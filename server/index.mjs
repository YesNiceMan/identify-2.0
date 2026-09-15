import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, PUBLIC_DIR, PORT, HOST, MAX_ASSET_BYTES } from './config.mjs';
import { STATIC_MIME, TYPES } from './mime.mjs';
import {
  normalizeUrl, openStream, ensureBytes, cachePath, readCacheMeta, readCacheBuffer,
  purgeCache, filenameFromUrl, hostOf,
} from './net.mjs';
import { createJob, getJob, listJobs, subscribe, formatBytes, reprobeItems, jobCount, inlineAsset } from './scan.mjs';
import { ZipWriter } from './zip.mjs';

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: (err && err.message) || 'server error' });
    else { try { res.destroy(); } catch { /* noop */ } }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (p.startsWith('/api/')) {
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
    if (p === '/api/health') return json(res, 200, { ok: true, jobs: jobCount(), uptime: Math.round(process.uptime()) });
    if (p === '/api/scan' && req.method === 'POST') return apiScan(req, res);
    if (p === '/api/jobs' && req.method === 'GET') return json(res, 200, { jobs: listJobs() });
    if (p === '/api/reprobe' && req.method === 'POST') return apiReprobe(req, res);
    if (p === '/api/bundle' && req.method === 'POST') return apiBundle(req, res);
    if (p === '/api/export' && req.method === 'POST') return apiExportText(req, res);
    if (p === '/api/cache/purge' && req.method === 'POST') return json(res, 200, { removed: purgeCache() });
    const events = /^\/api\/jobs\/([\w-]+)\/events$/.exec(p);
    if (events) return apiEvents(req, res, events[1]);
    const jobGet = /^\/api\/jobs\/([\w-]+)$/.exec(p);
    if (jobGet) {
      const job = getJob(jobGet[1]);
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, snapshot(job));
    }
    if (p === '/api/proxy') return apiProxy(req, res, url);
    if (p === '/api/inline') return apiInline(res, url);
    return json(res, 404, { error: 'not found' });
  }

  return serveStatic(req, res, p);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type,last-event-id',
    'access-control-expose-headers': 'content-range,accept-ranges,x-original-size',
  };
}

function snapshot(job) {
  return {
    id: job.id, url: job.url, options: job.options, status: job.status, phase: job.phase,
    progress: job.progress, error: job.error, logs: job.logs, events: job.events.length,
    result: job.result || (job.partial ? stripPartial(job.partial) : null),
  };
}

function stripPartial(partial) {
  return {
    doc: partial.doc, pages: partial.pages, stats: null,
    resources: partial.resources || [], textBlocks: partial.textBlocks || [],
    filtered: partial.filtered || [], filteredTotal: partial.filteredTotal || 0, filteredOverflow: partial.filteredOverflow || 0,
    links: partial.links || [], headings: partial.headings || [], keywords: partial.keywords || [],
  };
}

/* ---------------------------------------------------------- 扫描接口 */

async function apiScan(req, res) {
  const body = await readBodyJson(req);
  const target = normalizeUrl(body.url);
  if (!target) return json(res, 400, { code: 'BAD_URL', message: '请输入合法的 http(s) 链接' });
  if (isSelf(target)) return json(res, 400, { code: 'SELF', message: '不能扫描本工具的接口地址；样本页请用 /samples/lab' });
  const job = createJob(target, {
    deep: body.deep !== false,
    infer: body.infer !== false,
    includeIcons: body.includeIcons === true,
    includeTech: body.includeTech === true,
    crawlPages: body.crawlPages,
    maxResources: body.maxResources,
  });
  return json(res, 200, { job: job.id, url: job.url, status: job.status, options: job.options });
}

function isSelf(target) {
  try {
    const u = new URL(target);
    const selfHost = ['127.0.0.1', 'localhost', HOST];
    return selfHost.includes(u.hostname) && /^\/api\//.test(u.pathname);
  } catch { return false; }
}

async function apiReprobe(req, res) {
  const body = await readBodyJson(req);
  const job = getJob(body.job);
  if (!job) return json(res, 404, { error: 'job not found' });
  const updated = await reprobeItems(job, body.urls || [], body.ids || []);
  return json(res, 200, { items: updated, stats: job.result ? job.result.stats : null });
}

