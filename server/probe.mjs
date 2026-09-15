/**
 * 从字节流解析媒体元数据：尺寸 / 时长 / 真实格式 / 动图 / 编码（零依赖）
 *
 *  图片：PNG（APNG 动画、位深、色彩类型、alpha、隔行、DPI）、GIF（帧数、动画时长）、
 *        WebP（动图 / alpha / 有损无损）、JPEG（渐进式、通道、EXIF 方向）、BMP、TIFF、
 *        ICO / CUR（多尺寸清单）、SVG（viewBox、精灵图 symbol 数、路径数）、HEIF / AVIF、JPEG 2000
 *  音视频：MP4/MOV（mvhd + tkhd + 矩阵旋转 + codec 四字符码）、Matroska/WebM（完整 EBML 遍历）、
 *        MP3（Xing / Info / IB+ 与 CBR 估算）、WAV（fmt 细节）、Ogg（Vorbis / Opus 末页 granule）、
 *        FLAC（STREAMINFO 总样本数）、AIFF / AIFC
 *  文档：PDF、OOXML、OLE2、RTF、ZIP / RAR / 7z / gz / xz / tar、WebVTT、SRT、HLS、SQLite、WASM
 */

import zlib from 'node:zlib';
import {
  mp4Info as mp4Boxes, aviInfo as aviParse, flvInfo as flvParse, id3Tags,
  fontInfo as fontParse, icnsInfo as icnsParse, ddsInfo, exrInfo, pnmInfo, tgaInfo, qoiInfo,
} from './containers.mjs';

const u16le = (b, p) => (p + 1 < b.length ? b[p] | (b[p + 1] << 8) : 0);
const u16be = (b, p) => (p + 1 < b.length ? (b[p] << 8) | b[p + 1] : 0);
const u32le = (b, p) => (p + 3 < b.length ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0) : 0);
const u32be = (b, p) => (p + 3 < b.length ? (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0) : 0);
const i32be = (b, p) => (p + 3 < b.length ? ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0 : 0);
const i32le = (b, p) => (p + 3 < b.length ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0 : 0);

function u64be(b, p) {
  if (p + 7 >= b.length) return 0;
  try { return Number(b.readBigUInt64BE(p)); } catch { return 0; }
}
function i64le(b, p) {
  if (p + 7 >= b.length) return 0;
  try { return Number(b.readBigInt64LE(p)); } catch { return 0; }
}
function f32be(b, p) {
  if (p + 3 >= b.length) return 0;
  try { return b.readFloatBE(p); } catch { return 0; }
}
function f64be(b, p) {
  if (p + 7 >= b.length) return 0;
  try { return b.readDoubleBE(p); } catch { return 0; }
}
function ascii(b, p, len) {
  if (p < 0 || len <= 0 || p + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[p + i]);
  return s;
}
function readLEBits(b, bitPos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const p = bitPos + i;
    if ((p >> 3) >= b.length) break;
    v |= ((b[p >> 3] >> (p & 7)) & 1) << i;
  }
  return v;
}
/** 在字节流里查找一段 latin1 字符序列 */
function indexOfSeq(buf, seq, from, to) {
  const needle = Buffer.from(seq, 'latin1');
  const start = Math.max(0, from || 0);
  const end = Math.min(to == null ? buf.length : to, buf.length) - needle.length;
  for (let p = start; p <= end; p++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[p + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return p;
  }
  return -1;
}
function readText(b, at, max) {
  if (at < 0) return '';
  let s = '';
  for (let i = at; i < b.length && b[i] && s.length < (max || 120); i++) s += String.fromCharCode(b[i]);
  return s.trim();
}

/* ------------------------------------------------------------ 图片 */

export function imageDimensions(buffer, mime = '') {
  if (!buffer || buffer.length < 8) return null;
  try {
    if (ascii(buffer, 0, 4) === '\x89PNG') return pngInfo(buffer);
    if (ascii(buffer, 0, 3) === 'GIF') return gifInfo(buffer);
    if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return webpInfo(buffer);
    if (ascii(buffer, 0, 2) === 'BM' && buffer.length > 26) {
      const w = i32le(buffer, 18); const h = i32le(buffer, 22);
      if (Math.abs(w) > 1 && Math.abs(h) > 1) return { width: Math.abs(w), height: Math.abs(h), bitDepth: u16le(buffer, 28), alpha: false };
    }
    if (isIco(buffer)) return icoInfo(buffer);
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegInfo(buffer);
    if (ascii(buffer, 0, 4) === 'II*\x00' || ascii(buffer, 0, 4) === 'MM\x00*') return tiffInfo(buffer);
    if (ascii(buffer, 0, 4) === '8BPS') return { width: u32be(buffer, 16), height: u32be(buffer, 20), bitDepth: u16be(buffer, 24) };
    if (ascii(buffer, 0, 12) === '\x00\x00\x00\x0cjP  \x0d\x0a\x87\x0a') return jpeg2000Size(buffer);
    const qoi = qoiInfo(buffer);
    if (qoi) return qoi;
    const dds = ddsInfo(buffer);
    if (dds) return dds;
    const exr = exrInfo(buffer);
    if (exr) return exr;
    if (ascii(buffer, 0, 4) === 'icns') {
      const ic = icnsParse(buffer);
      if (ic) return ic;
    }
    const pnm = pnmInfo(buffer);
    if (pnm) return pnm;
    if (/tga|x-tga|ega-i8/i.test(String(mime))) {
      const tga = tgaInfo(buffer);
      if (tga) return tga;
    }
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      const z = gunzipHead(buffer);
      if (z) {
        const r = imageDimensions(z, mime);
        if (r) { r.transport = 'gzip'; return r; }
      }
    }
    const text = String(buffer.subarray(0, Math.min(buffer.length, 12000)).toString('utf-8'));
    if (/svg/i.test(String(mime)) || /^\s*(<\?xml|<svg|<!--)/i.test(text)) return svgInfo(text);
    const box = ascii(buffer, 4, 4);
    if (box === 'ftyp') {
      const brand = ascii(buffer, 8, 4);
      if (/heic|heix|heim|mif1|msf1|avif/.test(brand)) {
        const r = heifSize(buffer);
        if (r) { r.codec = brand.trim(); return r; }
      }
    }
  } catch { /* noop */ }
  return null;
}

function isIco(b) {
  return b.length > 22 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0;
}

