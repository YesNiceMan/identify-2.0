import { $, $$, el, esc, bytesText, fmtMs, fmtNum, debounce, TYPES } from './util.js';
import { startScan, streamJob, loadJob, bundle, exportText, reprobe, api, proxySrc } from './api.js';
import {
  state, reset, putResource, putItems, putTexts, toggle, toggleText, clearSelection, pickSelection, visibleOrder,
  selectedItems, visibleItems, visibleTexts, totals,
} from './store.js';
import {
  mount, renderSpectre, renderTabs, renderStage, appendCard, renderDock,
  detailHtml, textDetailHtml, renderPolicy, policyModalHtml,
} from './views.js';
import {
  renderPreviewStage, previewMounted, disposePreview, reloadPreview, remapLive,
  refreshPreviewSelection, locateInPreview, setPreviewMode, setPreviewTool, mountPreview,
} from './preview.js';
import { Radar } from './radar.js';
import { initCursor, initReveal, initScrambles, initMagnetic, attachTilt, flip, toast, scrollTo } from './fx.js';

const PRESETS = [

  { label: '本机样本页', url: 'http://127.0.0.1:4620/samples/lab' },

];

const PHASE_LABEL = {
  queued: '任务排队',
  connect: '抓取目标文档',
  parse: '解析 DOM 与引用',
  css: '递归解析外链 CSS',
  crawl: '顺带扫描站内页面',
  probe: '读取真实字节与元数据',
  organize: '归并类型与文案分区',
  done: '完成',
};

let radar = null;
let closeStream = null;
let refsCount = 0;
let modalItem = null;
let modalBlock = null;
let presetType = null;
let presetApplied = false;
let pendingStage = null;

/* ============================================================ 启动 */

async function boot() {
  radar = new Radar($('#radar-bg'));
  initCursor();
  initScrambles();
  initReveal();
  wireConsole();
  restoreSwitches();
  wireFilters();
  wireStageSeg();
  wireDock();
  wireModal();
  wireKeys();
  mount(handlers);
  mountPreview({
    onExport: (spec) => doExport(spec),
    onExportText: (spec) => doExportText(spec),
    onOpen: (item) => openModal(detailHtml(item), item, null),
    onOpenText: (block) => openModal(textDetailHtml(block), null, block),
    onToast: toast,
    onSelectionChange: afterSelection,
    onShowCards: showCards,
    onNavigate: (url) => {
      $('#url').value = url;
      $('#command').classList.add('has-value');
      run(url, 'preview');
    },
  });
  renderSpectre();
  renderTabs();
  renderStage();
  renderDock();
  let health = null;
  try {
    health = await api('/api/health');
    $('#engine-state').textContent = '就绪 · ' + health.jobs + ' 个任务 · 运行 ' + health.uptime + 's';
  } catch {
    $('#engine-state').textContent = '离线';
    toast('解析服务未响应 · 请在项目目录执行 <b>npm start</b>', { error: true, ms: 9000 });
  }
  try {
    const jobs = (await api('/api/jobs')).jobs || [];
    for (const j of jobs.slice(0, 3)) {
      PRESETS.unshift({ label: '上次 · ' + shortHost(j.url), url: j.url, job: j.id, status: j.status });
    }
  } catch { /* 忽略 */ }
  renderPresets();
  initMagnetic();
  const params = new URLSearchParams(location.search);
  const wanted = params.get('job');
  const preset = params.get('type');
  if (params.get('stage') === 'preview') pendingStage = 'preview';
  if (preset && (TYPES[preset] || preset === 'text')) {
    presetType = preset;
    history.replaceState({}, '', location.pathname + (wanted ? '?job=' + wanted + '&type=' + preset : '?type=' + preset));
  }
  if (params.get('url')) {
    $('#url').value = params.get('url');
    $('#command').classList.add('has-value');
    if (!wanted) { run(params.get('url')); return; }
  }
  if (wanted) {
    state.job = wanted;
    loadExisting(wanted, params.get('url') || '');
  }
}

function shortHost(u) {
  try { return new URL(u).host.replace('127.0.0.1', '本机'); } catch { return String(u).slice(0, 16); }
}

