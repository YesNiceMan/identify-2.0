/**
 * 扫描速度基准站：在临时目录里造一个「大而真实」的页面（上百张图 + 视音频 + 文档 + 字体
 * + 图标 + 懒加载 + 外链 CSS + 站内文章页），固定端口 4621 本地服务。
 * 有了它，扫描耗时的对比不再受公网波动影响。
 *
 * 用法：node scripts/bench-site.mjs          生成 + 启动
 *       node scripts/bench-site.mjs --gen   只生成
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';

const OUT = process.env.BENCH_DIR || path.join(os.tmpdir(), 'idv-bench');
const PORT = Number(process.env.BENCH_PORT || 4621);

function crc32(buf) {
  const table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const j = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(j));
  return Buffer.concat([len, j, c]);
}

function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const at = row + 1 + x * 3;
      raw[at] = (rgb[0] + x * 3 + y) & 255;
      raw[at + 1] = (rgb[1] + y * 5) & 255;
      raw[at + 2] = (rgb[2] + x * 7) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gif(w, h) {
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), lsd, Buffer.from([0x3b])]);
}

function jpeg(w, h) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof[2] = 0; sof[3] = 17; sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  for (let i = 1; i <= 3; i++) {
    sof[10 + (i - 1) * 3] = i;
    sof[11 + (i - 1) * 3] = 0x21;
    sof[12 + (i - 1) * 3] = i === 1 ? 2 : 1;
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function wav(ms, rate) {
  const samples = Math.floor((ms / 1000) * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE((Math.sin(i / 20) * 8000) | 0, i * 2);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const dh = Buffer.alloc(8);
  dh.write('data', 0);
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, fmt, dh, data]);
}

function svg(w, h, label) {
  const s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
    + '<title>' + label + '</title>'
    + '<rect width="' + w + '" height="' + h + '" fill="#0a3"/></svg>';
  return Buffer.from(s, 'utf-8');
}

function pdf(pages) {
  let body = '%PDF-1.4\n';
  for (let i = 1; i <= pages; i++) body += '1 0 obj\n<< /Type /Page /MediaBox [0 0 595 842] >>\nendobj\n';
  body += '2 0 obj\n<< /Title (bench doc) /Author (bench) >>\nendobj\n%%EOF\n';
  return Buffer.from(body, 'latin1');
}

function m3u8() {
  const s = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
    '#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080', '1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720', '720.m3u8', '#EXT-X-ENDLIST'].join('\n');
  return Buffer.from(s, 'utf-8');
}

export function generate(cfg) {
  const c = Object.assign({ images: 160, lazy: 60, icons: 90, fonts: 40, docs: 16, media: 10, pages: 10 }, cfg);
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const d of ['img', 'icons', 'font', 'doc', 'media']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  const write = (rel, buf) => fs.writeFileSync(path.join(OUT, rel), buf);
  const body = [];

  for (let i = 0; i < c.images; i++) {
    const w = 160 + (i * 37) % 900;
    const h = 120 + (i * 23) % 600;
    const kind = i % 3;
    let rel;
    if (kind === 0) { rel = 'img/p' + i + '.png'; write(rel, png(w, h, [i & 255, (i * 3) & 255, (i * 7) & 255])); }
    else if (kind === 1) { rel = 'img/p' + i + '.jpg'; write(rel, jpeg(w, h)); }
    else { rel = 'img/p' + i + '.gif'; write(rel, gif(w, h)); }
    body.push('<figure><img src="/' + rel + '" width="' + w + '" height="' + h + '" alt="素材 ' + i + '"></figure>');
  }
  for (let i = 0; i < c.lazy; i++) {
    const rel = 'img/q' + i + '.png';
    write(rel, png(480 + i, 320 + i, [9, 99, 199]));
    body.push('<div class="card" data-src="/' + rel + '" data-original="/' + rel + '"></div>');
  }
  for (let i = 0; i < c.icons; i++) write('icons/i' + i + '.png', png(16 + (i % 3) * 8, 16 + (i % 3) * 8, [1, 2, 3]));
  for (let i = 0; i < c.fonts; i++) write('font/f' + i + '.ttf', pdf(1));
  for (let i = 0; i < c.docs; i++) write('doc/d' + i + '.pdf', pdf(2 + i));
  for (let i = 0; i < c.media; i++) write('media/a' + i + '.wav', wav(400 + i * 120, 22050));
  write('media/master.m3u8', m3u8());
  write('img/hero.svg', svg(1600, 900, 'hero illustration'));
  write('icons/glyph.svg', svg(24, 24, 'glyph'));

  let css = 'body{margin:0}\n';
  for (let i = 0; i < 30; i++) css += '.bg' + i + '{background:url(/img/p' + (i % c.images) + '.png)}\n';
  for (let i = 0; i < 40; i++) css += '.ic' + i + '{background:url(/icons/i' + (i % c.icons) + '.png)}\n';
  for (let i = 0; i < c.fonts; i++) css += '@font-face{font-family:f' + i + ';src:url(/font/f' + i + '.ttf) format("truetype")}\n';
  write('site.css', Buffer.from(css, 'utf-8'));
  write('deep.css', Buffer.from('@import url(/site.css);\n.x{background:url(/img/hero.svg)}\n', 'utf-8'));

  const head = [];
  for (let i = 0; i < c.media; i++) head.push('<audio src="/media/a' + i + '.wav"></audio>');
  for (let i = 0; i < 4; i++) head.push('<link rel="icon" href="/icons/i' + i + '.png">');
  head.push('<link rel="stylesheet" href="/deep.css">');
  head.push('<meta property="og:image" content="/img/hero.svg">');

  const nav = '<nav>' + Array.from({ length: 40 }, (_, i) => '<a href="/icons/i' + (i % c.icons) + '.png">n' + i + '</a>').join('') + '</nav>';
  const footer = '<footer>' + Array.from({ length: 30 }, (_, i) => '<img src="/icons/i' + ((i * 3) % c.icons) + '.png">').join('') + '</footer>';
  const json = JSON.stringify({ list: Array.from({ length: 60 }, (_, i) => ({ thumb: '/img/p' + (i % c.images) + '.png', src: '/media/a' + (i % c.media) + '.wav' })) });
  const script = '<scr' + 'ipt>var DATA=' + json + ';</scr' + 'ipt>';
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BENCH</title>'
    + head.join('') + '</head><body>' + nav + '<main>' + body.join('\n') + '</main>' + footer + script + '</body></html>';
  write('index.html', Buffer.from(html, 'utf-8'));

  const article = '<!doctype html><html><head><meta charset="utf-8"><title>article</title>'
    + '<link rel="stylesheet" href="/site.css"></head><body><main><article>'
    + Array.from({ length: 60 }, (_, i) => '<p>段落 ' + i + ' ' + '内容'.repeat(20) + '</p>').join('')
    + Array.from({ length: 40 }, (_, i) => '<img src="/img/p' + ((i * 7) % c.images) + '.png">').join('')
    + '</article></main></body></html>';

  return { out: OUT, article, counts: c };
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl',
};

export function serve() {
  const g = generate();
  const stat = { total: 0, range: 0, full: 0, bytes: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(stat));
      return;
    }
    stat.total++;
    if (req.headers.range) stat.range++; else stat.full++;
    /* 真实上游会回 Range，这里也回：否则「发了多少字节」这个指标不诚实 */
    const send = (buf, ctype) => {
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      let from = 0; let to = buf.length - 1; let status = 200;
      if (range && (range[1] || range[2])) {
        status = 206;
        from = range[1] ? Number(range[1]) : 0;
        to = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
      }
      const slice = status === 206 ? buf.subarray(from, to + 1) : buf;
      const head = { 'content-type': ctype, 'content-length': String(slice.length), 'accept-ranges': 'bytes' };
      if (status === 206) head['content-range'] = 'bytes ' + from + '-' + to + '/' + buf.length;
      /* 按真正落到线上的字节计费（含响应头，keep-alive 上按本请求增量算） */
      const before = res.socket ? res.socket.bytesWritten : 0;
      res.on('close', () => {
        if (res.socket) stat.bytes += Math.max(0, res.socket.bytesWritten - before);
        else stat.bytes += slice.length;
      });
      res.writeHead(status, head);
      res.end(slice);
    };
    let rel = decodeURIComponent(u.pathname);
    if (/^\/article-\d+$/.test(rel)) {
      send(g.article, 'text/html; charset=utf-8');
      return;
    }
    if (rel === '/') rel = '/index.html';
    const file = path.join(OUT, rel);
    if (!file.startsWith(OUT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
      send(buf, (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8');
    });
  });
  server.listen(PORT, '127.0.0.1', () => console.log('BENCH http://127.0.0.1:' + PORT + '/  (' + OUT + ')'));
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('bench-site.mjs')) {
  if (process.argv.includes('--gen')) console.log('generated → ' + generate().out);
  else serve();
}
