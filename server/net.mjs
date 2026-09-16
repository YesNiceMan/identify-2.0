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
    headers = {}, method = 'GET', range, maxBytes = MAX_DOC_BYTES,
    timeoutMs = REQUEST_TIMEOUT_MS, retries = 1, referer, signal,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await rawFetch(url, { method, headers, range, timeoutMs, referer, signal });
      const buf = await readBody(res, maxBytes);
      const ct = (res.headers.get('content-type') || '').trim();
      let total = Number(res.headers.get('content-length')) || null;
      if (res.status === 206) {
        const cr = res.headers.get('content-range') || '';
        const m = /\/(\d+)$/.exec(cr);
        if (m) total = Number(m[1]) || total;
      }
      return {
        status: res.status, ok: res.status >= 200 && res.status < 400,
        headers: Object.fromEntries(res.headers.entries()),
        body: buf.body, bytes: buf.body.length, truncated: buf.truncated,
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

/* ---------------------------------------------------------- 磁盘字节缓存 */

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(url) { return crypto.createHash('sha1').update(url).digest('hex'); }
export function cachePath(url) { return path.join(CACHE_DIR, cacheKey(url) + '.bin'); }
function cacheMetaPath(url) { return path.join(CACHE_DIR, cacheKey(url) + '.json'); }

export function readCacheMeta(url) {
  try {
    const bin = cachePath(url);
    if (!fs.existsSync(bin) || !fs.existsSync(cacheMetaPath(url))) return null;
    const st = fs.statSync(bin);
    if (!st.size) return null;
    const meta = JSON.parse(fs.readFileSync(cacheMetaPath(url), 'utf-8'));
    if (Date.now() - (meta.savedAt || 0) > CACHE_TTL_MS) return null;
    return { meta, size: st.size };
  } catch { return null; }
}

export function readCacheBuffer(url) {
  try { return fs.readFileSync(cachePath(url)); } catch { return null; }
}

export async function writeCache(url, { buffer, contentType, status, finalUrl, name, truncated }) {
  if (!buffer || buffer.length > MAX_ASSET_BYTES) return false;
  try {
    await fsp.writeFile(cachePath(url), buffer);
    await fsp.writeFile(cacheMetaPath(url), JSON.stringify({
      savedAt: Date.now(), contentType: contentType || '', status: status || 200,
      finalUrl: finalUrl || url, bytes: buffer.length, name: name || '',
      truncated: !!truncated,
    }));
    return true;
  } catch { return false; }
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
  let removed = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (/\.(bin|json)$/.test(f)) { fs.rmSync(path.join(CACHE_DIR, f), { force: true }); removed++; }
    }
  } catch { /* noop */ }
  return removed;
}
