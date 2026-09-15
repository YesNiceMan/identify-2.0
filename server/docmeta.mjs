/**
 * 文档与流媒体容器的深度解析（零依赖）
 *
 *   parsePlaylist()  HLS(m3u8) / DASH(mpd)：清晰度档位、码率、时长、分片数、编解码、字幕音轨
 *   pdfMeta()        版本、页数、标题 / 作者 / 主题 / 关键词、页面尺寸、是否加密、内嵌图片数
 *   officeMeta()     docx / xlsx / pptx / epub / odt 的 core 属性与包内结构
 *   zipEntries()     只读中央目录：不解压即可列出包内文件与体积
 * 解析出的字段一律做长度与数量上限，避免把结果撑爆。
 */
import zlib from 'node:zlib';

const u16le = (b, p) => (p + 1 < b.length ? b[p] | (b[p + 1] << 8) : 0);
const u32le = (b, p) => (p + 3 < b.length ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0) : 0);

function ascii(b, p, len) {
  if (p < 0 || len <= 0 || p + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[p + i]);
  return s;
}
function clip(v, n) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function dropEmpty(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === 0 || obj[k] === '' || obj[k] == null || obj[k] === false) delete obj[k];
    else if (Array.isArray(obj[k]) && !obj[k].length) delete obj[k];
  }
  return obj;
}

/* ----------------------------------------------------------- ZIP 目录 */