function renderPresets() {
  const host = $('#presets');
  if (!host) return;
  host.innerHTML = '';
  host.appendChild(el('span', { style: 'color:var(--dim);letter-spacing:.24em;font-size:9px', text: 'TARGETS' }));
  const seen = new Set();
  for (const p of PRESETS) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    host.appendChild(el('button', {
      class: 'chip' + (p.job ? ' host' : ''),
      type: 'button',
      title: p.url,
      text: p.label,
      onclick: () => {
        $('#url').value = p.url;
        $('#command').classList.add('has-value');
        if (p.job && p.status === 'done') loadExisting(p.job, p.url);
        else run(p.url);
      },
    }));
  }
  initMagnetic(host);
}

async function loadExisting(jobId, url) {
  reset();
  retirePreview();
  state.job = jobId;
  state.url = url;
  document.body.dataset.mode = 'work';
  $('#results').hidden = false;
  $('#scope').classList.add('on');
  $('#scope-target').textContent = url;
  $('#scope-phase').textContent = '载入历史结果';
  addLine({ kind: 'info', msg: '从任务 ' + jobId + ' 载入上次扫描结果' }, '');
  try {
    const snap = await loadJob(jobId);
    applyResult(snap.result);
    $('#scope-target').textContent = snap.url || url;
  } catch (e) {
    toast('载入失败：' + esc(e.message), { error: true });
  }
}

/* ============================================================ 交互处理器 */
const handlers = {
  onType: (key) => {
    state.filter.type = state.filter.type === key ? 'all' : key;
    if (state.stage === 'preview') setPreviewMode(state.filter.type === 'text' ? 'text' : 'res');
    repaint();
    scrollTo($('#results'), 12);
  },
  onQuery: debounce((q) => { state.filter.q = q; repaint(); }, 200),
  onSort: () => repaint(),
  onView: () => repaint(),
  /* 勾选：普通点击切换；按住 Shift 点击 = 从上次勾选处**连续多选**（整段区间并入） */
  onSelect: (item, node, ev) => {
    const r = pickSelection(visibleOrder(), item.id, !!(ev && ev.shiftKey), 'res');
    paintPicked(r.ids, 'res');
    afterSelection(r);
  },
  onSelectText: (block, node, ev) => {
    const r = pickSelection(visibleOrder(), block.id, !!(ev && ev.shiftKey), 'text');
    paintPicked(r.ids, 'text');
    afterSelection(r);
  },
  onOpen: (item) => openModal(detailHtml(item), item, null),
  onPolicy: (reason) => openModal(policyModalHtml(reason), null, null),
  onOpenText: (block) => openModal(textDetailHtml(block), null, block),
  onCopy: async (item) => {
    const ok = await copy(item.url);
    toast(ok ? '地址已复制 · <b>' + esc(String(item.name || '').slice(0, 26)) + '</b>' : '复制失败', { error: !ok });
  },
  onCopyText: async (block) => {
    const ok = await copy(block.text);
    toast(ok ? '文案已复制 · <b>' + fmtNum(block.chars) + '</b> 字' : '复制失败', { error: !ok });
  },
  onRetry: async (item) => {
    if (!state.job) return;
    toast('重新探测 <b>' + esc(String(item.name || item.url).slice(0, 26)) + '</b> …');
    try {
      const r = await reprobe(state.job, [item.id]);
      const next = (r.items || [])[0];
      if (!next) return toast('未找到该项', { error: true });
      Object.assign(item, next);
      repaint();
      toast(next.status === 'ok' ? '✓ 现在可导出 · ' + bytesText(next.size || 0) : '仍不可达：' + esc(next.error || next.status), { error: next.status !== 'ok' });
    } catch (e) {
      toast('重试失败：' + esc(e.message), { error: true });
    }
  },
  onExport: (spec) => doExport(spec),
  onExportText: (spec) => doExportText(spec),
  onTilt: attachTilt,
  onLocate: (id, kind) => {
    setStage('preview');
    setPreviewMode(kind === 'text' ? 'text' : 'res');
    locateInPreview(id);
  },
};

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** 只改勾选状态相关的 class，不重排列表（Shift 连选一次可能涉及上百项） */
function paintPicked(ids, kind) {
  const text = kind === 'text';
  const set = text ? state.selText : state.sel;
  for (const id of ids || []) {
    const node = $(text ? '.trow[data-textid="' + String(id).replace(/[^\w-]/g, '') + '"]' : '.card[data-id="' + String(id).replace(/[^\w-]/g, '') + '"]');
    if (node) node.classList.toggle('sel', set.has(id));
  }
  refreshPreviewSelection();
}

