import { Readable } from 'node:stream';
import { parseBuffer } from 'music-metadata';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { ServerSound, User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import type { LocalFileStorage } from '../attachments/storage.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { EventPublisher } from '../realtime/events.js';
import type { AuditService } from '../audit/audit.service.js';

export const MAX_SOUND_BYTES = 512 * 1024;
export const MAX_SOUND_MS = 5000;
/** One press per person per this long. */
export const SOUND_COOLDOWN_MS = 2000;

export interface SoundView {
  id: string;
  guildId: string;
  name: string;
  emoji: string | null;
  volume: number;
  durationMs: number;
  createdById: string;
  createdAt: string;
}

function view(row: ServerSound): SoundView {
  return { id: row.id, guildId: row.guildId, name: row.name, emoji: row.emoji, volume: row.volume, durationMs: row.durationMs, createdById: row.createdById, createdAt: row.createdAt.toISOString() };
}

const name = z.string().transform(sanitizeText).pipe(z.string().min(1, 'Name is required').max(32, 'At most 32 characters'));
const emoji = z
  .string()
  .trim()
  .max(16)
  .regex(/^\S*$/, 'One emoji')
  .transform((v) => (v === '' ? null : v));
const volume = z.coerce.number().int().min(0).max(100);
const createInput = z.object({ name, emoji: emoji.optional(), volume: volume.default(100) });
const patchInput = z.object({ name: name.optional(), emoji: emoji.nullable().optional(), volume: volume.optional() });

/** The audio container by its first bytes (the client's Content-Type is not trusted). */
function sniff(bytes: Buffer): 'audio/wav' | 'audio/ogg' | 'audio/mpeg' | null {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

const soundType = () => Errors.badRequest('SOUND_TYPE', 'Use an MP3, OGG or WAV file');
const nameTaken = () => Errors.conflict('SOUND_NAME_TAKEN', 'A sound with this name already exists on the server');

export type PressResult = { ok: true; channelId: string; listenerIds: string[] } | { ok: false; code: 'NOT_IN_VOICE' | 'NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED' };

export interface VoicePresenceSource {
  channelOf(userId: string): string | null;
  participantIdsOf(channelId: string): string[];
}

/**
 * 0.7.1 soundboard: each server's short sounds (CREATE_SOUNDS / MANAGE_SOUNDS, like emojis). A press
 * is not audio through the microphone: the server checks it and tells everyone in the voice
 * channel to play the file themselves (cached by the clients), so it works the same on every node.
 */
export class SoundsService {
  private readonly lastPress = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly storage: LocalFileStorage,
    private readonly permissions: PermissionsService,
    private readonly publisher: EventPublisher,
    private readonly audit: AuditService,
    private readonly limits: LimitsService,
    private readonly voice: VoicePresenceSource,
  ) {}

  async list(user: User, guildId: string): Promise<SoundView[]> {
    if (!(await this.permissions.isMember(user.id, guildId))) throw Errors.guildNotFound();
    return (await this.prisma.serverSound.findMany({ where: { guildId }, orderBy: { name: 'asc' } })).map(view);
  }

  /** The file, for members of the sound's server only. */
  async readable(user: User, id: string): Promise<ServerSound> {
    const row = await this.prisma.serverSound.findUnique({ where: { id } });
    if (!row || !(await this.permissions.isMember(user.id, row.guildId))) throw Errors.notFound('Sound');
    return row;
  }

  private async get(id: string): Promise<ServerSound> {
    const row = await this.prisma.serverSound.findUnique({ where: { id } });
    if (!row) throw Errors.notFound('Sound');
    return row;
  }

  private async requireEdit(user: User, row: ServerSound): Promise<void> {
    const perms = await this.permissions.guildPermissions(user, row.guildId);
    if (perms.size === 0) throw Errors.notFound('Sound');
    if (perms.has('MANAGE_SOUNDS')) return;
    if (row.createdById === user.id && perms.has('CREATE_SOUNDS')) return;
    throw Errors.forbidden('You cannot manage this sound');
  }

  async create(user: User, guildId: string, query: unknown, stream: Readable): Promise<SoundView> {
    const perms = await this.permissions.guildPermissions(user, guildId);
    if (perms.size === 0) throw Errors.guildNotFound();
    if (!perms.has('CREATE_SOUNDS') && !perms.has('MANAGE_SOUNDS')) throw Errors.forbidden('Missing permission: CREATE_SOUNDS');
    const data = parseInput(createInput, query);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of stream) {
      const chunk: unknown = raw;
      if (!Buffer.isBuffer(chunk)) throw soundType();
      size += chunk.length;
      if (size > MAX_SOUND_BYTES) throw Errors.payloadTooLarge('Sound files must be at most 512 KiB');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const mimeType = sniff(bytes);
    if (!mimeType) throw soundType();
    let seconds: number | undefined;
    try {
      seconds = (await parseBuffer(bytes, { mimeType, size }, { duration: true, skipCovers: true })).format.duration;
    } catch {
      throw soundType();
    }
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) throw soundType();
    const durationMs = Math.round(seconds * 1000);
    // A little slack for encoder padding (a "5 s" MP3 is often 5.02 s).
    if (durationMs > MAX_SOUND_MS + 100) throw new AppError(400, 'SOUND_TOO_LONG', 'Sounds must be at most 5 seconds long', { durationMs, maxMs: MAX_SOUND_MS });

    if (await this.prisma.serverSound.findUnique({ where: { guildId_name: { guildId, name: data.name } } })) throw nameTaken();
    const limit = await this.limits.resolve('guild.sounds', { guildId });
    if ((await this.prisma.serverSound.count({ where: { guildId } })) >= limit) throw Errors.limitReached('guild.sounds', limit);
    const saved = await this.storage.save(Readable.from(bytes));
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const used = new Set((await this.prisma.serverSound.findMany({ where: { guildId }, select: { slot: true } })).map((s) => s.slot));
        const slot = Array.from({ length: limit }, (_, i) => i).find((i) => !used.has(i));
        if (slot === undefined) throw Errors.limitReached('guild.sounds', limit);
        try {
          const row = await this.prisma.serverSound.create({
            data: { guildId, name: data.name, emoji: data.emoji ?? null, volume: data.volume, slot, storedName: saved.storedName, mimeType, size, durationMs, createdById: user.id },
          });
          await this.audit.record(user.id, 'sound.created', { type: 'sound', id: row.id }, { name: row.name }, guildId);
          this.publisher.soundsChanged(guildId);
          return view(row);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          if (await this.prisma.serverSound.findUnique({ where: { guildId_name: { guildId, name: data.name } } })) throw nameTaken();
        }
      }
      throw Errors.conflict('SOUND_BUSY', 'Another sound is being added; please retry');
    } catch (error) {
      await this.storage.remove(saved.storedName);
      throw error;
    }
  }

  async update(user: User, id: string, input: unknown): Promise<SoundView> {
    const row = await this.get(id);
    await this.requireEdit(user, row);
    const data = parseInput(patchInput, input);
    let updated: ServerSound;
    try {
      updated = await this.prisma.serverSound.update({
        where: { id },
        data: { ...(data.name !== undefined ? { name: data.name } : {}), ...(data.emoji !== undefined ? { emoji: data.emoji } : {}), ...(data.volume !== undefined ? { volume: data.volume } : {}) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
    await this.audit.record(user.id, 'sound.updated', { type: 'sound', id }, { name: updated.name }, row.guildId);
    this.publisher.soundsChanged(row.guildId);
    return view(updated);
  }

  async remove(user: User, id: string): Promise<void> {
    const row = await this.get(id);
    await this.requireEdit(user, row);
    await this.prisma.serverSound.delete({ where: { id } });
    await this.storage.remove(row.storedName);
    await this.audit.record(user.id, 'sound.deleted', { type: 'sound', id }, { name: row.name }, row.guildId);
    this.publisher.soundsChanged(row.guildId);
  }

  /** A soundboard press (socket): in a voice channel of the sound's server, allowed there, not too often. */
  async press(user: User, soundId: string, now = Date.now()): Promise<PressResult> {
    const channelId = this.voice.channelOf(user.id);
    if (!channelId) return { ok: false, code: 'NOT_IN_VOICE' };
    const sound = await this.prisma.serverSound.findUnique({ where: { id: soundId }, select: { guildId: true } });
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!sound || !channel || channel.guildId !== sound.guildId) return { ok: false, code: 'NOT_FOUND' };
    if (!(await this.permissions.hasInChannel(user, channel, 'USE_SOUNDBOARD'))) return { ok: false, code: 'FORBIDDEN' };
    const last = this.lastPress.get(user.id) ?? 0;
    if (now - last < SOUND_COOLDOWN_MS) return { ok: false, code: 'RATE_LIMITED' };
    this.lastPress.set(user.id, now);
    if (this.lastPress.size > 5000) for (const [id, at] of this.lastPress) if (now - at > SOUND_COOLDOWN_MS) this.lastPress.delete(id);
    return { ok: true, channelId, listenerIds: this.voice.participantIdsOf(channelId) };
  }
}
