import { TYPE_ORDER } from './util.js';

export const state = {
  job: null,
  url: '',
  options: { deep: true, crawlPages: 0, infer: true, includeIcons: false, includeTech: false },
  doc: {},
  resources: [],
  filtered: [],
  texts: [],
  headings: [],
  keywords: [],
  links: [],
  pages: [],
  stats: null,
  filteredTotal: 0,
  filteredOverflow: 0,
  /* 选择集合改动即作废旧视图缓存（见 TrackedSet），调用方照旧 add/delete/clear */
  sel: trackedSet(),
  selText: trackedSet(),
  /* Shift 连续多选的锚点：上一次「单独勾选」的资源 / 文案 id */
  anchor: null,
  anchorText: null,
  filter: { type: 'all', q: '', onlySel: false, onlyOk: false, onlyOriginal: false },
  sort: 'index',
  view: 'grid',
  /* 展台（卡片）还是页面预览（原始页面快照 + 可点选叠加层） */
  stage: 'list',
  scanning: false,
  byId: new Map(),
  textById: new Map(),
};

/**
 * 视图版本号：任何会影响「谁可见 / 排第几 / 各类多少」的改动都要 bump()。
 * 派生结果（可见列表、分类计数、总计）按版本号缓存——扫描时每条 SSE 都会重算，
 * 不缓存就是 资源数 × 资源数 的白工（900 条时明显卡手）。
 */
state.rev = 0;
export function bump() { state.rev++; }

/**
 * 会 bump() 的 Set：把「勾选变化」也当成一次版本推进，
 * 于是缓存的失效不需要每个调用点手工维护。
 */
function trackedSet() {
  const s = new Set();
  const add = Set.prototype.add;
  const del = Set.prototype.delete;
  const clr = Set.prototype.clear;
  s.add = function (v) { if (!s.has(v)) { add.call(s, v); bump(); } return s; };
  s.delete = function (v) { const hit = del.call(s, v); if (hit) bump(); return hit; };
  s.clear = function () { if (s.size) { clr.call(s); bump(); } };
  return s;
}

export function putResource(item) {
  if (state.byId.has(item.id)) {
    const prev = state.byId.get(item.id);
    Object.assign(prev, item);
    prev._dirty = true;   /* 搜索用的小写摘要要重算，只标这一条 */
    bump();
    return prev;
  }
  state.byId.set(item.id, item);
  state.resources.push(item);
  bump();
  return item;
}

export function putItems(list) {
  for (const it of list || []) putResource(it);
}

export function putTexts(list) {
  state.texts = (list || []).slice();
  state.textById = new Map(state.texts.map((b) => [b.id, b]));
  bump();
}

export function reset() {
  state.job = null;
  state.doc = {};
  state.resources = [];
  state.filtered = [];
  state.texts = [];
  state.headings = [];
  state.keywords = [];
  state.links = [];
  state.pages = [];
  state.stats = null;
  state.filteredTotal = 0;
  state.filteredOverflow = 0;
  state.sel.clear();
  state.selText.clear();
  state.anchor = null;
  state.anchorText = null;
  state.byId = new Map();
  state.textById = new Map();
  state.filter = { type: 'all', q: '', onlySel: false, onlyOk: false, onlyOriginal: false };
  state.scanning = false;
  state.pages = [];
}

export function toggle(id) {
  if (state.sel.has(id)) state.sel.delete(id);
  else state.sel.add(id);
}

export function toggleText(id) {
  if (state.selText.has(id)) state.selText.delete(id);
  else state.selText.add(id);
}

export function clearSelection() {
  state.sel.clear();
  state.selText.clear();
  state.anchor = null;
  state.anchorText = null;
}

/* -------------------------------------------------------- 连续多选 */

/** 当前视图里资源 / 文案的可见顺序（Shift 连选就按这个顺序取区间） */
export function visibleOrder() {
  return state.filter.type === 'text' ? orderText() : orderItems();
}

/**
 * 勾选一项。
 *   普通点击      —— 切换这一项，并把它记成锚点
 *   Shift + 点击 —— 从锚点到这一项之间的**整段连续区间**并入选择（只加不减），锚点不变
 *   锚点已不在当前视图（换了筛选 / 排序）时，Shift 退化为普通切换
 * @param order 当前可见顺序
 * @param kind  'res' 资源 / 'text' 文案
 * @returns {mode:'toggle'|'range', ids:Array, added:number}
 */
export function pickSelection(order, id, shift, kind) {
  const isText = kind === 'text';
  const set = isText ? state.selText : state.sel;
  const anchorId = isText ? state.anchorText : state.anchor;
  const from = anchorId ? order.indexOf(anchorId) : -1;
  const to = order.indexOf(id);
  if (shift && from >= 0 && to >= 0 && from !== to) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const ids = order.slice(lo, hi + 1);
    let added = 0;
    for (const x of ids) if (!set.has(x)) { set.add(x); added++; }
    return { mode: 'range', ids: ids, added: added };
  }
  if (set.has(id)) set.delete(id);
  else { set.add(id); }
  if (isText) state.anchorText = id;
  else state.anchor = id;
  return { mode: 'toggle', ids: [id], added: set.has(id) ? 1 : 0 };
}


