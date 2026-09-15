/**
 * 扫描策略：把「UI 界面图标」与「字体 / 样式表 / 脚本 / 数据」这类非内容资源
 * 排除在识别与导出之外。
 *
 * 分两级执行，目的是**连请求都不发出**：
 *   preFilter(ref)   —— 解析阶段，仅凭 URL / 属性 / 样式选择器 / 声明尺寸判断（零网络开销）
 *   postFilter(item) —— 探测之后，用真实像素尺寸与魔数结论补判（小图、精灵图、占位像素）
 *
 * reason 取值：
 *   'icon'    UI 图标：站点图标、界面小图、精灵图、图标字体位图（includeIcons 可打开）
 *   'pixel'   占位 / 统计像素：1×1、spacer、blank（始终排除）
 *   'font' | 'stylesheet' | 'script' | 'data' | 'page' | 'other'   技术资源（includeTech 可打开）
 */
import { TECH_TYPES, CHROME_TYPES, TYPES } from './mime.mjs';

/** 判定为「界面图标」的最大像素边长（声明尺寸与真实尺寸都用它） */
export const ICON_MAX_EDGE = 64;
/** 判定为占位像素的边长 */
export const PIXEL_MAX_EDGE = 4;
/** 判定为占位像素的字节上限 */
export const PIXEL_MAX_BYTES = 512;