function afterSelection(r) {
  renderDock();
  const t = totals();
  const note = $('#tool-note');
  if (r && r.mode === 'range') {
    note.textContent = 'Shift 连续多选 · 区间 ' + r.ids.length + ' 项（新增 ' + r.added + '）· 已选 ' + state.sel.size + ' / ' + state.selText.size + ' 段';
    return;
  }
  note.textContent = state.resources.length ? ('已选 ' + state.sel.size + ' · 显示 ' + visibleItems().length + ' / ' + t.total) : '';
}

/* ============================================================ 扫描 */
function wireConsole() {
  const form = $('#command');
  const input = $('#url');
  const sync = () => form.classList.toggle('has-value', !!input.value.trim());
  input.addEventListener('input', sync);
  $('#clear-url').addEventListener('click', () => { input.value = ''; sync(); input.focus(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value); });
  const openBtn = $('#open-page');
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.preventDefault();
      run(input.value, 'preview');
    });
  }
  $$('.stepper button').forEach((b) => b.addEventListener('click', () => {
    const node = $('#opt-crawl');
    const v = Math.max(0, Math.min(12, (Number(node.textContent) || 0) + Number(b.dataset.step)));
    node.textContent = String(v);
    b.animate([{ transform: 'scale(.6)' }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
  }));
}

async function run(raw, targetStage) {
  let url = String(raw || '').trim();
  if (!url) { toast('请先输入要解析的链接', { error: true }); $('#url').focus(); return; }
  if (!/^https?:\/\//i.test(url)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) url = 'https://' + url;
    else { toast('链接格式无法识别', { error: true }); return; }
  }
  if (closeStream) { closeStream(); closeStream = null; }
  reset();
  retirePreview();
  state.url = url;
  state.scanning = true;
  refsCount = 0;
  const deep = $('#opt-deep').checked;
  const infer = $('#opt-infer').checked;
  const includeIcons = $('#opt-icons').checked;
  const includeTech = $('#opt-tech').checked;
  /* 勾选「扫描页眉 / 导航 / 页脚」= 整页扫描；不勾 = 只扫描主体内容区 */
  const mainOnly = !($('#opt-region') && $('#opt-region').checked);
  const crawlPages = Number($('#opt-crawl').textContent) || 0;
  state.options = { deep, infer, includeIcons, includeTech, mainOnly, crawlPages };
  saveSwitches();
  document.body.dataset.mode = 'work';
  $('#results').hidden = false;
  $('#scope').classList.add('on');
  $('#command').classList.add('busy');
  $('#stream').innerHTML = '';
  $('#scope-target').textContent = url;
  $('#scope-phase').textContent = '建立任务';
  paintProgress(0);
  resetCounters();
  radar.clear();
  radar.setMode('scan');
  radar.burst(0.5, 0.45);
  const btn = $('#ignite');
  btn.classList.add('running');
  $('.label', btn).textContent = '扫描中';
  $('.hint', btn).textContent = 'SCANNING';
  if (targetStage === 'preview') {
    pendingStage = 'preview';
    setStage('preview');
  }
  renderSpectre();
  renderTabs();
  renderStage();
  renderDock();
  try {
    const r = await startScan({ url: url, deep: deep, infer: infer, includeIcons: includeIcons, includeTech: includeTech, mainOnly: mainOnly, crawlPages: crawlPages });
    state.job = r.job;
    subscribe(r.job);
  } catch (e) {
    finishScan();
    addLine({ kind: 'error', msg: e.message }, '错误');
    toast('启动失败：' + esc(e.message), { error: true, ms: 6000 });
  }
}

function subscribe(jobId) {
  closeStream = streamJob(jobId, {
    status: (d) => {
      if (d.phase) $('#scope-phase').textContent = d.label || PHASE_LABEL[d.phase] || d.phase;
      if (typeof d.progress === 'number') paintProgress(d.progress);
    },
    log: (d) => addLine(d, ''),
    meta: (d) => {
      state.doc = d.doc || {};
      refsCount = d.refs || 0;
      $('#c-refs').textContent = fmtNum(refsCount);
      $('#c-text').textContent = fmtNum(d.text || 0);
      $('#scope-target').textContent = (state.doc.title ? state.doc.title + ' · ' : '') + state.url;
      addLine({ kind: 'info', msg: '页面 ' + (state.doc.host || '') + ' · ' + fmtNum(d.refs) + ' 个引用 · ' + fmtNum(d.headings) + ' 个标题' }, '结构');
      if (d.regions) {
        const rg = d.regions;
        addLine({
          kind: 'info',
          msg: '区域划分 · 正文引用 ' + fmtNum(rg.refs.main) + ' · 未定性 ' + fmtNum(rg.refs.content)
            + ' · 非内容区 ' + fmtNum(rg.refs.noise) + (rg.kindText ? '（' + rg.kindText + '）' : '')
            + ' · 文案 正文 ' + fmtNum(rg.texts.main) + ' / 区外 ' + fmtNum(rg.texts.noise),
        }, '区域');
      }
    },
    item: (d) => {
      const item = d.item || d;
      putResource(item);
      radar.addNode(item.type);
      appendCard(item);
      liveCounters();
      if (state.stage === 'preview') remapLive();
    },
    progress: (d) => {
      if (typeof d.progress === 'number') paintProgress(d.progress);
      if (d.total) $('#scope-pct').title = d.done + ' / ' + d.total;
    },
    done: () => {
      loadJob(jobId).then((snap) => {
        applyResult(snap.result, snap.status);
      }).catch((e) => toast('结果读取失败：' + esc(e.message), { error: true }));
    },
    reopen: (d) => {
      if (d.result) applyResult(d.result, d.status);
      else loadJob(jobId).then((snap) => applyResult(snap.result, snap.status));
    },
    error: (d) => {
      finishScan();
      addLine({ kind: 'error', msg: d.message || d.error || '未知错误' }, '错误');
      toast('扫描失败：' + esc(d.message || d.error || ''), { error: true, ms: 7000 });
    },
    gone: () => { if (state.scanning) finishScan(); },
  });
}

function paintProgress(p) {
  const v = Math.max(0, Math.min(100, Math.round(p)));
  $('#scope-bar').style.width = v + '%';
  $('#scope-pct').textContent = v + '%';
  if (radar) radar.setProgress(v);
}

let lineQueue = [];
let lineFlush = 0;
function addLine(d) {
  const host = $('#stream');
  if (!host) return;
  lineQueue.push(d);
  if (lineFlush) return;
  lineFlush = requestAnimationFrame(() => {
    lineFlush = 0;
    const frag = document.createDocumentFragment();
    const batch = lineQueue.slice(-24);
    lineQueue = [];
    for (const item of batch) {
      const t = new Date(item.at || Date.now());
      frag.appendChild(el('p', {
        class: item.kind || 'info',
        html: '<span class="t">' + t.toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' + esc(item.msg || ''),
      }));
    }
    host.appendChild(frag);
    while (host.children.length > 40) host.removeChild(host.firstChild);
  });
}

function resetCounters() {
  ['#c-found', '#c-refs', '#c-text'].forEach((s) => { $(s).textContent = '0'; });
  $('#c-size').textContent = '0 B';
  $('#ov-total').textContent = '0';
}

function liveCounters() {
  const t = totals();
  $('#c-found').textContent = fmtNum(t.total);
  $('#c-text').textContent = fmtNum(t.texts);
  $('#c-size').textContent = bytesText(t.bytes);
  $('#c-size').title = fmtNum(t.bytes) + ' 字节';
}

function applyResult(result, status) {
  if (!result) { finishScan(); return; }
  state.doc = result.doc || state.doc;
  state.headings = result.headings || [];
  state.keywords = result.keywords || [];
  state.links = result.links || [];
  state.pages = result.pages || [];
  putItems(result.resources || []);
  state.filtered = result.filtered || [];
  state.filteredTotal = result.filteredTotal || state.filtered.length;
  state.filteredOverflow = result.filteredOverflow || 0;
  putTexts(result.textBlocks || []);
  state.stats = result.stats || null;
  const fam = state.stats && state.stats.families;
  const famWrap = $('#only-original-wrap');
  if (famWrap) {
    famWrap.hidden = !(fam && fam.groups);
    if (!(fam && fam.groups)) $('#only-original').checked = false;
    else $('#only-original').title = '共 ' + fam.groups + ' 组同族资源 · ' + fam.collapsed + ' 个缩略候选可折叠';
  }
  refsCount = (result.stats && result.stats.refs) || refsCount || (result.resources || []).length;
  finishScan();
  $('#scope-phase').textContent = (status === 'error' ? '失败' : '完成') + ' · ' + fmtMs((result.stats && result.stats.duration) || 0);
  $('#c-refs').textContent = fmtNum(refsCount);
  paintProgress(100);
  liveCounters();
  if (presetType && !presetApplied) {
    state.filter.type = presetType;
    presetApplied = true;
  }
  repaint();
  if (state.stage === 'preview') reloadPreview();
  if (pendingStage) { const s = pendingStage; pendingStage = null; setTimeout(() => setStage(s), 120); }
  radar.setMode('result');
  radar.burst(0.5, 0.45);
  const t = totals();
  if (!t.total) {
    toast('未在该页面识别到可导出的资源', { error: true });
    return;
  }
  const extra = [];
  if (t.bad) extra.push('<span style="color:#ffd166">' + t.bad + ' 项不可达</span>');
  if (state.filteredTotal) extra.push('<span style="color:var(--muted)">按策略排除 ' + fmtNum(state.filteredTotal) + ' 项'
    + (state.stats && state.stats.requests ? '（其中 ' + fmtNum(state.stats.requests.probed || 0) + ' 项做过探测）' : '') + '</span>');
  if (result.stats && result.stats.families && result.stats.families.collapsed) extra.push('同族缩略 ' + result.stats.families.collapsed + ' 个');
  if (t.texts) extra.push(fmtNum(t.chars) + ' 字文案');
  toast('识别完成 · <b>' + fmtNum(t.total) + '</b> 项 · ' + bytesText(t.bytes) + ' · ' + fmtMs((result.stats && result.stats.duration) || 0)
    + (extra.length ? ' · ' + extra.join(' · ') : ''), { ms: 6500 });
}

function finishScan() {
  state.scanning = false;
  $('#command').classList.remove('busy');
  const btn = $('#ignite');
  btn.classList.remove('running');
  $('.label', btn).textContent = '再次扫描';
  $('.hint', btn).textContent = 'ENTER';
  if (closeStream) { closeStream(); closeStream = null; }
}

/* ============================================================ 展台 / 预览 */

function applyStage() {
  document.body.dataset.stage = state.stage;
  $$('#stage-seg button').forEach((b) => b.classList.toggle('on', b.dataset.stage === state.stage));
  const host = $('#preview-stage');
  if (!host) return;
  if (state.stage === 'preview') {
    /* 「只看已选」属于展台：进预览先放开，否则叠加层会空掉，选择动作也会扑空 */
    if (state.filter.onlySel) {
      state.filter.onlySel = false;
      const cb = $('#only-selected');
      if (cb) cb.checked = false;
    }
    if (!previewMounted(state.job)) renderPreviewStage(host);
    host.hidden = false;
    refreshPreviewSelection();
  } else {
    host.hidden = true;
    renderStage();
  }
}

function setStage(next) {
  if (next !== 'preview' && next !== 'list') return;
  if (state.stage === next) return;
  state.stage = next;
  applyStage();
  if (next === 'preview') scrollTo($('#command'), 20);
}

function retirePreview() {
  disposePreview();
  state.stage = 'list';
  document.body.dataset.stage = 'list';
  const host = $('#preview-stage');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/** 预览里框选完，回到展台核对 */
function showCards(ids) {
  setStage('list');
  state.filter.onlySel = true;
  const box = $('#only-selected');
  if (box) box.checked = true;
  repaint();
  scrollTo($('#results'), 8);
  const first = (ids || [])[0];
  if (first != null) {
    const node = $('.card[data-id="' + String(first).replace(/[^\w-]/g, '') + '"]');
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function wireStageSeg() {
  $$('#stage-seg button').forEach((b) => b.addEventListener('click', () => setStage(b.dataset.stage)));
}

/* ============================================================ 筛选 */
function repaint() {
  const stage = $('#stage-body');
  flip(stage, () => {
    renderStage();
    renderTabs();
    renderSpectre();
  });
  if (state.view === 'grid' && stage) $$('.card', stage).forEach(attachTilt);
  refreshPreviewSelection();
  afterSelection();
}

function wireFilters() {
  $('#filter').addEventListener('input', (e) => handlers.onQuery(e.target.value));
  $$('#view-seg button').forEach((b) => b.addEventListener('click', () => {
    $$('#view-seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.view = b.dataset.view;
    repaint();
  }));
  $$('#sort-seg button').forEach((b) => b.addEventListener('click', () => {
    $$('#sort-seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.sort = b.dataset.sort;
    repaint();
  }));
  $('#only-selected').addEventListener('change', (e) => { state.filter.onlySel = e.target.checked; repaint(); });
  $('#only-ok').addEventListener('change', (e) => { state.filter.onlyOk = e.target.checked; repaint(); });
  $('#only-original').addEventListener('change', (e) => { state.filter.onlyOriginal = e.target.checked; repaint(); });
  ['#opt-icons', '#opt-tech', '#opt-region'].forEach((s) => { if ($(s)) $(s).addEventListener('change', saveSwitches); });
}

/* 记住上次使用的扫描范围（只存这几个开关） */
const OPT_KEY = 'identify2.switches';
function restoreSwitches() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPT_KEY) || 'null');
    if (!saved) return;
    if (typeof saved.deep === 'boolean' && $('#opt-deep')) $('#opt-deep').checked = saved.deep;
    if (typeof saved.infer === 'boolean' && $('#opt-infer')) $('#opt-infer').checked = saved.infer;
    if (typeof saved.includeIcons === 'boolean' && $('#opt-icons')) $('#opt-icons').checked = saved.includeIcons;
    if (typeof saved.includeTech === 'boolean' && $('#opt-tech')) $('#opt-tech').checked = saved.includeTech;
    if (typeof saved.mainOnly === 'boolean' && $('#opt-region')) $('#opt-region').checked = !saved.mainOnly;
  } catch { /* 忽略 */ }
}

function saveSwitches() {
  try {
    localStorage.setItem(OPT_KEY, JSON.stringify({
      deep: $('#opt-deep').checked,
      infer: $('#opt-infer').checked,
      includeIcons: $('#opt-icons').checked,
      includeTech: $('#opt-tech').checked,
      mainOnly: $('#opt-region') ? !$('#opt-region').checked : true,
    }));
  } catch { /* 忽略 */ }
}

/* ============================================================ 导出 */
function wireDock() {
  $('#export-type').addEventListener('click', () => {
    const t = state.filter.type;
    if (t === 'all' || t === 'text') { toggleDrawer(); return; }
    const ids = selectedItems().filter((r) => r.type === t).map((r) => r.id);
    if (ids.length) doExport({ ids: ids, label: labelOf(t) + '-已选' });
    else doExport({ scope: 'type', types: [t], label: labelOf(t) });
  });
  $('#export-all').addEventListener('click', () => {
    if (state.sel.size) doExport({ ids: Array.from(state.sel), label: '已选资源' });
    else doExport({ scope: 'all', label: '全部资源' });
  });
  $('#clear-sel').addEventListener('click', () => {
    clearSelection();
    repaint();
    renderDock();
  });
  $('#more-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#drawer') && !e.target.closest('#more-btn')) $('#drawer').classList.remove('on');
  });
}

