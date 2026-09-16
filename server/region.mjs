/**
 * 扫描区域判定：把页面切成「主体内容区」与「页眉 / 导航菜单 / 页脚 / 侧栏 / 挂件」，
 * 默认只扫描正文内容区里的引用（配合 policy.mjs 的 region 规则）。
 *
 * 设计要点（与 public/js/pv-match.js 的浏览器侧镜像逐条对齐，自检比对常量与判定结果）：
 *
 *   1. 地标证据最强：<header> <nav> <footer> <aside> 与 role=banner / navigation /
 *      contentinfo / complementary / search 算非内容区；<main> <article> role=main 算正文区。
 *      裸 <form> 不算（整页套在表单里的站点很多），只有带 search / login / subscribe
 *      这类命名或 role=search 的表单才判非内容区。
 *   2. 章节例外：规范里 <header> / <footer> 只有不在章节性元素内时才是页眉 / 页脚地标，
 *      所以 <article><header> 这种「文章自己的抬头」保留为正文。
 *   3. 从属例外：.content-header、.entry-footer、.card-footer 这类「正文块的抬头 / 落款」
 *      先剥掉再比对，避免把文章自带的标题栏当成页眉。
 *   4. 命名证据次之：id / class 比对词表（masthead、navbar、breadcrumb、site-footer、
 *      sidebar、newsletter、cookie、share…），词元前后必须是非字母数字，
 *      所以 .hero、.banners、.post-list 不会被误伤。
 *   5. 正文护栏：一旦进入 <main> / #content / .article-body 这类正文容器，其后代的
 *      **命名证据**不再判非内容区（正文里的 .search-results、.promo 卡片会被留下），
 *      但后代的地标证据（<nav> / <aside>）仍然生效。
 *   6. 判不动就是 'content'（保留）：只有明确命中噪音证据才排除——宁可少排除，不可误伤正文。
 *
 * 区域（zone）三种取值：
 *   'main'    明确正文（main / article / role=main / 正文命名）
 *   'content' 未定性（既不是地标也不是噪音）
 *   'noise'   非内容区，kind 给出具体是哪一类
 */

/** 非内容区的种类与中文名 */
export const REGION_KINDS = {
  header: '页眉',
  nav: '导航菜单',
  footer: '页脚',
  aside: '侧栏',
  form: '表单 / 搜索',
  widget: '推广 / 分享 / 订阅',
};

/** 标签 → 非内容区种类（地标证据） */
export const REGION_TAGS = {
  header: 'header',
  nav: 'nav',
  footer: 'footer',
  aside: 'aside',
};

/** role → 非内容区种类（地标证据；main 单独处理） */
export const REGION_ROLES = {
  banner: 'header',
  navigation: 'nav',
  menubar: 'nav',
  tablist: 'nav',
  contentinfo: 'footer',
  complementary: 'aside',
  search: 'form',
  dialog: 'widget',
};

/** 正文区标签与角色 */
export const MAINISH_TAGS = ['main', 'article'];
export const MAINISH_ROLES = ['main'];

/** 规范里的章节性元素：其中的 header / footer 不算页眉 / 页脚地标 */
export const SECTIONING_TAGS = ['main', 'article', 'section', 'aside', 'nav', 'td', 'th', 'li', 'figure', 'blockquote', 'details', 'dialog', 'fieldset'];

/** 正文命名证据（id / class 词元） */
export const MAIN_HINT_RE = /(?:^|[^a-z0-9])(?:main|main-?content|main-?area|content|page-?content|entry(?:[-_](?:content|body|text|detail|title))?|article(?:[-_](?:body|content|text))?|post(?:[-_](?:body|content|text))?|story(?:[-_](?:body|text))?|prose|document?-body|sheet-content|attachment-?body)(?:[^a-z0-9]|$)/i;

/** 从属抬头：正文容器自己的 header / footer / 标题栏，不是页面框架 */
export const SUBORDINATE_RE = /(?:content|entry|post|article|story|item|card|panel|pane|block|media|figure|table|field|cell|doc|text|body|thread|comment|attachment|gallery|slide)(?:[-_])(?:header|footer|head|foot|title|meta|bar|top|bottom|actions|tools|caption|info)(?:[-_](?:wrap|inner|area|box|row|line|text))?/gi;

/**
 * 非内容区命名证据（id / class 词元）。按「先具体后宽泛」排序，第一个命中的种类胜出。
 */
