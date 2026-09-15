/**
 * 离线自检：解析器 / 打包器 / 元数据探测
 * 用法：node scripts/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractPage } from '../server/extract.mjs';
import { ZipWriter } from '../server/zip.mjs';
import { imageDimensions, mediaMeta, detectSignature, looksTextual } from '../server/probe.mjs';
import { classify, extFromPath, typeFromExt } from '../server/mime.mjs';
import { normalizeUrl } from '../server/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = 'http://127.0.0.1:4620/samples/lab';
const html = fs.readFileSync(path.join(ROOT, 'public/samples/lab.html'), 'utf-8');

let pass = 0;
let fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log('  \u001b[32mPASS\u001b[0m ' + label); }
  else { fail++; console.log('  \u001b[31mFAIL\u001b[0m ' + label + (detail ? '  \u001b[2m' + detail + '\u001b[0m' : '')); }
};

console.log('\n\u001b[1m1. HTML 解析器\u001b[0m');
const t0 = Date.now();
const r = extractPage(html, BASE);
const ms = Date.now() - t0;
ok(ms < 1500, '解析耗时 ' + ms + 'ms（< 1500ms）', ms + 'ms');
const urls = r.resources.map((x) => x.url);
const has = (frag) => urls.some((u) => u.includes(frag));
ok(has('aurora-1920x1080.png'), '抓到 img src 图片');
ok(has('badge-96.png') && has('badge-512.png'), '抓到 srcset 多密度候选');
ok(has('icon-mask.svg'), '抓到 SVG 矢量');
ok(has('blip-mono.wav') && has('chime-stereo.wav'), '抓到 video source / audio src');
ok(has('specimen.pdf') && has('bundle-sample.zip') && has('inventory.csv'), '抓到 a[download] 文档与压缩包');
ok(has('missing-404.png'), '抓到失效引用（不静默丢弃）');
ok(has('hidden-lazy-320x200.png'), '抓到仅存在于脚本 JSON 的隐藏地址');
ok(has('dot-64.png') && r.resources.some((x) => x.attr === 'link:href' || x.tag === 'link'), '抓到 favicon link');
ok(r.resources.some((x) => x.url.includes('aurora-1920x1080') && x.count >= 3), '同一图片被 img/style/script 三处引用并合并计数');
ok(r.resources.filter((x) => x.provenance === 'datauri').length === 2, '抓到 2 个 data URI 图片（含 35KB 大图）');
ok(r.resources.some((x) => x.url.includes('aurora-2560x1440') && x.count >= 2), '抓到懒加载 data-src（与 og:image 合并）');
ok(r.resources.some((x) => x.provenance === 'inferred' && x.url.includes('hidden-lazy')), '脚本内嵌裸链接标记为 inferred');
ok(!!r.doc.favicon && r.doc.favicon.includes('dot-64'), '读取 favicon 元数据');
ok(!!r.doc.ogImage && r.doc.ogImage.includes('aurora-2560'), '读取 og:image');
ok(/资源标本馆/.test(r.doc.title), '读取 title：' + r.doc.title);
ok(r.textBlocks.length > 12, '文案块数量 ' + r.textBlocks.length);
ok(r.textBlocks.some((b) => b.tag === 'h1' && /资源标本馆/.test(b.text)), '标题层级 h1');
ok(r.textBlocks.filter((b) => b.level >= 2).length >= 6, '二级以上标题 >= 6');
ok(r.textBlocks.some((b) => b.tag === 'blockquote'), '引用块');
ok(r.textBlocks.some((b) => b.tag === 'td'), '表格单元格文案');
ok(r.textBlocks.some((b) => b.zone === 'noise'), '页脚文字被标记为 noise');
ok(extFromPath('a/b/image.png') === 'png' && extFromPath('archive.tar.gz') === 'gz' && extFromPath('noext') === '', '扩展名解析');
const mainPara = r.textBlocks.find((b) => b.tag === 'p' && b.chars > 80);
ok(!!mainPara, '存在长正文段落（chars=' + (mainPara ? mainPara.chars : 0) + '）');
ok(r.keywords.length > 4, '关键词抽取 ' + r.keywords.length + ' 条：' + r.keywords.slice(0, 5).map((k) => k.term).join('/'));
const dupIds = new Set(r.resources.filter((x) => x.url).map((x) => x.url));
const httpRefs = r.resources.filter((x) => x.url).length;
ok(dupIds.size === httpRefs, '按绝对 URL 去重（http ' + httpRefs + ' 条 + ' + (r.resources.length - httpRefs) + ' 个内联）');
ok(r.resources.every((x) => !/^(javascript|mailto):/i.test(x.url)), '过滤非 http 协议');
ok(r.resources.some((x) => x.count > 1), '重复引用计数 count>1');
const classified = r.resources.filter((x) => x.type === 'other' && typeFromExt(x.ext));
ok(classified.length === 0, '扩展名与类别一致', classified.map((x) => x.ext).join(','));

console.log('\n\u001b[1m2. 分类与 URL\u001b[0m');
ok(classify({ mime: '', ext: 'webp', context: '' }) === 'image', 'webp → image');
ok(classify({ mime: '', ext: 'm4a', context: '<video' }) === 'audio', 'm4a → audio');
ok(classify({ mime: 'application/octet-stream', ext: 'woff2', context: '' }) === 'font', 'woff2 → font');
ok(classify({ mime: '', ext: 'svg', context: '<img' }) === 'vector', 'svg → vector');
ok(classify({ mime: 'image/png', ext: '', context: '' }) === 'image', '仅 MIME 也能定类');
ok(normalizeUrl('../a.png', BASE) === 'http://127.0.0.1:4620/a.png', '相对路径 ../ 解析');
ok(normalizeUrl('assets/x.png', BASE) === 'http://127.0.0.1:4620/samples/assets/x.png', '相对路径 assets/ 解析');
ok(normalizeUrl('//cdn.x.com/a.png', BASE) === 'https://cdn.x.com/a.png' || normalizeUrl('//cdn.x.com/a.png', BASE) === 'http://cdn.x.com/a.png', '协议相对地址');
ok(normalizeUrl('javascript:void(0)', BASE) === null, '拒绝 javascript: 伪地址');
ok(normalizeUrl('assets/a.png?v=1#x', BASE).indexOf('#') < 0, '去掉 hash');

console.log('\n\u001b[1m3. 元数据探测\u001b[0m');
const png = fs.readFileSync(path.join(ROOT, 'public/samples/assets/aurora-1920x1080.png'));
const dims = imageDimensions(png, 'image/png');
ok(dims && dims.width === 1920 && dims.height === 1080, 'PNG 尺寸 1920x1080', JSON.stringify(dims));
const small = png.subarray(0, 64);
ok(imageDimensions(small, 'image/png').width === 1920, '仅前 64 字节即可读出 PNG 尺寸');
const svgBuf = fs.readFileSync(path.join(ROOT, 'public/samples/assets/logo-crest.svg'));
const sv = imageDimensions(svgBuf, 'image/svg+xml');
ok(sv && sv.width === 320 && sv.height === 120, 'SVG viewBox/width 解析', JSON.stringify(sv));
const wavBuf = fs.readFileSync(path.join(ROOT, 'public/samples/assets/chime-stereo.wav'));
const wm = mediaMeta(wavBuf, 'audio/wav', 'x.wav');
ok(wm.duration > 5.4 && wm.duration < 5.6 && wm.channels === 2 && wm.sampleRate === 44100, 'WAV 时长/声道/采样率 ' + JSON.stringify(wm));
const sigP = detectSignature(png);
ok(sigP && sigP.ext === 'png', '魔数识别 PNG');
const sigW = detectSignature(wavBuf);
ok(sigW && sigW.type === 'audio', '魔数识别 WAV');
ok(detectSignature(fs.readFileSync(path.join(ROOT, 'public/samples/assets/specimen.pdf'))).ext === 'pdf', '魔数识别 PDF');
ok(detectSignature(fs.readFileSync(path.join(ROOT, 'public/samples/assets/bundle-sample.zip'))).ext === 'zip', '魔数识别 ZIP');
ok(looksTextual(Buffer.from('hello \u4f60好')) === true, '文本判定');
ok(looksTextual(Buffer.from([0, 1, 2, 3, 0, 0, 255, 9])) === false, '二进制判定');

console.log('\n\u001b[1m4. ZIP 打包器\u001b[0m');
const { Writable } = await import('node:stream');
const chunks = [];
const sink = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
const zip = new ZipWriter(sink);
const payload = Buffer.concat(Array.from({ length: 400 }, () => Buffer.from('IDENTIFY 原始字节导出测试 ')));
await zip.add('包 A/图片/中文名称.png', png);
await zip.add('包 A/README.txt', 'hello');
await zip.add('包 A/大文件.bin', payload);
await zip.finish();
const zipBuf = Buffer.concat(chunks);
fs.writeFileSync(path.join(ROOT, '.tmp-selftest.zip'), zipBuf);
ok(zipBuf.readUInt32LE(0) === 0x04034b50, '本地文件头签名');
ok(zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) > 0, '中央目录结束记录');
const roundtrip = await unzipCheck(zipBuf);
ok(roundtrip.ok, '解压往返一致：条目 ' + roundtrip.names.join(' , '), roundtrip.error || '');
ok(roundtrip.samePng, 'PNG 字节完全一致（原大小 / 未再编码）');
ok(roundtrip.sameBig, 'deflate 往返一致');
fs.rmSync(path.join(ROOT, '.tmp-selftest.zip'), { force: true });

function unzipCheck(buf) {
  const result = { ok: false, names: [], samePng: false, sameBig: false, error: '' };
  try {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central header 损坏 @' + p);
      const method = buf.readUInt16LE(p + 10);
      const usize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
      result.names.push(name);
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const csize = buf.readUInt32LE(lho + 18);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + csize);
      const out = method === 8 ? zlib.inflateRawSync(data) : data;
      if (out.length !== usize) throw new Error(name + ' 体积不符 ' + out.length + '!=' + usize);
      if (name.endsWith('.png')) result.samePng = out.equals(png);
      if (name.endsWith('.bin')) result.sameBig = out.equals(payload);
      p += 46 + nameLen + extraLen + commentLen;
    }
    result.ok = true;
  } catch (err) { result.error = err.message; }
  return result;
}

console.log('\n\u001b[1m结果：' + pass + ' 通过 / ' + fail + ' 失败\u001b[0m\n');
process.exitCode = fail ? 1 : 0;
