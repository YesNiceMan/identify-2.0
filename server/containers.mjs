/**
 * 容器级深度解析（零依赖，配合 probe.mjs 使用）
 *
 *   mp4Info()    MP4/MOV/M4A：遍历 moov/trak —— 轨道清单、真实编解码、音频采样率与声道、
 *                创建时间、faststart（moov 是否在 mdat 之前）、brand
 *   aviInfo()    AVI：avih 帧率 / 帧数 / 宽高、strf 位深、INFO 标题与作者
 *   flvInfo()    FLV：头部 + onMetaData（AMF0）里的宽高、帧率、码率、时长
 *   id3Tags()    MP3：ID3v2.2/2.3/2.4 与 ID3v1 的标题 / 艺人 / 专辑 / 年份 / 流派 / 封面
 *   fontInfo()   TTF/OTF/WOFF/WOFF2：家族与样式名、字形数、unitsPerEm、嵌入许可、图标字体
 *   icnsInfo()   macOS 图标集：内含尺寸清单
 *   以及 QOI / DDS / OpenEXR / PNM / TGA 的头字段
 */

const u8 = (b, p) => (p < b.length ? b[p] : 0);
const u16le = (b, p) => (p + 1 < b.length ? b[p] | (b[p + 1] << 8) : 0);
const u16be = (b, p) => (p + 1 < b.length ? (b[p] << 8) | b[p + 1] : 0);
const u32le = (b, p) => (p + 3 < b.length ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0) : 0);
const u32be = (b, p) => (p + 3 < b.length ? (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0) : 0);
const i32le = (b, p) => (p + 3 < b.length ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0 : 0);
const i32be = (b, p) => (p + 3 < b.length ? ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0 : 0);
const C9 = String.fromCharCode(0xa9);

const i32s = (b, p) => (p + 1 < b.length ? (((b[p] << 8) | b[p + 1]) << 16 >> 16) : 0);
const hex4 = (n) => ('000' + (Number(n) >>> 0).toString(16).toUpperCase()).slice(-4);


