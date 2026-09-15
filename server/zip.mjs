/**
 * 极简 ZIP 写入器（零依赖，流式输出，条目内容保持原始字节）
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dt = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: dt };
}

function sanitizeName(name) {
  return String(name)
    .replace(/[\\]+/g, '/')
    .replace(/:/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\/+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

export class ZipWriter {
  /** @param {import('node:stream').Writable} writable */
  constructor(writable, { comment = '', level = 6 } = {}) {
    this.w = writable;
    this.entries = [];
    this.offset = 0;
    this.count = 0;
    this.comment = comment;
    this.level = level;
    this.lastDate = null;
  }

  async _write(buf) {
    this.offset += buf.length;
    if (!this.w.write(buf)) {
      await new Promise((resolve) => this.w.once('drain', resolve));
    }
  }

  /** 添加一个文件（buffer/string），默认 deflate，但字节内容与源文件完全一致 */
  async add(name, content, opts = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content == null ? '' : content), 'utf-8');
    let compression = 0;
    let finalPayload = data;
    if (!opts.store && data.length > 32) {
      const deflated = zlib.deflateRawSync(data, { level: opts.level != null ? opts.level : this.level });
      if (deflated.length < data.length) {
        compression = 8;
        finalPayload = deflated;
      }
    }
    const clean = sanitizeName(name);
    const nameBuf = Buffer.from(clean, 'utf-8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(opts.date || this.lastDate || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(finalPayload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await this._write(local);
    await this._write(nameBuf);
    if (finalPayload.length) await this._write(finalPayload);

    this.entries.push({
      name: nameBuf, crc, csize: finalPayload.length, usize: data.length,
      compression, time, date, offset: this.offset - finalPayload.length - nameBuf.length - 30,
      external: 0o644 << 16,
    });
    this.count++;
    return this.entries[this.entries.length - 1];
  }

  async addDir(name) {
    const clean = sanitizeName(name).replace(/\/*$/, '') + '/';
    const nameBuf = Buffer.from(clean, 'utf-8');
    const { time, date } = dosDateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const before = this.offset;
    await this._write(local);
    await this._write(nameBuf);
    this.entries.push({ name: nameBuf, crc: 0, csize: 0, usize: 0, compression: 0, time, date, offset: before, external: (0o755 << 16) | 0x10 });
    this.count++;
  }

  async finish() {
    const centralStart = this.offset;
    const chunks = [];
    for (const e of this.entries) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.compression, 10);
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.date, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.csize, 20);
      head.writeUInt32LE(e.usize, 24);
      head.writeUInt16LE(e.name.length, 28);
      head.writeUInt16LE(0, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(e.external, 38);
      head.writeUInt32LE(e.offset, 42);
      chunks.push(head, e.name);
    }
    const central = Buffer.concat(chunks);
    await this._write(central);
    const commentBuf = Buffer.from(this.comment || '', 'utf-8');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.count & 0xffff, 8);
    end.writeUInt16LE(this.count & 0xffff, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(commentBuf.length, 20);
    await this._write(end);
    if (commentBuf.length) await this._write(commentBuf);
    if (typeof this.w.end === 'function') {
      await new Promise((resolve) => { try { this.w.end(resolve); } catch { resolve(); } });
    }
    return { entries: this.count, bytes: this.offset };
  }
}

/** 内存中打包（用于小批量预览/校验） */
export async function zipToBuffer(items, { comment = '' } = {}) {
  const { Writable } = await import('node:stream');
  const buffers = [];
  const sink = new Writable({
    write(chunk, enc, cb) { buffers.push(Buffer.from(chunk)); cb(); },
  });
  const zip = new ZipWriter(sink, { comment });
  for (const item of items) await zip.add(item.name, item.data, item.opts || {});
  await zip.finish();
  return Buffer.concat(buffers);
}