export const REGION_HINTS = [
  ['nav', /(?:^|[^a-z0-9])(?:nav|navbar|navi|navigation|menu|menubar|main-?menu|top-?menu|sub-?nav|side-?nav|sidenav|top-?nav|tab-?bar|tabbar|tool-?bar|toolbar|breadcrumb|breadcrumbs|crumbs|pagination|pager|jump-?menu)(?:[^a-z0-9]|$)/i],
  ['header', /(?:^|[^a-z0-9])(?:masthead|site-?header|page-?header|global-?header|header|topbar|top-?bar|app-?bar|appbar|hdr)(?:[^a-z0-9]|$)/i],
  ['footer', /(?:^|[^a-z0-9])(?:site-?footer|page-?footer|footer|foot-?bar|bottom-?bar|bottombar|copyright|colophon|legal|footnotes?|disclaimer)(?:[^a-z0-9]|$)/i],
  ['aside', /(?:^|[^a-z0-9])(?:sidebar|side-?bar|side-?panel|widget(?:[-_]?area|s)?|aside|rail|right-?rail|left-?rail|toc|table-?of-?contents|mini-?nav)(?:[^a-z0-9]|$)/i],
  ['form', /(?:^|[^a-z0-9])(?:search|search-?(?:form|box|bar)|login|log-?in|signin|sign-?in|signup|sign-?up|register|subscribe|subscription|newsletter|comment-?(?:form|box|area)|contact-?form|filters?)(?:[^a-z0-9]|$)/i],
  ['widget', /(?:^|[^a-z0-9])(?:cookie|consent|gdpr|age-?gate|paywall|popup|modal|drawer|toast|advert|advert-?ising|ads|adsbygoogle|ad-?(?:slot|unit|banner)|sponsor|promo|promotion|share|social|follow-?us|related|recommended|read-?more|app-?download|install-?banner|lang(?:uage)?-?(?:switch|menu)|back-?to-?top|scroll-?top|live-?chat|chat-?widget|sticky-?(?:bar|cta)?)(?:[^a-z0-9]|$)/i],
];

/** 根状态：还没进入任何元素（sub = 落在某个章节块里，core = 已进入正文根） */
export const REGION_ROOT = { zone: 'content', kind: '', sub: false, core: false, soft: false };

/**
 * 粘连写法：真实站点爱把区域名糊成一个词（`globalnav` / `localnav` / `sitefooter` / `mainmenu`…），
 * 带分隔符的词表匹配不到，这里按词根做前后缀识别。
 * 只做「认出界面框架」这一件事：认不出来最多退回未定性（照样扫描），不会误伤正文。
 */
export const REGION_ROOTS = [
  ['nav', ['nav', 'navbar', 'navigation', 'navi', 'menu', 'menubar', 'breadcrumb', 'breadcrumbs', 'crumb', 'pagination', 'tabbar', 'toolbar', 'tablist']],
  ['header', ['header', 'masthead', 'topbar', 'appbar', 'hdr', 'headbar']],
  ['footer', ['footer', 'bottombar', 'copyright', 'colophon', 'footbar']],
  ['aside', ['sidebar', 'sidepanel', 'aside']],
  ['widget', ['popup', 'modal', 'consent', 'cookie', 'advert', 'adsbygoogle', 'sponsor']],
];

const WORD_SPLIT = /[^a-z0-9]+/;

export function compoundKind(hint) {
  const words = String(hint || '').toLowerCase().split(WORD_SPLIT).filter((w) => w.length > 3);
  for (const pair of REGION_ROOTS) {
    const kind = pair[0];
    const roots = pair[1];
    for (const w of words) {
      for (const r of roots) {
        if (w.length > r.length && (w.endsWith(r) || w.startsWith(r))) return kind;
      }
    }
  }
  return '';
}

/** id + class → 噪音种类（先剥掉从属抬头，再按词表逐条比对，最后试粘连词根） */
export function hintKind(hint) {
  const s = String(hint || '').replace(SUBORDINATE_RE, ' ');
  if (!s.trim()) return '';
  for (const pair of REGION_HINTS) if (pair[1].test(s)) return pair[0];
  return compoundKind(s);
}

/**
 * 逐层步进：prev = 父容器状态，frame = { tag, role, hint }
 * @returns {{zone:string, kind:string, sub:boolean, core:boolean, soft:boolean}}
 */
