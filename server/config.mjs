import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const CACHE_DIR = path.join(ROOT, '.cache');

export const PORT = Number(process.env.PORT || 4620);
export const HOST = process.env.HOST || '127.0.0.1';

export const UA =
  process.env.IDENTIFY_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 单个资源允许的最大字节数（超过则只探测头部信息，不落盘缓存） */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
/** HTML 文档最大字节数 */
export const MAX_DOC_BYTES = 8 * 1024 * 1024;
/** 探测时至少读到的头部字节数（用于解析图片尺寸 / 时长） */
export const PROBE_HEAD_BYTES = 256 * 1024;
/** 单次扫描最多处理的资源数量（保护） */
export const MAX_RESOURCES = 900;
/** 深度扫描时最多抓取的 CSS 文件数 */
export const MAX_CSS_FILES = 40;
/** 站内链接顺带扫描的最大页数 */
export const MAX_PAGES = 12;
export const REQUEST_TIMEOUT_MS = 20000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
