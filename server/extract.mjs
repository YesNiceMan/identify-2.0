/**
 * HTML → 结构化资源清单 + 文案块（零依赖 HTML 解析器）
 *
 * 覆盖面：
 *   标签属性   src / srcset（含 w·x 描述符）/ poster / data / background / xlink:href / formaction
 *   懒加载     data-src · data-original · data-lazy-src · data-bg · data-echo · data-thumbnail …
 *              以及任何「名字暗示资源 + 取值带已知扩展名」的属性
 *   样式       <style> · style="" · CSS url() · image-set() · CSS 自定义属性 · @import（含无引号写法）
 *              并记录每条 url 的选择器上下文与 @font-face 归属，供扫描策略判定界面装饰
 *   脚本与数据 内联脚本裸链接 · key:"value" 对 · 完整 JSON 递归遍历 · application/ld+json
 *   其他       noscript（按真实 HTML 递归解析）· srcdoc（递归解析）· meta(og: / twitter: / itemprop /
 *              msapplication) · link rel(icon / preload as=…) · data URI · <a href|download>
 *
 * 扫描区域：每个元素沿祖先链步进一次 regionStep（见 server/region.mjs），得出它落在
 * 主体内容区（main / content）还是非内容区（noise：页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件）。
 * 结论写到文案块（zone / zoneKind）与资源引用（zone / zoneKind）上，扫描策略据此实现
 * 「只扫描主体内容区」；样式表、脚本、正文裸链接这类页面级来源永远记 content，不因位置被排除。
 */
import { classify, extFromPath, typeFromExt, typeFromMime, TYPES, KNOWN_EXT_SOURCE } from './mime.mjs';
import { urlMeta, compactUrlMeta } from './urlmeta.mjs';
import { normalizeUrl } from './net.mjs';
import { regionStep, regionOf, kindsLabel, mergeZone } from './region.mjs';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'textarea', 'title']);
const OPAQUE = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'video', 'audio', 'head']);
const BLOCK_TEXT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'blockquote', 'figcaption',
  'caption', 'td', 'th', 'pre', 'address', 'summary', 'option', 'label', 'article', 'section', 'aside', 'main', 'div', 'a']);
const INLINE = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'code', 'kbd', 'samp', 'var', 'sub', 'sup',
  'mark', 'time', 'abbr', 'q', 'cite', 'label', 'font', 'big', 'tt', 'ins', 'del', 'nobr', 'output', 'data']);
const HEADING_LIKE = /^h([1-6])$/;
/* 区域判定（页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件 vs 主体内容区）统一在 server/region.mjs */
const IMPLICIT = {
  p: ['p'], li: ['li', 'p'], dt: ['dt', 'dd', 'p'], dd: ['dt', 'dd', 'p'],
  td: ['td', 'th', 'p'], th: ['td', 'th', 'p'], tr: ['tr', 'td', 'th', 'p'], option: ['option', 'optgroup', 'p'],
  h1: ['p'], h2: ['p'], h3: ['p'], h4: ['p'], h5: ['p'], h6: ['p'],
};

/** 明确承载地址的属性 */
const URL_ATTR_OK = /^(src|href|poster|data|xlink:href|background|srcset|imagesrcset|movie|codebase|formaction)$/i;
/** 懒加载 / 框架写法里的 data-* 属性（与扫描策略共用一份表） */
import { LAZY_ATTR_RE } from './lazy-attrs.mjs';
/** 名字暗示「这是个资源」的其它属性（取值需带已知扩展名才采纳） */
const HINT_ATTR_RE = /(?:^|[-:._])(?:src|href|url|uri|image|img|thumb|poster|cover|bg|background|file|download|media|source|movie|clip|video|audio|sound|avatar|icon|logo|gallery|zoom|original|preview|attachment|path)$/i;
/** 永远不当作地址的属性 */
const NOT_URL_ATTR = new Set(['class', 'id', 'style', 'alt', 'title', 'rel', 'type', 'sizes', 'media', 'width', 'height',
  'name', 'property', 'itemprop', 'dir', 'lang', 'role', 'target', 'charset', 'content', 'datetime', 'cite', 'span',
  'colspan', 'rowspan', 'value', 'pattern', 'placeholder', 'aria-label', 'aria-describedby', 'aria-labelledby', 'usemap',
  'shape', 'coords', 'shape-rendering', 'srcdoc']);

const LOOSE_URL_RE = new RegExp(
  '(?:https?:)?\\/\\/[^\\s"\'()<>|\\\\^{}*]+'
  + '|[A-Za-z0-9_.\\-/~%+:]+\\.(?:' + KNOWN_EXT_SOURCE + ')(?:[?#][^\\s"\'<>]*)?', 'gi');

const JSON_MEDIA_KEY_RE = /(?:^|[^a-z])(?:src|srcset|href|url|uri|image|images|img|thumb|thumbnail|poster|cover|avatar|logo|icon|background|bg|file|files|filepath|download|downloads|media|video|videos|audio|sound|movie|clip|source|sources|attachment|attachments|preview|gallery|lightbox|zoom|full|large|original|contenturl|thumbnailurl|imageurl|embedurl|streamurl|videourl|audiourl|ogimage|link|path)(?:$|[^a-z])/i;

export function extractPage(html, baseUrl) {
  const ctx = newContext(baseUrl);
  walkDocument(html, ctx, { text: true });

  /* 全文兜底：剥掉标签与脚本，只留正文里裸露的地址（页面级来源，不带区域） */
  ctx.rstate = null;
  ctx.pageLevel = true;
  const prose = String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  collectLooseUrls(unescapeJsUrls(prose), baseUrl, ctx, 0, 'document');

  const resources = mergeResources(ctx.resources);
  const blocks = ctx.blocks.sort((a, b) => a.order - b.order);
  const seen = new Set();
  const unique = [];
  for (const b of blocks) {
    const key = b.tag + '|' + b.text;
    if (seen.has(key)) continue;
    seen.add(key);
    b.id = 't' + (unique.length + 1);
    unique.push(b);
  }
  return {
    doc: ctx.doc,
    headings: ctx.headings.slice(0, 300),
    links: dedupeLinks(ctx.links).slice(0, 500),
    resources,
    textBlocks: unique,
    keywords: topKeywords(unique.filter((b) => b.zone !== 'noise').map((b) => b.text).join(' ')),
    stats: { htmlBytes: Buffer.byteLength(html, 'utf-8'), blocks: unique.length, tokens: ctx.tokens },
    regions: regionSummary(resources, unique),
  };
}