function labelOf(t) {
  const info = TYPES[t];
  return info ? info.label : t;
}

function toggleDrawer() {
  $('#drawer').classList.toggle('on');
}

async function doExport(spec) {
  if (!state.job) return toast('还没有扫描结果', { error: true });
  const payload = Object.assign({ job: state.job, label: 'export' }, spec);
  if (state.selText.size) {
    payload.withText = true;
    payload.textIds = Array.from(state.selText);
  }
  $('#drawer').classList.remove('on');
  await withBusy('按类型打包原始字节', async (report) => {
    const r = await bundle(payload, report);
    toast('已导出 <b>' + esc(r.name || 'bundle.zip') + '</b> · ' + bytesText(r.bytes) + ' · ' + (r.entries || '?') + ' 个文件（原尺寸未重编码）');
  });
}

async function doExportText(spec) {
  if (!state.job) return toast('还没有扫描结果', { error: true });
  const ids = spec.ids && spec.ids.length ? spec.ids : null;
  const useAll = !ids && spec.mode !== 'selected';
  if (!ids && !useAll && !state.selText.size) return toast('先在「文字」页或预览里勾选段落', { error: true });
  try {
    const r = await exportText({
      job: state.job,
      format: spec.format,
      ids: ids || (useAll ? undefined : Array.from(state.selText)),
    });
    toast('文案已导出 <b>' + esc(r.name) + '</b> · ' + bytesText(r.bytes));
  } catch (e) {
    toast('导出失败：' + esc(e.message), { error: true });
  }
}

