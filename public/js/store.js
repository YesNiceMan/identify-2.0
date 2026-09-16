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
  sel: new Set(),
  selText: new Set(),
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

export function putResource(item) {
  if (state.byId.has(item.id)) {
    Object.assign(state.byId.get(item.id), item);
    return state.byId.get(item.id);
  }
  state.byId.set(item.id, item);
  state.resources.push(item);
  return item;
}

export function putItems(list) {
  for (const it of list || []) putResource(it);
}

export function putTexts(list) {
  state.texts = (list || []).slice();
  state.textById = new Map(state.texts.map((b) => [b.id, b]));
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
  return state.filter.type === 'text' ? visibleTexts().map((b) => b.id) : visibleItems().map((r) => r.id);
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

/** 只把区间并入（预览叠加层用：不切换锚点以外的项） */
export function addRange(order, fromId, toId, kind) {
  const set = kind === 'text' ? state.selText : state.sel;
  const a = order.indexOf(fromId);
  const b = order.indexOf(toId);
  if (a < 0 || b < 0) return [];
  const ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
  for (const x of ids) set.add(x);
  return ids;
}

export function selectedItems() {
  return state.resources.filter((r) => state.sel.has(r.id) && r.status === 'ok');
}

export function selectionBytes() {
  return selectedItems().reduce((n, r) => n + (r.size || 0), 0);
}

export function selectionByType() {
  const map = new Map();
  for (const r of selectedItems()) {
    const list = map.get(r.type) || [];
    list.push(r);
    map.set(r.type, list);
  }
  return map;
}

export function counts() {
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

export function typeOrderPresent() {
  const c = counts();
  return TYPE_ORDER.filter((t) => c.has(t));
}

export function visibleItems() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  let list = state.resources.filter((r) => {
    if (f.type !== 'all' && r.type !== f.type) return false;
    if (f.onlySel && !state.sel.has(r.id)) return false;
    if (f.onlyOk && r.status !== 'ok') return false;
    /* 「只留同族原件」：把同一张图的缩略 / 低密度写法收起来（没有同族的条目不受影响） */
    if (f.onlyOriginal && r.familySize > 1 && !r.familyBest) return false;
    if (q) {
      const hay = (r.name + ' ' + r.url + ' ' + r.type + ' ' + (r.host || '') + ' ' + (r.mime || '') + ' ' + (r.alt || '')
        + ' ' + (r.provenance || '') + ' ' + (r.format || '') + ' ' + (r.codec || '') + ' ' + (r.title || '') + ' ' + (r.creator || '')
        + ' ' + (r.album || '') + ' ' + (r.genre || '') + ' ' + (r.fontName || '') + ' ' + (r.family || '') + ' ' + (r.camera || '')
        + ' ' + (r.kind || '') + ' ' + (r.flavor || '') + ' ' + (r.docInfo || '') + ' ' + (r.playlistInfo || '') + ' ' + (r.pageSize || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
  const sort = state.sort;
  list = list.slice().sort((a, b) => {
    if (sort === 'size') return (b.size || 0) - (a.size || 0);
    if (sort === 'pixels') return (b.width * b.height || 0) - (a.width * a.height || 0);
    if (sort === 'type') return a.type.localeCompare(b.type) || (b.size || 0) - (a.size || 0);
    return a.index - b.index;
  });
  return list;
}

export function visibleTexts() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  return state.texts.filter((b) => {
    if (f.onlySel && !state.selText.has(b.id)) return false;
    if (q && String(b.text).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

export function totals() {
  const bytes = state.resources.reduce((n, r) => n + (r.size || 0), 0);
  const ok = state.resources.filter((r) => r.status === 'ok').length;
  const bad = state.resources.length - ok;
  const chars = state.texts.reduce((n, b) => n + (b.chars || 0), 0);
  return { bytes, ok, bad, chars, total: state.resources.length, texts: state.texts.length };
}