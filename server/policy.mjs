/**
 * 扫描策略：把「UI 界面图标」与「字体 / 样式表 / 脚本 / 数据」这类非内容资源
 * 排除在识别与导出之外；同时保证**真正的内容资源不会被误杀**。
 *
 * 分两级执行，目的是**连请求都不发出**：
 *   preFilter(ref)   —— 解析阶段，仅凭地址 / 属性 / 样式选择器 / 声明尺寸 / 所在版面区域判断（零网络开销）
 *   postFilter(item) —— 探测之后，用真实像素尺寸、魔数与容器结论补判（小图、精灵图、占位像素）
 *
 * reason 取值：
 *   'region'  扫描区域之外：引用位于页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件（mainOnly 可放开）
 *   'icon'    UI 图标：站点图标、界面小图、精灵图、表情 / 徽章 / 头像占位（includeIcons 可打开）
 *   'pixel'   占位像素与统计打点：1×1、spacer、beacon（始终排除）
 *   'font' | 'stylesheet' | 'script' | 'data' | 'page' | 'other'   技术资源（includeTech 可打开）
 */
import { TECH_TYPES, CHROME_TYPES, TYPES } from './mime.mjs';
import { regionLabel } from './region.mjs';
import { urlMeta, declaredEdge } from './urlmeta.mjs';
import { LAZY_ATTR_RE } from './lazy-attrs.mjs';

/** 判定为「界面图标」的最大像素边长（声明尺寸与真实尺寸都用它） */
export const ICON_MAX_EDGE = 64;
/** 结合上下文（图标目录 / 界面选择器 / 精灵图）时放宽到的边长 */
export const ICON_CONTEXT_EDGE = 128;
/** 判定为占位像素的边长 */
export const PIXEL_MAX_EDGE = 4;
/** 判定为占位像素的字节上限 */
export const PIXEL_MAX_BYTES = 512;

