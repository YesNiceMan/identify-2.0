/**
 * 预览叠加层的「地址对上号」逻辑：把扫描结果里的每一项映射回页面 DOM 中的元素。
 *
 * 写成纯函数（不碰 DOM），于是 scripts/selftest.mjs 能在 Node 里拿服务端的
 * normalizeUrl / lazy-attrs 做对照断言，防止前后端两套解析漂移。
 */

/** 与 server/lazy-attrs.mjs 同一张表（浏览器不能 import server/，故保留镜像，自检逐字比对） */
export const LAZY_ATTR_RE = /^data[-_]?[a-z0-9_-]*?(?:src|srcset|url|uri|image|img|thumb|thumbnail|poster|background|bg|file|download|href|media|video|audio|movie|clip|sound|mp4|mp3|webm|original|orig|lazy|lazyload|echo|preview|cover|full|large|zoom|lightbox|gallery|source|path|attach)(?:[-_]?(?:set|s|2x|1x))?$/i;

/** 明确承载地址的属性（与 server/extract.mjs 的 URL_ATTR_OK 对齐） */
export const URL_ATTRS = ['src', 'href', 'poster', 'data', 'background', 'xlink:href', 'movie', 'codebase', 'formaction'];
export const SRCSET_ATTRS = ['srcset', 'imagesrcset'];
/** 值里可能藏 url() 的属性 */
export const STYLE_ATTRS = ['style'];

const SKIP_RE = /^(?:javascript|vbscript|mailto|tel|callto|sms|blob|about)\s*:/i;

