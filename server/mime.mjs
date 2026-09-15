/**
 * 资源类型体系：扩展名 / MIME → 类别、MIME、中文名
 */

export const TYPES = {
  image: { label: '图片', en: 'Images', color: '#7cf6b0', glyph: '▧' },
  vector: { label: '矢量图', en: 'Vector', color: '#4ad9ff', glyph: '◈' },
  video: { label: '视频', en: 'Video', color: '#ff6ec7', glyph: '▶' },
  audio: { label: '音频', en: 'Audio', color: '#ffd166', glyph: '∿' },
  document: { label: '文档', en: 'Docs', color: '#a0b4ff', glyph: '▤' },
  sheet: { label: '表格', en: 'Sheets', color: '#8ce99a', glyph: '▦' },
  archive: { label: '压缩包', en: 'Archives', color: '#d0a215', glyph: '⛃' },
  model: { label: '三维模型', en: '3D Model', color: '#ffb86b', glyph: '◮' },
  /* 下面几类不是「内容资源」：UI 图标与技术资源默认不扫描，见 server/policy.mjs */
  icon: { label: 'UI 图标', en: 'UI Icons', color: '#a3b1c6', glyph: '⊕', chrome: true },
  font: { label: '字体', en: 'Fonts', color: '#e59fff', glyph: 'Aa', tech: true },
  stylesheet: { label: '样式表', en: 'Styles', color: '#5eead4', glyph: '{ }', tech: true },
  script: { label: '脚本', en: 'Scripts', color: '#f5d90a', glyph: '#!', tech: true },
  data: { label: '数据', en: 'Data', color: '#94a3b8', glyph: '⛁', tech: true },
  page: { label: '页面', en: 'Pages', color: '#cbd5e1', glyph: '⬜', tech: true },
  other: { label: '其他', en: 'Other', color: '#64748b', glyph: '·', tech: true },
};

/** 内容类别：图片 / 矢量 / 视音频 / 文档 / 表格 / 压缩包 / 三维模型 */
export const CONTENT_TYPES = Object.keys(TYPES).filter((k) => !TYPES[k].chrome && !TYPES[k].tech);
/** UI 界面图标一类的装饰资源 */
export const CHROME_TYPES = Object.keys(TYPES).filter((k) => TYPES[k].chrome);
/** 技术资源：字体、样式表、脚本、数据、页面、未知 */
export const TECH_TYPES = Object.keys(TYPES).filter((k) => TYPES[k].tech);

const EXT_MAP = {
  png: 'image', jpg: 'image', jpeg: 'image', jpe: 'image', jfif: 'image', webp: 'image', avif: 'image',
  apng: 'image', gif: 'image', bmp: 'image', dib: 'image', tif: 'image', tiff: 'image',
  heic: 'image', heif: 'image', jp2: 'image', jpf: 'image', jpx: 'image', jpm: 'image',
  tga: 'image', pcx: 'image', pict: 'image', pct: 'image', qoi: 'image', jxl: 'image',
  cr2: 'image', cr3: 'image', nef: 'image', raw: 'image', arw: 'image', dng: 'image', orf: 'image', rw2: 'image',
  svg: 'vector', svgz: 'vector',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', flv: 'video',
  wmv: 'video', '3gp': 'video', '3g2': 'video', ogv: 'video', ts: 'video', m2ts: 'video', mts: 'video',
  mpg: 'video', mpeg: 'video', mxf: 'video', f4v: 'video', divx: 'video',
  m3u8: 'video', mpd: 'video',
  mp3: 'audio', wav: 'audio', wave: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', m4a: 'audio',
  m4b: 'audio', aac: 'audio', flac: 'audio', wma: 'audio', aiff: 'audio', aif: 'audio', aifc: 'audio',
  caf: 'audio', amr: 'audio', mid: 'audio', midi: 'audio', mod: 'audio', mka: 'audio',
  pdf: 'document', doc: 'document', docx: 'document', rtf: 'document', odt: 'document', pages: 'document',
  key: 'document', ppt: 'document', pptx: 'document', odp: 'document', epub: 'document', mobi: 'document',
  azw: 'document', azw3: 'document', fb2: 'document', djvu: 'document', xps: 'document', txt: 'document',
  md: 'document', markdown: 'document', log: 'document',
  xls: 'sheet', xlsx: 'sheet', xlsm: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet', numbers: 'sheet',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  bz2: 'archive', xz: 'archive', zst: 'archive', lz4: 'archive', 'gz.1': 'archive', dmg: 'archive',
  iso: 'archive', cbz: 'archive', cbr: 'archive', exe: 'archive', msi: 'archive', apk: 'archive',
  deb: 'archive', rpm: 'archive',
  gltf: 'model', glb: 'model', usdz: 'model', usd: 'model', usda: 'model', obj: 'model', stl: 'model',
  fbx: 'model', ply: 'model', dae: 'model', '3mf': 'model', abc: 'model', skp: 'model',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font', pfb: 'font', fnt: 'font',
  css: 'stylesheet', scss: 'stylesheet', less: 'stylesheet',
  js: 'script', mjs: 'script', cjs: 'script', jsx: 'script', tsx: 'script', wasm: 'script',
  map: 'script', json: 'data', jsonld: 'data', ndjson: 'data', xml: 'data', yaml: 'data', yml: 'data',
  toml: 'data', webmanifest: 'data', manifest: 'data', vtt: 'data', srt: 'data', ass: 'data',
  ics: 'data', vcf: 'data', proto: 'data', onnx: 'data', pt: 'data', safetensors: 'data',
  html: 'page', htm: 'page', xhtml: 'page', php: 'page', asp: 'page', aspx: 'page', jsp: 'page',
  ico: 'icon', cur: 'icon', icns: 'icon',
};