function u64be(b, p) {
  if (p + 7 >= b.length) return 0;
  try { return Number(b.readBigUInt64BE(p)); } catch { return 0; }
}
function ascii(b, p, len) {
  if (p < 0 || len <= 0 || p + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[p + i]);
  return s;
}
function clip(v, n) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s.trim();
}
function indexOfSeq(buf, seq, from, to) {
  const needle = Buffer.from(String(seq), 'latin1');
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
function dropEmpty(obj) {
  for (const k of Object.keys(obj)) {
    if (obj[k] === 0 || obj[k] === '' || obj[k] == null || obj[k] === false) delete obj[k];
    else if (Array.isArray(obj[k]) && !obj[k].length) delete obj[k];
  }
  return obj;
}
/** Mac 时间戳（自 1904-01-01）→ ISO 日期 */
function macTime(v) {
  if (!v || v < 2082844800 || v > 6e9) return '';
  const d = new Date((v - 2082844800) * 1000);
  const y = d.getFullYear();
  if (!Number.isFinite(d.getTime()) || y < 1985 || y > 2100) return '';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/* ------------------------------------------------------------ ISO BMFF */

function eachBox(b, start, end, fn, depth) {
  const d = depth || 0;
  let p = start;
  for (let guard = 0; p + 8 <= end && guard < 3000 && d < 8; guard++) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let hdr = 8;
    if (size === 1) { size = u64be(b, p + 8); hdr = 16; }
    else if (size === 0) { size = end - p; }
    if (!Number.isFinite(size) || size < hdr) { p += 4; continue; }
    if (p + size > end) {
      /** 窗口在盒中间截断（大 mdat 常见）：仍把已读到的部分交出去，然后收工 */
      fn(p, type, p + hdr, end);
      return;
    }
    fn(p, type, p + hdr, p + size);
    p += size;
  }
}

const CODEC_NAMES = {
  avc1: 'H.264', avc3: 'H.264', avcp: 'H.264', hev1: 'H.265', hvc1: 'H.265', hvt1: 'H.265', vvc1: 'H.266',
  mp4v: 'MPEG-4 Part 2', h263: 'H.263', I263: 'H.263', vp08: 'VP8', vp09: 'VP9', av01: 'AV1',
  jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', rle : 'Run Length', jpeg2000: 'JPEG 2000',
  mp4a: 'AAC-LC', '.mp3': 'MP3', ac3: 'AC-3', 'ac-3': 'AC-3', ec3: 'E-AC-3', 'ec-3': 'E-AC-3',
  alac: 'ALAC', samr: 'AMR-NB', sawb: 'AMR-WB', Opus: 'Opus', opus: 'Opus', flac: 'FLAC', fLaC: 'FLAC',
  sowt: 'PCM (sowt)', twos: 'PCM (twos)', lpcm: 'PCM', fl32: '32 位浮点 PCM', dtsh: 'DTS-HD',
  dtsl: 'DTS', dtsc: 'DTS', dtsu: 'DTS-UHD', text: '字幕', 'tx3g': 'TTXT 字幕', wvtt: 'WebVTT 字幕',
  sbtl: '字幕', c608: '隐藏字幕 CEA-608', c708: '隐藏字幕 CEA-708', meta: '元数据', mebx: '扩展媒体',
};

/**
 * MP4 / MOV / M4A 解析。
 * @param head 头部字节
 * @param tail 可选尾部字节（非 faststart 的 moov 常在文件末尾）
 */
export function mp4Info(head, tail) {
  const out = {};
  const tracks = [];
  let moovAt = -1;
  let mdatAt = -1;
  const bufs = [head];
  if (tail && tail.length > 16) bufs.push(tail);
  for (const b of bufs) {
    if (!b || b.length < 12 || tracks.length) continue;
    if (b === bufs[bufs.length - 1] && bufs.length > 1) {
      /** 尾部切片是从中间截断的，顶层盒边界无意义：直接搜 moov 并校验长度 */
      let at = 0;
      for (let guard = 0; guard < 8; guard++) {
        const i = indexOfSeq(b, 'moov', at, b.length);
        if (i < 8) break;
        const size = u32be(b, i - 4);
        at = i + 4;
        if (size >= 16 && i - 4 + size <= b.length) {
          parseMoov(b, i + 8, i - 4 + size, tracks, out);
          if (tracks.length) break;
        }
      }
      if (tracks.length) continue;
    }
    eachBox(b, 0, b.length, (p, type, s, e) => {
      if (type === 'ftyp' && !out.brand) {
        const major = ascii(b, s, 4).trim();
        const list = [];
        for (let q = s + 4; q + 4 <= e && list.length < 8; q += 4) {
          const t = ascii(b, q, 4).trim();
          if (t) list.push(t);
        }
        out.brand = major || list[0] || '';
        if (list.length) out.compatibleBrands = list.slice(0, 6).join(' / ');
      }
      if (type === 'mdat' && mdatAt < 0) mdatAt = p;
      if (type === 'moov') {
        if (moovAt < 0) moovAt = p;
        parseMoov(b, s, e, tracks, out);
      }
    }, 0);
  }
  const video = tracks.filter((t) => t.kind === 'vide' && t.width).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const audio = tracks.filter((t) => t.kind === 'soun')[0];
  if (video) {
    out.width = video.width;
    out.height = video.height;
    if (video.rotation) out.rotation = video.rotation;
    if (video.frameRate) out.frameRate = video.frameRate;
    if (video.trackDuration && !out.duration) out.duration = video.trackDuration;
  }
  if (video && video.codec) out.codec = video.codec;
  if (audio) {
    if (audio.sampleRate) out.sampleRate = audio.sampleRate;
    if (audio.channels) out.channels = audio.channels;
    if (audio.bitDepth) out.bitDepth = audio.bitDepth;
    out.audioCodec = audio.codec || '';
    if (audio.trackDuration && !out.duration) out.duration = audio.trackDuration;
  }
  if (!out.codec) {
    const all = [...new Set(tracks.map((t) => t.codec).filter(Boolean))];
    if (all.length) out.codec = all.join(' + ');
  } else if (out.audioCodec && out.audioCodec !== out.codec) out.codec = out.codec + ' + ' + out.audioCodec;
  if (tracks.length) {
    out.tracks = tracks.length;
    const kinds = [...new Set(tracks.map((t) => ({ vide: '视频', soun: '音频', subt: '字幕', text: '文本', meta: '元数据', hint: '提示' }[t.kind] || (t.kind || '其他')).trim()))];
    if (kinds.length) out.trackKinds = kinds.join(' + ');
  }
  if (moovAt >= 0 && mdatAt >= 0) out.faststart = moovAt < mdatAt;
  return dropEmpty(out);
}

function parseMoov(b, s, e, tracks, out) {
  eachBox(b, s, e, (p, type, cs, ce) => {
    if (type === 'mvhd') parseMvhd(b, cs, out);
    else if (type === 'trak') parseTrak(b, cs, ce, tracks);
    else if (type === 'mvex') out.fragmented = true;
    else if (type === 'udta') readUdta(b, cs, ce, out);
    else if (type === 'meta') readMeta(b, cs, ce, out);
  }, 1);
}

function parseMvhd(b, cs, out) {
  const ver = u8(b, cs);
  let created = 0; let modified = 0; let timescale = 0; let duration = 0;
  if (ver === 1) {
    created = u64be(b, cs + 8); modified = u64be(b, cs + 16);
    timescale = u32be(b, cs + 24); duration = u64be(b, cs + 28);
  } else {
    created = u32be(b, cs + 4); modified = u32be(b, cs + 8);
    timescale = u32be(b, cs + 12); duration = u32be(b, cs + 16);
  }
  if (timescale) {
    out.timescale = timescale;
    if (duration) out.duration = Math.round((duration / timescale) * 100) / 100;
  }
  const made = macTime(created);
  if (made) out.created = made;
  const mod = macTime(modified);
  if (mod) out.modified = mod;
}
function parseTrak(b, cs, ce, tracks) {
  const t = {};
  eachBox(b, cs, ce, (q, ty, ds, de) => {
    if (ty === 'tkhd') readTkhd(b, ds, t);
    else if (ty === 'edts') t.edited = true;
    else if (ty === 'mdia') {
      /** mdia 里才是真正描述媒体的那一层：mdhd / hdlr / minf(stbl/stsd,stts) */
      eachBox(b, ds, de, (q2, ty2, d2, e2) => {
        if (ty2 === 'mdhd') readMdhd(b, d2, t);
        else if (ty2 === 'hdlr') t.kind = ascii(b, d2 + 8, 4);
        else if (ty2 === 'minf') {
          eachBox(b, d2, e2, (q3, ty3, d3, e3) => {
            if (ty3 !== 'stbl') return;
            eachBox(b, d3, e3, (q4, ty4, d4, e4) => {
              if (ty4 === 'stsd') readStsd(b, d4, t);
              else if (ty4 === 'stts') readStts(b, d4, t);
              else if (ty4 === 'stsz') t.samples = u32be(b, d4 + 12);
              else if (ty4 === 'stco' || ty4 === 'co64') t.chunkOffsets = u32be(b, d4 + 8);
            }, 5);
          }, 4);
        }
      }, 3);
    }
  }, 1);
  if (t.kind === 'vide' && t.timescale && t.sttsDelta) {
    const fps = t.timescale / t.sttsDelta;
    if (fps > 0.5 && fps < 1000) t.frameRate = Math.round(fps * 1000) / 1000;
  }
  if (!t.width && t.stsdWidth) { t.width = t.stsdWidth; t.height = t.stsdHeight; }
  if (t.kind === 'vide' || t.kind === 'soun' || t.codec) tracks.push(t);
  return t;
}

/** stts：前两个游程给出平均帧率 */
function readStts(b, ds, t) {
  const n = u32be(b, ds + 4);
  if (!n || n > 100000) return;
  t.sttsEntries = n;
  t.sttsDelta = u32be(b, ds + 12);
  t.sttsRun = u32be(b, ds + 8);
}

/** tkhd：矩阵换算出真实宽高与旋转 */
function readTkhd(b, ds, t) {
  const ver = u8(b, ds);
  const matrix = ver === 1 ? ds + 52 : ds + 40;
  if (matrix + 40 > b.length) return;
  const ma = i32be(b, matrix) / 65536;
  const mb = i32be(b, matrix + 4) / 65536;
  const w = i32be(b, matrix + 36) / 65536;
  const h = i32be(b, matrix + 40) / 65536;
  const deg = Math.round((Math.atan2(mb, ma) * 180) / Math.PI);
  const sideways = Math.abs(Math.abs(deg) - 90) < 20;
  if (w > 0 && h > 0 && w < 20000 && h < 20000) {
    t.width = Math.round(sideways ? h : w);
    t.height = Math.round(sideways ? w : h);
  }
  if (Math.abs(deg) >= 70 && Math.abs(deg) <= 110) t.rotation = deg > 0 ? 90 : -90;
  else if (Math.abs(deg) > 150) t.rotation = 180;
}

/** mdhd：媒体时基与时长 */
function readMdhd(b, ds, t) {
  const ver = u8(b, ds);
  const tsOff = ver === 1 ? ds + 20 : ds + 12;
  const ts = u32be(b, tsOff);
  const dur = ver === 1 ? u64be(b, tsOff + 4) : u32be(b, tsOff + 4);
  if (ts) t.timescale = ts;
  if (ts && dur) {
    const secs = dur / ts;
    if (secs > 0 && secs < 604800) t.trackDuration = Math.round(secs * 100) / 100;
  }
  const lang = u16le(b, tsOff + 14) & 0x7fff;
  if (lang && lang !== 0x5f2b) {
    const l = s16Lang(lang);
    if (l) t.language = l;
  }
}

/** QuickTime 的 15 位语言码 */
function s16Lang(v) {
  const a = (v >> 10) & 0x1f;
  const b = (v >> 5) & 0x1f;
  const c = v & 0x1f;
  const s = a === 0 && b === 0 && c === 0 ? '' : String.fromCharCode(a ? 96 + a : 122, b ? 96 + b : 122, c ? 96 + c : 122);
  return /^[a-z]{3}$/.test(s) ? s : '';
}

/** stsd：样本描述符里的编解码 fourcc、音频采样率 / 声道 / 位深、视频宽高 */
function readStsd(b, ds, t) {
  const n = u32be(b, ds + 4);
  if (!n || n > 64) return;
  let at = ds + 8;
  const size = u32be(b, at);
  if (size < 8 || at + size > b.length) return;
  const fourcc = ascii(b, at + 4, 4).trim();
  if (!fourcc) return;
  t.codec = CODEC_NAMES[fourcc] || fourcc;
  t.codecFourcc = fourcc;
  if (indexOfSeq(b, 'sinf', at, Math.min(b.length, at + 400)) >= 0) t.encrypted = true;
  if (t.kind === 'soun' || /mp4a|ac-3|ec-3|samr|sowt|twos|lpcm|fLaC|Opus|fl32|dtsc|dtsl|alac|\\.mp3/.test(fourcc)) {
    const channels = u16be(b, at + 24);
    const bits = u16be(b, at + 26);
    const rate = u32be(b, at + 32) >>> 16;
    if (channels > 0 && channels < 32) t.channels = channels;
    if (bits > 0 && bits < 64) t.bitDepth = bits;
    if (rate > 0 && rate < 400000) t.sampleRate = rate;
    if (fourcc === 'alac' || fourcc === 'sowt' || fourcc === 'twos' || fourcc === 'lpcm' || fourcc === 'fLaC' || fourcc === 'flac') t.lossless = true;
  }
  if (t.kind === 'vide' || /avc|hev|hvc|mp4v|vp[89]|av01|jpeg|png|jpg/.test(fourcc)) {
    const w = u16be(b, at + 36);
    const h = u16be(b, at + 38);
    if (w > 0 && w < 20000 && h > 0 && h < 20000) { t.stsdWidth = w; t.stsdHeight = h; }
  }
}

const META_ATOMS = { nam: 'title', '©nam': 'title', art: 'creator', '©art': 'creator', alb: 'album', '©alb': 'album', day: 'year', '©day': 'year', gen: 'genre', '©gen': 'genre', too: 'software', '©too': 'software', cmt: 'comment', '©cmt': 'comment', wrt: 'composer', '©wrt': 'composer', cov: 'cover', '©cov': 'cover' };

function readMeta(b, cs, ce, out) {
  eachBox(b, cs, ce, (p, type, s, e) => {
    if (type !== 'ilst') return;
    eachBox(b, s, e, (q, key, ks, ke) => {
      const name = META_ATOMS[key.replace(/[^a-z]/gi, '').slice(0, 3)] || META_ATOMS[key];
      if (!name) return;
      if (name === 'cover') { out.cover = true; return; }
      const text = ascii(b, ks, Math.min(160, ke - ks)).replace(/[\u0000-\u001f]+/g, ' ');
      const clean = clip(text, 120);
      if (clean && !out[name]) out[name] = clean;
    }, 3);
  }, 2);
}

function readUdta(b, cs, ce, out) {
  const text = ascii(b, cs, Math.min(ce - cs, 4096));
  const pick = (key, name) => {
    const at = text.indexOf(C9 + key);
    if (at < 0 || out[name]) return;
    const v = clip(text.slice(at + 4, at + 90).replace(/[^\u0020-\u007e\u00a0-\uffff]+/g, ' '), 120);
    if (v.length > 1) out[name] = v;
  };
  pick('nam', 'title');
  pick('art', 'creator');
  pick('alb', 'album');
  pick('day', 'year');
  pick('cmt', 'comment');
  pick('too', 'software');
  if (text.indexOf(C9 + 'cov') >= 0) out.cover = true;
}

/* ------------------------------------------------------------------ AVI */

const AVI_COMP = {
  DIB: '未压缩（BMP 位图）', RGB: 'RGB', '24BIT': '24 位 RGB', CVID: 'Cinepak', IV50: 'Intel Indeo 5',
  IYUV: 'iYuV', MJPG: 'Motion JPEG', MR16: 'Motion JPEG', DIVX: 'DivX', DX50: 'DivX 5', XVID: 'Xvid',
  H264: 'H.264', x264: 'H.264', avc1: 'H.264', mp4s: 'MPEG-4', VP31: 'VP3', VP6F: 'VP6', WMV2: 'WMV 2',
  wmv3: 'WMV 3', UYVY: 'UYVY', YUY2: 'YUY2', h263: 'H.263', I263: 'H.263', HFYU: 'Huffyuv',
};

export function aviInfo(b) {
  const out = { container: 'AVI' };
  const avih = indexOfSeq(b, 'avih', 0, Math.min(b.length, 8192));
  if (avih >= 0) {
    const at = avih + 8;
    const usPerFrame = u32le(b, at);
    const frames = u32le(b, at + 16);
    const streams = u32le(b, at + 24);
    const w = u32le(b, at + 32);
    const h = u32le(b, at + 36);
    if (w > 0 && h > 0 && w < 20000 && h < 20000) { out.width = w; out.height = h; }
    if (usPerFrame > 0) {
      out.frameRate = Math.round((1e6 / usPerFrame) * 1000) / 1000;
      if (frames > 0) {
        out.frames = frames;
        out.duration = Math.round((frames * usPerFrame) / 1e4) / 100;
      }
    }
    if (streams) out.tracks = streams;
    out.interleaved = !!(u32le(b, at + 12) & 0x10);
  }
  const strf = indexOfSeq(b, 'strf', 0, Math.min(b.length, 16384));
  if (strf >= 0 && u32le(b, strf + 8) >= 40) {
    const w = Math.abs(i32le(b, strf + 16));
    const h = Math.abs(i32le(b, strf + 20));
    if (!out.width && w > 0 && h > 0) { out.width = w; out.height = h; }
    const bpp = u16le(b, strf + 22);
    if (bpp) out.bitDepth = bpp;
  }
  const strh = indexOfSeq(b, 'strh', 0, Math.min(b.length, 16384));
  if (strh >= 0 && strh + 40 < b.length) {
    const body = strh + 8;
    const fccType = ascii(b, body, 4);
    const handler = ascii(b, body + 4, 4).replace(/\u0000+$/, '').trim();
    if (/^[\x20-\x7e]{3,4}$/.test(handler)) out.codec = AVI_COMP[handler] || handler;
    const scale = u32le(b, body + 20);
    const rate = u32le(b, body + 24);
    if (!out.frameRate && scale && rate) out.frameRate = Math.round((rate / scale) * 1000) / 1000;
    if (fccType === 'auds') {
      const aScale = u32le(b, body + 20);
      const aRate = u32le(b, body + 24);
      if (aRate && aScale && aRate / aScale < 400000) out.sampleRate = Math.round(aRate / aScale);
    }
  }
  const audio = indexOfSeq(b, 'auds', 0, Math.min(b.length, 16384)) >= 0;
  const video = indexOfSeq(b, 'vids', 0, Math.min(b.length, 16384)) >= 0;
  out.trackKinds = [video && '视频', audio && '音频'].filter(Boolean).join(' + ');
  const info = (tag) => {
    const at = indexOfSeq(b, tag, 0, Math.min(b.length, 262144));
    if (at < 0) return '';
    const len = Math.min(160, u32le(b, at + 4) || 0);
    return clip(ascii(b, at + 8, len), 160);
  };
  const title = info('INAM'); if (title) out.title = title;
  const artist = info('IART'); if (artist) out.creator = artist;
  const soft = info('ISFT'); if (soft) out.software = soft;
  const copy = info('ICOP'); if (copy) out.copyright = copy;
  return dropEmpty(out);
}

/* ------------------------------------------------------------------ FLV */

export function flvInfo(b) {
  if (ascii(b, 0, 3) !== 'FLV') return null;
  const flags = u8(b, 4);
  const out = { container: 'FLV', version: u8(b, 3) };
  if (!(flags & 0x01)) out.noAudio = true;
  if (!(flags & 0x02)) out.noVideo = true;
  const offset = u32be(b, 5);
  let p = offset >= 9 && offset < 1024 ? offset : 9;
  p += 4;
  for (let guard = 0; guard < 12 && p + 11 < b.length; guard++) {
    const type = u8(b, p);
    const size = (u8(b, p + 1) << 16) | (u8(b, p + 2) << 8) | u8(b, p + 3);
    const body = p + 11;
    if (size <= 0 || body + size > b.length) break;
    if (type === 18) {
      Object.assign(out, amf0Meta(b.subarray(body, body + size)));
      break;
    }
    if (type === 9 && !out.width) {
      const w = u16be(b, body + 5);
      const h = u16be(b, body + 7);
      if (w && h) { out.width = w; out.height = h; out.codec = 'FLV 视频标签'; }
    }
    p = body + size + 4;
  }
  return dropEmpty(out);
}

function readDouble(b, p) {
  if (p + 7 >= b.length) return 0;
  try { return b.readDoubleBE(p); } catch { return 0; }
}

/** 只读 AMF0 头部的键值（够取 width/height/duration/framerate/videodatarate 等） */
export function amf0Meta(body) {
  const out = {};
  let p = 0;
  const stop = () => { p = body.length; };
  const str = () => { const len = u16be(body, p); p += 2; const s = ascii(body, p, Math.min(len, 512)); p += len; return s; };
  const value = (depth) => {
    if (p >= body.length) return undefined;
    const type = u8(body, p);
    p++;
    if (type === 0x00) { const v = readDouble(body, p); p += 8; return v; }
    if (type === 0x01) return true;
    if (type === 0x02) return str();
    if (type === 0x05) return null;
    if (type === 0x06) return undefined;
    if (type === 0x08 || type === 0x0a) {
      const count = type === 0x0a ? u32be(body, p) : 0;
      if (type === 0x0a) p += 4;
      const o = {};
      if (depth > 1) return o;
      for (let i = 0; i < (count || 40) && p + 3 < body.length; i++) {
        const key = str();
        if (!key && u8(body, p) === 0x09) { p++; break; }
        o[key.toLowerCase()] = value(depth + 1);
      }
      return o;
    }
    if (type === 0x03 || type === 0x11 || type === 0x0c) {
      const o = {};
      if (depth > 1) return o;
      for (let i = 0; i < 40 && p + 3 < body.length; i++) {
        const key = str();
        if (!key && u8(body, p) === 0x09) { p++; break; }
        o[key.toLowerCase()] = value(depth + 1);
      }
      return o;
    }
    if (type === 0x04) { const n = u32be(body, p); p += 4; const a = []; for (let i = 0; i < n && i < 40; i++) a.push(value(depth + 1)); return a; }
    if (type === 0x07 || type === 0x0d || type === 0x0f || type === 0x10) return undefined;
    stop();
    return undefined;
  };
  let meta = null;
  for (let guard = 0; guard < 6 && p < body.length; guard++) {
    const v = value(0);
    if (v && typeof v === 'object' && !Array.isArray(v)) { meta = v; break; }
  }
  if (!meta) return out;
  const num = (k) => (Number.isFinite(Number(meta[k])) ? Number(meta[k]) : 0);
  const strOf = (k) => (typeof meta[k] === 'string' ? clip(meta[k], 120) : '');
  if (num('width')) out.width = num('width');
  if (num('height')) out.height = num('height');
  if (num('framerate')) out.frameRate = Math.round(num('framerate') * 1000) / 1000;
  if (num('duration')) out.duration = Math.round(num('duration') * 100) / 100;
  if (num('videodatarate')) out.videoBitrate = Math.round(num('videodatarate') * 1000);
  if (num('audiodatarate')) out.audioBitrate = Math.round(num('audiodatarate') * 1000);
  if (num('videosize')) out.videoBytes = num('videosize');
  if (num('videocodecid')) out.codec = 'FLV 视频编码 #' + num('videocodecid');
  if (strOf('encoder')) out.software = strOf('encoder');
  if (strOf('title')) out.title = strOf('title');
  return dropEmpty(out);
}
/* ------------------------------------------------------------ ID3 标签 */

const ID3_KEYS = {
  TIT2: 'title', TT2: 'title', TPE1: 'creator', TP1: 'creator', TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album', TYER: 'year', TYE: 'year', TDRC: 'year', TCON: 'genre', TCO: 'genre',
  TPOS: 'disc', TPA: 'disc', TRCK: 'track', TRK: 'track', APIC: 'cover', PIC: 'cover', MVI: 'cover',
  COMM: 'comment', COM: 'comment', TCOP: 'copyright', TPUB: 'publisher', PUB: 'publisher',
  TSSE: 'software', TENC: 'encodedBy', TLEN: 'durationMs', TPE3: 'conductor', TOLY: 'lyricist',
  WOAR: 'url', WXXX: 'url',
};

function syncSafe(b, p) {
  return ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
}

function decodeTagText(buf, encoding) {
  if (!buf || !buf.length) return '';
  if (encoding === 1) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    return s;
  }
  if (encoding === 2) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    return s;
  }
  if (encoding === 3) return buf.toString('latin1');
  return buf.toString('utf-8');
}