function pngInfo(b) {
  const out = { width: u32be(b, 16), height: u32be(b, 20) };
  out.bitDepth = b[24];
  out.colorType = b[25];
  out.channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[b[25]] || 0;
  out.alpha = b[25] === 4 || b[25] === 6;
  if (b[28] === 1) out.interlaced = true;
  let p = 8;
  for (let guard = 0; guard < 64 && p + 12 <= b.length; guard++) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    if (len > b.length) break;
    if (type === 'acTL') {
      out.animated = true;
      out.frames = u32be(b, p + 8) || 0;
      out.plays = u32be(b, p + 12);
    } else if (type === 'tRNS') {
      out.alpha = true;
    } else if (type === 'sRGB') {
      out.colorSpace = ({ 0: '默认', 1: 'sRGB', 2: 'Linear RGB', 3: 'RGB' })[b[p + 8]] || 'sRGB';
    } else if (type === 'iCCP') {
      out.colorSpace = 'ICC ' + ascii(b, p + 8, Math.min(24, len - 1)).split('\x00')[0];
    } else if (type === 'bKGD') {
      out.background = true;
    } else if (type === 'fcTL' && out.animated) {
      const num = u32be(b, p + 20);
      const den = u32be(b, p + 24) || 100;
      out.duration = Math.round(((out.duration || 0) + num / den) * 100) / 100;
      if (u32be(b, p + 8) === 0 && u32be(b, p + 12) === 0) out.firstFrame = true;
    } else if (type === 'pHYs') {
      const unit = b[p + 16];
      if (unit === 1) out.dpi = Math.round(u32be(b, p + 8) * 0.0254);
    } else if (type === 'eXIf') {
      const o = exifOrientationBlock(b, p + 8, len);
      if (o) out.orientation = o;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

function gifInfo(b) {
  const out = { width: u16le(b, 6), height: u16le(b, 8), version: ascii(b, 3, 3) };
  let loop = -1;
  for (let i = 0; i + 19 < b.length; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xff && ascii(b, i + 3, 11) === 'NETSCAPE2.0') {
      if (b[i + 16] === 1) loop = u16le(b, i + 17);
      break;
    }
  }
  if (loop >= 0) out.loops = loop === 0 ? '无限' : loop + ' 次';
  let frames = 0;
  let delay = 0;
  let transparent = false;
  for (let i = 0; i + 7 < b.length; i++) {
    if (b[i] === 0x21 && b[i + 1] === 0xf9) {
      frames++;
      if (b[i + 3] & 0x01) transparent = true;
      delay += u16le(b, i + 4);
      i += 6;
    }
  }
  out.frames = Math.max(1, frames);
  out.transparent = transparent;
  if (frames > 1) {
    out.animated = true;
    out.duration = Math.round(delay) / 100;
  }
  return out;
}

/**
 * 动图 WebP 的动画块：ANIM 里的循环次数 + 每个 ANMF 的 24 位帧时长（毫秒）累加。
 * 只走 RIFF 块表，不碰压缩数据。
 */
function webpAnim(b) {
  const out = { loop: undefined, duration: 0, keyframes: 0, frames: 0 };
  let p = 12;
  let guard = 0;
  while (p + 8 <= b.length && guard++ < 4000) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    const body = p + 8;
    if (size < 0 || body > b.length) break;
    if (id === 'ANIM' && body + 6 <= b.length) out.loop = u16le(b, body + 4);
    else if (id === 'ANMF' && body + 15 <= b.length) {
      out.frames++;
      const ms = b[body + 12] | (b[body + 13] << 8) | (b[body + 14] << 16);
      out.duration += ms;
      /** 末字节：高 6 位保留，bit1 = disposal（1=画回底色），bit0 = blending（1=不混合） */
      const flagsByte = b[body + 15];
      if (!(flagsByte & 0x02)) out.keyframes++;
      if (flagsByte & 0x02) out.resetFrame = true;
      if (flagsByte & 0x01) out.overwrite = true;
    }
    p = body + size + (size & 1);
  }
  return out;
}

function webpInfo(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    const out = {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
    const flags = b[20];
    if (flags & 0x10) out.alpha = true;
    if (flags & 0x02) {
      out.animated = true;
      const anim = webpAnim(b);
      /** 帧数只能数 ANMF 块：VP8X 头里并没有帧数字段 */
      out.frames = anim.frames || 1 + (b[30] | (b[31] << 8) | (b[32] << 16));
      if (anim.loop !== undefined) out.loops = anim.loop === 0 ? '无限' : anim.loop + ' 次';
      if (anim.duration) out.duration = Math.round(anim.duration) / 100;
      if (anim.keyframes) out.keyframes = anim.keyframes;
      if (anim.resetFrame) out.disposal = '每帧复位';
      if (anim.overwrite) out.overwrite = true;
    }
    return out;
  }
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, alpha: false };
  if (chunk === 'VP8L') {
    return {
      width: readLEBits(b, 21 * 8, 14) + 1,
      height: readLEBits(b, 21 * 8 + 14, 14) + 1,
      alpha: !!readLEBits(b, 21 * 8 + 28, 1),
      lossless: true,
    };
  }
  return null;
}

function jpegInfo(b) {
  const out = {};
  let p = 2;
  for (let guard = 0; guard < 600 && p + 9 < b.length; guard++) {
    if (b[p] !== 0xff) { p++; continue; }
    let marker = b[p + 1];
    while (marker === 0xff && p + 2 < b.length) { p++; marker = b[p + 1]; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }
    if (marker === 0xd9) break;
    const len = u16be(b, p + 2);
    if (marker === 0xe1 && out.exifRead !== true) {
      const ex = exifTags(b, p + 4, len);
      if (ex) {
        Object.assign(out, ex);
        out.exifRead = true;
      }
    }
    if (marker === 0xe2 && !out.colorSpace) {
      if (ascii(b, p + 4, 4) === 'ICC_PROFILE') out.colorSpace = 'ICC 内嵌';
    }
    if (marker === 0xfe && !out.comment) out.comment = readText(b, p + 4, 120);
    if (marker === 0xda) { out.thumbnailOnly = !out.width; break; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const comps = b[p + 9];
      out.width = u16be(b, p + 7);
      out.height = u16be(b, p + 5);
      out.bitDepth = b[p + 4];
      out.channels = comps;
      out.colorSpace = comps === 1 ? '灰度' : comps === 3 ? 'RGB' : comps === 4 ? 'CMYK' : comps + ' 通道';
      out.progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xc7 || marker === 0xce;
      out.baseline = marker === 0xc0;
      return out;
    }
    if (len <= 0) { p += 2; continue; }
    p += 2 + len;
  }
  return out.orientation != null ? { orientation: out.orientation, incomplete: true } : null;
}

