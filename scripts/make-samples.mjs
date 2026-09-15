/**
 * 生成离线样本资源（真实可解析的 PNG / SVG / WAV / PDF / ZIP / CSV / MD / JSON / CSS）
 * 用法：node scripts/make-samples.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { zipToBuffer } from '../server/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'public', 'samples');
const ASSETS = path.join(OUT, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

function mulberry(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------- PNG */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let x = i; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; t[i] = x; }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y, width, height);
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function auroraPixel(seed) {
  const rnd = mulberry(seed);
  const blobs = Array.from({ length: 7 }, () => ({
    x: rnd(), y: rnd(), r: 0.18 + rnd() * 0.4,
    c: [rnd() * 255, rnd() * 200 + 30, 120 + rnd() * 135],
  }));
  return (x, y, w, h) => {
    const u = x / w; const v = y / h;
    let r = 8 + v * 20; let g = 10 + v * 26; let b = 18 + v * 40;
    for (const bl of blobs) {
      const dx = (u - bl.x) * 1.6; const dy = v - bl.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const f = Math.max(0, 1 - d / bl.r) ** 2.2;
      r += bl.c[0] * f * 0.55; g += bl.c[1] * f * 0.55; b += bl.c[2] * f * 0.75;
    }
    const band = Math.sin((v * 26 + u * 6)) * 0.5 + 0.5;
    r += band * 12; g += band * 16; b += band * 10;
    const n = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
    const grain = (n > 0 ? n : -n) * 18 - 8;
    return [clamp(r + grain), clamp(g + grain), clamp(b + grain)];
  };
}

function gridPixel(x0) {
  return (x, y, w, h) => {
    const u = x / w; const v = y / h;
    const gx = Math.abs(((x / 40) % 1) - 0.5);
    const gy = Math.abs(((y / 40) % 1) - 0.5);
    const line = Math.max(0, 1 - Math.min(gx, gy) * 30);
    const hue = 170 + u * 90 + v * 40;
    const r = 12 + line * 90 + Math.sin(hue / 57) * 40;
    const g = 20 + line * 200 + Math.sin((hue + 120) / 57) * 60;
    const b = 30 + line * 170 + Math.sin((hue + 240) / 57) * 70;
    const dot = (x % 200 < 3 && y % 200 < 3) ? 120 : 0;
    return [clamp(r + dot * 0.4), clamp(g + dot * 0.8), clamp(b + dot)];
  };
}

function badgePixel(x, y, w, h) {
  const cx = w / 2; const cy = h / 2;
  const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (w / 2);
  const ring = Math.abs(d - 0.72) < 0.045 ? 1 : 0;
  const ring2 = Math.abs(d - 0.88) < 0.02 ? 1 : 0;
  const inside = d < 0.62 ? 1 : 0;
  const wedge = (Math.atan2(y - cy, x - cx) + Math.PI) / (Math.PI * 2);
  const pulse = 0.5 + 0.5 * Math.sin(wedge * Math.PI * 8);
  const r = 20 + inside * (120 + pulse * 90) + ring * 200 + ring2 * 90;
  const g = 26 + inside * (230 - pulse * 60) + ring * 255 + ring2 * 130;
  const b = 40 + inside * (150 + pulse * 40) + ring * 120 + ring2 * 200;
  return [clamp(r), clamp(g), clamp(b)];
}

const pngs = [
  ['aurora-1920x1080.png', 1920, 1080, auroraPixel(7)],
  ['aurora-2560x1440.png', 2560, 1440, auroraPixel(21)],
  ['grid-1200x800.png', 1200, 800, gridPixel()],
  ['badge-512.png', 512, 512, badgePixel],
  ['badge-96.png', 96, 96, badgePixel],
  ['dot-64.png', 64, 64, (x, y) => [clamp(200 - x * 3), clamp(90 + y * 2), clamp(220 - x * 2)]],
  ['hidden-lazy-320x200.png', 320, 200, auroraPixel(555)],
];

