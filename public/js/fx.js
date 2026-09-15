import { $, $$, el, clamp, reduceMotion } from './util.js';

/* --------------------------------------------------- 自定义光标 */
export function initCursor() {
  if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
  const dot = $('.cursor-dot');
  const ring = $('.cursor-ring');
  if (!dot || !ring) return;
  let x = window.innerWidth / 2; let y = window.innerHeight / 2;
  let rx = x; let ry = y;
  window.addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    const hot = e.target.closest && e.target.closest('a,button,input,label,.card,.trow,[data-hot]');
    document.body.dataset.cursor = e.buttons ? 'down' : hot ? 'hot' : '';
  }, { passive: true });
  window.addEventListener('pointerdown', () => { document.body.dataset.cursor = 'down'; });
  window.addEventListener('pointerup', () => { document.body.dataset.cursor = ''; });
  (function loop() {
    rx += (x - rx) * 0.18;
    ry += (y - ry) * 0.18;
    dot.style.transform = 'translate3d(' + (x - 2.5) + 'px,' + (y - 2.5) + 'px,0)';
    ring.style.transform = 'translate3d(' + (rx - parseFloat(ring.offsetWidth || 34) / 2) + 'px,' + (ry - parseFloat(ring.offsetHeight || 34) / 2) + 'px,0)';
    requestAnimationFrame(loop);
  })();
}

/* --------------------------------------------------- 滚动揭示 */
export function initReveal(root) {
  const scope = root || document;
  const nodes = $$('.reveal:not(.in)', scope);
  if (!nodes.length) return;
  if (reduceMotion() || !('IntersectionObserver' in window)) {
    nodes.forEach((n) => n.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      const node = entry.target;
      node.style.transitionDelay = Math.min(220, i * 45) + 'ms';
      node.classList.add('in');
      io.unobserve(node);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  nodes.forEach((n) => io.observe(n));
}

/* --------------------------------------------------- 文字解码 */
const GLYPHS = 'アイウエオカキクケコサシスセソ01#@%&*+=<>/\\{}[]·▧◈∿▤▦⛁';
export function scramble(node, finalText, duration) {
  const text = String(finalText == null ? node.textContent : finalText);
  if (reduceMotion()) { node.textContent = text; return; }
  const ms = duration || 900;
  const chars = Array.from(text);
  const start = performance.now();
  (function frame(now) {
    const t = clamp((now - start) / ms, 0, 1);
    const revealCount = Math.floor(t * chars.length * 1.35);
    const out = chars.map((c, i) => {
      if (i < revealCount || c === ' ') return c;
      return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    });
    node.textContent = out.join('');
    if (t < 1) requestAnimationFrame(frame);
    else node.textContent = text;
  })(start);
}

export function initScrambles() {
  $$('[data-scramble]').forEach((node, i) => {
    const text = node.getAttribute('data-scramble');
    setTimeout(() => scramble(node, text, 760 + i * 130), 120 + i * 150);
  });
}

/* --------------------------------------------------- 磁吸按钮 */
export function initMagnetic(root) {
  const scope = root || document;
  $$('.ignite, .dbtn, .chip', scope).forEach((node) => {
    if (node.dataset.mag) return;
    node.dataset.mag = '1';
    node.addEventListener('pointermove', (e) => {
      if (reduceMotion()) return;
      const r = node.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      node.style.transform = 'translate(' + (dx * 7).toFixed(2) + 'px,' + (dy * 5).toFixed(2) + 'px)';
    });
    node.addEventListener('pointerleave', () => { node.style.transform = ''; });
  });
}

/* --------------------------------------------------- 卡片倾斜 */
export function attachTilt(card) {
  if (reduceMotion()) return;
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    card.style.transform = 'perspective(760px) rotateY(' + (dx * 5).toFixed(2) + 'deg) rotateX(' + (-dy * 5).toFixed(2) + 'deg) translateZ(0) scale(1.012)';
  });
  card.addEventListener('pointerleave', () => { card.style.transform = ''; });
}

/* --------------------------------------------------- FLIP 重排动画 */
export function flip(container, mutate) {
  if (reduceMotion()) { mutate(); return; }
  const items = $$('.card, .trow', container);
  const before = new Map();
  items.forEach((n) => before.set(n, n.getBoundingClientRect()));
  mutate();
  const after = $$('.card, .trow', container);
  after.forEach((n) => {
    const b = before.get(n);
    if (!b) return;
    const a = n.getBoundingClientRect();
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const sx = b.width / (a.width || 1);
    const sy = b.height / (a.height || 1);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) return;
    n.animate(
      [{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')', opacity: 0.65 }, { transform: 'none', opacity: 1 }],
      { duration: 460, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  });
}

/* --------------------------------------------------- 吐司 */
export function toast(message, opts) {
  const o = opts || {};
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: 'toast' + (o.error ? ' err' : ''), html: message });
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 420);
  }, o.ms || 3600);
}

/* --------------------------------------------------- 平滑滚动到 */
export function scrollTo(node, offset) {
  if (!node) return;
  const y = node.getBoundingClientRect().top + window.scrollY - (offset || 20);
  window.scrollTo({ top: y, behavior: reduceMotion() ? 'auto' : 'smooth' });
}