/** 读 ZIP 中央目录（不解压）。entries: {name,size,packed,method,offset} */
export function zipEntries(buffer, limit = 1200) {
  const out = { entries: [], total: 0, truncated: false };
  if (!buffer || buffer.length < 22) return out;
  let eocd = -1;
  const from = Math.max(0, buffer.length - 66000);
  for (let p = buffer.length - 22; p >= from; p--) {
    if (u32le(buffer, p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) return out;
  let count = u16le(buffer, eocd + 10);
  let cdPtr = u32le(buffer, eocd + 16);
  if (count === 0xffff || cdPtr === 0xffffffff) {
    for (let p = Math.max(0, eocd - 64); p + 20 <= eocd; p++) {
      if (u32le(buffer, p) !== 0x07064b50) continue;
      const rel = u32le(buffer, p + 8);
      if (rel > 0 && rel + 56 < buffer.length && u32le(buffer, rel) === 0x06064b50) {
        try {
          count = Number(buffer.readBigUInt64LE(rel + 32)) || count;
          cdPtr = Number(buffer.readBigUInt64LE(rel + 48)) || cdPtr;
        } catch { /* 保持 32 位值 */ }
      }
      break;
    }
  }
  let p = cdPtr;
  for (let i = 0; i < count && i < limit; i++) {
    if (p + 46 > buffer.length || u32le(buffer, p) !== 0x02014b50) break;
    const method = u16le(buffer, p + 10);
    const packed = u32le(buffer, p + 20);
    const size = u32le(buffer, p + 24);
    const nameLen = u16le(buffer, p + 28);
    const extraLen = u16le(buffer, p + 30);
    const commentLen = u16le(buffer, p + 32);
    const offset = u32le(buffer, p + 42);
    out.entries.push({ name: ascii(buffer, p + 46, Math.min(nameLen, 400)), size, packed, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  out.total = count;
  out.truncated = count > out.entries.length;
  return out;
}

/** 解压包里某个条目（仅小体积，防解压炸弹） */
function inflateEntry(buffer, entry, maxOut = 256 * 1024) {
  try {
    const at = entry.offset;
    if (at < 0 || at + 30 > buffer.length || u32le(buffer, at) !== 0x04034b50) return null;
    const nameLen = u16le(buffer, at + 26);
    const extraLen = u16le(buffer, at + 28);
    const start = at + 30 + nameLen + extraLen;
    if (entry.packed < 0 || start + entry.packed > buffer.length) return null;
    const raw = buffer.subarray(start, start + entry.packed);
    if (entry.method === 0) return raw.length > maxOut ? null : Buffer.from(raw);
    if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: maxOut });
  } catch { /* 单条目失败不影响整体 */ }
  return null;
}

function readEntryText(buffer, entries, re, max = 200 * 1024) {
  for (const e of entries) {
    if (!re.test(e.name)) continue;
    if ((e.size || 0) > max) continue;
    const buf = inflateEntry(buffer, e, max);
    if (buf && buf.length) return buf.toString('utf-8');
  }
  return '';
}

/* --------------------------------------------------- OOXML / ODF / EPUB */

function xmlTag(text, tag) {
  const re = new RegExp('<(?:[a-z0-9]+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]{0,400}?)</(?:[a-z0-9]+:)?' + tag + '>', 'i');
  const m = re.exec(text);
  return m ? clip(m[1].replace(/<[^>]*>/g, ''), 200) : '';
}

/** docx / xlsx / pptx / epub / odf 的结构与属性 */
export function officeMeta(buffer) {
  const z = zipEntries(buffer);
  if (!z.entries.length) return {};
  const names = z.entries.map((e) => e.name);
  const has = (re) => names.some((n) => re.test(n));
  const out = {};
  if (has(/^word\/document\.xml$/)) out.flavor = 'docx';
  else if (has(/^xl\/workbook\.xml$/)) out.flavor = 'xlsx';
  else if (has(/^ppt\/presentation\.xml$/)) out.flavor = 'pptx';
  else if (has(/\.[a-z]+\.epub$/i) || (has(/^mimetype$/) && /epub/i.test(readEntryText(buffer, z.entries, /^mimetype$/, 256)))) out.flavor = 'epub';
  else if (has(/^mimetype$/) && /application\/vnd\.oasis/i.test(readEntryText(buffer, z.entries, /^mimetype$/, 256))) out.flavor = 'odf';
  else if (has(/^content\.xml$/)) out.flavor = 'odf';
  out.entries = z.total;
  out.uncompressedBytes = z.entries.reduce((n, e) => n + (e.size || 0), 0);
  out.mediaFiles = names.filter((n) => /\.(png|jpe?g|gif|webp|avif|svg|mp3|m4a|mp4|webm|wav)$/i.test(n)).length;

  const core = readEntryText(buffer, z.entries, /(?:^|\/)docProps\/core\.xml$|^content\.xml$|\.opf$/);
  if (core) {
    out.title = xmlTag(core, 'title');
    out.creator = xmlTag(core, 'creator') || xmlTag(core, 'initial-creator');
    out.subject = xmlTag(core, 'subject');
    out.keywords = xmlTag(core, 'keywords');
    out.description = xmlTag(core, 'description');
    out.lastModifiedBy = xmlTag(core, 'lastModifiedBy');
    out.created = xmlTag(core, 'created') || xmlTag(core, 'creation-date');
    out.modified = xmlTag(core, 'modified') || xmlTag(core, 'date');
    out.language = xmlTag(core, 'language');
  }
  const app = readEntryText(buffer, z.entries, /^docProps\/app\.xml$/);
  if (app) {
    out.pages = Number(xmlTag(app, 'Pages')) || 0;
    out.words = Number(xmlTag(app, 'Words')) || 0;
    out.paragraphs = Number(xmlTag(app, 'Paragraphs')) || 0;
    out.software = xmlTag(app, 'Application');
  }
  if (out.flavor === 'xlsx') {
    const wb = readEntryText(buffer, z.entries, /^xl\/workbook\.xml$/, 600 * 1024);
    const sheets = wb ? (wb.match(/<sheet[\s>/]/g) || []).length : 0;
    if (sheets) out.sheets = sheets;
    const shared = z.entries.find((e) => e.name === 'xl/sharedStrings.xml');
    if (shared) out.textCells = Number((readEntryText(buffer, z.entries, /^xl\/sharedStrings\.xml$/, 600 * 1024).match(/<si>/g) || []).length) || 0;
  }
  if (out.flavor === 'pptx') {
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
    if (slides) out.pages = slides;
  }
  if (out.flavor === 'docx') {
    const doc = readEntryText(buffer, z.entries, /^word\/document\.xml$/, 4 * 1024 * 1024);
    if (doc) {
      out.paragraphs = (doc.match(/<w:p[\s>/]/g) || []).length || out.paragraphs;
      out.images = (doc.match(/<pic:pic[\s>]|<w:drawing>/g) || []).length;
      out.textChars = clip(doc.replace(/<[^>]*>/g, ''), 1e9).replace(/\s+/g, '').length;
    }
  }
  if (out.flavor === 'epub') {
    const opf = readEntryText(buffer, z.entries, /\.opf$/);
    if (opf) {
      out.spine = (opf.match(/<itemref\b/gi) || []).length;
      out.images = names.filter((n) => /\.(png|jpe?g|gif|svg|webp)$/i.test(n)).length;
    }
  }
  return dropEmpty(out);
}

/* ------------------------------------------------------------------ PDF */

/** PDF：版本、页数、文档信息、页面尺寸、加密、图片与字体统计 */
export function pdfMeta(buffer) {
  const out = {};
  if (!buffer || buffer.length < 8 || ascii(buffer, 0, 5) !== '%PDF-') return out;
  out.version = ascii(buffer, 5, 3).slice(0, 3);
  const text = buffer.toString('latin1');
  const head = text.slice(0, 4000);
  out.linearized = /\/Linearized\s+1/.test(head);
  out.encrypted = /\/Encrypt\b/.test(text);
  out.pages = pdfPageCount(text);
  out.images = (text.match(/\/Subtype\s*\/Image\b/g) || []).length;
  out.fonts = (text.match(/\/Type\s*\/Font\b/g) || []).length;
  out.links = Math.min((text.match(/\/URI\b/g) || []).length, 9999);
  out.forms = /\/AcroForm\b/.test(text);
  out.appended = (text.match(/%%EOF/g) || []).length > 1;
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  if (box) {
    const w = Math.abs(Number(box[3]) - Number(box[1]));
    const h = Math.abs(Number(box[4]) - Number(box[2]));
    if (w > 0 && h > 0 && w < 20000 && h < 20000) {
      out.width = Math.round(w);
      out.height = Math.round(h);
      out.pageSize = pdfPageName(w, h);
    }
  }
  Object.assign(out, pdfInfoDicts(text));
  if (!/%%EOF\s*/.test(text.slice(-2048))) out.incomplete = true;
  return dropEmpty(out);
}

function pdfPageName(w, h) {
  const mm = (v) => (v * 25.4) / 72;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const landscape = w > h;
  const W = mm(w); const H = mm(h);
  const table = [['A3', 297, 420, 10], ['A4', 210, 297, 8], ['A5', 148, 210, 6], ['Letter', 215.9, 279.4, 8], ['Legal', 215.9, 355.6, 8]]
    .find(([, a, b]) => near(landscape ? H : W, a, 8) && near(landscape ? W : H, b, b * 0.05));
  if (!table) return Math.round(W) + '×' + Math.round(H) + ' mm';
  return table[0] + (landscape ? ' 横向' : ' 纵向');
}

/** 页数：优先 Pages 字典的 /Count，其次数 /Page 对象 */
function pdfPageCount(text) {
  let best = 0;
  const reA = /\/Type\s*\/Pages\b[^\]]{0,200}?\/Count\s+(\d+)/g;
  const reB = /\/Count\s+(\d+)[^\]]{0,200}?\/Type\s*\/Pages\b/g;
  for (const re of [reA, reB]) {
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 200) {
      const v = Number(m[1]);
      if (v > best && v < 5000000) best = v;
    }
  }
  if (best) return best;
  const single = (text.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  if (single) return single;
  const kids = (text.match(/\/Kids\s*\[/g) || []).length;
  return kids || 0;
}

const PDF_INFO_KEYS = {
  Title: 'title', Author: 'creator', Subject: 'subject', Keywords: 'keywords',
  Creator: 'software', Producer: 'producer', CreationDate: 'created', ModDate: 'modified',
};

function pdfInfoDicts(text) {
  const out = {};
  const re = /\/(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)\s*([(\<])/g;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 300) {
    const key = PDF_INFO_KEYS[m[1]];
    if (!key || out[key]) continue;
    const open = m[2];
    const start = m.index + m[0].length;
    const raw = open === '(' ? readPdfLiteral(text, start) : text.slice(start, (text.indexOf('>', start) + 1 || text.length));
    if (!raw) continue;
    out[key] = clip(open === '(' ? pdfString(raw) : pdfHexBytes(raw), 200);
  }
  if (!out.title) {
    const x = /<xmp:Title>([^<]{1,200})</.exec(text) || /<dc:title[^>]*>([^<]{1,200})</i.exec(text);
    if (x) out.title = clip(decodeXml(x[1]), 200);
  }
  if (!out.creator) {
    const x = /<dc:creator[^>]*>([^<]{1,200})</i.exec(text) || /<xmp:Creator>([^<]{1,200})</.exec(text);
    if (x) out.creator = clip(decodeXml(x[1]), 200);
  }
  if (out.created) out.created = pdfDate(out.created);
  if (out.modified) out.modified = pdfDate(out.modified);
  return out;
}

/** 字面字符串：处理嵌套括号与转义 */
function readPdfLiteral(text, start) {
  let depth = 1;
  let s = '';
  for (let i = start; i < text.length && s.length < 4000; i++) {
    const c = text[i];
    if (c === '\\') { s += c + (text[i + 1] || ''); i++; continue; }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (!depth) return s; }
    s += c;
  }
  return null;
}

/** 十六进制字符串：<FEFF...> 为 UTF-16BE，其余按 PDFDocEncoding */
function pdfHexBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (!clean.length || clean.length % 2) return '';
  const bytes = Buffer.from(clean.replace(/(..)/g, '$1').match(/.{2}/g).map((p) => parseInt(p, 16)));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  return bytes.toString('latin1').replace(/\u0000/g, ' ');
}

