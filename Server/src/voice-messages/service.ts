import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { User } from '../generated/prisma/client.js';
import type { AttachmentsService } from '../attachments/attachments.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import { Errors } from '../common/errors.js';

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 300;
const idSchema = z.uuid();
const recordSchema = z.object({
  id: idSchema, status: z.enum(['draft', 'queued', 'processing', 'done', 'failed']),
  text: z.string().max(20000).nullable(), duration: z.number().positive().max(MAX_VOICE_SECONDS).nullable(),
  error: z.string().max(80).nullable(), attempts: z.number().int().min(0).max(3),
  notBefore: z.number().nonnegative(),
});
export type VoiceMessage = z.infer<typeof recordSchema>;
export type Transcribe = (file: string, signal: AbortSignal) => Promise<{ text: string; duration: number }>;

/** One backend process owns this directory. Audio remains in protected attachment storage. */
export class VoiceMessages {
  private readonly directory: string;
  private jobs: string[] = [];
  private mutation: Promise<unknown> = Promise.resolve();
  private processing: Promise<void> | null = null;
  private stopped = false;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly prisma: PrismaClient, private readonly attachments: AttachmentsService,
    private readonly permissions: PermissionsService, private readonly worker: Transcribe, private readonly capacity = 32) {
    this.directory = path.join(attachments.storage.root, '.voice-messages');
  }

  private async atomic(file: string, value: unknown): Promise<void> {
    const target = path.join(this.directory, file);
    await writeFile(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(`${target}.tmp`, target); return; }
      catch (error) {
        // Windows readers/antivirus can briefly deny atomic replacement. Keep
        // the old file intact and retry the rename, never unlink the target.
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(fn);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private async record(id: string): Promise<VoiceMessage | null> {
    if (!idSchema.safeParse(id).success) throw Errors.notFound('Voice message');
    try { return recordSchema.parse(JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private save(record: VoiceMessage) { return this.atomic(`${record.id}.json`, record); }
  private saveQueue() { return this.atomic('queue.json', this.jobs); }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { this.jobs = z.array(idSchema).max(this.capacity).parse(JSON.parse(await readFile(path.join(this.directory, 'queue.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Interrupted jobs stay in the persisted index until their result is durable.
    for (const id of this.jobs) {
      const record = await this.record(id);
      if (record?.status === 'processing') await this.save({ ...record, status: 'queued' });
    }
    this.kick();
  }

  private async authorized(user: User, id: string) {
    const attachment = await this.attachments.get(id);
    if (!attachment.messageId) {
      // Deleting a message detaches its files. Completed/queued metadata must not
      // become uploader-readable drafts again after losing its channel ACL.
      if (attachment.uploaderId !== user.id || (await this.record(id))?.status !== 'draft') throw Errors.notFound('Voice message');
      return attachment;
    }
    const message = await this.prisma.message.findUnique({ where: { id: attachment.messageId }, include: { channel: true } });
    if (!message || message.deletedAt || !(await this.permissions.canView(user, message.channel))) throw Errors.notFound('Voice message');
    return attachment;
  }

  async register(user: User, id: string): Promise<VoiceMessage> {
    idSchema.parse(id);
    const attachment = await this.attachments.get(id);
    if (attachment.uploaderId !== user.id || attachment.messageId) throw Errors.notFound('Unused upload');
    if (Number(attachment.size) > MAX_VOICE_BYTES || await this.attachments.storage.sizeOf(attachment.storedName) > MAX_VOICE_BYTES) throw Errors.payloadTooLarge('Voice messages are limited to 20 MiB');
    const head = await this.attachments.storage.readHead(attachment.storedName, 16);
    const valid = head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || head.subarray(0, 4).toString() === 'OggS'
      || (head.subarray(4, 8).toString() === 'ftyp') || (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE');
    if (!valid) throw Errors.badRequest('INVALID_VOICE_AUDIO', 'Unsupported audio container');
    return this.locked(async () => {
      const existing = await this.record(id);
      if (existing && existing.status !== 'draft') throw Errors.notFound('Unused upload');
      if (existing) return existing;
      const record: VoiceMessage = { id, status: 'draft', text: null, duration: null, error: null, attempts: 0, notBefore: 0 };
      await this.save(record); return record;
    });
  }

  async get(user: User, id: string): Promise<VoiceMessage | null> {
    const attachment = await this.authorized(user, id);
    const record = await this.record(id);
    // Recovers a crash between message commit and queue insertion when the message is next read.
    if (attachment.messageId && record?.status === 'draft') {
      await this.queueAttached([id]); return this.record(id);
    }
    return record;
  }

  async queueAttached(ids: string[]): Promise<void> {
    await this.locked(async () => {
      for (const id of ids) {
        const record = await this.record(id);
        if (!record || record.status !== 'draft') continue;
        const attachment = await this.attachments.get(id);
        if (!attachment.messageId) continue;
        const message = await this.prisma.message.findUnique({ where: { id: attachment.messageId } });
        if (!message || message.deletedAt || message.authorId !== attachment.uploaderId) continue;
        if (this.jobs.length >= this.capacity) { await this.save({ ...record, status: 'failed', error: 'queue-full' }); continue; }
        this.jobs.push(id);
        // Index first: a crash can leave a draft in the queue, which the pump safely accepts.
        await this.saveQueue(); await this.save({ ...record, status: 'queued' });
      }
    });
    this.kick();
  }

  private kick(): void {
    if (this.stopped || this.processing || this.timer) return;
    this.processing = this.pump().catch(() => {
      // Storage errors leave the persisted job intact; retry without a busy loop.
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; this.kick(); }, 30_000);
    }).finally(() => { this.processing = null; if (!this.stopped && !this.timer && this.jobs.length) this.kick(); });
  }

  private async pump(): Promise<void> {
    while (!this.stopped && this.jobs[0]) {
      const id = this.jobs[0];
      const record = await this.record(id);
      if (!record || record.status === 'done' || record.status === 'failed') {
        await this.locked(async () => { this.jobs.shift(); await this.saveQueue(); }); continue;
      }
      if (record.attempts >= 2) {
        await this.locked(async () => {
          await this.save({ ...record, status: 'failed', error: 'transcription-failed' });
          this.jobs.shift(); await this.saveQueue();
        });
        continue;
      }
      if (record.notBefore > Date.now()) {
        this.timer = setTimeout(() => { this.timer = null; this.kick(); }, record.notBefore - Date.now()); return;
      }
      this.controller = new AbortController();
      await this.locked(() => this.save({ ...record, status: 'processing', attempts: record.attempts + 1 }));
      let next: VoiceMessage;
      try {
        const attachment = await this.attachments.get(id);
        const author = await this.prisma.user.findUnique({ where: { id: attachment.uploaderId } });
        if (!author || author.disabled || !attachment.messageId) throw new Error('unavailable');
        await this.authorized(author, id);
        const result = await this.worker(this.attachments.storage.resolve(attachment.storedName), this.controller.signal);
        if (!Number.isFinite(result.duration) || result.duration <= 0 || result.duration > MAX_VOICE_SECONDS || result.text.length > 20000) throw new Error('invalid-audio');
        next = { ...record, status: 'done', attempts: record.attempts + 1, text: result.text, duration: result.duration, error: null };
      } catch (error) {
        if (this.controller.signal.aborted) { await this.locked(() => this.save({ ...record, status: 'queued' })); return; }
        const invalid = error instanceof Error && error.message === 'invalid-audio';
        next = { ...record, attempts: record.attempts + 1, status: invalid || record.attempts >= 1 ? 'failed' : 'queued',
          error: invalid ? 'invalid-audio' : 'transcription-failed', notBefore: Date.now() + 30_000 };
      }
      await this.locked(async () => {
        await this.save(next);
        if (next.status !== 'queued') { this.jobs.shift(); await this.saveQueue(); }
      });
      this.controller = null;
    }
  }

  async close(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    this.controller?.abort(); await this.processing; await this.mutation;
  }
}
