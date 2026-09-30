/**
 * 字节读取工具（全站唯一实现）
 *
 * probe.mjs / containers.mjs / docmeta.mjs 原本各抄一份 u16le/u16be/u32le/u32be/ascii/indexOfSeq/
 * clip/dropEmpty，边界判断细微不一致（有的 p+n<b.length、有的 <=），复制粘贴极易跑偏。
 * 统一到这里：越界一律返回 0 / 空串，调用方不必再各自防御。
 */

export const u8 = (b, p) => (p >= 0 && p < b.length ? b[p] : 0);
export const u16le = (b, p) => (p + 1 < b.length ? b[p] | (b[p + 1] << 8) : 0);
export const u16be = (b, p) => (p + 1 < b.length ? (b[p] << 8) | b[p + 1] : 0);
export const i16be = (b, p) => (p + 1 < b.length ? ((b[p] << 8) | b[p + 1]) << 16 >> 16 : 0);
export const u32le = (b, p) => (p + 3 < b.length ? ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0) : 0);
export const u32be = (b, p) => (p + 3 < b.length ? (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0) : 0);
export const i32le = (b, p) => (p + 3 < b.length ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0 : 0);
export const i32be = (b, p) => (p + 3 < b.length ? ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) | 0 : 0);

export function u64be(b, p) {
  if (p < 0 || p + 7 >= b.length) return 0;
  try { return Number(b.readBigUInt64BE(p)); } catch { return 0; }
}
export function i64le(b, p) {
  if (p < 0 || p + 7 >= b.length) return 0;
  try { return Number(b.readBigInt64LE(p)); } catch { return 0; }
}
export function f32be(b, p) {
  if (p < 0 || p + 3 >= b.length) return 0;
  try { return b.readFloatBE(p); } catch { return 0; }
}
/** 大端 float64（MP4 tkhd 矩阵、AMF0 number） */
export function f64be(b, p) {
  if (p < 0 || p + 7 >= b.length) return 0;
  try { return b.readDoubleBE(p); } catch { return 0; }
}

/** 读一段 latin1 字符（标签、四字符码、表名都用它） */
export function ascii(b, p, len) {
  if (!b || p < 0 || len <= 0 || p + len > b.length) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[p + i]);
  return s;
}

/** 读到 NUL 或末尾为止的字符串（容器里的说明文字、name 表条目） */
export function cstring(b, at, max) {
  if (at < 0) return '';
  let s = '';
  const cap = max || 120;
  for (let i = at; i < b.length && b[i] && s.length < cap; i++) s += String.fromCharCode(b[i]);
  return s.trim();
}

/**
 * 在字节流里查找一段 latin1 字符序列（'mvhd'、'ID3' 这类标签）。
 * 首字节用 Buffer.indexOf 走 SIMD，命中后再核对整段——原实现是纯 JS 双层循环，
 * 在几 MB 的头部里扫一个标签要空转上百万次。
 */
export function indexOfSeq(buf, seq, from, to) {
  const needle = Buffer.isBuffer(seq) ? seq : Buffer.from(String(seq), 'latin1');
  if (!needle.length) return -1;
  const start = Math.max(0, from || 0);
  const end = Math.min(to == null ? buf.length : to, buf.length) - needle.length;
  let p = buf.indexOf(needle[0], start);
  while (p >= 0 && p <= end) {
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (buf[p + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return p;
    p = buf.indexOf(needle[0], p + 1);
  }
  return -1;
}

/**
 * 清洗并截断元数据字符串：容器里的标题 / 作者常夹带控制字符与首尾空白。
 * （probe.mjs 另有一个更宽松的 clipText，只截断不清洗，两者用途不同。）
 */
export function clip(v, n) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 就地删掉空值键（0 / 空串 / null / false / 空数组都算空）：
 * 容器解析写出一堆「没读到就是 0」的键，出网前统一瘦身。
 */
export function dropEmpty(obj) {
  for (const k of Object.keys(obj || {})) {
    if (obj[k] === 0 || obj[k] === '' || obj[k] == null || obj[k] === false) delete obj[k];
    else if (Array.isArray(obj[k]) && !obj[k].length) delete obj[k];
  }
  return obj;
}

/** 非破坏版：只留有意义的键（时长 / 尺寸 0 是有效事实，所以不删 0 与 false） */
export function compact(obj) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}
