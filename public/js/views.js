import { $, el, esc, fmtBytes, bytesText, fmtDuration, fmtNum, pixels, typeOf, TYPES, TYPE_ORDER, PROV_LABEL, hostUrl } from './util.js';
import { proxySrc, downloadSrc } from './api.js';
import { state, counts, visibleItems, visibleTexts, totals, selectionBytes, selectedItems } from './store.js';

let H = {};
export function mount(handlers) { H = handlers; }

/* -------------------------------------------------------- 侧栏光谱 */

export function renderSpectre() {
  const list = $('#spectre-list');
  const t = totals();
  if (!list) return;
  const c = counts();
  const max = Math.max(1, ...TYPE_ORDER.map((k) => (c.get(k) || { bytes: 0 }).bytes));
  list.innerHTML = '';
  if (!state.resources.length) {
    list.appendChild(el('div', { class: 'spec-empty', text: '尚无数据 · 先扫描一个网址' }));
  } else {
    for (const key of TYPE_ORDER) {
      const g = c.get(key);
      if (!g) continue;
      const info = TYPES[key];
      const on = state.filter.type === key;
      const row = el('div', { class: 'spec-row' + (on ? ' on' : ''), dataset: { type: key }, onclick: () => H.onType(key) });
      row.appendChild(el('span', { class: 'glyph', text: info.glyph, style: 'color:' + info.color }));
      row.appendChild(el('span', { class: 'name', html: esc(info.label) + '<em>' + esc(info.en) + '</em>' }));
      row.appendChild(el('span', { class: 'num', html: g.count + '<i>' + esc(bytesText(g.bytes)) + '</i>' }));
      const meter = el('i', { class: 'meter', style: 'background:' + info.color });
      row.appendChild(meter);
      list.appendChild(row);
      requestAnimationFrame(() => { meter.style.width = Math.max(4, (g.bytes / max) * 100) + '%'; });
    }
  }
  const pie = $('#ov-pie');
  if (pie) {
    const totalBytes = Math.max(1, t.bytes);
    pie.innerHTML = '';
    for (const key of TYPE_ORDER) {
      const g = c.get(key);
      if (!g || !g.bytes) continue;
      pie.appendChild(el('i', { dataset: { key }, style: 'background:' + TYPES[key].color, title: TYPES[key].label + ' ' + bytesText(g.bytes) }));
    }
    requestAnimationFrame(() => {
      Array.prototype.forEach.call(pie.children, (node) => {
        const g = c.get(node.dataset.key);
        if (g) node.style.width = ((g.bytes / totalBytes) * 100).toFixed(2) + '%';
      });
    });
  }
  const total = $('#ov-total');
  if (total) countTo(total, t.total);
  const kv = $('#ov-kv');
  if (kv) {
    const st = state.stats;
    const dropped = st && st.filtered ? st.filtered.total : state.filtered.length;
    const rows = [
      ['可导出', t.ok + ' / ' + t.total],
      ['失效', t.bad || 0],
      ['文案', fmtNum(t.chars) + ' 字'],
      ['已排除', fmtNum(dropped)],
      ['主机', st && st.hosts ? st.hosts.length : new Set(state.resources.map((r) => r.host).filter(Boolean)).size],
      ['用时', st && st.duration ? (st.duration / 1000).toFixed(1) + 's' : '扫描中'],
    ];
    kv.innerHTML = rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd title="' + esc(String(r[1])) + '">' + esc(String(r[1])) + '</dd>').join('');
  }
  const hosts = $('#host-list');
  if (hosts) {
    const map = new Map();
    for (const r of state.resources) {
      if (!r.host) continue;
      const g = map.get(r.host) || { count: 0, bytes: 0 };
      g.count++; g.bytes += r.size || 0;
      map.set(r.host, g);
    }
    const sorted = [...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 9);
    hosts.innerHTML = '';
    for (const [host, g] of sorted) {
      const row = el('div', { title: '仅看来自 ' + host, html: '<span>' + esc(host) + '</span><b>' + g.count + ' · ' + esc(bytesText(g.bytes)) + '</b>' });
      row.addEventListener('click', () => { $('#filter').value = host; state.filter.q = host; H.onQuery(host); });
      hosts.appendChild(row);
    }
    if (!sorted.length) hosts.appendChild(el('div', { class: 'spec-empty', text: '—' }));
  }
  renderPolicy();
}

/* -------------------------------------------------------- 扫描策略面板 */

