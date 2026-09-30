import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, UA, MAX_ASSET_BYTES, MAX_DOC_BYTES, REQUEST_TIMEOUT_MS, CACHE_TTL_MS } from './config.mjs';

/* ------------------------------------------------------------------ URL */

const STRIP_RE = /^[\s"']+|[\s"']+$/g;

export function normalizeUrl(raw, base) {
  if (!raw) return null;
  let s = String(raw).trim().replace(STRIP_RE, '');
  if (!s || /^(javascript|vbscript|mailto|tel|callto|sms|blob|about|data):/i.test(s)) return null;
  try {
    const u = base ? new URL(s, base) : new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function shortHash(str, len = 10) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, len);
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

export function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

export function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && last.length <= 160 && !/^[.:]+$/.test(last)) return last;
    const q = u.searchParams.get('filename') || u.searchParams.get('file') || u.searchParams.get('name');
    if (q) return decodeURIComponent(String(q).split('/').pop());
  } catch { /* noop */ }
  return '';
}

/* ------------------------------------------------------------- HTTP 抓取 */

const DEFAULT_HEADERS = {
  'user-agent': UA,
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

function timeoutSignal(ms) {
  const t = AbortSignal.timeout ? AbortSignal.timeout(ms) : null;
  if (!t) return undefined;
  return AbortSignal.any ? AbortSignal.any([t]) : t;
}

/**
 * 抓取远端资源，返回完整字节（受 maxBytes 限制）。
 */
export async function grab(url, opts = {}) {
  const {
    headers = {}, method = 'GET', range, maxBytes = MAX_DOC_BYTES, fitsBytes = null,
    timeoutMs = REQUEST_TIMEOUT_MS, retries = 1, referer, signal,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await rawFetch(url, { method, headers, range, timeoutMs, referer, signal });
      const ct = (res.headers.get('content-type') || '').trim();
      let total = Number(res.headers.get('content-length')) || null;
      if (res.status === 206) {
        const cr = res.headers.get('content-range') || '';
        const m = /\/(\d+)$/.exec(cr);
        if (m) total = Number(m[1]) || total;
      }
      /*
       * fitsBytes = 「顺手取全量」的门槛：探测一个资源原本只要 maxBytes 那么多头部字节，
       * 但服务端报明的体积如果在门槛内（也就是「反正待会儿导出也要全量下载」），
       * 这一次连接就把上限提到整个文件，省掉紧随其后的第二条请求——
       * 既不重复传头部那些字节，也省一次往返与一次 TLS 冷启动。
       *
       * 拿 Content-Length 提上限必须排除带 Content-Encoding 的响应：
       * 那种情况下 Content-Length 是**压缩后**的字节数，而 readBody 读到的是解压后的流，
       * 照它设上限会把本该读到的头部拦腰截断（压缩比一高，几 KB 就“读完”了）。
       *
       * whole 不看 Content-Length，只看流是不是自己结束的：readBody 只有在主动截断时
       * 才置 truncated，没截断就说明整份解压字节都在手里，声明与实况不符也不会误判。
       */
      const encoded = /\b(?:gzip|br|deflate|zstd|compress)\b/i.test(res.headers.get('content-encoding') || '');
      let cap = maxBytes;
      if (!range && !encoded && res.status === 200 && fitsBytes != null && total != null && total > 0 && total <= fitsBytes) {
        cap = Math.max(maxBytes, total);
      }
      const buf = await readBody(res, cap);
      /*
       * 两道判断都要过：流没被我们主动截断，且（能比对时）实际字节数与服务端声明一致。
       * 后者防的是「连接提前结束」——那种情况流也算自然结束，但我们手里只有一半文件，
       * 当成全量缓存就会把残缺当原件。带 Content-Encoding 时压缩/解压字节数无法比对，跳过。
       */
      const matches = encoded || total == null || total === buf.body.length;
      const whole = !buf.truncated && !range && res.status === 200 && matches;
      return {
        status: res.status, ok: res.status >= 200 && res.status < 400,
        body: buf.body, bytes: buf.body.length, truncated: buf.truncated, whole,
        contentType: ct, charset: charsetOf(ct), totalBytes: total, finalUrl: res.url || url,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(120 * (attempt + 1));
    }
  }
  throw lastErr || new Error('fetch failed: ' + url);
}

async function rawFetch(url, { method, headers, range, timeoutMs, referer, signal }) {
  const h = { ...DEFAULT_HEADERS, ...headers };
  if (referer) h.referer = referer;
  if (range) h.range = range;
  const init = { method, headers: h, redirect: 'follow', duplex: 'half' };
  init.signal = signal || timeoutSignal(timeoutMs);
  let res = await fetch(url, init);
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
    const next = new URL(res.headers.get('location'), res.url || url).toString();
    try { res.body && res.body.cancel(); } catch { /* noop */ }
    res = await fetch(next, { ...init, method: 'GET' });
  }
  return res;
}

async function readBody(res, maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  try {
    for await (const chunk of res.body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += b.length;
      if (size > maxBytes) {
        const room = b.length - (size - maxBytes);
        if (room > 0) chunks.push(b.subarray(0, room));
        truncated = true;
        break;
      }
      chunks.push(b);
    }
  } finally {
    if (truncated) { try { await res.body.cancel(); } catch { /* noop */ } }
  }
  return { body: Buffer.concat(chunks), truncated };
}

/** 打开上游流（用于透传代理，支持 Range） */
export async function openStream(url, { range, referer, timeoutMs = REQUEST_TIMEOUT_MS, headers = {} } = {}) {
  return rawFetch(url, { method: 'GET', headers, range, timeoutMs, referer });
}

export function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return m ? m[1].toLowerCase() : '';
}

const REPLACEMENT = String.fromCharCode(0xFFFD);

