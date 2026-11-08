import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { Attachment, User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { sanitizeFilename, sanitizeMimeType, type LocalFileStorage } from './storage.js';

/**
 * 0.5.5 large files: resumable uploads in chunks (up to MAX_LARGE_UPLOAD_SIZE, 5 GiB by default).
 *
 * The client announces the file, then sends it in pieces of at most CHUNK_SIZE bytes, each at the
 * offset the server reports. A broken connection loses at most the piece in flight: the client asks
 * how much arrived and continues from there (also after an app restart, if the same file is
 * picked again). Pieces stay below Nginx's client_max_body_size, so no proxy change is needed.
 *
 * Partial files live in <upload dir>/.partial as <uploadId>.part plus <uploadId>.json (who, name,
 * type, size, received). On completion the file is moved into the normal storage and becomes an
 * ordinary attachment. Unfinished uploads are removed after STALE_MS without progress.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const STALE_MS = 24 * 60 * 60 * 1000;
/** Parallel unfinished uploads per user. */
export const MAX_OPEN_UPLOADS = 5;
/** Disk space that must stay free besides the announced file. */
export const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UploadSession {
  id: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  size: number;
  received: number;
  createdAt: number;
  updatedAt: number;
}

export interface UploadStatus {
  uploadId: string;
  size: number;
  received: number;
  chunkSize: number;
}

export class ChunkedUploads {
  private readonly dir: string;
  /** Uploads with a request in progress (one writer per upload). */
  private readonly busy = new Set<string>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: LocalFileStorage,
    readonly maxSize: number,
    private readonly log: FastifyBaseLogger,
  ) {
    this.dir = path.join(storage.root, '.partial');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.sweepTimer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    this.sweepTimer.unref();
    void this.sweep();
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private paths(id: string): { part: string; meta: string } {
    if (!ID_PATTERN.test(id)) throw Errors.notFound('Upload');
    return { part: path.join(this.dir, `${id}.part`), meta: path.join(this.dir, `${id}.json`) };
  }

  private async load(user: User, id: string): Promise<UploadSession> {
    const { meta } = this.paths(id);
    let session: UploadSession;
    try {
      session = JSON.parse(await readFile(meta, 'utf8')) as UploadSession;
    } catch {
      throw Errors.notFound('Upload');
    }
    if (session.uploaderId !== user.id) throw Errors.notFound('Upload');
    return session;
  }

  private async save(session: UploadSession): Promise<void> {
    await writeFile(this.paths(session.id).meta, JSON.stringify(session), { mode: 0o640 });
  }

  private status(session: UploadSession): UploadStatus {
    return { uploadId: session.id, size: session.size, received: session.received, chunkSize: CHUNK_SIZE };
  }

  async start(user: User, input: { filename?: string; mimeType?: string; size: number }): Promise<UploadStatus> {
    const size = input.size;
    if (!Number.isSafeInteger(size) || size <= 0) throw Errors.badRequest('EMPTY_FILE', 'Uploaded file is empty');
    if (size > this.maxSize) throw Errors.payloadTooLarge(`File is too large (max ${formatGiB(this.maxSize)})`);
    const open = (await this.list()).filter((s) => s.uploaderId === user.id);
    if (open.length >= MAX_OPEN_UPLOADS) throw Errors.conflict('TOO_MANY_UPLOADS', `Finish or cancel your other uploads first (max ${MAX_OPEN_UPLOADS})`);
    const reserved = open.reduce((sum, s) => sum + (s.size - s.received), 0);
    const free = await freeBytes(this.dir);
    if (free !== null && free < size + reserved + DISK_RESERVE_BYTES) throw new AppError(507, 'INSUFFICIENT_STORAGE', 'Not enough free space on the server for this file');
    const now = Date.now();
    const session: UploadSession = {
      id: randomUUID(),
      uploaderId: user.id,
      filename: sanitizeFilename(input.filename),
      mimeType: sanitizeMimeType(input.mimeType),
      size,
      received: 0,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(this.paths(session.id).part, Buffer.alloc(0), { flag: 'wx', mode: 0o640 });
    await this.save(session);
    return this.status(session);
  }

  async get(user: User, id: string): Promise<UploadStatus> {
    return this.status(await this.load(user, id));
  }

  /**
   * Appends one piece at `offset`. The offset must be exactly what has arrived so far (409 with the
   * current status otherwise). If the connection breaks inside the piece, whatever was written is
   * kept and reported, so the client resumes from the real position.
   */
  async append(user: User, id: string, offset: number, body: Readable): Promise<UploadStatus> {
    const session = await this.load(user, id);
    if (this.busy.has(id)) throw Errors.conflict('UPLOAD_BUSY', 'This upload is already receiving data');
    if (offset !== session.received) throw new AppError(409, 'UPLOAD_OFFSET', 'Unexpected offset', this.status(session));
    const limit = Math.min(CHUNK_SIZE, session.size - session.received);
    if (limit <= 0) throw Errors.conflict('UPLOAD_COMPLETE', 'All data has arrived; complete the upload');
    this.busy.add(id);
    const { part } = this.paths(id);
    // The file must end exactly at the confirmed position (a refused piece may have left bytes).
    try {
      if ((await stat(part)).size !== session.received) await truncate(part, session.received);
    } catch (error) {
      this.busy.delete(id);
      throw error;
    }
    let written = 0;
    let tooLong = false;
    let discarded = 0;
    const out = createWriteStream(part, { flags: 'a' });
    try {
      // Read by hand (not pipeline): a piece that is too long is drained and answered with 413
      // instead of tearing the connection down, so the client gets a real answer.
      for await (const chunk of body as AsyncIterable<Buffer>) {
        if (tooLong) {
          discarded += chunk.length;
          if (discarded > CHUNK_SIZE) {
            body.destroy();
            break;
          }
          continue;
        }
        if (written + chunk.length > limit) {
          tooLong = true;
          continue;
        }
        written += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
    } catch {
      this.log.info({ event: 'upload.chunk_interrupted', uploadId: id, written }, 'Upload piece interrupted; keeping what arrived');
    } finally {
      await new Promise<void>((resolve) => {
        out.end(() => {
          resolve();
        });
      });
      if (tooLong) await truncate(part, session.received).catch(() => undefined);
      this.busy.delete(id);
    }
    if (tooLong) throw Errors.payloadTooLarge(`A piece may be at most ${String(limit)} bytes here`);
    const info = await stat(part);
    session.received = Math.min(info.size, session.size);
    session.updatedAt = Date.now();
    await this.save(session);
    return this.status(session);
  }

  /** All data arrived: hash it, move it into storage and create the attachment. */
  async complete(user: User, id: string): Promise<Attachment> {
    const session = await this.load(user, id);
    if (session.received !== session.size) throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Not all data has arrived yet', this.status(session));
    if (this.busy.has(id)) throw Errors.conflict('UPLOAD_BUSY', 'This upload is already being completed');
    this.busy.add(id);
    const { part, meta } = this.paths(id);
    try {
      const info = await stat(part);
      if (info.size !== session.size) throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Stored data does not match the announced size', this.status(session));
      const sha256 = await hashFile(part);
      const storedName = randomUUID();
      const target = this.storage.resolve(storedName);
      await rename(part, target);
      try {
        const attachment = await this.prisma.attachment.create({
          data: { uploaderId: user.id, originalName: session.filename, storedName, mimeType: session.mimeType, size: BigInt(session.size), sha256 },
        });
        await rm(meta, { force: true });
        return attachment;
      } catch (error) {
        await rename(target, part).catch(() => undefined);
        throw error;
      }
    } finally {
      this.busy.delete(id);
    }
  }

  async cancel(user: User, id: string): Promise<void> {
    await this.load(user, id);
    await this.remove(id);
  }

  private async remove(id: string): Promise<void> {
    const { part, meta } = this.paths(id);
    await rm(part, { force: true });
    await rm(meta, { force: true });
  }

  private async list(): Promise<UploadSession[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: UploadSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as UploadSession);
      } catch {
        /* half-written metadata: the sweep removes it */
      }
    }
    return out;
  }

  /** 0.5.8 admin panel: unfinished uploads right now (how many, bytes already on disk). */
  async stats(): Promise<{ count: number; bytes: number; idleOverHour: number }> {
    const sessions = await this.list();
    const now = Date.now();
    return {
      count: sessions.length,
      bytes: sessions.reduce((sum, s) => sum + s.received, 0),
      idleOverHour: sessions.filter((s) => now - s.updatedAt > 3_600_000).length,
    };
  }

  /** 0.5.8 admin panel: removes unfinished uploads without progress for `idleMs` (default 1 hour). */
  async purgeIdle(idleMs = 3_600_000): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const session of await this.list()) {
      if (now - session.updatedAt > idleMs) {
        await this.remove(session.id).catch(() => undefined);
        removed += 1;
      }
    }
    if (removed > 0) this.log.info({ event: 'upload.purged', removed }, 'Idle unfinished uploads removed by an admin');
    return removed;
  }

  /** 0.5.8 admin panel: free / total bytes of the disk the uploads live on. */
  async disk(): Promise<{ free: number; total: number } | null> {
    try {
      const info = await statfs(this.dir);
      return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
    } catch {
      return null;
    }
  }

  /** Removes uploads without progress for STALE_MS (and stray files). */
  async sweep(now = Date.now()): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const live = new Set<string>();
    for (const session of await this.list()) {
      if (now - session.updatedAt > STALE_MS) {
        await this.remove(session.id).catch(() => undefined);
        this.log.info({ event: 'upload.expired', uploadId: session.id }, 'Unfinished upload expired');
      } else live.add(session.id);
    }
    for (const name of names) {
      const id = name.replace(/\.(part|json)$/, '');
      if (!live.has(id) && ID_PATTERN.test(id)) {
        const full = path.join(this.dir, name);
        const info = await stat(full).catch(() => null);
        if (info && now - info.mtimeMs > STALE_MS) await rm(full, { force: true }).catch(() => undefined);
      }
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
  return hash.digest('hex');
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

function formatGiB(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
