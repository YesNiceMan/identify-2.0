/**
 * 导出保真校验：扫描基准站 → 全量导出 ZIP → 逐个文件与磁盘原始字节比 md5。
 * 用法：node scripts/verify-export.mjs   （自检「原尺寸导出」这条硬承诺）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ROOT = '/Users/a123/Desktop/test/identify-2.0';
const API = 'http://127.0.0.1:4620';
const BENCH = 'http://127.0.0.1:4621';
const OUT = process.env.BENCH_DIR || path.join(os.tmpdir(), 'idv-bench');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const procs = [spawn(process.execPath, ['scripts/bench-site.mjs'], { cwd: ROOT }), spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT })];
const bye = () => { for (const p of procs) { try { p.kill(); } catch {} } };
process.on('exit', bye);
for (let i = 0; i < 80; i++) {
  let up = true;
  try { await fetch(BENCH + '/__stats'); await fetch(API + '/api/health'); } catch { up = false; }
  if (up) break;
  await sleep(150);
}

const j = await (await fetch(API + '/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: BENCH + '/' }) })).json();
let snap;
for (;;) { await sleep(80); snap = await (await fetch(API + '/api/jobs/' + j.job)).json(); if (snap.status !== 'running') break; }
const res = snap.result;
const okItems = res.resources.filter((r) => r.status === 'ok');
console.log('资源 ' + res.resources.length + ' · 可导出 ' + okItems.length);

/* 1) 单文件代理下载 vs 磁盘原始字节 */
let same = 0; let diff = 0; const bad = [];
for (const it of okItems.slice(0, 60)) {
  const rel = decodeURIComponent(new URL(it.url).pathname);
  const disk = fs.readFileSync(path.join(OUT, rel));
  const viaProxy = Buffer.from(await (await fetch(API + '/api/proxy?url=' + encodeURIComponent(it.url) + '&download=1')).arrayBuffer());
  if (md5(disk) === md5(viaProxy)) same++; else { diff++; bad.push(it.name + ' ' + md5(disk) + ' != ' + md5(viaProxy)); }
}
console.log('代理下载 md5 一致 ' + same + ' / 不一致 ' + diff);

/* 2) ZIP 打包：解出的每个资源与磁盘原始字节比对 */
const zip = Buffer.from(await (await fetch(API + '/api/bundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job: j.job, ids: okItems.map((r) => r.id) }) })).arrayBuffer());
const entries = unzip(zip);
let zsame = 0; let zdiff = 0; let matched = 0; const zbad = [];
for (const [name, buf] of entries) {
  /* 条目在 <根目录>/<类型中文名>/NNN-xxx 下 */
  if (!/\/(图片|矢量图|视频|音频|文档|表格|压缩包|三维模型|字体|UI 图标|样式表|脚本|数据|页面|其他)\//.test(name)) continue;
  const base = name.split('/').pop();
  const stem = base.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
  const src = findSource(stem);
  if (!src) continue;
  matched++;
  if (md5(src) === md5(buf)) zsame++; else { zdiff++; zbad.push(name); }
}
console.log('ZIP 匹配 ' + matched + ' 项 · 解包 md5 一致 ' + zsame + ' / 不一致 ' + zdiff + (zbad.length ? ' · ' + zbad.slice(0, 5).join(', ') : ''));
console.log(bad.length ? 'BAD: ' + bad.slice(0, 5).join(' | ') : '代理全部一致');
bye(); process.exit(zdiff + diff ? 1 : 0);

var INDEX = null;   /* var：顶层 await 下 const/let 会落在 TDZ 里 */
function buildIndex() {
  if (INDEX) return INDEX;
  const map = new Map();
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (!map.has(path.parse(ent.name).name)) map.set(path.parse(ent.name).name, full);
    }
  };
  walk(OUT);
  INDEX = map;
  return map;
}

function findSource(stem) {
  const hit = buildIndex().get(stem);
  return hit ? fs.readFileSync(hit) : null;
}

/** 最小 ZIP 读取：只解析中央目录 + stored/deflate 条目 */
function unzip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let p = buf.length - 22; p >= 0 && p > buf.length - 66000; p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    const lname = buf.readUInt16LE(lho + 26);
    const lextra = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lname + lextra;
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : Buffer.alloc(0));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}