export function renderPolicy() {
  const box = $('#policy-box');
  if (!box) return;
  const list = state.filtered || [];
  box.innerHTML = '';
  if (!state.stats) {
    box.appendChild(el('div', { class: 'spec-empty', text: '等待扫描' }));
    return;
  }
  const pol = state.stats.policy || {};
  box.appendChild(el('div', { class: 'pol-mode' }, [
    el('b', { text: pol.mode || '仅内容资源' }),
    el('s', { class: pol.includeIcons ? 'on' : '', text: pol.includeIcons ? 'UI 图标 开' : 'UI 图标 关' }),
    el('s', { class: pol.includeTech ? 'on' : '', text: pol.includeTech ? '技术资源 开' : '技术资源 关' }),
  ]));
  if (!list.length) {
    box.appendChild(el('div', { class: 'spec-empty', text: '本次没有排除任何引用' }));
    return;
  }
  /* 统计口径以服务端为准（明细可能被截断），分组顺序仍按当前可见列表 */
  const byReason = new Map();
  for (const f of list) {
    const g = byReason.get(f.reason) || { reason: f.reason, label: f.label, hint: f.hint, count: 0, bytes: 0, asked: 0 };
    g.count++;
    if (f.size) { g.bytes += f.size; g.asked++; }
    byReason.set(f.reason, g);
  }
  const official = (state.stats.filtered && state.stats.filtered.byReason) || [];
  for (const g of official) {
    const cur = byReason.get(g.reason);
    if (cur) { cur.count = g.count; cur.bytes = g.bytes || cur.bytes; cur.asked = g.probed || 0; cur.label = g.label || cur.label; cur.hint = g.hint || cur.hint; }
    else byReason.set(g.reason, { reason: g.reason, label: g.label, hint: g.hint, count: g.count, bytes: g.bytes || 0, asked: g.probed || 0 });
  }
  const groups = [...byReason.values()].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...groups.map((g) => g.count));
  const wrap = el('div', { class: 'pol-list' });
  for (const g of groups) {
    const row = el('button', { class: 'pol-row', type: 'button', title: (g.hint || g.label) + ' · 点击查看明细' });
    row.appendChild(el('span', { class: 'k', text: g.label }));
    row.appendChild(el('span', { class: 'n', html: g.count + '<i>' + esc(g.bytes ? bytesText(g.bytes) : '未请求') + '</i>' }));
    row.appendChild(el('i', { class: 'bar', style: 'width:' + Math.max(6, (g.count / max) * 100) + '%' }));
    row.addEventListener('click', () => H.onPolicy && H.onPolicy(g.reason));
    wrap.appendChild(row);
  }
  box.appendChild(wrap);
  const total = state.stats.filtered && state.stats.filtered.total ? state.stats.filtered.total : list.length;
  const asked = groups.reduce((n, g) => n + (g.asked || 0), 0);
  const overflow = state.filteredOverflow || 0;
  box.appendChild(el('div', {
    class: 'pol-foot',
    text: '合计排除 ' + fmtNum(total) + ' 项 · ' + fmtNum(Math.max(0, total - asked)) + ' 项在发起请求前就被识别'
      + (overflow ? ' · 明细最多展示 ' + list.length + ' 条' : ''),
  }));
  box.appendChild(el('button', { class: 'pol-more', type: 'button', text: '查看全部排除明细 →', onclick: () => H.onPolicy && H.onPolicy('') }));
}

/** 排除明细弹层 */
export function policyModalHtml(reason) {
  const all = state.filtered || [];
  const list = reason ? all.filter((f) => f.reason === reason) : all;
  const first = list[0] || {};
  const cap = 400;
  const rows = list.slice(0, cap).map((f) => '<tr>'
    + '<td title="' + esc(f.url || '') + '">' + esc(f.name || '(内联)') + '</td>'
    + '<td><i style="color:' + esc(typeOf(f.type).color) + '">' + esc(typeOf(f.type).glyph) + '</i> ' + esc(typeOf(f.type).label) + '</td>'
    + '<td class="why">' + esc(f.detail || f.reason || '') + '</td>'
    + '<td class="num">' + (f.size ? esc(bytesText(f.size)) : '未请求') + '</td>'
    + '<td class="src">' + esc([f.tag ? '<' + f.tag + '>' : '', f.attr || '', f.selector ? '· ' + f.selector : ''].filter(Boolean).join(' ')) + '</td>'
    + '</tr>').join('');
  const dl = [
    ['排除原因', first.label || '全部'],
    ['判定说明', first.hint || '按扫描策略排除'],
    ['条目数', list.length + ' 项'],
    ['体积合计', list.some((f) => f.size) ? bytesText(list.reduce((n, f) => n + (f.size || 0), 0)) : '尚未请求，无体积'],
    ['开关', reason === 'icon' || reason === 'pixel' ? '「扫描 UI 图标」' : reason === 'overflow' ? '「最大资源数」' : '「扫描技术资源」'],
  ];
  return '<div class="view pol-view"><div class="pol-scroll"><table class="pol-table"><thead><tr>'
    + '<th>名称</th><th>类别</th><th>判定依据</th><th class="num">体积</th><th>来源</th></tr></thead>'
    + '<tbody>' + (rows || '<tr><td colspan="5">没有条目</td></tr>') + '</tbody></table>'
    + (list.length > cap ? '<div class="pol-cap">仅列出前 ' + cap + ' 项，共 ' + list.length + ' 项</div>' : '')
    + '</div></div>'
    + '<div class="info">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem"><div class="name">' + esc(first.label || '扫描策略') + ' · ' + list.length + ' 项</div><button class="icon-btn close" data-close>✕</button></div>'
    + '<div class="url">' + esc(first.hint || '这些引用按当前扫描策略被排除') + '</div>'
    + '<dl>' + dl.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd>').join('') + '</dl>'
    + '<div class="row-acts"><button class="dbtn" data-close>关闭</button></div>'
    + '<div class="hint-line">被排除的字体 / 样式表 / 脚本 / 数据 / 图标默认不发起请求；需要它们时，在扫描台打开对应开关后重新扫描。</div>'
    + '</div>';
}

function countTo(node, to) {
  const from = Number(String(node.textContent).replace(/[^\d.]/g, '')) || 0;
  if (from === to) { node.textContent = fmtNum(to); return; }
  const start = performance.now();
  const dur = 700;
  (function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = fmtNum(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  })(start);
}

/* ------------------------------------------------------------ 标签栏 */

export function renderTabs() {
  const host = $('#tabs');
  if (!host) return;
  const c = counts();
  const items = [['all', '全部', 'ALL', state.resources.length, '#fff']];
  for (const key of TYPE_ORDER) {
    const g = c.get(key);
    if (!g) continue;
    items.push([key, TYPES[key].label, TYPES[key].en, g.count, TYPES[key].color]);
  }
  items.push(['text', '文字', 'COPY', state.texts.length, '#b8ff3c']);
  host.innerHTML = '';
  for (const [key, label, en, count, color] of items) {
    const on = state.filter.type === key;
    const tab = el('button', { class: 'tab' + (on ? ' on' : ''), type: 'button', html: esc(label) + '<s>' + count + '</s>' });
    if (!on) tab.style.color = '';
    tab.dataset.key = key;
    tab.addEventListener('click', () => H.onType(key));
    if (on) tab.style.setProperty('background', 'rgba(255,255,255,.9)');
    host.appendChild(tab);
  }
}