/** 与 server/net.mjs normalizeUrl 同构：解析 → 仅收 http(s) → 去 hash */
export function absKey(raw, base) {
  const s = String(raw == null ? '' : raw).trim().replace(/^[\s"']+|[\s"']+$/g, '');
  if (!s || SKIP_RE.test(s)) return '';
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

/** 与解析器合并内联地址时同一把键（extract.mjs parseDataUri + mergeResources） */
export function dataKey(raw) {
  const rest = String(raw || '').slice(5);
  const comma = rest.indexOf(',');
  if (comma < 0 || comma > 220) return '';
  const metaPart = rest.slice(0, comma);
  const mime = (metaPart.split(';')[0] || '').trim().toLowerCase();
  const base64 = /;base64/i.test(metaPart);
  if (!base64 && !mime) return '';   /* 与服务端 parseDataUri 同一道门槛 */
  const data = rest.slice(comma + 1).replace(/\s+/g, '');
  if (data.length < 8) return '';
  return 'data::' + (mime || 'application/octet-stream') + '::' + data.slice(0, 200);
}

/** 一个属性值 → 可用于查表的键 */
export function keyOf(raw, base) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^data:/i.test(s)) return dataKey(s);
  return absKey(s, base);
}

/** srcset 切分（与解析器同一套规则：URL 取到第一个空白，描述符取到下一个逗号） */
export function parseSrcset(value) {
  const raw = String(value || '');
  const out = [];
  let i = 0;
  let guard = 0;
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (i < raw.length && guard++ < 200) {
    while (i < raw.length && (ws(raw[i]) || raw[i] === ',')) i++;
    if (i >= raw.length) break;
    let url = '';
    while (i < raw.length && !ws(raw[i])) {
      const c = raw[i];
      if (c === ',') {
        const keep = /^data:/i.test(url) || (/[?&;]/.test(url) && !/[(),]/.test(url));
        if (!keep) break;
      }
      url += c; i++;
    }
    url = url.replace(/,+$/, '');
    let desc = '';
    let depth = 0;
    let quote = '';
    while (i < raw.length) {
      const c = raw[i];
      if (quote) { desc += c; if (c === quote) quote = ''; i++; continue; }
      if (c === '"' || c === "'") { quote = c; desc += c; i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) break;
      desc += c; i++;
    }
    if (!url) continue;
    const bits = desc.trim().split(/\s+/).filter(Boolean);
    let density = 0;
    let width = 0;
    for (const d of bits) {
      const m = /^(\d*\.?\d+)([wx])$/i.exec(d);
      if (!m) continue;
      if (m[2].toLowerCase() === 'x') density = Number(m[1]);
      else width = Number(m[1]);
    }
    out.push({ url, density, width });
    if (i >= raw.length) break;
  }
  return out;
}

/** 一段 CSS 文本里的 url(...) 与 image-set() 候选 */
export function cssUrls(cssText) {
  const out = [];
  const text = String(cssText || '');
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 200) {
    const raw = m[2].trim();
    if (!raw || raw.charAt(0) === '#' || /^local\(/i.test(raw)) continue;
    out.push(raw);
  }
  const is = /image-set\(([^)]*)\)/gi;
  while ((m = is.exec(text)) && guard++ < 220) {
    for (const piece of m[1].split(',')) {
      const q = /^\s*(['"])([^'"]+)\1/.exec(piece);
      if (q) out.push(q[2]);
    }
  }
  return out;
}

/** 计算样式里的背景 / 遮罩 / 边框图（这些资源在 DOM 上没有属性可查，只能读 computed style） */
export function computedCssUrls(style) {
  if (!style) return [];
  const out = [];
  const props = ['background-image', 'border-image-source', 'mask-image', '-webkit-mask-image', 'list-style-image', 'cursor'];
  for (const prop of props) {
    let v = '';
    try { v = typeof style.getPropertyValue === 'function' ? style.getPropertyValue(prop) : style[prop]; } catch { v = ''; }
    if (v && v !== 'none' && v.indexOf('url(') >= 0) out.push.apply(out, cssUrls(v));
  }
  return out;
}

/**
 * 一个元素的候选地址键集合。
 * @param {Array<[string,string]>} pairs 属性名 / 属性值
 * @param {string} base 文档基准地址（即注入的 <base href>）
 */
export function elementKeys(pairs, base) {
  const keys = [];
  const push = (v) => {
    const s = String(v == null ? '' : v).trim();
    /* 纯锚点解析后就是文档自身地址，不该冒充资源 */
    if (s.charAt(0) === '#') return;
    const k = keyOf(s, base);
    if (k && keys.indexOf(k) < 0) keys.push(k);
  };
  for (const pair of pairs || []) {
    const name = pair[0];
    const value = pair[1];
    if (!value) continue;
    const n = String(name).toLowerCase();
    if (SRCSET_ATTRS.indexOf(n) >= 0) { for (const c of parseSrcset(value)) push(c.url); continue; }
    if (URL_ATTRS.indexOf(n) >= 0 || LAZY_ATTR_RE.test(n)) { push(value); continue; }
    if (STYLE_ATTRS.indexOf(n) >= 0) { for (const u of cssUrls(value)) push(u); continue; }
    if (/^data-/i.test(n) && /\.(png|jpe?g|webp|avif|gif|svg|mp4|webm|mov|m4a|mp3|wav|pdf|zip|docx?|xlsx?|pptx?)($|[?#])/i.test(value)) push(value);
  }
  return keys;
}

/* ------------------------------------------------------- 文案块口径 */

export function normText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

export function blockKey(tag, text) {
  return String(tag || '').toLowerCase() + '|' + normText(text).slice(0, 220);
}

/** 只算直接文本 + 内联后代文本：与解析器逐块收集文案的口径一致 */
export const INLINE_TAGS = ['a', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'code', 'kbd', 'samp', 'var',
  'sub', 'sup', 'mark', 'time', 'abbr', 'q', 'cite', 'label', 'font', 'big', 'tt', 'ins', 'del', 'nobr', 'output', 'data'];

/* ------------------------------------------------------- 矩形与相交 */

export function box(left, top, width, height) {
  return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height };
}

/** 矩形 a 有多少比例落在矩形 b 内 —— 区域框选时判定「这个资源属不属于这一块」 */
export function overlap(a, b) {
  const area = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  if (!area) return 0;
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / area;
}

/* ============================================================ 扫描区域
 * 以下常量与 regionStep 是 server/region.mjs 的**逐字镜像**（浏览器不能 import server/），
 * scripts/selftest.mjs 会比对两边的正则源码与判定结果，防止漂移。
 * 用途：页面预览里把页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件标成「不在扫描范围」的色块。
 */

export const REGION_KINDS = {
  header: '页眉',
  nav: '导航菜单',
  footer: '页脚',
  aside: '侧栏',
  form: '表单 / 搜索',
  widget: '推广 / 分享 / 订阅',
};

export const REGION_TAGS = {
  header: 'header',
  nav: 'nav',
  footer: 'footer',
  aside: 'aside',
};

export const REGION_ROLES = {
  banner: 'header',
  navigation: 'nav',
  menubar: 'nav',
  tablist: 'nav',
  contentinfo: 'footer',
  complementary: 'aside',
  search: 'form',
  dialog: 'widget',
};

export const MAINISH_TAGS = ['main', 'article'];
export const MAINISH_ROLES = ['main'];
export const SECTIONING_TAGS = ['main', 'article', 'section', 'aside', 'nav', 'td', 'th', 'li', 'figure', 'blockquote', 'details', 'dialog', 'fieldset'];

export const MAIN_HINT_RE = /(?:^|[^a-z0-9])(?:main|main-?content|main-?area|content|page-?content|entry(?:[-_](?:content|body|text|detail|title))?|article(?:[-_](?:body|content|text))?|post(?:[-_](?:body|content|text))?|story(?:[-_](?:body|text))?|prose|document?-body|sheet-content|attachment-?body)(?:[^a-z0-9]|$)/i;

export const SUBORDINATE_RE = /(?:content|entry|post|article|story|item|card|panel|pane|block|media|figure|table|field|cell|doc|text|body|thread|comment|attachment|gallery|slide)(?:[-_])(?:header|footer|head|foot|title|meta|bar|top|bottom|actions|tools|caption|info)(?:[-_](?:wrap|inner|area|box|row|line|text))?/gi;

export const REGION_HINTS = [
  ['nav', /(?:^|[^a-z0-9])(?:nav|navbar|navi|navigation|menu|menubar|main-?menu|top-?menu|sub-?nav|side-?nav|sidenav|top-?nav|tab-?bar|tabbar|tool-?bar|toolbar|breadcrumb|breadcrumbs|crumbs|pagination|pager|jump-?menu)(?:[^a-z0-9]|$)/i],
  ['header', /(?:^|[^a-z0-9])(?:masthead|site-?header|page-?header|global-?header|header|topbar|top-?bar|app-?bar|appbar|hdr)(?:[^a-z0-9]|$)/i],
  ['footer', /(?:^|[^a-z0-9])(?:site-?footer|page-?footer|footer|foot-?bar|bottom-?bar|bottombar|copyright|colophon|legal|footnotes?|disclaimer)(?:[^a-z0-9]|$)/i],
  ['aside', /(?:^|[^a-z0-9])(?:sidebar|side-?bar|side-?panel|widget(?:[-_]?area|s)?|aside|rail|right-?rail|left-?rail|toc|table-?of-?contents|mini-?nav)(?:[^a-z0-9]|$)/i],
  ['form', /(?:^|[^a-z0-9])(?:search|search-?(?:form|box|bar)|login|log-?in|signin|sign-?in|signup|sign-?up|register|subscribe|subscription|newsletter|comment-?(?:form|box|area)|contact-?form|filters?)(?:[^a-z0-9]|$)/i],
  ['widget', /(?:^|[^a-z0-9])(?:cookie|consent|gdpr|age-?gate|paywall|popup|modal|drawer|toast|advert|advert-?ising|ads|adsbygoogle|ad-?(?:slot|unit|banner)|sponsor|promo|promotion|share|social|follow-?us|related|recommended|read-?more|app-?download|install-?banner|lang(?:uage)?-?(?:switch|menu)|back-?to-?top|scroll-?top|live-?chat|chat-?widget|sticky-?(?:bar|cta)?)(?:[^a-z0-9]|$)/i],
];

export const REGION_ROOTS = [
  ['nav', ['nav', 'navbar', 'navigation', 'navi', 'menu', 'menubar', 'breadcrumb', 'breadcrumbs', 'crumb', 'pagination', 'tabbar', 'toolbar', 'tablist']],
  ['header', ['header', 'masthead', 'topbar', 'appbar', 'hdr', 'headbar']],
  ['footer', ['footer', 'bottombar', 'copyright', 'colophon', 'footbar']],
  ['aside', ['sidebar', 'sidepanel', 'aside']],
  ['widget', ['popup', 'modal', 'consent', 'cookie', 'advert', 'adsbygoogle', 'sponsor']],
];

const WORD_SPLIT = /[^a-z0-9]+/;

export function compoundKind(hint) {
  const words = String(hint || '').toLowerCase().split(WORD_SPLIT).filter((w) => w.length > 3);
  for (const pair of REGION_ROOTS) {
    const roots = pair[1];
    for (const w of words) {
      for (const r of roots) {
        if (w.length > r.length && (w.endsWith(r) || w.startsWith(r))) return pair[0];
      }
    }
  }
  return '';
}

export const REGION_ROOT = { zone: 'content', kind: '', sub: false, core: false, soft: false };

export function hintKind(hint) {
  const s = String(hint || '').replace(SUBORDINATE_RE, ' ');
  if (!s.trim()) return '';
  for (const pair of REGION_HINTS) if (pair[1].test(s)) return pair[0];
  return compoundKind(s);
}

export function regionStep(prev, frame) {
  const st = prev || REGION_ROOT;
  const tag = String((frame && frame.tag) || '').toLowerCase();
  const role = String((frame && frame.role) || '').toLowerCase();
  const hint = String((frame && frame.hint) || '');
  if (!tag || tag === 'html' || tag === 'body' || tag === '#document') return st;

  const isRoot = tag === 'main' || MAINISH_ROLES.indexOf(role) >= 0;
  const mainTag = isRoot || tag === 'article';
  let landmark = mainTag ? '' : (REGION_TAGS[tag] || REGION_ROLES[role] || '');
  let named = landmark || mainTag ? '' : hintKind(hint);
  /* 章节例外：<header>/<footer> 只有不落进别的章节块时才算页眉 / 页脚地标。
     <main> 是整页正文根、本身不算章节，所以「整页被 main 包住」的站点照样能认出页脚；
     而 <article>/<section>/<li> 里的 header 只是这一块的抬头，留在正文里。 */
  if (st.sub && (landmark === 'header' || landmark === 'footer')) landmark = '';
  if (st.sub && (named === 'header' || named === 'footer')) named = '';
  /* 正文护栏：已经进了正文容器，光凭命名证据不再把它判成正文之外（地标证据仍然生效） */
  if (named && st.core) named = '';
  /* 命名线索只用于「还没定性」的地方：绝不把正文外拉回正文，也不把正文压成噪音 */
  const mainHint = !landmark && !named && !mainTag && st.zone !== 'noise' && MAIN_HINT_RE.test(hint);
  const sectioning = SECTIONING_TAGS.indexOf(tag) >= 0;
  const sub = isRoot ? false : !!(st.sub || sectioning || landmark || named);
  if (isRoot) return { zone: 'main', kind: '', sub: false, core: true, soft: false };
  if (mainTag) return { zone: 'main', kind: '', sub: sub, core: true, soft: false };
  if (landmark) return { zone: 'noise', kind: landmark, sub: sub, core: st.core, soft: false };
  if (named) return { zone: 'noise', kind: named, sub: sub, core: st.core, soft: true };
  if (mainHint) return { zone: 'main', kind: '', sub: sub, core: true, soft: false };
  return { zone: st.zone, kind: st.kind, sub: sub, core: st.core, soft: !!st.soft };
}

export function regionOf(state) {
  const st = state || REGION_ROOT;
  return { zone: st.zone || 'content', kind: st.kind || '', soft: !!(st.zone === 'noise' && st.soft) };
}

export function regionLabel(kind) {
  return REGION_KINDS[kind] || '界面框架区域';
}

/** 一个真实 DOM 元素的区域结论（沿祖先链步进；根 -> 叶） */
export function regionOfElement(node) {
  let st = REGION_ROOT;
  const chain = [];
  for (let p = node; p && p.nodeType === 1; p = p.parentElement) chain.push(p);
  chain.reverse();
  for (const e of chain) {
    st = regionStep(st, {
      tag: String(e.tagName || '').toLowerCase(),
      role: (e.getAttribute && e.getAttribute('role')) || '',
      hint: (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : (e.getAttribute && e.getAttribute('class')) || ''),
    });
  }
  return regionOf(st);
}