/** 路径分段里出现即视为界面图标 */
const ICON_NAME_RE = /(?:^|[/._\-\s])(?:favicons?|touch-?icons?|app-?icons?|ui-?icons?|icons?|iconfont|icon-?font|glyphicons?|glyphs?|sprites?|picto-?grams?|bullets?|chevrons?|carets?|spinners?|preloaders?|loaders?)(?:[._\-@]|\b)/i;
/** 界面装饰类的具体图形命名 */
const ICON_PHRASE_RE = /(?:^|[/._\-])(?:arrow|caret|chevron|cross|tick|check-?mark|hamburger|menu-?(?:icon|button)?|search-?icon|expand|collapse|plus-?icon|minus-?icon|play-?btn|btn-?(?:bg|icon)?|social-?icons?|star-?empty|dot-?(?:png|gif|svg)|marker-?icon|badge-?small|avatar-?(?:small|default|placeholder)|no-?image|default-?(?:thumb|avatar))(?:[/._\-@]|\b)/i;
/** 统计像素 / 占位图：始终排除 */
const PIXEL_NAME_RE = /(?:^|[/._\-])(?:spacer|blank|transparent|trans-?pixel|clear-?(?:gif|png)?|tracking-?pixel|analytics?-?pixel|beacon|1x1|px\.gif|s\.gif|dot\.(?:gif|png)|empty-?(?:gif|png|image)|placeholder-?(?:gif|png)?)(?:[/._\-?#]|\b)/i;
/** 页面框架里的小图标常出现在这些选择器上下文中 */
const CHROME_SELECTOR_RE = /(?:^|[\s,>+~.#[-])(?:nav|navbar|menu|menubar|breadcrumb|crumb|tab|btn|button|icon|ico|glyph|sprite|caret|chevron|close|toggle|switch|checkbox|radio|rating|social|share|follow|footer|header|topbar|toolbar|sidebar|cookie|banner|badge|chip|pill|pagination|pager|search|dropdown|accordion|tooltip|toast|modal|loader|spinner)(?:[\s,>+~.#[-]|\b|-)/i;
/** CDN / 图片处理参数里表示尺寸的部分 */
const SIZE_PARAM_RE = /(?:^|[?&;])(?:w|width|hw|th|mw|sw|size|resize|thumb|thumbnail|small|square|sq)=(\d{1,4})(?:[&;x,]|\b)/i;

/** 供 UI 展示的理由说明 */
export const FILTER_LABELS = {
  icon: { label: 'UI 图标', hint: '站点图标、界面小图、精灵图与图标字体位图', switch: 'includeIcons' },
  pixel: { label: '占位像素', hint: '1×1 透明图、统计像素、spacer', switch: null },
  font: { label: '字体', hint: '@font-face 与字体文件', switch: 'includeTech' },
  stylesheet: { label: '样式表', hint: 'CSS / @import（仍会被解析，以便取出其中引用的图片）', switch: 'includeTech' },
  script: { label: '脚本', hint: 'JS / source map / wasm', switch: 'includeTech' },
  data: { label: '数据', hint: 'JSON / XML / 字幕 / manifest', switch: 'includeTech' },
  page: { label: '页面', hint: 'HTML 文档与站内链接', switch: 'includeTech' },
  other: { label: '无法归类', hint: '扩展名与 MIME 都不能判定的地址', switch: 'includeTech' },
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

function fileNameOf(url) {
  const p = pathOf(url);
  return p.split('?')[0].split('/').pop() || '';
}

/** srcset 描述 / 标签属性 / 图片处理参数里能得到的声明宽度 */
function declaredWidthOf(src) {
  const direct = Number(src.declaredWidth) || Number(src.widthHint) || Number(src.width) || 0;
  if (direct > 0) return direct;
  const m = SIZE_PARAM_RE.exec(String(src.url || ''));
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && n < 8000) return n;
  }
  return 0;
}

export function isTechType(type) { return TECH_TYPES.includes(type); }
export function isChromeType(type) { return CHROME_TYPES.includes(type); }

/**
 * 解析阶段判定（不发起任何请求）。
 * @param ref extract.mjs 产出的引用
 * @param opts { includeIcons, includeTech }
 * @returns null 表示保留，否则 { reason, detail }
 */
export function preFilter(ref, opts = {}) {
  const includeIcons = !!opts.includeIcons;
  const includeTech = !!opts.includeTech;
  const type = ref.type || 'other';
  const isData = !!ref.dataUri;
  const path = isData ? 'data:' + String(ref.dataUri.mime || '').toLowerCase() : pathOf(ref.url || '');

  /* 1. 占位像素：任何设置下都不扫描 */
  if (PIXEL_NAME_RE.test(path)) return { reason: 'pixel', detail: '占位 / 统计像素命名' };
  if (isData) {
    const approx = Number(ref.dataUri.approxBytes) || 0;
    const mime = String(ref.dataUri.mime || '').toLowerCase();
    if (approx && approx <= PIXEL_MAX_BYTES) return { reason: 'pixel', detail: '内联数据仅 ' + approx + ' 字节' };
    if (!includeIcons && approx && approx <= 1400 && /svg|gif|bmp/.test(mime)) return { reason: 'icon', detail: '内联小图（' + approx + ' 字节）' };
  }

  /* 2. 技术资源 */
  if (isTechType(type)) {
    return includeTech ? null : { reason: type, detail: TYPES[type] ? TYPES[type].label : type };
  }

  /* 3. 解析阶段已判定为界面图标的（link rel=icon、.ico、图标目录、图标精灵） */
  if (isChromeType(type)) {
    return includeIcons ? null : { reason: 'icon', detail: '类别为 UI 图标' };
  }

  if (includeIcons) return null;

  /* 4. 名字 / 路径像界面图标 */
  if ((type === 'image' || type === 'vector' || type === 'other') && ICON_NAME_RE.test(path)) {
    return { reason: 'icon', detail: '路径含图标关键字' };
  }
  if ((type === 'image' || type === 'vector') && ICON_PHRASE_RE.test(path)) {
    return { reason: 'icon', detail: '文件名为界面装饰图' };
  }

  /* 5. 样式选择器上下文说明它是界面装饰 */
  const selector = String(ref.selector || '');
  if ((type === 'image' || type === 'vector') && selector && CHROME_SELECTOR_RE.test(selector)) {
    return { reason: 'icon', detail: '选择器 ' + selector.slice(-44) };
  }

  /* 6. 声明尺寸小到只能当图标 */
  const edge = Math.max(Number(ref.widthHint) || 0, Number(ref.heightHint) || 0, declaredWidthOf(ref));
  if ((type === 'image' || type === 'vector') && edge > 0 && edge <= ICON_MAX_EDGE) {
    return { reason: 'icon', detail: '声明尺寸 ' + edge + 'px' };
  }
  return null;
}

/**
 * 探测之后的补判（真实像素尺寸 / 魔数 / 精灵图）。
 * @returns null | { reason, detail }
 */
export function postFilter(item, opts = {}) {
  const includeIcons = !!opts.includeIcons;
  const includeTech = !!opts.includeTech;
  const type = item.type || 'other';

  if (isTechType(type) && !includeTech) return { reason: type, detail: '技术资源' };
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
  if (item.size && item.size <= PIXEL_MAX_BYTES && !w && !h) return { reason: 'pixel', detail: '仅 ' + item.size + ' 字节' };
  return null;
}

/** 归并出过滤摘要（供侧栏与 README.txt 展示） */
export function summarize(list) {
  const map = new Map();
  for (const f of list || []) {
    const key = f.reason || 'other';
    const g = map.get(key) || { reason: key, label: filterLabel(key), count: 0, bytes: 0 };
    g.count++;
    if (f.size) g.bytes += f.size;
    map.set(key, g);
  }
  return {
    total: (list || []).length,
    byReason: [...map.values()].sort((a, b) => b.count - a.count),
  };
}
