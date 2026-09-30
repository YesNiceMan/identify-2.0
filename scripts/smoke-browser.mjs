/**
 * 无头 Chrome 冒烟测试（零依赖，直连 CDP）
 *
 * 自检脚本证明「解析出的事实对不对」，这一条证明「界面真的跑得起来」：
 * 加载真实页面 → 扫一次 → 读侧栏计数与卡片 → 依次做 搜索 / 清搜索 / 排序 /
 * 点选 / ⇧ 连选 / 切类型 / 开预览，全程收集控制台报错与未捕获异常。
 * 前端派生结果缓存化（store.js）最容易在这里露馅：筛完不重算、点了不刷新、缓存不失效。
 *
 * 用法：node scripts/smoke-browser.mjs [扫描目标]
 *   没装 Chrome 就打印跳过并退出 0（这条闸门在没有浏览器的机器上不算失败）。
 *
 * 关于 --no-sandbox：部分环境（受限的 macOS 会话 / CI）里 Chrome 的utility 进程会被沙箱拦掉，
 * 表现为 GPU / 网络服务反复崩溃、DevTools WebSocket 连上就被关。这里先按常规启动并探测一次，
 * 只有探测失败才带 --no-sandbox 重试；且无论哪种模式，全程只访问本机地址。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpConnect } from './cdp-ws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://127.0.0.1:4620';
const FIXTURE = 'http://127.0.0.1:4621/';
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = '/tmp/idv-cdp-profile-' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LF = String.fromCharCode(10);

/* 整条闸门的硬上限：任何一步卡住都要在 150s 内退出，不能挂住调用方 */
const watchdog = setTimeout(() => { console.log('\u001b[31m冒烟测试整体超时\u001b[0m'); cleanup(); process.exit(1); }, 150000);

const procs = [];
function cleanup() {
  clearTimeout(watchdog);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* noop */ } }
}
process.on('exit', cleanup);

if (!fs.existsSync(CHROME)) {
  console.log('未找到 Chrome（' + CHROME + '），跳过浏览器冒烟测试');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  \u001b[32mPASS\u001b[0m ' + label + (detail ? '  \u001b[2m' + detail + '\u001b[0m' : '')); }
  else { fail++; console.log('  \u001b[31mFAIL\u001b[0m ' + label + '  \u001b[2m' + detail + '\u001b[0m'); }
};

/* ---------------------------------------------------------- 被测进程 */

procs.push(spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, stdio: 'ignore' }));
procs.push(spawn(process.execPath, ['scripts/bench-site.mjs'], { cwd: ROOT, stdio: 'ignore' }));
for (let i = 0; i < 100; i++) {
  await sleep(200);
  try { await fetch(APP + '/api/health'); await fetch(FIXTURE + '/__stats'); break; } catch { /* 还没起来 */ }
}

/* ------------------------------------------------------ CDP 会话 */

const problems = [];

async function openSession(extraFlags) {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ }
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank',
  ].concat(extraFlags || []), { stdio: 'ignore' });
  procs.push(chrome);
  let list = null;
  for (let i = 0; i < 80 && !list; i++) {
    await sleep(250);
    if (chrome.killed) return null;
    try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (l.length) list = l; } catch { /* 还没起来 */ }
  }
  if (!list) { try { chrome.kill('SIGKILL'); } catch {} return null; }
  const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!page) { try { chrome.kill('SIGKILL'); } catch {} return null; }

  const ws = cdpConnect(page.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  ws.onMessage((text) => {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.id && pending.has(msg.id)) { const w = pending.get(msg.id); pending.delete(msg.id); w(msg.error ? { err: msg.error } : { res: msg.result }); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      problems.push('未捕获异常: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').split(LF)[0]);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      problems.push('console.' + msg.params.type + ': ' + (msg.params.args || []).map((a) => (a.value == null ? (a.description || '') : a.value)).join(' ').slice(0, 220));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry && msg.params.entry.level === 'error') {
      problems.push('日志错误: ' + String(msg.params.entry.text).slice(0, 220));
    }
  });
  const closed = new Promise((res) => ws.onClose(() => res(false)));
  try { await Promise.race([ws.ready(), closed.then(() => { throw new Error('ws 提前关闭'); })]); }
  catch { try { chrome.kill('SIGKILL'); } catch {} return null; }

  const send = (method, params) => new Promise((res) => {
    const id = ++mid;
    pending.set(id, res);
    try { ws.send(JSON.stringify({ id, method, params: params || {} })); } catch { pending.delete(id); res({ err: { message: 'send 失败' } }); }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ err: { message: '超时: ' + method } }); } }, 20000);
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.err) throw new Error(JSON.stringify(r.err));
    if (r.res && r.res.exceptionDetails) throw new Error('页面抛错: ' + JSON.stringify(r.res.exceptionDetails).slice(0, 240));
    return r.res && r.res.result ? r.res.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  /* 探测：算一次 6×7。沙箱拦掉 utility 进程时这一步就会失败 */
  const probe = await evalJs('6*7').catch(() => null);
  if (probe !== 42) {
    for (const p of procs.splice(procs.length - 1, 1)) { try { p.kill('SIGKILL'); } catch {} }
    try { ws.close(); } catch { /* noop */ }
    return null;
  }
  return { send, evalJs, ws };
}

