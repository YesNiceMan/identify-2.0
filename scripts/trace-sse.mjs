/* SSE 事件时间线：每个 item 到达的相对毫秒（墙钟）与服务端任务内毫秒 */
const BASE = process.env.BASE || 'http://127.0.0.1:4620';
const url = process.argv[2] || 'http://127.0.0.1:4620/samples/lab';
const j0 = await (await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })).json();
const res = await fetch(BASE + '/api/jobs/' + j0.job + '/events');
const rd = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const items = [];
const phases = [];
const t0 = Date.now();
let finished = false;
while (!finished) {
  const { value, done } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let at;
  while ((at = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, at); buf = buf.slice(at + 2);
    const dm = /data: (.*)/.exec(block);
    if (!dm) continue;
    const ev = JSON.parse(dm[1]);
    if (ev.type === 'item') items.push({ t: Date.now() - t0, ms: ev.t, name: (ev.item.name || '').slice(0, 26), size: ev.item.size || 0, cached: ev.item.cached ? 'C' : ' ', status: ev.item.status });
    else if (ev.type === 'status') phases.push((Date.now() - t0) + 'ms ' + (ev.label || ev.phase));
    else if (ev.type === 'done' || ev.type === 'error') { finished = true; phases.push((Date.now() - t0) + 'ms DONE'); }
  }
}
try { rd.cancel(); } catch (e) {}
console.log('phases: ' + phases.join(' | '));
console.log('items: ' + items.length);
for (const it of items) console.log(String(it.t).padStart(6), String(it.ms).padStart(6), String(it.size).padStart(9), it.cached, '', it.status.padEnd(8), it.name);