/** 用页面声明的字符集解码（支持 gbk 等），失败回退 utf-8 */
export function decodeText(buffer, charset) {
  const list = [];
  if (charset) list.push(charset);
  if (/^gb/i.test(charset || '')) list.push('gb18030');
  list.push('utf-8');
  for (const cs of list) {
    try {
      const text = new TextDecoder(cs, { fatal: false }).decode(buffer);
      if (!text.includes(REPLACEMENT) || cs === 'utf-8') return text;
    } catch { /* 编码不支持，尝试下一个 */ }
  }
  return buffer.toString('utf-8');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 从字节里嗅探字符集：先看 <meta charset>，再退到任意 charset= 写法。
 * 全站唯一实现（扫描编排与预览快照都用它，避免两处正则漂移）。
 */
export function sniffCharset(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = String(buffer.subarray(0, 4096).toString('latin1'));
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /charset=([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

/* ---------------------------------------------------------- 磁盘字节缓存 */

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(url) { return crypto.createHash('sha1').update(url).digest('hex'); }
export function cachePath(url) { return path.join(CACHE_DIR, cacheKey(url) + '.bin'); }
function cacheMetaPath(url) { return path.join(CACHE_DIR, cacheKey(url) + '.json'); }
/** 同一个地址只算一次哈希，.bin 与 .json 共用 */
function cacheFiles(url) {
  const key = cacheKey(url);
  return { bin: path.join(CACHE_DIR, key + '.bin'), json: path.join(CACHE_DIR, key + '.json') };
}

/**
 * 元信息内存索引：一次扫描里同一个地址会被查很多次（探测、导出、预览），
 * 每次都 existsSync ×2 + statSync + readFileSync 纯属浪费。写入与清空缓存时同步维护。
 * 文件被外部删掉时索引会短暂失真——读字节的那一步返回 null，调用方自然回源。
 */
const metaIndex = new Map();

export function readCacheMeta(url) {
  const hit = metaIndex.get(url);
  if (hit) {
    if (Date.now() - hit.savedAt > CACHE_TTL_MS) { metaIndex.delete(url); return null; }
    return { meta: hit, size: hit.bytes };
  }
  try {
    const st = fs.statSync(cachePath(url));
    if (!st.size) return null;
    const meta = JSON.parse(fs.readFileSync(cacheMetaPath(url), 'utf-8'));
    if (Date.now() - (meta.savedAt || 0) > CACHE_TTL_MS) return null;
    metaIndex.set(url, meta);
    return { meta, size: st.size };
  } catch { return null; }
}

export function readCacheBuffer(url) {
  try { return fs.readFileSync(cacheFiles(url).bin); } catch { return null; }
}

/** 只读缓存头部字节（探测尺寸 / 时长用，避免把几十 MB 全读进内存） */
export function readCacheHead(url, maxBytes) {
  const file = cacheFiles(url).bin;
  let fd = 0;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.max(0, Math.min(st.size, maxBytes));
    const buf = Buffer.allocUnsafe(len);
    const got = fs.readSync(fd, buf, 0, len, 0);
    return got === len ? buf : buf.subarray(0, got);
  } catch { return null; }
  finally { if (fd) { try { fs.closeSync(fd); } catch { /* noop */ } } }
}

export async function writeCache(url, { buffer, contentType, status, finalUrl, name, truncated, hash }) {
  if (!buffer || buffer.length > MAX_ASSET_BYTES) return false;
  const meta = {
    savedAt: Date.now(), contentType: contentType || '', status: status || 200,
    finalUrl: finalUrl || url, bytes: buffer.length, name: name || '',
    truncated: !!truncated,
    /** 内容指纹随缓存一起存：重复扫描时不必再把整份文件重算一遍哈希 */
    hash: hash || '',
  };
  /* 落盘与内存索引保持一致：先更新索引，再写文件（写失败时读字节那一步会回源） */
  metaIndex.set(url, meta);
  const files = cacheFiles(url);
  try {
    await fsp.writeFile(files.bin, buffer);
    await fsp.writeFile(files.json, JSON.stringify(meta));
    return true;
  } catch {
    metaIndex.delete(url);
    return false;
  }
}

/** 读取缓存里的原始字节（含 meta）；未命中或过期返回 null */
export function readCached(url) {
  const hit = readCacheMeta(url);
  if (!hit) return null;
  const buffer = readCacheBuffer(url);
  if (!buffer || !buffer.length) return null;
  return { buffer, meta: hit.meta };
}

/** 取得资源完整字节：优先缓存 */
export async function ensureBytes(url, opts = {}) {
  const { referer, maxBytes = MAX_ASSET_BYTES } = opts;
  const hit = readCacheMeta(url);
  if (hit && (!hit.meta.bytes || hit.meta.bytes <= maxBytes)) {
    const buffer = readCacheBuffer(url);
    if (buffer && buffer.length) {
      return { buffer, cached: true, contentType: hit.meta.contentType, status: hit.meta.status, finalUrl: hit.meta.finalUrl || url, truncated: false };
    }
  }
  const got = await grab(url, { maxBytes, referer });
  if (got.bytes && got.bytes <= maxBytes && !got.truncated) {
    await writeCache(url, { buffer: got.body, contentType: got.contentType, status: got.status, finalUrl: got.finalUrl });
  }
  return {
    buffer: got.body, cached: false, contentType: got.contentType, status: got.status,
    finalUrl: got.finalUrl, truncated: got.truncated, totalBytes: got.totalBytes,
  };
}

export function purgeCache() {
  metaIndex.clear();
  let removed = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (/\.(bin|json)$/.test(f)) { fs.rmSync(path.join(CACHE_DIR, f), { force: true }); removed++; }
    }
  } catch { /* noop */ }
  return removed;
}
