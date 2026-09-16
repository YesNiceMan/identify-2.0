/**
 * 页面预览：把扫描时留下的原始 HTML 改造成一份「可安全嵌入的静态快照」。
 *
 * 原则：
 *   1. 只做减法，不改版式 —— 颜色、字体、间距全部沿用站点自己的 CSS，
 *      这样预览才配得上「原始页面的预览效果」。
 *   2. 不执行任何脚本 —— 响应带 script-src 'none'，文档里的 <script> 也整段剥掉，
 *      配合前端 iframe 的 sandbox="allow-same-origin"（不给 allow-scripts），
 *      内联 on* 处理器同样失效；保留同源是为了让外层界面能读 DOM 并叠加选择框。
 *   3. 不额外请求站点 —— 原始字节在扫描阶段已写入 .cache（键 = 页面地址 + #doc）。
 */
import { grab, decodeText, charsetOf, readCached, writeCache } from './net.mjs';

const DOC_SUFFIX = '#doc';

export function docKey(url) { return String(url || '') + DOC_SUFFIX; }

/** 扫描时留档：已有缓存就不重复写盘 */
export async function rememberDoc(url, buffer, contentType, status, truncated) {
  if (!url || !buffer || !buffer.length) return false;
  if (readCached(docKey(url))) return true;
  return writeCache(docKey(url), {
    buffer,
    contentType: contentType || 'text/html; charset=utf-8',
    status: status || 200,
    finalUrl: url,
    name: 'preview.html',
    truncated: !!truncated,
  });
}

/** 取页面原文：优先缓存，缺失时按原地址补抓一次 */
export async function loadDoc(url, referer) {
  const hit = readCached(docKey(url));
  if (hit) {
    return {
      buffer: hit.buffer,
      text: decodeText(hit.buffer, charsetOf(hit.meta.contentType) || sniffCharset(hit.buffer)),
      contentType: hit.meta.contentType || 'text/html',
      truncated: !!hit.meta.truncated,
      cached: true,
    };
  }
  try {
    const got = await grab(url, {
      maxBytes: 8 * 1024 * 1024,
      referer: referer || '',
      retries: 0,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    if (!got.ok) return { error: '站点返回 ' + got.status };
    await rememberDoc(got.finalUrl || url, got.body, got.contentType, got.status, got.truncated);
    return {
      buffer: got.body,
      text: decodeText(got.body, got.charset || sniffCharset(got.body)),
      contentType: got.contentType || 'text/html',
      truncated: !!got.truncated,
      cached: false,
    };
  } catch (err) {
    return { error: (err && err.message ? err.message : '无法取得页面原文').slice(0, 160) };
  }
}

function sniffCharset(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = String(buffer.subarray(0, 4096).toString('latin1'));
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

/* ------------------------------------------------------ 净化与注入 */

const SCRIPT_RE = /<script\b[\s\S]*?(?:<\/script\s*>|$)/gi;
const IFRAME_RE = /<iframe\b[\s\S]*?(?:<\/iframe\s*>|$)/gi;
const FRAME_RE = /<frame\b[^>]*>/gi;
const OBJECT_RE = /<(?:object|embed)\b[\s\S]*?(?:<\/(?:object|embed)\s*>|>)/gi;
const BASE_RE = /<base\b[^>]*>/gi;
const CHARSET_META_RE = /<meta\b[^>]*charset[^>]*>/gi;
const HTTP_EQUIV_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy(?:-report)?|refresh|x-dns-prefetch-control)["']?[^>]*>/gi;
const LINK_STRIP_RE = /<link\b[^>]*rel\s*=\s*["'][^"']*(?:manifest|prefetch|prerender|dns-prefetch|preconnect|pingback|icon|preload)["'][^>]*>/gi;
/** 无脚本环境里 noscript 会被当普通内容渲染，但其中的地址早已解析完毕，摘掉只留视觉干净 */
const NOSCRIPT_RE = /<noscript\b[\s\S]*?<\/noscript\s*>/gi;

function attr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 注入预览文档的补丁样式：只补「无脚本」带来的短板，不改站点自己的设计 */
const PATCH_CSS = [
  'html{-webkit-text-size-adjust:100%;scroll-behavior:auto!important}',
  'img{color:transparent;font-size:0}',
  'video,audio{max-width:100%}',
  '[hidden]{display:none!important}',
].join('\n');

/**
 * 生成预览文档。
 * @param {string} html    站点返回的原始 HTML（已按声明字符集解码成文本）
 * @param {string} baseUrl 该页面的最终地址，作为 <base href>
 * @param {object} meta    { jobUrl, truncated }
 */
export function buildPreview(html, baseUrl, meta) {
  const info = meta || {};
  let doc = String(html || '');

  doc = doc
    .replace(SCRIPT_RE, '')
    .replace(IFRAME_RE, '')
    .replace(FRAME_RE, '')
    .replace(OBJECT_RE, '')
    .replace(NOSCRIPT_RE, '')
    .replace(BASE_RE, '')
    .replace(HTTP_EQUIV_RE, '')
    .replace(CHARSET_META_RE, '')
    .replace(LINK_STRIP_RE, '');

  const patch = [
    '<meta charset="utf-8">',
    '<base href="' + attr(baseUrl) + '">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex,nofollow,noarchive">',
    '<meta name="idv:source" content="' + attr(info.jobUrl || baseUrl) + '">',
    '<meta name="idv:truncated" content="' + (info.truncated ? '1' : '0') + '">',
    '<style id="idv-patch">' + PATCH_CSS + '</style>',
  ].join('');

  const headOpen = /<head\b[^>]*>/i.exec(doc);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    doc = doc.slice(0, at) + patch + doc.slice(at);
  } else {
    const htmlOpen = /<html\b[^>]*>/i.exec(doc);
    if (htmlOpen) {
      const at = htmlOpen.index + htmlOpen[0].length;
      doc = doc.slice(0, at) + '<head>' + patch + '</head>' + doc.slice(at);
    } else {
      doc = '<!doctype html><html lang="zh-CN"><head>' + patch + '</head><body>' + doc + '</body></html>';
    }
  }
  if (!/<!doctype/i.test(doc.slice(0, 400))) doc = '<!doctype html>' + doc;
  return doc;
}

/** 非 HTML 的文档（PDF / 图片 / 音视频）把原始字节交回浏览器自己渲染 */
export function passthroughType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct) return 'text/html';
  if (/html|xhtml|xml/.test(ct)) return 'text/html';
  if (/(^image|^video|^audio|pdf)/.test(ct)) return ct.split(';')[0].trim();
  return '';
}

/** 预览页清单：主页面 + 站内顺带扫描到的页面 */
export function previewPages(job) {
  const result = (job && (job.result || job.partial)) || {};
  const pages = Array.isArray(result.pages) && result.pages.length ? result.pages : [];
  const list = pages.map((pg, i) => ({
    index: i,
    url: pg.url || (job && job.url),
    title: pg.title || (pg.main ? '主页面' : ''),
    main: !!pg.main || pg.url === job.url,
    resources: pg.resources || 0,
    text: pg.text || 0,
  }));
  if (!list.some((pg) => pg.main)) {
    list.unshift({
      index: -1, url: job.url, main: true, resources: 0, text: 0,
      title: (result.doc && result.doc.title) || '主页面',
    });
  }
  const mi = list.findIndex((pg) => pg.main);
  if (mi > 0) list.unshift(list.splice(mi, 1)[0]);   /* 主页面永远排第一 */
  return list;
}