/* -------------------------------------------------------------- 展台 */

export function renderStage() {
  const host = $('#stage-body');
  if (!host) return null;
  if (state.filter.type === 'text') return renderTextStage(host);
  const list = visibleItems();
  host.className = '';
  host.innerHTML = '';
  if (!list.length) {
    host.appendChild(el('div', { class: 'empty', text: state.resources.length ? '此条件没有匹配的资源' : '等待扫描' }));
    return host;
  }
  const grid = el('div', { class: 'grid' + (state.view === 'list' ? ' list' : '') });
  for (const item of list) grid.appendChild(cardNode(item));
  host.appendChild(grid);
  revealChildren(grid);
  hydrateFonts(grid);
  return grid;
}

function revealChildren(container) {
  const nodes = Array.prototype.slice.call(container.children);
  nodes.forEach((node, i) => {
    const delay = Math.min(i, 26) * 26;
    setTimeout(() => node.classList.add('in'), delay);
  });
}

export function appendCard(item) {
  const host = $('#stage-body');
  if (!host || state.filter.type === 'text') return;
  let grid = $('.grid', host);
  if (!grid) { renderStage(); return; }
  const empty = $('.empty', host);
  if (empty) empty.remove();
  if (!matchesFilter(item)) return;
  const card = cardNode(item);
  grid.appendChild(card);
  hydrateFonts(card);
  requestAnimationFrame(() => card.classList.add('in'));
}

function matchesFilter(item) {
  const f = state.filter;
  if (f.type !== 'all' && item.type !== f.type) return false;
  if (f.onlySel && !state.sel.has(item.id)) return false;
  if (f.onlyOk && item.status !== 'ok') return false;
  if (f.onlyOriginal && item.familySize > 1 && !item.familyBest) return false;
  const q = f.q.trim().toLowerCase();
  if (q && (item.name + ' ' + item.url + ' ' + item.type + ' ' + (item.host || '') + ' ' + (item.format || '') + ' '
    + (item.codec || '') + ' ' + (item.title || '') + ' ' + (item.creator || '') + ' ' + (item.fontName || '') + ' '
    + (item.kind || '') + ' ' + (item.flavor || '') + ' ' + (item.camera || '') + ' ' + (item.pageSize || '')).toLowerCase().indexOf(q) < 0) return false;
  return true;
}

/* -------------------------------------------------------------- 卡片 */

export function cardNode(item) {
  const info = typeOf(item.type);
  const card = el('article', {
    class: 'card' + (state.sel.has(item.id) ? ' sel' : '') + (item.status !== 'ok' ? ' bad' : ''),
    dataset: { id: item.id, type: item.type },
  });
  const thumb = el('div', { class: 'thumb' });
  thumb.appendChild(thumbContent(item, info));
  thumb.appendChild(el('span', { class: 'badge', text: info.label, style: 'color:' + info.color }));
  thumb.appendChild(el('button', {
    class: 'tick', type: 'button', title: '选择 / 取消（空格）',
    html: '&#10003;',
    onclick: (e) => { e.stopPropagation(); H.onSelect(item, card); },
  }));
  if (item.status !== 'ok') {
    thumb.appendChild(el('div', {
      class: 'status',
      html: '<span>' + esc(statusLabel(item.status)) + '</span><span class="err">' + esc(item.error || '') + '</span>',
    }));
  }
  if (item.count > 1) thumb.appendChild(el('span', { class: 'count', text: '×' + item.count + ' 处引用' }));
  if (item.dup) thumb.appendChild(el('span', { class: 'dup', text: '内容重复' }));
  if (item.sprite) thumb.appendChild(el('span', { class: 'flag sprite', text: '精灵图 ' + (item.symbols || '?') + ' 图' }));
  else if (item.animated) thumb.appendChild(el('span', { class: 'flag anim', text: item.frames ? '动画 ' + item.frames + ' 帧' : '动画' }));
  if (item.familySize > 1) thumb.appendChild(el('span', { class: 'flag fam' + (item.familyBest ? ' best' : ''), text: item.familyBest ? '同族原件 ×' + item.familySize : '同族缩略候选' }));
  if (item.rescued) thumb.appendChild(el('span', { class: 'flag rescue', title: esc(item.rescued), text: '按内容补探测' }));
  else if (item.iconFont) thumb.appendChild(el('span', { class: 'flag sprite', text: '图标字体' }));
  else if (item.encrypted) thumb.appendChild(el('span', { class: 'flag fam', text: '已加密' }));
  else if (item.live) thumb.appendChild(el('span', { class: 'flag anim', text: '直播流' }));
  const acts = el('div', { class: 'acts' });
  if (item.status === 'ok') {
    acts.appendChild(el('a', { class: 'icon-btn', href: item.inline ? '/api/inline?job=' + state.job + '&id=' + item.id + '&download=1' : downloadSrc(item.url, item.name), title: '下载原始文件', html: '&#8681;' }));
    acts.appendChild(el('button', { class: 'icon-btn', type: 'button', title: '复制地址', html: '&#8646;', onclick: (e) => { e.stopPropagation(); H.onCopy(item); } }));
  } else {
    acts.appendChild(el('button', { class: 'icon-btn', type: 'button', title: '重新探测', html: '&#8635;', onclick: (e) => { e.stopPropagation(); H.onRetry(item, card); } }));
  }
  card.appendChild(thumb);
  card.appendChild(acts);
  const metaBits = [];
  if (item.size) metaBits.push('<b>' + esc(bytesText(item.size)) + '</b>');
  else metaBits.push('体积未知');
  if (item.width && item.height) metaBits.push(esc(pixels(item.width, item.height)));
  if (item.duration) metaBits.push(esc(fmtDuration(item.duration)));
  if (item.entries > 1 && item.sizes) metaBits.push(item.entries + ' 尺寸');
  if (item.pages) metaBits.push(item.pages + ' 页');
  if (item.kind) metaBits.push(esc(item.kind + (item.variantCount ? ' ×' + item.variantCount : '')));
  if (item.fontName) metaBits.push(esc(item.fontName));
  if (item.camera) metaBits.push(esc(item.camera.split(' ')[0]));
  if (item.codec) metaBits.push(esc(item.codec));
  if (item.ext) metaBits.push(esc(item.ext.toUpperCase()));
  if (item.provenance === 'inferred' || item.provenance === 'json') metaBits.push('推断');
  card.appendChild(el('div', { class: 'body', html: '<div class=\"name\" title=\"' + esc(item.name || item.url) + '\">' + esc(item.name || '(内联资源)') + '</div><div class=\"meta\">' + metaBits.join('<i>/</i>') + '</div>' }));
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    H.onOpen(item);
  });
  if (H.onTilt) H.onTilt(card);
  return card;
}

