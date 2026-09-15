/**
 * 从地址本身读出「图片处理参数」：声明尺寸、像素密度、真实容器格式、代理内层地址，
 * 以及 UI 装饰线索（徽章 / 表情 / 占位头像）。
 *
 * 为什么需要它：现代站点的内容图常常没有可用扩展名 ——
 *   https://images.unsplash.com/photo-1500?w=1080&q=75&fm=webp
 *   https://lh3.googleusercontent.com/abc=sd1080-w1080
 *   https://example.com/_next/image?url=%2Fhero.png&w=1200
 * 只看扩展名会全部落到「无法归类」，既判不出类别，也容易让扫描策略把内容当技术资源排除掉。
 * 解析分两级：先按服务商写法，再按通用写法兜底。产出：
 *   width / height / dpr     声明尺寸（探测到真实像素后以真实值为准）
 *   ext / mime               由 format / fm / wx_fmt / _.webp 等写法推出的真实容器
 *   inner                    图片代理背后真正的地址（_next/image、weserv、photon…）
 *   quality / provider       展示用
 *   badge / emoji / avatar   UI 装饰线索（供扫描策略判定界面图标）
 */
import { EXT2MIME, typeFromExt } from './mime.mjs';

const MAX_EDGE = 20000;

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EDGE) return 0;
  return Math.round(n);
}
function ratio(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 0;
}
function decodeSafe(s) {
  try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); }
}

const FORMAT_ALIAS = {
  jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', pjpg: 'jpg', heic: 'heic', heif: 'heic',
  png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', tif: 'tif', tiff: 'tif',
  svg: 'svg', ico: 'ico', pdf: 'pdf', woff: 'woff', woff2: 'woff2', mp4: 'mp4', webm: 'webm',
};

