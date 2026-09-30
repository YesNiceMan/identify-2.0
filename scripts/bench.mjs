/**
 * 扫描速度基准：对本地基准站（scripts/bench-site.mjs）跑一次扫描，输出各阶段耗时。
 * 用法：node scripts/bench.mjs [次数]   —— 默认 3 次取最快值（冷启动那次丢弃）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const API = 'http://127.0.0.1:' + (process.env.PORT || 4620);
const BENCH_DIR = process.env.BENCH_DIR || path.join(os.tmpdir(), 'idv-bench');
const TARGET = 'http://127.0.0.1:' + (process.env.BENCH_PORT || 4621) + '/';
const RUNS = Math.max(1, Number(process.argv[2] || 3));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUp(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 还没起来 */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(120);
  }
}

function start(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  p.__log = '';
  p.stdout.on('data', (d) => { p.__log += d; });
  p.stderr.on('data', (d) => { p.__log += d; });
  return p;
}

async function stats() {
  try { return await (await fetch('http://127.0.0.1:' + (process.env.BENCH_PORT || 4621) + '/__stats')).json(); } catch { return {}; }
}

async function scan(url) {
  const before = await stats();
  const res = await fetch(API + '/api/scan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
  });
  const j = await res.json();
  if (!j.job) throw new Error('scan 启动失败：' + JSON.stringify(j));
  let snap;
  for (;;) {
    await sleep(60);
    snap = await (await fetch(API + '/api/jobs/' + j.job)).json();
    if (snap.status !== 'running') break;
  }
  const st = snap.result && snap.result.stats;
  const after = await stats();
  const marks = [];
  let prev = 0;
  for (const l of (snap.logs || [])) {
    if (/文档已获取|结构解析完成|外链 CSS|扫描策略|合计按策略排除/.test(l.msg)) marks.push({ at: l.t, msg: l.msg.slice(0, 34) });
  }
  const steps = marks.map((m) => { const d = m.at - prev; prev = m.at; return { step: m.msg, ms: d }; });
  if (st) steps.push({ step: '探测 + 整理（余下）', ms: Math.max(0, st.duration - prev) });
  return {
    duration: st ? st.duration : 0,
    resources: st ? st.total : 0,
    refs: st ? st.refs : 0,
    probed: st && st.requests ? st.requests.probed : 0,
    skipped: st && st.requests ? st.requests.skipped : 0,
    steps,
    req: {
      total: (after.total || 0) - (before.total || 0),
      range: (after.range || 0) - (before.range || 0),
      full: (after.full || 0) - (before.full || 0),
      bytes: (after.bytes || 0) - (before.bytes || 0),
    },
  };
}

const bench = start(process.execPath, [path.join(ROOT, 'scripts/bench-site.mjs')], ROOT);
const app = start(process.execPath, [path.join(ROOT, 'server/index.mjs')], ROOT);

if (!await waitUp('http://127.0.0.1:4621/', 8000)) { console.log('基准站未启动\n' + bench.__log); process.exit(1); }
if (!await waitUp(API + '/api/health', 8000)) { console.log('服务未启动\n' + app.__log); process.exit(1); }

/* 冷启动（含 DNS/首次编译）丢弃，之后取每阶段最快值 */
let results = [];
for (let i = 0; i < RUNS; i++) {
  /* 每轮都走接口清缓存（顺带清掉内存索引）；直接 rm -rf 会删掉服务已持有的目录 */
  await fetch(API + '/api/cache/purge', { method: 'POST' });
  try { results.push(await scan(TARGET)); } catch (e) { console.log('ERR ' + e.message); }
}
const runs = results.slice(1).length ? results.slice(1) : results;
const best = runs.reduce((a, b) => (b.duration < a.duration ? b : a), runs[0]);

console.log('目标 ' + TARGET + '  资源 ' + best.resources + ' / 引用 ' + best.refs
  + '  探测 ' + best.probed + '  跳过 ' + best.skipped);
for (const s of best.steps) console.log('  ' + String(s.ms).padStart(6) + 'ms  ' + s.step);
console.log('  ------');
const kb = (n) => (n ? (n / 1024).toFixed(n > 1048576 ? 0 : 1) + 'KB' : '0');
console.log('   ' + String(best.req.total || 0).padStart(5) + '   上游请求（其中带 Range ' + (best.req.range || 0) + '，全量 ' + (best.req.full || 0) + '）· 线上传输 ' + kb(best.req.bytes));
console.log('  ' + String(best.duration).padStart(6) + 'ms  总耗时（' + runs.length + ' 次最快；全部：'
  + runs.map((r) => r.duration).join(', ') + '）');
console.log('RESULT ' + JSON.stringify({ duration: best.duration, resources: best.resources, requests: best.req.total, steps: best.steps }));

bench.kill();
app.kill();
process.exit(0);