async function withBusy(title, task) {
  const veil = $('#busy-veil');
  $('#busy-title').textContent = title;
  $('#busy-bytes').textContent = '0';
  $('#busy-unit').textContent = 'B';
  $('#busy-bar').style.width = '0%';
  $('#busy-foot').textContent = '连接解析服务 · 建立流式管道';
  veil.classList.add('on');
  let bytes = 0;
  let entries = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    const f = bytesText(bytes).split(' ');
    $('#busy-bytes').textContent = f[0];
    $('#busy-unit').textContent = f[1] || 'B';
    const secs = Math.max(0.4, (Date.now() - started) / 1000);
    $('#busy-foot').textContent = (bytes / secs > 102400 ? '写入中' : '准备中') + ' · ' + bytesText(bytes)
      + ' · ' + (entries ? entries + ' 项目录' : '按类型分目录');
    $('#busy-bar').style.width = Math.min(96, bytes / 260000) + '%';
  }, 110);
  let ok = false;
  try {
    await task((p) => { bytes = p.bytes; entries = p.entries; });
    ok = true;
    $('#busy-bar').style.width = '100%';
  } catch (e) {
    toast('导出失败：' + esc(e.message), { error: true, ms: 6000 });
  } finally {
    clearInterval(timer);
    setTimeout(() => veil.classList.remove('on'), ok ? 300 : 80);
  }
}