/** APP1 EXIF：方向、相机、拍摄时间、曝光参数、缩略图与 GPS */
function exifTags(b, start, len) {
  if (ascii(b, start, 4) !== 'Exif' || start + 6 >= b.length) return null;
  const tiff = start + 6;
  if (tiff + 8 > b.length) return null;
  const little = ascii(b, tiff, 2) === 'II';
  const rd16 = little ? u16le : u16be;
  const rd32 = little ? u32le : u32be;
  const ifd0 = tiff + rd32(b, tiff + 4);
  const out = {};
  const sub = {
    0x010f: ['cameraMake', 'ascii'], 0x0110: ['cameraModel', 'ascii'], 0x0131: ['software', 'ascii'],
    0x0112: ['orientation', 'num'], 0x0128: ['unit', 'num'],
    0x8769: ['_exifIfd', 'num'], 0x8825: ['_gpsIfd', 'num'], 0x0103: ['_compression', 'num'],
    0x0201: ['_thumbOffset', 'num'], 0x0202: ['_thumbLength', 'num'],
  };
  const walk = (at, map, target) => {
    if (at + 2 > b.length || at < 0) return;
    const count = rd16(b, at);
    for (let i = 0; i < count && i < 70; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = rd16(b, e);
      const type = rd16(b, e + 2);
      const n = rd32(b, e + 4);
      const def = map[tag];
      if (!def) continue;
      const sizeOf = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const bytes = (sizeOf[type] || 4) * n;
      const valAt = bytes <= 4 ? e + 8 : tiff + rd32(b, e + 8);
      if (def[1] === 'ascii') {
        const txt = readText(b, valAt, def[0] === 'cameraMake' ? 40 : 60);
        if (txt) target[def[0]] = txt;
      } else if (def[1] === 'num') {
        target[def[0]] = type === 3 ? rd16(b, valAt) : rd32(b, valAt);
      }
    }
  };
  walk(ifd0, sub, out);
  const exifIfd = out._exifIfd ? tiff + out._exifIfd : 0;
  if (exifIfd) {
    const sub2 = {
      0x9003: ['dateTimeOriginal', 'ascii'], 0x8827: ['iso', 'num'], 0x829a: ['_shutter', 'rational'],
      0x8822: ['_aperture', 'rational'], 0x9201: ['_focal35', 'rational'], 0xa434: ['lensModel', 'ascii'],
      0x920a: ['_flash', 'num'],
    };
    const rat = (at) => (at + 7 < b.length ? (rd32(b, at) / (rd32(b, at + 4) || 1)) : 0);
    const count = rd16(b, exifIfd);
    for (let i = 0; i < count && i < 70; i++) {
      const e = exifIfd + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = rd16(b, e);
      const type = rd16(b, e + 2);
      const n = rd32(b, e + 4);
      const sizeOf = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const bytes = (sizeOf[type] || 4) * n;
      const valAt = bytes <= 4 ? e + 8 : tiff + rd32(b, e + 8);
      if (tag === 0x9003) out.dateTimeOriginal = readText(b, valAt, 24);
      else if (tag === 0xa434) out.lensModel = readText(b, valAt, 60);
      else if (tag === 0x8827) out.iso = type === 3 ? rd16(b, valAt) : rd32(b, valAt);
      else if (tag === 0x829a) out.shutter = rat(valAt);
      else if (tag === 0x8822) out.aperture = rat(valAt);
      else if (tag === 0x9201) out.focalLength35 = rat(valAt);
    }
  }
  const gpsIfd = out._gpsIfd ? tiff + out._gpsIfd : 0;
  if (gpsIfd) out.gps = true;
  if (out._thumbLength > 0) out.thumbnailBytes = out._thumbLength;
  if (out._compression === 6) out.thumbnailFormat = 'JPEG';
  for (const k of Object.keys(out)) if (String(k).startsWith('_')) delete out[k];
  if (out.cameraMake && out.cameraModel) out.camera = (out.cameraMake + ' ' + out.cameraModel).slice(0, 70);
  delete out.cameraMake; delete out.cameraModel;
  if (out.shutter) out.shutterLabel = out.shutter >= 1 ? out.shutter.toFixed(1) + 's' : '1/' + Math.round(1 / out.shutter) + 's';
  if (out.aperture) out.apertureLabel = 'f/' + out.aperture.toFixed(1);
  return Object.keys(out).length ? out : null;
}

function exifOrientationBlock(b, tiff, len) {
  if (tiff + 8 > b.length || len < 8) return 0;
  const little = ascii(b, tiff, 2) === 'II';
  const rd16 = little ? u16le : u16be;
  const rd32 = little ? u32le : u32be;
  const ifd = tiff + rd32(b, tiff + 4);
  const count = rd16(b, ifd);
  if (ifd + 2 > b.length) return 0;
  for (let i = 0; i < count && i < 40; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    if (rd16(b, e) === 0x0112) return rd16(b, e + 8);
  }
  return 0;
}

function icoInfo(b) {
  const count = u16le(b, 4);
  const sizes = [];
  let best = { w: 0, h: 0 };
  for (let i = 0; i < count && i < 64; i++) {
    const at = 6 + i * 16;
    if (at + 16 > b.length) break;
    const w = b[at] || 256;
    const h = b[at + 1] || 256;
    sizes.push(w === h ? w + '\u00d7' + h : w + '\u00d7' + h);
    if (w * h > best.w * best.h) best = { w, h };
  }
  return {
    width: best.w || 16,
    height: best.h || 16,
    entries: count,
    sizes: sizes.join('  '),
    alpha: true,
    iconSet: true,
    format: b[2] === 2 ? 'CUR' : 'ICO',
  };
}

function tiffInfo(b) {
  const little = ascii(b, 0, 2) === 'II';
  const rd16 = little ? u16le : u16be;
  const rd32 = little ? u32le : u32be;
  const ifd = rd32(b, 4);
  if (ifd + 2 > b.length) return null;
  const count = rd16(b, ifd);
  let width = 0; let height = 0;
  for (let i = 0; i < count && i < 60; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    const tag = rd16(b, e);
    const type = rd16(b, e + 2);
    const value = type === 3 ? rd16(b, e + 8) : rd32(b, e + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return width && height ? { width, height } : null;
}

function jpeg2000Size(b) {
  const idx = indexOfSeq(b, 'ihdr', 0, Math.min(b.length, 4096));
  if (idx < 0) return null;
  return { width: u32be(b, idx + 4), height: u32be(b, idx + 8) };
}

function heifSize(b) {
  const idx = indexOfSeq(b, 'ispe', 0, Math.min(b.length, 4000000) - 16);
  if (idx < 0) return null;
  const w = u32be(b, idx + 8); const h = u32be(b, idx + 12);
  return w && h ? { width: w, height: h } : null;
}

function clipText(v, n) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 160);
}

function svgInfoRaw(text) {
  const root = /<svg[^>]*>/i.exec(text);
  if (!root) return null;
  const tag = root[0];
  const num = (s) => (s == null ? null : parseFloat(String(s).replace(/(px|pt|cm|mm|in|%)$/i, '')) || null);
  const out = { vector: true };
  const symbols = (text.match(/<symbol[\s>/]/gi) || []).length;
  if (symbols) {
    out.symbols = symbols;
    if (symbols >= 2) out.sprite = true;
  }
  const count = (re) => (text.match(re) || []).length;
  const shapes = count(/<(path|circle|rect|ellipse|polygon|polyline|line)[\s>/]/gi);
  const uses = count(/<use[\s>/]/gi);
  const images = count(/<image[\s>/]/gi);
  const texts = count(/<text[\s>/]/gi);
  const glyphPaths = count(/<(path|rect|circle|ellipse|polygon|polyline|line)[\s>/]/gi);
  if (shapes) out.shapes = shapes;
  if (uses) out.uses = uses;
  if (images) out.embeddedImages = images;
  if (texts) out.textNodes = texts;
  const title = /<title[^>]*>([\s\S]{1,160}?)<\/title>/i.exec(text);
  if (title) out.svgTitle = clipText(title[1]);
  const desc = /<desc[^>]*>([\s\S]{1,200}?)<\/desc>/i.exec(text);
  if (desc) out.svgDesc = clipText(desc[1]);
  const stroke = /stroke\s*=\s*["']([^"'n][^"']*)["']/i.exec(text);
  if (stroke) out.stroke = clipText(stroke[1], 24);
  out.primitiveCount = glyphPaths + uses;
  const fx = (text.match(/<linearGradient|<radialGradient|<filter[\s>/]/gi) || []).length;
  if (fx) out.effects = fx;
  if (/<animate|<animateTransform|<set[\s>]/i.test(text)) out.animated = true;
  const w = num((/\swidth=["']([^"']+)["']/i.exec(tag) || [])[1]);
  const h = num((/\sheight=["']([^"']+)["']/i.exec(tag) || [])[1]);
  if (w && h) { out.width = Math.round(w); out.height = Math.round(h); return out; }
  const vb = (/viewBox=["']([^"']+)["']/i.exec(tag) || [])[1];
  if (vb) {
    const bits = vb.trim().split(/[\s,]+/).map(Number);
    if (bits.length === 4 && bits[2] && bits[3]) {
      out.width = Math.round(bits[2]);
      out.height = Math.round(bits[3]);
      out.viewBox = true;
      return out;
    }
  }
  return out;
}