async function apiEvents(req, res, id) {
  const job = getJob(id);
  if (!job) { json(res, 404, { error: 'no job' }); return; }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
  const send = (ev) => {
    try {
      res.write('id: ' + ev._id + '\nevent: ' + (ev.type || 'message') + '\ndata: ' + JSON.stringify(ev) + '\n\n');
    } catch { /* 客户端已断开 */ }
  };
  const unsub = subscribe(job, send, Number(req.headers['last-event-id'] || 0));
  if (job.status !== 'running') {
    send({ _id: job.events.length + 1, t: 0, type: 'reopen', status: job.status, result: job.result || (job.partial ? stripPartial(job.partial) : null), error: job.error });
  }
  req.on('close', () => { clearInterval(heartbeat); unsub(); });
}

/* ------------------------------------------------------------ 代理 */

async function apiProxy(req, res, url) {
  const target = normalizeUrl(url.searchParams.get('url'));
  if (!target) { json(res, 400, { error: '缺少 url 参数' }); return; }
  if (isSelf(target)) { json(res, 400, { error: '禁止代理本工具接口' }); return; }
  const download = url.searchParams.get('download') === '1';
  const name = url.searchParams.get('name') || filenameFromUrl(target) || hostOf(target);
  const range = req.headers.range || '';

  const cached = readCacheMeta(target);
  if (cached) {
    serveFileBytes(req, res, { file: cachePath(target), type: cached.meta.contentType || 'application/octet-stream', name, download, range, size: cached.meta.bytes });
    return;
  }

  try {
    const upstream = await openStream(target, { range, referer: url.searchParams.get('referer') || '' });
    if (upstream.status >= 400) {
      let detail = '';
      try { detail = (await upstream.text()).slice(0, 200); } catch { /* noop */ }
      text(res, 502, '上游返回 ' + upstream.status + '\n' + detail);
      return;
    }
    const headers = {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
    };
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    if (download) headers['content-disposition'] = disposition(name);
    res.writeHead(upstream.status, headers);
    if (!upstream.body) { res.end(); return; }
    for await (const chunk of upstream.body) { if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); }
    res.end();
  } catch (err) {
    json(res, 502, { code: 'PROXY_FAILED', message: (err.message || '无法获取该资源').slice(0, 200), url: target });
  }
}