for (const [name, w, h, px] of pngs) {
  const buf = encodePng(w, h, px);
  fs.writeFileSync(path.join(ASSETS, name), buf);
  log('  PNG  ' + name.padEnd(24) + (w + 'x' + h).padEnd(11) + kb(buf.length));
}

/* --------------------------------------------------------------- SVG */

const svgLogo = ['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0" stop-color="#b8ff3c"/><stop offset="1" stop-color="#4ad9ff"/></linearGradient></defs>',
  '<rect width="320" height="120" rx="14" fill="#06080b"/>',
  '<path d="M22 88 L62 32 L102 88 Z" fill="none" stroke="url(#g)" stroke-width="5"/>',
  '<circle cx="62" cy="60" r="7" fill="#ff6ec7"/>',
  '<text x="120" y="66" font-family="Menlo,monospace" font-size="26" fill="url(#g)" letter-spacing="4">IDENTIFY</text>',
  '<text x="121" y="90" font-family="Menlo,monospace" font-size="12" fill="#5c6472" letter-spacing="6">RESOURCE SCANNER</text>',
  '</svg>'].join('');

const svgMask = ['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">',
  '<circle cx="100" cy="100" r="92" fill="none" stroke="#4ad9ff" stroke-width="2" stroke-dasharray="8 6"/>',
  '<path d="M60 120 Q100 40 140 120" fill="none" stroke="#b8ff3c" stroke-width="6"/>',
  '<circle cx="76" cy="86" r="9" fill="#ff6ec7"/><circle cx="124" cy="86" r="9" fill="#ffd166"/>',
  '<rect x="64" y="132" width="72" height="8" rx="4" fill="#a0b4ff"/></svg>'].join('');

fs.writeFileSync(path.join(ASSETS, 'logo-crest.svg'), svgLogo);
fs.writeFileSync(path.join(ASSETS, 'icon-mask.svg'), svgMask);
log('  SVG  logo-crest.svg / icon-mask.svg');

/* --------------------------------------------------------------- WAV */

function wav(samples, rate, channels) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + samples.length * 2, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 44 + i * 2);
  return bytes;
}

const RATE = 44100;
function chime(seconds) {
  const n = Math.floor(RATE * seconds);
  const out = new Float64Array(n * 2);
  const chord = [261.63, 329.63, 392.0, 523.25];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = Math.exp(-t * 1.1) * (1 - Math.exp(-t * 40));
    let v = 0;
    chord.forEach((f, k) => { v += Math.sin(2 * Math.PI * f * t * (1 + k * 0.002)) / (k + 2); });
    v += 0.25 * Math.sin(2 * Math.PI * 65.4 * t) * Math.exp(-t * 2.4);
    out[i * 2] = v * env * 9000;
    out[i * 2 + 1] = v * env * 8200;
  }
  return out;
}

function blip(seconds) {
  const n = Math.floor(RATE * seconds);
  const out = new Float64Array(n);
  const notes = [440, 554.4, 659.3, 880, 659.3, 554.4];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const step = Math.floor((t / seconds) * notes.length) % notes.length;
    const env = Math.exp(-((t * notes.length) % 1) * 3.2);
    out[i] = Math.sin(2 * Math.PI * notes[step] * t) * env * 11000
      + Math.sin(2 * Math.PI * notes[step] * 2 * t) * env * 2200;
  }
  return out;
}

const audioA = wav(Array.from(chime(5.5)), RATE, 2);
const audioB = wav(Array.from(blip(2.4)), RATE, 1);
fs.writeFileSync(path.join(ASSETS, 'chime-stereo.wav'), audioA);
fs.writeFileSync(path.join(ASSETS, 'blip-mono.wav'), audioB);
log('  WAV  chime-stereo.wav' + '     5.50s  ' + kb(audioA.length));
log('  WAV  blip-mono.wav' + '        2.40s  ' + kb(audioB.length));

/* --------------------------------------------------------------- PDF */