/** 单独解析一段 CSS（供深度扫描递归引用） */
export function extractCss(cssText, cssUrl) {
  const ctx = newContext(cssUrl);
  ctx.pageLevel = true;   /* 外链样式表不属于任何版面区域，永不按位置排除 */
  collectCssUrls(String(cssText || ''), cssUrl, ctx, { tag: 'style', attr: 'css-file', line: 0 });
  return mergeResources(ctx.resources);
}

function newContext(baseUrl) {
  return {
    baseUrl,
    rstate: null,          // 当前元素的区域状态（regionStep 逐步推进）
    rseed: null,           // 递归片段（noscript / srcdoc）继承的外层状态
    pageLevel: false,      // 页面级来源（外链 CSS / 脚本 / 正文裸链接）不参与区域排除
    resources: [],
    blocks: [],
    headings: [],
    links: [],
    seq: 0,
    nest: '',
    tokens: 0,
    doc: { title: '', description: '', keywords: '', lang: '', charset: '', canonical: '', ogImage: '', generator: '', themeColor: '', favicon: '', base: '', imageCount: 0 },
  };
}

function addRef(ctx, ref) {
  if (ctx.nest && ref.attr) ref.attr = ctx.nest + ref.attr;
  if (ref.zone === undefined) {
    const reg = regionOf(ctx.pageLevel ? null : ctx.rstate);
    ref.zone = reg.zone;
    ref.zoneKind = ctx.pageLevel ? '' : reg.kind;
    ref.zoneSoft = ctx.pageLevel ? false : !!reg.soft;
  }
  if (ref.url && !ref.dataUri && ref.cdn === undefined) {
    const m = urlMeta(ref.url);
    const cm = compactUrlMeta(m);
    ref.cdn = Object.keys(cm).length ? cm : null;
    /** 图片代理（Next.js 优化器 / weserv / Photon）：真正的内容在内层地址里 */
    if (m.inner && !ref.noInner) {
      addRef(ctx, Object.assign({}, ref, {
        url: m.inner, noInner: true, cdn: undefined,
        attr: String(ref.attr || 'src') + '→内层',
        viaProxy: ref.url,
      }));
    }
  }
  ctx.resources.push(ref);
}

function top(stack) { return stack.length ? stack[stack.length - 1] : null; }

function hasOpaque(stack) {
  for (const s of stack) if (s.opaque) return true;
  return false;
}

/* --------------------------------------------- 文档遍历（可递归嵌套） */

function walkDocument(html, ctx, opts) {
  const options = opts || {};
  const tokens = tokenize(html);
  ctx.tokens += tokens.length;
  const lineStarts = buildLineIndex(html);
  const lineOf = (offset) => (options.line || 0) || lineFor(lineStarts, offset);
  const stack = [];

  for (const tok of tokens) {
    if (tok.type === 'start') {
      const implicit = IMPLICIT[tok.name];
      if (implicit) {
        while (stack.length && implicit.includes(top(stack).name)) flush(ctx, stack.pop(), stack);
      }
      frameStart(ctx, stack, tok, lineOf);
      if (!VOID.has(tok.name) && !tok.selfClosing) {
        stack.push({ name: tok.name, attrs: tok.attrs, start: tok.start, raw: tok.raw, direct: [], opaque: OPAQUE.has(tok.name), line: lineOf(tok.start), rstate: ctx.rstate });
      }
      if (stack.length > 250) { while (stack.length) flush(ctx, stack.pop(), stack); }
    } else if (tok.type === 'raw') {
      frameRaw(ctx, tok, lineOf);
    } else if (tok.type === 'end') {
      let found = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === tok.name) { found = i; break; }
      if (found >= 0) {
        while (stack.length - 1 > found) flush(ctx, stack.pop(), stack);
        flush(ctx, stack.pop(), stack);
      }
    } else if (tok.type === 'text') {
      if (options.text === false) continue;
      const node = top(stack);
      if (node && !node.opaque && !hasOpaque(stack)) node.direct.push(tok.value);
    }
  }
  while (stack.length) flush(ctx, stack.pop(), stack);
  return ctx.resources.length;
}

/* ------------------------------------------------------------ 标签处理 */