function serveFileBytes(req, res, { file, type, name, download, range, size }) {
  let st;
  try { st = fs.statSync(file); } catch { json(res, 404, { error: '缓存已失效，请重新扫描' }); return; }
  const total = size && size <= st.size ? size : st.size;
  const headers = {
    'content-type': type || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
    'x-original-size': String(total),
  };
  if (download) headers['content-disposition'] = disposition(name);

  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (start >= total || end < start) {
      res.writeHead(416, { 'content-range': 'bytes */' + total });
      res.end();
      return;
    }
    headers['content-range'] = 'bytes ' + start + '-' + end + '/' + total;
    headers['content-length'] = String(end - start + 1);
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  headers['content-length'] = String(total);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

function apiInline(res, url) {
  const entry = inlineAsset(url.searchParams.get('job'), url.searchParams.get('id'));
  if (!entry) { json(res, 404, { error: '内联资源不存在或任务已过期' }); return; }
  res.writeHead(200, {
    'content-type': entry.mime,
    'content-length': String(entry.buffer.length),
    'content-disposition': url.searchParams.get('download') === '1' ? disposition(entry.name) : 'inline',
    'cache-control': 'public, max-age=86400',
    'x-original-size': String(entry.buffer.length),
    'access-control-allow-origin': '*',
  });
  res.end(entry.buffer);
}

/* ------------------------------------------------------------ 打包 */

async function apiBundle(req, res) {
  const body = await readBodyJson(req);
  const job = getJob(body.job);
  if (!job) { json(res, 404, { error: '任务不存在，请重新扫描' }); return; }
  const items = selectItems(job, body);
  if (!items.length) { json(res, 400, { error: '没有可导出的资源' }); return; }

  const label = body.scope === 'type' ? (TYPES[items[0].type] || {}).label || items[0].type : body.scope === 'all' ? '全部资源' : '精选资源';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rootName = safeSeg('IDENTIFY-' + (hostOf(job.url) || 'site') + '-' + String(label).replace(/[^\w\u4e00-\u9fff]/g, '') + '-' + stamp);

  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': disposition(rootName + '.zip'),
    'cache-control': 'no-store',
    'x-entry-count': String(items.length),
    'x-accel-buffering': 'no',
  });

  const zip = new ZipWriter(res, { comment: 'IDENTIFY 2.0 - ' + job.url });
  let aborted = false;
  res.on('close', () => { aborted = true; });

  const used = new Map();
  const manifest = {
    tool: 'IDENTIFY 2.0',
    generatedAt: new Date().toISOString(),
    source: job.url,
    title: (job.result && job.result.doc && job.result.doc.title) || '',
    scope: body.scope || 'selected',
    types: [...new Set(items.map((i) => i.type))],
    entryCount: items.length,
    note: '每个文件均为目标站点返回的原始字节，未缩放、未二次编码。',
    files: [],
  };

  try {
    await zip.add(rootName + '/README.txt', readme(job, items, label));
    for (const item of items) {
      if (aborted) break;
      const data = await loadBytes(job, item);
      if (data === null) {
        manifest.files.push({ path: '', name: item.name, url: item.url, size: item.size, status: 'failed' });
        continue;
      }
      const dir = TYPES[item.type] ? TYPES[item.type].label : '其他';
      const entryName = uniquePath(used, rootName + '/' + dir + '/' + safeFile(item));
      await zip.add(entryName, data);
      manifest.files.push({
        path: entryName, name: item.name, url: item.url, type: item.type, mime: item.mime,
        bytes: data.length, reportedBytes: item.size, width: item.width || null, height: item.height || null,
        duration: item.duration || null, signature: item.format || '', status: 'ok',
        declaredSize: item.declaredWidth ? item.declaredWidth + (item.declaredHeight ? 'x' + item.declaredHeight : '') + (item.declaredFrom ? ' (' + item.declaredFrom + ')' : '') : '',
        extCorrected: item.extCorrected || '',
        pages: item.pages || null,
        page: item.pageWidth ? item.pageWidth + 'x' + item.pageHeight + (item.pageSize ? ' ' + item.pageSize : '') : '',
        docTitle: item.title || '',
        docAuthor: item.creator || item.albumArtist || '',
        album: item.album || '',
        year: item.year || '',
        genre: item.genre || '',
        sampleRate: item.sampleRate || null,
        channels: item.channels || null,
        frameRate: item.frameRate || null,
        codec: item.codec || '',
        playlist: item.kind ? item.kind + (item.variantCount ? ' · ' + item.variantCount + ' 档' : '') + (item.segments ? ' · ' + item.segments + ' 分片' : '') : '',
        fonts: item.fontName ? item.fontName + (item.glyphs ? ' · ' + item.glyphs + ' 字形' : '') : '',
        camera: item.camera || '',
        sprite: item.sprite || item.symbols ? '精灵图' : '',
        rescued: item.rescued || '',
      });
    }
    await zip.add(rootName + '/_manifest.json', JSON.stringify(manifest, null, 2));
    await zip.add(rootName + '/_资源清单.csv', manifestCsv(manifest));
    if (body.withText !== false) {
      const blocks = (job.result && job.result.textBlocks) || [];
      if (blocks.length) {
        await zip.add(rootName + '/_文案/正文.md', textMarkdown(job, blocks));
        await zip.add(rootName + '/_文案/文案.csv', textCsv(blocks));
        await zip.add(rootName + '/_文案/文案.json', JSON.stringify(blocks.map(pickText), null, 2));
      }
    }
    await zip.finish();
  } catch (err) {
    if (!aborted) logServer('bundle error', err && err.message);
    try { res.end(); } catch { /* noop */ }
  }
}