function pdf(title) {
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const lines = [
    'BT /F1 26 Tf 64 760 Td (' + title + ') Tj ET',
    'BT /F2 11 Tf 64 726 Td (IDENTIFY 2.0 offline specimen document) Tj ET',
    'BT /F2 11 Tf 64 700 Td (This PDF was generated byte-by-byte by scripts/make-samples.mjs) Tj ET',
    'BT /F2 11 Tf 64 684 Td (It exists so the scanner can export a document at its exact) Tj ET',
    'BT /F2 11 Tf 64 668 Td (original size without any re-encoding.) Tj ET',
    '0.72 0.98 0.24 RG 3 w 64 640 m 531 640 l S',
    '0.29 0.85 1 RG 1.5 w 64 620 m 531 620 l S',
  ];
  const content = lines.join('\n');
  objects.push('<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + '\nendstream');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  const xrefStart = Buffer.byteLength(out);
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

const pdfBuf = pdf('RESOURCE SPECIMEN');
fs.writeFileSync(path.join(ASSETS, 'specimen.pdf'), pdfBuf);
log('  PDF  specimen.pdf' + '         ' + kb(pdfBuf.length));

/* -------------------------------------------------- CSV / MD / JSON / TXT */

const rows = [['编号', '资源名称', '类型', '体积KB', '许可']];
const kinds = ['图片', '视频', '音频', '文档', '字体'];
const rnd = mulberry(99);
for (let i = 1; i <= 32; i++) {
  rows.push(['R-' + String(i).padStart(4, '0'), 'specimen-' + i + '-' + kinds[i % kinds.length], kinds[i % kinds.length], (rnd() * 900 + 12).toFixed(1), i % 3 ? 'CC0' : '内部使用']);
}
const csv = '\ufeff' + rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
fs.writeFileSync(path.join(ASSETS, 'inventory.csv'), csv);

const md = ['# 资源标本馆', '', '本页由 `scripts/make-samples.mjs` 生成，用于在无网络环境下验证扫描、识别与按类型导出的完整链路。', '',
  '## 设计意图', '', '- 文字、图片、视音频、文档、样式表、字体、压缩包都被引用了一次', '- 相对路径与绝对路径混排，检验 URL 解析', '- 同一资源被多处引用，检验去重与计数', '- 懒加载属性与内联 JSON 中暗藏链接，检验深度提取', '',
  '## 导出承诺', '', '所有导出的文件都是原始字节：图片不会被压缩重编码，音视频不会被转码，文档不会被改写。', '', '> 识别，然后原样带走。', ''].join('\n');
fs.writeFileSync(path.join(ASSETS, 'notes.md'), md);

const json = JSON.stringify({ project: 'IDENTIFY', version: '2.0.0', assets: { hero: 'assets/grid-1200x800.png', badge: 'assets/badge-512.png', audio: 'assets/blip-mono.wav' }, lazy: { poster: 'assets/aurora-1920x1080.png' }, nested: { list: [{ file: 'assets/inventory.csv' }, { file: 'assets/specimen.pdf' }] } }, null, 2);
fs.writeFileSync(path.join(ASSETS, 'payload.json'), json);

const notes = 'IDENTIFY 2.0 plain-text specimen.\n\n原始大小导出：字节数、MD5 与站点返回值一致。\n';
fs.writeFileSync(path.join(ASSETS, 'notes.txt'), notes);

/* --------------------------------------------------------------- CSS */

const baseCss = [
  '.lab-quote{border-left:3px solid #b8ff3c;padding-left:1rem}',
  '.lab-figure{margin:0}',
  '/* 通过 @import 引入第二层样式，检验深度扫描 */',
  "@import url('layer-2.css');",
].join('\n');
const layer2 = [
  '.lazy-card{background-image:url(../assets/grid-1200x800.png);background-size:cover}',
  '@font-face{font-family:"Noto Serif SC";src:url(https://fonts.gstatic.com/s/notoserifsc/v22/H4chBXePl9DZ0Xe7gG9bcOa9IovDXThXkr8c0egL.woff2) format("woff2");font-weight:400}',
  '.watermark{background:url(../assets/dot-64.png) repeat}',
].join('\n');
fs.writeFileSync(path.join(ASSETS, 'base.css'), baseCss);
fs.writeFileSync(path.join(ASSETS, 'layer-2.css'), layer2);

/* --------------------------------------------------------------- ZIP */

const zipBuf = await zipToBuffer([
  { name: 'archive-readme.txt', data: '这是样本压缩包，用于验证压缩包类别的识别与导出。\n' },
  { name: 'inner/badge-96.png', data: fs.readFileSync(path.join(ASSETS, 'badge-96.png')) },
  { name: 'inner/notes.txt', data: notes },
], { comment: 'IDENTIFY sample archive' });
fs.writeFileSync(path.join(ASSETS, 'bundle-sample.zip'), zipBuf);
log('  ZIP  bundle-sample.zip' + '    ' + kb(zipBuf.length));

/* ------------------------------------------------------- 内联 data URI */

const tinyPng = encodePng(120, 80, (x, y, w, h) => {
  const u = x / w; const v = y / h;
  return [clamp(20 + u * 160), clamp(230 - v * 120), clamp(120 + u * 120)];
});
const tinySvg = ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="10" fill="#0b0f14"/><path d="M12 44 L32 14 L52 44Z" fill="#b8ff3c"/></svg>'].join('');
const dataPng = 'data:image/png;base64,' + tinyPng.toString('base64');
const dataSvg = 'data:image/svg+xml;base64,' + Buffer.from(tinySvg, 'utf-8').toString('base64');

/* --------------------------------------------------------------- 页面 */

const page = buildPage({ dataPng, dataSvg });
fs.writeFileSync(path.join(OUT, 'lab.html'), page);
log('  HTML public/samples/lab.html  ' + kb(Buffer.byteLength(page)));
if (!quiet) console.log('\n样本资源已就绪：http://127.0.0.1:4620/samples/lab\n');

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

function buildPage({ dataPng, dataSvg }) {
  const paragraphs = [
    '识别一台工具的诚实程度，取决于它敢不敢把原文件交到你手上。样本馆里的每一件标本都有确定的字节长度、确定的像素尺寸与确定的 MIME 类型：解析器读到的不是缩略图，也不是转码后的替身，而是站点返回的那一份原始数据。',
    '网页里的资源往往藏在四层地方：标签属性、样式表、脚本内的字符串、以及懒加载自定义属性。只解析 img 标签的工具会漏掉一半，尤其当页面用 data-src 与 srcset 承载高清素材时，缺失的往往是真正值得导出的那一张。',
    '本页刻意混排了相对路径与绝对路径、同名不同目录、重复引用与已失效链接，用来检验解析的稳健度：去重是否按绝对 URL 进行、相对路径是否以最终跳转地址为基准、失效资源是否被清楚标记而不是静默丢弃。',
    '文案部分同样重要。标题层级、列表、引用与表格构成页面的语义骨架，导出为 Markdown 后仍可还原结构；导航与页脚里的噪音文本被单独标注区域，你可以只带走正文，而不是整页的杂讯。',
  ];
  return ['<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>资源标本馆 · IDENTIFY 样本页</title>',
    '<meta name="description" content="IDENTIFY 2.0 离线样本页：混排图片、视音频、文档、字体、压缩包、懒加载与失效链接，用于验证资源识别与原尺寸导出。">',
    '<meta name="keywords" content="资源识别, 原尺寸导出, 网页解析, 样本页">',
    '<meta property="og:image" content="assets/aurora-2560x1440.png">',
    '<meta name="generator" content="make-samples.mjs">',
    '<link rel="icon" href="assets/dot-64.png">',
    '<link rel="apple-touch-icon" href="assets/badge-96.png">',
    '<link rel="stylesheet" href="assets/base.css">',
    '<link rel="preconnect" href="https://fonts.gstatic.com">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap">',
    '<style>',
    'body{margin:0;background:#05070a;color:#e7ecf3;font:16px/1.85 -apple-system,"PingFang SC","Helvetica Neue",sans-serif}',
    'main{max-width:56rem;margin:0 auto;padding:3rem 1.5rem 6rem}',
    'h1{font-size:clamp(2.4rem,7vw,4.6rem);line-height:1.02;letter-spacing:-.03em;margin:.2em 0}',
    'h2{margin-top:3rem;border-bottom:1px solid #1a212b;padding-bottom:.4rem}',
    'a{color:#4ad9ff}',
    'img{max-width:100%;display:block;border-radius:6px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem;margin:1.5rem 0}',
    '.bg-sample{height:150px;border-radius:8px;background-image:url(assets/badge-512.png);background-size:cover;background-position:center}',
    'table{border-collapse:collapse;width:100%}',
    'th,td{border:1px solid #1e2733;padding:.5rem .7rem;text-align:left;font-size:.92rem}',
    'ul{padding-left:1.2rem}',
    '.inline-strip img{display:inline-block;width:118px;margin-right:8px;vertical-align:top}',
    '</style>',
    '</head><body>',
    '<header style="padding:2rem 0 0"><img src="assets/logo-crest.svg" alt="IDENTIFY 标志" width="320" height="120"></header>',
    '<main>',
    '<p style="letter-spacing:.4em;color:#5c6472;font-size:.75rem">OFFLINE SPECIMEN · 001</p>',
    '<h1>资源标本馆</h1>',
    '<p>把这一页的地址填进扫描台，就能在没有外网的情况下看到完整的识别与导出流程：'
      + '<strong>文字、图片、视音频、文档、字体、样式表、压缩包</strong>七类资源各就位。</p>',
    '<h2>正文段落</h2>',
    paragraphs.map((t) => '<p>' + t + '</p>').join('\n'),
    '<blockquote class="lab-quote">识别，然后原样带走。<br>—— 样本馆宣言</blockquote>',
    '<h2>图片与尺寸</h2>',
    '<p>下列图片拥有不同的原生分辨率，导出后的宽高应与卡片中显示的数字完全一致。</p>',
    '<div class="grid">',
    '<figure class="lab-figure"><img src="assets/aurora-1920x1080.png" alt="极光渐变 1920x1080" width="1920" height="1080"><figcaption>极光 A · 1920×1080</figcaption></figure>',
    '<figure class="lab-figure"><img src="assets/grid-1200x800.png" alt="网格 1200x800"><figcaption>网格 · 1200×800</figcaption></figure>',
    '<figure class="lab-figure"><img src="assets/badge-512.png" alt="徽章 512"><figcaption>徽章 · 512×512</figcaption></figure>',
    '<figure class="lab-figure"><img src="assets/icon-mask.svg" alt="矢量图标 200x200" width="200" height="200"><figcaption>矢量 · SVG</figcaption></figure>',
    '</div>',
    '<picture>',
    '<source srcset="assets/badge-96.png 96w, assets/badge-512.png 512w" sizes="(max-width:600px) 96px, 512px">',
    '<img src="assets/badge-512.png" srcset="assets/badge-512.png 512w, assets/aurora-2560x1440.png 2560w" alt="响应式图片组">',
    '</picture>',
    '<h2>懒加载与脚本内嵌地址</h2>',
    '<div class="grid">',
    '<div class="lazy-card" data-src="assets/aurora-2560x1440.png" data-original="assets/grid-1200x800.png" title="data-src 承载高清图"></div>',
    '<div class="bg-sample" style="background-image:url(assets/aurora-1920x1080.png)"></div>',
    '<img data-src="assets/dot-64.png" data-thumbnail="assets/badge-96.png" src="assets/dot-64.png" alt="懒加载小图">',
    '<div class="watermark" style="height:150px;border-radius:8px"></div>',
    '</div>',
    '<script type="application/json" id="boot-data">'
      + JSON.stringify({ hero: 'assets/aurora-2560x1440.png', gallery: ['assets/grid-1200x800.png', 'assets/badge-512.png'], audio: 'assets/chime-stereo.wav', doc: 'assets/specimen.pdf', lazyTile: 'assets/hidden-lazy-320x200.png' })
      + '</script>',
    '<script>window.__SPECIMEN__={poster:"assets/aurora-1920x1080.png",zip:"assets/bundle-sample.zip",csv:"assets/inventory.csv",hidden:"assets/hidden-lazy-320x200.png",exclusive:"assets/hidden-lazy-320x200.png?v=7"};</script>',
    '<noscript><img src="assets/badge-96.png" alt="无脚本兜底图片"></noscript>',
    '<h2>内联 data URI 资源</h2>',
    '<p class="inline-strip">',
    '<img src="' + dataPng + '" alt="内联 PNG 位图">',
    '<img src="' + dataSvg + '" alt="内联 SVG">',
    '</p>',
    '<h2>视音频</h2>',
    '<video width="640" height="360" poster="assets/grid-1200x800.png" preload="metadata" controls>',
    '<source src="assets/blip-mono.wav" type="audio/wav">',
    '<source src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" type="video/mp4">',
    '当前浏览器不支持内嵌播放器',
    '</video>',
    '<audio src="assets/chime-stereo.wav" controls preload="metadata"></audio>',
    '<p>视频标签引用了外网 MP4（约 1.1 MB），音频引用本地 WAV（约 900 KB）。若外网不可达，扫描台会把该条目标记为失效而不是丢弃。</p>',
    '<h2>文档与数据下载</h2>',
    '<ul>',
    '<li><a href="assets/specimen.pdf" download> specimen.pdf · PDF 文档</a></li>',
    '<li><a href="assets/inventory.csv" download>inventory.csv · 表格数据</a></li>',
    '<li><a href="assets/notes.md" download>notes.md · Markdown 文稿</a></li>',
    '<li><a href="assets/notes.txt">notes.txt · 纯文本</a></li>',
    '<li><a href="assets/payload.json">payload.json · JSON 数据</a></li>',
    '<li><a href="assets/bundle-sample.zip" download>bundle-sample.zip · 压缩包</a></li>',
    '<li><a href="assets/missing-404.png">missing-404.png · 故意失效的引用</a></li>',
    '<li><a href="https://example.com/never-heard-of-it.webp">外站不存在的 webp</a></li>',
    '</ul>',
    '<h2>表格与结构</h2>',
    '<table><caption>导出策略对照</caption><thead><tr><th>类型</th><th>导出单位</th><th>是否保持原始字节</th></tr></thead><tbody>',
    '<tr><td>图片</td><td>单个文件</td><td>是</td></tr>',
    '<tr><td>视音频</td><td>单个文件</td><td>是</td></tr>',
    '<tr><td>文档</td><td>单个文件</td><td>是</td></tr>',
    '<tr><td>文案</td><td>Markdown / CSV / JSON / HTML / TXT</td><td>结构可还原</td></tr>',
    '</tbody></table>',
    '<h2>关键词密度</h2>',
    '<p>资源识别、原尺寸导出、深度扫描、类型分组、失效标记、去重计数、清单文件、字节校验——这些词在样本页里各出现两次以上，便于检验关键词抽取。</p>',
    '<p>资源识别是入口，原尺寸导出是承诺。深度扫描负责把藏在样式表与脚本里的资源一并捞出，类型分组让批量导出变得可预期。</p>',
    '</main>',
    '<footer style="padding:3rem 1.5rem;border-top:1px solid #16202b;color:#4d5765">',
    '<p>样本页脚：这一段的文字位于 footer 区域内，扫描台会把它的区域标记为 noise，导出文案时可一键排除。</p>',
    '<nav><a href="#top">返回顶部</a> · <a href="/samples/lab">重新载入</a></nav>',
    '</footer>',
    '</body></html>'].join('\n');
}