/** PDF 字串：支持 () 内八进制 / 转义与 UTF-16BE BOM */
function pdfString(body) {
  const s = String(body || '');
  if (/^\xFE\xFF/.test(s)) {
    let outStr = '';
    for (let i = 2; i + 1 < s.length; i += 2) outStr += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return outStr;
  }
  return s.replace(/\\([0-7]{1,3}|.)/g, (all, ch) => {
    if (/^[0-7]+$/.test(ch)) return String.fromCharCode(parseInt(ch, 8));
    const named = { n: '\\n', r: '\\r', t: '\\t', b: '\\b', f: '\\f' };
    return named[ch] !== undefined ? named[ch] : ch;
  });
}

function pdfDate(v) {
  const m = /D:?\s*(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(v));
  if (!m) return clip(v, 40);
  const [, y, mo, d, h, mi] = m;
  return y + (mo ? '-' + mo : '') + (d ? '-' + d : '') + (h ? ' ' + h + ':' + (mi || '00') : '');
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (a, n) => String.fromCharCode(Number(n)));
}

/* ------------------------------------------------------- HLS / DASH */

const HLS_RES_RE = /RESOLUTION=(\d{1,5})x(\d{1,5})/i;

/** 自适应码率清单解析：m3u8（主 / 媒体清单）与 mpd（DASH） */
export function playlistMeta(buffer, url = '', mime = '') {
  if (!buffer || !buffer.length) return null;
  const head = String(buffer.subarray(0, Math.min(buffer.length, 400 * 1024)).toString('utf-8'));
  const u = String(url || '').toLowerCase();
  const isM3u8 = /^\s*#EXTM3U/m.test(head) || /mpegurl|\.m3u8($|\?)/i.test(u) || /mpegurl/i.test(mime);
  const isMpd = /<MPD[\s>]/i.test(head.slice(0, 4000)) || /dash\+xml|\.mpd($|\?)/i.test(u);
  if (!isM3u8 && !isMpd) return null;
  const out = isMpd ? dashParse(head) : hlsParse(head);
  out.kind = isMpd ? 'DASH' : 'HLS';
  return dropEmpty(out);
}

