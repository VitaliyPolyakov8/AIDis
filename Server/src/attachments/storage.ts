import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, Errors } from '../common/errors.js';

const STORED_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Local filesystem storage for uploads. Files are stored under a server-generated
 * UUID name; the client-supplied filename is never used to build a path.
 */
export class LocalFileStorage {
  readonly root: string;

  constructor(directory: string) {
    this.root = path.resolve(directory);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Resolves a stored name to an absolute path, refusing anything that could escape the root. */
  resolve(storedName: string): string {
    if (!STORED_NAME_PATTERN.test(storedName)) {
      throw Errors.notFound('File');
    }
    const full = path.resolve(this.root, storedName);
    if (path.dirname(full) !== this.root) {
      throw Errors.notFound('File');
    }
    return full;
  }

  /** Streams data to a new file. Returns the generated name, size and SHA-256. */
  async save(source: Readable): Promise<{ storedName: string; size: number; sha256: string }> {
    const storedName = randomUUID();
    const target = this.resolve(storedName);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(target, { flags: 'wx', mode: 0o640 }));
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return { storedName, size, sha256: hash.digest('hex') };
  }

  async open(storedName: string, range?: { start: number; end: number }): Promise<{ stream: ReadStream; size: number }> {
    const full = this.resolve(storedName);
    try {
      const info = await stat(full);
      if (!info.isFile()) throw Errors.notFound('File');
      return { stream: createReadStream(full, range ? { start: range.start, end: range.end } : undefined), size: info.size };
    } catch {
      throw Errors.notFound('File');
    }
  }

  /** Size of a stored file (Range requests need it before opening). */
  async sizeOf(storedName: string): Promise<number> {
    try {
      const info = await stat(this.resolve(storedName));
      if (!info.isFile()) throw Errors.notFound('File');
      return info.size;
    } catch {
      throw Errors.notFound('File');
    }
  }

  /** Reads at most `maxBytes` from the start of a stored file (header checks). */
  async readHead(storedName: string, maxBytes: number): Promise<Buffer> {
    const { stream } = await this.open(storedName);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) break;
    }
    stream.destroy();
    return Buffer.concat(chunks).subarray(0, maxBytes);
  }

  async remove(storedName: string): Promise<void> {
    await rm(this.resolve(storedName), { force: true });
  }
}

/**
 * 0.5.5: one byte range of a "Range: bytes=..." header (video seeking, resumed downloads), or
 * null for "whole file". Multi-range requests are answered with the whole file. Throws 416 when
 * the range is outside the file. Pure (unit-tested).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    throw new AppError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range is outside the file', { size });
  }
  return { start, end };
}


/** Makes an uploaded filename safe for display and Content-Disposition: no paths, no control chars. */
export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F"<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}

/** Accepts only well-formed MIME types; anything else is stored as application/octet-stream. */
export function sanitizeMimeType(mime: string | undefined): string {
  const value = (mime ?? '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(value)
    ? value
    : 'application/octet-stream';
}

/** Types that browsers may display inline. Everything else (incl. SVG/HTML) is forced to download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
]);

export function isInlineSafe(mime: string): boolean {
  return INLINE_TYPES.has(mime);
}