function selectItems(job, body) {
  const all = (job.result && job.result.resources) || (job.partial && job.partial.resources) || [];
  if (body.ids && body.ids.length) {
    const set = new Set(body.ids);
    return all.filter((r) => set.has(r.id));
  }
  if (body.scope === 'type' && body.types && body.types.length) {
    const set = new Set(body.types);
    return all.filter((r) => set.has(r.type) && r.status === 'ok');
  }
  if (body.scope === 'all') return all.filter((r) => r.status === 'ok');
  return [];
}

async function loadBytes(job, item) {
  if (item.inline) {
    const entry = inlineAsset(job.id, item.id);
    if (entry) return entry.buffer;
  }
  if (!item.url) return null;
  try {
    const got = await ensureBytes(item.url, { maxBytes: MAX_ASSET_BYTES });
    if (!got.buffer || !got.buffer.length) return null;
    return got.buffer;
  } catch (err) {
    logServer('load fail', item.url, (err.message || '').slice(0, 120));
    return null;
  }
}

function safeFile(item) {
  const base = String(item.name || 'asset').replace(/[\r\n]/g, '');
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff ()#+\u00e0-\u024f\u3000-\u303f\uff00-\uffef]/g, '_').replace(/^\.+/, '_');
  const withExt = /\.[a-z0-9]{1,6}$/i.test(cleaned) ? cleaned : cleaned + (item.ext ? '.' + item.ext : '');
  const prefix = item.index ? String(item.index).padStart(3, '0') + '-' : '';
  return (prefix + withExt).slice(0, 160);
}

function safeSeg(s) {
  return String(s).replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 90);
}

function uniquePath(map, p) {
  const key = p.toLowerCase();
  if (!map.has(key)) { map.set(key, 1); return p; }
  const n = map.get(key) + 1;
  map.set(key, n);
  const dot = p.lastIndexOf('.');
  if (dot > p.lastIndexOf('/')) return p.slice(0, dot) + '-' + n + p.slice(dot);
  return p + '-' + n;
}

