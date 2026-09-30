/**
 * grab() 的取字节边界自检（零依赖，只开一个本地服务）
 *
 * 重点守一条：探测请求带 fitsBytes 门槛时，「这一次连接顺手把整份读完」的判断
 * 不能信带 Content-Encoding 的响应——那种 Content-Length 是压缩后的字节数，
 * 而读到的是解压后的流，照它设上限会把内容拦腰截断，还会被当成完整文件落盘。
 * 用法：node scripts/selftest-net.mjs
 */
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { grab } = await import(path.join(ROOT, 'server/net.mjs'));

let pass = 0; let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  \u001b[32mPASS\u001b[0m ' + label); }
  else { fail++; console.log('  \u001b[31mFAIL\u001b[0m ' + label + '  \u001b[2m' + detail + '\u001b[0m'); }
};

/* 用真 PNG 拼接，既保证魔数完整，又能压出「压缩后极小、解压后很大」的形状 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c6360000002000100ffff03ba3cfe0000000049454e44ae426082', 'hex');
const mk = (n) => Buffer.concat(Array.from({ length: n }, () => PNG));
const WINDOW = 262144;
const small = mk(6);
const huge = mk(40000);
const gzSmall = zlib.gzipSync(small, { level: 9 });
const gzHuge = zlib.gzipSync(huge, { level: 9 });
if (!(gzHuge.length < WINDOW && huge.length > WINDOW)) {
  console.log('标本形状不成立，测试无效'); process.exit(1);
}

const srv = http.createServer((req, res) => {
  if (req.url === '/gz-small') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': String(gzSmall.length) });
    return res.end(gzSmall);
  }
  if (req.url === '/gz-huge') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': String(gzHuge.length) });
    return res.end(gzHuge);
  }
  if (req.url === '/id-huge') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(huge.length) });
    return res.end(huge);
  }
  if (req.url === '/lie') {
    /* 谎报体积后掐断连接：流也算「自然结束」，但手里只有残件 */
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(huge.length) });
    res.write(huge.subarray(0, 4096));
    setTimeout(() => res.socket && res.socket.destroy(), 30);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const get = (p, opts) => grab(base + p, Object.assign({ retries: 0 }, opts));

console.log('\n\u001b[1mgrab 取字节边界\u001b[0m');

/* 1) 压缩响应不许拿 Content-Length 当上限：必须读到完整解压字节 */
const a = await get('/gz-small', { maxBytes: WINDOW, fitsBytes: 14 * 1024 * 1024 });
ok(a.bytes === small.length, 'gzip 小文件不被压缩后的 Content-Length 截断', 'bytes=' + a.bytes + ' want=' + small.length);
ok(a.body.subarray(0, 8).equals(PNG.subarray(0, 8)), 'gzip 小文件魔数完整', a.body.subarray(0, 8).toString('hex'));
ok(a.whole === true, 'gzip 小文件确为全量（流自然读完）', 'whole=' + a.whole);

/* 2) 压缩后落在窗口内、解压后超出窗口：只读窗口，且绝不能标 whole */
const b = await get('/gz-huge', { maxBytes: WINDOW, fitsBytes: 14 * 1024 * 1024 });
ok(b.bytes === WINDOW, 'gzip 大文件只读到探测窗口', 'bytes=' + b.bytes);
ok(b.whole === false, 'gzip 大文件不标全量（否则会缓存半份文件）', 'whole=' + b.whole);
ok(b.truncated === true, 'gzip 大文件标已截断', 'truncated=' + b.truncated);

/* 3) 未压缩但超过门槛：读满窗口即止 */
const c = await get('/id-huge', { maxBytes: WINDOW, fitsBytes: 1024 * 1024 });
ok(c.bytes === WINDOW, '超门槛的未压缩文件读满窗口', 'bytes=' + c.bytes);
ok(c.whole === false, '超门槛不标全量', 'whole=' + c.whole);
ok(c.totalBytes === huge.length, '仍从 Content-Length 得到真实总体积', c.totalBytes + '/' + huge.length);

/* 4) 未压缩且门槛内：一条请求顺手拿全量（本轮提速的主路径） */
const d = await get('/id-huge', { maxBytes: WINDOW, fitsBytes: 64 * 1024 * 1024 });
ok(d.bytes === huge.length && d.whole === true, '门槛内的未压缩文件一次读全', 'bytes=' + d.bytes + ' whole=' + d.whole);

/* 5) 不给门槛：读到的就是 maxBytes 以内；只要流自己结束得早，全量这件事依然成立
 *    ——whole 判的是「手里是不是整份」，与有没有提到上限无关 */
const e = await get('/gz-small', { maxBytes: WINDOW });
ok(e.bytes === small.length && e.whole === true, '无门槛但流已读完 → 仍算全量', 'bytes=' + e.bytes + ' whole=' + e.whole);

/* 6) 带 Range 时门槛不生效（范围请求本来就只要头部） */
const f = await get('/id-huge', { maxBytes: 1024, fitsBytes: 64 * 1024 * 1024, range: 'bytes=0-1023' });
ok(f.bytes === 1024 && f.whole === false, 'Range 请求不受门槛影响', 'bytes=' + f.bytes + ' status=' + f.status);
ok(f.totalBytes === huge.length, 'Range 仍解析出总体积', f.totalBytes + '/' + huge.length);

/* 7) 连接中途被掐断：绝不允许当成全量（否则残缺文件会被当原件缓存并导出） */
let g = null; let threw = null;
try { g = await get('/lie', { maxBytes: WINDOW, fitsBytes: 64 * 1024 * 1024 }); } catch (err) { threw = err; }
ok(!!threw || g.whole === false, '残件不标全量（抛错或 whole=false 都算守住）',
  threw ? '抛错：' + String(threw.message).slice(0, 40) : 'bytes=' + g.bytes + ' whole=' + g.whole);

srv.close();
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);