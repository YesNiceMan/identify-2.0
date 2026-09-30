/* store.js 缓存正确性 + 性能回归（无 DOM 依赖，可直接 node 跑） */
const S = await import('/Users/a123/Desktop/test/identify-2.0/public/js/store.js');
const { state, putResource, putItems, putTexts, visibleItems, visibleTexts, visibleOrder, counts, totals, matchesFilter, bump, selectionBytes, selectedItems, toggle, clearSelection, pickSelection } = S;
let pass = 0; let fail = 0;
const eq = (name, a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x === y) pass++; else { fail++; console.log('FAIL ' + name + String.fromCharCode(10) + '  got ' + x.slice(0, 200) + String.fromCharCode(10) + '  exp ' + y.slice(0, 200)); } };
const T = (t) => ({ id: t, name: t + '.png', url: 'http://x/' + t, type: 'image', status: 'ok', size: 100, index: 0 });

/* 1) 空态 */
eq('empty items', visibleItems().length, 0);
eq('empty totals', totals().total, 0);

/* 2) 追加即出现在视图里 */
putResource(T('a')); putResource(T('b'));
eq('two items', visibleItems().map((r) => r.id), ['a', 'b']);
eq('order cached', visibleOrder(), ['a', 'b']);
putResource(T('c'));
eq('three items', visibleItems().map((r) => r.id), ['a', 'b', 'c']);

/* 3) 同 id 更新（SSE 会重复推同一条） */
putResource({ id: 'b', size: 999, status: 'error' });
eq('update size', totals().bytes, 100 + 999 + 100);
eq('update ok/bad', [totals().ok, totals().bad], [2, 1]);
eq('update keeps count', counts().get('image').count, 3);
eq('onlyOk filter', (state.filter.onlyOk = true, visibleItems().map((r) => r.id)), ['a', 'c']);
state.filter.onlyOk = false;

/* 4) 筛选条件变化必须立刻生效（不经 bump） */
state.filter.q = '  '; 
eq('blank query', visibleItems().length, 3);
state.filter.q = '.png';   /* 注：type 'image' 里含字母 a，不能用单字母当词 */
eq('query ext', visibleItems().map((r) => r.id), ['a', 'b', 'c']);
state.filter.q = 'x/b';
eq('query url', visibleItems().map((r) => r.id), ['b']);
state.filter.q = 'zzz';
eq('query miss', visibleItems().length, 0);
state.filter.q = '';
eq('query reset', visibleItems().length, 3);
state.filter.type = 'video';
eq('type filter', visibleItems().length, 0);
state.filter.type = 'image';
eq('type image', visibleItems().length, 3);
state.filter.type = 'all';

/* 5) 勾选：toggle / sel 变化要让 onlySel 与选择体积同步 */
toggle('a'); toggle('c');
eq('selected ids', selectedItems().map((r) => r.id), ['a', 'c']);
eq('selection bytes', selectionBytes(), 200);
state.filter.onlySel = true;
eq('onlySel view', visibleItems().map((r) => r.id), ['a', 'c']);
state.filter.onlySel = false;
clearSelection();
eq('cleared', selectedItems().length, 0);

/* 6) 排序（直接改 state.sort，无 bump） */
putItems([{ id: 'd', name: 'd.png', url: 'http://x/d', type: 'image', status: 'ok', size: 5000, index: 3 }]);
state.resources.forEach((r, i) => { r.index = i; });
eq('index order', visibleItems().map((r) => r.id), ['a', 'b', 'c', 'd']);
state.sort = 'size';
eq('size order', visibleItems().map((r) => r.id), ['d', 'b', 'a', 'c']);   /* b 已被改成 999 */
state.sort = 'index';
eq('back to index', visibleItems().map((r) => r.id), ['a', 'b', 'c', 'd']);

/* 7) 文案 + 文本筛选 */
putTexts([{ id: 't0', text: 'hello world', chars: 11 }, { id: 't1', text: 'goodbye', chars: 7 }]);
eq('texts', visibleTexts().map((b) => b.id), ['t0', 't1']);
state.filter.q = 'good';
eq('text query', visibleTexts().map((b) => b.id), ['t1']);
state.filter.q = '';
state.filter.type = 'text';
eq('text order', visibleOrder(), ['t0', 't1']);
state.filter.type = 'all';
eq('totals texts', totals().texts, 2);
eq('totals chars', totals().chars, 18);

/* 8) matchesFilter 覆盖全部搜索字段（老 views.js 版本会漏 mime/alt/album/docInfo…） */
const rich = { id: 'r', name: 'r.png', url: 'http://x/r', type: 'image', status: 'ok', size: 1, index: 9,
  mime: 'image/avif', alt: '落日大道', provenance: 'og:image', album: 'Blue Train', genre: 'Jazz', family: '思源宋体',
  flavor: 'lossy', docInfo: 'PDF 1.7', playlistInfo: '4 档清晰度', pageSize: 'A4' };
putResource(rich);
for (const term of ['avif', '落日', 'og:image', 'Blue Train', 'Jazz', '思源', 'lossy', 'PDF 1.7', '清晰度', 'A4']) {
  state.filter.q = term;
  eq('search ' + term, visibleItems().some((r) => r.id === 'r'), true);
}
state.filter.q = '';

/* 9) 同族折叠 */
putResource({ id: 'f1', name: 'f1', url: 'u', type: 'image', status: 'ok', size: 1, index: 10, familySize: 2, familyBest: false });
const before = visibleItems().length;
state.filter.onlyOriginal = true;
eq('family collapsed', visibleItems().length, before - 1);
state.filter.onlyOriginal = false;

/* 10) pickSelection：Shift 取区间、锚点失效退化为切换 */
clearSelection();
const order = visibleOrder();
pickSelection(order, order[1], false, 'res');
pickSelection(order, order[4], true, 'res');
eq('shift range', [...state.sel].sort(), [order[1], order[2], order[3], order[4]].sort());

/* 11) reset 后回到空态 */
S.reset();
eq('reset items', visibleItems().length, 0);
eq('reset totals', totals().total, 0);
eq('reset texts', visibleTexts().length, 0);
eq('reset sel', state.sel.size, 0);

/* 12) 性能：900 条 × 逐条 SSE 的旧路径 vs 现在 */
const mk = (i) => ({ id: 'p' + i, name: 'photo-' + i + '.jpg', url: 'http://x/p' + i, type: i % 3 ? 'image' : 'font', status: 'ok', size: 1000 + i, index: i, host: 'x' });
const t0 = process.hrtime.bigint();
for (let i = 0; i < 900; i++) { putResource(mk(i)); }
const t1 = process.hrtime.bigint();
eq('900 loaded', visibleItems().length, 900);
/* 每次推进一条后都重读一遍视图（等价于旧版每条 SSE 全表重算） */
const t2 = process.hrtime.bigint();
for (let i = 0; i < 900; i++) { putResource(mk(i)); if (i % 60 === 0) visibleItems(); }
const t3 = process.hrtime.bigint();
console.log('  900 条首建 ' + Number(t1 - t0) / 1e6 + 'ms · 全量覆写+周期性重读 ' + Number(t3 - t2) / 1e6 + 'ms');
console.log(pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);