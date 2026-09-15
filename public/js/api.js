/** 与本地解析服务的通信层 */

export async function api(path, body, opts) {
  const o = opts || {};
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: o.signal,
  });
  if (o.raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.message || data.error || ('HTTP ' + res.status));
    err.code = data.code || res.status;
    throw err;
  }
  return data;
}

export function startScan(payload) {
  return api('/api/scan', payload);
}

export function loadJob(id) {
  return api('/api/jobs/' + encodeURIComponent(id));
}

export function reprobe(job, ids) {
  return api('/api/reprobe', { job: job, ids: ids });
}

export function purgeCache() {
  return api('/api/cache/purge', {});
}

/**
 * SSE 订阅任务事件。
 * handlers: { status, log, meta, item, progress, done, error }
 */
export function streamJob(jobId, handlers) {
  const es = new EventSource('/api/jobs/' + encodeURIComponent(jobId) + '/events');
  const names = ['status', 'log', 'meta', 'item', 'progress', 'done', 'reopen', 'error'];
  for (const name of names) {
    es.addEventListener(name, (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { data = null; }
      if (!data) return;
      if (name === 'status' && handlers.phase) handlers.phase(data);
      if (handlers[name]) handlers[name](data);
    });
  }
  es.onerror = () => {
    if (es.readyState === 2) { es.close(); if (handlers.gone) handlers.gone(); }
  };
  return () => es.close();
}

/** 打包导出：流式读取 zip 并显示真实字节进度 */
export async function bundle(payload, onProgress) {
  const res = await fetch('/api/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch { /* noop */ }
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }
  const total = Number(res.headers.get('x-entry-count')) || 0;
  const name = filenameFromDisposition(res.headers.get('content-disposition'));
  const type = res.headers.get('content-type') || 'application/zip';
  let blob;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      received += r.value.length;
      if (onProgress) onProgress({ bytes: received, entries: total, name: name });
    }
    blob = new Blob(chunks, { type: type });
  } else {
    blob = await res.blob();
    if (onProgress) onProgress({ bytes: blob.size, entries: total, name: name });
  }
  saveBlob(blob, name || 'identify.zip');
  return { bytes: blob.size, name: name, entries: total };
}

/** 文案导出（md/txt/csv/json/html） */
export async function exportText(payload) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  const name = filenameFromDisposition(res.headers.get('content-disposition'));
  const blob = await res.blob();
  saveBlob(blob, name || 'text.' + (payload.format || 'md'));
  return { bytes: blob.size, name: name };
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

function filenameFromDisposition(value) {
  if (!value) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* noop */ } }
  const plain = /filename="([^"]+)"/i.exec(value);
  return plain ? plain[1] : '';
}

export function proxySrc(url, name) {
  return '/api/proxy?url=' + encodeURIComponent(url) + (name ? '&name=' + encodeURIComponent(name) : '');
}

export function downloadSrc(url, name) {
  return proxySrc(url, name) + '&download=1';
}
