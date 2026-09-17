/**
 * 页面预览 —— 扫描后把原始页面按版式呈现出来，并允许「在页面中框选或勾选元素导出」。
 *
 * 链路：
 *   /api/preview 返回去掉脚本的静态快照 → 同源 iframe（sandbox 不给 allow-scripts）
 *   → 外层把扫描结果按地址逐一对回 DOM 元素 → 影子层里画出可点选/可勾选的资源框
 *   → 勾选 / 区域框选 / 按类型与筛选联动 / 文案块模式 → 选完直接在页面上一键导出。
 *
 * 与页面 CSS 隔离：叠加层用 shadow root，站点样式进不来，我们的样式也不影响站点。
 */
import { el, esc, bytesText, fmtNum, typeOf, TYPES, clamp } from './util.js';
import { state, visibleItems, visibleTexts, pickSelection, putResource, putTexts } from './store.js';
import {
  absKey, elementKeys, computedCssUrls, blockKey, normText, INLINE_TAGS, box, overlap,
  regionStep, regionOf, regionLabel, REGION_ROOT,
} from './pv-match.js';

let H = {};
export function mountPreview(handlers) { H = handlers || {}; }

const MAX_ELEMS = 26000;
const MAX_COMPUTED = 9000;
const MAX_BOXES = 1500;
const MAX_TEXT_BOXES = 900;
const MAX_HEIGHT = 16000;
const VIEWPORTS = [1920, 1440, 1280, 1024, 820, 640, 390];
const ZOOMS = [['fit', '适配'], [1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.3, '30%']];
const BLOCK_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'blockquote', 'figcaption', 'caption',
  'td', 'th', 'pre', 'address', 'summary', 'option', 'label', 'article', 'section', 'aside', 'main', 'div', 'a'];

const S = {
  gen: 0, frame: null, canvas: null, viewport: null, host: null, doc: null, win: null,
  layer: null, root: null, wrap: null, cap: null, mq: null, mqBadge: null, boxHost: null, foot: null, stat: null, loading: null,
  boxes: [], base: '', pageUrl: '', pageMeta: null,
  zoom: 'fit', width: 1440, k: 1, docW: 1440, docH: 800, truncated: false,
  mode: 'res', tool: 'pick', region: false, excluded: false, force: false, marks: true, regions: [],
  ready: false, regionIds: [], regionTexts: [],
  mappedCount: 0, unmapped: [], timers: [], io: null,
};

/* ============================================================== 界面 */

/** 面板按任务挂载一次即可：切标签页 / 改筛选都只是重绘叠加层，不重新载入 iframe */
export function previewMounted(jobId) {
  return !!S.host && S.host.isConnected && (!jobId || S.job === jobId);
}

export function setPreviewMode(mode) {
  if (mode !== 'res' && mode !== 'text') return;
  S.mode = mode;
  setRegionMode();
  if (S.ready) remap(S.gen);
  const host = document.getElementById('pv-mode');
  if (host) Array.prototype.forEach.call(host.children, (x, i) => x.classList.toggle('on', (i === 0) === (mode === 'res')));
}

export function setPreviewTool(tool) {
  if (tool !== 'pick' && tool !== 'marquee') return;
  S.tool = tool;
  const host = document.getElementById('pv-tool');
  if (host) Array.prototype.forEach.call(host.children, (x, i) => x.classList.toggle('on', (i === 0) === (tool === 'pick')));
}

export function renderPreviewStage(host) {
  const gen = ++S.gen;
  S.job = state.job;
  clearTimers();
  S.boxes = []; S.regionIds = []; S.regionTexts = []; S.ready = false; S.mappedCount = 0; S.unmapped = [];
  host.className = 'preview-stage';
  host.innerHTML = '';

  const pages = (state.pages && state.pages.length ? state.pages : [{ url: state.url, title: '主页面', main: true }]);
  if (!S.pageUrl || !pages.some((pg) => pg.url === S.pageUrl)) {
    const main = pages.find((pg) => pg.main) || pages[0];
    S.pageUrl = main.url;
  }
  S.pageMeta = pages.find((pg) => pg.url === S.pageUrl) || pages[0];

  const bar = el('div', { class: 'pv-bar' });
  const urlBox = el('div', { class: 'pv-url-box' });
  urlBox.appendChild(el('span', { class: 'pv-url-tag', text: 'URL' }));
  const urlInp = el('input', {
    class: 'pv-url-input',
    type: 'text',
    value: S.pageUrl || state.url || '',
    placeholder: '输入网址并按回车直接打开…',
    spellcheck: 'false',
  });
  const urlGo = el('button', { class: 'pv-url-btn', type: 'button', text: '打开 ↵' });
  const triggerGo = () => {
    const nextUrl = urlInp.value.trim();
    if (!nextUrl) return;
    if (H.onNavigate) H.onNavigate(nextUrl);
    else {
      S.pageUrl = nextUrl;
      loadFrame(S.gen);
    }
  };
  urlInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerGo(); } });
  urlGo.addEventListener('click', triggerGo);
  urlBox.appendChild(urlInp);
  urlBox.appendChild(urlGo);
  bar.appendChild(urlBox);
  bar.appendChild(spacer());

  bar.appendChild(segControl('pv-mode', [['res', '资源标记'], ['text', '文案块']], S.mode,
    (v) => { S.mode = v; setRegionMode(); remap(gen); }));
  bar.appendChild(spacer());
  bar.appendChild(segControl('pv-tool', [['pick', '↖ 勾选模式 (V)'], ['marquee', '⬚ 框选模式 (M)']], S.tool,
    (v) => { S.tool = v; setPreviewTool(v); }));
  bar.appendChild(spacer());
  bar.appendChild(toggleButton('全选本页', () => selectAllOnPage(), () => false));
  bar.appendChild(toggleButton('反选', () => invertSelectionOnPage(), () => false));
  bar.appendChild(toggleButton('含已排除', () => { S.excluded = !S.excluded; remap(gen); }, () => S.excluded));
  bar.appendChild(toggleButton('强制显形', () => { S.force = !S.force; applyForce(); }, () => S.force));
  bar.appendChild(toggleButton('标注非扫描区', () => { S.marks = !S.marks; paintRegions(); layoutRegions(); }, () => S.marks,
    '按扫描服务端的同一套规则，把页眉 / 导航菜单 / 页脚 / 侧栏 / 表单 / 挂件框成虚线区（这些地方的引用不会被扫描），并框出主体内容区'));
  bar.appendChild(spacer());
  bar.appendChild(selectControl('宽', VIEWPORTS.map((w) => [w, w + ' px']), S.width, (v) => { S.width = Number(v); relayout(gen); }));
  bar.appendChild(segControl('pv-zoom', ZOOMS.map((z) => [String(z[0]), z[1]]), String(S.zoom),
    (v) => { S.zoom = v === 'fit' ? 'fit' : Number(v); applyZoom(); }));
  bar.appendChild(spacer());
  bar.appendChild(toggleButton('重算位置', () => { relayout(gen, true); }, () => false));
  if (pages.length > 1) {
    bar.appendChild(selectControl('页', pages.map((pg) => [pg.url, (pg.main ? '◆ ' : '') + shortTitle(pg)
      + '（' + fmtNum(pg.resources || 0) + ' 引用 · ' + fmtNum(pg.text || 0) + ' 段文案）']), S.pageUrl,
      (v) => { S.pageUrl = v; S.pageMeta = pages.find((pg) => pg.url === v) || null; loadFrame(gen); }));
  }
  bar.appendChild(el('a', { class: 'pv-btn', href: previewUrl(), target: '_blank', rel: 'noopener', title: '在新标签页打开这份静态快照', text: '原页 ↗' }));
  S.stat = el('span', { class: 'pv-stat', id: 'pv-stat', text: '正在载入原始页面…' });
  bar.appendChild(S.stat);

  const hint = el('div', { class: 'pv-hint' }, [
    el('b', { class: 'dot' }),
    el('span', { html: '页面实时交互 · 在页面中直接<b>框选</b>或<b>勾选</b>元素进行导出。' }),
    el('span', { class: 'sep', text: '｜' }),
    el('span', { html: '<b>点选/勾选</b> 切换元素 · <b>⇧ + 点击</b> 连续多选 · <b>按住鼠标拖动</b> 区域框选（按住 ⇧ 叠加 / ⌥ 减选）· <b>⌥ + 点击</b> 查看详情 · <b>V/M</b> 切换工具' }),
  ]);

  S.viewport = el('div', { class: 'pv-viewport' });
  S.canvas = el('div', { class: 'pv-canvas' });
  S.frame = el('iframe', {
    class: 'pv-frame', title: '原始页面预览', sandbox: 'allow-same-origin',
    referrerpolicy: 'no-referrer', src: previewUrl(),
  });
  S.loading = el('div', { class: 'pv-loading' }, [el('i'), el('span', { text: '正在取回原始页面…' })]);
  S.canvas.appendChild(S.frame);
  S.canvas.appendChild(S.loading);
  S.viewport.appendChild(S.canvas);
  S.foot = el('div', { class: 'pv-foot' });
  S.host = host;
  host.appendChild(el('div', { class: 'pv' }, [bar, hint, S.viewport, S.foot]));
  renderFoot();

  S.frame.addEventListener('load', () => attach(gen));
  S.frame.addEventListener('error', () => { if (gen === S.gen && S.stat) S.stat.textContent = '预览载入失败 · 该地址可能已不可达'; });
  S.viewport.addEventListener('wheel', onWheel, { passive: false });
  if (window.ResizeObserver) {
    S.io = new ResizeObserver(() => { if (S.ready) applyZoom(); });
    S.io.observe(S.viewport);
  }
  return host;
}