function statusLabel(s) {
  return { missing: '404 不存在', blocked: '403 被拒绝', timeout: '超时', dns: '域名无法解析', error: '无法访问', skipped: '未探测', pending: '未探测' }[s] || String(s).toUpperCase();
}

function thumbContent(item, info) {
  const src = item.inline ? '/api/inline?job=' + encodeURIComponent(state.job || '') + '&id=' + encodeURIComponent(item.id) : proxySrc(item.url, item.name);
  if ((item.type === 'image' || item.type === 'icon') && item.status === 'ok') {
    return el('img', { src: src, alt: item.alt || item.name || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  }
  if (item.type === 'vector' && item.status === 'ok') {
    return el('img', { src: src, alt: item.alt || item.name || '', loading: 'lazy', style: 'width:70%;height:70%;object-fit:contain;padding:8%' });
  }
  if (item.type === 'video' && item.status === 'ok') {
    const v = el('video', { muted: true, loop: true, playsinline: true, preload: 'none',poster: '', style: 'width:100%;height:100%;object-fit:cover' });
    v.appendChild(el('source', { src: src, type: item.mime || '' }));
    v.addEventListener('pointerenter', () => { try { v.play(); } catch { /* noop */ } });
    v.addEventListener('pointerleave', () => { try { v.pause(); v.currentTime = 0; } catch { /* noop */ } });
    const wrap = el('div', { style: 'position:relative;width:100%;height:100%' }, [v, el('span', { class: 'glyph', style: 'position:absolute;inset:0;display:grid;place-items:center;font-size:2rem;color:' + info.color + ';text-shadow:0 0 22px rgba(0,0,0,.8)', text: '▶' })]);
    return wrap;
  }
  if (item.type === 'audio' && item.status === 'ok') {
    const canvas = el('canvas', { width: 240, height: 180, style: 'width:100%;height:100%' });
    setTimeout(() => drawWave(canvas, item.url + (item.name || ''), info.color), 0);
    return canvas;
  }
  if (item.type === 'font' && item.status === 'ok') {
    return fontSpecimen(item, src);
  }
  if (item.sample) {
    return el('pre', { text: String(item.sample).slice(0, 900) });
  }
  const box = el('div', { style: 'position:absolute;inset:0;display:grid;place-items:center' });
  box.appendChild(el('span', { class: 'ext', text: (item.ext || info.glyph).toUpperCase().slice(0, 5) }));
  return box;
}

function fontSample(item) {
  const alt = String(item.alt || '');
  if (alt && /[\u4e00-\u9fff]/.test(alt)) return '永 ' + alt.slice(0, 2);
  return 'Aa 永 0123';
}

/** 字体样本：进入视口才注入 @font-face，避免一次性拉取上百个子集 */
function fontSpecimen(item, src) {
  return el('div', { class: 'font-specimen', dataset: { pending: src, fam: 'spec-' + item.id }, html: esc(fontSample(item)) });
}

/** 挂载后调用：为已进入/即将进入视口的字体样本注入 @font-face */
export function hydrateFonts(root) {
  const nodes = (root || document).querySelectorAll('.font-specimen[data-pending]');
  if (!nodes.length) return;
  const inject = (node) => {
    if (!node.dataset.pending) return;
    const src = node.dataset.pending;
    const fam = node.dataset.fam;
    delete node.dataset.pending;
    const style = document.createElement('style');
    style.textContent = '@font-face{font-family:\"' + fam + '\";src:url(\"' + src + '\");font-display:swap}';
    document.head.appendChild(style);
    node.style.fontFamily = '"' + fam + '", var(--sans)';
    node.style.fontSize = '26px';
  };
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(nodes, inject);
    return;
  }
  // 先把已经在视口里的注入（不依赖 IO 首帧），其余交给观察者
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const rest = [];
  Array.prototype.forEach.call(nodes, (n) => {
    const r = n.getBoundingClientRect();
    if (r.bottom > -320 && r.top < vh + 320) inject(n);
    else rest.push(n);
  });
  if (!rest.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        inject(entry.target);
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: '300px 0px' });
  rest.forEach((n) => io.observe(n));
  fontIOs.push(io);
  if (fontIOs.length > 8) {
    const old = fontIOs.shift();
    try { old.disconnect(); } catch { /* noop */ }
  }
}

const fontIOs = [];

function drawWave(canvas, seed, color) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const rnd = () => {
    hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
    return ((hash >>> 0) % 10000) / 10000;
  };
  ctx.clearRect(0, 0, w, h);
  const bars = 42;
  const bw = w / bars;
  for (let i = 0; i < bars; i++) {
    const env = Math.sin((i / bars) * Math.PI) * 0.65 + 0.35;
    const amp = (0.2 + rnd() * 0.8) * env;
    const bh = amp * h * 0.72;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25 + amp * 0.5;
    ctx.fillRect(i * bw + bw * 0.22, (h - bh) / 2, bw * 0.56, bh);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.1)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

/* ------------------------------------------------------------ 文案视图 */

