/**
 * 扫描编排：抓取 → 解析 → 深度解析 CSS → 逐个探测元数据 → 分类统计
 * 任务状态通过 SSE 推送，前端可流式渲染结果。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { extractPage, extractCss } from './extract.mjs';
import { TYPES, extFromPath, extFromMime, typeFromExt, guessMime, previewable, assetFamily } from './mime.mjs';
import { preFilter, postFilter, summarize, filterLabel, filterHint, contentSignal, trimFiltered } from './policy.mjs';
import { imageDimensions, mediaMeta, detectSignature, looksTextual, textSample, fontMeta } from './probe.mjs';
import { pdfMeta, officeMeta, playlistMeta } from './docmeta.mjs';
import {
  grab, decodeText, charsetOf, normalizeUrl, hostOf, sameOrigin, filenameFromUrl, shortHash,
  readCacheMeta, readCacheBuffer, writeCache, cachePath,
} from './net.mjs';
import { MAX_DOC_BYTES, MAX_ASSET_BYTES, MAX_RESOURCES, MAX_CSS_FILES, MAX_PAGES, PROBE_HEAD_BYTES } from './config.mjs';

const FULL_LIMIT_IMAGE = 14 * 1024 * 1024;
const FULL_LIMIT_MEDIA = 8 * 1024 * 1024;
const FULL_LIMIT_DOC = 10 * 1024 * 1024;
const CONCURRENCY = 6;
const TIME_BUDGET_MS = Number(process.env.IDENTIFY_BUDGET || 75000);

const jobs = new Map();
let seq = 0;

export function jobCount() { return jobs.size; }

export function createJob(rawUrl, options = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) { const err = new Error('链接无效，请输入 http(s) 地址'); err.code = 'BAD_URL'; throw err; }
  const job = {
    id: 'j' + (++seq).toString(36) + Date.now().toString(36).slice(-4),
    url,
    options: {
      deep: options.deep !== false,
      infer: options.infer !== false,
      /* 默认只识别内容资源：UI 图标与字体 / 样式表 / 脚本 / 数据不扫描、不请求、不导出 */
      includeIcons: options.includeIcons === true,
      includeTech: options.includeTech === true,
      crawlPages: Math.max(0, Math.min(MAX_PAGES, Number(options.crawlPages) || 0)),
      maxResources: Math.max(20, Math.min(MAX_RESOURCES, Number(options.maxResources) || MAX_RESOURCES)),
    },
    status: 'running',
    phase: 'queued',
    progress: 0,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    events: [{ type: 'status', status: 'running', phase: 'queued', progress: 0 }],
    listeners: new Set(),
    logs: [],
    result: null,
    error: null,
    partial: null,
  };
  jobs.set(job.id, job);
  pruneJobs();
  emit(job, { type: 'status', status: 'running', phase: 'queued', progress: 0 });
  run(job).catch((err) => {
    job.error = publicError(err);
    job.status = 'error';
    log(job, 'error', '扫描失败：' + job.error.message);
    emit(job, { type: 'done', status: 'error', error: job.error });
  });
  return job;
}

function publicError(err) {
  const msg = String((err && err.message) || err || '未知错误');
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return { code: 'DNS', message: '域名无法解析（请检查拼写或网络）' };
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|abort/i.test(msg)) return { code: 'TIMEOUT', message: '请求超时，站点可能无法访问或响应过慢' };
  if (/ECONNREFUSED/i.test(msg)) return { code: 'REFUSED', message: '连接被拒绝（端口未开放？）' };
  if (/ERR_CERT|self-signed|unable to verify/i.test(msg)) return { code: 'TLS', message: 'HTTPS 证书校验失败' };
  if (/BAD_URL/.test(String(err && err.code))) return { code: 'BAD_URL', message: msg };
  return { code: (err && err.code) || 'ERROR', message: msg.slice(0, 300) };
}

function pruneJobs() {
  if (jobs.size <= 24) return;
  const done = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  for (const j of done.slice(0, jobs.size - 24)) jobs.delete(j.id);
}

export function getJob(id) { return jobs.get(id) || null; }

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((j) => ({
    id: j.id, url: j.url, status: j.status, createdAt: j.createdAt,
    resources: j.result ? j.result.resources.length : 0,
    title: j.result ? j.result.doc.title : '',
  }));
}

export function subscribe(job, listener, lastEventId = 0) {
  job.listeners.add(listener);
  for (const ev of job.events) {
    if (ev._id > lastEventId) listener(ev);
  }
  return () => job.listeners.delete(listener);
}

function emit(job, event) {
  event._id = job.events.length + 1;
  event.t = Date.now() - job.startedAt;
  job.events.push(event);
  if (job.events.length > 900) job.events.splice(0, job.events.length - 900);
  for (const fn of job.listeners) { try { fn(event); } catch { /* 客户端断开 */ } }
}

function log(job, kind, msg, extra) {
  const entry = { kind, msg, t: Date.now() - job.startedAt, ...(extra || {}) };
  job.logs.push(entry);
  if (job.logs.length > 400) job.logs.shift();
  emit(job, { type: 'log', ...entry });
}

function phase(job, name, label, progress) {
  job.phase = name;
  job.progress = progress;
  emit(job, { type: 'status', status: 'running', phase: name, label, progress });
}

/* ------------------------------------------------------------- 主流程 */