function shortTitle(pg) {
  const t = String(pg.title || pg.url || '');
  return t.length > 26 ? t.slice(0, 25) + '…' : t;
}
function spacer() { return el('span', { class: 'pv-sep' }); }

function previewUrl() {
  return '/api/preview?job=' + encodeURIComponent(state.job || '') + '&page=' + encodeURIComponent(S.pageUrl || state.url || '');
}

function segControl(id, options, value, onPick) {
  const wrap = el('div', { class: 'pv-seg', id: id });
  for (const pair of options) {
    const b = el('button', { type: 'button', text: pair[1], class: String(value) === String(pair[0]) ? 'on' : '' });
    b.addEventListener('click', () => {
      Array.prototype.forEach.call(wrap.children, (x) => x.classList.toggle('on', x === b));
      onPick(pair[0]);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function toggleButton(label, onClick, active, tip) {
  const b = el('button', { type: 'button', class: 'pv-btn', text: label, title: tip || label });
  b.classList.toggle('on', !!active());
  b.addEventListener('click', () => { onClick(); b.classList.toggle('on', !!active()); });
  return b;
}

function selectControl(prefix, options, value, onPick) {
  const lab = el('label', { class: 'pv-sel' });
  lab.appendChild(el('span', { text: prefix }));
  const sel = el('select');
  for (const pair of options) {
    sel.appendChild(el('option', { value: String(pair[0]), text: String(pair[1]), selected: String(pair[0]) === String(value) }));
  }
  sel.addEventListener('change', () => onPick(sel.value));
  lab.appendChild(sel);
  return lab;
}

function onWheel(ev) {
  if (!(ev.metaKey || ev.ctrlKey)) return;
  ev.preventDefault();
  const nums = ZOOMS.filter((z) => z[0] !== 'fit').map((z) => z[0]).sort((a, b) => b - a);
  let idx = nums.indexOf(Number(S.zoom));
  if (idx < 0) idx = S.zoom === 'fit' ? nums.length - 1 : 0;
  idx = clamp(idx + (ev.deltaY > 0 ? 1 : -1), 0, nums.length - 1);
  S.zoom = nums[idx];
  const seg = document.getElementById('pv-zoom');
  if (seg) Array.prototype.forEach.call(seg.children, (x, i) => x.classList.toggle('on', ZOOMS[i] && String(ZOOMS[i][0]) === String(S.zoom)));
  applyZoom();
}

/* ============================================================== 接管快照 */

function attach(gen) {
  if (gen !== S.gen) return;
  let doc = null;
  try { doc = S.frame.contentDocument; } catch { doc = null; }
  if (!doc || !doc.documentElement) {
    if (S.stat) S.stat.textContent = '快照不可读（跨源或被拒绝）';
    hideLoading();
    return;
  }
  S.doc = doc;
  S.win = S.frame.contentWindow;
  try { S.base = doc.baseURI || state.url; } catch { S.base = state.url; }
  injectClientStyle(doc);
  buildLayer(doc);
  hookErrors(doc, gen);
  preventNavigation(doc, gen);
  applyForce();
  relayout(gen, false, () => {
    settleImages(gen, () => {
      hideLoading();
      autoHarvestFromDom();
      remap(gen);
      S.ready = true;
      if (S.stat) S.stat.textContent = '预览就绪 · 文档 ' + S.docW + '×' + S.docH + (S.truncated ? '（高度已截断）' : '');
    });
  });
}

function hideLoading() { if (S.loading) S.loading.style.display = 'none'; }

function injectClientStyle(doc) {
  if (doc.getElementById('idv-client')) return;
  const style = doc.createElement('style');
  style.id = 'idv-client';
  style.textContent = 'html{overflow:hidden!important}::-webkit-scrollbar{width:0!important;height:0!important}';
  (doc.head || doc.documentElement).appendChild(style);
}

function buildLayer(doc) {
  if (S.layer && S.layer.parentNode) S.layer.parentNode.removeChild(S.layer);
  const layer = doc.createElement('div');
  layer.id = 'idv-overlay';
  doc.documentElement.appendChild(layer);
  S.layer = layer;
  const root = layer.attachShadow ? layer.attachShadow({ mode: 'open' }) : layer;
  S.root = root;
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  root.appendChild(style);
  const mk = (cls, display) => {
    const n = doc.createElement('div');
    n.className = cls;
    if (display) n.style.display = 'none';
    root.appendChild(n);
    return n;
  };
  S.cap = mk('idv-cap', false);
  S.regionHost = mk('idv-rs');
  S.boxHost = mk('idv-boxes');
  S.mq = mk('idv-mq', true);
  S.mqBadge = doc.createElement('div');
  S.mqBadge.className = 'idv-mq-badge';
  S.mq.appendChild(S.mqBadge);
  wireOverlay(doc);
}

const OVERLAY_CSS = [
  ':host{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;display:block}',
  '.idv-cap{position:absolute;left:0;top:0;background:rgba(74,217,255,.01);cursor:crosshair;pointer-events:auto}',
  '.idv-boxes{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:20}',
  '.idv-rs{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5}',
  '.idv-r{position:absolute;box-sizing:border-box;border:1px dashed rgba(255,209,102,.5);border-radius:3px;'
    + 'background:repeating-linear-gradient(135deg,rgba(255,209,102,.07) 0 7px,rgba(255,209,102,.02) 7px 14px);'
    + 'pointer-events:none}',
  '.idv-r.off{border-color:rgba(124,246,176,.55);background:repeating-linear-gradient(135deg,rgba(124,246,176,.05) 0 7px,rgba(124,246,176,.01) 7px 14px)}',
  '.idv-r.soft{border-style:dotted;border-color:rgba(240,201,139,.6)}',
  '.idv-r.soft>i{color:#f0c98b;background:rgba(58,42,14,.92);border-color:rgba(240,201,139,.4)}',
  '.idv-r>i{position:absolute;left:-1px;top:-1px;transform:translateY(-100%);font-size:10px;font-style:normal;'
    + 'letter-spacing:.06em;white-space:nowrap;padding:1px 6px;border:1px solid rgba(255,209,102,.55);border-bottom:0;'
    + 'border-radius:2px 2px 0 0;background:rgba(5,7,10,.92);color:#ffd166}',
  '.idv-r.tiny>i{display:none}',
  '.idv-mq{position:absolute;border:1.5px dashed #b8ff3c;background:rgba(184,255,60,.14);box-shadow:0 0 0 9999px rgba(3,5,8,.32),0 0 16px rgba(184,255,60,.35);pointer-events:none;border-radius:2px;z-index:100}',
  '.idv-mq-badge{position:absolute;left:4px;top:-26px;background:#05070a;color:#b8ff3c;border:1px solid #b8ff3c;border-radius:3px;font-size:11px;padding:2px 7px;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 4px 12px rgba(0,0,0,.7);font-weight:700;pointer-events:none}',
  '.idv-b{position:absolute;box-sizing:border-box;border:1.5px solid var(--c);background:var(--f);border-radius:3px;'
    + 'pointer-events:auto;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'transition:box-shadow .16s ease,background .16s ease,border-color .16s ease}',
  '.idv-b:hover{background:var(--g);box-shadow:0 0 0 1px var(--c),0 0 12px var(--c)}',
  '.idv-b .n{position:absolute;left:-1px;top:-1px;transform:translateY(-100%);background:#05070a;color:#fff;'
    + 'border:1px solid var(--c);border-bottom:0;font-size:10px;line-height:1.1;padding:2px 5px;white-space:nowrap;'
    + 'max-width:260px;overflow:hidden;text-overflow:ellipsis;border-radius:2px 2px 0 0}',
  '.idv-b .d{position:absolute;right:-1px;bottom:-1px;background:var(--c);color:#04070a;font-size:9px;line-height:1;'
    + 'padding:2px 4px;white-space:nowrap;opacity:0;transition:opacity .16s ease;font-weight:700;border-radius:2px 0 2px 0}',
  '.idv-b:hover .d,.idv-b.sel .d{opacity:1}',
  '.idv-b.sel{border-width:2px;border-color:#b8ff3c!important;box-shadow:0 0 0 2px rgba(184,255,60,.6),0 0 24px rgba(184,255,60,.4);z-index:30}',
  '.idv-b.sel .n{border-color:#b8ff3c;color:#b8ff3c}',
  '.idv-b.bad{border-style:dotted;opacity:.9}',
  '.idv-b.exc{border-style:dashed;opacity:.55}',
  '.idv-b.tiny{min-width:16px;min-height:16px}',
  '.idv-b.csspos{border-style:dashed}',
  '.idv-b.pulse{animation:idvPulse 1.2s ease 2}',
  '.idv-b.mq-hit{border-color:#4ad9ff!important;box-shadow:0 0 0 2px rgba(74,217,255,.7),0 0 18px rgba(74,217,255,.5)}',
  '.idv-chk{position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:3px;border:1px solid rgba(255,255,255,.55);'
    + 'background:rgba(5,7,10,.88);display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;line-height:1;'
    + 'transition:all .16s ease;opacity:.8;pointer-events:auto;user-select:none}',
  '.idv-b:hover .idv-chk,.idv-t:hover .idv-chk{opacity:1;border-color:#4ad9ff;background:rgba(74,217,255,.2)}',
  '.idv-b.sel .idv-chk,.idv-t.sel .idv-chk{opacity:1;border-color:#b8ff3c;background:#b8ff3c;color:#05070a;font-weight:900;box-shadow:0 0 10px rgba(184,255,60,.9)}',
  '.idv-t{position:absolute;box-sizing:border-box;border:1.5px dashed rgba(184,255,60,.65);background:rgba(184,255,60,.06);'
    + 'pointer-events:auto;cursor:pointer;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'transition:box-shadow .16s ease,background .16s ease,border-color .16s ease}',
  '.idv-t .n{position:absolute;left:-1px;top:-1px;transform:translateY(-100%);background:#0b1220;color:#dcf7b0;'
    + 'border:1px solid rgba(184,255,60,.5);font-size:10px;line-height:1.1;padding:2px 5px;white-space:nowrap;'
    + 'max-width:260px;overflow:hidden;text-overflow:ellipsis;border-radius:2px 2px 0 0}',
  '.idv-t:hover{background:rgba(184,255,60,.16);box-shadow:0 0 0 1px rgba(184,255,60,.4)}',
  '.idv-t.sel{border-style:solid;border-color:#b8ff3c;box-shadow:0 0 0 2px rgba(184,255,60,.5),0 0 22px rgba(184,255,60,.3);z-index:30}',
  '.idv-t.mq-hit{border-color:#4ad9ff!important;box-shadow:0 0 0 2px rgba(74,217,255,.7),0 0 18px rgba(74,217,255,.5)}',
  '@keyframes idvPulse{0%,100%{box-shadow:0 0 0 0 rgba(74,217,255,0)}45%{box-shadow:0 0 0 7px rgba(74,217,255,.4)}}',
  '@media (prefers-reduced-motion:reduce){.idv-b.pulse{animation:none}}',
].join('');

function shade(hex, a) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  const s = m ? (m[1].length === 3 ? m[1][0] + m[1][0] + m[1][1] + m[1][1] + m[1][2] + m[1][2] : m[1]) : '7cf6b0';
  const n = parseInt(s, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ============================================================== 布局 */

function relayout(gen, force, done) {
  if (gen !== S.gen || !S.frame || !S.doc) return;
  const doc = S.doc;
  const root = doc.documentElement;
  const body = doc.body || root;
  S.frame.style.width = S.width + 'px';
  S.frame.style.height = '1200px';
  void root.offsetHeight;
  let h = Math.max(root.scrollHeight || 0, body.scrollHeight || 0);
  let prev = 0;
  for (let i = 0; i < 4; i++) {
    S.frame.style.height = clamp(h + 4, 320, MAX_HEIGHT) + 'px';
    void root.offsetHeight;
    const next = Math.max(root.scrollHeight || 0, body.scrollHeight || 0);
    if (Math.abs(next - prev) <= 8) { h = next; break; }
    prev = next;
    h = next;
  }
  S.truncated = h >= MAX_HEIGHT;
  let w = Math.max(root.scrollWidth || 0, body.scrollWidth || 0, S.width);
  if (force) void root.offsetWidth;
  S.docW = Math.max(320, Math.min(w, 8000));
  S.docH = Math.max(320, Math.min(h + 4, MAX_HEIGHT));
  S.frame.style.width = S.docW + 'px';
  S.frame.style.height = S.docH + 'px';
  applyZoom();
  if (done) done();
}

function applyZoom() {
  if (!S.viewport || !S.frame || !S.canvas) return;
  const avail = Math.max(240, (S.viewport.clientWidth || 900) - 18);
  const k = S.zoom === 'fit' ? clamp(avail / S.docW, 0.08, 1) : Number(S.zoom);
  S.k = k;
  S.canvas.style.width = Math.round(S.docW * k) + 'px';
  S.canvas.style.height = Math.round(S.docH * k) + 'px';
  S.frame.style.transform = 'scale(' + k + ')';
  if (S.cap) { S.cap.style.width = S.docW + 'px'; S.cap.style.height = S.docH + 'px'; }
  layoutBoxes();
}

function applyForce() {
  if (!S.doc) return;
  const old = S.doc.getElementById('idv-force');
  if (!S.force) { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
  if (old) return;
  const st = S.doc.createElement('style');
  st.id = 'idv-force';
  st.textContent = '*{opacity:1!important;visibility:visible!important;transform:none!important;'
    + 'animation:none!important;transition:none!important;max-height:none!important;filter:none!important}';
  S.doc.documentElement.appendChild(st);
}

/* ============================================================== 就绪 */

function settleImages(gen, done) {
  if (gen !== S.gen || !S.doc) return;
  const started = Date.now();
  const tick = () => {
    if (gen !== S.gen) return;
    const imgs = S.doc.images || [];
    let left = 0;
    for (let i = 0; i < imgs.length; i++) if (!imgs[i].complete) left++;
    const wait = Date.now() - started;
    if (!left || wait > 5200) {
      relayout(gen);
      repairBroken();
      done();
      after(1500, () => { if (gen === S.gen) { relayout(gen); layoutBoxes(); } });
      after(4200, () => { if (gen === S.gen) { repairBroken(); relayout(gen); remap(gen); } });
      return;
    }
    if (S.stat) S.stat.textContent = '等待页面素材加载 · 还有 ' + left + ' 张图';
    after(280, tick);
  };
  tick();
}

function after(ms, fn) {
  const id = setTimeout(() => { S.timers = S.timers.filter((x) => x !== id); fn(); }, ms);
  S.timers.push(id);
}

function clearTimers() {
  for (const id of S.timers) clearTimeout(id);
  S.timers = [];
  if (S.io) { try { S.io.disconnect(); } catch { /* noop */ } S.io = null; }
  S.ready = false;
}

/** 防盗链导致加载失败的图 / 样式表：改走本地代理再试一次 */
function hookErrors(doc, gen) {
  doc.addEventListener('error', (ev) => {
    if (gen !== S.gen) return;
    const t = ev.target;
    if (!t || !t.tagName) return;
    const tag = t.tagName.toLowerCase();
    if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
      if (t.dataset && t.dataset.idvSwap) return;
      if (t.dataset) t.dataset.idvSwap = '1';
      const sw = swapToProxy(t.currentSrc || t.src || t.getAttribute('src') || '');
      if (sw) t.src = sw;
    } else if (tag === 'link' && /stylesheet/i.test(t.rel || '')) {
      if (t.dataset && t.dataset.idvSwap) return;
      if (t.dataset) t.dataset.idvSwap = '1';
      const sw = swapToProxy(t.href);
      if (sw) t.href = sw;
    }
  }, true);
}

function swapToProxy(raw) {
  if (!raw || /^data:/i.test(raw) || raw.indexOf('/api/proxy') >= 0) return '';
  const abs = absKey(raw, S.base);
  if (!abs) return '';
  return location.origin + '/api/proxy?url=' + encodeURIComponent(abs) + (state.url ? '&referer=' + encodeURIComponent(state.url) : '');
}

function repairBroken() {
  if (!S.doc) return;
  const imgs = S.doc.images || [];
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    if (!img.dataset || img.dataset.idvSwap) continue;
    if (img.complete && !img.naturalWidth) {
      img.dataset.idvSwap = '1';
      const sw = swapToProxy(img.getAttribute('src') || img.src);
      if (sw) img.src = sw;
    }
  }
}

/** 快照里不跳转；命中本次扫描过的站内页就切换预览 */
function preventNavigation(doc, gen) {
  doc.addEventListener('click', (ev) => {
    if (gen !== S.gen) return;
    const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    ev.preventDefault();
    const href = absKey(a.getAttribute('href'), S.base);
    if (!href) return;
    const page = (state.pages || []).find((pg) => pg.url === href);
    if (page) {
      S.pageUrl = page.url;
      S.pageMeta = page;
      loadFrame(gen);
      if (H.onToast) H.onToast('已切换到站内页 <b>' + esc(String(page.title || page.url).slice(0, 28)) + '</b>');
    } else if (H.onToast) {
      H.onToast('这一页不在本次扫描结果里 · 可用命令台的「站内顺带扫描」把它带上');
    }
  }, true);
}

function loadFrame(gen) {
  if (!S.frame) return;
  S.ready = false;
  if (S.stat) S.stat.textContent = '正在切换页面…';
  if (S.boxHost) S.boxHost.textContent = '';
  if (S.loading) S.loading.style.display = '';
  S.frame.src = previewUrl();
}

/* ============================================================== 自动从 DOM 提取元素 */

function autoHarvestFromDom() {
  if (!S.doc) return;
  if (!state.resources.length) {
    const found = [];
    const seenUrls = new Set();
    let idx = 1;
    const all = S.doc.querySelectorAll('img, svg, video, audio, source, a[href], [style*="url("]');
    for (const e of all) {
      const tag = String(e.tagName || '').toLowerCase();
      let rawUrl = '';
      let type = 'image';
      if (tag === 'img') {
        rawUrl = e.currentSrc || e.src || e.getAttribute('src') || e.getAttribute('data-src') || '';
        type = /\.svg(\?|#|$)/i.test(rawUrl) ? 'vector' : 'image';
      } else if (tag === 'svg') {
        type = 'vector';
      } else if (tag === 'video' || tag === 'audio') {
        rawUrl = e.currentSrc || e.src || e.getAttribute('src') || '';
        type = tag;
      } else if (tag === 'source') {
        rawUrl = e.src || e.getAttribute('src') || '';
        const parentTag = e.parentElement ? String(e.parentElement.tagName || '').toLowerCase() : '';
        type = parentTag === 'audio' ? 'audio' : 'video';
      } else if (tag === 'a') {
        rawUrl = e.getAttribute('href') || '';
        if (/\.(png|jpe?g|webp|gif|svg|mp4|webm|mp3|wav|ogg|pdf|zip|rar|tar|gz|7z)(\?|#|$)/i.test(rawUrl)) {
          if (/\.(mp4|webm)(\?|#|$)/i.test(rawUrl)) type = 'video';
          else if (/\.(mp3|wav|ogg)(\?|#|$)/i.test(rawUrl)) type = 'audio';
          else if (/\.(pdf|docx?|xlsx?|pptx?)(\?|#|$)/i.test(rawUrl)) type = 'doc';
          else if (/\.(zip|rar|7z|tar|gz)(\?|#|$)/i.test(rawUrl)) type = 'archive';
          else if (/\.svg(\?|#|$)/i.test(rawUrl)) type = 'vector';
          else type = 'image';
        } else {
          rawUrl = '';
        }
      }
      const abs = rawUrl ? absKey(rawUrl, S.base) : '';
      if (abs && !seenUrls.has(abs)) {
        seenUrls.add(abs);
        const name = (abs.split('/').pop() || 'resource').split('?')[0];
        found.push({
          id: 'dom-' + (idx++),
          url: abs,
          name: decodeURIComponent(name),
          type,
          status: 'ok',
          size: 0,
          provenance: 'dom',
        });
      }
    }
    if (found.length) {
      for (const it of found) putResource(it);
    }
  }

  if (!state.texts.length) {
    const textBlocks = [];
    let tidx = 1;
    const blockNodes = S.doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, li, td, th');
    for (const el of blockNodes) {
      const tag = String(el.tagName || '').toLowerCase();
      const txt = directText(el);
      if (txt && txt.length >= 2) {
        textBlocks.push({
          id: 't-' + (tidx++),
          tag,
          text: txt,
          chars: txt.length,
        });
      }
    }
    if (textBlocks.length) {
      putTexts(textBlocks);
    }
  }
}

/* ============================================================== 对表 */

function itemKeyOf(it) {
  if (it.inline && it.dataKey) return it.dataKey;
  return absKey(it.url, S.base);
}

function pairsOf(e) {
  const out = [];
  const attrs = e.attributes;
  if (!attrs) return out;
  for (let i = 0; i < attrs.length; i++) if (attrs[i] && attrs[i].value) out.push([attrs[i].name, attrs[i].value]);
  return out;
}

function rectOf(e) {
  const r = e.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return r;
  const list = typeof e.getClientRects === 'function' ? e.getClientRects() : null;
  if (list && list.length && list[0].width > 1 && list[0].height > 1) return list[0];
  /* <source> / <track> 之类自己不成框，用宿主媒体元素的框 */
  const host = e.parentElement ? e.parentElement.getBoundingClientRect() : null;
  if (host && host.width > 0 && host.height > 0) return host;
  return null;
}

/** 资源条目 → 页面元素 */
function collectResourceHits() {
  const doc = S.doc;
  const resKeys = new Map();
  const excKeys = new Map();
  for (const it of state.resources) {
    const k = itemKeyOf(it);
    if (!k) continue;
    const list = resKeys.get(k) || [];
    list.push(it);
    resKeys.set(k, list);
  }
  if (S.excluded) {
    for (const f of state.filtered || []) {
      const k = absKey(f.url, S.base);
      if (!k) continue;
      const list = excKeys.get(k) || [];
      list.push(f);
      excKeys.set(k, list);
    }
  }
  const hits = [];
  const seen = new Set();
  const matched = new Set();
  const found = new Set();
  const all = doc.getElementsByTagName('*');
  const limit = Math.min(all.length, MAX_ELEMS);
  function add(it, e, at, isExc) {
    const tag = it.id + '@' + at;
    if (seen.has(tag)) return;
    seen.add(tag);
    matched.add(it.id);
    hits.push({ id: it.id, el: e, exc: isExc, entry: it });
  }
  for (let i = 0; i < limit; i++) {
    const e = all[i];
    if (!e.attributes || !e.attributes.length) continue;
    const keys = elementKeys(pairsOf(e), S.base);
    if (!keys.length) continue;
    for (const k of keys) {
      const list = resKeys.get(k);
      if (list) { for (const it of list) { found.add(it.id); add(it, e, i, false); } continue; }
      const exc = excKeys.get(k);
      if (exc) for (const f of exc) add(f, e, i, true);
    }
  }
  /* 样式表背景图之类的：DOM 属性上没有地址，读一次 computed style 兜住 */
  const pending = [];
  for (const it of state.resources) if (!matched.has(it.id)) pending.push(it);
  const want = new Map();
  for (const it of pending) {
    const k = itemKeyOf(it);
    if (!k) continue;
    const list = want.get(k) || [];
    list.push(it);
    want.set(k, list);
  }
  function takeCss(i, urls) {
    const e = all[i];
    for (const raw of urls) {
      const k = absKey(raw, S.base);
      if (!k || !want.has(k)) continue;
      for (const it of want.get(k)) {
        found.add(it.id);
        const key = it.id + '@bg' + i;
        if (!seen.has(key)) { seen.add(key); matched.add(it.id); hits.push({ id: it.id, el: e, exc: false, entry: it }); }
      }
      want.delete(k);
    }
  }
  if (want.size && limit <= MAX_COMPUTED) {
    const view = S.win;
    for (let i = 0; i < limit && want.size; i++) {
      const e = all[i];
      if (!e.offsetWidth && !e.offsetHeight && !(e.getClientRects && e.getClientRects().length)) continue;
      let style = null;
      try { style = view.getComputedStyle(e); } catch { style = null; }
      if (style) takeCss(i, computedCssUrls(style));
      /* 伪元素（::before/::after）上的背景图也属于这个位置 */
      for (const pseudo of ['::before', '::after']) {
        if (!want.size) break;
        let ps = null;
        try { ps = view.getComputedStyle(e, pseudo); } catch { ps = null; }
        if (!ps) continue;
        const content = ps.content;
        if (!content || content === 'none' || content === 'normal') continue;
        takeCss(i, computedCssUrls(ps));
      }
    }
  }
  /* 解析器会记下 CSS 选择器：样式表若由脚本注入，快照里算不出背景图，用选择器兜一个位置 */
  if (want.size) {
    for (const it of pending) {
      if (matched.has(it.id) || !it.selector) continue;
      const k = itemKeyOf(it);
      if (!k || !want.has(k)) continue;
      let target = null;
      try { target = doc.querySelector(it.selector); } catch { target = null; }
      if (!target || !rectOf(target)) continue;
      found.add(it.id);
      const key = it.id + '@sel';
      if (!seen.has(key)) { seen.add(key); matched.add(it.id); hits.push({ id: it.id, el: target, exc: false, entry: it, sel: true }); }
      want.delete(k);
    }
  }
  const unmapped = state.resources.filter((it) => !matched.has(it.id)).map((it) => ({
    id: it.id,
    label: it.name || it.url || '内联资源',
    reason: it.provenance === 'json' || it.provenance === 'inferred'
      ? '从脚本 / 数据岛的字符串推断而来，页面本身没有它的位置'
      : found.has(it.id) ? '元素在 DOM 里但没有可显示的尺寸' : '地址未出现在当前页面的 DOM 里',
  }));
  return { hits: hits, total: state.resources.length, unmapped: unmapped };
}

/** 文案块 → 页面元素（按「直接文本 + 内联后代」口径匹配） */
function directText(e) {
  const parts = [];
  const kids = e.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 3) { parts.push(n.data); continue; }
    if (n.nodeType !== 1) continue;
    /* 解析器把每段文本单独入栈再用空格拼接，换行标签本身不产文字 */
    if (INLINE_TAGS.indexOf(String(n.tagName || '').toLowerCase()) >= 0) parts.push(n.textContent);
  }
  return normText(parts.join(' '));
}

function collectTextHits() {
  const doc = S.doc;
  const want = new Map();
  for (const b of state.texts) {
    const k = blockKey(b.tag, b.text);
    if (!k) continue;
    const list = want.get(k) || [];
    list.push(b);
    want.set(k, list);
  }
  const hits = [];
  const used = new Set();
  const all = doc.getElementsByTagName('*');
  const limit = Math.min(all.length, MAX_ELEMS);
  for (let i = 0; i < limit && hits.length < MAX_TEXT_BOXES * 2; i++) {
    const e = all[i];
    const tag = String(e.tagName || '').toLowerCase();
    if (BLOCK_TAGS.indexOf(tag) < 0) continue;
    /* 只要口径对得上就算命中：解析器对短标题同样出块，这里不能再按长度截断 */
    const text = directText(e);
    const list = want.get(blockKey(tag, text));
    if (!list) continue;
    for (const b of list) {
      if (used.has(b.id) || hits.length >= MAX_TEXT_BOXES) continue;
      used.add(b.id);
      hits.push({ id: b.id, el: e, text: true, entry: b });
    }
  }
  const unmapped = state.texts.filter((b) => !used.has(b.id)).map((b) => ({
    id: b.id, label: b.tag + ' · ' + normText(b.text).slice(0, 30), reason: '文本口径不一致（脚本改写或图片化文案）',
  }));
  return { hits: hits, total: state.texts.length, unmapped: unmapped };
}

function remap(gen) {
  if (gen !== S.gen || !S.doc || !S.layer) return;
  autoHarvestFromDom();
  const out = S.mode === 'text' ? collectTextHits() : collectResourceHits();
  S.boxes = out.hits.map((h) => ({
    id: h.id, el: h.el, exc: !!h.exc, text: !!h.text, entry: h.entry, viaSel: !!h.sel,
    node: null, rect: box(0, 0, 0, 0), hidden: false,
  }));
  const unique = new Set();
  for (const h of out.hits) unique.add(h.id);
  S.mappedCount = unique.size;
  S.markCount = out.hits.length;
  S.unmapped = out.unmapped || [];
  collectRegions();
  buildBoxNodes(S.mode === 'text');
  layoutBoxes();
  renderFoot();
  if (H.onSelectionChange) H.onSelectionChange();
}

/* ============================================================== 叠加框 */

function buildBoxNodes(isText) {
  if (!S.boxHost) return;
  S.boxHost.textContent = '';
  const frag = S.doc.createDocumentFragment();
  for (const b of S.boxes) {
    const info = isText ? null : typeOf(b.entry.type);
    const node = S.doc.createElement('div');
    node.className = (isText ? 'idv-t' : 'idv-b') + (b.exc ? ' exc' : '') + (isText || b.entry.status === 'ok' ? '' : ' bad') + (b.viaSel ? ' csspos' : '');
    node.dataset.id = String(b.id);
    if (!isText && info) {
      node.style.setProperty('--c', info.color);
      node.style.setProperty('--f', shade(info.color, 0.12));
      node.style.setProperty('--g', shade(info.color, 0.3));
    }
    const chk = S.doc.createElement('span');
    chk.className = 'idv-chk';
    chk.title = '勾选 / 取消勾选';
    node.appendChild(chk);

    const label = isText
      ? (b.entry.tag + (b.entry.level ? b.entry.level : '') + ' · ' + normText(b.entry.text).slice(0, 46))
      : String(b.entry.name || b.entry.url || '内联资源').slice(0, 46);
    const num = S.doc.createElement('span');
    num.className = 'n';
    num.textContent = (isText ? '¶ ' : (b.exc ? '⌀ ' : '')) + label;
    node.appendChild(num);
    if (!isText) {
      const size = S.doc.createElement('span');
      size.className = 'd';
      size.textContent = (b.entry.size && b.entry.size > 0)
        ? (bytesText(b.entry.size) + (b.entry.width && b.entry.height ? ' · ' + b.entry.width + '×' + b.entry.height : ''))
        : (b.entry.width && b.entry.height ? b.entry.width + '×' + b.entry.height : '就绪');
      node.appendChild(size);
    }
    node.title = isText
      ? normText(b.entry.text).slice(0, 260)
      : [b.entry.name || '', b.entry.type || '', b.entry.size ? bytesText(b.entry.size) : '',
        b.entry.width && b.entry.height ? b.entry.width + '×' + b.entry.height : '', b.entry.url || '',
        b.viaSel ? '按样式选择器 ' + (b.entry.selector || '') + ' 定位（该样式由脚本注入，快照里未渲染）' : ''].filter(Boolean).join(' · ');
    b.node = node;
    frag.appendChild(node);
  }
  S.boxHost.appendChild(frag);
  syncSelection();
}

function layoutBoxes() {
  if (!S.layer || !S.boxHost) return;
  const hostRect = S.layer.getBoundingClientRect();
  for (const b of S.boxes) {
    if (!b.node || !b.el) continue;
    const r = rectOf(b.el);
    if (!r) { b.node.style.display = 'none'; b.hidden = true; continue; }
    b.rect = box(r.left - hostRect.left, r.top - hostRect.top, r.width, r.height);
    b.hidden = false;
    b.node.style.display = '';
    b.node.style.left = Math.round(b.rect.left) + 'px';
    b.node.style.top = Math.round(b.rect.top) + 'px';
    b.node.style.width = Math.max(2, Math.round(b.rect.width)) + 'px';
    b.node.style.height = Math.max(2, Math.round(b.rect.height)) + 'px';
    b.node.classList.toggle('tiny', b.rect.width < 16 || b.rect.height < 16);
  }
  applyVisibility();
  layoutRegions();
}

/* ============================================================== 非扫描区标注 */

function collectRegions() {
  S.regions = [];
  if (!S.doc || !S.regionHost) return;
  const memo = new Map();
  const all = S.doc.getElementsByTagName('*');
  const limit = Math.min(all.length, MAX_ELEMS);
  const noise = [];
  const main = [];
  for (let i = 0; i < limit; i++) {
    const e = all[i];
    const parent = e.parentElement;
    const pst = parent ? (memo.get(parent) || REGION_ROOT) : REGION_ROOT;
    const st = regionStep(pst, {
      tag: String(e.tagName || '').toLowerCase(),
      role: (e.getAttribute && e.getAttribute('role')) || '',
      hint: (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : (e.getAttribute && e.getAttribute('class')) || ''),
    });
    memo.set(e, st);
    const here = regionOf(st);
    const up = regionOf(pst);
    if (up.zone === here.zone) continue;
    if (here.zone === 'noise' && noise.length < 60) noise.push({ el: e, kind: here.kind, zone: 'noise', soft: !!here.soft });
    else if (here.zone === 'main' && main.length < 12) main.push({ el: e, kind: '', zone: 'main' });
  }
  const picked = noise.concat(main.filter((m) => !noise.some((n) => n.el.contains(m.el) && n.el !== m.el)));
  S.regions = picked;
  paintRegions();
}

function paintRegions() {
  if (!S.regionHost) return;
  S.regionHost.textContent = '';
  if (!S.marks) { for (const r of S.regions) r.node = null; return; }
  const frag = S.doc.createDocumentFragment();
  for (const r of S.regions) {
    const node = S.doc.createElement('div');
    node.className = 'idv-r' + (r.zone === 'main' ? ' off' : '');
    node.appendChild(S.doc.createElement('i')).textContent = r.zone === 'main'
      ? '主体内容区'
      : regionLabel(r.kind) + ' · 不在扫描范围' + (r.soft ? '（按命名推断）' : '');
    if (r.soft) node.classList.add('soft');
    r.node = node;
    frag.appendChild(node);
  }
  S.regionHost.appendChild(frag);
  layoutRegions();
}

function layoutRegions() {
  if (!S.layer || !S.regionHost) return;
  const hostRect = S.layer.getBoundingClientRect();
  const area = Math.max(1, S.docW * S.docH);
  for (const r of S.regions) {
    if (!r.node) continue;
    const rect = rectOf(r.el);
    if (!rect || rect.width < 2 || rect.height < 2) { r.node.style.display = 'none'; continue; }
    if (rect.width * rect.height > area * 0.92) { r.node.style.display = 'none'; continue; }
    r.node.style.display = '';
    r.node.style.left = Math.round(rect.left - hostRect.left) + 'px';
    r.node.style.top = Math.round(rect.top - hostRect.top) + 'px';
    r.node.style.width = Math.max(2, Math.round(rect.width)) + 'px';
    r.node.style.height = Math.max(2, Math.round(rect.height)) + 'px';
    r.node.classList.toggle('tiny', rect.height < 22 || rect.width < 90);
  }
}

function visibleIdSet() {
  if (S.mode === 'text') return new Set(visibleTexts().map((b) => b.id));
  if (state.filter.type === 'text') return new Set(state.resources.map((r) => r.id));
  return new Set(visibleItems().map((r) => r.id));
}

function selectableIdSet() {
  const was = state.filter.onlySel;
  state.filter.onlySel = false;
  let set;
  try { set = visibleIdSet(); } finally { state.filter.onlySel = was; }
  return set;
}

function applyVisibility() {
  const vis = visibleIdSet();
  for (const b of S.boxes) {
    if (!b.node || b.hidden) continue;
    const show = vis.has(b.id) && !(b.exc && !S.excluded);
    b.node.style.opacity = show ? '' : '0';
    b.node.style.pointerEvents = show ? 'auto' : 'none';
    b.dim = !show;
  }
}

function syncSelection() {
  const sel = S.mode === 'text' ? state.selText : state.sel;
  for (const b of S.boxes) {
    if (!b.node) continue;
    const isSelected = sel.has(b.id);
    b.node.classList.toggle('sel', isSelected);
    const chk = b.node.querySelector('.idv-chk');
    if (chk) chk.textContent = isSelected ? '✓' : '';
  }
}

function wireOverlay(doc) {
  let drag = null;

  S.root.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const targetNode = ev.target && ev.target.closest ? ev.target.closest('[data-id]') : null;
    drag = {
      startX: ev.pageX,
      startY: ev.pageY,
      shift: ev.shiftKey,
      alt: ev.altKey,
      moved: false,
      targetId: targetNode ? targetNode.dataset.id : null,
      pointerId: ev.pointerId,
    };
    try { S.cap.setPointerCapture(ev.pointerId); } catch {}
  });

  S.root.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = Math.abs(ev.pageX - drag.startX);
    const dy = Math.abs(ev.pageY - drag.startY);
    if (dx > 4 || dy > 4) {
      drag.moved = true;
      S.mq.style.display = '';
      const r = box(Math.min(drag.startX, ev.pageX), Math.min(drag.startY, ev.pageY), dx, dy);
      S.mq.style.left = r.left + 'px';
      S.mq.style.top = r.top + 'px';
      S.mq.style.width = r.width + 'px';
      S.mq.style.height = r.height + 'px';

      const ids = idsInRegion(r, false);
      const idSet = new Set(ids);
      for (const b of S.boxes) {
        if (b.node) b.node.classList.toggle('mq-hit', idSet.has(b.id));
      }
      if (S.mqBadge) {
        const isText = S.mode === 'text';
        const pool = isText ? state.texts : state.resources;
        const matched = pool.filter((x) => idSet.has(x.id));
        const totalBytes = isText ? 0 : matched.reduce((acc, x) => acc + (x.size || 0), 0);
        S.mqBadge.textContent = isText
          ? ('框选 ' + matched.length + ' 段文案')
          : ('框选 ' + matched.length + ' 项' + (totalBytes > 0 ? ' · ' + bytesText(totalBytes) : ''));
      }
    }
  });

  const onPointerEnd = (ev) => {
    if (!drag) return;
    const info = drag;
    drag = null;
    S.mq.style.display = 'none';
    for (const b of S.boxes) if (b.node) b.node.classList.remove('mq-hit');

    if (!info.moved) {
      // 单击 / 勾选事件
      let id = info.targetId;
      if (!id) {
        const elAt = S.root.elementFromPoint ? S.root.elementFromPoint(ev.clientX, ev.clientY) : null;
        const boxEl = elAt && elAt.closest ? elAt.closest('[data-id]') : null;
        if (boxEl) id = boxEl.dataset.id;
      }
      if (id) {
        if (ev.altKey) { openEntry(id); return; }
        toggleEntry(id, ev);
      }
      return;
    }

    // 框选事件
    const dx = Math.abs(ev.pageX - info.startX);
    const dy = Math.abs(ev.pageY - info.startY);
    const r = box(Math.min(info.startX, ev.pageX), Math.min(info.startY, ev.pageY), dx, dy);
    if (r.width >= 4 && r.height >= 4) {
      const ids = idsInRegion(r, false);
      commitRegion(ids, info.shift, info.alt);
    }
  };

  S.root.addEventListener('pointerup', onPointerEnd);
  S.root.addEventListener('pointercancel', () => {
    drag = null;
    S.mq.style.display = 'none';
    for (const b of S.boxes) if (b.node) b.node.classList.remove('mq-hit');
  });
}

function setRegionMode() {
  if (!S.cap) return;
}

function idsInRegion(rect, additive) {
  const vis = selectableIdSet();
  const ids = [];
  for (const b of S.boxes) {
    if (b.hidden || b.dim || b.exc) continue;
    if (!vis.has(b.id) || ids.indexOf(b.id) >= 0) continue;
    if (overlap(b.rect, rect) >= 0.35) ids.push(b.id);
  }
  if (additive) {
    const cur = new Set(S.mode === 'text' ? S.regionTexts : S.regionIds);
    for (const id of ids) cur.add(id);
    return [...cur];
  }
  return ids;
}

function paintRegion(ids) {
  if (S.mode === 'text') S.regionTexts = ids.slice();
  else S.regionIds = ids.slice();
  renderFoot();
}

function commitRegion(ids, isAdditive, isSubtractive) {
  const set = S.mode === 'text' ? state.selText : state.sel;
  if (isSubtractive) {
    for (const id of ids) set.delete(id);
  } else if (isAdditive) {
    for (const id of ids) set.add(id);
  } else {
    for (const id of ids) set.add(id);
  }
  S.regionIds = S.mode === 'text' ? S.regionIds : ids.slice();
  S.regionTexts = S.mode === 'text' ? ids.slice() : S.regionTexts;
  syncSelection();
  renderFoot();
  if (H.onSelectionChange) H.onSelectionChange();
  const n = ids.length;
  if (H.onToast) {
    if (isSubtractive) {
      H.onToast('已从选择中减去 <b>' + n + '</b> 项');
    } else {
      H.onToast(n ? (S.mode === 'text' ? '框选选中 <b>' + n + '</b> 段文案' : '框选选中 <b>' + n + '</b> 项资源 · 点「导出所选」一键下载')
        : '这个选区内没有可识别的资源');
    }
  }
}

/** 叠加框在文档里的先后顺序——Shift 连选就按这个顺序取区间 */
function boxOrder() {
  const seen = new Set();
  const out = [];
  for (const b of S.boxes) {
    if (b.exc || b.hidden || seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b.id);
  }
  return out;
}

function toggleEntry(id, ev) {
  if (S.mode === 'text') {
    const b = state.texts.find((x) => x.id === id);
    if (!b) return;
    applyPick(pickSelection(boxOrder(), id, !!(ev && ev.shiftKey), 'text'));
    return;
  }
  const item = state.resources.find((r) => r.id === id);
  if (!item) return;
  if (item.status !== 'ok' && !(ev && ev.shiftKey)) { openEntry(id); return; }
  applyPick(pickSelection(boxOrder(), id, !!(ev && ev.shiftKey), 'res'));
}

/** 把 store 的勾选结果同步回预览：区域计数跟随最新一次点击 */
function applyPick(r) {
  if (!r) return;
  const ids = boxOrder();
  const first = r.ids[0];
  const last = r.ids[r.ids.length - 1];
  const lo = ids.indexOf(first);
  const hi = ids.indexOf(last);
  if (S.mode === 'text') S.regionTexts = lo >= 0 && hi >= 0 ? ids.slice(Math.min(lo, hi), Math.max(lo, hi) + 1) : r.ids.slice();
  else S.regionIds = lo >= 0 && hi >= 0 ? ids.slice(Math.min(lo, hi), Math.max(lo, hi) + 1) : r.ids.slice();
  syncSelection();
  renderFoot();
  if (H.onSelectionChange) H.onSelectionChange(r);
}

function openEntry(id) {
  if (S.mode === 'text') {
    const b = state.texts.find((x) => x.id === id);
    if (b && H.onOpenText) H.onOpenText(b);
    return;
  }
  const item = state.resources.find((r) => r.id === id);
  if (item && H.onOpen) H.onOpen(item);
}

/* ============================================================== 底栏 */

function renderFoot() {
  if (!S.foot) return;
  S.foot.innerHTML = '';
  const isText = S.mode === 'text';
  const selSet = isText ? state.selText : state.sel;
  const pool = isText ? state.texts : state.resources;
  const picked = pool.filter((x) => selSet.has(x.id));
  const bytes = isText ? 0 : picked.reduce((n, r) => n + (r.status === 'ok' ? r.size || 0 : 0), 0);
  const chars = isText ? picked.reduce((n, b) => n + (b.chars || 0), 0) : 0;

  if (!isText) {
    const legend = el('div', { class: 'pv-legend' });
    const byType = new Map();
    for (const b of S.boxes) {
      if (b.exc) continue;
      const it = b.entry;
      byType.set(it.type, (byType.get(it.type) || 0) + 1);
    }
    const order = Object.keys(TYPES);
    for (const key of order) {
      const n = byType.get(key);
      if (!n) continue;
      legend.appendChild(el('span', { class: 'pv-key', title: TYPES[key].label + ' 在页面上定位到 ' + n + ' 处', style: '--c:' + TYPES[key].color },
        [el('i', { style: 'background:' + TYPES[key].color }), el('s', { text: TYPES[key].label }), el('b', { text: String(n) })]));
    }
    S.foot.appendChild(legend);
  }

  const info = el('div', { class: 'pv-region' });
  if (picked.length) {
    info.appendChild(el('span', {
      html: '已选 <b>' + fmtNum(picked.length) + '</b> ' + (isText ? '段文案 · ' + fmtNum(chars) + ' 字' : '项' + (bytes > 0 ? ' · ' + bytesText(bytes) : '')),
    }));
  } else {
    info.appendChild(el('span', { class: 'idle', text: isText ? '页面中勾选 / 框选文案段落 · 按住 Shift 连续多选 / 叠加' : '页面中勾选 / 框选元素 · 按住 Shift 连续多选 / 叠加' }));
  }
  const rg = el('div', { class: 'pv-regions' });
  const byKind = new Map();
  for (const r of S.regions) if (r.zone === 'noise') byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
  if (!byKind.size) {
    rg.appendChild(el('span', { class: 'pv-rg zero', text: '整页都是主体内容区', title: '没有识别到页眉 / 导航 / 页脚 / 侧栏 / 挂件' }));
  } else {
    const skipped = state.stats && state.stats.region ? state.stats.region.skipped : 0;
    for (const pair of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
      rg.appendChild(el('span', {
        class: 'pv-rg', title: '虚线区域 = 页面上的' + regionLabel(pair[0]) + '，扫描时整块跳过',
        html: regionLabel(pair[0]) + '<i>' + pair[1] + '</i>',
      }));
    }
    if (skipped) rg.appendChild(el('span', { class: 'pv-rg', title: '这些区域里的引用在扫描阶段就被排除', html: '正文外已排除<i>' + fmtNum(skipped) + '</i>' }));
  }
  info.appendChild(rg);
  info.appendChild(el('span', {
    class: 'pv-count',
    text: (isText ? '文案定位 ' : '资源定位 ') + S.mappedCount + ' / ' + fmtNum(pool.length) + ' 项 · ' + S.markCount + ' 处标记',
    title: S.unmapped.length
      ? '未定位：' + S.unmapped.slice(0, 6).map((u) => u.label + ' → ' + u.reason).join('\n')
      : '全部条目都在页面上找到了位置',
  }));
  S.foot.appendChild(info);

  const acts = el('div', { class: 'pv-acts' });
  acts.appendChild(el('button', {
    class: 'pv-btn go', type: 'button', disabled: !picked.length,
    text: isText ? ('导出已选文案 (' + picked.length + '段) ↓') : ('导出所选 (' + picked.length + '项' + (bytes > 0 ? ' · ' + bytesText(bytes) : '') + ') ↓'),
    title: isText ? '把勾选/框选到的文案导出为 md / json' : '把勾选/框选到的资源打成 ZIP，字节与站点返回完全一致',
    onclick: () => exportRegion(),
  }));
  acts.appendChild(el('button', {
    class: 'pv-btn', type: 'button', text: isText ? '全选本页文案' : '全选本页',
    onclick: () => selectAllOnPage(),
  }));
  acts.appendChild(el('button', {
    class: 'pv-btn', type: 'button', text: '反选',
    onclick: () => invertSelectionOnPage(),
  }));
  acts.appendChild(el('button', {
    class: 'pv-btn ghost', type: 'button', text: '清空选择',
    onclick: () => { if (isText) state.selText.clear(); else state.sel.clear(); state.anchorText = null; state.anchor = null; S.regionIds = []; S.regionTexts = []; syncSelection(); renderFoot(); if (H.onSelectionChange) H.onSelectionChange(); },
  }));
  if (picked.length && !isText) {
    acts.appendChild(el('button', {
      class: 'pv-btn', type: 'button', text: '在展台查看',
      onclick: () => { if (H.onShowCards) H.onShowCards(picked.map((r) => r.id)); },
    }));
  }
  S.foot.appendChild(acts);
}

function invertSelectionOnPage() {
  const vis = selectableIdSet();
  const isText = S.mode === 'text';
  const set = isText ? state.selText : state.sel;
  const pageIds = [];
  for (const b of S.boxes) {
    if (b.exc || b.hidden || !vis.has(b.id)) continue;
    if (pageIds.indexOf(b.id) < 0) pageIds.push(b.id);
  }
  for (const id of pageIds) {
    if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  if (isText) S.regionTexts = [...set].filter((id) => pageIds.includes(id));
  else S.regionIds = [...set].filter((id) => pageIds.includes(id));
  syncSelection();
  renderFoot();
  if (H.onSelectionChange) H.onSelectionChange();
  if (H.onToast) H.onToast('已反选当前页元素 · 当前已选 <b>' + set.size + '</b> 项');
}

function selectAllOnPage() {
  const vis = selectableIdSet();
  const ids = [];
  for (const b of S.boxes) {
    if (b.exc || b.hidden || !vis.has(b.id)) continue;
    if (ids.indexOf(b.id) < 0) ids.push(b.id);
  }
  const set = S.mode === 'text' ? state.selText : state.sel;
  for (const id of ids) set.add(id);
  if (S.mode === 'text') S.regionTexts = ids.slice();
  else S.regionIds = ids.slice();
  syncSelection();
  renderFoot();
  if (H.onSelectionChange) H.onSelectionChange();
  if (H.onToast) H.onToast('本页选中 <b>' + ids.length + '</b> ' + (S.mode === 'text' ? '段文案' : '项资源'));
}

function exportRegion() {
  const isText = S.mode === 'text';
  const selSet = isText ? state.selText : state.sel;
  const ids = Array.from(selSet);
  if (!ids.length) return;
  if (isText) { if (H.onExportText) H.onExportText({ format: 'md', ids: ids }); return; }
  const ok = ids.filter((id) => {
    const it = state.resources.find((r) => r.id === id);
    return it && it.status === 'ok';
  });
  if (!ok.length) { if (H.onToast) H.onToast('所选资源都不可达', { error: true }); return; }
  if (H.onExport) H.onExport({ ids: ok, label: '页面选区' });
}

/* ============================================================== 对外接口 */

export function previewActive() { return state.stage === 'preview'; }
export function previewReady() { return !!S.ready; }

export function refreshPreviewSelection() {
  if (!S.ready) return;
  syncSelection();
  applyVisibility();
  renderFoot();
}

export function remapLive() {
  if (S.ready && S.doc && S.layer) {
    remap(S.gen);
  }
}

/** 从详情弹层跳回预览并定位某一项 */
export function locateInPreview(id) {
  if (state.stage !== 'preview') return false;
  const go = () => {
    const found = S.boxes.filter((b) => String(b.id) === String(id) && b.node && !b.hidden);
    if (!found.length) {
      if (H.onToast) H.onToast('这一项在当前预览页上没有可见元素（可能由脚本渲染）', { error: true });
      return;
    }
    const first = found[0];
    const top = Math.max(0, (first.rect.top || 0) * S.k - (S.viewport.clientHeight || 600) / 2);
    S.viewport.scrollTo({ top: top, behavior: 'smooth' });
    for (const b of found) {
      b.node.classList.add('pulse');
      setTimeout(() => b.node.classList.remove('pulse'), 2600);
    }
  };
  if (S.ready) go();
  else {
    let tries = 0;
    const wait = setInterval(() => {
      if (S.ready || ++tries > 40) { clearInterval(wait); go(); }
    }, 200);
  }
  return true;
}

export function disposePreview() {
  S.gen++;
  clearTimers();
  S.boxes = [];
  S.ready = false;
  S.job = null;
  if (S.layer && S.layer.parentNode) S.layer.parentNode.removeChild(S.layer);
  if (S.host && S.host.parentNode) S.host.parentNode.removeChild(S.host);
  S.host = null; S.layer = null; S.root = null; S.boxHost = null; S.cap = null; S.mq = null; S.mqBadge = null; S.regionHost = null; S.regions = [];
  S.frame = null; S.doc = null; S.win = null; S.stat = null; S.foot = null;
}

/** 重新扫描后地址变了：让快照按当前页重新载入 */
export function reloadPreview() {
  if (!S.frame) return;
  S.gen++;
  clearTimers();
  S.boxes = [];
  S.ready = false;
  S.job = state.job;
  const pages = (state.pages && state.pages.length ? state.pages : [{ url: state.url, title: '主页面', main: true }]);
  if (!S.pageUrl || !pages.some((pg) => pg.url === S.pageUrl)) {
    const main = pages.find((pg) => pg.main) || pages[0];
    S.pageUrl = main.url;
  }
  S.pageMeta = pages.find((pg) => pg.url === S.pageUrl) || pages[0];
  loadFrame(S.gen);
}