function renderTextStage(host) {
  host.className = '';
  host.innerHTML = '';
  const list = visibleTexts();
  const top = el('div', { style: 'display:grid;gap:1.1rem;margin-bottom:1.3rem' });
  if (state.keywords.length) {
    const kw = el('div', { class: 'kw' });
    for (const k of state.keywords) {
      kw.appendChild(el('span', {
        html: esc(k.term) + '<b>' + k.count + '</b>',
        title: '作为筛选词', onclick: () => { $('#filter').value = k.term; state.filter.q = k.term; H.onQuery(k.term); },
      }));
    }
    top.appendChild(el('div', {}, [el('h3', { text: '关键词 / keywords' }), kw]));
  }
  if (state.headings.length) {
    const ol = el('div', { class: 'outline' });
    for (const h of state.headings.slice(0, 40)) {
      ol.appendChild(el('div', {
        style: 'padding-left:' + Math.max(0, (h.level - 1) * 0.9) + 'rem',
        html: '<i>h' + h.level + '</i><span>' + esc(h.text.slice(0, 80)) + '</span>',
        onclick: () => { const row = document.querySelector('.trow[data-text-search=\"' + CSS.escape(h.text.slice(0, 24)) + '\"]'); if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
      }));
    }
    top.appendChild(el('div', {}, [el('h3', { text: '标题骨架 / outline' }), ol]));
  }
  host.appendChild(top);
  if (!list.length) {
    host.appendChild(el('div', { class: 'empty', text: '没有匹配的文案段落' }));
    return host;
  }
  const wrap = el('div', { class: 'texts' });
  for (const b of list) wrap.appendChild(textRow(b));
  host.appendChild(wrap);
  revealChildren(wrap);
  return wrap;
}

export function textRow(block) {
  const row = el('div', {
    class: 'trow' + (state.selText.has(block.id) ? ' sel' : ''),
    dataset: { textid: block.id, level: block.level || 0, tag: block.tag, zone: block.zone, textSearch: block.text.slice(0, 24) },
  });
  row.appendChild(el('span', { class: 'tick', html: '&#10003;' }));
  const txt = el('div', { class: 'txt' });
  txt.appendChild(el('span', { class: 'tagpill', text: block.tag + (block.level ? block.level : '') }));
  txt.appendChild(el('span', { class: 'body', text: block.text }));
  row.appendChild(txt);
  const side = el('div', { class: 'side' });
  side.appendChild(el('span', { text: fmtNum(block.chars) + ' 字' }));
  if (block.line) side.appendChild(el('span', { text: 'L' + block.line }));
  if (block.zone === 'noise') side.appendChild(el('span', { text: '噪音区', style: 'color:#ffd166' }));
  side.appendChild(el('span', { class: 'icon-btn', style: 'width:22px;height:22px', html: '&#8646;', title: '复制这段', onclick: (e) => { e.stopPropagation(); H.onCopyText(block); } }));
  row.appendChild(side);
  row.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn')) return;
    H.onSelectText(block, row);
  });
  return row;
}

/* -------------------------------------------------------------- 详情 */

