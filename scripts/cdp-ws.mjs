/**
 * 极简直写 WebSocket 客户端（零依赖，只为 CDP 服务）
 *
 * Node 内置的 WebSocket（undici）连本机 Chrome 的 DevTools 会被 1006 掐断，
 * 而 CDP 才是无头冒烟测试唯一可靠的通道，所以这里手写一层：
 * 只实现「客户端发帧必须掩码、服务端回帧不掩码」这一条现实需要的子集，
 * 支持分片续帧与大帧长（CDP 一次回几十 KB 的 JSON 是常态）。
 */
import net from 'node:net';
import crypto from 'node:crypto';

export function cdpConnect(wsUrl) {
  const u = new URL(wsUrl);
  const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  const socket = net.connect(port, u.hostname.replace(/^\[/, '').replace(/\]$/, ''));

  let state = 'connecting';
  const queue = [];
  let handlers = { message: () => {}, close: () => {} };
  let inflight = { opcode: 0, parts: [] };
  let buf = Buffer.alloc(0);

  const onMessage = (fn) => { handlers.message = fn; };
  const onClose = (fn) => { handlers.close = fn; };

  socket.on('error', (e) => { if (state === 'connecting') fail(e); });
  socket.on('close', () => { state = 'closed'; handlers.close(); });

  function fail(err) { state = 'failed'; handlers.close(err); }

  socket.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = [
      'GET ' + (u.pathname + u.search) + ' HTTP/1.1',
      'Host: ' + u.host,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      /* 不发 Origin：Chrome 只对「带了 Origin 又不在白名单」的连接回 403 */
      '', '',
    ].join(String.fromCharCode(13, 10));
    socket.write(req);
  });

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (state === 'connecting') {
      const sep = buf.indexOf(Buffer.from(String.fromCharCode(13, 10, 13, 10)));
      if (sep < 0) return;
      const head = buf.subarray(0, sep).toString('latin1');
      buf = buf.subarray(sep + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { fail(new Error('握手失败：' + head.split(String.fromCharCode(13))[0])); socket.destroy(); return; }
      state = 'open';
      for (const q of queue.splice(0).reverse()) send(q);
      drain();
      return;
    }
    drain();
  });

  function drain() {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let p = 2;
      if (len === 126) { if (buf.length < p + 2) return; len = buf.readUInt16BE(p); p += 2; }
      else if (len === 127) { if (buf.length < p + 8) return; len = Number(buf.readBigUInt64BE(p)); p += 8; }
      let mask = null;
      if (masked) { if (buf.length < p + 4) return; mask = buf.subarray(p, p + 4); p += 4; }
      if (buf.length < p + len) return;
      let payload = buf.subarray(p, p + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.subarray(p + len);

      if (process.env.CDP_TRACE) console.log('[ws] frame op=' + opcode + ' fin=' + fin + ' len=' + len + ' masked=' + masked + ' remain=' + buf.length);
      if (opcode === 8) { socket.end(); return; }              /* 服务端关闭 */
      if (opcode === 9) { frame(10, payload); continue; }      /* ping → pong */
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 2) inflight = { opcode, parts: [payload] };
      else if (opcode === 0) inflight.parts.push(payload);     /* 续帧 */
      else continue;
      if (fin && inflight.opcode) {
        const body = Buffer.concat(inflight.parts).toString('utf-8');
        inflight = { opcode: 0, parts: [] };
        if (body) handlers.message(body);
      }
    }
  }

  function frame(opcode, payloadBuf) {
    const len = payloadBuf.length;
    let head;
    if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = 0x80 | len; }
    else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.allocUnsafe(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const out = Buffer.allocUnsafe(head.length + 4 + len);
    head.copy(out, 0);
    mask.copy(out, head.length);
    for (let i = 0; i < len; i++) out[head.length + 4 + i] = payloadBuf[i] ^ mask[i & 3];
    socket.write(out);
  }

  function send(text) {
    if (state === 'closed' || state === 'failed') throw new Error('连接已断开');
    if (state !== 'open') { queue.push(text); return; }
    frame(1, Buffer.from(text, 'utf-8'));
  }

  return {
    send,
    onMessage,
    onClose,
    close: () => { try { frame(8, Buffer.alloc(0)); } catch { /* noop */ } socket.destroy(); },
    /* 等 socket 真的进入 open；失败则 reject */
    ready: () => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws 握手超时')), 8000);
      const tick = setInterval(() => {
        if (state === 'open') { clearInterval(t); clearTimeout(t); res(); }
        else if (state === 'failed' || state === 'closed') { clearInterval(t); clearTimeout(t); rej(new Error('ws 握手失败')); }
      }, 25);
    }),
  };
}