async function run(job) {
  job.startedAt = Date.now();
  const out = {
    job: { id: job.id, url: job.url, options: job.options, startedAt: job.startedAt },
    doc: {}, links: [], headings: [], keywords: [], pages: [],
    resources: [], textBlocks: [], logs: [], stats: null,
  };
  job.partial = out;

  /* 1. 抓取文档 */
  phase(job, 'connect', '抓取目标文档', 3);
  const doc = await grab(job.url, {
    maxBytes: MAX_DOC_BYTES,
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  if (!doc.ok) throw new Error('站点返回 ' + doc.status);
  const html = decodeText(doc.body, doc.charset || sniffCharset(doc.body));
  out.doc.http = doc.status;
  out.doc.bytes = doc.bytes;
  out.doc.finalUrl = doc.finalUrl;
  out.doc.contentType = doc.contentType;
  out.doc.truncated = doc.truncated;
  log(job, 'info', '文档已获取 · ' + formatBytes(doc.bytes) + (doc.finalUrl !== job.url ? ' · 已跳转到 ' + doc.finalUrl : ''));
  if (doc.truncated) log(job, 'warn', '文档超出 ' + formatBytes(MAX_DOC_BYTES) + ' 上限，仅解析前部分');

  /* 2. 解析结构与文案 */
  phase(job, 'parse', '解析 DOM 与资源引用', 12);
  let parsed = extractPage(html, doc.finalUrl || job.url);
  out.doc = Object.assign(out.doc, parsed.doc, { host: hostOf(doc.finalUrl || job.url) });
  out.links = parsed.links;
  out.headings = parsed.headings;
  out.keywords = parsed.keywords;
  out.textBlocks = parsed.textBlocks;
  out.pages.push({ url: doc.finalUrl || job.url, title: parsed.doc.title, main: true, resources: 0, text: parsed.textBlocks.length });
  log(job, 'info', '结构解析完成 · ' + parsed.resources.length + ' 个资源引用 · ' + parsed.textBlocks.length + ' 段文案');
  emit(job, { type: 'meta', doc: out.doc, text: parsed.textBlocks.length, refs: parsed.resources.length, headings: parsed.headings.length });

  /* 3. 递归解析外链 CSS
   *    样式表自身按扫描策略不进入结果，但一定要读它——否则其中的背景图与图标精灵会漏掉。 */
  let refs = parsed.resources;
  if (job.options.infer === false) {
    const isGuess = (x) => x.provenance === 'inferred' || x.provenance === 'json';
    const dropped = refs.filter(isGuess).length;
    refs = refs.filter((x) => !isGuess(x));
    if (dropped) log(job, 'info', '按设置忽略 ' + dropped + ' 个仅出现在脚本 / JSON 中的推断地址');
  }
  const cssSeeds = refs.filter((r) => r.type === 'stylesheet' && r.url).map((r) => r.url);
  let cssStat = null;
  if (job.options.deep && cssSeeds.length) {
    phase(job, 'css', '递归解析外链样式表', 20);
    cssStat = await crawlCss(job, cssSeeds);
    if (cssStat.extra.length) refs = mergeRefLists(refs, cssStat.extra);
    log(job, 'info', '外链 CSS：读取 ' + cssStat.done + ' 个 / ' + cssStat.depth + ' 层 @import → 新增 ' + cssStat.extra.length + ' 个引用');
  }

  /* 4. 站内顺带扫描 */
  if (job.options.crawlPages > 0) {
    const candidates = pickCrawlTargets(parsed.links, job.url, job.options.crawlPages);
    if (candidates.length) {
      phase(job, 'crawl', '顺带扫描站内链接', 32);
      let ci = 0;
      for (const target of candidates) {
        ci++;
        emit(job, { type: 'progress', progress: 32 + Math.round((ci / candidates.length) * 10) });
        try {
          const page = await grab(target, { maxBytes: 2 * 1024 * 1024, referer: job.url, retries: 0 });
          if (!page.ok) throw new Error('HTTP ' + page.status);
          const pageHtml = decodeText(page.body, page.charset || sniffCharset(page.body));
          const sub = extractPage(pageHtml, page.finalUrl || target);
          refs = mergeRefLists(refs, sub.resources.map((r) => Object.assign(r, { page: target })));
          out.textBlocks = mergeTextBlocks(out.textBlocks, sub.textBlocks, target);
          out.pages.push({ url: page.finalUrl || target, title: sub.doc.title, resources: sub.resources.length, text: sub.textBlocks.length });
          log(job, 'info', '站内页 · ' + (sub.doc.title || target).slice(0, 40) + ' → ' + sub.resources.length + ' 个引用');
        } catch (err) {
          log(job, 'warn', '站内页跳过 · ' + target + ' · ' + (err.message || '').slice(0, 60));
        }
      }
    }
  }

  /* 5. 扫描策略：UI 图标 / 占位像素 / 字体 / 样式表 / 脚本 / 数据在此剔除，一次请求都不发 */
  const filtered = [];
  const candidates = [];
  let rescued = 0;
  for (const ref of refs) {
    const verdict = preFilter(ref, job.options);
    if (verdict) {
      filtered.push(filterEntry(ref, verdict, null));
    } else {
      const signal = contentSignal(ref);
      if (signal && !TYPES[ref.type]) ref.rescued = signal;
      else if (signal && ref.type === 'other') ref.rescued = signal;
      if (ref.rescued) rescued++;
      candidates.push(ref);
    }
  }
  if (rescued) log(job, 'info', '按内容线索补探测 ' + rescued + ' 个无扩展名 / 无法直接归类的地址');
  if (filtered.length) {
    const sum = summarize(filtered);
    log(job, 'info', '扫描策略 · 跳过 ' + sum.total + ' 个引用（未发起请求）：' + sum.byReason.map((g) => g.label + ' ' + g.count).join(' · '));
  }

  /* 6. 逐个探测资源 */
  const limited = candidates.slice(0, job.options.maxResources);
  job.refTotal = candidates.length;
  if (candidates.length > limited.length) {
    for (const ref of candidates.slice(limited.length)) filtered.push(filterEntry(ref, { reason: 'overflow', detail: '超出数量上限' }, null));
    log(job, 'warn', '内容资源超过上限，仅探测前 ' + limited.length + ' 个');
  }
  phase(job, 'probe', '探测资源真实大小与尺寸', 45);
  const items = [];
  let cursor = 0;
  let completed = 0;
  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (cursor < limited.length) {
        const idx = cursor++;
        const ref = limited[idx];
        let item;
        try {
          item = await probeRef(job, ref);
        } catch (err) {
          item = baseItem(ref);
          item.status = 'error';
          item.error = (err.message || '探测失败').slice(0, 160);
        }
        completed++;
        /* 真实字节到手后再判一次：小尺寸图、精灵图、1×1 像素 */
        const verdict = postFilter(item, job.options);
        if (verdict) {
          filtered.push(filterEntry(ref, verdict, item));
        } else {
          items.push(item);
          const pct = 45 + Math.round((completed / Math.max(1, limited.length)) * 50);
          job.progress = pct;
          /* 每个条目都要实时推给前端，只有 progress 节流 */
          emit(job, { type: 'item', item });
          if (completed % 2 === 0 || completed === limited.length) {
            emit(job, { type: 'progress', progress: pct, done: completed, total: limited.length });
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    })());
  }
  await Promise.all(workers);
  items.sort((a, b) => (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1) || a.index - b.index);
  items.forEach((it, i) => { it.index = i + 1; });
  out.resources = items;
  const filterSummary = summarize(filtered);
  const trimmed = trimFiltered(filtered);
  out.filtered = trimmed.kept;
  out.filteredOverflow = trimmed.dropped;
  out.filteredTotal = filtered.length;
  out.filterSummary = filterSummary;

  /* 7. 统计 */
  phase(job, 'organize', '整理资源光谱', 97);
  markDuplicates(items);
  const families = groupFamilies(items);
  out.stats = buildStats(job, items, out, { css: cssStat, families });
  out.logs = job.logs;
  job.progress = 100;
  job.status = 'done';
  job.finishedAt = Date.now();
  job.result = out;
  if (filtered.length) log(job, 'info', '合计按策略排除 ' + filtered.length + ' 项 · 侧栏「扫描策略」可查看明细');
  emit(job, { type: 'done', status: 'done', stats: out.stats, duration: job.finishedAt - job.startedAt });
}

/* ------------------------------------------------------ 递归 CSS 抓取 */

async function crawlCss(job, seeds) {
  const seen = new Set();
  let level = [];
  for (const url of seeds) if (url && !seen.has(url)) { seen.add(url); level.push({ url, depth: 0 }); }
  const extra = [];
  let done = 0, failed = 0, imports = 0, depth = 0;
  while (level.length && done + failed < MAX_CSS_FILES) {
    const room = Math.max(0, MAX_CSS_FILES - done - failed);
    const batch = level.slice(0, room);
    level = [];
    depth++;
    const results = await Promise.all(batch.map((task) => parseOneCss(job, task)));
    for (const one of results) {
      if (one.error) { failed++; continue; }
      done++;
      extra.push(...one.refs);
      for (const u of one.imports) {
        if (seen.has(u)) continue;
        seen.add(u);
        imports++;
        if (one.depth < 4) level.push({ url: u, depth: one.depth + 1 });
      }
    }
    emit(job, { type: 'progress', progress: 20 + Math.round(Math.min(1, (done + failed) / Math.max(1, seen.size)) * 12) });
  }
  return { extra, done, failed, imports, depth };
}

async function parseOneCss(job, task) {
  try {
    if (Date.now() - job.startedAt > TIME_BUDGET_MS) throw new Error('时间预算耗尽');
    const got = await grab(task.url, { maxBytes: 3 * 1024 * 1024, referer: job.url, retries: 0 });
    if (!got.ok) throw new Error('HTTP ' + got.status);
    const cssText = decodeText(got.body, charsetOf(got.contentType) || sniffCharset(got.body));
    const found = extractCss(cssText, task.url);
    const refs = [];
    const imports = [];
    for (const f of found) {
      if (/@import$/.test(f.attr || '')) imports.push(f.url);
      else refs.push(Object.assign(f, { via: hostOf(task.url), fromCss: task.url }));
    }
    log(job, 'info', 'CSS · ' + hostOf(task.url) + (task.depth ? '（第 ' + (task.depth + 1) + ' 层）' : '') + ' → 新增 ' + refs.length + ' 个引用 · ' + formatBytes(got.bytes));
    return { refs, imports, depth: task.depth, error: null };
  } catch (err) {
    log(job, 'warn', 'CSS 无法读取 · ' + task.url + ' · ' + (err.message || '').slice(0, 80));
    return { refs: [], imports: [], depth: task.depth, error: (err.message || 'failed').slice(0, 120) };
  }
}

/* -------------------------------------------------------- 策略与归并 */

/** 被策略排除的条目：留下足够信息，让用户看得到「少了什么、为什么少」 */
function filterEntry(ref, verdict, item) {
  const dataUri = ref.dataUri || null;
  const reason = verdict.reason;
  return {
    id: ref.id,
    url: item ? item.url : (ref.url || ''),
    name: (item && item.name) || (dataUri ? '内联 ' + (dataUri.mime || '') : filenameFromUrl(ref.url || '')) || '未命名',
    type: item ? item.type : ref.type,
    label: reason === 'overflow' ? '数量上限' : filterLabel(reason),
    hint: reason === 'overflow' ? '超过本次扫描的资源数量上限' : filterHint(reason),
    reason,
    detail: String(verdict.detail || '').slice(0, 140),
    ext: (item && item.ext) || ref.ext || '',
    tag: ref.tag,
    attr: ref.attr,
    provenance: ref.provenance,
    count: ref.count || 1,
    size: item ? item.size || null : (dataUri ? dataUri.approxBytes : null),
    width: item ? item.width || null : (ref.widthHint ? Number(ref.widthHint) || null : null),
    height: item ? item.height || null : null,
    mime: item ? item.mime || '' : (dataUri ? dataUri.mime : ''),
    selector: ref.selector || '',
    page: ref.page || '',
    line: ref.line || 0,
    probed: !!item,
    status: item ? item.status : 'unresolved',
    declaredWidth: !item && ref.widthHint ? Number(ref.widthHint) || 0 : 0,
    cdn: !item && ref.cdn ? ref.cdn : null,
  };
}

/** 同族归并：一张图的多个尺寸 / 密度写法 → 标出原件，其余记为缩略候选 */
function groupFamilies(items) {
  const buckets = new Map();
  for (const it of items) {
    if (!it.url || it.dataUri || it.status !== 'ok') continue;
    if (['image', 'vector', 'video', 'audio'].indexOf(it.type) < 0) continue;
    const key = assetFamily(it.url);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  let groups = 0, collapsed = 0;
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const best = list.slice().sort((a, b) => (familyScore(b) - familyScore(a)))[0];
    const bestAspect = aspectOf(best);
    const members = list.filter((it) => it === best || !bestAspect || !aspectOf(it) || Math.abs(aspectOf(it) - bestAspect) / bestAspect <= 0.12);
    if (members.length < 2) continue;
    for (const it of list) {
      if (members.indexOf(it) < 0) continue;
      it.family = key.slice(0, 120);
      it.familySize = members.length;
      it.familyBest = it === best;
      it.familyOf = it === best ? '' : best.id;
    }
    best.familyMembers = members.length;
    groups++;
    collapsed += members.length - 1;
  }
  return { groups, collapsed };
}

function familyScore(item) {
  const px = (Number(item.width) || 0) * (Number(item.height) || 0);
  return px || (Number(item.size) || 0);
}

function aspectOf(item) {
  const w = Number(item.width) || 0;
  const h = Number(item.height) || 0;
  return w && h ? w / h : 0;
}

/* ------------------------------------------------------------ 单项探测 */

function baseItem(ref) {
  return {
    id: ref.id, url: ref.url, index: ref.index || 0, type: ref.type, ext: ref.ext,
    tag: ref.tag, attr: ref.attr, provenance: ref.provenance, hint: ref.hint,
    count: ref.count, line: ref.line, alt: ref.alt || '', density: ref.density || 0,
    declaredWidth: ref.declaredWidth || 0, declaredHeight: ref.declaredHeight || 0,
    declaredFrom: ref.cdn ? '图片服务参数' : ref.widthHint ? 'HTML/CSS 声明' : ref.heightHint ? 'HTML/CSS 声明' : '',
    cdn: ref.cdn || null, rescued: ref.rescued || '', selector: ref.selector || '',
    page: ref.page || '', fromCss: ref.fromCss || '',
    name: '', mime: '', size: null, width: null, height: null, duration: null,
    status: 'pending', http: 0, host: ref.url ? hostOf(ref.url) : '', preview: false,
    src: '', download: '', cached: false, hash: '', dup: false, format: '', sample: '',
    error: '', truncated: false, source: '',
  };
}

async function probeRef(job, ref) {
  const item = baseItem(ref);
  if (Date.now() - job.startedAt > TIME_BUDGET_MS + 20000) {
    item.status = 'skipped';
    item.error = '超出时间预算';
    return item;
  }

  if (ref.dataUri) {
    item.source = 'data-uri';
    item.inline = true;
    item.mime = ref.dataUri.mime;
    item.ext = ref.ext || extFromDataUri(ref.dataUri.mime);
    item.name = uniqueName('inline-' + shortHash(ref.dataUri.data, 6) + '.' + item.ext, job);
    let buffer = null;
    try {
      buffer = Buffer.from(ref.dataUri.data, ref.dataUri.base64 ? 'base64' : 'utf-8');
      if (!ref.dataUri.base64) buffer = Buffer.from(decodeURIComponent(String(ref.dataUri.data)), 'utf-8');
    } catch { /* 非法编码 */ }
    item.size = buffer ? buffer.length : ref.dataUri.approxBytes;
    item.status = buffer ? 'ok' : 'error';
    if (buffer) {
      applyBytesMeta(item, buffer, job, null);
      await writeCache(job.url + '#inline#' + shortHash(ref.dataUri.data, 10), { buffer, contentType: item.mime, status: 200, finalUrl: job.url, name: item.name });
      item.inlineKey = job.url + '#inline#' + shortHash(ref.dataUri.data, 10);
    }
    item.src = '/api/inline?id=' + encodeURIComponent(item.id) + '&job=' + job.id;
    item.download = item.src + '&download=1';
    item.preview = previewable(item.type, item.mime);
    item.hash = buffer ? crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16) : '';
    job.inlineMap = job.inlineMap || new Map();
    job.inlineMap.set(item.id, { mime: item.mime, base64: ref.dataUri.base64, data: ref.dataUri.data, name: item.name });
    return item;
  }

  const url = item.url;
  item.host = hostOf(url);
  const cached = readCacheMeta(url);
  let head = null;
  let total = cached ? cached.meta.bytes : null;
  let mime = cached ? (cached.meta.contentType || '') : '';

  if (cached) {
    item.cached = true;
    head = readHeadFile(url, PROBE_HEAD_BYTES);
    item.status = 'ok';
    item.http = cached.meta.status || 200;
    if (!mime) {
      try {
        const guessSig = detectSignature(head || Buffer.alloc(0));
        if (guessSig) mime = guessSig.mime;
      } catch { /* noop */ }
    }
  } else {
    try {
      const got = await grab(url, {
        maxBytes: PROBE_HEAD_BYTES,
        range: 'bytes=0-' + (PROBE_HEAD_BYTES - 1),
        referer: job.url,
        retries: 0,
      });
      item.http = got.status;
      head = got.body;
      mime = got.contentType;
      total = got.totalBytes != null ? got.totalBytes : (got.status === 200 ? got.bytes : null);
      if (got.ok) {
        item.status = 'ok';
      } else {
        item.status = got.status === 404 || got.status === 410 ? 'missing' : got.status === 403 || got.status === 401 ? 'blocked' : 'error';
        item.error = 'HTTP ' + got.status;
        return finishItem(job, item, null);
      }
    } catch (err) {
      item.status = /ENOTFOUND|EAI_AGAIN/.test(err.message) ? 'dns' : /timeout|abort/i.test(err.message) ? 'timeout' : 'error';
      item.error = (err.message || '网络错误').slice(0, 140);
      return finishItem(job, item, null);
    }
  }

  /* 修正类型：魔数是权威，但容器语义要保留（SVG 仍是矢量、ICO 仍是图标） */
  const sig = head && head.length ? detectSignature(head) : null;
  if (sig) {
    item.format = sig.label;
    if (!mime || /octet-stream|text\/plain/i.test(mime)) mime = sig.mime;
    if (sig.type === 'vector') item.type = 'vector';
    else if (sig.type === 'icon') item.type = 'icon';
    else if (sig.type === 'image') { if (item.type !== 'icon') item.type = 'image'; }
    else if (sig.type === 'video' || sig.type === 'audio') item.type = sig.type;
    else if (!typeFromExt(item.ext) || item.type === 'other') item.type = sig.type;
    if (sig.ext && (!item.ext || item.ext === 'bin')) item.ext = sig.ext;
    else if (sig.ext && sig.ext !== item.ext && (TYPES[sig.type] || sig.type === 'vector' || sig.type === 'icon')) {
      /** 地址后缀与真实魔数不符：以字节为准，导出的扩展名才不会“png 打不开” */
      item.extCorrected = item.ext;
      item.ext = sig.ext;
    }
  }
  item.mime = mime || guessMime(item.type, item.ext);
  if (!item.ext) item.ext = extFromMime(item.mime) || '';
  item.size = total != null ? total : (head ? head.length : null);

  /* 小文件直接完整下载并缓存（用于精确尺寸与后续导出） */
  let full = null;
  const limit = item.type === 'video' || item.type === 'audio' ? FULL_LIMIT_MEDIA : item.type === 'image' ? FULL_LIMIT_IMAGE : FULL_LIMIT_DOC;
  if (cached && item.size && item.size <= MAX_ASSET_BYTES) {
    full = readHeadFile(url, MAX_ASSET_BYTES);
    /* 命中缓存时也要有指纹，否则「重复内容」标不出来 */
    if (full && full.length === item.size && !item.hash) {
      item.hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 16);
      if (!item.mime) item.mime = cached.meta.contentType || guessMime(item.type, item.ext);
    }
  } else if (!cached && item.size && item.size <= limit) {
    try {
      const got = await grab(url, { maxBytes: limit + 1, referer: job.url, retries: 0 });
      if (got.ok && got.bytes && !got.truncated) {
        full = got.body;
        item.cached = await writeCache(url, { buffer: full, contentType: got.contentType || mime, status: got.status, finalUrl: got.finalUrl });
        item.size = full.length;
        if (!head || full.length > head.length) head = full;
        item.hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 16);
      }
    } catch { /* 保留头部信息 */ }
  } else if (!cached) {
    item.truncated = true;
  }

  /* 大体积音视频：读取尾部以获得时长 */
  let tail = null;
  const needTail = (item.type === 'video' || item.type === 'audio') && !full && total && total > PROBE_HEAD_BYTES * 2;
  if (needTail) {
    try {
      const got = await grab(url, { maxBytes: PROBE_HEAD_BYTES, range: 'bytes=' + Math.max(0, total - PROBE_HEAD_BYTES) + '-' + (total - 1), referer: job.url, retries: 0 });
      tail = got.body;
    } catch { /* noop */ }
  }

  if (head || full || tail) applyBytesMeta(item, full || head, job, tail);

  if (item.status === 'pending') item.status = 'ok';
  if (item.status !== 'ok') item.size = null;
  if (item.type === 'video' || item.type === 'audio') item.preview = true;
  else item.preview = previewable(item.type, item.mime);
  return finishItem(job, item, full);
}