/* ============================================================ 详情弹层 */
function wireModal() {
  const modal = $('#modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) return closeModal();
    const btn = e.target.closest('[data-close],[data-copy],[data-open],[data-toggle],[data-retry],[data-copytext],[data-toggletext],[data-locate],[data-locatetext]');
    if (!btn) return;
    if (btn.hasAttribute('data-locate')) { closeModal(); handlers.onLocate(btn.dataset.locate, 'res'); return; }
    if (btn.hasAttribute('data-locatetext')) { closeModal(); handlers.onLocate(btn.dataset.locatetext, 'text'); return; }
    if (btn.hasAttribute('data-close')) closeModal();
    else if (btn.hasAttribute('data-copy')) handlers.onCopy(modalItem);
    else if (btn.hasAttribute('data-copytext')) handlers.onCopyText(modalBlock);
    else if (btn.hasAttribute('data-open')) window.open(modalItem.inline ? '/api/inline?job=' + state.job + '&id=' + modalItem.id : proxySrc(modalItem.url), '_blank');
    else if (btn.hasAttribute('data-toggle')) { toggle(modalItem.id); repaint(); openModal(detailHtml(modalItem), modalItem, null); }
    else if (btn.hasAttribute('data-toggletext')) { toggleText(modalBlock.id); repaint(); openModal(textDetailHtml(modalBlock), null, modalBlock); }
    else if (btn.hasAttribute('data-retry')) handlers.onRetry(modalItem);
  });
}