export function detailHtml(item) {
  const info = typeOf(item.type);
  const src = item.inline ? '/api/inline?job=' + encodeURIComponent(state.job || '') + '&id=' + encodeURIComponent(item.id) : proxySrc(item.url, item.name);
  let view;
  if (item.type === 'image' || item.type === 'icon' || item.type === 'vector') view = '<img class="full" style="object-fit:contain" src="' + esc(src) + '" alt="' + esc(item.alt || '') + '">';
  else if (item.type === 'video') view = '<video class="full" controls playsinline preload="metadata" src="' + esc(src) + '"></video>';
  else if (item.type === 'audio') view = '<div style="width:100%;padding:1rem"><canvas id="big-wave" width="900" height="220" style="width:100%;height:180px"></canvas><audio controls preload="metadata" src="' + esc(src) + '" style="width:100%;margin-top:.8rem"></audio></div>';
  else if (item.sample) view = '<pre>' + esc(item.sample) + '</pre>';
  else if (item.status === 'ok') view = '<div class="oopssh">该类型无法在浏览器内预览<br><a href="' + esc(src) + '&download=1" style="color:#b8ff3c">直接下载原文件</a></div>';
  else view = '<div class="oopssh">' + esc(statusLabel(item.status)) + '<br>' + esc(item.error || '') + '</div>';
  const rows = [];
  const yes = (txt) => txt || '是';
  rows.push(['类型', info.label + ' / ' + info.en]);
  rows.push(['状态', item.status === 'ok' ? '可导出' : statusLabel(item.status)]);
  rows.push(['原始体积', item.size ? bytesText(item.size) + ' (' + fmtNum(item.size) + ' 字节)' : '未知']);
  if (item.width && item.height) rows.push(['像素尺寸', item.width + ' × ' + item.height + ' · ' + ((item.width * item.height) / 1e6).toFixed(2) + ' MP' + (item.vector ? '（矢量按 viewBox 换算）' : '')]);
  if (item.duration) rows.push(['时长', fmtDuration(item.duration)]);
  if (item.animated) rows.push(['动画', yes([item.frames ? item.frames + ' 帧' : '', item.duration ? '一轮 ' + fmtDuration(item.duration) : '', item.keyframes ? item.keyframes + ' 个关键帧' : '', item.disposal ? '处置：' + item.disposal : '', item.overwrite ? '不混合直接覆盖' : ''].filter(Boolean).join(' · '))]);
  if (item.transparent) rows.push(['透明', yes('整幅带透明索引')]);
  if (item.sprite) rows.push(['图标精灵', item.symbols + ' 个 symbol（同一片画布上的多个图标）']);
  if (item.entries > 1 && item.sizes) rows.push(['内含尺寸', item.entries + ' 张：' + (item.sizes || '')]);
  if (item.bitDepth) rows.push(['位深', item.bitDepth + ' bit' + (item.channels ? ' · ' + item.channels + ' 通道' : '') + (item.alpha ? ' · 带透明通道' : '')]);
  if (item.colorSpace) rows.push(['色彩空间', item.colorSpace + (item.progressive ? ' · 渐进式扫描' : item.baseline ? ' · 顺序扫描' : '')]);
  if (item.interlaced) rows.push(['隔行', 'Adam7 隔行扫描']);
  if (item.orientation) rows.push(['EXIF 方向', '值 ' + item.orientation + ' · ' + ({ 1: '正常', 2: '水平镜像', 3: '旋转 180°', 4: '垂直镜像', 5: '顺时针 90° + 镜像', 6: '顺时针 90°', 7: '逆时针 90° + 镜像', 8: '逆时针 90°' })[item.orientation]]);
  if (item.rotation) rows.push(['画面旋转', item.rotation + '°（尺寸已按显示方向换算）']);
  if (item.sampleRate) rows.push(['音频参数', fmtNum(item.sampleRate) + ' Hz' + (item.channels ? ' · ' + (item.channels === 2 ? '立体声' : item.channels + ' 声道') : '') + (item.bit ? ' · ' + item.bit + ' bit' : '')]);
  if (item.bitrate) rows.push(['码率', fmtNum(Math.round(item.bitrate / 1000)) + ' kbps' + (item.vbr ? '（可变）' : item.cbr ? '（恒定）' : '')]);
  if (item.codec) rows.push(['编码', item.codec]);
  if (item.shapes) rows.push(['矢量元素', item.shapes + ' 个图形' + (item.effects ? ' · ' + item.effects + ' 个渐变 / 滤镜' : '')]);
  if (item.exifRead) rows.push(['EXIF', '已解析 ' + item.exifRead + ' 项']);
  if (item.camera) rows.push(['拍摄设备', item.camera + (item.lensModel ? ' · ' + item.lensModel : '')]);
  if (item.dateTimeOriginal) rows.push(['拍摄时间', item.dateTimeOriginal]);
  if (item.iso || item.shutterLabel || item.apertureLabel || item.focalLength35) rows.push(['曝光参数', [item.shutterLabel ? '快门 ' + item.shutterLabel : '', item.apertureLabel ? '光圈 ' + item.apertureLabel : '', item.iso ? 'ISO ' + item.iso : '', item.focalLength35 ? '等效 ' + item.focalLength35 + 'mm' : ''].filter(Boolean).join(' · ')]);
  if (item.gps) rows.push(['GPS', '内嵌经纬度']);
  if (item.thumbnailOnly) rows.push(['读取范围', '只取到缩略图，主图尺寸待定']);
  if (item.comment) rows.push(['注释', String(item.comment)]);
  if (item.tracks) rows.push(['轨道', item.tracks + ' 条' + (item.trackKinds ? '：' + item.trackKinds : '')]);
  if (item.frameRate) rows.push(['帧率', item.frameRate + ' fps']);
  if (item.brand) rows.push(['容器', item.brand + (item.compatibleBrands ? ' · 兼容 ' + item.compatibleBrands : '')]);
  if (item.faststart) rows.push(['流式播放', 'moov 前置（faststart，可边下边播）']);
  if (item.fragmented) rows.push(['分片封装', 'fMP4 / fragmented']);
  if (item.edited) rows.push(['编辑列表', item.edited + ' 段']);
  if (item.chunkOffsets) rows.push(['采样块', fmtNum(item.chunkOffsets) + ' 块' + (item.sttsRun ? ' · ' + item.sttsRun + ' 种帧长' : '')]);
  if (item.created) rows.push(['创建时间', item.created]);
  if (item.modified && item.modified !== item.created) rows.push(['修改时间', item.modified]);
  if (item.container) rows.push(['封装', item.container]);
  if (item.interleaved) rows.push(['交错存放', '音视频帧交错']);
  if (item.cover) rows.push(['内嵌封面', (item.cover && item.cover.mime) || '图片']);
  if (item.title || item.album) {
    rows.push(['音频标签', [item.title, item.artist, item.album].filter(Boolean).join(' · ')]);
    const tag = [item.genre, item.year, item.track && item.track !== '/' ? '曲目 ' + item.track : '', item.language].filter(Boolean).join(' · ');
    if (tag) rows.push(['流派 / 年份', tag]);
    if (item.tagVersion) rows.push(['标签版本', item.tagVersion]);
  }
  if (item.kind) rows.push(['流媒体清单', item.kind + (item.playlistInfo ? ' · ' + item.playlistInfo : '')]);
  if (item.variantList && item.variantList.length) rows.push(['清晰度档位', item.variantList.join(' / ')]);
  if (item.segments) rows.push(['分片', fmtNum(item.segments) + ' 片' + (item.segmentDuration ? ' · 每片 ' + item.segmentDuration + ' 秒' : '') + (item.live ? ' · 直播' : '')]);
  if (item.subtitleTracks) rows.push(['字幕轨', item.subtitleTracks + ' 条' + (item.languages && item.languages.length ? ' · ' + item.languages.join('/') : '')]);
  if (item.adaptive) rows.push(['自适应码率', '是']);
  if (item.encrypted) rows.push(['加密', '容器内加密（需密钥解码）']);
  if (item.pages) rows.push(['页数', fmtNum(item.pages) + ' 页' + (item.pageSize ? ' · ' + item.pageSize : '')]);
  if (item.pageWidth) rows.push(['页面尺寸', item.pageWidth + ' × ' + item.pageHeight + ' pt']);
  if (item.docTitle || item.creator) rows.push(['文档信息', [item.docTitle || item.title, item.creator].filter(Boolean).join(' · ')]);
  if (item.subject) rows.push(['主题', item.subject]);
  if (item.keywords) rows.push(['关键词', item.keywords]);
  if (item.producer || item.software) rows.push(['生成工具', [item.producer, item.software].filter(Boolean).join(' · ')]);
  if (item.forms) rows.push(['表单 / 批注', item.forms + ' 个表单域' + (item.annotations ? ' · ' + item.annotations + ' 条批注' : '')]);
  if (item.linearized) rows.push(['PDF 优化', '线性化（可边下边看）']);
  if (item.appended) rows.push(['增量保存', '尾部追加对象']);
  if (item.incomplete && item.type !== 'image') rows.push(['读取范围', '尾部未完整到达，按已有字节解析']);
  if (item.flavor) rows.push(['文档结构', String(item.flavor).toUpperCase() + '（' + (item.entries ? fmtNum(item.entries) + ' 个内部文件' : '') + (item.uncompressedBytes ? ' · 解压后 ' + bytesText(item.uncompressedBytes) : '') + '）']);
  if (item.mediaFiles) rows.push(['包内媒体', item.mediaFiles + ' 个图片 / 音视频']);
  if (item.words) rows.push(['篇幅', fmtNum(item.words) + ' 词' + (item.paragraphs ? ' · ' + fmtNum(item.paragraphs) + ' 段' : '') + (item.textChars ? ' · ' + fmtNum(item.textChars) + ' 字符' : '')]);
  if (item.sheets) rows.push(['工作表', fmtNum(item.sheets) + ' 张' + (item.textCells ? ' · ' + fmtNum(item.textCells) + ' 个文本单元格' : '')]);
  if (item.spine) rows.push(['阅读顺序', item.spine + ' 章' + (item.images ? ' · ' + item.images + ' 张插图' : '')]);
  if (item.fontName || item.family) {
    rows.push(['字体', [item.fontName || [item.family, item.style].filter(Boolean).join(' '), item.postscriptName].filter(Boolean).join(' · ')]);
    const metric = [item.glyphs ? fmtNum(item.glyphs) + ' 字形' : '', item.unitsPerEm ? 'upem ' + item.unitsPerEm : '', item.weightClass ? '字重 ' + item.weightClass : '', item.widthClass ? '宽度类 ' + item.widthClass : '', item.italicAngle ? '斜度 ' + item.italicAngle : ''].filter(Boolean).join(' · ');
    if (metric) rows.push(['字体度量', metric]);
    if (item.fontFlavor) rows.push(['字体轮廓', item.fontFlavor + (item.numTables ? ' · ' + item.numTables + ' 张表' : '') + (item.sfntSize ? ' · 展开 ' + bytesText(item.sfntSize) : '')]);
    if (item.iconFont) rows.push(['图标字体', '是（字形多为界面小图标）']);
    if (item.colorFont) rows.push(['彩色字体', item.colorFont]);
    if (item.features) rows.push(['OpenType 特性', item.features]);
    if (item.embedding) rows.push(['嵌入许可', item.embedding]);
    if (item.license) rows.push(['授权', item.license]);
    if (item.designer) rows.push(['设计者', item.designer]);
  }
  if (item.declaredFrom && item.declaredWidth) rows.push(['声明尺寸', item.declaredWidth + 'px · ' + item.declaredFrom]);
  if (item.cdn) rows.push(['图片服务', [item.cdn.p, item.cdn.w || item.cdn.h ? (item.cdn.sq ? (item.cdn.w || item.cdn.h) + 'px 见方' : (item.cdn.w || '?') + '×' + (item.cdn.h || '?')) : '', item.cdn.dpr ? item.cdn.dpr + 'x 密度' : '', item.cdn.q ? '质量 ' + item.cdn.q : '', item.cdn.ext ? '输出 .' + item.cdn.ext : '', item.cdn.inner ? '内层原图' : ''].filter(Boolean).join(' · ')]);
  if (item.viaProxy) rows.push(['代理内层', hostUrl(item.viaProxy)]);
  if (item.cssProp) rows.push(['CSS 属性', item.cssProp + (item.imageSet ? ' · image-set' : '')]);
  if (item.fontFormat) rows.push(['字体格式声明', '@font-face format(' + item.fontFormat + ')']);
  if (item.metaKey) rows.push(['meta 属性', item.metaKey]);
  if (item.rescued) rows.push(['补探测理由', item.rescued + '（地址无法直接归类，按内容线索请求）']);
  if (item.extCorrected) rows.push(['后缀修正', '.' + item.extCorrected + ' → .' + item.ext + '（按真实字节）']);
  if (item.transport) rows.push(['传输编码', item.transport === 'gzip' ? 'gzip（已解压读取真实字节）' : String(item.transport)]);
  if (item.loops) rows.push(['循环次数', String(item.loops)]);
  if (item.dpi) rows.push(['分辨率', fmtNum(item.dpi) + ' DPI']);
  if (item.lossless) rows.push(['压缩方式', '无损']);
  if (item.maxVal) rows.push(['通道峰值', String(item.maxVal)]);
  if (item.mipLevels) rows.push(['Mipmap', item.mipLevels + ' 级' + (item.cubemap ? ' · 立方体' : '') + (item.volume ? ' · 体积纹理' : '') + (item.arraySize > 1 ? ' · 数组 ' + item.arraySize : '')]);
  if (item.hdr) rows.push(['高动态范围', '是（' + (item.compressed ? '有损压缩' : '未压缩') + '）']);
  if (item.background) rows.push(['自带背景', item.background]);
  if (item.embeddedImages) rows.push(['SVG 内嵌位图', item.embeddedImages + ' 张']);
  if (item.uses) rows.push(['use 引用', item.uses + ' 处']);
  if (item.textNodes) rows.push(['SVG 文字', item.textNodes + ' 个 <text>（未被栅格化）']);
  if (item.svgTitle || item.svgDesc) rows.push(['SVG 标题 / 描述', [item.svgTitle, item.svgDesc].filter(Boolean).join(' · ')]);
  if (item.svgScript) rows.push(['SVG 脚本', '含 <script>，内嵌需谨慎']);  if (item.familySize > 1) rows.push(['同族资源', item.familyBest ? '这是同族中尺寸最大的原件（共 ' + item.familySize + ' 个尺寸写法）' : '与原件同族（原件 ' + item.familySize + ' 个尺寸之一）']);
  rows.push(['MIME', item.mime || '—']);
  rows.push(['格式判定', item.format || '—']);
  rows.push(['来源标签', '<' + (item.tag || '?') + '> ' + (item.attr || '')]);
  rows.push(['识别方式', (PROV_LABEL[item.provenance] || item.provenance || '') + (item.fromCss ? ' · 来自 ' + hostUrl(item.fromCss) : '')]);
  if (item.selector) rows.push(['命中选择器', item.selector]);
  if (item.density) rows.push(['srcset 密度', item.density + 'x']);
  if (item.declaredWidth) rows.push(['声明宽度', item.declaredWidth + 'px']);
  if (item.count > 1) rows.push(['页面引用', item.count + ' 处']);
  if (item.line) rows.push(['文档行号', '第 ' + item.line + ' 行']);
  if (item.alt) rows.push(['替代文本', item.alt]);
  if (item.host) rows.push(['主机', item.host]);
  if (item.page) rows.push(['来源页面', item.page]);
  return '<div class="view">' + view + '</div>'
    + '<div class="info">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem"><div class="name">' + esc(item.name || '内联资源') + '</div><button class="icon-btn close" data-close>✕</button></div>'
    + '<div class="url">' + esc(item.url || 'data URI · 内联于文档中') + '</div>'
    + '<dl>' + rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd>').join('') + '</dl>'
    + '<div class="row-acts">' + (item.status === 'ok'
      ? '<a class="dbtn" href="' + esc(src) + (item.inline ? '&download=1' : '&download=1') + '">下载原文件</a><button class="dbtn" data-copy>复制地址</button>' + (item.url ? '<button class="dbtn" data-open>新窗口打开</button>' : '')
      : '<button class="dbtn" data-retry>重新探测</button>')
    + '<button class="dbtn ' + (state.sel.has(item.id) ? 'ghost' : '') + '" data-toggle>' + (state.sel.has(item.id) ? '取消选择' : '加入导出') + '</button>'
    + '</div>'
    + '<div class="hint-line">导出使用该地址的完整响应字节，图片不会被重压缩，音视频不会被转码。</div>'
    + '</div>';
}