function fmtExt(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return '';
  const key = raw.replace(/^(?:image|video|audio|application)\//, '').replace(/^x-/, '');
  if (FORMAT_ALIAS[key]) return FORMAT_ALIAS[key];
  return typeFromExt(key) ? key : '';
}

/* ------------------------------------------------------- 通用解析件 */

const W_KEYS = ['w', 'width', 'mw', 'sw', 'maxwidth', 'max_width', '_w', 'pw', 'imgwidth', 'resize_w', 'im'];
const H_KEYS = ['h', 'height', 'mh', 'sh', 'maxheight', 'max_height', '_h', 'ph', 'imgheight', 'resize_h'];
const F_KEYS = ['fm', 'format', 'f', 'ext', 'output', 'output_format', 'fileext', 'imgformat', 'type'];
const Q_KEYS = ['q', 'quality', '_q', 'qy', 'qi'];
const IGNORED_FORMAT = new Set(['auto', 'web', 'orig', 'original', 'src', 'default', 'best', 'same', 'none', 'false', 'true']);

/** 兼容 query 参数、Cloudflare 的 k=v 串、以及 `key:value` 形式 */
function scanPairs(pairs) {
  const out = {};
  const take = (k, v) => {
    const key = String(k).toLowerCase().replace(/^[?&;/]/, '');
    const val = String(v == null ? '' : v).trim();
    if (!val) return;
    if (!out.width && W_KEYS.includes(key)) out.width = num(val);
    if (!out.height && H_KEYS.includes(key)) out.height = num(val);
    if (!out.ext && F_KEYS.includes(key) && !IGNORED_FORMAT.has(val.toLowerCase())) out.ext = fmtExt(val);
    if (!out.quality && Q_KEYS.includes(key)) out.quality = num(val);
    if (!out.dpr && /^(?:dpr|density|pixelratio|scale)$/.test(key)) out.dpr = ratio(val);
    if (!out.width) {
      const combo = /^(\d{1,4})[x,_](\d{1,4})$/.exec(val);
      if (combo && /(?:size|resize|dim|dimension|wh|res|s|px)$/i.test(key)) {
        out.width = num(combo[1]);
        if (!out.height) out.height = num(combo[2]);
      }
    }
  };
  for (const pair of pairs) {
    if (Array.isArray(pair)) take(pair[0], pair[1]);
    else {
      const raw = String(pair || '');
      const bits = raw.split('=');
      if (bits.length === 2) take(bits[0], bits[1]);
    }
  }
  return out;
}

/** 文件名 / 路径里的尺寸写法 */
const SIZE_IN_NAME = /(?:^|[/._@:~\- (])(\d{1,4})x(\d{1,4})(?![\d])/i;
const WIDTH_ONLY = /(?:^|[/._@:\-])(\d{1,4})w(?![a-z0-9])/i;
const DPR_IN_NAME = /(?:^|[/._@:\-])([1-4](?:\.5)?)x(?=[._]|$)/i;
const PX_SUFFIX = /(?:^|[/._@:\-])(\d{1,4})px(?![a-z0-9])/i;
const TAIL_FORMAT = /\.(jpe?g|png|gif|webp|avif|svgz?|heic|tiff?)\.(jpe?g|png|gif|webp|avif|heic|tif|tiff)(?:_[a-z0-9]+)?$/i;
const NUMERIC_HINT_SEGMENT = /^(?:thumb|thumbs|thumbnail|resize|resized|scale|crop|avatar|proxy|media|img|image|w|width|s|sq|size|fit|max|px|d|dim)$/i;

function scanPath(pathname) {
  const out = {};
  const segs = String(pathname).split('/').filter(Boolean);
  const base = segs.length ? segs[segs.length - 1] : '';
  if (base) {
    const hit = SIZE_IN_NAME.exec(base);
    if (hit) { out.width = num(hit[1]); out.height = num(hit[2]); }
  }
  if (!out.width) {
    /** 纯数字目录段：/thumb/300/200/x.jpg、/640/480/、/avatar/96/x.png */
    const nums = segs.filter((x) => /^\d{1,4}$/.test(x));
    const vi = segs.map((x) => (/^\d{1,4}$/.test(x) ? 1 : 0));
    /** 只有「相邻两段都像尺寸」才当作宽高，Shopify 的 /files/1/0000/ 这类 ID 路径要排除 */
    let pair = null;
    for (let i = segs.length - 1; i > 0; i--) {
      if (vi[i] && vi[i - 1]) {
        const a = num(segs[i - 1]); const b = num(segs[i]);
        if (a >= 32 && b >= 32 && a <= 9000 && b <= 9000) { pair = [a, b]; break; }
      }
    }
    if (pair) {
      out.width = pair[0];
      out.height = pair[1];
    } else if (nums.length === 1) {
      const idx = segs.lastIndexOf(nums[0]);
      const prev = String(segs[idx - 1] || '').toLowerCase().replace(/\.(?:php|aspx?|html?)$/, '');
      if (NUMERIC_HINT_SEGMENT.test(prev)) out.width = num(nums[0]);
    }
    /** /w/640/h/360/ 与 /width/640/ 这类带键名的写法 */
    for (let i = 0; i + 1 < segs.length && !out.width; i++) {
      const key = segs[i].toLowerCase();
      if (key === 'w' || key === 'width') out.width = num(segs[i + 1]);
      else if ((key === 'h' || key === 'height') && !out.height) out.height = num(segs[i + 1]);
    }
  }
  if (!out.width) {
    const w = (base && WIDTH_ONLY.exec(base)) || PX_SUFFIX.exec(pathname);
    if (w) out.width = num(w[1]);
  }
  if (!out.dpr && base) {
    const d = DPR_IN_NAME.exec(base);
    if (d) out.dpr = ratio(d[1]) >= 1.5 ? ratio(d[1]) : 0;
  }
  if (base) {
    const tail = TAIL_FORMAT.exec(base);
    if (tail) { const e = fmtExt(tail[2]); if (e) out.ext = e; }
  }
  return out;
}

/* ------------------------------------------------------- 内层地址还原 */

const INNER_QUERY_KEYS = ['url', 'src', 'u', 'image', 'img', 'i', 'href', 'target', 'uri'];
const INNER_EXT = /\.(jpe?g|png|webp|avif|gif|svgz?|heic|tif|tiff|bmp|ico|mp4|webm|m4v|mov|m4a|mp3|wav|pdf|zip|docx?|xlsx?|csv)($|[?&,])/i;

/**
 * 图片代理背后真正的地址，只认三种明显写法：
 *   /_next/image?url=%2Fhero.png                          Next.js 优化器
 *   https://images.weserv.nl/?url=real.site.com/a.png     中转服务
 *   https://i0.wp.com/real.site.com/wp-content/a.jpg      Photon / Jetpack
 */
function innerOf(u) {
  const host = u.hostname.toLowerCase();
  const out = [];
  for (const key of INNER_QUERY_KEYS) {
    const v = u.searchParams.get(key);
    if (v) {
      const clean = decodeSafe(v);
      if (INNER_EXT.test(clean)) out.push(clean);
    }
  }
  if (/(?:^|\.)\d*\.?wp\.com$/i.test(host) || /photon|jetpack|msho\.i/i.test(host)) {
    const first = (u.pathname.split('/').filter(Boolean)[0] || '');
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(first)) {
      out.push('https://' + first + u.pathname.slice(u.pathname.indexOf(first) + first.length));
    }
  }
  for (const raw of out) {
    const clean = String(raw || '').trim();
    if (!clean || /\s/.test(clean) || clean.length > 600) continue;
    let guess = clean;
    if (/^\/\//.test(clean)) guess = u.protocol + clean;
    else if (!/^https?:\/\//i.test(clean)) {
      /** 没有协议又像一个域名：weserv 的 url=site.com/a.png */
      guess = /^\d+[a-z0-9-]*\.[a-z]{2,}\//i.test(clean) || /^[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\//i.test(clean)
        ? 'https://' + clean
        : u.origin + (clean.startsWith('/') ? '' : '/') + clean;
    }
    try {
      const made = new URL(guess);
      if (!/^https?:$/.test(made.protocol)) continue;
      if (made.hostname === u.hostname && made.pathname === u.pathname) continue;
      return made.toString();
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/* --------------------------------------------------------- 服务商表 */

const FLICKR_SIZES = { s: 75, t: 100, q: 150, m: 240, n: 320, z: 640, l: 500, b: 1024, c: 1600, h: 1600, k: 2048 };
const SHOPIFY_SIZES = { pico: 16, icon: 24, thumb: 100, compact: 160, small: 200, medium: 400, large: 800, grande: 1200, jqborder: 60 };
const TW_SIZES = { thumb: 120, square: 144, small: 340, medium: 600, large: 1200 };
const CLIKE = /(?:^|[/,])w_(\d{1,4})(?![\d._])/;
const CLIKE_H = /(?:^|[/,])h_(\d{1,4})(?![\d._])/;

const PROVIDERS = [
  {
    name: 'Google 图片服务',
    host: /googleusercontent\.com$|(?:^|\.)google\.[a-z]{2,3}$/i,
    rule(joined) {
      /** 变换串是最后一个 = 之后的部分：=w300-h200-no / =sd1080 / =s1600,c_fit */
      const at = joined.lastIndexOf('=');
      if (at < 0) return {};
      const seg = joined.slice(at + 1).split(/[/?#]/)[0];
      if (!/^[a-z0-9][a-z0-9_,.-]*$/i.test(seg)) return {};
      const out = {};
      for (const token of seg.split(/[-_,]/)) {
        const m = /^([a-z]{0,3})(\d{1,4})$/i.exec(token);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const v = num(m[2]);
        if (!v) continue;
        if (key === 'w' && !out.width) out.width = v;
        else if (key === 'h' && !out.height) out.height = v;
        else if ((key === 's' || key === 'd' || key === 'sd' || key === 'p' || key === '') && !out.width) out.width = v;
      }
      return out;
    },
  },
  {
    name: 'Cloudinary',
    host: /cloudinary/i,
    rule(joined) {
      const out = {};
      const w = CLIKE.exec(joined); const h = CLIKE_H.exec(joined);
      const d = /dpr_([\d.]+)/.exec(joined); const q = /(?:^|[/,])q_(\d{1,3})/.exec(joined);
      const f = /(?:^|[/,])f_([a-z0-9]+)(?![a-z])/.exec(joined);
      if (w) out.width = num(w[1]);
      if (h) out.height = num(h[1]);
      if (d) out.dpr = ratio(d[1]);
      if (q) out.quality = num(q[1]);
      if (f && !IGNORED_FORMAT.has(f[1])) out.ext = fmtExt(f[1]);
      return out;
    },
  },
  {
    name: 'Wix 图片服务',
    host: /wixstatic|wixmp|parastorage/i,
    rule(joined) {
      const out = {};
      const w = CLIKE.exec(joined) || /\/w_(\d{1,4})/.exec(joined);
      const h = CLIKE_H.exec(joined) || /\/h_(\d{1,4})/.exec(joined);
      const q = /q_(\d{1,3})/.exec(joined);
      if (w) out.width = num(w[1]);
      if (h) out.height = num(h[1]);
      if (q) out.quality = num(q[1]);
      return out;
    },
  },
  {
    name: 'ImageKit',
    host: /imagekit|ik\.media|ik-img\.com/i,
    rule(joined) {
      const out = {};
      const w = /(?:^|[/,-])w-(\d{1,4})/.exec(joined);
      const h = /(?:^|[/,-])h-(\d{1,4})/.exec(joined);
      const f = /fm-([a-z0-9]+)/.exec(joined);
      if (w) out.width = num(w[1]);
      if (h) out.height = num(h[1]);
      if (f) out.ext = fmtExt(f[1]);
      return out;
    },
  },
  {
    name: '阿里云 OSS / 腾讯图片服务',
    host: /alicdn\.com|aliyuncs\.com|tbcdn\.cn|qpic\.cn|gtimg\.cn|bdstatic\.com|hdslb\.com|kkimgs\.ya|itc\.cn|yisou|myqcloud/i,
    rule(joined) {
      const out = {};
      const proc = /(?:x-oss-process=|x-bce-process=|imageMogr2[/:]|imageView2[/:])([^"'&\s]*)/i.exec(joined);
      if (proc) {
        const w = /[,/_]w[_,]?\s?(\d{1,4})/i.exec(proc[1]);
        const h = /[,/_]h[_,]?\s?(\d{1,4})/i.exec(proc[1]);
        const f = /format[_,:]([a-z0-9]+)/i.exec(proc[1]);
        if (w) out.width = num(w[1]);
        if (h) out.height = num(h[1]);
        if (f) out.ext = fmtExt(f[1]);
      }
      const legacy = /@(\d{1,4})w(?:_(\d{1,4})h)?/i.exec(joined);
      if (legacy && !out.width) {
        out.width = num(legacy[1]);
        out.height = num(legacy[2] || legacy[1]);
      }
      const taobao = /_(\d{1,4})x(\d{1,4})(?:q\d+)?(?:\.jpg)?_?\.?([a-z]*)$/i.exec(joined);
      if (taobao) {
        out.width = num(taobao[1]);
        out.height = num(taobao[2]);
        const e = fmtExt(taobao[3]);
        if (e) out.ext = e;
      }
      const wx = /wx_fmt=([a-z0-9]+)/i.exec(joined);
      if (wx && !out.ext) out.ext = fmtExt(wx[1]);
      const q = /q_(\d{2,3})(?:[/_]|$)/i.exec(joined);
      if (q && !out.quality) out.quality = num(q[1]);
      /** mmbiz.qpic.cn/mmbiz_jpg/xxx/640?wx_fmt=jpeg —— 末段纯数字就是宽度 */
      const tail = /\/(\d{2,4})(?:[?#]|$)/.exec(joined);
      if (tail && !out.width) out.width = num(tail[1]);
      return out;
    },
  },
  {
    name: '火山图床 / 小红书',
    host: /xiaohongshu|xhscdn|douyinpic|toutiaoimg|byteimg|pstatp|snssdk|dypic|bdstatic/i,
    rule(joined) {
      const out = {};
      const iv = /imageView2\/\d(?:\/[a-z]\/(\d{1,4}))+/i.exec(joined);
      if (iv) {
        const bits = /w\/(\d{1,4})/i.exec(joined); const h = /h\/(\d{1,4})/i.exec(joined);
        if (bits) out.width = num(bits[1]);
        if (h) out.height = num(h[1]);
      }
      const th = /thumbnail\/!?(\d{1,4})x?(\d{1,4})?/i.exec(joined);
      if (th && !out.width) { out.width = num(th[1]); if (th[2]) out.height = num(th[2]); }
      const f = /format[,_]([a-z0-9]+)/i.exec(joined);
      if (f && !IGNORED_FORMAT.has(f[1])) out.ext = fmtExt(f[1]);
      return out;
    },
  },
  {
    name: 'Cloudflare 图片变换',
    host: /.*/,
    rule(joined) {
      const seg = /cdn-cgi\/image\/([^/?]+)/i.exec(joined);
      if (!seg) return {};
      return scanPairs(seg[1].split(','));
    },
  },
  {
    name: 'Flickr',
    host: /flickr\.com/i,
    rule(joined) {
      const m = /_([stmqnlzcbhk])\.(?:jpe?g|png|webp|gif)/i.exec(joined);
      if (!m) return {};
      const edge = FLICKR_SIZES[m[1].toLowerCase()];
      return edge ? { width: edge, height: edge } : {};
    },
  },
  {
    name: 'YouTube 缩略图',
    host: /ytimg\.com|youtube(?:-nocookie)?\.com/i,
    rule(joined) {
      const p = String(joined).toLowerCase();
      if (/maxresdefault|hq720/.test(p)) return { width: 1280, height: 720 };
      if (/sddefault/.test(p)) return { width: 640, height: 480 };
      if (/hqdefault/.test(p)) return { width: 480, height: 360 };
      if (/mqdefault/.test(p)) return { width: 320, height: 180 };
      if (/default\.jpg|[0-3]\.jpg/.test(p)) return { width: 120, height: 90 };
      return {};
    },
  },
  {
    name: 'Twitter 图片服务',
    host: /twimg\.com/i,
    rule(joined) {
      const dim = /(?:[_:]|size=)(\d{2,4})x(\d{2,4})/.exec(joined);
      if (dim) return { width: num(dim[1]), height: num(dim[2]) };
      const named = /(?:[_:]|name=)(thumb|square|small|medium|large)(?:[._&]|$)/i.exec(joined);
      if (named) {
        const edge = TW_SIZES[named[1].toLowerCase()];
        if (edge) return { width: edge, height: edge };
      }
      return {};
    },
  },
  {
    name: 'Wikimedia',
    host: /wikimedia\.org|wikipedia\.org/i,
    rule(joined) {
      const m = /\/(\d{1,4})px-/i.exec(joined);
      if (!m) return {};
      return { width: num(m[1]) };
    },
  },
  {
    name: 'Shopify CDN',
    host: /shopify/i,
    rule(joined) {
      const m = /_(compact|thumb|small|medium|large|grande|master|pico|icon|jqborder)_?(\d{0,4})x?(\d{0,4})?x?@?(\d?x)?\./i.exec(joined);
      if (!m) return {};
      const edge = SHOPIFY_SIZES[m[1].toLowerCase()];
      const w = num(m[2]) || edge || 0;
      return { width: w, height: num(m[3]) || w };
    },
  },
  {
    name: 'Steam CDN',
    host: /steamstatic|steamcommunity|steampowered/i,
    rule(joined) {
      const p = String(joined).toLowerCase();
      const named = { 'header.jpg': [920, 430], 'capsule_184x69': [184, 69], 'library_600x900.jpg': [600, 900], 'community_94x18': [94, 18], 'avatar_full': [184, 184], 'avatar_medium': [64, 64], 'avatar_icon': [32, 32] };
      for (const key of Object.keys(named)) if (p.includes(key)) return { width: named[key][0], height: named[key][1] };
      return {};
    },
  },
  {
    name: '电商图片服务',
    host: /media-amazon|ssl-images-amazon|amazon|ebaystatic|walmartimages|target|alibaba|taobao|tmall|jd\.com|360buyimg|suning|pinduoduo|yangkeduo|alicdn/i,
    rule(joined) {
      const sr = /_SR(\d{1,4}),(\d{1,4})_/.exec(joined);
      if (sr) return { width: num(sr[1]), height: num(sr[2]) };
      const out = {};
      const s = /_S[UX]?\d*(\d{1,4})(?:_SY(\d{1,4}))?_/.exec(joined) || /\.[a-z]{3,4}_(\d{1,4})x(\d{1,4})_/.exec(joined) || /_SS(\d{1,4})_/.exec(joined);
      if (s) { out.width = num(s[1]); if (s[2]) out.height = num(s[2]); }
      const cn = /\/\/(?:s\d*|n\d\/s?)(\d{1,4})x(\d{1,4})_/i.exec(joined);
      if (cn && !out.width) { out.width = num(cn[1]); out.height = num(cn[2]); }
      return out;
    },
  },
  {
    name: 'Gravatar 头像',
    host: /gravatar\.com/i,
    rule(joined) {
      const out = {};
      const s = /[?&](?:s|size)=(\d{1,4})/.exec(joined);
      if (s) { out.width = num(s[1]); out.height = num(s[1]); }
      if (/[?&]d=(?:blank|mp|mm|identicon|retro|wavatar|404)/i.test(joined)) out.avatar = 1;
      return out;
    },
  },
  {
    name: '徽章生成器',
    host: /shields\.io|badgen\.net|badge\.php|versionbadge|img Shields/i,
    rule() {
      return { badge: 1, width: 120, height: 20 };
    },
  },
  {
    name: '表情 / 国旗小图',
    host: /twemoji|openmoji|joypixels|emoji|flagcdn|flagicons|intl-flags|country-flags|s\.w\.org|jsdelivr\.net|unpkg\.com/i,
    rule(joined) {
      if (!/(emoji|twemoji|openmoji|joypixels|flag)/i.test(joined)) return {};
      return { emoji: 1 };
    },
  },
  {
    name: '占位图服务',
    host: /picsum\.photos|placehold\.co|placeholdit|placeholder\.com|dummyimage\.com|loremflickr|placekitten|placebear|via\.placeholder|cataas/i,
    rule(joined) {
      const wxh = /(\d{1,4})x(\d{1,4})/.exec(joined);
      if (wxh) return { width: num(wxh[1]), height: num(wxh[2]) };
      const segs = joined.split('/').filter((s) => /^\d{1,4}$/.test(s)).map(Number);
      if (segs.length >= 2) return { width: segs[segs.length - 2], height: segs[segs.length - 1] };
      if (segs.length === 1) return { width: segs[0] };
      return {};
    },
  },
];

const CACHE = new Map();

/**
 * @param raw 绝对地址
 * @returns 地址元信息；没有解析到任何线索时返回空对象
 */
export function urlMeta(raw) {
  const key = String(raw || '');
  if (!key) return {};
  if (CACHE.has(key)) return CACHE.get(key);
  const out = resolveUrlMeta(key);
  if (CACHE.size > 6000) CACHE.clear();
  CACHE.set(key, out);
  return out;
}

function resolveUrlMeta(raw) {
  const out = {};
  let u = null;
  try { u = new URL(raw); } catch { return out; }
  const host = u.hostname.toLowerCase();
  const path = decodeSafe(u.pathname);
  const joined = host + path + u.search;

  for (const p of PROVIDERS) {
    if (!p.host.test(host)) continue;
    let part = {};
    try { part = p.rule(joined) || {}; } catch { part = {}; }
    const keys = Object.keys(part);
    if (!keys.length) continue;
    for (const k of keys) if (out[k] === undefined || !out[k]) out[k] = part[k];
    if (!out.provider) out.provider = p.name;
    if (out.width || out.height || out.badge || out.emoji) break;
  }

  let gen = {};
  let q = {};
  try { gen = scanPath(path); } catch { gen = {}; }
  try { q = scanPairs(Array.from(u.searchParams.entries())); } catch { q = {}; }
  /** 查询参数比路径里的数字段更可信，先取参数 */
  if (!out.width && q.width) out.width = q.width;
  if (!out.height && q.height) out.height = q.height;
  if (!out.width && gen.width) out.width = gen.width;
  if (!out.height && gen.height) out.height = gen.height;
  if (!out.dpr) out.dpr = q.dpr || gen.dpr || 0;
  if (!out.quality) out.quality = q.quality || 0;
  if (!out.ext) out.ext = q.ext || gen.ext || '';

  const inPath = (/\.([a-z0-9]{1,8})$/i.exec(path.split('/').pop() || '') || [])[1];
  const realExt = out.ext || (inPath ? String(inPath).toLowerCase() : '');
  if (realExt) {
    const e = fmtExt(realExt) || realExt;
    if (e) { out.ext = e; out.mime = EXT2MIME[e] || ''; }
  }
  /** 只知一条边时不臆造另一条：标成 square，界面里写「× 见方」 */
  if ((out.width && !out.height) || (out.height && !out.width)) out.square = 1;
  if (out.width || out.height) out.edge = Math.max(out.width || 0, out.height || 0);
  if (!out.width && !out.height) {
    /** 与服务商无关的变换串：?x-oss-process=image/resize,w_900 / imageMogr2/thumbnail/900x */
    const proc = /(?:x-oss-process|x-bce-process|imageMogr2|imageView2)[=/:]([^&"'\s]*)/i.exec(joined);
    if (proc) {
      const w = /[,/_]w[_,:]?\s?(\d{1,4})/i.exec(proc[1]) || /thumbnail\/(\d{1,4})x/i.exec(proc[1]);
      const h = /[,/_]h[_,:]?\s?(\d{1,4})/i.exec(proc[1]);
      const f = /format[_,:]([a-z0-9]+)/i.exec(proc[1]);
      const pq = /q[_,:]?\s?(\d{1,3})/i.exec(proc[1]);
      if (w) out.width = num(w[1]);
      if (h) out.height = num(h[1]);
      if (f && !IGNORED_FORMAT.has(f[1])) out.ext = fmtExt(f[1]);
      if (pq && !out.quality) out.quality = num(pq[1]);
      if (out.width || out.height) {
        out.square = out.width && out.height ? out.square || 0 : 1;
        out.edge = Math.max(out.width || 0, out.height || 0);
      }
    }
  }
  try {
    if (/^(?:https?:)$/.test(u.protocol) && (u.search.length > 4 || /wp\.com|weserv|wsrv|_next/i.test(joined))) {
      const inner = innerOf(u);
      if (inner && inner !== u.href) out.inner = inner;
    }
  } catch { /* 忽略 */ }
  out.chrome = out.badge || out.emoji || out.avatar ? 1 : 0;
  for (const k of Object.keys(out)) if (out[k] === 0 || out[k] === '' || out[k] === undefined) delete out[k];
  return out;
}

/** 紧凑写法，便于塞进条目与 SSE 载荷 */
export function compactUrlMeta(m) {
  const out = {};
  if (!m) return out;
  if (m.width) out.w = m.width;
  if (m.height) out.h = m.height;
  if (m.dpr) out.dpr = m.dpr;
  if (m.ext) out.ext = m.ext;
  if (m.mime) out.mime = m.mime;
  if (m.quality) out.q = m.quality;
  if (m.provider) out.p = m.provider;
  if (m.square) out.sq = 1;
  if (m.inner) out.inner = 1;
  if (m.badge) out.badge = 1;
  if (m.emoji) out.emoji = 1;
  if (m.avatar) out.avatar = 1;
  return out;
}

/** 地址声明的最大边长（没有可信声明时返回 0） */
export function declaredEdge(m) {
  if (!m) return 0;
  return Math.max(num(m.width || m.w || 0), num(m.height || m.h || 0));
}

/** 地址里能不能读出「这大概率是一张图」 */
export function urlImageSignals(m) {
  if (!m) return false;
  if (m.ext) {
    const t = typeFromExt(m.ext);
    if (t === 'image' || t === 'vector' || t === 'icon') return true;
  }
  return !!(m.width || m.quality || m.dpr);
}

/** 地址是否明确指向图片 / 矢量（用于救回没有扩展名的内容图） */
export function urlLooksVisual(raw) {
  const m = urlMeta(raw);
  const ext = m.ext;
  if (!ext) return false;
  const t = typeFromExt(ext);
  return t === 'image' || t === 'vector' || t === 'icon';
}