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
  sel: new Set(),
  selText: new Set(),
  filter: { type: 'all', q: '', onlySel: false, onlyOk: false, onlyOriginal: false },
  sort: 'index',
  view: 'grid',
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
  state.sel.clear();
  state.selText.clear();
  state.byId = new Map();
  state.textById = new Map();
  state.filter = { type: 'all', q: '', onlySel: false, onlyOk: false, onlyOriginal: false };
  state.scanning = false;
}

export function toggle(id) {
  if (state.sel.has(id)) state.sel.delete(id);
  else state.sel.add(id);
}

export function toggleText(id) {
  if (state.selText.has(id)) state.selText.delete(id);
  else state.selText.add(id);
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
      const hay = (r.name + ' ' + r.url + ' ' + r.type + ' ' + (r.host || '') + ' ' + (r.mime || '') + ' ' + (r.alt || '') + ' ' + (r.provenance || '') + ' ' + (r.format || '') + ' ' + (r.codec || '')).toLowerCase();
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