function finishItem(job, item, full) {
  if (!item.name) item.name = displayName(item.url, item);
  item.name = uniqueName(item.name, job);
  item.src = '/api/proxy?url=' + encodeURIComponent(item.url);
  item.download = '/api/proxy?url=' + encodeURIComponent(item.url) + '&download=1';
  if (full && looksTextual(full) && ['stylesheet', 'script', 'data', 'document'].includes(item.type)) {
    item.sample = textSample(full, 2600);
  }
  if (!item.format) item.format = formatHint(item);
  delete item.index0;
  return item;
}

function applyBytesMeta(item, buffer, job, tail) {
  if (item.type === 'image' || item.type === 'vector' || item.type === 'icon') {
    const dims = imageDimensions(buffer || Buffer.alloc(0), item.mime) || (tail ? imageDimensions(tail, item.mime) : null);
    if (dims) {
      if (dims.width && dims.height) { item.width = dims.width; item.height = dims.height; }
      copyMeta(item, dims);
    }
  }
  if (item.type === 'video' || item.type === 'audio') {
    const buffers = [buffer, tail].filter(Boolean);
    for (const b of buffers) {
      const meta = mediaMeta(b, item.mime, item.url, tail);
      if (meta.duration && item.duration == null) item.duration = round(meta.duration, 2);
      if (meta.width && meta.height && !item.width) { item.width = meta.width; item.height = meta.height; }
      copyMeta(item, meta);
    }
  }
  if ((item.type === 'document' || item.type === 'sheet') && buffer && looksTextual(buffer)) {
    item.textLike = true;
    item.sample = textSample(buffer, 2600);
  }
  deepContainerMeta(item, buffer, tail);
}

