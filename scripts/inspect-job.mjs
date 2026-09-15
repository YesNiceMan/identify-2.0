import fs from 'node:fs';
const o = JSON.parse(fs.readFileSync('/tmp/job.json', 'utf8'));
console.log('status', o.status, 'phase', o.phase, 'progress', o.progress, 'error', o.error);
const r = o.result || {};
console.log('doc', JSON.stringify({ title: r.doc && r.doc.title, host: r.doc && r.doc.host, bytes: r.doc && r.doc.bytes, favicon: r.doc && r.doc.favicon, charset: r.doc && r.doc.charset }));
console.log('resources', (r.resources || []).length, 'text', (r.textBlocks || []).length);
for (const x of (r.resources || [])) {
  console.log([x.status, x.type, x.ext, x.size != null ? x.size : '-', (x.width || '-') + 'x' + (x.height || '-'), (x.duration || '-'), x.provenance, x.tag, String(x.attr).slice(0, 12), String(x.name).slice(0, 30), x.format, x.cached ? 'C' : ''].join(' | '));
}
if (r.stats) console.log('STATS', JSON.stringify(r.stats.groups), 'total', r.stats.total, 'bytes', r.stats.bytes, 'ok', r.stats.ok, 'failed', r.stats.failed, 'dups', r.stats.duplicates);
console.log('LOGS');
for (const l of (o.logs || [])) console.log('  ', l.kind, l.msg.slice(0, 110));