function openModal(html, item, block) {
  modalItem = item;
  modalBlock = block;
  $('#sheet').innerHTML = html;
  $('#modal').classList.add('on');
}

function closeModal() {
  $('#modal').classList.remove('on');
}

/* ============================================================ 快捷键 */
function wireKeys() {
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      closeModal();
      $('#drawer').classList.remove('on');
      if (typing) document.activeElement.blur();
      return;
    }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (e.key === '/') { e.preventDefault(); ($('#results').hidden ? $('#url') : $('#filter')).focus(); }
    else if (k === 'a') {
      /* 全选按「当前视图」口径；锚点清空，下一次点击重新定位 */
      if (state.filter.type === 'text') visibleTexts().forEach((b) => state.selText.add(b.id));
      else visibleItems().forEach((r) => { if (r.status === 'ok') state.sel.add(r.id); });
      state.anchor = null;
      state.anchorText = null;
      repaint();
      renderDock();
    }
    else if (k === 'e') {
      if (state.filter.type !== 'all' && state.filter.type !== 'text') $('#export-type').click();
      else $('#export-all').click();
    }
    else if (k === 'g') $$('#view-seg button')[state.view === 'grid' ? 1 : 0].click();
    else if (k === 'v') { if (state.stage === 'preview') setPreviewTool('pick'); }
    else if (k === 'm') { if (state.stage === 'preview') setPreviewTool('marquee'); }
    else if (k === 'x') $('#clear-sel').click();
    else if (k === 'i') $('#url').focus();
    else if (k === 'p') setStage(state.stage === 'preview' ? 'list' : 'preview');
  });
}

boot();