function readme(job, items, label) {
  const lines = [];
  const bytes = items.reduce((n, i) => n + (i.size || 0), 0);
  const byType = new Map();
  for (const it of items) {
    const t = TYPES[it.type] ? TYPES[it.type].label : '其他';
    byType.set(t, (byType.get(t) || 0) + 1);
  }
  lines.push('IDENTIFY 2.0 · 资源导出包');
  lines.push('='.repeat(52));
  lines.push('来源页面 : ' + job.url);
  lines.push('页面标题 : ' + ((job.result && job.result.doc && job.result.doc.title) || '-'));
  lines.push('导出范围 : ' + label + '（' + items.length + ' 个文件）');
  lines.push('合计体积 : ' + formatBytes(bytes));
  lines.push('生成时间 : ' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  lines.push('类型分布 :');
  for (const [t, n] of byType) lines.push('  - ' + t + '  ' + n + ' 个');
  lines.push('');
  lines.push('说明：ZIP 内每个文件都是目标站点返回的原始字节（未缩放、未二次编码）。');
  lines.push('     _manifest.json 与 _资源清单.csv 记录了每个文件的原始 URL、MIME、像素尺寸、');
  lines.push('     时长、页数、页面尺寸、文档标题 / 作者、音频标题 / 艺人 / 专辑 / 年份 / 流派、');
  lines.push('     采样率 / 声道 / 帧率 / 编解码、HLS·DASH 档位、字体家族与字形数、相机 EXIF、');
  lines.push('     声明尺寸及其来源，可用于溯源与校验。');
  const result = job.result || {};
  const opts = job.options || {};
  lines.push('');
  lines.push('扫描策略 : ' + (opts.includeIcons ? '包含 UI 图标' : '不含 UI 图标') + ' · ' + (opts.includeTech ? '包含字体/样式表/脚本/数据' : '不含字体 / 样式表 / 脚本 / 数据'));
  if (result.filtered && result.filtered.length) {
    const sum = result.stats && result.stats.filtered ? result.stats.filtered : null;
    lines.push('被排除   : ' + result.filtered.length + ' 项（默认不扫描、不请求）');
    if (sum && sum.byReason) for (const g of sum.byReason) lines.push('  - ' + g.label + '  ' + g.count + ' 项');
    lines.push('');
    lines.push('排除明细 :');
    const shown = result.filtered.slice(0, 240);
    for (const f of shown) {
      const est = f.size ? ' · ' + formatBytes(f.size) : f.declaredWidth ? ' · 声明 ' + f.declaredWidth + 'px' : '';
      lines.push('  · [' + f.label + '] ' + (f.name || f.url || '内联') + est + '  ← ' + (f.detail || f.reason));
    }
    if (result.filtered.length > shown.length) lines.push('  … 其余 ' + (result.filtered.length - shown.length) + ' 项略');
    lines.push('');
    lines.push('     如需这些资源，回到扫描台打开「UI 图标」「技术资源」两个开关重新扫描。');
  } else {
    lines.push('被排除   : 0 项');
  }
  return lines.join('\n');
}

function manifestCsv(manifest) {
  const head = [
    '序号', '类型', '文件名', '体积(字节)', '宽', '高', '时长(秒)', '页数', '页面尺寸', '文档标题', '作者 / 艺人',
    '专辑', '年份', '流派', '采样率', '声道', '帧率', '编解码', '播放列表', '字体', '相机', '精灵图',
    '声明尺寸', '声明来源', '地址后缀修正', '识别格式', 'MIME', '原始 URL',
  ];
  const rows = manifest.files.map((f, i) => [
    i + 1, (TYPES[f.type] || {}).label || f.type || '', f.name || '', f.bytes != null ? f.bytes : (f.size || ''),
    f.width || '', f.height || '', f.duration || '', f.pages || '', f.page || '', f.docTitle || '', f.docAuthor || '',
    f.album || '', f.year || '', f.genre || '', f.sampleRate || '', f.channels || '', f.frameRate || '', f.codec || '',
    f.playlist || '', f.fonts || '', f.camera || '', f.sprite || '', f.declaredSize || '',
    f.rescued ? '按内容线索补探测（' + f.rescued + '）' : '', f.extCorrected || '', f.signature || '', f.mime || '', f.url || '',
  ]);
  return '\ufeff' + [head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function pickText(b) {
  return { tag: b.tag, level: b.level, zone: b.zone, chars: b.chars, words: b.words, line: b.line, text: b.text };
}

function textMarkdown(job, blocks) {
  const lines = ['# ' + ((job.result && job.result.doc && job.result.doc.title) || job.url), ''];
  lines.push('> 来源：' + job.url);
  lines.push('> 导出时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  for (const b of blocks) {
    if (b.level) lines.push('#'.repeat(b.level) + ' ' + b.text);
    else if (b.tag === 'li') lines.push('- ' + b.text);
    else if (b.tag === 'blockquote') lines.push('> ' + b.text);
    else if (b.tag === 'pre') lines.push('    ' + b.text);
    else if (b.tag === 'a') lines.push('[' + b.text + '](' + (b.href || '') + ')');
    else lines.push(b.text);
    lines.push('');
  }
  return lines.join('\n');
}

function textCsv(blocks) {
  const head = ['序号', '标签', '级别', '区域', '字数', '词数', '行号', '内容'];
  const rows = blocks.map((b, i) => [i + 1, b.tag, b.level || '', b.zone || '', b.chars, b.words, b.line || '', b.text]);
  return '\ufeff' + [head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/* ------------------------------------------------------ 文案导出接口 */

const TEXT_FORMATS = new Set(['md', 'txt', 'csv', 'json', 'html']);

async function apiExportText(req, res) {
  const body = await readBodyJson(req);
  const job = getJob(body.job);
  if (!job || !job.result) { json(res, 404, { error: '任务不存在或尚未完成' }); return; }
  const all = job.result.textBlocks || [];
  const set = body.ids && body.ids.length ? new Set(body.ids) : null;
  let blocks = set ? all.filter((b) => set.has(b.id)) : all.slice();
  if (body.scope === 'main') blocks = blocks.filter((b) => b.zone !== 'noise');
  if (!blocks.length) { json(res, 400, { error: '没有可导出的文案' }); return; }
  const fmt = TEXT_FORMATS.has(body.format) ? body.format : 'md';
  let payload;
  if (fmt === 'md') payload = textMarkdown(job, blocks);
  else if (fmt === 'csv') payload = textCsv(blocks);
  else if (fmt === 'json') payload = JSON.stringify({ source: job.url, title: job.result.doc.title, exportedAt: new Date().toISOString(), blocks: blocks.map(pickText) }, null, 2);
  else if (fmt === 'html') payload = htmlDoc(job, blocks);
  else payload = blocks.map((b) => b.text).join('\n\n');
  const name = safeSeg((job.result.doc.title || hostOf(job.url)) + '-文案.' + fmt);
  res.writeHead(200, {
    'content-type': (fmt === 'json' ? 'application/json' : 'text/plain') + '; charset=utf-8',
    'content-disposition': disposition(name),
    'content-length': String(Buffer.byteLength(payload, 'utf-8')),
  });
  res.end(payload);
}

function htmlDoc(job, blocks) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => map[c]);
  const body = blocks.map((b) => {
    if (b.level) return '<h' + b.level + '>' + esc(b.text) + '</h' + b.level + '>';
    if (b.tag === 'li') return '<li>' + esc(b.text) + '</li>';
    if (b.tag === 'blockquote') return '<blockquote>' + esc(b.text) + '</blockquote>';
    return '<p>' + esc(b.text) + '</p>';
  }).join('\n');
  const out = ['<!doctype html>', '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<title>' + esc(job.result.doc.title || job.url) + '</title>',
    '<style>body{max-width:44rem;margin:4rem auto;padding:0 1.5rem;font:16px/1.8 -apple-system,"PingFang SC",sans-serif;color:#14161a;background:#f7f7f5}small{color:#7a7f87}h1{font-size:2rem}</style>',
    '</head><body>', '<h1>' + esc(job.result.doc.title || job.url) + '</h1>',
    '<p><small>来源：' + esc(job.url) + ' · 导出于 ' + new Date().toLocaleString('zh-CN') + '</small></p>',
    body, '</body></html>'];
  return out.join('\n');
}

/* ------------------------------------------------------------ 静态 */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/samples' || rel === '/samples/') rel = '/samples/lab.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  let st = null;
  let target = file;
  try { st = fs.statSync(target); } catch { st = null; }
  if (!st || !st.isFile()) {
    const withHtml = target + '.html';
    try { st = fs.statSync(withHtml); target = withHtml; } catch { st = null; }
  }
  if ((!st || !st.isDirectory()) && st === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 · 未找到 ' + rel);
    return;
  }
  if (st && st.isDirectory()) {
    const idx = path.join(target, 'index.html');
    try { st = fs.statSync(idx); target = idx; } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404 · 未找到 ' + rel); return; }
  }
  const ext = path.extname(target).slice(1).toLowerCase();
  const mime = STATIC_MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': /^text|javascript|json|xml|svg|markdown/.test(mime) ? mime + '; charset=utf-8' : mime,
    'content-length': String(st.size),
    'cache-control': ext === 'html' ? 'no-store' : 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------ 工具 */

function disposition(name) {
  const clean = String(name || 'download').replace(/["\\\r\n]/g, '');
  const asciiName = clean.replace(/[^\x20-\x7e]/g, '_');
  return 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(clean);
}

async function readBodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) break;
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const payload = params.get('payload');
    if (payload) { try { return JSON.parse(payload); } catch { return {}; } }
    const out = {};
    for (const [k, v] of params) out[k] = v;
    if (typeof out.ids === 'string') out.ids = out.ids.split(',').filter(Boolean);
    if (typeof out.types === 'string') out.types = out.types.split(',').filter(Boolean);
    return out;
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function text(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function logServer(...args) {
  if (process.env.IDENTIFY_DEBUG) console.error('[identify]', ...args);
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  IDENTIFY 2.0 · 网页资源识别控制台');
  console.log('  ──────────────────────────────────────');
  console.log('  本地地址   http://' + HOST + ':' + PORT);
  console.log('  样本页面   http://' + HOST + ':' + PORT + '/samples/lab');
  console.log('  缓存目录   ' + path.join(ROOT, '.cache'));
  console.log('  停止服务   Ctrl + C');
  console.log('');
});

process.on('uncaughtException', (err) => logServer('uncaught', err && err.message));
process.on('unhandledRejection', (err) => logServer('rejection', err && err.message));