/** 文档 / 压缩包 / 播放列表 / 字体的深度解析 */
function deepContainerMeta(item, buffer, tail) {
  if (!buffer || !buffer.length) return;
  const mime = String(item.mime || '').toLowerCase();
  const ext = String(item.ext || '').toLowerCase();
  const head = buffer.subarray(0, Math.min(buffer.length, 2 * 1024 * 1024));

  /* 自适应码率清单 */
  if (item.type === 'video' || /mpegurl|dash\+xml/.test(mime) || /\.(m3u8|mpd)$/.test(ext)) {
    const pl = playlistMeta(head, item.url || '', mime);
    if (pl) {
      copyMeta(item, pl);
      if (pl.duration) item.duration = round(pl.duration, 2);
      if (pl.width && pl.height && !item.width) { item.width = pl.width; item.height = pl.height; }
      if (pl.variants) delete item.variants;
      item.variantCount = pl.variantCount || 0;
      item.playlistInfo = [
        pl.variantCount ? pl.variantCount + ' 档清晰度' : '单路分片流',
        pl.segments ? pl.segments + ' 个分片' : '',
        pl.bitrate ? Math.round(pl.bitrate / 1000) + ' kbps' : '',
        (pl.languages || []).length ? '语言 ' + pl.languages.join('/') : '',
        pl.encrypted ? '已加密' : '',
        pl.live ? '直播' : '',
      ].filter(Boolean).join(' · ');
      item.kind = pl.kind;
      if (pl.variants && pl.variants.length) {
        item.variantList = pl.variants.slice(0, 8).map((v) => [v.width && v.height ? v.width + '×' + v.height : '', v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : '', v.codecs || ''].filter(Boolean).join(' '));
      }
    }
  }

  /* PDF */
  if (ext === 'pdf' || /pdf/.test(mime) || ascii4(head, 0) === '%PDF') {
    const pm = pdfMeta(head.length > 4 * 1024 * 1024 ? head.subarray(0, 4 * 1024 * 1024) : buffer.length > 4 * 1024 * 1024 ? head : buffer);
    if (pm && (pm.pages || pm.title)) {
      if (pm.width && pm.height) {
        pm.pageWidth = pm.width;
        pm.pageHeight = pm.height;
        delete pm.width;
        delete pm.height;
      }
      copyMeta(item, pm);
      item.docInfo = [pm.pages ? pm.pages + ' 页' : '', pm.pageSize || '', pm.title || '', pm.creator || ''].filter(Boolean).join(' · ');
    }
  }

  /* OOXML / ODF / EPUB */
  if (item.type === 'document' || item.type === 'sheet' || item.type === 'archive'
      || /zip|epub|officedocument|opendocument/.test(mime) || /\.(docx|xlsx|pptx|epub|odt|ods|odp)$/.test(ext)) {
    const om = officeMeta(buffer);
    if (om && (om.flavor || om.entries)) {
      copyMeta(item, om);
      if (om.pages) item.docInfo = [om.pages + ' 页', om.title || '', om.creator || ''].filter(Boolean).join(' · ');
      if (om.entryNames) delete om.entryNames;
    }
  }

  /* 字体：家族 / 字形数 / 图标字体 */
  if (item.type === 'font' || /\/font|typeface/.test(mime)) {
    const fm = fontMeta(head, mime);
    if (fm && Object.keys(fm).length) {
      copyMeta(item, fm);
      if (fm.iconFont) item.iconFont = true;
      item.fontName = [fm.family, fm.style].filter(Boolean).join(' ') || fm.fullName || fm.postscriptName || '';
    }
  }
}