export function selectedItems() {
  return state.resources.filter((r) => state.sel.has(r.id) && r.status === 'ok');
}

export function selectionBytes() {
  return selectedItems().reduce((n, r) => n + (r.size || 0), 0);
}


/* ---------------------------------------------------- 派生结果缓存 */

var derived = null;   /* var：模块顶层执行时不受 TDZ 影响 */

/**
 * 缓存键 = 版本号 + 筛选/排序签名。
 * 版本号覆盖「数据与勾选变了」（putResource / trackedSet 会自动 bump），
 * 签名覆盖「只是换了看法」——filter/sort 在别处是直接赋值的，
 * 单靠版本号会有读到旧视图的风险，所以这里两样都看。
 */
function viewKey() {
  const f = state.filter;
  return state.rev + '|' + f.type + '|' + f.q + '|' + (f.onlySel ? 1 : 0) + '|' + (f.onlyOk ? 1 : 0) + '|' + (f.onlyOriginal ? 1 : 0) + '|' + state.sort;
}

function derivedView() {
  const key = viewKey();
  if (derived && derived.key === key) return derived;
  const items = computeVisibleItems();
  const texts = computeVisibleTexts();
  derived = {
    key: key,
    counts: computeCounts(),
    totals: computeTotals(),
    items: items,
    texts: texts,
    /* id 顺序也一并缓存：Shift 连选每点一次都要读 */
    orderItems: items.map((r) => r.id),
    orderText: texts.map((b) => b.id),
  };
  return derived;
}

function computeCounts() {
  const map = new Map();
  for (const r of state.resources) {
    const g = map.get(r.type) || { count: 0, bytes: 0, ok: 0, bad: 0 };
    g.count++;
    if (r.size) g.bytes += r.size;
    if (r.status === 'ok') g.ok++; else g.bad++;
    map.set(r.type, g);
  }
  return map;
}

/** 分类计数：侧栏、类型条、雷达都从这里取，扫描中每帧只算一次 */
export function counts() { return derivedView().counts; }


/**
 * 搜索用的摘要（小写、拼接一次）。每个 _dirty 的条目重算一次并缓存，
 * 原来每次筛选都为每条资源重新拼一遍 20 个字段的字符串。
 */
function haystackOf(r) {
  if (!r._dirty && r._hay != null) return r._hay;
  r._hay = (r.name + ' ' + r.url + ' ' + r.type + ' ' + (r.host || '') + ' ' + (r.mime || '') + ' ' + (r.alt || '')
    + ' ' + (r.provenance || '') + ' ' + (r.format || '') + ' ' + (r.codec || '') + ' ' + (r.title || '') + ' ' + (r.creator || '')
    + ' ' + (r.album || '') + ' ' + (r.genre || '') + ' ' + (r.fontName || '') + ' ' + (r.family || '') + ' ' + (r.camera || '')
    + ' ' + (r.kind || '') + ' ' + (r.flavor || '') + ' ' + (r.docInfo || '') + ' ' + (r.playlistInfo || '') + ' ' + (r.pageSize || '')).toLowerCase();
  r._dirty = false;
  return r._hay;
}

/**
 * 当前筛选条件是否命中这条资源 —— 展台增量追加卡片与整表重算共用同一份定义。
 * （原 views.js 里另有一份 matchesFilter，字段比这里少 6 个，搜索时会漏筛。）
 */
export function matchesFilter(r) {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  if (f.type !== 'all' && r.type !== f.type) return false;
  if (f.onlySel && !state.sel.has(r.id)) return false;
  if (f.onlyOk && r.status !== 'ok') return false;
  /* 「只留同族原件」：把同一张图的缩略 / 低密度写法收起来（没有同族的条目不受影响） */
  if (f.onlyOriginal && r.familySize > 1 && !r.familyBest) return false;
  if (q && haystackOf(r).indexOf(q) < 0) return false;
  return true;
}

function computeVisibleItems() {
  const list = state.resources.filter(matchesFilter);
  const sort = state.sort;
  return list.sort((a, b) => {
    if (sort === 'size') return (b.size || 0) - (a.size || 0);
    if (sort === 'pixels') return (b.width * b.height || 0) - (a.width * a.height || 0);
    if (sort === 'type') return a.type.localeCompare(b.type) || (b.size || 0) - (a.size || 0);
    return a.index - b.index;
  });
}

export function visibleItems() { return derivedView().items; }
function orderItems() { return derivedView().orderItems; }
function orderText() { return derivedView().orderText; }

function computeVisibleTexts() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  return state.texts.filter((b) => {
    if (f.onlySel && !state.selText.has(b.id)) return false;
    if (q && String(b.text).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

export function visibleTexts() { return derivedView().texts; }

function computeTotals() {
  let bytes = 0; let ok = 0; let chars = 0;
  for (const r of state.resources) {
    if (r.size) bytes += r.size;
    if (r.status === 'ok') ok++;
  }
  for (const b of state.texts) chars += b.chars || 0;
  return { bytes, ok, bad: state.resources.length - ok, chars, total: state.resources.length, texts: state.texts.length };
}

export function totals() { return derivedView().totals; }