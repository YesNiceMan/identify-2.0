/**
 * 懒加载 / 框架属性名的唯一判定表（extract.mjs 与 policy.mjs 共用，避免两处正则漂移）
 */
export const LAZY_ATTR_RE = /^data[-_]?[a-z0-9_-]*?(?:src|srcset|url|uri|image|img|thumb|thumbnail|poster|background|bg|file|download|href|media|video|audio|movie|clip|sound|mp4|mp3|webm|original|orig|lazy|lazyload|echo|preview|cover|full|large|zoom|lightbox|gallery|source|path|attach)(?:[-_]?(?:set|s|2x|1x))?$/i;

export function isLazyAttr(name) {
  return LAZY_ATTR_RE.test(String(name || ''));
}
