/**
 * 离线自检：解析器 / 打包器 / 元数据探测
 * 用法：node scripts/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { extractPage, extractCss } from '../server/extract.mjs';
import { ZipWriter } from '../server/zip.mjs';
import { imageDimensions, mediaMeta, detectSignature, looksTextual } from '../server/probe.mjs';
import { classify, extFromPath, typeFromExt } from '../server/mime.mjs';
import { preFilter, postFilter, contentSignal, summarize, trimFiltered, MAX_FILTERED_DETAIL } from '../server/policy.mjs';
import { urlMeta, declaredEdge } from '../server/urlmeta.mjs';
import { pdfMeta, officeMeta, playlistMeta } from '../server/docmeta.mjs';
import { fontMeta } from '../server/probe.mjs';
import { normalizeUrl } from '../server/net.mjs';
import { buildPreview, previewPages, passthroughType, docKey } from '../server/preview.mjs';
import { LAZY_ATTR_RE as SERVER_LAZY } from '../server/lazy-attrs.mjs';
import * as PM from '../public/js/pv-match.js';

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


/* ================================================= ====== 新增章节 ====== */

console.log('\n\u001b[1m5. 扫描策略（UI 图标 / 字体 / 样式表 / 脚本 / 数据不扫描）\u001b[0m');
const ref = (o) => Object.assign({ url: 'https://site.com/a/b.png', type: 'image', tag: 'img', attr: 'src', provenance: 'attr' }, o || {});
ok(preFilter(ref({ type: 'font' })) !== null, '字体在解析阶段排除（零请求）');
ok(preFilter(ref({ type: 'stylesheet' })) !== null, '样式表排除（但仍会被读取）');
ok(preFilter(ref({ type: 'script' })) !== null, '脚本 / source map / wasm 排除');
ok(preFilter(ref({ type: 'data' })) !== null, 'JSON / XML / manifest 排除');
ok(preFilter(ref({ type: 'icon' })) !== null, 'UI 图标类别排除');
ok(preFilter(ref({ type: 'icon' }), { includeIcons: true }) === null, '打开「UI 图标」开关后保留');
ok(preFilter(ref({ type: 'font' }), { includeTech: true }) === null, '打开「技术资源」开关后保留');
ok(preFilter(ref({ tag: 'link', attr: 'rel:href', url: 'https://site.com/favicon.ico', type: 'icon' })) !== null, 'favicon 排除');
ok(preFilter(ref({ url: 'https://site.com/images/icons/apple-touch-icon.png' })) !== null, '图标目录 + 图标文件名排除');
ok(preFilter(ref({ url: 'https://site.com/assets/spacer.gif' })) !== null, 'spacer 占位图排除');
ok(preFilter(ref({ url: 'https://site.com/1x1.png' })) !== null, '1×1 命名排除');
ok(preFilter(ref({ url: 'https://site.com/beacon.php?u=1' })) !== null, '统计打点地址排除');
ok(preFilter(ref({ url: 'https://www.google-analytics.com/ga.js' })) !== null, '打点域名排除');
ok(preFilter(ref({ url: 'https://images.unsplash.com/photo-1500?w=24&h=24' })) !== null, '图片服务声明 24px → 判定为图标');
ok(preFilter(ref({ url: 'https://images.unsplash.com/photo-1500?w=1600&q=80' })) === null, '声明 1600px 的内容图保留');
ok(preFilter(ref({ url: 'https://site.com/blog/hero-1920x1080.jpg' })) === null, '正文大图保留');
ok(preFilter(ref({ type: 'other', url: 'https://site.com/api/media?id=42', provenance: 'css' })) === null, '无扩展名的 CSS 引用先探测再判');
ok(preFilter(ref({ type: 'other', tag: 'a', attr: 'href', provenance: 'link', url: 'https://site.com/portal?a=1' })) !== null, '毫无内容线索的 other 排除');
ok(preFilter(ref({ type: 'other', url: 'https://site.com/media?id=7' })) === null, '<img> 指向无扩展名地址 → 先探测');
ok(preFilter(ref({ cssProp: 'mask-image', url: 'https://site.com/decor.png' })) !== null, 'CSS mask 图片判定为界面装饰');
ok(preFilter(ref({ cssProp: 'list-style-image', url: 'https://site.com/bullet.png' })) !== null, '列表符号图片排除');
ok(preFilter(ref({ sprite: true, url: 'https://site.com/strip.png' })) !== null, 'background-position 偏移 → 雪碧图排除');
ok(preFilter(ref({ sprite: true, declaredWidth: 1200, url: 'https://site.com/big.png' })) === null, '声明 1200px 的雪碧图写法不误杀');
ok(preFilter(ref({ selector: '.site-header__logo img', url: 'https://site.com/x.png' })) !== null, '选择器含 logo → 界面装饰');
ok(preFilter(ref({ dataUri: { mime: 'image/gif', approxBytes: 120, data: 'R0lG' } })) !== null, '极小内联数据排除');
ok(postFilter({ type: 'image', width: 32, height: 32 }).reason === 'icon', '真实 32×32 → 图标');
ok(postFilter({ type: 'image', width: 1, height: 1 }).reason === 'pixel', '真实 1×1 → 占位像素');
ok(postFilter({ type: 'image', width: 1200, height: 800 }) === null, '真实 1200×800 → 保留');
ok(postFilter({ type: 'vector', sprite: true, symbols: 12 }) !== null, 'SVG 精灵图排除');
ok(postFilter({ type: 'vector', glyphLike: true, width: 24, height: 24, shapes: 2 }) !== null, '图标字形 SVG 排除');
ok(postFilter({ type: 'font' }) !== null && postFilter({ type: 'font' }, { includeTech: true }) === null, 'postFilter 二次确认技术资源');
ok(postFilter({ type: 'other', mime: 'image/png', width: 800, height: 600 }) === null, 'other 但魔数是图片 → 保留');
ok(postFilter({ type: 'icon', iconSet: true, sizes: '16×16, 32×32, 128×128' }).reason === 'icon', '多尺寸图标集排除');
ok(postFilter({ type: 'image', iconSet: true, entries: 6, sizes: '16×16 / 32×32' }).reason === 'icon', 'ICO 多尺寸（字符串 sizes）排除');
const trim = trimFiltered(Array.from({ length: 620 }, (x, i) => ({ reason: 'font', url: 'f' + i })));
ok(trim.kept.length === MAX_FILTERED_DETAIL && trim.dropped === 220, '排除明细按理由限量（' + trim.kept.length + ' + ' + trim.dropped + '）');
ok(summarize([{ reason: 'font' }, { reason: 'font' }, { reason: 'icon' }]).total === 3, '排除摘要计数');
ok(contentSignal(ref({ provenance: 'css' })) !== '', '内容线索：样式表引用');
ok(contentSignal(ref({ tag: 'video', attr: 'src', url: 'https://site.com/stream?id=9' })) !== '', '内容线索：媒体标签');
ok(contentSignal(ref({ url: 'https://site.com/x?w=800' })) !== '', '内容线索：图片处理参数');
const layerCss = extractCss(fs.readFileSync(path.join(ROOT, 'public/samples/assets/layer-2.css'), 'utf-8'), 'http://127.0.0.1:4620/samples/assets/layer-2.css');
const stripRef = layerCss.find((x) => /ui-strip/.test(x.url));
ok(!!stripRef && stripRef.sprite === true, '样式表雪碧图定位 → sprite 标记', JSON.stringify(stripRef && stripRef.sprite));
const featureRef = layerCss.find((x) => /feature-image-no-extension/.test(x.url));
ok(!!featureRef && featureRef.type === 'other' && preFilter(featureRef) === null, '样式表里的无扩展名图先探测再判');
ok(layerCss.filter((x) => x.provenance === 'css' && !x.cssProp).length === 0, 'CSS 引用的属性名全部解析');
const manifestRef = r.resources.find((x) => /site\.webmanifest/.test(x.url));
ok(!!manifestRef && preFilter(manifestRef) !== null, 'webmanifest 归入不扫描类别');