function ascii4(b, at) {
  if (!b || at + 4 > b.length) return '';
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(b[at + i]);
  return s;
}

/** 把探测到的细节挂到条目上（只在有值时写，避免 SSE 载荷变肥） */
const META_KEYS = [
  /* 图片 */
  'vector', 'animated', 'frames', 'duration', 'symbols', 'sprite', 'shapes', 'uses', 'textNodes', 'primitiveCount',
  'effects', 'bitDepth', 'colorType', 'channels', 'alpha', 'interlaced', 'progressive', 'baseline', 'colorSpace',
  'orientation', 'entries', 'sizes', 'dpi', 'lossless', 'viewBox', 'iconSet', 'loops', 'version', 'background',
  'svgTitle', 'svgDesc', 'stroke', 'embeddedImages', 'transport', 'maxVal', 'mipLevels', 'cubemap', 'volume',
  'keyframes', 'disposal', 'overwrite', 'transparent', 'palette', 'delay',
  'arraySize', 'hdr', 'compressed', 'idLength', 'origin', 'thumbnailBytes', 'thumbnailFormat',
  /* 相机与色彩 */
  'camera', 'software', 'dateTimeOriginal', 'iso', 'shutter', 'shutterLabel', 'aperture', 'apertureLabel',
  'focalLength35', 'lensModel', 'gps', 'comment', 'incomplete', 'plays',
  /* 视音频 */
  'sampleRate', 'bit', 'bitrate', 'codec', 'rotation', 'timescale', 'vbr', 'cbr', 'title', 'sampleFormat',
  'dataBytes', 'frameRate', 'tracks', 'trackKinds', 'brand', 'compatibleBrands', 'faststart', 'fragmented',
  'created', 'modified', 'audioCodec', 'album', 'genre', 'year', 'cover', 'tagVersion', 'albumArtist',
  'track', 'disc', 'container', 'interleaved', 'noAudio', 'noVideo', 'videoBytes', 'copyright', 'language',
  'edited', 'samples', 'chunkOffsets', 'sttsEntries', 'sttsRun', 'encrypted',
  /* 文档 / 播放列表 */
  'pages', 'pageWidth', 'pageHeight', 'pageSize', 'creator', 'subject', 'keywords', 'producer', 'forms',
  'annotations', 'links', 'images', 'linearized', 'objectStreams', 'flavor', 'uncompressedBytes', 'mediaFiles',
  'description', 'lastModifiedBy', 'words', 'paragraphs', 'sheets', 'textCells', 'spine', 'textChars',
  'kind', 'variantCount', 'segments', 'segmentDuration', 'startSequence', 'live', 'firstSegment', 'fmp4',
  'sessionData', 'audioGroups', 'subtitleTracks', 'languages', 'adaptive', 'segmentTemplates', 'periods',
  'minUpdate',
  /* 字体 */
  'fontFlavor', 'numTables', 'glyphs', 'unitsPerEm', 'weightClass', 'widthClass', 'embedding', 'family',
  'style', 'fullName', 'postscriptName', 'designer', 'manufacturer', 'license', 'colorFont', 'features',
  'metrics', 'hinting', 'italicAngle', 'bbox', 'sfntSize', 'totalSfntSize', 'os2Version', 'typoAscender',
  'sfntFlavor', 'compressedSize', 'fontVersion', 'coverage', 'bold', 'fsSelection', 'postFormat', 'artist', 'encoder',
  'imageSet', 'declaredFrom', 'variantList',
];