/** 尺寸算完之后才能判断“像不像一个图标字形” */
function svgInfo(text) {
  const out = svgInfoRaw(text);
  if (!out) return null;
  const area = (out.width || 0) * (out.height || 0);
  out.glyphLike = !out.symbols && !out.embeddedImages && (out.primitiveCount || 0) <= 6 && !out.textNodes
    && !out.effects && (!area || area <= 96 * 96) && !out.animated;
  if (!out.glyphLike) delete out.glyphLike;
  return out;
}

/** 只看文本就能拿到的 SVG 元信息（用于尚未缓存全字节的场合） */
export function svgMeta(text) {
  try { return svgInfo(String(text || '')); } catch { return null; }
}

/* ----------------------------------------------------------- 视音频 */

export function mediaMeta(buffer, mime = '', url = '', tail) {
  /* 容器解析优先：MP4/MOV 走盒遍历，AVI / FLV 走各自头部 */
  const out = {};
  const b = buffer;
  if (!b || b.length < 12) return out;
  const type = String(mime).toLowerCase();
  const name = String(url || '').toLowerCase();
  try {
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') Object.assign(out, wavInfo(b) || {});
    if (ascii(b, 0, 4) === 'FORM' && (ascii(b, 8, 4) === 'AIFC' || ascii(b, 8, 4) === 'AIFF')) Object.assign(out, aiffInfo(b) || {});
    const box = ascii(b, 4, 4);
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 12, 4) === 'AVI ') Object.assign(out, compact(aviParse(b)));
    if (ascii(b, 0, 3) === 'FLV') Object.assign(out, compact(flvParse(b) || {}));
    if (box === 'ftyp' || box === 'moov' || box === 'styp' || /video|mp4|quicktime|mpeg4|audio\/x-m4a/i.test(type) || /\.(mp4|m4v|mov|m4a|3gp)($|[?#])/.test(name)) {
      const deep = compact(mp4Boxes(b, tail && tail.length ? tail : null));
      if (deep.duration || deep.width || deep.tracks || deep.brand || deep.codec) Object.assign(out, deep);
      else Object.assign(out, compact(mp4Info(b)));
    }
    if (ascii(b, 0, 4) === '\x1aE\xdf\xa3') {
      const mkv = compact(matroskaInfo(b));
      Object.assign(out, mkv);
      if (!mkv.width) {
        const vp8 = vp8KeyframeSize(b);
        if (vp8) Object.assign(out, vp8);
      }
    }
    if (ascii(b, 0, 4) === 'OggS') Object.assign(out, compact(oggInfo(b, tail)));
    if (ascii(b, 0, 4) === 'fLaC') Object.assign(out, compact(flacInfo(b)));
    if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
      Object.assign(out, compact(mp3Info(b)));
      Object.assign(out, compact(id3Tags(b, tail && tail.length ? tail : null)));
    }
    if (ascii(b, 0, 4) === 'MAC ') out.codec = out.codec || 'APE';
  } catch { /* noop */ }
  if (out.duration != null && !(out.duration > 0 && out.duration < 86400 * 3)) delete out.duration;
  if (/video/.test(type) && !out.width) { /* 只有音频轨 */ }
  return out;
}

/** gzip 容器（svgz 等）：只解前 512KB */
function gunzipHead(b) {
  try { return zlib.gunzipSync(b.subarray(0, Math.min(b.length, 512 * 1024)), { maxOutputLength: 512 * 1024 }); } catch { return null; }
}

export function fontMeta(buffer, mime = '') {
  try { return fontParse(buffer, mime) || {}; } catch { return {}; }
}

/** VP8 关键帧帧头（帧标签后 0x9d 0x01 0x2a + 14bit 宽高） */
function vp8KeyframeSize(b) {
  const end = Math.min(b.length - 6, 300000);
  for (let p = 0; p <= end; p++) {
    if (b[p] !== 0x9d || b[p + 1] !== 0x01 || b[p + 2] !== 0x2a) continue;
    const w = (b[p + 3] | (b[p + 4] << 8)) & 0x3fff;
    const h = (b[p + 5] | (b[p + 6] << 8)) & 0x3fff;
    if (w > 1 && h > 1 && w < 16384 && h < 16384) return { width: w, height: h, codec: 'VP8' };
  }
  return null;
}

function compact(obj) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

/* -------------------------------------------------------- MP4 / MOV */

function mp4Info(b) {
  const out = {};
  let duration = 0;
  let timescale = 0;
  const mv = indexOfSeq(b, 'mvhd', 0, Math.min(b.length, 400000));
  if (mv >= 0) {
    const ver = b[mv + 4];
    if (ver === 1) {
      timescale = u32be(b, mv + 24);
      duration = u64be(b, mv + 28);
    } else {
      timescale = u32be(b, mv + 16);
      duration = u32be(b, mv + 20);
    }
  }
  let p = 0;
  for (let guard = 0; guard < 8; guard++) {
    const t = indexOfSeq(b, 'tkhd', p, b.length);
    if (t < 0) break;
    p = t + 4;
    const boxStart = t - 4;
    let size = u32be(b, boxStart);
    let body = boxStart + 8;
    if (size === 1) {
      size = u64be(b, boxStart + 8);
      body = boxStart + 16;
    }
    if (size < 84 || boxStart + size > b.length + 4) continue;
    const end = boxStart + size;
    const w = i32be(b, end - 8) / 65536;
    const h = i32be(b, end - 4) / 65536;
    if (!(w > 0 && h > 0)) continue;
    const ma = i32be(b, end - 44) / 65536;
    const mb = i32be(b, end - 40) / 65536;
    const rotation = Math.abs(ma) < 0.02 && Math.abs(mb) >= 0.5 ? Math.round((Math.atan2(mb, ma) * 180) / Math.PI) : 0;
    const sideways = Math.abs(Math.abs(rotation) - 90) < 12 || Math.abs(Math.abs(rotation) - 270) < 12;
    out.width = Math.round(sideways ? h : w);
    out.height = Math.round(sideways ? w : h);
    if (rotation) out.rotation = rotation;
    break;
  }
  const codec = pickCodec(b);
  if (timescale && duration) out.duration = Math.round((duration / timescale) * 100) / 100;
  if (timescale) out.timescale = timescale;
  if (codec) out.codec = codec;
  return out;
}

const CODEC_HINTS = [
  ['avc1', 'H.264'], ['avc3', 'H.264'], ['hev1', 'H.265'], ['hvc1', 'H.265'],
  ['mp4v', 'MPEG-4 Part 2'], ['vp08', 'VP8'], ['vp09', 'VP9'], ['av01', 'AV1'],
  ['mp4a', 'AAC'], ['ac-3', 'AC-3'], ['ec-3', 'E-AC-3'], ['Opus', 'Opus'],
  ['sowt', 'PCM'], ['twos', 'PCM'], ['mlpa', 'TrueHD'], ['dts ', 'DTS'], ['dtsc', 'DTS'],
  ['tx6d', 'DTS-X'], ['fLaC', 'FLAC'],
];