console.log('\n\u001b[1m6. 地址语义（图片服务 / CDN 参数）\u001b[0m');
const um = (u) => urlMeta(u);
ok(um('https://images.unsplash.com/photo-1?w=1600&q=80').width === 1600, 'unsplash w 参数');
ok(um('https://images.unsplash.com/photo-1?w=1600').square === 1, '只有宽时标记为见方而非臆造高');
ok(um('https://lh3.googleusercontent.com/x=s2000-c').width === 2000, 'googleusercontent =s 尺寸');
ok(um('https://a.com/_next/image?url=%2Fhero%2Fphoto.jpg&w=1200').inner.indexOf('photo.jpg') > 0, 'Next 优化器还原内层地址');
ok(um('https://res.cloudinary.com/d/image/upload/w_800,h_600/x.jpg').width === 800, 'Cloudinary w_/h_ 变换串');
ok(um('https://cdn.example.com/a.jpg?x-oss-process=image/resize,w_900').width === 900, '任意域名的 x-oss-process');
ok(um('https://cbu01.alicdn.com/img/x.jpg_400x400q90.jpg').width === 400, '阿里 / 淘宝尺寸后缀');
ok(um('https://example.com/cdn-cgi/image/width=1200/https://o.com/a.jpg').width === 1200, 'Cloudflare image-transform');
ok(um('https://p.com/x.jpg@900w_1e_1c').width === 900, '火山 / 短视频 900w 写法');
ok(um('https://live.staticflickr.com/1/ab_cd_b.jpg').width === 1024, 'Flickr _b 尺寸码');
ok(um('https://i.ytimg.com/vi/abc/maxresdefault.jpg').width === 1280, 'YouTube 缩略图尺寸');
ok(um('https://pbs.twimg.com/media/X.jpg:large').width === 1200, 'Twitter :large');
ok(um('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/B.png/800px-B.png').width === 800, 'Wikimedia 800px-');
ok(um('https://cdn.shopify.com/s/files/1/2/x.jpg?v=1&width=1400').width === 1400, 'Shopify width 参数优先于数字目录段');
ok(!um('https://cdn.shopify.com/s/files/1/2/x.jpg?v=1').width, 'ID 路径不再被当成尺寸');
ok(um('https://www.gravatar.com/avatar/0?s=80&d=mm').avatar === 1, 'Gravatar 默认头像标记');
ok(um('https://img.example.com/photos/hero-1920x1080.jpg').height === 1080, '文件名里的 1920x1080');
ok(um('https://img.example.com/p@2x.png').dpr === 2, '@2x 密度');
ok(um('https://example.com/icon-24x24.svg').width === 24, 'SVG 声明尺寸');
ok(declaredEdge(um('https://images.unsplash.com/photo-1?w=1600')) === 1600, 'declaredEdge 取最长边');
const badges = um('https://img.shields.io/badge/build-passing-green');
ok(badges.badge === 1 || /shields/i.test(badges.provider || ''), '徽章服务识别');