function copyMeta(item, meta) {
  for (const key of META_KEYS) {
    const v = meta[key];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (item[key] !== undefined && item[key] !== null && item[key] !== '' && item[key] !== false && key !== 'duration') continue;
    item[key] = typeof v === 'number' ? round(v, 3) : v;
  }
}

function readHeadFile(url, maxBytes) {
  const p = cachePath(url);
  try {
    const st = fs.statSync(p);
    const len = Math.min(st.size, maxBytes);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/* ------------------------------------------------------------- 统计 */

function buildStats(job, items, out, extra) {
  const info = extra || {};
  const rescuedCount = items.filter((r) => r.rescued).length;
  if (rescuedCount) out.rescuedTotal = rescuedCount;
  const rescued = rescuedCount || out.rescuedTotal || 0;
  const byType = {};
  for (const key of Object.keys(TYPES)) byType[key] = { type: key, label: TYPES[key].label, en: TYPES[key].en, color: TYPES[key].color, glyph: TYPES[key].glyph, count: 0, bytes: 0, ok: 0, failed: 0 };
  const hosts = new Map();
  let bytes = 0;
  let ok = 0;
  let failed = 0;
  let withSize = 0;
  for (const r of items) {
    const g = byType[r.type] || byType.other;
    g.count++;
    if (r.size) { g.bytes += r.size; bytes += r.size; withSize++; }
    if (r.status === 'ok') { g.ok++; ok++; } else { g.failed++; failed++; }
    if (r.host) {
      const h = hosts.get(r.host) || { host: r.host, count: 0, bytes: 0 };
      h.count++;
      if (r.size) h.bytes += r.size;
      hosts.set(r.host, h);
    }
  }
  const groups = Object.values(byType).filter((g) => g.count > 0).sort((a, b) => b.bytes - a.bytes || b.count - a.count);
  const largest = [...items].filter((r) => r.size).sort((a, b) => b.size - a.size).slice(0, 8)
    .map((r) => ({ id: r.id, name: r.name, size: r.size, type: r.type }));
  const provenance = {};
  for (const r of items) provenance[r.provenance] = (provenance[r.provenance] || 0) + 1;
  const textBytes = out.textBlocks.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf-8'), 0);
  return {
    total: items.length,
    refs: job.refTotal || items.length,
    bytes,
    ok, failed, withSize,
    groups,
    provenance,
    hosts: [...hosts.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count).slice(0, 14),
    largest,
    duration: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
    duplicates: items.filter((r) => r.dup).length,
    mediaSeconds: items.reduce((n, r) => n + (r.duration || 0), 0),
    pixels: items.reduce((n, r) => n + (r.width && r.height ? r.width * r.height : 0), 0),
    text: {
      blocks: out.textBlocks.length,
      chars: out.textBlocks.reduce((n, b) => n + b.chars, 0),
      words: out.textBlocks.reduce((n, b) => n + b.words, 0),
      bytes: textBytes,
      headings: out.headings.length,
      noise: out.textBlocks.filter((b) => b.zone === 'noise').length,
    },
    doc: { bytes: out.doc.bytes || 0 },
    filtered: info.filterSummary || out.filterSummary || summarize(out.filtered || []),
    rescued: rescued || out.rescuedTotal || 0,
    families: info.families || { groups: 0, collapsed: 0 },
    css: info.css ? { files: info.css.done, depth: info.css.depth, imports: info.css.imports, failed: info.css.failed } : null,
    policy: {
      includeIcons: !!job.options.includeIcons,
      includeTech: !!job.options.includeTech,
      mode: job.options.includeIcons && job.options.includeTech ? '全部资源' : job.options.includeIcons ? '含 UI 图标' : job.options.includeTech ? '含技术资源' : '仅内容资源',
    },
    requests: {
      probed: items.length + (out.filtered || []).filter((f) => f.probed).length,
      skipped: out.filteredTotal != null ? out.filteredTotal : (out.filtered || []).length,
    },
  };
}

function markDuplicates(items) {
  const seen = new Map();
  for (const r of items) {
    if (!r.hash) continue;
    if (seen.has(r.hash)) {
      r.dup = true;
      seen.get(r.hash).dup = true;
    } else seen.set(r.hash, r);
  }
}

function mergeRefLists(a, b) {
  const map = new Map();
  for (const r of a) map.set(r.dataUri ? 'd' + (r.dataUri.data || '').slice(0, 60) : r.url, r);
  const out = [...a];
  for (const r of b) {
    const key = r.dataUri ? 'd' + (r.dataUri.data || '').slice(0, 60) : r.url;
    if (map.has(key)) {
      const prev = map.get(key);
      prev.count++;
      if (r.page) prev.page = prev.page || r.page;
      continue;
    }
    map.set(key, r);
    out.push(r);
  }
  out.forEach((r, i) => { r.index = i + 1; r.id = 'r' + (i + 1); });
  return out;
}

function mergeTextBlocks(existing, incoming, pageUrl) {
  const seen = new Set(existing.map((b) => b.tag + '|' + b.text));
  const out = existing.slice();
  let n = out.length;
  for (const b of incoming) {
    const key = b.tag + '|' + b.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.assign({}, b, { id: 't' + (++n), page: pageUrl }));
  }
  return out;
}

function pickCrawlTargets(links, baseUrl, limit) {
  const seen = new Set([new URL(baseUrl).pathname]);
  const out = [];
  for (const l of links) {
    if (out.length >= limit) break;
    if (!sameOrigin(l.url, baseUrl)) continue;
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (u.pathname !== baseUrl && seen.has(u.pathname)) continue;
    if (/\.(pdf|zip|docx?|xlsx?|mp4|mp3|png|jpe?g|gif|webp|svg|js|css)($|[?#])/i.test(u.pathname)) continue;
    if (/(login|signin|logout|signup|register|cart|checkout|share|print)/i.test(u.pathname)) continue;
    seen.add(u.pathname);
    out.push(u.toString());
  }
  return out;
}

/* --------------------------------------------------- 单资源重新探测 */

export async function reprobeItems(job, urls = [], ids = []) {
  const result = job.result || job.partial;
  if (!result) return [];
  const wantUrl = new Set(urls.filter(Boolean));
  const wantId = new Set(ids.filter(Boolean));
  const targets = result.resources.filter((r) => wantId.has(r.id) || wantUrl.has(r.url));
  const ctx = { id: job.id, url: job.url, startedAt: Date.now() - 1000, options: job.options, logs: [], events: job.events, listeners: job.listeners, inlineMap: job.inlineMap || new Map() };
  const updated = [];
  for (const target of targets) {
    const freshRef = {
      id: target.id, url: target.url, dataUri: null, ext: target.ext, type: target.type,
      tag: target.tag, attr: target.attr, provenance: target.provenance, hint: target.hint,
      count: target.count, line: target.line, alt: target.alt, density: target.density, index: target.index,
    };
    try {
      const next = await probeRef(ctx, freshRef);
      Object.assign(target, next, { id: target.id, index: target.index });
    } catch (err) {
      target.status = 'error';
      target.error = (err.message || '探测失败').slice(0, 140);
    }
    updated.push(target);
  }
  result.stats = buildStats(job, result.resources, result);
  return updated;
}

export function rebuildStats(job) {
  const result = job.result;
  if (!result) return null;
  result.stats = buildStats(job, result.resources, result);
  return result.stats;
}

export function inlineAsset(jobId, itemId) {
  const job = getJob(jobId);
  const entry = job && job.inlineMap && job.inlineMap.get(itemId);
  if (!entry) return null;
  try {
    const buffer = Buffer.from(entry.data, entry.base64 ? 'base64' : 'utf-8');
    return { mime: entry.mime, buffer, name: entry.name };
  } catch { return null; }
}

/* ------------------------------------------------------------ 工具 */

const usedNames = new Map();

function uniqueName(name, job) {
  const key = job.id + '::' + name.toLowerCase();
  if (!usedNames.has(key)) { usedNames.set(key, 1); return name; }
  const n = usedNames.get(key) + 1;
  usedNames.set(key, n);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return name.slice(0, dot) + '-' + n + name.slice(dot);
  return name + '-' + n;
}

function displayName(url, item) {
  const fromUrl = filenameFromUrl(url);
  if (fromUrl && /\.[a-z0-9]{1,6}$/i.test(fromUrl)) return clip(fromUrl);
  const base = fromUrl || (hostOf(url).replace(/[^a-z0-9]/gi, '_') + '-' + shortHash(url, 6));
  const ext = item && item.ext ? '.' + item.ext : '';
  return clip(base + ext);
}

function clip(s, n = 84) {
  const str = String(s || '').replace(/[\r\n\t]/g, ' ').replace(/[\\/:*?"<>|]/g, '_').trim();
  return str.length > n ? str.slice(0, n - 4) + '…' + str.slice(-3) : str || 'unnamed';
}

function round(v, d) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function formatHint(item) {
  if (item.ext && TYPES[item.type]) return String(item.ext).toUpperCase();
  const m = /\/([a-z0-9.+-]+)/i.exec(item.mime || '');
  return m ? m[1].toUpperCase() : String(item.type).toUpperCase();
}

function sniffCharset(buffer) {
  if (!buffer || !buffer.length) return '';
  const head = String(buffer.subarray(0, 4096).toString('latin1'));
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || /charset=([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : '';
}

const DATA_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'application/pdf': 'pdf', 'font/woff2': 'woff2', 'font/woff': 'woff', 'application/json': 'json', 'text/plain': 'txt', 'text/css': 'css', 'text/javascript': 'js' };

function extFromDataUri(mime) {
  return DATA_EXT[mime] || (mime && mime.indexOf('/') > 0 ? mime.split('/')[1].replace(/[^a-z0-9]/gi, '').slice(0, 5) : 'bin');
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, Number(n));
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + units[i];
}