function pickCodec(b) {
  const head = b.subarray(0, Math.min(b.length, 500000));
  const found = [];
  for (const [tag, label] of CODEC_HINTS) {
    if (indexOfSeq(head, tag, 0, head.length) >= 0 && found.indexOf(label) < 0) found.push(label);
    if (found.length >= 3) break;
  }
  return found.join(' + ');
}

/* ----------------------------------------------- Matroska / WebM(EBML) */

const EBML_MASTERS = new Set([
  0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1043a770, 0x1c53bb6b, 0xbf, 0x74, 0x75, 0x9c, 0x6f, 0xbc,
]);

function vintLen(first) {
  if (!first) return 0;
  let mask = 0x80;
  let n = 1;
  while (n <= 8 && !(first & mask)) { mask >>= 1; n++; }
  return n > 8 ? 0 : n;
}

function readId(b, p) {
  const n = vintLen(b[p]);
  if (!n || p + n > b.length) return null;
  let id = 0;
  for (let i = 0; i < n; i++) id = id * 256 + b[p + i];
  return { id, next: p + n };
}

function readVSize(b, p) {
  const first = b[p];
  const n = vintLen(first);
  if (!n || p + n > b.length) return null;
  let v = first & ((1 << (8 - n)) - 1);
  for (let i = 1; i < n; i++) v = v * 256 + b[p + i];
  const unknown = n === 8 && v >= 0x7fffffffffff00;
  return { size: unknown ? -1 : v, next: p + n };
}

function uintAt(b, p, len) {
  let v = 0;
  for (let i = 0; i < len && p + i < b.length && i < 8; i++) v = v * 256 + b[p + i];
  return v;
}

/** 真正的 EBML 遍历：TimestampScale / Duration / DefaultDuration / 像素尺寸 / CodecID */
function matroskaInfo(b) {
  const out = {};
  let tsSeconds = 0.001;
  let duration = 0;
  let defaultDuration = 0;
  const codecs = [];
  let sawTrack = false;

  const walk = (start, end, depth) => {
    let p = start;
    for (let guard = 0; p + 4 < end && guard < 40000; guard++) {
      const id = readId(b, p);
      if (!id || id.id === 0) return;
      const sz = readVSize(b, id.next);
      if (!sz) return;
      const data = sz.next;
      const stop = sz.size < 0 ? end : Math.min(end, data + sz.size);
      const I = id.id;
      if (I === 0x1f43b675) return;
      const len = Math.max(0, stop - data);
      if (I === 0x2ad7b1) {
        const raw = len === 4 ? f32be(b, data) : len === 8 ? f64be(b, data) : uintAt(b, data, len);
        if (raw > 0) tsSeconds = raw > 1e-3 && raw < 1e6 ? raw / 1e9 : raw;
      } else if (I === 0x4489) {
        duration = len === 4 ? f32be(b, data) : len === 8 ? f64be(b, data) : uintAt(b, data, len);
      } else if (I === 0x23e383e3 && !defaultDuration) {
        defaultDuration = uintAt(b, data, len);
      } else if (I === 0x55b0 && !out.width) {
        out.width = uintAt(b, data, len);
      } else if (I === 0x55ba && !out.height) {
        out.height = uintAt(b, data, len);
      } else if (I === 0x7ba) {
        const s = ascii(b, data, Math.min(len, 120)).replace(/\u0000+$/, '').trim();
        if (s && !out.title) out.title = s.slice(0, 120);
      } else if (I === 0x5d) {
        const s = ascii(b, data, Math.min(len, 80)).replace(/\u0000+$/, '').trim();
        if (s && !out.writingApp) out.writingApp = s.slice(0, 80);
      } else if (I === 0xae) {
        out.tracks = (out.tracks || 0) + 1;
      } else if (I === 0x86) {
        const s = ascii(b, data, Math.min(len, 32)).replace(/\u0000+$/, '');
        if (/^[VASB]_/.test(s) && codecs.indexOf(s) < 0 && codecs.length < 6) {
          codecs.push(s);
          if (/^V_/.test(s)) sawTrack = true;
        }
      }
      if (EBML_MASTERS.has(I) && depth < 7 && stop > data) walk(data, stop, depth + 1);
      const advance = Math.max(stop, data);
      if (advance <= p) return;
      p = advance;
    }
  };

  walk(0, Math.min(b.length, 3000000), 0);
  const seconds = duration ? duration * tsSeconds : (defaultDuration && sawTrack ? defaultDuration / 1e9 : 0);
  if (seconds > 0) out.duration = Math.round(seconds * 100) / 100;
  if (codecs.length) {
    const v = codecs.find((c) => /^V_/.test(c));
    const a = codecs.find((c) => /^A_/.test(c));
    const label = [v ? v.slice(2) : '', a ? a.slice(2) : ''].filter(Boolean).join(' + ');
    if (label) out.codec = label;
  }
  if (!out.width || !out.height) { delete out.width; delete out.height; }
  return out;
}

/* -------------------------------------------------------------- Ogg */

function oggInfo(b, tail) {
  const out = {};
  let sampleRate = 0;
  let channels = 0;
  let codec = '';
  const vi = indexOfSeq(b, '\x03vorbis', 0, Math.min(b.length, 12000));
  const ci = vi < 0 ? indexOfSeq(b, '\x01vorbis', 0, Math.min(b.length, 12000)) : -1;
  const oi = indexOfSeq(b, 'OpusHead', 0, Math.min(b.length, 12000));
  const si = indexOfSeq(b, 'Speex ', 0, Math.min(b.length, 12000));
  if (vi >= 0 || ci >= 0) {
    const at = (vi >= 0 ? vi : ci) + 7;
    channels = b[at + 4];
    sampleRate = u32le(b, at + 5);
    codec = 'Vorbis';
  } else if (oi >= 0) {
    channels = b[oi + 9];
    sampleRate = 48000;
    codec = 'Opus';
  } else if (si >= 0) {
    sampleRate = i32le(b, si + 36) || 16000;
    channels = i32le(b, si + 40) + 1;
    codec = 'Speex';
  }
  if (sampleRate > 0 && sampleRate < 400000) {
    out.sampleRate = sampleRate;
    if (channels > 0 && channels < 9) out.channels = channels;
    if (codec) out.codec = codec;
  } else {
    sampleRate = 0;
  }
  const src = tail && tail.length > 20 ? tail : b;
  let last = -1;
  for (let guard = 0; guard < 2000; guard++) {
    const at = indexOfSeq(src, 'OggS', last + 1, src.length);
    if (at < 0) break;
    last = at;
    if (last > src.length - 40 && src.length > 40) { /* 继续找末页 */ }
  }
  if (last >= 0 && sampleRate && last + 14 <= src.length) {
    const headerType = src[last + 5];
    const granule = i64le(src, last + 6);
    if ((headerType & 0x04) && granule > 0 && codec !== 'Vorbis' || ((headerType & 0x04) && granule > 0 && codec === 'Vorbis')) {
      out.duration = Math.round((granule / sampleRate) * 100) / 100;
    }
    if (codec === 'Vorbis' && out.duration) out.frames = granule;
  }
  if (!out.duration) {
    const di = indexOfSeq(b, 'Duration', 0, Math.min(b.length, 200000));
    if (di >= 0) {
      let q = di + 8;
      while (q < b.length && (b[q] === 0x3d || b[q] === 0x20 || b[q] === 0x25)) q++;
      let s = '';
      while (q < b.length && /[0-9.]/.test(String.fromCharCode(b[q]))) { s += String.fromCharCode(b[q]); q++; }
      const v = parseFloat(s);
      if (v > 0) out.duration = Math.round(v * 1000) / 1000;
    }
  }
  return out;
}