/** 路径分段里出现即视为界面图标 */
const ICON_NAME_RE = /(?:^|[/._\-\s])(?:favicons?|touch-?icons?|app-?icons?|ui-?icons?|icons?|iconfont|icon-?font|glyphicons?|glyphs?|sprites?|picto-?grams?|bullets?|chevrons?|carets?|spinners?|preloaders?|loaders?|stickers?|emojis?|emoticons?|smapies?)(?:[._\-@]|\b)/i;
/** 界面装饰类的具体图形命名 */
const ICON_PHRASE_RE = /(?:^|[/._\-])(?:arrow|caret|chevron|cross|tick|check-?mark|hamburger|menu-?(?:icon|button)?|search-?icon|expand|collapse|plus-?icon|minus-?icon|play-?btn|pause-?btn|btn-?(?:bg|icon)?|social-?icons?|star-?empty|dot-?(?:png|gif|svg)|marker-?icon|badge-?small|avatar-?(?:small|default|placeholder|mono)|no-?image|no-?photo|broken-?image|default-?(?:thumb|avatar|user)|placeholder|watermark|grain|noise-?texture|noise\.png)(?:[/._\-@]|\b)/i;
/** 图标 / 装饰资源常见的目录段 */
const ICON_DIR_RE = /(?:^|\/)(?:icons?|iconfont|glyphs?|sprites?|ui|widgets?|toolbar|navbar|topbar|sidebar|footer|buttons?|smilies?|emoji|emojis?|flags?|countries|social|sharing|share|follow|badges?|stars?|ratings?|pagination|avatars?|thumbnails?|tiny|mini|small|16|24|32|48|64)(?:\/|$)/i;
/** 统计像素 / 打点 / 占位图：任何设置下都不扫描 */
const PIXEL_NAME_RE = /(?:^|[/._\-])(?:spacer|blank|transparent|trans-?pixel|clear-?(?:gif|png|pixel)?|tracking-?pixel|track-?(?:pixel|.gif)|analytics?-?pixel|beacon|web-?bug|webbug|1x1|1x1\.gif|px\.gif|[bsmg]\.gif|__utm\.gif|ga\.gif|collect|log\.gif|event\.gif|notice\.gif|record_gif|rt_event|open\.php|b\.js|dot\.(?:gif|png)|empty-?(?:gif|png|image)|placeholder-?(?:gif|png)?|no-?cookie|noscript-?\.gif)(?:[/._\-?#]|\b)/i;
/** 打点服务的宿主特征（无论地址有没有扩展名） */
const TRACKING_HOST_RE = /doubleclick|googlesyndication|googleadservices|google\.[a-z]{2,3}\/(?:pagead|collect)|facebook\.com\/tr|analytics\.google|google-analytics\.com|googletagmanager|\/ga\.js|\/gtag\/js|scorecardresearch|quantserve|omtrdc|bat\.bing|crazyegg|hotjar|clarity\.ms|matomo|piwik|cnzz|umeng|hm\.baidu|google\.[a-z]{2,3}\/rmi?\/collect/i;
/** 页面框架里的小图标常出现在这些选择器上下文中 */
const CHROME_SELECTOR_RE = /(?:^|[\s,>+~.#[_-])(?:nav|navbar|menu|menubar|breadcrumb|crumb|tab|btn|button|icon|ico|logo|wordmark|brand|glyph|sprite|caret|chevron|close|toggle|switch|checkbox|radio|rating|social|share|follow|footer|header|topbar|toolbar|sidebar|cookie|banner|badge|chip|pill|pagination|pager|search|dropdown|accordion|tooltip|toast|modal|loader|spinner|bullet|avatar|thumb)(?:[\s,>+~.#[_-]|\b|-)/i;
/** 明确是「内容」的目录段 */
const CONTENT_DIR_RE = /(?:^|\/)(?:images?|img|imgres|media|uploads?|uploadfiles|files?|assets|photos?|pics?|pictures?|gallery|albums?|covers?|banners?|posters?|products?|blogs?|articles?|attachments?|resource|content|stream|video|audio)(?:\/|$)/i;
/** 只是界面用的 CSS 属性（cursor / mask / 边框切片等） */
const CHROME_CSS_PROP = new Set(['cursor', 'border-image', 'border-image-source', 'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image']);
/** 明确承载内容的标签 */
const MEDIA_TAGS = new Set(['img', 'image', 'source', 'video', 'audio', 'picture', 'input', 'embed', 'object', 'canvas', 'iframe', 'track']);

/** 供 UI 展示的理由说明 */
export const FILTER_LABELS = {
  region: { label: '内容区之外', hint: '引用位于页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件；只凭 class 命名判定的区域里，下载链接与媒体标签仍会保留。关掉「只扫描主体内容区」即可一并识别', switch: 'mainOnly' },
  icon: { label: 'UI 图标', hint: '站点图标、界面小图、精灵图、表情 / 徽章 / 默认头像', switch: 'includeIcons' },
  pixel: { label: '占位像素', hint: '1×1 透明图、统计打点、spacer', switch: null },
  font: { label: '字体', hint: '@font-face 与字体文件', switch: 'includeTech' },
  stylesheet: { label: '样式表', hint: 'CSS / @import（仍会被读取解析，以便取出其中引用的图片）', switch: 'includeTech' },
  script: { label: '脚本', hint: 'JS / source map / wasm', switch: 'includeTech' },
  data: { label: '数据', hint: 'JSON / XML / 字幕 / manifest', switch: 'includeTech' },
  page: { label: '页面', hint: 'HTML 文档与站内链接', switch: 'includeTech' },
  other: { label: '无法归类', hint: '扩展名、MIME 与内容线索都无法判定的地址', switch: 'includeTech' },
};

export function filterLabel(reason) {
  const info = FILTER_LABELS[reason];
  if (info) return info.label;
  return TYPES[reason] ? TYPES[reason].label : String(reason || '其他');
}

export function filterHint(reason) {
  const info = FILTER_LABELS[reason];
  if (info) return info.hint;
  return '按扫描策略排除';
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname + (u.search || '')).toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function fileNameOf(url) {
  const p = pathOf(url);
  return p.split('?')[0].split('/').pop() || '';
}

export function isTechType(type) { return TECH_TYPES.includes(type); }
export function isChromeType(type) { return CHROME_TYPES.includes(type); }

/** 声明边长：srcset 描述符、标签 width/height、内联 style、图片处理参数 */
function declaredEdgeOf(src) {
  const direct = Math.max(
    Number(src.declaredWidth) || 0,
    Number(src.declaredHeight) || 0,
    Number(src.widthHint) || 0,
    Number(src.heightHint) || 0,
    Number(src.width) || 0,
    Number(src.height) || 0,
  );
  const cdn = src.cdn || {};
  const fromCdn = declaredEdge(cdn) || declaredEdge(urlMeta(src.url || ''));
  return Math.max(direct, fromCdn);
}

/**
 * 内容线索：地址本身判不出类别时，用它决定「值得发一次探测请求」。
 * @returns 命中的线索说明；空字符串表示没有线索
 */
export function contentSignal(ref) {
  if (!ref) return '';
  if (ref.provenance === 'css') return '样式表 url() 引用';
  if (ref.provenance === 'datauri') return '内联数据';
  if (MEDIA_TAGS.has(String(ref.tag || '').toLowerCase())) return '<' + ref.tag + '> 媒体标签';
  if (ref.hint && /^(?:image|video|audio|vector)$/.test(ref.hint)) return '标签类型暗示为' + ref.hint;
  if (ref.attr === 'a[download]') return 'a[download] 附件';
  if (LAZY_ATTR_RE.test(String(ref.attr || ''))) return '懒加载属性';
  if (ref.metaKey && /og:|twitter:|image|thumb|avatar|photo/i.test(String(ref.metaKey))) return 'meta ' + ref.metaKey;
  const cdn = ref.cdn || {};
  if (cdn.w || cdn.h || cdn.dpr || cdn.q) return '图片处理参数';
  if (CONTENT_DIR_RE.test(pathOf(ref.url || ''))) return '内容目录';
  return '';
}

/**
 * 「只凭 class / id 命名」判定的非内容区里，两类引用仍然放行：
 *   · 下载链接（a[download] / a[href] 带 download 属性）—— 页面上明写「下载这个文件」的本身就是内容，
 *     必应首页的当日壁纸原图就挂在分享菜单里，靠这条不被误杀；
 *   · 媒体标签（video / audio / source / picture / track / object / embed / iframe）。
 * 语义地标（<nav>/<footer>/role=banner…）判定的区域不享受这个例外——那里是真页脚，不是猜的。
 */
export function softRegionEscape(ref) {
  if (!ref || ref.zoneSoft !== true) return false;
  const tag = String(ref.tag || '').toLowerCase();
  const attr = String(ref.attr || '');
  if (/^a\[download\]$|^download$/i.test(attr)) return true;
  return /^(video|audio|source|picture|track|object|embed|iframe)$/i.test(tag);
}

/**
 * 解析阶段判定（不发起任何请求）。
 * @param ref extract.mjs 产出的引用
 * @param opts { includeIcons, includeTech, mainOnly }
 * @returns null 表示保留，否则 { reason, detail }
 */
export function preFilter(ref, opts = {}) {
  const includeIcons = !!opts.includeIcons;
  const includeTech = !!opts.includeTech;
  const mainOnly = !!opts.mainOnly;

  /**
   * 最后一道：扫描区域。前面所有规则都是「这东西本来就不该扫」，
   * 走到这里说明它是一个**内容资源**，只是出现的位置在正文之外——
   * 页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件里的引用默认不发请求（关掉 mainOnly 即恢复整页扫描）。
   * 样式表、脚本、正文裸链接等页面级来源在解析阶段就记为 content，不受这条影响。
   */
  const pass = () => {
    if (!mainOnly || ref.zone !== 'noise') return null;
    if (softRegionEscape(ref)) return null;
    return { reason: 'region', detail: '位于' + regionLabel(ref.zoneKind) + (ref.zoneSoft ? '（按命名推断）' : '') + '，在主体内容区之外' };
  };
  const type = ref.type || 'other';
  const isData = !!ref.dataUri;
  const url = ref.url || '';
  const path = isData ? 'data:' + String(ref.dataUri.mime || '').toLowerCase() : pathOf(url);
  const host = isData ? '' : hostOf(url);
  const cdn = ref.cdn || {};
  const visual = type === 'image' || type === 'vector' || type === 'other';

  /* 1. 占位像素与统计打点：任何设置下都不扫描 */
  if (PIXEL_NAME_RE.test(path) || TRACKING_HOST_RE.test(host + path)) {
    return { reason: 'pixel', detail: '占位图 / 统计打点' };
  }
  if (isData) {
    const approx = Number(ref.dataUri.approxBytes) || 0;
    const mime = String(ref.dataUri.mime || '').toLowerCase();
    if (approx && approx <= PIXEL_MAX_BYTES) return { reason: 'pixel', detail: '内联数据仅 ' + approx + ' 字节' };
    if (!includeIcons && approx && approx <= 1400 && /svg|gif|bmp/.test(mime)) return { reason: 'icon', detail: '内联小图（' + approx + ' 字节）' };
  }

  /* 2. 徽章 / 表情 / 默认头像这类地址就能确定的界面装饰 */
  if (!includeIcons && (cdn.badge || cdn.emoji || cdn.avatar)) {
    return { reason: 'icon', detail: cdn.badge ? '徽章图片' : cdn.emoji ? '表情 / 国旗小图' : '默认头像' };
  }

  /* 3. 技术资源：字体 / 样式表 / 脚本 / 数据 / 页面 / 无法归类 */
  if (isTechType(type)) {
    if (includeTech) return pass();
    /** 「无法归类」不能一刀切：地址没有扩展名是常态，先探一次再判，避免误杀内容 */
    if (type === 'other') {
      const signal = contentSignal(ref);
      if (signal) return pass();
    }
    return { reason: type, detail: TYPES[type] ? TYPES[type].label : type };
  }

  /* 4. 解析阶段已判定为界面图标的（link rel=icon、.ico、图标目录、图标精灵） */
  if (isChromeType(type)) {
    return includeIcons ? pass() : { reason: 'icon', detail: '类别为 UI 图标' };
  }

  if (includeIcons) return pass();

  /* 5. 名字 / 目录像界面图标（但声明尺寸明显大于图标时交回内容判断） */
  const declared = declaredEdgeOf(ref);
  const big = declared > ICON_CONTEXT_EDGE;
  if (visual && !big && ICON_NAME_RE.test(path)) return { reason: 'icon', detail: '路径含图标关键字' + (declared ? ' · 声明 ' + declared + 'px' : '') };
  if (visual && !big && ICON_PHRASE_RE.test(fileNameOf(url))) return { reason: 'icon', detail: '文件名为界面装饰图' };
  if (visual && ICON_DIR_RE.test(path) && !big) {
    return { reason: 'icon', detail: '图标目录' + (declared ? ' · 声明 ' + declared + 'px' : '') };
  }

  /* 6. 样式上下文说明它是界面装饰（选择器 / CSS 属性 / 雪碧图定位） */
  const selector = String(ref.selector || '');
  if (visual && selector && CHROME_SELECTOR_RE.test(selector)) {
    return { reason: 'icon', detail: '选择器 ' + selector.slice(-44) };
  }
  if (visual && CHROME_CSS_PROP.has(String(ref.cssProp || ''))) {
    return { reason: 'icon', detail: 'CSS 属性 ' + ref.cssProp };
  }
  if (visual && ref.sprite && !(declaredEdgeOf(ref) > ICON_CONTEXT_EDGE)) return { reason: 'icon', detail: '雪碧图（background-position 偏移定位）' };

  /* 7. 声明尺寸小到只能当图标：连请求都不发 */
  const edge = declaredEdgeOf(ref);
  if (visual && edge > 0 && edge <= ICON_MAX_EDGE) {
    return { reason: 'icon', detail: '声明尺寸 ' + edge + 'px' };
  }
  return pass();
}

/**
 * 探测之后的补判（真实像素尺寸 / 魔数 / 精灵图 / 图标字形）。
 * @returns null | { reason, detail }
 */
export function postFilter(item, opts = {}) {
  const includeIcons = !!opts.includeIcons;
  const includeTech = !!opts.includeTech;
  const type = item.type || 'other';

  if (isTechType(type) && !includeTech) {
    if (type === 'other' && item.mime && /image|video|audio/.test(String(item.mime))) return null;
    return { reason: type, detail: '技术资源' };
  }
  if (isChromeType(type) && !includeIcons) return { reason: 'icon', detail: 'UI 图标' };
  if (includeIcons) return null;
  if (type !== 'image' && type !== 'vector') return null;

  const w = Number(item.width) || 0;
  const h = Number(item.height) || 0;
  if (w && h) {
    const edge = Math.max(w, h);
    if (edge <= PIXEL_MAX_EDGE) return { reason: 'pixel', detail: '真实尺寸 ' + w + '×' + h };
    if (edge <= ICON_MAX_EDGE) return { reason: 'icon', detail: '真实尺寸 ' + w + '×' + h };
  }
  if (item.sprite) return { reason: 'icon', detail: 'SVG 精灵图（' + (item.symbols || '?') + ' 个 symbol）' };
  if (item.glyphLike) return { reason: 'icon', detail: '图标字形（' + (item.shapes || '?') + ' 条路径 · viewBox ' + (item.viewBox || '?') + '）' };
  if (item.iconSet) {
    const sz = Array.isArray(item.sizes) ? item.sizes.join(' / ') : String(item.sizes || '');
    return { reason: 'icon', detail: '多尺寸图标集（' + (sz || (item.entries + ' 项')) + '）' };
  }
  if (item.frames && item.frames >= 12 && (!w || Math.max(w, h) <= 256)) return { reason: 'icon', detail: '逐帧动画精灵图（' + item.frames + ' 帧）' };
  if (item.size && item.size <= PIXEL_MAX_BYTES && !w && !h) return { reason: 'pixel', detail: '仅 ' + item.size + ' 字节' };
  return null;
}

/** 归并出过滤摘要（供侧栏与 README.txt 展示） */
export function summarize(list) {
  const map = new Map();
  for (const f of list || []) {
    const key = f.reason || 'other';
    const g = map.get(key) || { reason: key, label: filterLabel(key), hint: filterHint(key), count: 0, bytes: 0, probed: 0 };
    g.count++;
    if (f.size) g.bytes += f.size;
    if (f.status && f.status !== 'unresolved') g.probed++;
    map.set(key, g);
  }
  return {
    total: (list || []).length,
    byReason: [...map.values()].sort((a, b) => b.count - a.count),
  };
}

/** 排除明细的体积上限（避免一个上千字体的站点把结果撑爆） */
export const MAX_FILTERED_DETAIL = 400;

/** 按理由配额保留明细，统计仍然完整 */
export function trimFiltered(list, limit = MAX_FILTERED_DETAIL) {
  const perReason = new Map();
  const kept = [];
  let dropped = 0;
  for (const f of list || []) {
    const key = f.reason || 'other';
    const n = perReason.get(key) || 0;
    if (n >= limit) { dropped++; continue; }
    perReason.set(key, n + 1);
    kept.push(f);
  }
  return { kept, dropped };
}