function attrOf(line, name) {
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(line) || new RegExp(name + '\\s*=\\s*([\\w.+-]+)', 'i').exec(line);
  return m ? m[1] : '';
}

function hlsParse(text) {
  const out = {};
  const variants = [];
  const langs = new Set();
  let totalDuration = 0;
  let segments = 0;
  const target = /#EXT-X-TARGETDURATION:\s*([\d.]+)/i.exec(text);
  if (target) out.segmentDuration = Number(target[1]) || 0;
  const seq = /#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i.exec(text);
  if (seq) out.startSequence = Number(seq[1]) || 0;
  const endList = /#EXT-X-ENDLIST/i.test(text);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] !== '#') {
      if (!out.firstSegment && /#EXTINF/.test(lines[i - 1] || '') && /\.[a-z0-9]{2,5}(\?|$)/i.test(line)) out.firstSegment = clip(line, 200);
      continue;
    }
    if (/#EXT-X-STREAM-INF/i.test(line)) {
      const res = HLS_RES_RE.exec(line);
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const fr = /FRAME-RATE=([\d.]+)/i.exec(line);
      variants.push({
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        bandwidth: bw ? Number(bw[1]) : 0,
        codecs: attrOf(line, 'CODECS'),
        frameRate: fr ? Number(fr[1]) : 0,
        range: attrOf(line, 'VIDEO-RANGE'),
        url: clip(String(lines[i + 1] || '').trim(), 200),
      });
    } else if (/#EXT-X-MEDIA/i.test(line)) {
      const type = attrOf(line, 'TYPE').toUpperCase();
      if (type === 'SUBTITLES') out.subtitleTracks = (out.subtitleTracks || 0) + 1;
      if (type === 'AUDIO') out.audioGroups = (out.audioGroups || 0) + 1;
      const lang = attrOf(line, 'LANGUAGE');
      if (lang) langs.add(lang);
    } else if (/#EXTINF:\s*([\d.]+)/i.test(line)) {
      totalDuration += Number((/#EXTINF:\s*([\d.]+)/i.exec(line))[1]) || 0;
      segments++;
    } else if (/#EXT-X-MAP/i.test(line)) out.fmp4 = true;
    else if (/#EXT-X-KEY/i.test(line)) {
      const method = attrOf(line, 'METHOD');
      if (method && method !== 'NONE') out.encrypted = true;
    } else if (/#EXT-X-SESSION-DATA/i.test(line)) out.sessionData = true;
  }
  out.variantCount = variants.length;
  out.variants = variants.map(dropEmpty);
  out.segments = segments;
  if (totalDuration) out.duration = Math.round(totalDuration * 10) / 10;
  if (langs.size) out.languages = [...langs].slice(0, 12);
  const best = variants.reduce((a, v) => ((v.width || 0) > (a.width || 0) ? v : a), variants[0] || {});
  if (best.width) { out.width = best.width; out.height = best.height; }
  const bws = variants.map((v) => v.bandwidth).filter(Boolean);
  if (bws.length) out.bitrate = Math.max(...bws);
  const codecs = [...new Set(variants.map((v) => v.codecs).filter(Boolean).join(',').split(','))].filter(Boolean);
  if (codecs.length) out.codec = clip(codecs.join(' + '), 80);
  if (!endList && !variants.length) out.live = true;
  return out;
}

function dashParse(text) {
  const out = {};
  const reps = [];
  const re = /<Representation\b[^>]*>/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 120) {
    const tag = m[0];
    reps.push(dropEmpty({
      width: Number((/\swidth="(\d+)"/i.exec(tag) || [])[1]) || 0,
      height: Number((/\sheight="(\d+)"/i.exec(tag) || [])[1]) || 0,
      bandwidth: Number((/bandwidth="(\d+)"/i.exec(tag) || [])[1]) || 0,
      codecs: (/codecs="([^"]+)"/i.exec(tag) || [])[1] || '',
      frameRate: Number((/frameRate="([\d.]+)"/i.exec(tag) || [])[1]) || 0,
    }));
  }
  const dur = /mediaPresentationDuration="PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:([\d.]+)S)?"/i.exec(text);
  if (dur) out.duration = Math.round(((Number(dur[1] || 0) * 3600) + (Number(dur[2] || 0) * 60) + Number(dur[3] || 0)) * 10) / 10;
  out.adaptive = /AdaptationSet\b/i.test(text);
  out.live = /type="dynamic"/i.test(text);
  out.encrypted = /<ContentProtection\b/i.test(text);
  out.segmentTemplates = (text.match(/<Segment(?:Template|List|Base)/g) || []).length;
  out.periods = (text.match(/<Period\b/g) || []).length;
  out.variantCount = (text.match(/<Representation\b/gi) || []).length;
  out.variants = reps.slice(0, 24);
  const best = reps.reduce((a, v) => ((v.width || 0) > (a.width || 0) ? v : a), reps[0] || {});
  if (best.width) { out.width = best.width; out.height = best.height; }
  const bws = reps.map((r) => r.bandwidth).filter(Boolean);
  if (bws.length) out.bitrate = Math.max(...bws);
  const codecs = [...new Set(reps.map((r) => r.codecs).filter(Boolean))];
  if (codecs.length) out.codec = clip(codecs.join(' + '), 80);
  const langs = [...new Set(reps.map((r) => r.lang).filter(Boolean))];
  if (langs.length) out.languages = langs.slice(0, 12);
  return out;
}