/* ------------------------------------------------------------ FLAC */

function flacInfo(b) {
  let p = 4;
  for (let guard = 0; guard < 24 && p + 4 < b.length; guard++) {
    const type = b[p] & 0x7f;
    const size = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    if (size <= 0 || p + 4 + size > b.length) {
      if (type !== 0) { p += 4 + Math.max(size, 0); continue; }
    }
    if (type === 0 && size >= 34) {
      const s = b.subarray(p + 4, p + 4 + 34);
      const get = (bitOff, len) => {
        let v = 0;
        for (let i = 0; i < len; i++) {
          const pos = bitOff + i;
          v = v * 2 + ((s[pos >> 3] >> (7 - (pos & 7))) & 1);
        }
        return v;
      };
      const sampleRate = get(80, 20);
      const channels = get(100, 3) + 1;
      const bit = get(103, 5) + 1;
      const frames = get(108, 36);
      const out = { sampleRate, channels, bit, frames };
      if (sampleRate && frames) out.duration = Math.round((frames / sampleRate) * 100) / 100;
      out.codec = 'FLAC';
      return out;
    }
    p += 4 + Math.max(size, 0);
  }
  return null;
}

/* ------------------------------------------------------- WAV / AIFF */

function scanChunks(b, from, wanted) {
  const out = {};
  let p = from;
  for (let guard = 0; p + 8 < b.length && guard < 200; guard++) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (wanted.indexOf(id) >= 0 && !out[id]) out[id] = { at: p + 8, size };
    if (size < 0 || size > b.length) break;
    p += 8 + size + (size % 2);
  }
  return out;
}

function wavInfo(b) {
  const chunks = scanChunks(b, 12, ['fmt ', 'data', 'LIST']);
  const fmt = chunks['fmt '];
  const data = chunks.data;
  if (!fmt) return null;
  const format = u16le(b, fmt.at);
  const channels = u16le(b, fmt.at + 2) || 1;
  const sampleRate = u32le(b, fmt.at + 4);
  const byteRate = u32le(b, fmt.at + 8);
  const bits = u16le(b, fmt.at + 14) || u16le(b, fmt.at + 12) || 16;
  const out = { sampleRate, channels, bit: bits };
  out.sampleFormat = format === 3 || format === 0xfffe ? 'IEEE float' : format === 6 ? 'ALAW' : format === 7 ? 'μLaw' : 'PCM';
  if (format === 0xfffe) out.sampleFormat = 'Extensible PCM';
  const bytes = data ? Math.min(data.size, Math.max(0, b.length - data.at)) : Math.max(0, b.length - fmt.at - 44);
  out.dataBytes = bytes;
  if (byteRate) out.duration = Math.round((bytes / byteRate) * 1000) / 1000;
  else if (sampleRate) out.duration = Math.round((bytes / (sampleRate * channels * (bits / 8))) * 1000) / 1000;
  const list = chunks.LIST;
  if (list) {
    const at = indexOfSeq(b, 'INAM', list.at, Math.min(b.length, list.at + list.size));
    if (at >= 0) out.title = readText(b, at + 8, 90);
  }
  return out;
}

function aiffInfo(b) {
  const comm = indexOfSeq(b, 'COMM', 12, Math.min(b.length, 2000));
  if (comm < 0) return null;
  const channels = u16be(b, comm + 8);
  const frames = u32be(b, comm + 10);
  const bits = u16be(b, comm + 14);
  const sampleRate = Math.round(read80Extended(b, comm + 16));
  const out = { channels, bit: bits, sampleRate, frames };
  if (sampleRate && frames) out.duration = Math.round((frames / sampleRate) * 1000) / 1000;
  out.codec = ascii(b, 0, 4) === 'FORM' && ascii(b, 8, 4) === 'AIFC' ? 'AIFC' : 'AIFF';
  return out;
}

function read80Extended(b, p) {
  if (p + 9 >= b.length) return 0;
  const exp = ((b[p] & 0x7f) << 8) | b[p + 1];
  let mant = 0;
  for (let i = 2; i < 10; i++) mant = mant * 256 + b[p + i];
  if (!exp) return 0;
  const sign = b[p] & 0x80 ? -1 : 1;
  return sign * mant * Math.pow(2, exp - 16398);
}

/* -------------------------------------------------------------- MP3 */

const MP3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
];
const MP3_RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
const MPEG_NAME = { 3: 'MPEG-1', 2: 'MPEG-2', 0: 'MPEG-2.5' };

function id3Size(b) {
  if (b.length < 10) return 0;
  return ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
}

function mp3Info(b) {
  let start = ascii(b, 0, 3) === 'ID3' ? 10 + id3Size(b) : 0;
  let p = start;
  let rate = 0;
  let br = 0;
  let spf = 0;
  let channelMode = 0;
  let mpeg = '';
  for (let guard = 0; p + 4 < b.length && guard < 4000; guard++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) { p++; continue; }
    const ver = (b[p + 1] >> 3) & 0x03;
    const layer = (b[p + 1] >> 1) & 0x03;
    const brIdx = (b[p + 2] >> 4) & 0x0f;
    const srIdx = (b[p + 2] >> 2) & 0x03;
    const padding = (b[p + 2] >> 1) & 0x01;
    channelMode = (b[p + 3] >> 6) & 0x03;
    if (layer === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) { p++; continue; }
    const mpeg1 = ver === 3;
    /* 版本位：3=MPEG-1、2=MPEG-2、0=MPEG-2.5，对应采样率表 0/1/2 */
    rate = (MP3_RATES[[2, 0, 1, 0][ver]] || [])[srIdx] || 0;
    br = (MP3_BITRATES[mpeg1 ? 0 : 1] || [])[brIdx] || 0;
    /* 层号的位值是反的：3=Layer I、2=Layer II、1=Layer III */
    spf = layer === 3 ? 384 : layer === 2 ? 1152 : mpeg1 ? 1152 : 576;
    mpeg = (MPEG_NAME[ver] || 'MPEG') + ' Layer ' + (layer === 3 ? 'I' : layer === 2 ? 'II' : 'III');
    break;
  }
  if (!rate || !br) return null;
  const out = { sampleRate: rate, channels: channelMode === 3 ? 1 : 2, codec: mpeg };
  const searchEnd = Math.min(b.length, start + 200000);
  const xi = indexOfSeq(b, 'Xing', start, searchEnd);
  const info = xi < 0 ? indexOfSeq(b, 'Info', start, searchEnd) : -1;
  const ib = xi < 0 && info < 0 ? indexOfSeq(b, 'IB+', start, searchEnd) : -1;
  const at = xi >= 0 ? xi : info >= 0 ? info : ib;
  const bytes = Math.max(1, b.length - start);
  if (at > 0 && at + 12 < b.length) {
    const flags = u32be(b, at + 4);
    let q = at + 8;
    let frames = 0;
    if (flags & 0x01) { frames = u32be(b, q); q += 4; }
    if (flags & 0x02) q += 4;
    if (!(flags & 0x01) || !frames) frames = 0;
    if (frames) {
      out.frames = frames;
      out.duration = Math.round((frames * spf) / rate * 1000) / 1000;
      out.vbr = xi >= 0;
      out.bitrate = Math.round((frames * spf * 8) / out.duration / 1000) * 1000 || br * 1000;
      return out;
    }
  }
  out.bitrate = br * 1000;
  out.cbr = true;
  out.duration = Math.round(((bytes * 8) / (br * 1000)) * 100) / 100;
  out.frames = Math.round((out.duration * rate) / spf);
  return out;
}

