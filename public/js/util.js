export const TYPES = {
  image: { label: '图片', en: 'Images', color: '#7cf6b0', glyph: '▧' },
  vector: { label: '矢量图', en: 'Vector', color: '#4ad9ff', glyph: '◈' },
  video: { label: '视频', en: 'Video', color: '#ff6ec7', glyph: '▶' },
  audio: { label: '音频', en: 'Audio', color: '#ffd166', glyph: '∿' },
  document: { label: '文档', en: 'Docs', color: '#a0b4ff', glyph: '▤' },
  sheet: { label: '表格', en: 'Sheets', color: '#8ce99a', glyph: '▦' },
  archive: { label: '压缩包', en: 'Archives', color: '#d0a215', glyph: '⛃' },
  model: { label: '三维模型', en: '3D Model', color: '#ffb86b', glyph: '◮' },
  /* UI 图标与技术资源默认不扫描，只有打开对应开关才会出现在这里 */
  icon: { label: 'UI 图标', en: 'UI Icons', color: '#a3b1c6', glyph: '⊕' },
  font: { label: '字体', en: 'Fonts', color: '#e59fff', glyph: 'Aa' },
  stylesheet: { label: '样式表', en: 'Styles', color: '#5eead4', glyph: '{ }' },
  script: { label: '脚本', en: 'Scripts', color: '#f5d90a', glyph: '#!' },
  data: { label: '数据', en: 'Data', color: '#94a3b8', glyph: '⛁' },
  page: { label: '页面', en: 'Pages', color: '#cbd5e1', glyph: '⬜' },
  other: { label: '其他', en: 'Other', color: '#8a9bb0', glyph: '·' },
  text: { label: '文字', en: 'TEXT', color: '#ffffff', glyph: '¶' },
};

export const TYPE_ORDER = ['image', 'vector', 'video', 'audio', 'document', 'sheet', 'archive', 'model', 'icon', 'font', 'stylesheet', 'script', 'data', 'page', 'other'];

/** 服务端返回的排除原因 → 中文说明（server/policy.mjs 的镜像，缺省时用服务端 label） */
export const PROV_LABEL = { attr: '元素属性', css: '样式表 url()', datauri: '内联 data URI', json: 'JSON-LD / 结构化数据', inferred: '脚本 / 文本推断' };

export function typeOf(t) { return TYPES[t] || TYPES.other; }

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n, digits) {
  if (n == null || !isFinite(n)) return { value: '—', unit: '' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, Number(n));
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = i === 0 ? 0 : (v >= 100 ? 0 : v >= 10 ? (digits == null ? 1 : digits) : 2);
  return { value: v.toFixed(d), unit: units[i] };
}

export function bytesText(n) {
  const f = fmtBytes(n);
  return f.unit ? f.value + ' ' + f.unit : f.value + ' B';
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

export function fmtDuration(s) {
  if (!s && s !== 0) return '—';
  const sec = Number(s);
  if (sec < 1) return Math.round(sec * 1000) + ' 毫秒';
  if (sec < 60) return sec.toFixed(sec < 10 ? 2 : 1) + ' 秒';
  const m = Math.floor(sec / 60);
  const r = Math.round(sec % 60);
  if (m < 60) return m + ' 分 ' + (r < 10 ? '0' + r : r) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}

export function fmtMs(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's';
}

export function pixels(w, h) {
  if (!w || !h) return '';
  const mp = (w * h) / 1000000;
  return w + '×' + h + (mp >= 1 ? ' · ' + mp.toFixed(1) + 'MP' : '');
}

export function countUp(node, to, opts) {
  const o = opts || {};
  const from = Number(o.from || 0);
  const dur = o.duration || 900;
  const fmt = o.format || ((v) => Math.round(v).toLocaleString('zh-CN'));
  if (!node) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function debounce(fn, ms) {
  let timer = null;
  return function () {
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), ms || 200);
  };
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function reduceMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function timeAgo(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function hostUrl(u) {
  try { return new URL(u).host; } catch { return ''; }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;top:-999px', value: text });
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