export function textDetailHtml(block) {
  return '<div class="view"><div style="padding:2rem;font-size:17px;line-height:1.9;max-width:60ch">' + esc(block.text) + '</div></div>'
    + '<div class="info">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem"><div class="name">' + esc(block.tag) + ' 段落</div><button class="icon-btn close" data-close>✕</button></div>'
    + '<dl>'
    + '<dt>字数</dt><dd>' + fmtNum(block.chars) + '</dd>'
    + '<dt>词数</dt><dd>' + fmtNum(block.words) + '</dd>'
    + '<dt>区域</dt><dd>' + (block.zone === 'noise' ? '噪音（导航/页脚）' : block.zone === 'main' ? '正文区 main' : '一般内容') + '</dd>'
    + (block.line ? '<dt>行号</dt><dd>第 ' + block.line + ' 行</dd>' : '')
    + (block.cls ? '<dt>class</dt><dd>' + esc(block.cls) + '</dd>' : '')
    + '</dl>'
    + '<div class="row-acts"><button class="dbtn" data-copytext>复制这段</button><button class="dbtn ' + (state.selText.has(block.id) ? 'ghost' : '') + '" data-toggletext>' + (state.selText.has(block.id) ? '取消选择' : '加入文案导出') + '</button></div>'
    + '</div>';
}

