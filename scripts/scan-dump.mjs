/* 扫描一次并把「资源事实」写成指纹文件，用于 HEAD vs 改动后逐字段对比 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/Users/a123/Desktop/test/identify-2.0';
const TARGET = process.argv[3] || 'http://127.0.0.1:4621/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT });
let bench = null;
if (/4621/.test(TARGET)) bench = spawn(process.execPath, ['scripts/bench-site.mjs'], { cwd: ROOT });
for (let i = 0; i < 80; i++) { let up = true; try { if (bench) await fetch('http://127.0.0.1:4621/__stats'); await fetch('http://127.0.0.1:4620/api/health'); } catch { up = false; } if (up) break; await sleep(150); }
const rows = [];
for (const opts of [{}, { includeIcons: true, includeTech: true, mainOnly: false }, { crawlPages: 3 }]) {
  const j = await (await fetch('http://127.0.0.1:4620/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ url: TARGET }, opts)) })).json();
  let snap;
  for (;;) { await sleep(80); snap = await (await fetch('http://127.0.0.1:4620/api/jobs/' + j.job)).json(); if (snap.status !== 'running') break; }
  const res = snap.result;
  for (const r of res.resources) {
    rows.push([Object.keys(opts).join('+') || 'default', r.url, r.type, r.status, r.size, r.width, r.height, r.duration, r.mime, r.ext, r.format, r.hash ? 'H' : '', r.count, r.zone, r.zoneKind, r.sprite ? 'S' : '', r.iconFont ? 'IF' : '', r.live ? 'L' : '', r.truncated ? 'T' : '', r.title || '', r.codec || ''].join('|'));
  }
  for (const f of res.filtered) rows.push([Object.keys(opts).join('+') || 'default', 'FILTERED', f.url, f.reason, f.status, f.type].join('|'));
}
fs.writeFileSync(process.argv[2], rows.sort().join('\n'));
console.log('rows=' + rows.length + ' → ' + process.argv[2]);
try { app.kill(); } catch {} if (bench) { try { bench.kill(); } catch {} }
process.exit(0);