/** ID3v2（2.2 / 2.3 / 2.4）+ ID3v1 兜底 */
export function id3Tags(head, tail) {
  const out = {};
  const b = head;
  if (b && ascii(b, 0, 3) === 'ID3') {
    const ver = u8(b, 3);
    const flags = u8(b, 5);
    const size = ver === 2 ? ((u8(b, 6) << 16) | (u8(b, 7) << 8) | u8(b, 8)) : syncSafe(b, 6);
    const idLen = ver === 2 ? 3 : 4;
    const hdrLen = ver === 2 ? 3 : 10;
    let p = ver === 2 ? 10 : 10 + ((flags & 0x40) ? 10 : 0);
    const end = Math.min(b.length, 10 + size);
    for (let guard = 0; p + hdrLen <= end && guard < 250; guard++) {
      const id = ascii(b, p, idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
      const frameSize = ver === 2
        ? ((u8(b, p + 3) << 16) | (u8(b, p + 4) << 8) | u8(b, p + 5))
        : (ver === 4 ? syncSafe(b, p + 4) : u32be(b, p + 4));
      const body = p + hdrLen;
      if (frameSize <= 0 || body + frameSize > b.length) break;
      const key = ID3_KEYS[id];
      if (key === 'cover') out.cover = true;
      else if (key && !out[key]) {
        if (id[0] === 'T') {
          const text = decodeTagText(b.subarray(body + 1, body + frameSize), u8(b, body));
          out[key] = clip(text.replace(/[\u0000]+/g, ' '), 160);
        } else if (id === 'COMM' || id === 'COM') {
          const enc = u8(b, body);
          out.comment = clip(decodeTagText(b.subarray(body + 4, body + frameSize), enc).replace(/[\u0000]+/g, ' '), 160);
        } else if (id[0] === 'W') {
          out.url = clip(ascii(b, body, frameSize), 160);
        }
      }
      p = body + frameSize;
    }
    if (out.durationMs) {
      const ms = Number(out.durationMs.replace(/\D/g, ''));
      if (ms > 0) out.duration = Math.round(ms / 100) / 10;
      delete out.durationMs;
    }
    if (out.year) out.year = clip(String(out.year).slice(0, 4), 8);
    if (out.genre) out.genre = id3Genre(out.genre);
  }
  if (tail && tail.length >= 128) {
    const at = tail.length - 128;
    if (ascii(tail, at, 3) === 'TAG') {
      const f = (o, n) => clip(ascii(tail, at + o, n), 60);
      if (!out.title) out.title = f(3, 30);
      if (!out.creator) out.creator = f(33, 30);
      if (!out.album) out.album = f(63, 30);
      if (!out.year) out.year = f(93, 4);
      if (!out.comment) out.comment = f(97, 28);
      if (!out.genre) out.genre = id3Genre(u8(tail, at + 127));
      out.tagVersion = 'ID3v1';
    }
  }
  return dropEmpty(out);
}

const ID3_GENRES = ('Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|'
  + 'Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Background|Sound|Samba|Euro-Techno|Ambient|Trip-Med|Vocal|'
  + 'Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|Alt Rock|Bass|Soul|'
  + 'Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|'
  + 'Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|'
  + 'Cabaret|New Wave|Psychadelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|'
  + 'Rock & Roll|Hard Rock').split('|');

/** "(17)" / "Rock" / "13" 三种写法都要认 */
function id3Genre(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /^\((\d+)\)\s*(.*)$/.exec(s);
  if (m) return clip((ID3_GENRES[Number(m[1])] || '') + (m[2] ? ' / ' + m[2] : ''), 60);
  if (/^\d{1,3}$/.test(s)) return ID3_GENRES[Number(s)] || s;
  return clip(s, 60);
}

/* ---------------------------------------------------------------- 字体 */

const NAME_IDS = {
  1: 'family', 2: 'style', 4: 'fullName', 6: 'postscriptName', 8: 'designer', 9: 'manufacturer',
  10: 'designerUrl', 11: 'license', 13: 'licenseUrl', 16: 'typographicFamily', 17: 'typographicStyle',
  0: 'copyright',
};

export function fontInfo(b, mime) {
  const type = String(mime || '').toLowerCase();
  const eat = (re) => (re.test(type) ? true : false);
  /* WOFF / WOFF2 头部字段与 sfnt 一样是大端序 */
  if (ascii(b, 0, 4) === 'wOFF') {
    const flavor = u32be(b, 4);
    return dropEmpty({
      fontFlavor: 'WOFF', numTables: u16be(b, 12),
      sfntFlavor: flavor === 0x4f54544f ? 'OpenType（CFF 轮廓）' : 'TrueType 轮廓',
      totalSfntSize: u32be(b, 16), sfntSize: u32be(b, 16), compressedSize: u32be(b, 20),
      fontVersion: (u16be(b, 24) || 0) + '.' + (u16be(b, 26) || 0),
    });
  }
  if (ascii(b, 0, 4) === 'wOF2') {
    const flavor = u32be(b, 4);
    return dropEmpty({
      fontFlavor: 'WOFF2', numTables: u16be(b, 12),
      sfntFlavor: flavor === 0x4f54544f ? 'OpenType（CFF 轮廓）' : 'TrueType 轮廓',
      totalSfntSize: u32be(b, 16), sfntSize: u32be(b, 16), compressedSize: u32be(b, 20),
      fontVersion: (u16be(b, 24) || 0) + '.' + (u16be(b, 26) || 0),
    });
  }
  if (ascii(b, 0, 4) === 'ttcf') return dropEmpty({ fontFlavor: 'TrueType 字体集（TTC）', numTables: u32be(b, 8) });
  const sig = u32be(b, 0);
  const isSfnt = sig === 0x00010000 || ascii(b, 0, 4) === 'OTTO' || ascii(b, 0, 4) === 'true' || ascii(b, 0, 4) === 'typ1';
  if (!isSfnt && !eat(/font|typeface/)) return null;
  if (!isSfnt) return null;
  const numTables = u16be(b, 4);
  const out = {
    fontFlavor: ascii(b, 0, 4) === 'OTTO' ? 'OpenType（CFF 轮廓）' : ascii(b, 0, 4) === 'true' ? 'TrueType（Apple）' : 'TrueType',
    numTables,
  };
  const tables = {};
  for (let i = 0; i < numTables && i < 80; i++) {
    const at = 12 + i * 16;
    if (at + 16 > b.length) break;
    const tag = ascii(b, at, 4);
    if (!/^[A-Za-z0-9 /]{4}$/.test(tag)) continue;
    tables[tag] = { offset: u32be(b, at + 8), length: u32be(b, at + 12) };
  }
  out.tables = Object.keys(tables).slice(0, 40).join(' ');
  if (tables.maxp) out.glyphs = u16be(b, tables.maxp.offset + 4);
  if (tables.head) {
    const h = tables.head.offset;
    out.unitsPerEm = u16be(b, h + 18);
    const xMin = i32s(b, h + 36); const yMin = i32s(b, h + 38);
    const xMax = i32s(b, h + 40); const yMax = i32s(b, h + 42);
    if (xMax || yMax) out.bbox = (xMax - xMin) + '×' + (yMax - yMin);
    if (u32be(b, h + 12) !== 0x5f0f3cf5) out.headMagic = false;
  }
  if (tables['OS/2']) {
    const at = tables['OS/2'].offset;
    out.weightClass = u16be(b, at + 4);
    out.widthClass = u16be(b, at + 6);
    const fsType = u16be(b, at + 8);
    if (fsType & 0x0002) out.embedding = '禁止嵌入';
    else if (fsType & 0x0004) out.embedding = '仅预览与打印';
    else if (fsType & 0x0008) out.embedding = '可编辑嵌入';
    else if (fsType) out.embedding = '安装嵌入';
    else out.embedding = '可自由嵌入';
    const ver = u16be(b, at);
    out.os2Version = ver;
    const typo = i32s(b, at + 68);
    if (typo) out.typoAscender = typo;
    out.fsSelection = u16be(b, at + 62);
    if (out.fsSelection & 0x20) out.bold = true;
    if (out.fsSelection & 0x01) out.italic = true;
    const first = u16be(b, at + 64);
    const lastChar = u16be(b, at + 66);
    if (first || lastChar) out.coverage = 'U+' + hex4(first) + '–U+' + hex4(lastChar);
  }
  if (tables.post) {
    const angle = i32be(b, tables.post.offset + 4) >> 16;
    if (angle) out.italicAngle = angle;
    out.postFormat = u32be(b, tables.post.offset) === 0x20000 ? '2.0（逐字形名字）' : u32be(b, tables.post.offset) === 0x30000 ? '3.0' : '1.0';
  }
  if (tables.COLR || tables.CPAL || tables['SVG '] || tables.cbdt || tables.CBDT) out.colorFont = true;
  if (tables.GPOS) out.features = 'GPOS';
  else if (tables.GSUB) out.features = 'GSUB';
  else if (tables.kern) out.features = 'kern';
  if (tables.hmtx || tables.vmtx) out.metrics = [tables.hmtx && '水平', tables.vmtx && '垂直'].filter(Boolean).join(' + ');
  if (tables.fpgm || tables.cvt) {
    out.hinting = tables.cvt ? 'TT instruction' : 'fpgm';
  }
  readNameTable(b, tables.name, out);
  const family = out.family || out.fullName || out.postscriptName || '';
  if (/icon|glyph|symbol|awesome|emoji|remix|weblate|material|feather|phosphor|codicon|fontist|linear/i.test(family)) out.iconFont = true;
  if (out.glyphs && out.glyphs < 120 && !out.iconFont && /icon|glyph/i.test(family)) out.iconFont = true;
  return dropEmpty(out);
}

/** name 表：优先 Windows (3,1,0x409)，其次 Mac (1,0)，再次 Unicode */
function readNameTable(b, name, out) {
  if (!name) return;
  const at = name.offset;
  if (at + 6 > b.length) return;
  const count = u16be(b, at + 2);
  const strings = at + u16be(b, at + 4);
  const best = {};
  for (let i = 0; i < count && i < 120; i++) {
    const e = at + 6 + i * 12;
    if (e + 12 > b.length) break;
    const platform = u16be(b, e);
    const encoding = u16be(b, e + 2);
    const nameId = u16be(b, e + 6);
    const len = u16be(b, e + 8);
    const off = u16be(b, e + 10);
    const key = NAME_IDS[nameId];
    if (!key) continue;
    const rank = platform === 3 ? 3 : platform === 0 ? 2 : platform === 1 ? 1 : 0;
    if (best[key] && best[key].rank >= rank) continue;
    const raw = b.subarray(strings + off, strings + off + Math.min(len, 512));
    if (!raw.length || strings + off + len > b.length) continue;
    const enc = platform === 3 || platform === 0 || encoding === 1 ? 2 : 0;
    best[key] = { rank, value: clip(decodeTagText(raw, enc).replace(/[\u0000]+/g, ' '), 120) };
  }
  for (const k of Object.keys(best)) if (best[k].value) out[k] = best[k].value;
}

/* --------------------------------------------------- 其它图像容器 */

const ICNS_EDGE = {
  icm4: 16, icm8: 32, ic11: 16, ic12: 32, ic04: 16, ic05: 32, ic06: 48, is32: 32, s8mk: 16, il32: 512,
  ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic13: 256, ic14: 512, ic15: 1024, icn4: 48, icn8: 128,
  ic0p: 16, ic1p: 32, ic0q: 48, ic1q: 64, togp: 1024,
};

export function icnsInfo(b) {
  const sizes = [];
  const seen = new Set();
  let best = 0;
  let p = 8;
  for (let guard = 0; guard < 80 && p + 8 <= b.length; guard++) {
    const type = ascii(b, p, 4).toLowerCase();
    const size = u32be(b, p + 4);
    if (size < 8 || p + size > b.length) break;
    let edge = ICNS_EDGE[type] || 0;
    if (!edge && /^ic(\d\d)$/.test(type)) edge = ({ 4: 16, 5: 32, 6: 48, 7: 128, 8: 256, 9: 512, 10: 1024 })[Number(type.slice(2))] || 0;
    if (!edge && /^[a-z](\d{1,4})x(\d{1,4})/.test(type)) {
      const m = /^[a-z](\d{1,4})x(\d{1,4})/.exec(type);
      edge = Number(m[1]);
    }
    if (edge) {
      const repr = ascii(b, p + 8, 4) === 'png ' ? 'PNG' : ascii(b, p + 8, 4) === 'jp2 ' ? 'JP2' : ascii(b, p + 8, 4) === 'icp4' ? 'JPEG2000' : '位图';
      if (!seen.has(edge)) {
        seen.add(edge);
        sizes.push(edge + '×' + edge + '（' + type.toUpperCase() + ' · ' + repr + '）');
      }
      if (edge > best) best = edge;
    }
    p += size;
  }
  if (!sizes.length) return null;
  return dropEmpty({
    width: best, height: best, entries: sizes.length, iconSet: true,
    sizes: sizes.slice(0, 10).join('  '), format: 'macOS 图标集（ICNS）',
  });
}

export function ddsInfo(b) {
  if (ascii(b, 0, 4) !== 'DDS ' || b.length < 128) return null;
  if (u32le(b, 8) < 124) return null;
  const width = u32le(b, 20);
  const height = u32le(b, 24);
  if (!width || !height || width > 40000 || height > 40000) return null;
  const caps = u32le(b, 104);
  const fourcc = ascii(b, 84, 4).trim();
  const bpp = u16le(b, 80);
  const DX = { DXT1: 1, DXT2: 3, DXT3: 4, DXT4: 5, DXT5: 5, ATI1: 4, ATI2: 4, A2XY: 6, XY: 6 };
  const out = {
    width, height, mipLevels: u32le(b, 28) || 1, bitDepth: bpp || 0,
    codec: fourcc && fourcc !== 'RGB ' ? 'DirectX 压缩 ' + fourcc : 'DDS 位图',
    alpha: !!(u32le(b, 76) & 0x2) || /DXT[2-5]|ATI2|A2XY/.test(fourcc),
    compressed: !!DX[fourcc.toUpperCase()],
    cubemap: !!(caps & 0x8) || !!(caps & 0x200),
    volume: !!(caps & 0x800000),
    arraySize: u32le(b, 108) || 0,
    layout: u32le(b, 12) & 0x40000 ? '线性（无 pitch）' : '',
  };
  return dropEmpty(out);
}

export function exrInfo(b) {
  if (u32le(b, 0) !== 0x01312f76 || b.length < 64) return null;
  const text = ascii(b, 0, Math.min(b.length, 8192));
  const at = text.indexOf('dataWindow');
  if (at < 0) return null;
  const typeAt = at + 11;
  if (ascii(b, typeAt, 5) !== 'box2i') return null;
  const v = typeAt + 8;
  const xmin = i32le(b, v); const ymin = i32le(b, v + 4);
  const xmax = i32le(b, v + 8); const ymax = i32le(b, v + 12);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  if (width <= 0 || height <= 0 || width > 40000 || height > 40000) return null;
  const ch = /channels/.test(text) ? (u8(b, text.indexOf('channels') + 16) === 104 ? 'RGB' : '') : '';
  return dropEmpty({ width, height, codec: 'OpenEXR', hdr: true, pixelType: /pixelType/.test(text) ? '半浮点' : '', channels: ch });
}

export function pnmInfo(b) {
  const head = ascii(b, 0, 2);
  if (!/^P[1-7]$/.test(head) || b.length < 4) return null;
  const sep = b[2];
  if (sep !== 0x20 && sep !== 0x09 && sep !== 0x0a && sep !== 0x0d) return null;
  if (head === 'P7') {
    const text = ascii(b, 0, Math.min(b.length, 2048));
    const w = /WIDTH\s+(\d+)/.exec(text);
    const h = /HEIGHT\s+(\d+)/.exec(text);
    const d = /DEPTH\s+(\d+)/.exec(text);
    if (!w || !h) return null;
    return dropEmpty({ width: Number(w[1]), height: Number(h[1]), channels: d ? Number(d[1]) : 0, codec: 'PAM（P7）' });
  }
  const maxScan = Math.min(b.length, 1024);
  const tokens = [];
  let p = 2;
  while (p < maxScan && tokens.length < 3) {
    const c = u8(b, p);
    if (c === 0x0a || c === 0x0d) { p++; continue; }
    if (c === 0x23) { while (p < maxScan && u8(b, p) !== 0x0a) p++; continue; }
    if (c <= 0x20) { p++; continue; }
    let s = '';
    while (p < maxScan && u8(b, p) > 0x20) { s += String.fromCharCode(u8(b, p)); p++; }
    if (s) tokens.push(s);
  }
  const width = Number(tokens[0]);
  const height = Number(tokens[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return null;
  const asciiKind = head === 'P1' || head === 'P2' || head === 'P3';
  const maxVal = Number(tokens[2] || 0);
  const kind = ({ P1: 'PBM 单色', P2: 'PGM 灰度', P3: 'PPM 彩色（ASCII）', P4: 'PBM 单色（二进制）', P5: 'PGM 灰度（二进制）', P6: 'PPM 彩色（二进制）' })[head] || 'PNM';
  return dropEmpty({
    width, height, codec: kind, maxVal,
    bitDepth: asciiKind ? 1 : (maxVal > 255 ? 16 : maxVal > 15 ? 8 : maxVal > 1 ? 5 : 1),
    channels: head === 'P1' || head === 'P4' ? 1 : head === 'P2' || head === 'P5' ? 1 : 3,
  });
}

export function tgaInfo(b) {
  if (b.length < 18) return null;
  const colorMap = u8(b, 1);
  const imageType = u8(b, 2);
  if (colorMap > 1 || [1, 2, 3, 9, 10, 11].indexOf(imageType) < 0) return null;
  const w = u16le(b, 12);
  const h = u16le(b, 14);
  const bpp = u8(b, 16);
  if (!w || !h || w > 20000 || h > 20000 || [8, 15, 16, 24, 32].indexOf(bpp) < 0) return null;
  const descriptor = u8(b, 17);
  return dropEmpty({
    width: w, height: h, bitDepth: bpp, alpha: bpp === 32 || (bpp === 16 && (descriptor & 0x0f) > 0),
    codec: imageType === 10 || imageType === 9 || imageType === 11 ? 'TGA（RLE 压缩）' : 'TGA',
    colorMap: colorMap === 1, origin: descriptor & 0x20 ? '右上' : descriptor & 0x10 ? '左上' : '',
    idLength: u8(b, 0),
  });
}

export function qoiInfo(b) {
  if (ascii(b, 0, 4) !== 'qoif' || b.length < 14) return null;
  const w = u32be(b, 4);
  const h = u32be(b, 8);
  if (!w || !h || w > 40000 || h > 40000) return null;
  return dropEmpty({
    width: w, height: h, channels: u8(b, 12), bitDepth: u8(b, 13) === 0 ? 8 : 16,
    codec: 'QOI（Quite OK Image）', alpha: u8(b, 12) === 4,
  });
}