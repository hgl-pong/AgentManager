import { inflateRawSync } from 'node:zlib';

import { AppError } from '../shared/types.ts';

/** One file from a ZIP archive, already decompressed. Directory markers are dropped. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 64 KiB. */
const MAX_COMMENT_BYTES = 0xffff;
const EOCD_MIN_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

const DEFAULTS = {
  maxEntries: 1_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
};

function findEndOfCentralDirectory(buffer: Buffer): number {
  const floor = Math.max(0, buffer.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function broken(detail: string): AppError {
  return new AppError(400, `下载内容不是有效的 ZIP：${detail}`);
}

/**
 * Minimal ZIP reader: central directory only, `store` and `deflate` entries, no ZIP64 and no
 * encryption — exactly what a registry download is. Read through the central directory because
 * streaming archives write sizes as zero in the local header and only fill them in later.
 */
export function unzip(buffer: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULTS.maxEntries;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULTS.maxFileBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULTS.maxTotalBytes;

  if (buffer.length < EOCD_MIN_BYTES) throw broken('文件太小');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw broken('找不到目录记录');

  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new AppError(400, '暂不支持 ZIP64 包');
  }
  if (count > maxEntries) throw new AppError(400, `压缩包里文件太多（${count} > ${maxEntries}）`);
  if (directoryOffset + directorySize > buffer.length) throw broken('目录越界');

  const entries: ZipEntry[] = [];
  let total = 0;
  let offset = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_HEADER_BYTES > buffer.length) throw broken('目录项被截断');
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw broken('目录项签名不对');

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (offset + CENTRAL_HEADER_BYTES + nameLength > buffer.length) throw broken('文件名被截断');
    const name = buffer
      .subarray(offset + CENTRAL_HEADER_BYTES, offset + CENTRAL_HEADER_BYTES + nameLength)
      .toString('utf8');
    offset += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;

    // Directory markers carry no content; the extractor recreates the tree from file paths.
    if (name.endsWith('/')) continue;
    if (size > maxFileBytes) throw new AppError(400, `压缩包里的 ${name} 太大（${size} 字节）`);
    if (total + size > maxTotalBytes) throw new AppError(400, '压缩包解压后超出大小上限');

    if (localOffset + LOCAL_HEADER_BYTES > buffer.length) throw broken(`${name} 的局部头越界`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw broken(`${name} 的局部头签名不对`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > buffer.length) throw broken(`${name} 的内容被截断`);

    let data: Buffer;
    if (size === 0) {
      data = Buffer.alloc(0);
    } else if (method === 0) {
      data = Buffer.from(buffer.subarray(start, end));
    } else if (method === 8) {
      data = inflateRawSync(buffer.subarray(start, end), { maxOutputLength: size });
    } else {
      throw new AppError(400, `不支持的压缩方式 ${method}（${name}）`);
    }

    total += data.length;
    entries.push({ name, data });
  }

  return entries;
}