let session = await openSession([]);
if (!session) {
  console.log('常规启动下 CDP 不可用，改用 --no-sandbox 重试（仅访问本机地址）');
  session = await openSession(['--no-sandbox']);
}
if (!session) { console.log('\u001b[33mCDP 连不上，跳过浏览器冒烟测试\u001b[0m'); cleanup(); process.exit(0); }

const { send, evalJs } = session;
const goal = process.argv[2] || FIXTURE;
await send('Page.navigate', { url: APP + '/?url=' + encodeURIComponent(goal) });

/* 等扫描收尾（阶段文案出现「完成 / 失败」） */
let finished = false;
for (let i = 0; i < 90 && !finished; i++) {
  await sleep(400);
  const phase = await evalJs("((document.querySelector('#scope-phase')||{}).textContent)||''").catch(() => '');
  if (/完成|失败/.test(String(phase))) finished = true;
}
await sleep(1600);   /* 让淡入与最后几条 SSE 落地 */
if (!finished) console.log('\u001b[33m! 超时未看到扫描收尾\u001b[0m');

await evalJs(fs.readFileSync(path.join(HERE, 'smoke-page.js'), 'utf-8'));

const st0 = await evalJs('__SMOKE__.status()');
console.log('初始状态 ' + JSON.stringify(st0));
ok(st0 && st0.cards > 0, '扫描后渲染出卡片', st0 && st0.cards + ' 张');
ok(st0 && st0.revealed === st0.cards, '全部卡片完成淡入（rAF 链没漏最后一批）', st0 && st0.revealed + '/' + st0.cards);
ok(st0 && Number(String(st0.found).replace(/,/g, '')) > 0, '侧栏「发现」计数已填充', st0 && st0.found);
ok(st0 && Number(String(st0.refs).replace(/,/g, '')) > 0, '侧栏「引用」计数已填充', st0 && st0.refs);
ok(st0 && /B|KB|MB/.test(String(st0.size)), '侧栏体积计数已填充', st0 && st0.size);

/* 搜索：命中 / 不命中 / 复原都要重算（缓存改造的核心风险点） */
const nHit = await evalJs('__SMOKE__.type("png")');
ok(typeof nHit === 'number' && nHit > 0 && nHit < st0.cards, '搜索 png 收窄列表', st0.cards + ' → ' + nHit);
const nMiss = await evalJs('__SMOKE__.type("zzz-不可能命中-qqq")');
ok(nMiss === 0, '搜索无命中时列表清空', String(nMiss));
const nBack = await evalJs('__SMOKE__.type("")');
ok(nBack === st0.cards, '清空搜索后完整恢复', String(nBack));

/* 排序 */
const sorted = await evalJs('__SMOKE__.sortBy("size")');
ok(sorted && sorted.n === st0.cards, '按体积排序不改变条目数', JSON.stringify(sorted));

/* 勾选与 ⇧ 连选 */
const c1 = await evalJs('__SMOKE__.clickCard(0, false)');
ok(c1 && c1.sel === 1, '点一张卡 → 选中 1 项', JSON.stringify(c1));
const c2 = await evalJs('__SMOKE__.clickCard(4, true)');
ok(c2 && c2.sel === 5, '⇧ 点第 5 张 → 区间共 5 项', JSON.stringify(c2));
ok(c2 && /区间 5 项/.test(String(c2.note)), '提示条写明区间数', String(c2.note || '').slice(0, 40));

/* 类型切换 */
const perType = await evalJs('__SMOKE__.chip("图片")');
ok(typeof perType === 'number' && perType > 0, '切到「图片」类型有结果', String(perType));
const backAll = await evalJs('__SMOKE__.chip("全部")');
ok(backAll === st0.cards, '切回「全部」条目数复原', String(backAll));

/* 预览：验证列表缓存没有把叠加层饿死 */
const pv = await evalJs('__SMOKE__.openPreview()');
ok(pv && typeof pv === 'object' && pv.shell && pv.frame, '打开页面预览（外壳与快照 iframe 都在）', JSON.stringify(pv));

console.log(problems.length ? LF + '\u001b[31m控制台 ' + problems.length + ' 条问题：\u001b[0m' : LF + '\u001b[32m控制台干净\u001b[0m');
for (const pr of problems.slice(0, 12)) console.log('  · ' + pr);

console.log(LF + '结果：' + pass + ' 通过 / ' + (fail + (problems.length ? 1 : 0)) + ' 失败');
cleanup();
process.exit(fail || problems.length ? 1 : 0);