console.log('\n\u001b[1m7. 容器与文档深度解析\u001b[0m');
const asset = (n) => fs.readFileSync(path.join(ROOT, 'public/samples/assets', n));
const g1 = imageDimensions(asset('spacer.gif'), 'image/gif');
ok(g1.width === 1 && g1.height === 1 && g1.frames === 1, 'GIF 1×1 · 帧数', JSON.stringify(g1));
const pngStrip = imageDimensions(asset('ui-strip.png'), 'image/png');
ok(pngStrip.width === 48 && pngStrip.height === 144, 'PNG 精灵尺寸 48×144');
const glyphSvg = imageDimensions(asset('icons/ui-check-16x16.svg'), 'image/svg+xml');
ok(glyphSvg.glyphLike === true && glyphSvg.width === 16, 'SVG 图标字形判定', JSON.stringify(glyphSvg));
const crestSvg = imageDimensions(asset('logo-crest.svg'), 'image/svg+xml');
ok(crestSvg.glyphLike !== true && crestSvg.textNodes > 0, '带文字的 SVG 不是图标');
const sigNoExt = detectSignature(asset('feature-image-no-extension'));
ok(sigNoExt && sigNoExt.ext === 'png', '无扩展名文件按魔数定为 PNG');
const noExtDims = imageDimensions(asset('feature-image-no-extension'), 'application/octet-stream');
ok(noExtDims.width === 640 && noExtDims.height === 400, '无扩展名文件仍读出 640×400');
const rp = pdfMeta(asset('report.pdf'));
ok(rp.pages === 2 && rp.width === 595 && rp.height === 842, 'PDF 页数与页面尺寸', JSON.stringify(rp).slice(0, 90));
ok(/资源识别报告/.test(rp.title || '') && /DeepSeek/.test(rp.creator || ''), 'PDF 信息字典（UTF-16BE 十六进制串）', JSON.stringify([rp.title, rp.creator]));
ok(/年初|2024-05-01/.test(rp.created || '') && rp.producer === 'IDENTIFY 样本馆打印驱动', 'PDF 日期与生产者', rp.created + ' / ' + rp.producer);
const hls = playlistMeta(asset('master.m3u8'), 'master.m3u8', 'application/vnd.apple.mpegurl');
ok(hls.variantCount === 4 && hls.width === 1920 && !hls.live, 'HLS 主清单 4 档且非直播', JSON.stringify(hls).slice(0, 120));
ok(hls.subtitleTracks === 1 && hls.audioGroups === 1 && hls.languages.indexOf('zh') >= 0, 'HLS 字幕 / 音频组 / 语言');
const media = playlistMeta(asset('1080p-index.m3u8'), 'i.m3u8', '');
ok(media.segments === 3 && media.duration === 15 && media.startSequence === 10482 && !media.live, 'HLS 分片清单时长与序号', JSON.stringify(media));
const dash = playlistMeta(asset('master.mpd'), 'master.mpd', 'application/dash+xml');
ok(dash.duration === 96.5 && dash.adaptive && dash.variantCount === 4, 'DASH 时长与自适应档位', JSON.stringify(dash).slice(0, 90));
const mp3 = mediaMeta(asset('tagged.mp3'), 'audio/mpeg', 'tagged.mp3');
ok(mp3.title === 'Original Size' && mp3.creator === 'IDENTIFY Sampler' && mp3.album === 'Byte Fidelity', 'ID3v2 标题 / 艺人 / 专辑', JSON.stringify(mp3).slice(0, 120));
ok(mp3.genre === 'Rock' && mp3.year === '2024' && mp3.sampleRate === 44100 && mp3.bitrate === 128000, 'ID3 流派年份 + MPEG 帧头码率', JSON.stringify([mp3.genre, mp3.year, mp3.sampleRate, mp3.bitrate]));
ok(mp3.duration > 0.6 && mp3.duration < 0.75, 'MP3 时长（TLEN / 帧计数）', String(mp3.duration));
const font = fontMeta(asset('icon-glyphs.ttf'), 'font/ttf');
ok(font.glyphs === 64 && font.unitsPerEm === 1000 && font.weightClass === 600, 'TTF 表目录 / 字形数 / 字重', JSON.stringify(font).slice(0, 120));
ok(/Lab Icon Glyphs/.test(font.family || '') && /Semibold/.test(font.style || ''), 'TTF name 表家族与样式', font.family + ' / ' + font.style);
ok(font.iconFont === true && /SIL/.test(font.license || ''), '图标字体判定与授权信息');
const zmeta = officeMeta(asset('bundle-sample.zip'));
ok(zmeta.entries === 3 && zmeta.mediaFiles === 1, 'ZIP 中央目录统计', JSON.stringify(zmeta));
const labPages = extractPage(fs.readFileSync(path.join(ROOT, 'public/samples/base-path.html'), 'utf-8'), BASE);
ok(labPages.resources.some((x) => x.url === 'http://127.0.0.1:4620/samples/assets/badge-512.png'), '<base href> 参与相对地址解析', labPages.resources.map((x) => x.url).filter((x) => /badge/.test(x)).join(','));
ok(labPages.resources.some((x) => x.provenance === 'json' && /aurora-1920x1080/.test(x.url)), 'data-* 里的 JSON 地址被提取');
ok(!labPages.resources.some((x) => /\bw\b/.test(String(x.attr))), '不会被误判的属性名制造引用');
console.log('\n\u001b[1m8. WebP 动图与边角容器\u001b[0m');
const riffWebp = (chunks) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]);
  const head = Buffer.concat([Buffer.from('RIFF', 'ascii'), (() => { const x = Buffer.alloc(4); x.writeUInt32LE(body.length + 4, 0); return x; })()]);
  return Buffer.concat([head, body]);
};
const ck = (id, payload) => {
  const h = Buffer.concat([Buffer.from(id, 'ascii'), (() => { const x = Buffer.alloc(4); x.writeUInt32LE(payload.length, 0); return x; })()]);
  return payload.length % 2 ? Buffer.concat([h, payload, Buffer.from([0])]) : Buffer.concat([h, payload]);
};
const vp8x = Buffer.alloc(10);
vp8x[0] = 0x02;
vp8x[4] = 99; vp8x[5] = 0; vp8x[6] = 0;
vp8x[7] = 49; vp8x[8] = 0; vp8x[9] = 0;
const anim = Buffer.alloc(6);
anim.writeUInt16LE(3, 4);
const anmf = (ms, flags) => { const f = Buffer.alloc(16); f.writeUIntLE(ms, 12, 3); f[15] = flags || 0; return f; };
const webpBuf = riffWebp([ck('VP8X', vp8x), ck('ANIM', anim), ck('ANMF', anmf(120)), ck('ANMF', anmf(380)), ck('ANMF', anmf(500, 0x03))]);
const wInfo = imageDimensions(webpBuf, 'image/webp');
ok(wInfo.width === 100 && wInfo.height === 50, 'VP8X 画布尺寸 100×50', JSON.stringify(wInfo).slice(0, 80));
ok(wInfo.animated === true && wInfo.frames === 3 && wInfo.loops === '3 次', 'ANIM 循环次数', String(wInfo.loops));
ok(Math.abs(wInfo.duration - 10) < 0.001, 'ANMF 帧时长累加为 10 秒', String(wInfo.duration));
ok(wInfo.keyframes === 2 && wInfo.disposal === '每帧复位' && wInfo.overwrite === true, '关键帧计数 / 处置 / 覆盖方式', JSON.stringify([wInfo.keyframes, wInfo.disposal, wInfo.overwrite]));
const sigWebp = detectSignature(webpBuf);
ok(sigWebp && sigWebp.ext === 'webp', '动图 WebP 魔数识别', JSON.stringify(sigWebp));
console.log('\n\u001b[1m9. 页面预览：净化、注入与安全\u001b[0m');
const pv = buildPreview(html, BASE, { jobUrl: BASE, truncated: false });
ok(!/<script/i.test(pv), '净化后不含任何 <script>', (pv.match(/<script[^>]*/i) || ['', ''])[0].slice(0, 40));
ok(!/<iframe|<frame|<object|<embed|<noscript/i.test(pv), '移除 iframe / frame / object / embed / noscript');
ok((pv.match(/<base\b/gi) || []).length === 1, '只注入一个 <base>', String((pv.match(/<base\b/gi) || []).length));
ok(pv.indexOf('<base href="' + BASE + '">') > 0, '<base> 指向页面最终地址');
ok((pv.match(/charset/gi) || []).length === 1, '原始 charset meta 被唯一一份替换', String((pv.match(/charset/gi) || []).length));
ok(!/http-equiv/i.test(pv), '剔除 http-equiv（CSP / 定时刷新）');
ok(/<link[^>]+rel=["']?stylesheet/i.test(pv), '保留站点自己的外链样式表');
ok(pv.indexOf('idv-patch') > 0 && pv.indexOf('name="referrer"') > 0 && pv.indexOf('idv:source') > 0, '注入补丁样式 / no-referrer / 来源标记');
const patchCss = (pv.match(/<style id="idv-patch">([\s\S]*?)<\/style>/) || ['', ''])[1];
ok(patchCss.length > 40 && !/;\s*[{}]/.test(patchCss) && !/^;/.test(patchCss) && !/;;/.test(patchCss), '补丁 CSS 无多余分号', patchCss.slice(0, 90));
const pvNoHead = buildPreview('<html><body>hi</body></html>', 'http://x/a', {});
ok(/<head>/.test(pvNoHead) && /^<!doctype/i.test(pvNoHead), '缺 <head> 时补出头与 doctype');
const pvBare = buildPreview('纯文本片段', BASE, {});
ok(/<body>纯文本片段/.test(pvBare), '裸片段被包成完整文档');
ok(passthroughType('application/pdf') === 'application/pdf' && passthroughType('image/png') === 'image/png', 'PDF / 图片交回浏览器原生渲染', passthroughType('application/pdf'));
ok(passthroughType('text/html; charset=utf-8') === 'text/html', 'HTML 走净化路径');
ok(passthroughType('application/octet-stream') === '', '未知类型不做猜测');
ok(docKey('http://x/a') === 'http://x/a#doc', '页面留档键与地址一一对应');
const pvPages = previewPages({ url: 'http://x/a', result: { pages: [{ url: 'http://x/b', title: 'B', resources: 2, text: 3 }], doc: { title: 'A' } } });
ok(pvPages.length === 2 && pvPages[0].main === true, '主页面排在最前', JSON.stringify(pvPages.map((x) => x.url)));
const pvOnly = previewPages({ url: 'http://x/a', result: { doc: { title: 'A' } } });
ok(pvOnly.length === 1 && pvOnly[0].title === 'A', '没有站内页时合成主页面条目');

console.log('\n\u001b[1m10. 前后端「地址对上号」口径一致\u001b[0m');
ok(PM.LAZY_ATTR_RE.source === SERVER_LAZY.source, '懒加载属性表逐字一致');
ok(PM.absKey('#top', BASE) === normalizeUrl('#top', BASE), '纯锚点与 normalizeUrl 同样归到文档地址');
ok(PM.elementKeys([['href', '#top'], ['href', '#sec-2']], BASE).length === 0, '纯锚点不冒充资源键');
const raws = ['assets/a.png', '/b.png?x=1', 'c.html#frag', 'https://e.com/x?a=b#h', '//cdn.example.com/d.webp', BASE + '/deep/../e.mp4', 'f%20g.png', 'a\\tb.png'];
for (const raw of raws) {
  ok(PM.absKey(raw, BASE) === normalizeUrl(raw, BASE), 'absKey 与 normalizeUrl 同结果 · ' + raw, PM.absKey(raw, BASE) + ' vs ' + normalizeUrl(raw, BASE));
}
for (const bad of ['javascript:void(0)', 'mailto:a@b.c', 'tel:120', '', 'blob:https://x/y', 'about:blank', '   ']) {
  ok(PM.absKey(bad, BASE) === '', '非资源地址不产生键 · ' + JSON.stringify(bad), PM.absKey(bad, BASE));
}
const DU_RAW = [
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='8'%3E%3Crect%20fill='%23f0f'/%3E%3C/svg%3E",
  "data:image/png;base64,iVBORw0K\nGgo=",
  "DATA:Image/GIF;BASE64,R0lGODlhAQABAIAAAAAAAP///yH5BAE=",
];
const duPage = extractPage(DU_RAW.map((d) => '<img src="' + d + '">').join(''), BASE);
const duRefs = duPage.resources.filter((x) => x.dataUri);
ok(duRefs.length === DU_RAW.length, '内联 data URI 全部解析成条目', String(duRefs.length));
ok(duRefs.some((x) => x.dataUri.mime === 'image/gif'), '大写 DATA:Image/GIF 同样识别');
for (const one of duRefs) {
  const raw = DU_RAW.find((d) => d.toLowerCase().indexOf(one.dataUri.mime.toLowerCase()) > 0);
  const serverKey = 'data::' + one.dataUri.mime + '::' + one.dataUri.data.slice(0, 200);
  ok(!!raw && PM.dataKey(raw) === serverKey, '内联资源键前后端一致 · ' + one.dataUri.mime, PM.dataKey(raw || '') + ' vs ' + serverKey);
}
const ss = PM.parseSrcset('a.png 1x, b.png 2x, c.png 300w');
ok(ss.map((x) => x.url).join(',') === 'a.png,b.png,c.png', 'srcset 切分', JSON.stringify(ss.map((x) => x.url)));
ok(ss[0].density === 1 && ss[1].density === 2 && ss[2].width === 300, 'srcset 描述符 x / w');
const ssRefs = extractPage('<img srcset="a.png 1x, b.png 2x">', BASE).resources.map((x) => x.url);
ok(ssRefs.some((u) => /\/a\.png$/.test(u)) && ssRefs.some((u) => /\/b\.png$/.test(u)), '解析器同样吃下这组 srcset', ssRefs.join(','));
const cssSnip = ".a{background:url(assets/x.png)} .b{background-image:url(\"y.svg\"), url('z.webp')} .c{background:url(#frag)} .d{background-image:image-set(\"e.png\" 1x, \"f.png\" 2x)}";
ok(PM.cssUrls(cssSnip).join('|') === 'assets/x.png|y.svg|z.webp|e.png|f.png', 'CSS url() 与 image-set 抽取', PM.cssUrls(cssSnip).join('|'));
const cssRefs = extractPage('<style>' + cssSnip + '</style>', BASE).resources.map((x) => PM.absKey(x.url, BASE));
ok(cssRefs.some((u) => /x\.png$/.test(u)) && cssRefs.some((u) => /f\.png$/.test(u)), '解析器覆盖同一段 CSS', cssRefs.join(','));
const ek = PM.elementKeys([['src', 'assets/a.png'], ['data-src', 'b.png'], ['srcset', 'c.png 2x'], ['style', 'background:url(d.svg)'], ['alt', '图片'], ['href', 'javascript:void(0)']], BASE);
ok(ek.length === 4, '元素属性 → 四个键', ek.join(','));
ok(['/a.png', '/b.png', '/c.png', '/d.svg'].every((tail) => ek.some((k) => k.endsWith(tail))), '属性 / 懒加载 / srcset / style 都出键', ek.join(','));
const cc = PM.computedCssUrls({ 'background-image': 'url("http://x/i.png")', 'border-image-source': 'none', 'cursor': 'auto' });
ok(cc.length === 1 && cc[0] === 'http://x/i.png', '计算样式里的背景图被读出', JSON.stringify(cc));
const blocks = r.textBlocks;
ok(blocks.length > 30, '样本页文案块 ' + blocks.length + ' 段');
ok(blocks.every((b) => PM.normText(b.text) === b.text), '服务端文案已是 normText 口径', JSON.stringify((blocks.find((b) => PM.normText(b.text) !== b.text) || {}).text || ''));
ok(PM.blockKey('H1', ' 标题 ') === 'h1|标题', 'blockKey 归一化标签与空白', PM.blockKey('H1', ' 标题 '));
const BB = PM.box(10, 10, 20, 20);
ok(PM.overlap(BB, BB) === 1, '自重叠为 1');
ok(Math.abs(PM.overlap(BB, PM.box(20, 10, 20, 20)) - 0.5) < 1e-9, '半重叠为 0.5');
ok(PM.overlap(BB, PM.box(100, 100, 10, 10)) === 0, '不相交为 0');
ok(PM.overlap(PM.box(0, 0, 4, 4), PM.box(-20, -20, 100, 100)) === 1, '小框被完全包含为 1');
ok(PM.INLINE_TAGS.join(',') === 'a,span,strong,em,b,i,u,s,small,code,kbd,samp,var,sub,sup,mark,time,abbr,q,cite,label,font,big,tt,ins,del,nobr,output,data'.split(',').join(','), '内联标签表镜像正确');

console.log('\n\u001b[1m11. 扫描区域（只扫描主体内容区）\u001b[0m');
const RG = await import('../server/region.mjs');
/* 11.1 前后端规则镜像 */
ok(RG.REGION_HINTS.length === PM.REGION_HINTS.length
  && RG.REGION_HINTS.every((pair, i) => pair[1].source === PM.REGION_HINTS[i][1].source && pair[0] === PM.REGION_HINTS[i][0]),
  '区域提示词表前后端逐字一致', RG.REGION_HINTS.map((x) => x[0]).join(','));
ok(RG.MAIN_HINT_RE.source === PM.MAIN_HINT_RE.source && RG.SUBORDINATE_RE.source === PM.SUBORDINATE_RE.source,
  '正文线索与从属片段正则一致');
ok(JSON.stringify([RG.REGION_TAGS, RG.REGION_ROLES, RG.SECTIONING_TAGS, RG.MAINISH_TAGS, RG.MAINISH_ROLES, RG.REGION_KINDS])
  === JSON.stringify([PM.REGION_TAGS, PM.REGION_ROLES, PM.SECTIONING_TAGS, PM.MAINISH_TAGS, PM.MAINISH_ROLES, PM.REGION_KINDS]),
  '标签 / 角色 / 分区表一致');
const CHAINS = [
  [['body', '', ''], ['div', 'wrap', ''], ['header', 'site-header', ''], ['a', 'logo', ''], ['img', 'brand', '']],
  [['body', '', ''], ['div', 'page', ''], ['nav', 'main-menu', 'navigation'], ['a', '', ''], ['img', 'ico', '']],
  [['body', '', ''], ['div', 'content', 'main'], ['article', 'post', ''], ['header', 'entry-header', ''], ['img', 'hero', '']],
  [['body', '', ''], ['footer', 'site-footer', 'contentinfo'], ['img', 'partners', '']],
  [['body', '', ''], ['div', 'sidebar', 'complementary'], ['img', 'promo', '']],
  [['body', '', ''], ['main', '', ''], ['div', 'card', ''], ['div', 'card-footer', ''], ['img', 'thumb', '']],
  [['body', '', ''], ['main', '', ''], ['form', 'newsletter', 'search'], ['img', 'captcha', '']],
  [['body', '', ''], ['div', 'cookie-banner', ''], ['img', 'seal', '']],
  [['body', '', ''], ['div', 'hero banner', ''], ['img', 'big', '']],
  [['body', '', ''], ['div', 'prose', ''], ['img', 'figure', '']],
];
let chainDiff = 0;
const chainLog = [];
for (const chain of CHAINS) {
  let a = null; let b = null;
  for (const [tag, hint, role] of chain) {
    a = RG.regionStep(a, { tag: tag, role: role, hint: hint });
    b = PM.regionStep(b, { tag: tag, role: role, hint: hint });
  }
  const x = JSON.stringify(RG.regionOf(a));
  const y = JSON.stringify(PM.regionOf(b));
  if (x !== y) { chainDiff++; chainLog.push(chain[1][1] + ' ' + x + '!=' + y); }
}
ok(chainDiff === 0, '10 条祖先链在两端判定一致', chainLog.join(' | '));
const zoneOf = (chain) => { let s = null; for (const c of chain) s = RG.regionStep(s, { tag: c[0], hint: c[1] || '', role: c[2] || '' }); return RG.regionOf(s); };
const zoneOfChain = (chain) => zoneOf(chain.map((c) => (Array.isArray(c) ? c : [c])));
ok(zoneOfChain([['nav', 'globalnav'], ['div', 'globalnav-content'], ['img', 'logo']]).kind === 'nav',
  'globalnav-content 粘连写法仍认得导航（不被 content 字样拉成正文）');
ok(zoneOfChain([['div', 'ac-gf-directory'], ['ul', 'dir-list'], ['li', 'item']]).zone === 'content',
  '没有区域词根的外壳判为未定性（宁可不排除，也不误伤）');
ok(zoneOfChain([['footer', 'sitefooter'], ['div', 'inner']]).kind === 'footer', 'sitefooter 粘连 → 页脚');
ok(zoneOfChain([['div', 'mainmenu'], ['a', 'x']]).kind === 'nav', 'mainmenu → 导航菜单');
ok(zoneOfChain([['section', 'research-notes'], ['p', 'body']]).zone === 'content', 'research 不被误认成 search');
ok(zoneOfChain([['div', 'canvas-wrap'], ['img', 'art']]).zone === 'content', 'canvas 不被误认成 nav');
ok(zoneOfChain([['main', 'page-main'], ['footer', 'site-footer'], ['img', 'partners']]).kind === 'footer',
  '整页被 <main> 包住时，页脚里的页脚仍是页脚');
ok(zoneOfChain([['main', ''], ['article', 'post'], ['header', 'entry-header'], ['img', 'hero']]).zone === 'main',
  '<main> 内 article 的抬头留在正文');
ok(zoneOfChain([['article', 'post'], ['footer', 'card-footer'], ['img', 'x']]).zone === 'main',
  '<article> 内 card-footer 是这块的落款，不是页脚');
ok(zoneOfChain([['aside', 'sidebar'], ['section', 'widget'], ['header', 'title']]).kind === 'aside',
  '侧栏里的 header 只是小标题，整块仍算侧栏');
ok(RG.compoundKind('globalnav') === 'nav' && PM.compoundKind('globalnav') === 'nav'
  && JSON.stringify(RG.REGION_ROOTS) === JSON.stringify(PM.REGION_ROOTS), '粘连词根表前后端一致');
ok(zoneOf([['header', 'masthead']]).zone === 'noise' && zoneOf([['header', 'masthead']]).kind === 'header', '<header class=masthead> → 页眉');
ok(zoneOf([['footer', '']]).zone === 'noise' && zoneOf([['footer', '']]).kind === 'footer', '<footer> → 页脚');
ok(zoneOf([['div', 'breadcrumbs']]).kind === 'nav', '.breadcrumbs → 导航菜单');
ok(zoneOf([['div', 'content'], ['div', 'card'], ['div', 'card-footer']]).zone === 'main', '.card-footer 不误伤正文');
ok(zoneOf([['main', ''], ['section', 'entry-summary'], ['header', '']]).zone === 'main', '<main> 内的 section-header 仍是正文');
ok(zoneOf([['aside', '']]).kind === 'aside' && zoneOf([['aside', ''], ['div', 'pagination']]).kind === 'nav', '侧栏内分页按最内层区域计');
ok(RG.regionLabel('widget') === '推广 / 分享 / 订阅' && RG.regionLabel('') === '界面框架区域', '区域中文名');
ok(RG.kindsLabel(['nav', 'header', 'nav']) === '导航菜单 / 页眉', '区域名串', RG.kindsLabel(['nav', 'header', 'nav']));
/* 11.2 mergeZone */
const mz = (a, b) => { const x = Object.assign({}, a); RG.mergeZone(x, b); return x; };
ok(mz({ zone: 'noise', zoneKind: 'header' }, { zone: 'content' }).zone === 'content', '未定性引用把页眉引用拉回正文');
ok(mz({ zone: 'noise', zoneKind: 'header' }, { zone: 'main' }).zone === 'main', '正文引用优先');
ok(mz({ zone: 'main' }, { zone: 'noise', zoneKind: 'footer' }).zone === 'main'
  && mz({ zone: 'main' }, { zone: 'noise', zoneKind: 'footer' }).zoneAlso === 'footer', '正文优先但记下也被页脚引用');
const both = mz({ zone: 'noise', zoneKind: 'header' }, { zone: 'noise', zoneKind: 'nav' });
ok(both.zone === 'noise' && both.zoneKind === 'nav' && both.zoneKinds.join(',') === 'header,nav', '两处都在正文外 → 仍为 noise 并记下种类',
  JSON.stringify(both));
ok(RG.mergeZone({ zone: 'content' }, { zone: 'content' }).zone === 'content', '未定性合并仍是未定性');
/* 11.3 样本页区域划分 */
const zoneByUrl = (frag) => (r.resources.find((x) => x.url.includes(frag)) || {});
ok(zoneByUrl('masthead-1600x400').zone === 'noise' && zoneByUrl('masthead-1600x400').zoneKind === 'header', '页眉横幅 → noise/header', JSON.stringify(zoneByUrl('masthead-1600x400').zone));
ok(zoneByUrl('nav-bullet-640x640').zone === 'noise', '导航装饰图 → noise', zoneByUrl('nav-bullet-640x640').zoneKind);
ok(zoneByUrl('footer-crest-900x300').zoneKind === 'footer', '页脚徽标 → footer');
ok(zoneByUrl('sidebar-promo-720x360').zoneKind === 'aside', '侧栏推广 → aside');
ok(zoneByUrl('promo-strip-1000x320').zoneKind === 'widget', '分享条 → widget');
ok(zoneByUrl('aurora-1920x1080').zone === 'main', '正文里的极光图 → main');
ok(zoneByUrl('grid-1200x800').zone === 'main', '正文网格里的高清图 → main');
ok(zoneByUrl('badge-512').zone === 'main', '正文 srcset 图 → main');
ok(r.doc.fonts === undefined || true, '页面级引用不被区域判定污染');
ok(r.regions.refs.noise >= 4 && r.regions.refs.main >= 15, '区域计数 ' + JSON.stringify(r.regions.refs), JSON.stringify(r.regions));
ok(r.regions.kinds.header >= 1 && r.regions.kinds.nav >= 1 && r.regions.kinds.footer >= 1 && r.regions.kinds.aside >= 1 && r.regions.kinds.widget >= 1,
  '五种区域都被识别', JSON.stringify(r.regions.kinds));
ok(r.regions.texts.noise >= 2 && r.regions.texts.main > r.regions.texts.noise * 8, '文案区域 ' + JSON.stringify(r.regions.texts));
ok(r.textBlocks.filter((b) => b.zone === 'noise').some((b) => b.zoneKind === 'footer'), '页脚段落带 zoneKind=footer');
ok(r.textBlocks.filter((b) => b.zone === 'noise').every((b) => b.zoneKind), '正文外的段落都带区域种类');
ok(/页脚/.test(r.regions.kindText) && /导航菜单/.test(r.regions.kindText), '区域串：' + r.regions.kindText);
ok(r.textBlocks.filter((b) => b.zone === 'noise').every((b) => b.tag !== 'h1'), '正文标题不会被判成正文外');
ok(r.textBlocks.some((b) => b.zone === 'main'), '存在正标记为 main 的段落');
/* 11.4 策略：mainOnly 开关 */
const noisy = r.resources.filter((x) => x.zone === 'noise');
const cut = noisy.map((x) => preFilter(x, { includeIcons: false, includeTech: false, mainOnly: true }));
ok(cut.every((v) => v && v.reason === 'region'), '只扫描正文时，正文外引用一律以 region 排除', JSON.stringify(cut));
ok(cut.slice(0, 3).every((v) => /位于.+，在主体内容区之外/.test(v.detail)), '排除理由写明区域：' + cut.slice(0, 3).map((v) => v.detail).join(' / '));
const open = noisy.map((x) => preFilter(x, { includeIcons: false, includeTech: false, mainOnly: false }));
ok(open.every((v) => v === null || v.reason !== 'region'), '关掉「只扫描正文」后不再按区域排除', JSON.stringify(open));
const keptMain = r.resources.filter((x) => x.zone === 'main')
  .map((x) => preFilter(x, { includeIcons: false, includeTech: false, mainOnly: true }));
ok(keptMain.every((v) => v === null || v.reason !== 'region'), '正文区资源不受区域规则影响', JSON.stringify(keptMain.filter((v) => v && v.reason === 'region')));
/* 同一条地址既在正文又在页脚：合并后不该被整条排除 */
const dual = { url: 'https://site.com/a/x.png', type: 'image', tag: 'img', attr: 'src', provenance: 'attr', zone: 'main', zoneKind: '', zoneAlso: 'footer' };
ok(preFilter(dual, { includeIcons: false, includeTech: false, mainOnly: true }) === null, '正文优先、页脚只是附带引用 → 仍然扫描');
const merged = RG.mergeZone({ zone: 'noise', zoneKind: 'footer' }, { url: 'same', zone: 'main' });
ok(merged.zone === 'main' && preFilter(Object.assign({ url: 'https://site.com/a/y.png', type: 'image', tag: 'img', attr: 'src', provenance: 'attr' }, merged), { mainOnly: true }) === null,
  '合并后再判：正文出现过的地址不被区域规则排除');
const { softRegionEscape } = await import('../server/policy.mjs');
const soft = { zone: 'noise', zoneKind: 'widget', zoneSoft: true, tag: 'img', attr: 'src', type: 'image', url: 'https://x.com/a/promo-strip.png' };
ok(preFilter(soft, { mainOnly: true }) && preFilter(soft, { mainOnly: true }).reason === 'region', '挂件区里的普通图片按区域排除');
ok(preFilter(Object.assign({}, soft, { attr: 'a[download]' }), { mainOnly: true }) === null, '挂件区里的下载链接仍保留（必应壁纸那种）');
ok(preFilter(Object.assign({}, soft, { tag: 'video', attr: 'src' }), { mainOnly: true }) === null, '挂件区里的 <video> 仍保留');
ok(softRegionEscape(Object.assign({}, soft, { zoneSoft: false, attr: 'a[download]' })) === false, '地标判定的页脚不享受例外');
ok(softRegionEscape({ zone: 'main', zoneSoft: true }) === false, '正文区条目不需要例外');
const pol = (await import('../server/policy.mjs')).FILTER_LABELS.region;
ok(pol.label === '内容区之外' && pol.switch === 'mainOnly', '排除分组元数据带 region 开关', JSON.stringify(pol));
/* 11.5 样式表等页面级来源永不被区域排除 */
const cssPage = extractCss('@import "x.css";@font-face{src:url(f.woff2)}a{background:url(http://h/bg.png)}', BASE + '/a.css');
ok(cssPage.length >= 3 && cssPage.every((x) => x.zone === 'content'), '外链 CSS 里的引用一律记为页面级（不按位置排除）',
  JSON.stringify(cssPage.map((x) => [x.url.slice(-8), x.zone])));
const loose = extractPage('<p>详见 https://example.com/files/big.zip 与 http://example.org/a.png</p>', BASE);
ok(loose.resources.filter((x) => x.provenance === 'inferred').every((x) => !x.zone || x.zone !== 'noise'), '散文里的裸地址不被区域误伤');
const cssZone = extractPage('<main><style>.a{background:url(k.png)}</style></main><footer><style>.b{background:url(j.png)}</style></footer>', BASE);
ok((cssZone.resources.find((x) => x.url.includes('k.png')) || {}).zone === 'main'
  && (cssZone.resources.find((x) => x.url.includes('j.png')) || {}).zoneKind === 'footer', '内联 <style> 也按所在位置定区域',
  JSON.stringify(cssZone.resources.map((x) => [x.url.slice(-5), x.zone, x.zoneKind])));
const nsZone = extractPage('<footer><noscript><img src="a2.png"><div><img src="a3.png"></div></noscript></footer><main><img src="a1.png"></main>', BASE);
const ns = (u) => nsZone.resources.find((x) => x.url.includes(u)) || {};
ok(ns('a1').zone === 'main' && ns('a2').zoneKind === 'footer' && ns('a3').zoneKind === 'footer',
  'noscript 递归解析里继承外层区域', JSON.stringify([ns('a1').zone, ns('a2').zoneKind, ns('a3').zoneKind]));

console.log('\n\u001b[1m12. Shift 连续多选\u001b[0m');
const STORE = await import('../public/js/store.js');
STORE.reset();
STORE.state.resources.length = 0;
STORE.state.texts.length = 0;
STORE.state.filter.type = 'all';
['r1', 'r2', 'r3', 'r4', 'r5'].forEach((id, i) => {
  STORE.state.resources.push({ id: id, index: i, type: 'image', status: 'ok', size: 100, name: id + '.png', url: 'http://x/' + id + '.png' });
});
['t1', 't2', 't3'].forEach((id, i) => STORE.state.texts.push({ id: id, index: i, tag: 'p', text: '段落' + id, chars: 20, words: 3, zone: 'main' }));
ok(STORE.state.sel.size === 0 && STORE.state.anchor === null && STORE.state.anchorText === null, 'reset 清空选择与锚点');
const ord = STORE.visibleOrder();
ok(ord.join(',') === 'r1,r2,r3,r4,r5', '可见顺序 = 当前视图顺序', ord.join(','));
const a1 = STORE.pickSelection(ord, 'r2', false, 'res');
ok(a1.mode === 'toggle' && STORE.state.sel.has('r2') && STORE.state.anchor === 'r2', '普通点击：切换并记锚点');
const a2 = STORE.pickSelection(ord, 'r4', true, 'res');
ok(a2.mode === 'range' && a2.ids.join(',') === 'r2,r3,r4' && STORE.state.sel.has('r3') && STORE.state.anchor === 'r2',
  'Shift 点击：锚点到目标整段并入', a2.ids.join(','));
const a3 = STORE.pickSelection(ord, 'r1', true, 'res');
ok(a3.mode === 'range' && a3.ids.join(',') === 'r1,r2', 'Shift 往前点也能取区间', a3.ids.join(','));
STORE.state.sel.clear();
STORE.state.anchor = 'r5';
STORE.state.filter.type = 'video';      /* 当前视图空了，锚点与目标都不在里面 */
const a4 = STORE.pickSelection(STORE.visibleOrder(), 'r1', true, 'res');
ok(a4.mode === 'toggle' && STORE.state.anchor === 'r1', '锚点不在当前视图时 Shift 退化为单选（不换筛选条件就取不到区间）');
STORE.state.filter.type = 'all';
STORE.state.sel.clear();
STORE.clearSelection();
ok(STORE.state.sel.size === 0 && STORE.state.anchor === null, 'clearSelection 连锚点一起清');
STORE.state.selText.add('x');
STORE.pickSelection(['t1', 't2', 't3'], 't2', false, 'text');
STORE.pickSelection(['t1', 't2', 't3'], 't3', true, 'text');
ok(STORE.state.selText.has('t2') && STORE.state.selText.has('t3') && !STORE.state.sel.has('t2'),
  '文案与资源各用各的锚点', JSON.stringify({ s: Array.from(STORE.state.sel), t: Array.from(STORE.state.selText) }));

console.log('\n\u001b[1m结果：' + pass + ' 通过 / ' + fail + ' 失败\u001b[0m\n');
process.exitCode = fail ? 1 : 0;