export function regionStep(prev, frame) {
  const st = prev || REGION_ROOT;
  const tag = String((frame && frame.tag) || '').toLowerCase();
  const role = String((frame && frame.role) || '').toLowerCase();
  const hint = String((frame && frame.hint) || '');
  if (!tag || tag === 'html' || tag === 'body' || tag === '#document') return st;

  const isRoot = tag === 'main' || MAINISH_ROLES.indexOf(role) >= 0;
  const mainTag = isRoot || tag === 'article';
  let landmark = mainTag ? '' : (REGION_TAGS[tag] || REGION_ROLES[role] || '');
  let named = landmark || mainTag ? '' : hintKind(hint);
  /* 章节例外：<header>/<footer> 只有不落进别的章节块时才算页眉 / 页脚地标。
     <main> 是整页正文根、本身不算章节，所以「整页被 main 包住」的站点照样能认出页脚；
     而 <article>/<section>/<li> 里的 header 只是这一块的抬头，留在正文里。 */
  if (st.sub && (landmark === 'header' || landmark === 'footer')) landmark = '';
  if (st.sub && (named === 'header' || named === 'footer')) named = '';
  /* 正文护栏：已经进了正文容器，光凭命名证据不再把它判成正文之外（地标证据仍然生效） */
  if (named && st.core) named = '';
  /* 命名线索只用于「还没定性」的地方：绝不把正文外拉回正文，也不把正文压成噪音 */
  const mainHint = !landmark && !named && !mainTag && st.zone !== 'noise' && MAIN_HINT_RE.test(hint);
  const sectioning = SECTIONING_TAGS.indexOf(tag) >= 0;
  const sub = isRoot ? false : !!(st.sub || sectioning || landmark || named);
  if (isRoot) return { zone: 'main', kind: '', sub: false, core: true, soft: false };
  if (mainTag) return { zone: 'main', kind: '', sub: sub, core: true, soft: false };
  if (landmark) return { zone: 'noise', kind: landmark, sub: sub, core: st.core, soft: false };
  if (named) return { zone: 'noise', kind: named, sub: sub, core: st.core, soft: true };
  if (mainHint) return { zone: 'main', kind: '', sub: sub, core: true, soft: false };
  return { zone: st.zone, kind: st.kind, sub: sub, core: st.core, soft: !!st.soft };
}

/** 一个元素的区域结论，供引用与文案块标注 */
export function regionOf(state) {
  const st = state || REGION_ROOT;
  return { zone: st.zone || 'content', kind: st.kind || '', soft: !!(st.zone === 'noise' && st.soft) };
}

/** 非内容区的中文说明；未知种类回落到「界面框架区域」 */
export function regionLabel(kind) {
  return REGION_KINDS[kind] || '界面框架区域';
}

/** 出现位置的优先级：正文 > 未定性 > 非内容区（同一地址被多处引用时按最高者保留） */
export const ZONE_RANK = { noise: 1, content: 2, main: 3 };

/**
 * 合并两个出现位置的区域结论（就地改 target）。
 * 规则：**只要有一处落在正文 / 未定性区域，就不算「内容区之外」**；
 * 全部出现位置都在非内容区时才保留噪音结论，并记下所有命中的种类。
 */
export function mergeZone(target, incoming) {
  const a = target.zone || 'content';
  const b = (incoming && incoming.zone) || 'content';
  const kb = (incoming && incoming.zoneKind) || '';
  const softA = target.zone !== 'noise' ? false : target.zoneSoft === true;
  const softB = b !== 'noise' ? false : incoming.zoneSoft === true;
  if (!target.zoneKinds) target.zoneKinds = a === 'noise' && target.zoneKind ? [target.zoneKind] : [];
  if ((ZONE_RANK[b] || 0) >= (ZONE_RANK[a] || 0)) {
    target.zone = b;
    target.zoneKind = b === 'noise' ? kb : '';
    target.zoneSoft = b === 'noise' ? softB : false;
    if (b === 'noise' && kb && target.zoneKinds.indexOf(kb) < 0) target.zoneKinds.push(kb);
  } else if (b === 'noise') {
    /* 正文优先：只把噪音种类记进「也被非内容区引用」 */
    if (kb && target.zoneAlso) target.zoneAlso += ' ' + kb;
    else if (kb) target.zoneAlso = kb;
  }
  /* 两处都只在正文外时：只要有一处是语义地标（nav/footer/…），结论就不再是「靠名字猜」 */
  if (target.zone === 'noise') target.zoneSoft = softA && softB ? true : !!(target.zoneSoft && softB);
  if (!target.zone) target.zone = 'content';
  return target;
}

/** 区域 kinds → 「页眉 / 页脚」这样的可读串 */
export function kindsLabel(kinds) {
  const list = Array.isArray(kinds) ? kinds.filter(Boolean) : [kinds].filter(Boolean);
  const uniq = [...new Set(list)];
  return uniq.length ? uniq.map(regionLabel).join(' / ') : regionLabel('');
}