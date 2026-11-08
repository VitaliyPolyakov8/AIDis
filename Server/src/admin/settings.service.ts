import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../db/prisma.js';
import { parseInput } from '../common/validation.js';

/** 0.5.8: a banner shown to everyone at the top of the app (e.g. "restart at 23:00"). */
export interface AnnouncementView {
  /** New id on every change, so a banner someone closed comes back when the text changes. */
  id: string;
  text: string;
  level: 'info' | 'warning';
  updatedAt: string;
}

export const announcementInput = z.object({
  text: z.string().trim().min(1).max(300),
  level: z.enum(['info', 'warning']).default('info'),
});

const ANNOUNCEMENT = 'announcement';

/**
 * Key/value settings in `app_settings`, cached in memory (one backend process, every write goes
 * through here). Values are plain JSON checked on the way in and on the way out.
 */
export class SettingsService {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly prisma: PrismaClient) {}

  private async read(key: string): Promise<unknown> {
    if (this.cache.has(key)) return this.cache.get(key);
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    const value = row ? (row.value as unknown) : null;
    this.cache.set(key, value);
    return value;
  }

  private async write(key: string, value: unknown): Promise<void> {
    if (value === null) await this.prisma.appSetting.deleteMany({ where: { key } });
    else {
      const json = value as Prisma.InputJsonValue;
      await this.prisma.appSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
    }
    this.cache.set(key, value);
  }

  async announcement(): Promise<AnnouncementView | null> {
    const raw = (await this.read(ANNOUNCEMENT)) as Partial<AnnouncementView> | null;
    if (!raw || typeof raw.text !== 'string' || typeof raw.id !== 'string') return null;
    return { id: raw.id, text: raw.text, level: raw.level === 'warning' ? 'warning' : 'info', updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString() };
  }

  async setAnnouncement(input: unknown): Promise<AnnouncementView> {
    const data = parseInput(announcementInput, input);
    const view: AnnouncementView = { id: randomUUID(), text: data.text, level: data.level, updatedAt: new Date().toISOString() };
    await this.write(ANNOUNCEMENT, view);
    return view;
  }

  async clearAnnouncement(): Promise<void> {
    await this.write(ANNOUNCEMENT, null);
  }

  /** 0.5.9: any small JSON value (e.g. which episodes were already announced). */
  async getValue<T>(key: string): Promise<T | null> {
    return (await this.read(key)) as T | null;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }
}
