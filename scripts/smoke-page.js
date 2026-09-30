// 在页面里跑的冒烟片段，由 smoke-browser.mjs 读入并注入（单独成文件，避免与 CDP 客户端互相转义）
window.__SMOKE__ = {
  status: function () {
    var cards = document.querySelectorAll('.grid .card');
    var shown = 0;
    for (var i = 0; i < cards.length; i++) if (cards[i].classList.contains('in')) shown++;
    var txt = function (s) { var n = document.querySelector(s); return n ? n.textContent : null; };
    return {
      cards: cards.length, revealed: shown, phase: txt('#scope-phase'),
      found: txt('#c-found'), refs: txt('#c-refs'), size: txt('#c-size'), texts: txt('#c-text'),
      sel: document.querySelectorAll('.card.sel').length,
      note: txt('#tool-note'),
      dock: txt('#dock-count'),
      empty: !!document.querySelector('.empty'),
    };
  },
  type: function (q) {
    var i = document.querySelector('#filter');
    i.value = q;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return later(420, function () { return document.querySelectorAll('.grid .card').length; });
  },
  sortBy: function (key) {
    var b = document.querySelector('[data-sort="' + key + '"]');
    if (!b) return Promise.resolve('no-button');
    b.click();
    return later(420, function () {
      var c = document.querySelectorAll('.grid .card');
      return { n: c.length, firstType: c[0] ? c[0].dataset.type : null };
    });
  },
  /* 普通点卡片是「打开详情」，勾选在 .tick 上（⇧ 点卡片或点 .tick 都算连选） */
  clickCard: function (idx, shift) {
    var c = document.querySelectorAll('.grid .card');
    if (c.length <= idx) return Promise.resolve('only-' + c.length);
    var t = c[idx].querySelector('.tick');
    if (!t) return Promise.resolve('no-tick');
    t.dispatchEvent(new MouseEvent('click', { shiftKey: !!shift, bubbles: true, cancelable: true }));
    return later(320, function () {
      var n = document.querySelector('#tool-note');
      return { sel: document.querySelectorAll('.card.sel').length, note: n ? n.textContent : null };
    });
  },
  closeModal: function () {
    var m = document.querySelector('#modal');
    if (m) m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return later(260, function () {
      var mm = document.querySelector('#modal');
      return !mm || !mm.classList.contains('on');
    });
  },
  chip: function (label) {
    var all = Array.prototype.slice.call(document.querySelectorAll('button, .chip, .tchip'));
    var hit = all.filter(function (n) { return n.textContent.trim().indexOf(label) === 0; });
    if (!hit.length) return Promise.resolve('no-chip:' + label);
    hit[0].click();
    return later(420, function () { return document.querySelectorAll('.grid .card').length; });
  },
  /* 预览外壳在顶层文档里（标记画在沙箱 iframe 内，顶层查不到也不该查） */
  openPreview: function () {
    var b = document.querySelector('[data-stage="preview"]');
    if (!b) return Promise.resolve('no-preview-button');
    b.click();
    return later(2500, function () {
      return {
        shell: !!document.querySelector('.pv-viewport'),
        frame: !!document.querySelector('.pv-frame'),
        stat: (document.querySelector('#pv-stat') || {}).textContent || '',
      };
    });
  },
};
function later(ms, fn) { return new Promise(function (r) { setTimeout(function () { r(fn()); }, ms); }); }