function frameStart(ctx, stack, tok, lineOf) {
  const lower = tok.name;
  const get = (n) => attrValue(tok.attrs, n);
  const base = ctx.baseUrl;
  const doc = ctx.doc;
  const line = lineOf(tok.start);
  const parentTag = (top(stack) || {}).name || '';

  /* 区域状态：父元素状态 + 本元素的标签 / role / id·class（region.mjs） */
  ctx.rstate = regionStep((top(stack) || {}).rstate || ctx.rseed, {
    tag: lower,
    role: get('role') || '',
    hint: (get('id') || '') + ' ' + (get('class') || ''),
  });

  /* <base href> 之后所有相对地址都改用它作基准 */
  if (lower === 'base') {
    const href = normalizeUrl(get('href'), ctx.baseUrl);
    if (href) { ctx.baseUrl = href; doc.base = href; }
    return;
  }
  const context = '<' + lower + ' ' + String(tok.raw || '').replace(/\s+/g, ' ').slice(0, 220);

  if (lower === 'html') doc.lang = get('lang') || doc.lang;

  /* style="width:24px" 这类内联声明也算「作者说这有多大」，在属性循环之前补进去 */
  const styleSize = get('style') ? declaredPx(get('style')) : null;
  if (styleSize) {
    if (styleSize.w && !get('width')) tok.attrs.push({ name: 'width', value: String(styleSize.w) });
    if (styleSize.h && !get('height')) tok.attrs.push({ name: 'height', value: String(styleSize.h) });
  }

  for (const a of tok.attrs) {
    const name = a.name;
    const value = String(a.value || '').trim();
    if (!value) continue;
    if (name === 'srcdoc') continue;                       // 交给下面的递归解析
    if (name === 'content' && lower === 'meta') continue;   // meta 走专用分支
    if (name === 'cite') continue;
    if (name === 'href' && lower === 'a') continue;         // <a> 走专用分支
    if (lower === 'link' && /preconnect|dns-prefetch|pingback|shortlink|author|publisher|edituri|wlmanifest/i.test(get('rel'))) continue;
    if (name === 'background' && !/[?].*=|\.[a-z0-9]{2,5}($|[?#])/i.test(value)) continue;

    if (value.startsWith('#') || value.startsWith('javascript:') || value.startsWith('about:') || value.startsWith('blob:')) continue;
    const direct = URL_ATTR_OK.test(name) || LAZY_ATTR_RE.test(name);
    const hinted = !direct && !NOT_URL_ATTR.has(name) && HINT_ATTR_RE.test(name)
      && (hasKnownExt(value) || looksVisual(value, base));
    if (!direct && !hinted) continue;
    if (NOT_URL_ATTR.has(name) && !direct) continue;

    const hint = hintFromTag(lower, name, get, parentTag);

    if (/srcset$/i.test(name)) {
      for (const cand of parseSrcset(value)) {
        if (isDataUri(cand.url)) {
          const parsed = parseDataUri(cand.url);
          if (parsed) addRef(ctx, { dataUri: parsed, tag: lower, attr: name, provenance: 'datauri', hint, line, density: cand.density, declaredWidth: cand.width });
          continue;
        }
        const u = normalizeUrl(cand.url, base);
        if (!u) continue;
        addRef(ctx, {
          url: u, tag: lower, attr: name, provenance: 'attr', hint, line,
          density: cand.density, declaredWidth: cand.width, context,
          widthHint: get('width'), heightHint: get('height'),
          alt: get('alt') || get('title') || get('aria-label'),
        });
      }
      continue;
    }

    if (isDataUri(value)) {
      const parsed = parseDataUri(value);
      if (parsed) addRef(ctx, { dataUri: parsed, tag: lower, attr: name, provenance: 'datauri', hint, context, line });
      continue;
    }

    const u = normalizeUrl(value, base);
    if (!u) continue;
    if (!direct) {
      const ext = extFromPath(safePath(u));
      if (!ext || !typeFromExt(ext)) continue;
    }
    addRef(ctx, {
      url: u, tag: lower, attr: name, provenance: 'attr', hint, line,
      widthHint: get('width'), heightHint: get('height'), context,
      alt: get('alt') || get('title') || get('aria-label'),
    });
  }

  const styleAttr = get('style');
  if (styleAttr) collectCssUrls(styleAttr, base, ctx, { tag: lower, attr: 'style', line });

  /* data-config='{"poster":"a.mp4"}' 这类把资源地址塞在 JSON 属性里的写法 */
  for (const a of tok.attrs) {
    if (!/^data-/i.test(a.name)) continue;
    const v = String(a.value || '').trim();
    if (v.length < 12 || (v[0] !== '{' && v[0] !== '[')) continue;
    if (!/\.(jpe?g|png|webp|avif|gif|svg|mp4|webm|m4v|mov|m4a|mp3|wav|pdf|zip|docx?|xlsx?)/i.test(v)) continue;
    collectJsonUrls(unescapeJsUrls(v), base, ctx, line, 'data-attr');
  }

  const srcdoc = get('srcdoc');
  if (srcdoc && srcdoc.length < 400000) {
    const prev = ctx.nest;
    const prevSeed = ctx.rseed;
    ctx.nest = 'srcdoc:';
    ctx.rseed = ctx.rstate;
    walkDocument(decodeEntities(srcdoc), ctx, { text: false, line });
    ctx.nest = prev;
    ctx.rseed = prevSeed;
  }

  if (lower === 'meta') {
    const name = (get('name') || get('property') || get('itemprop') || '').toLowerCase();
    const content = get('content');
    if (get('charset')) doc.charset = get('charset').toLowerCase();
    else if (name === 'description') doc.description = content;
    else if (name === 'keywords') doc.keywords = content;
    else if (name === 'generator') doc.generator = content;
    else if (name === 'theme-color') doc.themeColor = content;
    else if (name === 'charset') doc.charset = content;
    else if (name === 'content-type') {
      const m = /charset=([\w-]+)/i.exec(content);
      if (m) doc.charset = m[1];
    } else if (/^(?:og:)?image(?::(?:url|secure_url))?$|^og:video(?::(?:url|secure_url))?$|^og:audio(?::(?:url|secure_url))?$|^twitter:image(?::(?:src|secure_url))?$|^twitter:player(?::stream)?$|^(?:image|thumbnailurl|contenturl|embedurl|url|logo|audio|video)$/.test(name)) {
      if (content) {
        if (/^og:image/i.test(name)) doc.ogImage = doc.ogImage || content;
        const u = normalizeUrl(content, base);
        if (u) {
          let hint = null;
          if (/video|player/.test(name)) hint = 'video';
          else if (/audio/.test(name)) hint = 'audio';
          else if (/image|thumb|logo|^url$/.test(name)) hint = /logo/.test(name) ? 'icon' : 'image';
          addRef(ctx, { url: u, tag: 'meta', attr: 'meta:' + name, provenance: 'attr', hint, line, metaKey: name, context: '<meta ' + name + '>' });
        }
      }
    } else if (/msapplication-(tileimage|square\d+logo|wide\d+logo|smalllogo|largelogo)/i.test(name) && content) {
      const u = normalizeUrl(content, base);
      if (u) addRef(ctx, { url: u, tag: 'meta', attr: 'meta:' + name, provenance: 'attr', hint: 'icon', line, metaKey: name });
    }
  } else if (lower === 'link') {
    const rel = get('rel').toLowerCase();
    if (/icon/i.test(rel)) {
      const href = normalizeUrl(get('href'), base);
      if (href) {
        if (/(^|\s)(icon|shortcut icon)(\s|$)/.test(rel)) doc.favicon = href;
        else if (!doc.favicon) doc.favicon = href;
        doc.icons = (doc.icons || []).concat([{ rel, href }]);
      }
    }
    if (/(^|\s)canonical(\s|$)/.test(rel)) doc.canonical = normalizeUrl(get('href'), base) || doc.canonical;
  } else if (lower === 'a') {
    const href = get('href');
    const u = href ? normalizeUrl(href, base) : null;
    if (u) {
      const ext = extFromPath(safePath(u));
      const byExt = ext ? typeFromExt(ext) : null;
      const isAsset = !!byExt || !!get('download') || /\.(pdf|zip|docx?|xlsx?|csv|mp4|mp3|exe|dmg|iso|epub)($|[?#])/i.test(u);
      const node = top(stack);
      const ref = { url: u, text: '', asset: !!isAsset, line };
      if (isAsset) {
        addRef(ctx, {
          url: u, tag: 'a', attr: get('download') ? 'a[download]' : 'href', provenance: 'attr',
          hint: byExt || 'document', line, context, alt: get('title') || get('aria-label'),
        });
      }
      ctx.links.push(ref);
      if (node) node.linkRef = ref;
    }
  }
}

function frameRaw(ctx, tok, lineOf) {
  const base = ctx.baseUrl;
  const line = lineOf(tok.start);
  if (tok.name === 'style') {
    /* 内联样式表就在这一处，位置即区域：写在 <footer> 里的背景图同样算「正文之外」。
       外链样式表另说——extractCss() 把 pageLevel 置真，整份文件都不按位置排除。 */
    collectCssUrls(tok.value, base, ctx, { tag: 'style', attr: 'css', line });
    return;
  }
  if (tok.name === 'title') {
    ctx.doc.title = cleanText(tok.value).slice(0, 300);
    return;
  }
  if (tok.name === 'script') {
    const prevState = ctx.rstate;
    ctx.rstate = null;         /* 脚本里的数据岛描述整页，不按所在位置排除 */
    const code = unescapeJsUrls(tok.value);
    const isStructured = /type\s*=\s*["'](?:application|text)\/json/i.test(tok.raw || '') || /^\s*[[{]/.test(code);
    collectLooseUrls(code, base, ctx, line, 'script');
    collectJsonUrls(code, base, ctx, line, isStructured ? 'ld+json' : 'json');
    const pair = /\b(?:url|src|srcset|uri|image|images|img|poster|cover|thumb|thumbnail|file|files|filepath|downloadurl|download|background|bg|avatar|logo|icon|media|video|audio|movie|clip|original|preview|href|path)\b["']?\s*[:=]\s*["']([^"']{6,700})["']/gi;
    let m;
    let guard = 0;
    while ((m = pair.exec(code)) && guard++ < 900) {
      const raw = m[1];
      if (isDataUri(raw)) continue;
      const u = normalizeUrl(raw, base);
      if (!u) continue;
      const ext = extFromPath(safePath(u));
      const t = ext ? typeFromExt(ext) : null;
      if (!t) continue;
      addRef(ctx, { url: u, tag: 'inferred', attr: 'js:' + m[0].replace(/\s+/g, ' ').slice(0, 20), provenance: 'inferred', hint: t, line });
    }
    ctx.rstate = prevState;
    return;
  }
  if (tok.name === 'noscript') {
    /* noscript 里装的是真正的 HTML：直接递归解析，比正则抠属性可靠得多（区域继承外层） */
    const prev = ctx.nest;
    const prevSeed = ctx.rseed;
    ctx.nest = 'noscript:';
    ctx.rseed = ctx.rstate;
    walkDocument(tok.value, ctx, { text: false, line });
    ctx.nest = prev;
    ctx.rseed = prevSeed;
  }
}

function flush(ctx, node, stack) {
  if (!node || node.flushed) return;
  node.flushed = true;
  const name = node.name;
  const text = cleanText(node.direct.join(' '));

  if (node.linkRef && text) node.linkRef.text = text.slice(0, 180);

  if (INLINE.has(name) && text) {
    const parent = top(stack);
    if (parent && !parent.opaque) parent.direct.push(' ' + text + ' ');
  }
  if (!BLOCK_TEXT.has(name) || !text) return;
  if (name === 'span' || name === 'strong' || name === 'em') return;
  const leaf = HEADING_LIKE.test(name) || /^(p|li|dt|dd|blockquote|figcaption|caption|td|th|pre|address|option|summary|label)$/.test(name);
  if (!leaf) {
    if (text.length < 56) return;
    if (name === 'a' && text.length < 40) return;
  }
  const level = HEADING_LIKE.exec(name);
  const region = regionOf(node.rstate);
  const zone = region.zone;
  ctx.blocks.push({
    order: ctx.seq++, tag: name,
    level: level ? Number(level[1]) : 0,
    text, chars: countChars(text), words: countWords(text),
    id: attrValue(node.attrs, 'id') || '',
    cls: String(attrValue(node.attrs, 'class') || '').slice(0, 120),
    href: attrValue(node.attrs, 'href') || '',
    offset: node.start, line: node.line || 0, zone, zoneKind: region.kind, zoneSoft: !!region.soft,
  });
  if (level) ctx.headings.push({ level: Number(level[1]), text, chars: countChars(text), zone });
}

/* ------------------------------------------------------------- 分词器 */

export function tokenize(html) {
  const out = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      const rest = html.slice(i);
      if (rest.trim()) out.push({ type: 'text', value: rest, start: i });
      break;
    }
    if (lt > i) {
      const t = html.slice(i, lt);
      if (t.trim()) out.push({ type: 'text', value: t, start: i });
    }
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const gt = html.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const isEnd = html[lt + 1] === '/';
    let j = lt + (isEnd ? 2 : 1);
    let quote = '';
    while (j < n) {
      const c = html[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const inner = html.slice(lt + (isEnd ? 2 : 1), j);
    const nameMatch = /^([A-Za-z][^\s/>]*)/.exec(inner);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    if (!name) { i = j + 1; continue; }
    const attrSrc = nameMatch ? inner.slice(nameMatch[1].length) : '';
    if (isEnd) {
      out.push({ type: 'end', name, start: lt });
      i = j + 1;
      continue;
    }
    out.push({ type: 'start', name, attrs: parseAttrs(attrSrc), raw: attrSrc, start: lt, selfClosing: /\/\s*$/.test(inner) || VOID.has(name) });
    if (RAW_TEXT.has(name)) {
      const closeAt = findClosingTag(html, name, j + 1);
      const value = closeAt < 0 ? html.slice(j + 1) : html.slice(j + 1, closeAt);
      if (value.trim()) out.push({ type: 'raw', name, value, start: j + 1, raw: attrSrc });
      if (closeAt < 0) { i = n; continue; }
      const gt = html.indexOf('>', closeAt);
      i = gt < 0 ? n : gt + 1;
      out.push({ type: 'end', name, start: closeAt });
      continue;
    }
    i = j + 1;
  }
  return out;
}

function findClosingTag(html, name, from) {
  const re = new RegExp('<\\s*/\\s*' + name + '\\s*>', 'i');
  const rest = html.slice(from);
  const m = re.exec(rest);
  return m ? from + m.index : -1;
}

function parseAttrs(str) {
  const list = [];
  if (!str) return list;
  const re = /([-a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>]*)))?/g;
  let m;
  while ((m = re.exec(str))) {
    list.push({ name: m[1].toLowerCase(), value: decodeEntities(m[3] != null ? m[3] : m[4] != null ? m[4] : (m[5] || '')) });
  }
  return list;
}

function attrValue(attrs, name) {
  for (const a of attrs || []) if (a.name === name) return a.value;
  return '';
}

/* ------------------------------------------------------------ 线索推断 */

const AS_KIND = {
  image: 'image', video: 'video', audio: 'audio', font: 'font', style: 'stylesheet', script: 'script',
  document: 'page', track: 'data', worker: 'script', sharedworker: 'script', manifest: 'data',
  fetch: 'data', xhr: 'data', empty: 'data', embed: 'document', object: 'document', frame: 'page',
};

function hintFromTag(tag, attr, get, parentTag) {
  if (tag === 'img' || tag === 'image' || (tag === 'input' && attr === 'src')) return 'image';
  if (tag === 'picture') return 'media';
  if (tag === 'source') {
    const byMime = typeFromMime(get('type'));
    if (byMime) return byMime;
    if (parentTag === 'video') return 'video';
    if (parentTag === 'audio') return 'audio';
    return null;
  }
  if (attr === 'poster') return 'video';
  if (tag === 'video') return 'video';
  if (tag === 'audio') return 'audio';
  if (tag === 'script') return 'script';
  if (tag === 'iframe') return 'video';
  if (tag === 'embed' || tag === 'object') return 'document';
  if (tag === 'track') return 'data';
  if (tag === 'link') {
    const rel = (get('rel') || '').toLowerCase();
    const as = (get('as') || '').toLowerCase();
    if (/icon|apple-touch|fluid-icon|mask-icon|splashscreen/.test(rel)) return 'icon';
    if (/stylesheet/.test(rel)) return 'stylesheet';
    if (/font/.test(rel)) return 'font';
    if (/preload|modulepreload|prefetch/.test(rel)) return AS_KIND[as] || as || 'page';
    if (as && AS_KIND[as]) return AS_KIND[as];
    return 'page';
  }
  const mimeHint = typeFromMime(get('type'));
  if (mimeHint) return mimeHint;
  if (/image|thumb|src$/i.test(attr)) return 'image';
  if (/mp3|audio|sound/i.test(attr)) return 'audio';
  if (/mp4|video|movie/i.test(attr)) return 'video';
  if (/pdf|file|download|doc/i.test(attr)) return 'document';
  return null;
}

/**
 * 按规范切分 srcset：URL 取到第一个空白为止（因此 data URI 里的逗号不会被误切），
 * 描述符取到下一个逗号为止；普通地址里「逗号紧跟结尾」时仍按分隔符处理。
 */
function parseSrcset(value) {
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
        /** 空白出现之前：data URI 与「已带查询逗号的地址」里的逗号属于 URL 本身 */
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

/* ---------------------------------------------------------------- CSS */

/** url() 的声明上下文：所属选择器、是否 @font-face、所在属性名 */
function cssContext(css, idx) {
  const open = css.lastIndexOf('{', idx);
  if (open < 0) return { selector: '', atFace: false, prop: '' };
  const start = Math.max(css.lastIndexOf('}', open), css.lastIndexOf(';', open), 0);
  let sel = css.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const brace = sel.lastIndexOf('{');
  if (brace >= 0) sel = sel.slice(brace + 1);
  sel = sel.replace(/[;{}]+\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(-140);
  const atFace = /@font-face\b/i.test(sel) || /@font-face\b[^{}]*$/i.test(css.slice(Math.max(0, open - 220), open));
  const declStart = Math.max(css.lastIndexOf(';', idx), open);
  const decl = css.slice(declStart, idx).replace(/^[;{}]+\s*/, '');
  const dm = /^\s*(-{0,2}[a-zA-Z][-\w]*)\s*:/.exec(decl);
  /** 所在规则块里有 background-position —— 基本可以断定是雪碧图定位 */
  const blockEnd = css.indexOf('}', idx);
  const block = css.slice(open, blockEnd < 0 ? Math.min(css.length, idx + 400) : blockEnd);
  const formatM = /format\(\s*['"]?([a-z0-9.+-]+)/i.exec(css.slice(idx, idx + 200));
  return {
    selector: sel, atFace, prop: dm ? dm[1].toLowerCase() : '',
    sprite: /background-position[^;]*?-?[\d.]+(?:px|rem)\b/i.test(block),
    fontFormat: atFace && formatM ? formatM[1].toLowerCase() : '',
  };
}

/** 注释里出现的 url() / @import 不是引用：等长空白替换，保住偏移与行号 */
function blankCssComments(css) {
  const parts = String(css).split(/(\/\*[\s\S]*?\*\/)/g);
  for (let i = 1; i < parts.length; i += 2) parts[i] = parts[i].replace(/[^\n]/g, ' ');
  return parts.join('');
}

function collectCssUrls(css, baseUrl, ctx, meta) {
  if (!css) return;
  css = blankCssComments(css);
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(css)) && guard++ < 4000) {
    const raw = m[2].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('blob:') || raw.startsWith('about:') || raw.startsWith('local(')) continue;
    const c = cssContext(css, m.index);
    const before = css.slice(Math.max(0, m.index - 48), m.index);
    if (/@import\s+\(?\s*['"]?$/i.test(before)) continue;   /* 交给下面的 @import 分支，避免同一地址出现两次 */
    const after = css.slice(m.index + m[0].length, m.index + m[0].length + 14);
    const density = /\s(\d(?:\.\d+)?)x/.exec(after);
    const fromImageSet = /image-set\([^)]*$/i.test(css.slice(Math.max(0, m.index - 260), m.index));
    if (isDataUri(raw)) {
      const parsed = parseDataUri(raw);
      if (parsed) addRef(ctx, { dataUri: parsed, tag: meta.tag, attr: meta.attr + ':url', provenance: 'css', hint: c.atFace ? 'font' : null, selector: c.selector, line: meta.line || 0, density: density ? Number(density[1]) : 0, cssProp: c.prop, sprite: c.sprite, fontFormat: c.fontFormat });
      continue;
    }
    const u = normalizeUrl(raw, baseUrl);
    if (!u) continue;
    let hint = null;
    if (c.atFace || (c.prop === 'src' && /font/i.test(c.selector))) hint = 'font';
    else if (/cursor|\.cur\b/i.test(c.prop + ' ' + raw)) hint = 'icon';
    addRef(ctx, {
      url: u, tag: meta.tag || 'style', attr: (meta.attr || 'css') + ':url', provenance: 'css', hint,
      selector: (fromImageSet ? 'image-set ' : '') + c.selector, line: meta.line || 0,
      density: density ? Number(density[1]) : 0,
      cssProp: c.prop, sprite: !!c.sprite, fontFormat: c.fontFormat || '',
      imageSet: fromImageSet || undefined,
      context: String(meta.attr || 'css') + ' · ' + (c.prop || '?') + (c.selector ? ' · ' + c.selector : ''),
    });
  }
  /* image-set() 允许直接写字符串：image-set("a.png" 1x, "b@2x.png" 2x) —— url() 形态上面已收 */
  const setRe = /(?:-[a-z]+-)?image-set\(((?:[^()]|\([^()]*\))*)\)/gi;
  let sm;
  let sg = 0;
  while ((sm = setRe.exec(css)) && sg++ < 200) {
    const body = sm[1] || '';
    if (body.indexOf('"') < 0 && body.indexOf('\x27') < 0) continue;
    const sc = cssContext(css, sm.index);
    for (const piece of body.split(',')) {
      const q = /^\s*(['"])([^'"]+)\1\s*(?:(\d*\.?\d+)x|(\d+)w)?\s*$/.exec(piece);
      if (!q) continue;
      const raw = q[2].trim();
      if (!raw || raw.startsWith('#') || isDataUri(raw) || raw.startsWith('blob:') || /^local\(/i.test(raw)) continue;
      const u = normalizeUrl(raw, baseUrl);
      if (!u) continue;
      addRef(ctx, {
        url: u, tag: meta.tag || 'style', attr: (meta.attr || 'css') + ':image-set', provenance: 'css',
        hint: sc.atFace ? 'font' : null, selector: 'image-set ' + sc.selector, line: meta.line || 0,
        density: q[3] ? Number(q[3]) : 0,
        cssProp: sc.prop, sprite: !!sc.sprite, fontFormat: sc.fontFormat || '', imageSet: true,
        context: String(meta.attr || 'css') + ' · image-set' + (sc.selector ? ' · ' + sc.selector : ''),
      });
    }
  }
  /* @import：url("x") / url(x) / "x" / x 四种写法都收 */
  const imp = /@import\s+(?:url\(\s*)?(['"]?)([^'"\s);,]+)\1\s*\)?/gi;
  guard = 0;
  while ((m = imp.exec(css)) && guard++ < 240) {
    const raw = (m[2] || '').trim();
    if (!raw || isDataUri(raw) || /[^\x21-\x7e]/.test(raw) || /^(?:all|screen|print)$/.test(raw)) continue;
    const u = normalizeUrl(raw, baseUrl);
    if (u) addRef(ctx, { url: u, tag: 'style', attr: '@import', provenance: 'css', hint: 'stylesheet', line: meta.line || 0, context: '@import' });
  }
}

/* ------------------------------------------------------- 脚本与 JSON */

function unescapeJsUrls(text) {
  return String(text).replace(/\\\//g, '/').replace(/\\u002f/gi, '/').replace(/\\x2f/gi, '/');
}

/** 找出脚本里所有「括号配对完整」的 JSON 区块 */
function jsonCandidates(text, limit) {
  const out = [];
  const cap = limit || 20;
  let guard = 0;
  for (let i = 0; i < text.length && out.length < cap; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    if (++guard > 400) break;
    const close = matchBracket(text, i);
    if (close < 0 || close - i < 12 || close - i > 240000) continue;
    out.push(text.slice(i, close + 1));
    i = close;
  }
  return out;
}

function matchBracket(text, from) {
  const closing = { '{': '}', '[': ']' };
  const stack = [closing[text[from]]];
  let quote = '';
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') { stack.push(closing[c]); if (stack.length > 40) return -1; continue; }
    if (c === '}' || c === ']') {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
      continue;
    }
  }
  return -1;
}

function collectJsonUrls(text, baseUrl, ctx, line, origin) {
  if (!text) return;
  let parsed = 0;
  for (const cand of jsonCandidates(text)) {
    if (parsed > 8) break;
    let data = null;
    try { data = JSON.parse(cand); } catch { continue; }
    parsed++;
    walkJsonValue(ctx, baseUrl, data, '', line, origin || 'json');
  }
}

function walkJsonValue(ctx, baseUrl, node, key, line, origin) {
  if (node == null) return;
  if (typeof node === 'string') {
    const k = key || '';
    const media = JSON_MEDIA_KEY_RE.test(k);
    if (!media && !hasKnownExt(node)) return;
    for (const piece of node.split(/\s*,\s+/)) {
      const raw = String(piece).trim();
      if (!raw || raw.length > 1200) continue;
      if (isDataUri(raw)) {
        if (!media) continue;
        const parsed = parseDataUri(raw);
        if (parsed) addRef(ctx, { dataUri: parsed, tag: 'inferred', attr: origin + ':' + k, provenance: 'json', hint: 'image', line });
        continue;
      }
      const u = normalizeUrl(raw, baseUrl);
      if (!u) continue;
      const ext = extFromPath(safePath(u));
      const t = ext ? typeFromExt(ext) : null;
      if (!t && !media) continue;
      if (!t && !/[a-z0-9-]+\.[a-z0-9]{2,5}($|[?#])/i.test(safePath(u))) continue;
      addRef(ctx, { url: u, tag: 'inferred', attr: origin + ':' + k.slice(0, 26), provenance: 'json', hint: t, line });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkJsonValue(ctx, baseUrl, v, key, line, origin);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /srcset$/i.test(k)) {
        for (const cand of parseSrcset(v)) {
          const u = normalizeUrl(cand.url, baseUrl);
          if (u) addRef(ctx, { url: u, tag: 'inferred', attr: origin + ':' + k, provenance: 'json', hint: null, line, density: cand.density, declaredWidth: cand.width });
        }
        continue;
      }
      walkJsonValue(ctx, baseUrl, v, k, line, origin);
    }
  }
}

/** style="width:24px;height:24px" 里的声明尺寸（px 与 rem 可信，% / auto 忽略） */
function declaredPx(styleText) {
  const s = String(styleText || '');
  const pick = (prop) => {
    const re = new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*(px|rem)?\\s*(?:[;!]|$)', 'i');
    const m = re.exec(s);
    if (!m) return 0;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0 || v > 20000) return 0;
    return m[2] && m[2].toLowerCase() === 'rem' ? Math.round(v * 16) : Math.round(v);
  };
  const w = pick('width');
  const h = pick('height');
  return w || h ? { w, h } : null;
}

/** 属性值像不像一个可视化资源地址（无扩展名但带图片处理参数也算） */
function looksVisual(value, baseUrl) {
  const v = String(value || '').trim();
  if (!v || /\s/.test(v)) return false;
  if (/^(?:javascript|mailto|tel|data|blob|about):/i.test(v)) return false;
  const abs = normalizeUrl(v, baseUrl);
  if (!abs) return false;
  const m = urlMeta(abs);
  if (m.ext && /^(?:image|vector|icon)$/.test(typeFromExt(m.ext) || '')) return true;
  return !!(m.width && (m.quality || m.dpr || m.ext));
}

function hasKnownExt(value) {
  const v = String(value || '').trim();
  if (!v || /\s/.test(v)) return false;
  const ext = extFromPath(v.split('?')[0].split('#')[0]);
  return !!(ext && typeFromExt(ext));
}

function collectLooseUrls(text, baseUrl, ctx, line, where) {
  if (!text) return;
  const seen = new Set();
  const re = new RegExp(LOOSE_URL_RE.source, 'gi');
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 3200) {
    const raw = m[0].replace(/[).,;:']+$/, '');
    if (isDataUri(raw) || raw.length < 6) continue;
    // 相对写法必须带路径分隔符：链接文字里光秃秃的文件名（"inventory.csv"）不是资源引用
    if (!/^(?:https?:)?\/\//i.test(raw) && raw.indexOf('/') < 0) continue;
    const u = normalizeUrl(raw, baseUrl);
    if (!u || seen.has(u)) continue;
    const ext = extFromPath(safePath(u));
    if (!ext || !typeFromExt(ext)) continue;
    seen.add(u);
    addRef(ctx, { url: u, tag: 'inferred', attr: where || 'text', provenance: 'inferred', hint: typeFromExt(ext), line: line || 0 });
  }
}

/** data: 的方案名大小写不敏感（RFC 2397），判定统一走这里 */
function isDataUri(s) { return /^data:/i.test(String(s == null ? '' : s)); }

function parseDataUri(raw) {
  const rest = String(raw).slice(5);
  const comma = rest.indexOf(',');
  if (comma < 0 || comma > 220) return null;
  const metaPart = rest.slice(0, comma);
  const data = rest.slice(comma + 1).replace(/\s+/g, '');
  const mime = (metaPart.split(';')[0] || '').trim().toLowerCase();
  const base64 = /;base64/i.test(metaPart);
  if (!base64 && !mime) return null;
  if (data.length < 8) return null;
  return { mime: mime || 'application/octet-stream', base64, data, approxBytes: base64 ? Math.floor(data.length * 3 / 4) : data.length };
}

/* --------------------------------------------------------- 合并与去重 */

/** 引用可信度：标签属性 > 样式 > 内联 data > 结构化 JSON > 文本推断 */
const PROV_RANK = { attr: 5, css: 4, datauri: 3, json: 2, inferred: 1 };
const CONTENT_TAGS = new Set(['img', 'source', 'video', 'audio', 'picture', 'input', 'a', 'image', 'div', 'figure', 'body', 'td', 'li', 'span']);

function mergeResources(list) {
  const map = new Map();
  let n = 0;
  for (const r of list) {
    const cdn = r.cdn || null;
    const pathExt = r.dataUri ? '' : extFromPath(safePath(r.url));
    const ext = r.dataUri ? extFromDataUri(r.dataUri.mime) : (pathExt || (cdn && cdn.ext) || '');
    const key = r.dataUri ? 'data::' + r.dataUri.mime + '::' + r.dataUri.data.slice(0, 200) : r.url;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      if ((PROV_RANK[r.provenance] || 0) > (PROV_RANK[existing.provenance] || 0)) {
        existing.provenance = r.provenance;
        if (r.tag) existing.tag = r.tag;
        if (r.attr) existing.attr = r.attr;
        if (r.context) existing.context = r.context;
        /* 先被当成图标、后来发现正文里也在用 —— 交还内容类别，交给真实尺寸再判一次 */
        if (existing.type === 'icon' && CONTENT_TAGS.has(r.tag) && r.hint && r.hint !== 'icon' && r.hint !== 'media' && r.hint !== 'link' && TYPES[r.hint] && !TYPES[r.hint].chrome && !TYPES[r.hint].tech) {
          existing.type = r.hint;
          existing.hint = r.hint;
        }
      }
      if (!existing.widthHint && r.widthHint) existing.widthHint = r.widthHint;
      if (!existing.heightHint && r.heightHint) existing.heightHint = r.heightHint;
      if (!existing.density && r.density) existing.density = r.density;
      if (!existing.declaredWidth && r.declaredWidth) existing.declaredWidth = r.declaredWidth;
      if (!existing.selector && r.selector) existing.selector = r.selector;
      if (!existing.line && r.line) existing.line = r.line;
      if (!existing.alt && r.alt) existing.alt = r.alt;
      if (!existing.hint && r.hint) existing.hint = r.hint;
      if (!existing.cdn && r.cdn) existing.cdn = r.cdn;
      if (!existing.cssProp && r.cssProp) existing.cssProp = r.cssProp;
      if (!existing.fontFormat && r.fontFormat) existing.fontFormat = r.fontFormat;
      if (!existing.metaKey && r.metaKey) existing.metaKey = r.metaKey;
      if (!existing.viaProxy && r.viaProxy) existing.viaProxy = r.viaProxy;
      existing.sprite = existing.sprite || !!r.sprite;
      if (!existing.declaredHeight && r.declaredHeight) existing.declaredHeight = r.declaredHeight;
      /* 区域：同一地址只要有一处落在正文 / 未定性区域，就不算「内容区之外」 */
      mergeZone(existing, r);
      continue;
    }
    const hinted = r.hint && r.hint !== 'media' && r.hint !== 'link' ? r.hint : null;
    const type = classify({
      mime: r.dataUri ? r.dataUri.mime : ((cdn && cdn.mime) || ''), ext,
      context: r.context || '<' + (r.tag || ''), hintedType: hinted,
    });
    map.set(key, {
      id: 'r' + (++n),
      url: r.url || '',
      dataUri: r.dataUri || null,
      ext, type,
      tag: r.tag || 'inferred',
      attr: r.attr || '',
      provenance: r.provenance || 'attr',
      hint: r.hint || null,
      count: 1,
      line: r.line || 0,
      widthHint: r.widthHint || '',
      heightHint: r.heightHint || '',
      density: r.density || 0,
      declaredWidth: r.declaredWidth || (cdn && cdn.w) || 0,
      declaredHeight: (cdn && cdn.h) || 0,
      cdn: cdn || null,
      urlHint: (cdn && cdn.p) || '',
      viaProxy: r.viaProxy || '',
      selector: r.selector || '',
      alt: String(r.alt || '').slice(0, 200),
      context: String(r.context || '').slice(0, 220),
      cssProp: r.cssProp || '',
      sprite: !!r.sprite,
      fontFormat: r.fontFormat || '',
      metaKey: r.metaKey || '',
      imageSet: !!r.imageSet,
      zone: r.zone || 'content',
      zoneKind: r.zoneKind || '',
      zoneSoft: r.zoneSoft === true,
      zoneAlso: '',
    });
  }
  const arr = [...map.values()];
  arr.sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || String(a.url).localeCompare(String(b.url)));
  arr.forEach((r, i) => { r.index = i + 1; });
  return arr;
}

/** 本页各区域的引用 / 文案计数：扫描日志、统计面板与自检都用它 */
function regionSummary(refs, blocks) {
  const kinds = {};
  const bump = (k) => { const key = k || 'other'; kinds[key] = (kinds[key] || 0) + 1; };
  const out = { refs: { main: 0, content: 0, noise: 0 }, texts: { main: 0, content: 0, noise: 0 }, kinds, noiseRefs: 0, noiseTexts: 0 };
  for (const r of refs || []) {
    const z = r.zone === 'noise' ? 'noise' : (r.zone === 'main' ? 'main' : 'content');
    out.refs[z]++;
    if (z === 'noise') { out.noiseRefs++; bump(r.zoneKind); }
  }
  for (const b of blocks || []) {
    const z = b.zone === 'noise' ? 'noise' : (b.zone === 'main' ? 'main' : 'content');
    out.texts[z]++;
    if (z === 'noise') out.noiseTexts++;
  }
  out.kindText = kindsLabel(Object.keys(kinds).filter((k) => kinds[k] > 0));
  return out;
}

function rank(r) {
  if (r.provenance === 'inferred' || r.provenance === 'json') return 3;
  if (r.tag === 'link' || r.tag === 'script' || r.tag === 'meta') return 2;
  return 1;
}

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    if (!l.url) continue;
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    out.push({ url: l.url, text: String(l.text || '').slice(0, 180), asset: !!l.asset });
  }
  return out;
}

function safePath(u) {
  try { return new URL(u).pathname; } catch { return String(u || ''); }
}

/* ------------------------------------------------------------- 文本处理 */

export function cleanText(s) {
  return decodeEntities(String(s || ''))
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&([a-z]+);?/gi, (whole, name) => {
      const key = name.toLowerCase();
      return ENTITIES[key] != null ? ENTITIES[key] : whole;
    });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: String.fromCharCode(34), apos: String.fromCharCode(39), nbsp: ' ',
  ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', ldquo: String.fromCharCode(8220), rdquo: String.fromCharCode(8221),
  lsquo: String.fromCharCode(8216), rsquo: String.fromCharCode(8217), hellip: String.fromCharCode(8230),
  mdash: String.fromCharCode(8212), ndash: String.fromCharCode(8211), middot: String.fromCharCode(183),
  bull: String.fromCharCode(8226), copy: String.fromCharCode(169), reg: String.fromCharCode(174),
  trade: String.fromCharCode(8482), rarr: String.fromCharCode(8594), larr: String.fromCharCode(8592),
  darr: String.fromCharCode(8595), uarr: String.fromCharCode(8593), times: String.fromCharCode(215),
  deg: String.fromCharCode(176), frac12: String.fromCharCode(189), sup2: String.fromCharCode(178),
  sup3: String.fromCharCode(179), para: String.fromCharCode(182), sect: String.fromCharCode(167),
  euro: String.fromCharCode(8364), pound: String.fromCharCode(163), yen: String.fromCharCode(165),
};

export function countChars(s) {
  return Array.from(String(s).replace(/\s+/g, '')).length;
}

export function countWords(s) {
  const str = String(s);
  const cjk = (str.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const latin = (str.replace(/[一-鿿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9_'-]{2,}/g) || []).length;
  return cjk + latin;
}

const STOP_LATIN = new Set(('the and for with you that this from are was will have has not but our your can who how why what when where which their there here they them then than into onto over under about after before also more most much many said says one two new old via per com www http https js css img src url null true false function return var let const class style width height type name data attr item node list view page all some any just been does done').split(' '));
const STOP_CJK_CHARS = new Set('的了是在和等有与也不就都为我你他她它这那之并且或者而没可以什么怎么如果因为所以但是虽然已经正在将要其相他进行通过基于以下如更多解详情查点注发版所司站页个要家品务术用网络信数时间新代对能情况项目'.split(''));

function topKeywords(text) {
  const scores = new Map();
  const latin = String(text).match(/[A-Za-z][A-Za-z0-9+.-]{3,}/g) || [];
  for (const w of latin) {
    const key = w.toLowerCase().replace(/\.+$/, '');
    if (key.length > 24 || STOP_LATIN.has(key)) continue;
    scores.set(key, (scores.get(key) || 0) + 1);
  }
  const runs = String(text).match(/[一-鿿]{2,}/g) || [];
  for (const run of runs) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const gram = run.slice(i, i + len);
        let bad = false;
        for (const ch of gram) if (STOP_CJK_CHARS.has(ch)) { bad = true; break; }
        if (bad) continue;
        scores.set(gram, (scores.get(gram) || 0) + len / 2);
      }
    }
  }
  const picked = [];
  for (const [term, count] of [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (count < 2) continue;
    if (picked.some((p) => p.term.length > term.length && p.term.includes(term))) continue;
    picked.push({ term, count: Math.round(count) });
    if (picked.length >= 26) break;
  }
  return picked;
}

/* -------------------------------------------------------- 行号索引 */

function buildLineIndex(html) {
  const starts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === String.fromCharCode(10)) starts.push(i + 1);
  return starts;
}

function lineFor(starts, offset) {
  if (!offset) return 0;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const DATA_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/apng': 'apng', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/webm': 'webm', 'font/woff': 'woff',
  'font/woff2': 'woff2', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/css': 'css',
  'application/javascript': 'js', 'text/javascript': 'js', 'application/json': 'json', 'text/markdown': 'md',
  'text/html': 'html', 'model/gltf+json': 'gltf', 'image/vnd.microsoft.icon': 'ico',
};

function extFromDataUri(mime) {
  return DATA_EXT[mime] || (mime && mime.indexOf('/') > 0 ? mime.split('/')[1].replace(/[^a-z0-9]/gi, '').slice(0, 5) : 'bin');
}