const MIME_MAP = [
  [/^image\/svg/i, 'vector'],
  [/^image\//i, 'image'],
  [/^video\//i, 'video'],
  [/^audio\//i, 'audio'],
  [/^font\//i, 'font'],
  [/application\/(x-)?font(icc)?$/i, 'font'],
  [/text\/css/i, 'stylesheet'],
  [/javascript|ecmascript/i, 'script'],
  [/application\/json|jsonl|xml|yaml/i, 'data'],
  [/application\/pdf/i, 'document'],
  [/application\/msword|officedocument\.word|rtf|epub\+zip|vnd\.oasis\.opendocument\.text|powerpoint/i, 'document'],
  [/excel|spreadsheet|vnd\.oasis\.opendocument\.spreadsheet/i, 'sheet'],
  [/application\/(x-)?(zip|rar|x-7z-compressed|tar|x-gtar|x-bzip2|x-x509-ca-cert|vnd\.android\.package-archive|x-iso9660-image)/i, 'archive'],
  [/model\/|vnd\.model\.|\/(gltf|glb|usdz|vrml|x-directx)$|x-extented3d/i, 'model'],
  [/(x-)?(win-)?icon|vnd\.microsoft\.icon/i, 'icon'],
  [/\/(x-)?(woff2?|ttf|otf|opentype|fontcollect|font-sfnt|font-woff)/i, 'font'],
  [/\/x-shader|\/(javascript|ecmascript)|x-typescript/i, 'script'],
  [/manifest\+json|\/xml|\/json|x-ndjson|yaml/i, 'data'],
  [/text\/html/i, 'page'],
  [/^text\//i, 'document'],
];

const MIME_FOR_TYPE = {
  image: 'image/png', vector: 'image/svg+xml', video: 'video/mp4', audio: 'audio/mpeg',
  document: 'application/octet-stream', sheet: 'text/csv', archive: 'application/zip',
  model: 'model/gltf+json', icon: 'image/x-icon',
  font: 'font/woff2', stylesheet: 'text/css', script: 'text/javascript', data: 'application/json',
  page: 'text/html', other: 'application/octet-stream',
};

/** 全部已知扩展名（供「裸链接」扫描与内联脚本提取复用，保持与类别表同步） */
export const KNOWN_EXTS = Object.keys(EXT_MAP).sort((a, b) => b.length - a.length);
export const KNOWN_EXT_SOURCE = KNOWN_EXTS.map((e) => e.replace(/\./g, '\\.')).join('|');

/** 扩展名 → 类别 */
export function typeFromExt(ext) {
  if (!ext) return null;
  return EXT_MAP[String(ext).toLowerCase().replace(/^\./, '')] || null;
}

export function typeFromMime(mime) {
  if (!mime) return null;
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  for (const [re, t] of MIME_MAP) if (re.test(clean)) return t;
  return null;
}

let MIME2EXT = null;
function mimeToExt() {
  if (MIME2EXT) return MIME2EXT;
  MIME2EXT = {};
  for (const [ext, mime] of Object.entries(EXT2MIME)) {
    if (!MIME2EXT[mime]) MIME2EXT[mime] = ext;
  }
  MIME2EXT['text/plain'] = 'txt';
  MIME2EXT['text/markdown'] = 'md';
  return MIME2EXT;
}

/** 由 MIME 反推一个合理扩展名（导出命名用） */
export function extFromMime(mime) {
  if (!mime) return '';
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  const table = mimeToExt();
  if (table[clean]) return table[clean];
  const sub = clean.split('/')[1] || '';
  const m = /^([a-z0-9.+-]+)/.exec(sub);
  if (!m) return '';
  let ext = m[1].replace(/^x-/, '').replace(/^vnd[.-].*/, '');
  if (ext === 'x-icon') ext = 'ico';
  if (ext === 'javascript') ext = 'js';
  if (ext === 'quicktime') ext = 'mov';
  if (ext === 'matroska') ext = 'webm';
  if (ext === 'octet-stream' || ext.length > 6) return '';
  return ext || '';
}

/**
 * 同一素材的不同尺寸 / 密度写法归并成一个「家族键」：
 * aurora-1920x1080.png、aurora@2x.png、aurora-thumb.png 与 aurora.png 视为同族，
 * 用于标出原件（尺寸最大的那一个）并把缩略候选归组，避免一张图被当成多个素材。
 */
const FAMILY_STRIP = [
  /@\d+x(?=\.)/g,
  /[-_.]\d{2,4}x\d{2,4}(?=\.)/g,
  /[-_.](?:thumb|thumbs|tny|small|medium|large|big|full|orig|original|res|sq|square|max|min|preview|cover|card|list|grid)(?=\.)/g,
  /[-_.]\d{2,4}(?=\.)/g,
];
const FAMILY_SIZE_PARAMS = /^(?:w|h|width|height|size|resize|crop|dpr|density|format|fm|q|quality|th|thumb|version|v|s|tex|scale)$/i;

export function assetFamily(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.toLowerCase();
    for (const re of FAMILY_STRIP) p = p.replace(re, '');
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) if (!FAMILY_SIZE_PARAMS.test(k)) keep.push(k + '=' + v);
    keep.sort();
    return u.host + p + (keep.length ? '?' + keep.join('&') : '');
  } catch {
    return String(url || '');
  }
}

export function extFromPath(pathname) {
  const base = pathname.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i < base.length - 8) return '';
  const ext = base.slice(i + 1);
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : '';
}

/**
 * 综合判断资源类别：data URI / mime / 扩展名 / 上下文线索
 */
export function classify({ mime, ext, context = '', hintedType }) {
  const byMime = typeFromMime(mime);
  const byExt = typeFromExt(ext);
  /* 标签 / MIME 给出的线索优先，但容器本身能定性的（SVG、ICO）以容器为准 */
  if (hintedType && TYPES[hintedType]) {
    if (byExt === 'vector' && hintedType === 'image') return 'vector';
    if (byExt === 'icon') return 'icon';
    return hintedType;
  }
  const ctx = context.toLowerCase();
  if (byExt === 'video' || byExt === 'audio') return byExt;
  if (byMime === 'video' || byMime === 'audio') return byMime;
  if (/(^|[\s,>])<(video|audio|source|track|iframe)[\s/]/i.test(ctx)) {
    if (byExt === 'image' || byMime === 'image') return 'video';
  }
  if (byMime && byExt && byMime !== byExt) return byExt === 'other' ? byMime : byExt;
  if (byExt) return byExt;
  if (byMime) return byMime;
  if (/(^|[\s,>])<link[^>]+stylesheet/i.test(ctx)) return 'stylesheet';
  if (/(^|[\s,>])<script/i.test(ctx)) return 'script';
  return 'other';
}

export function guessMime(type, ext) {
  const e = (ext || '').replace(/^\./, '').toLowerCase();
  return EXT2MIME[e] || MIME_FOR_TYPE[type] || 'application/octet-stream';
}

export const EXT2MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', apng: 'image/apng', svg: 'image/svg+xml', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/vnd.microsoft.icon', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', ogv: 'video/ogg', ts: 'video/mp2t', m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus', aiff: 'audio/aiff', mid: 'audio/midi',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', tgz: 'application/gzip', epub: 'application/epub+zip',
  html: 'text/html', htm: 'text/html',
  jp2: 'image/jp2', tga: 'image/x-tga', qoi: 'image/qoi', jxl: 'image/jxl', svgz: 'image/svg+xml',
  apng: 'image/apng', ico: 'image/vnd.microsoft.icon', icns: 'image/x-icns', cur: 'image/x-icon',
  m4b: 'audio/mp4', caf: 'audio/x-caf', mka: 'audio/x-matroska', mod: 'audio/mod',
  mts: 'video/mp2t', m2ts: 'video/mp2t', mxf: 'application/mxf', f4v: 'video/x-f4v',
  gltf: 'model/gltf+json', glb: 'model/gltf-binary', usdz: 'model/vnd.usdz+zip', obj: 'model/obj',
  stl: 'model/stl', fbx: 'application/octet-stream', ply: 'application/vnd.ply', dae: 'model/vnd.collada+xml',
  vtt: 'text/vtt', srt: 'application/x-subrip', ics: 'text/calendar', vcf: 'text/vcard',
  webmanifest: 'application/manifest+json', zst: 'application/zstd', cbz: 'application/vnd.comicbook+zip',
  djvu: 'image/vnd.djvu', xps: 'application/vnd.ms-xpsdocument', wasm: 'application/wasm',
  exe: 'application/vnd.microsoft.portable-executable', apk: 'application/vnd.android.package-archive',
};

export const STATIC_MIME = {
  ...EXT2MIME,
  jsm: 'text/javascript', mjs: 'text/javascript', map: 'application/json',
  ico: 'image/vnd.microsoft.icon', webmanifest: 'application/manifest+json',
  eot: 'application/vnd.ms-fontobject', woff2: 'font/woff2',
};

/** 该类别是否可以在浏览器内直接预览 */
export function previewable(type, mime = '') {
  if (type === 'image' || type === 'vector') return true;
  if (type === 'video' || type === 'audio') return true;
  if (type === 'stylesheet' || type === 'script' || type === 'data' || type === 'document') {
    return /text|json|xml|yaml|csv|javascript|css|markdown|plain/i.test(String(mime));
  }
  return false;
}