/* -------------------------------------------------------- 文本类时长 */

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(r);
}

const ORIENTATION_TEXT = {
  1: '正常', 2: '水平镜像', 3: '旋转 180°', 4: '垂直镜像',
  5: '顺时针 90° + 镜像', 6: '顺时针 90°', 7: '逆时针 90° + 镜像', 8: '逆时针 90°',
};
export function orientationLabel(v) {
  return ORIENTATION_TEXT[v] || (v ? '方向标记 ' + v : '');
}

/* ---------------------------------------------------------- 魔数签名 */

const SIG = {
  png: (b) => ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => ascii(b, 0, 3) === 'GIF',
  webp: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP',
  riff: (tag) => (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === tag,
  form: (tag) => (b) => ascii(b, 0, 4) === 'FORM' && ascii(b, 8, 4) === tag,
  ftyp: (brand) => (b) => ascii(b, 4, 4) === 'ftyp' && ascii(b, 8, 4).indexOf(brand) === 0,
  text: (re) => (b) => re.test(String(b.subarray(0, 64).toString('utf-8'))),
  bytes: (...vals) => (b) => {
    for (let i = 0; i < vals.length; i++) if (b[i] !== vals[i]) return false;
    return true;
  },
};

export const SIGNATURES = [
  { test: SIG.png, ext: 'png', mime: 'image/png', type: 'image', label: 'PNG 位图' },
  { test: SIG.jpg, ext: 'jpg', mime: 'image/jpeg', type: 'image', label: 'JPEG 位图' },
  { test: SIG.gif, ext: 'gif', mime: 'image/gif', type: 'image', label: 'GIF 位图' },
  { test: SIG.webp, ext: 'webp', mime: 'image/webp', type: 'image', label: 'WebP 位图' },
  { test: SIG.ftyp('avif'), ext: 'avif', mime: 'image/avif', type: 'image', label: 'AVIF 位图' },
  { test: (b) => SIG.ftyp('heic')(b) || SIG.ftyp('heix')(b) || SIG.ftyp('mif1')(b) || SIG.ftyp('heim')(b), ext: 'heic', mime: 'image/heic', type: 'image', label: 'HEIF 图像' },
  { test: asciiTest('\x00\x00\x00\x0cjP  \x0d\x0a\x87\x0a'), ext: 'jp2', mime: 'image/jp2', type: 'image', label: 'JPEG 2000' },
  { test: (b) => ascii(b, 0, 4) === 'II*\x00' || ascii(b, 0, 4) === 'MM\x00*', ext: 'tiff', mime: 'image/tiff', type: 'image', label: 'TIFF 图像' },
  { test: asciiTest('8BPS'), ext: 'psd', mime: 'image/vnd.adobe.photoshop', type: 'image', label: 'Photoshop 文档' },
  { test: asciiTest('BM'), ext: 'bmp', mime: 'image/bmp', type: 'image', label: 'BMP 位图' },
  { test: (b) => isIco(b) && b[2] === 1, ext: 'ico', mime: 'image/vnd.microsoft.icon', type: 'icon', label: 'Windows 图标集' },
  { test: (b) => isIco(b) && b[2] === 2, ext: 'cur', mime: 'image/x-icon', type: 'icon', label: 'Windows 光标' },
  { test: asciiTest('icns'), ext: 'icns', mime: 'image/x-icns', type: 'icon', label: 'macOS 图标集' },
  { test: asciiTest('\x1aE\xdf\xa3'), ext: 'webm', mime: 'video/webm', type: 'video', label: 'Matroska / WebM 容器' },
  { test: SIG.riff('AVI '), ext: 'avi', mime: 'video/x-msvideo', type: 'video', label: 'AVI 视频' },
  { test: SIG.riff('WAVE'), ext: 'wav', mime: 'audio/wave', type: 'audio', label: 'WAV 波形音频' },
  { test: (b) => SIG.form('AIFF')(b) || SIG.form('AIFC')(b), ext: 'aiff', mime: 'audio/aiff', type: 'audio', label: 'AIFF 音频' },
  { test: asciiTest('OggS'), ext: 'ogg', mime: 'audio/ogg', type: 'audio', label: 'Ogg 容器' },
  { test: asciiTest('fLaC'), ext: 'flac', mime: 'audio/flac', type: 'audio', label: 'FLAC 无损音频' },
  { test: SIG.ftyp('qt  '), ext: 'mov', mime: 'video/quicktime', type: 'video', label: 'QuickTime 视频' },
  { test: (b) => SIG.ftyp('M4A ')(b) || SIG.ftyp('M4B ')(b), ext: 'm4a', mime: 'audio/mp4', type: 'audio', label: 'M4A 音频' },
  { test: (b) => SIG.ftyp('isom')(b) || SIG.ftyp('mp42')(b) || SIG.ftyp('avc1')(b) || SIG.ftyp('M4V ')(b) || SIG.ftyp('dash')(b) || SIG.ftyp('msdh')(b), ext: 'mp4', mime: 'video/mp4', type: 'video', label: 'MPEG-4 视频' },
  { test: (b) => ascii(b, 0, 4) === 'qoif', ext: 'qoi', mime: 'image/qoi', type: 'image', label: 'QOI 位图' },
  { test: (b) => ascii(b, 0, 4) === 'DDS ', ext: 'dds', mime: 'image/vnd-ms.dds', type: 'image', label: 'DirectDraw 贴图（DDS）' },
  { test: (b) => u32le(b, 0) === 0x01312f76, ext: 'exr', mime: 'image/aces', type: 'image', label: 'OpenEXR 高动态范围图' },
  { test: (b) => /^P[1-7][\s]/.test(ascii(b, 0, 3)), ext: 'pnm', mime: 'image/x-portable-anymap', type: 'image', label: 'PNM / PBM / PGM / PPM' },
  { test: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b[1] !== 0xff), ext: 'mp3', mime: 'audio/mpeg', type: 'audio', label: 'MPEG 音频（MP3）' },
  { test: (b) => b[0] === 0x47 && (b[188] === 0x47 || b[188] === 0x00) && b.length > 189, ext: 'ts', mime: 'video/mp2t', type: 'video', label: 'MPEG-TS 传输流' },
  { test: (b) => b[0] === 0xff && b[1] === 0x0f, ext: 'jxl', mime: 'image/jxl', type: 'image', label: 'JPEG XL 码流' },
  { test: asciiTest('bplist00'), ext: 'plist', mime: 'application/x-plist', type: 'data', label: '二进制属性列表' },
  { test: (b) => u32be(b, 0) === 0xfeedfacf || u32be(b, 0) === 0xfeedface, ext: 'macho', mime: 'application/octet-stream', type: 'archive', label: 'Mach-O 可执行文件' },
  { test: (b) => /<MPD[\s>]/i.test(String(b.subarray(0, 2048).toString('utf-8'))), ext: 'mpd', mime: 'application/dash+xml', type: 'video', label: 'DASH 清单（MPD）' },
  { test: asciiTest('%PDF-'), ext: 'pdf', mime: 'application/pdf', type: 'document', label: 'PDF 文档' },
  { test: SIG.bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), ext: 'doc', mime: 'application/msword', type: 'document', label: 'OLE2 复合文档' },
  { test: asciiTest('{\\rtf'), ext: 'rtf', mime: 'application/rtf', type: 'document', label: 'RTF 文档' },
  { test: SIG.text(/^WEBVTT/m), ext: 'vtt', mime: 'text/vtt', type: 'data', label: 'WebVTT 字幕' },
  { test: SIG.text(/^\d{2}:\d{2}:\d{2}[,.]\d{0,3}\s*-->/m), ext: 'srt', mime: 'application/x-subrip', type: 'data', label: 'SubRip 字幕' },
  { test: SIG.text(/^BEGIN:(VCARD|VCALENDAR)/m), ext: 'vcf', mime: 'text/vcard', type: 'data', label: 'vCard / iCalendar' },
  { test: SIG.text(/^#!(AMR|EXPLAIN)/m), ext: 'amr', mime: 'audio/amr', type: 'audio', label: 'AMR 音频' },
  { test: SIG.text(/^<svg[\s>]/i), ext: 'svg', mime: 'image/svg+xml', type: 'vector', label: 'SVG 矢量图' },
  { test: (b) => /^{\s*"filed"\s*:\s*"gtfs/.test(String(b.subarray(0, 40), 'utf-8')), ext: 'txt', mime: 'text/plain', type: 'data', label: '文本' },
  { test: asciiTest('wOFF'), ext: 'woff', mime: 'font/woff', type: 'font', label: 'WOFF 字体' },
  { test: asciiTest('wOF2'), ext: 'woff2', mime: 'font/woff2', type: 'font', label: 'WOFF2 字体' },
  { test: asciiTest('ttcf'), ext: 'ttc', mime: 'font/collection', type: 'font', label: 'TrueType 字体集合' },
  { test: (b) => (b[0] === 0x00 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) || ascii(b, 0, 4) === 'OTTO', ext: 'ttf', mime: 'font/ttf', type: 'font', label: 'TrueType / OpenType 字体' },
  { test: asciiTest('PK\x03\x04'), ext: 'zip', mime: 'application/zip', type: 'archive', label: 'ZIP 压缩包' },
  { test: (b) => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07, ext: 'rar', mime: 'application/vnd.rar', type: 'archive', label: 'RAR 压缩包' },
  { test: SIG.bytes(0x37, 0x7f, 0x53, 0x70), ext: '7z', mime: 'application/x-7z-compressed', type: 'archive', label: '7-Zip 压缩包' },
  { test: (b) => b[0] === 0x1f && b[1] === 0x8b, ext: 'gz', mime: 'application/gzip', type: 'archive', label: 'gzip 压缩包' },
  { test: (b) => b[0] === 0xfd && ascii(b, 1, 5) === '7zXZ\x00', ext: 'xz', mime: 'application/x-xz', type: 'archive', label: 'XZ 压缩包' },
  { test: (b) => b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd, ext: 'zst', mime: 'application/zstd', type: 'archive', label: 'Zstandard 压缩包' },
  { test: asciiTest('par2'), ext: 'par2', mime: 'application/octet-stream', type: 'archive', label: 'PAR2 校验包' },
  { test: (b) => ascii(b, 257, 5) === 'ustar', ext: 'tar', mime: 'application/x-tar', type: 'archive', label: 'TAR 归档' },
  { test: asciiTest('!<arch>'), ext: 'a', mime: 'application/x-archive', type: 'archive', label: 'Unix ar 归档' },
  { test: asciiTest('\x00asm'), ext: 'wasm', mime: 'application/wasm', type: 'script', label: 'WebAssembly 模块' },
  { test: asciiTest('\x7fELF'), ext: 'elf', mime: 'application/octet-stream', type: 'archive', label: 'ELF 可执行文件' },
  { test: (b) => b[0] === 0x4d && b[1] === 0x5a, ext: 'exe', mime: 'application/vnd.microsoft.portable-executable', type: 'archive', label: 'Windows 可执行程序' },
  { test: asciiTest('SQLite format 3\x00'), ext: 'db', mime: 'application/vnd.sqlite3', type: 'data', label: 'SQLite 数据库' },
  { test: SIG.text(/^#EXTM3U/m), ext: 'm3u8', mime: 'application/vnd.apple.mpegurl', type: 'video', label: 'HLS 播放列表' },
  { test: SIG.text(/^<\?xml/i), ext: 'xml', mime: 'application/xml', type: 'data', label: 'XML 文档' },
  { test: SIG.text(/^\s*(?:\d{1,3}\.){3}\d{1,3}\s/), ext: 'log', mime: 'text/plain', type: 'data', label: '纯文本' },
  { test: SIG.text(/^\s*[{"[]/), ext: 'json', mime: 'application/json', type: 'data', label: 'JSON 数据' },
];

function asciiTest(str) {
  const needle = Buffer.from(str, 'latin1');
  return (b) => {
    if (b.length < needle.length) return false;
    for (let i = 0; i < needle.length; i++) if (b[i] !== needle[i]) return false;
    return true;
  };
}

export function detectSignature(buffer) {
  if (!buffer || !buffer.length) return null;
  for (const sig of SIGNATURES) {
    try {
      if (!sig.test(buffer)) continue;
      if (sig.ext === 'zip') {
        const flavor = zipFlavor(buffer);
        if (flavor) return Object.assign({}, sig, { label: flavor });
      }
      return sig;
    } catch { /* noop */ }
  }
  return null;
}

/** ZIP 家族细分：docx / xlsx / pptx / epub / apk */
export function zipFlavor(buffer) {
  if (!buffer || ascii(buffer, 0, 4) !== 'PK\x03\x04') return '';
  const window = Math.min(buffer.length, 80000);
  const head = String(buffer.subarray(0, window).toString('latin1'));
  if (/word\/document\.xml/.test(head)) return 'Word 文档（.docx）';
  if (/xl\/workbook\.xml/.test(head)) return 'Excel 表格（.xlsx）';
  if (/ppt\/presentation\.xml/.test(head)) return 'PowerPoint 演示（.pptx）';
  if (/application\/epub\+zip/.test(head)) return 'EPUB 电子书';
  if (/AndroidManifest\.xml/.test(head) && /classes.*\.dex/.test(head)) return 'Android 安装包（APK）';
  if (/AndroidManifest\.xml/.test(head)) return 'Android 安装包（APK）';
  if (/META-INF\/.*\.SF/.test(head)) return '已签名 JAR / APK';
  if (/mimetypeapplication\/vnd\.oasis\.opendocument/.test(head)) return 'OpenDocument 文档';
  if (/\.glb|scene\.json/.test(head)) return '3D 资产包';
  return 'ZIP 压缩包';
}

/** 判断字节流是否更像文本 */
export function looksTextual(buffer) {
  if (!buffer || !buffer.length) return false;
  const n = Math.min(buffer.length, 4096);
  let weird = 0;
  for (let i = 0; i < n; i++) {
    const c = buffer[i];
    if (c === 0) return false;
    if (c < 9 && c !== 0) weird++;
    else if (c > 13 && c < 32 && c !== 27) weird++;
  }
  return weird / n < 0.02;
}

export function textSample(buffer, limit = 2400) {
  const s = String(buffer.subarray(0, limit).toString('utf-8'));
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}