/* ------------------------------------------------------------ 导出坞 */

export function renderDock() {
  const dock = $('#dock');
  const sel = selectedItems().length;
  const selT = state.selText.size;
  const show = sel > 0 || selT > 0;
  if (dock) dock.classList.toggle('on', !!show);
  const cnt = $('#dock-count');
  const size = $('#dock-size');
  if (cnt) cnt.textContent = String(sel);
  if (size) size.textContent = bytesText(selectionBytes()) + (selT ? ' + ' + selT + ' 段文案' : '');
  renderDrawerRows();
}

function renderDrawerRows() {
  const host = $('#drawer-rows');
  if (!host) return;
  host.innerHTML = '';
  const byType = new Map();
  for (const r of selectedItems()) {
    const list = byType.get(r.type) || [];
    list.push(r);
    byType.set(r.type, list);
  }
  if (byType.size) {
    host.appendChild(el('button', { type: 'button', html: '<span>已选全部 · 单个 ZIP</span><b>' + selectedItems().length + ' 项 / ' + esc(bytesText(selectionBytes())) + '</b>', onclick: () => H.onExport({ mode: 'selected' }) }));
    for (const key of TYPE_ORDER) {
      const list = byType.get(key);
      if (!list) continue;
      const bytes = list.reduce((n, r) => n + (r.size || 0), 0);
      host.appendChild(el('button', {
        type: 'button',
        html: '<span style=\"color:' + TYPES[key].color + '\">' + esc(TYPES[key].label) + ' / ' + esc(TYPES[key].en) + '</span><b>' + list.length + ' 项 / ' + esc(bytesText(bytes)) + '</b>',
        onclick: () => H.onExport({ mode: 'selected-by-type', types: [key] }),
      }));
    }
  }
  if (state.resources.length) {
    host.appendChild(el('button', { type: 'button', html: '<span>整站可导出项 · 按类型分目录</span><b>' + totals().ok + ' 项</b>', onclick: () => H.onExport({ mode: 'all' }) }));
  }
  if (state.texts.length) {
    for (const fmt of ['md', 'csv', 'json', 'html', 'txt']) {
      host.appendChild(el('button', { type: 'button', html: '<span>全部文案 → ' + fmt.toUpperCase() + '</span><s>' + fmtNum(totals().chars) + ' 字</s>', onclick: () => H.onExportText({ format: fmt, mode: 'all' }) }));
    }
  }
  if (!host.children.length) host.appendChild(el('div', { class: 'spec-empty', text: '先勾选一些资源' }));
}

export { countTo };