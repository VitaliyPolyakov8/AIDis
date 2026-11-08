import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { GamePlatform, GameStatus, User, UserGame } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import { gameKey } from '../presence/game-history.js';
import type { UsersService } from '../users/users.service.js';

export const GAME_STATUSES = ['PLAYING', 'COMPLETED', 'HUNDRED', 'DROPPED', 'PAUSED'] as const satisfies readonly GameStatus[];
export const GAME_PLATFORMS = ['PC', 'PLAYSTATION', 'XBOX', 'SWITCH', 'MOBILE', 'OTHER'] as const satisfies readonly GamePlatform[];
/** A game in progress that was not launched for this long gets a "how did it end?" card. */
export const PROMPT_AFTER_DAYS = 14;
const SHELF_LIMIT = 200;

export interface GameView {
  id: string;
  name: string;
  platform: GamePlatform;
  status: GameStatus;
  manual: boolean;
  steamAppId: number | null;
  totalSeconds: number;
  sessions: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
  coverAttachmentId: string | null;
}

export function toGameView(row: UserGame): GameView {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: row.status,
    manual: row.manual,
    steamAppId: row.steamAppId,
    totalSeconds: row.totalSeconds,
    sessions: row.sessions,
    firstPlayedAt: row.firstPlayedAt.toISOString(),
    lastPlayedAt: row.lastPlayedAt.toISOString(),
    coverAttachmentId: row.coverAttachmentId,
  };
}

const name = z.string().transform(sanitizeText).pipe(z.string().min(1, 'Name is required').max(128));
const addInput = z.object({ name, platform: z.enum(GAME_PLATFORMS).default('PC'), status: z.enum(GAME_STATUSES).default('PLAYING'), coverAttachmentId: z.uuid().nullable().optional() });
const patchInput = z.object({ name: name.optional(), platform: z.enum(GAME_PLATFORMS).optional(), status: z.enum(GAME_STATUSES).optional(), coverAttachmentId: z.uuid().nullable().optional() });

const ORDER: Record<GameStatus, number> = { PLAYING: 0, PAUSED: 1, COMPLETED: 2, HUNDRED: 2, DROPPED: 3 };

/**
 * Built-in game tracker: the games of a person, found on the PC by the desktop app (GameHistoryService)
 * or added by hand from any platform, with a status. Everything stays on this server.
 */
export class GamesService {
  /** Told after every change of someone's list (realtime "games.changed"). */
  onChanged: ((userId: string) => void) | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UsersService,
  ) {}

  /** The shelf of `userId` as `viewer` may see it (the caller checked that the profile is visible). */
  async list(viewer: User, userId: string): Promise<{ games: GameView[]; hidden: boolean }> {
    const owner = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, showRecentGames: true, disabled: true } });
    if (!owner || owner.disabled) throw Errors.notFound('User');
    if (!owner.showRecentGames && owner.id !== viewer.id) return { games: [], hidden: true };
    const rows = await this.prisma.userGame.findMany({ where: { userId }, orderBy: { lastPlayedAt: 'desc' }, take: SHELF_LIMIT });
    rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime());
    return { games: rows.map(toGameView), hidden: !owner.showRecentGames };
  }

  async add(user: User, input: unknown): Promise<GameView> {
    const data = parseInput(addInput, input);
    if (data.coverAttachmentId) await this.users.checkImage(user.id, data.coverAttachmentId, 'banner');
    try {
      const row = await this.prisma.userGame.create({
        data: { userId: user.id, gameKey: gameKey(data.name), name: data.name, platform: data.platform, status: data.status, manual: true, coverAttachmentId: data.coverAttachmentId ?? null, statusChangedAt: new Date() },
      });
      this.onChanged?.(user.id);
      return toGameView(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.conflict('GAME_EXISTS', 'This game is already in your list');
      throw error;
    }
  }

  async update(user: User, id: string, input: unknown): Promise<GameView> {
    const row = await this.own(user, id);
    const data = parseInput(patchInput, input);
    if (data.coverAttachmentId) await this.users.checkImage(user.id, data.coverAttachmentId, 'banner');
    try {
      const updated = await this.prisma.userGame.update({
        where: { id: row.id },
        data: {
          ...(data.name !== undefined ? { name: data.name, gameKey: gameKey(data.name) } : {}),
          ...(data.platform !== undefined ? { platform: data.platform } : {}),
          ...(data.status !== undefined && data.status !== row.status ? { status: data.status, statusChangedAt: new Date() } : {}),
          ...(data.coverAttachmentId !== undefined ? { coverAttachmentId: data.coverAttachmentId } : {}),
        },
      });
      this.onChanged?.(user.id);
      return toGameView(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.conflict('GAME_EXISTS', 'This game is already in your list');
      throw error;
    }
  }

  async remove(user: User, id: string): Promise<void> {
    const row = await this.own(user, id);
    await this.prisma.userGame.delete({ where: { id: row.id } });
    this.onChanged?.(user.id);
  }

  /** Games in progress that were not launched for PROMPT_AFTER_DAYS and were not asked about since. */
  async prompts(user: User, now = Date.now()): Promise<GameView[]> {
    const before = new Date(now - PROMPT_AFTER_DAYS * 86_400_000);
    const rows = await this.prisma.userGame.findMany({ where: { userId: user.id, status: 'PLAYING', lastPlayedAt: { lt: before } }, orderBy: { lastPlayedAt: 'asc' } });
    return rows.filter((r) => !r.promptedAt || r.promptedAt < r.lastPlayedAt).map(toGameView);
  }

  async markPrompted(user: User, id: string): Promise<void> {
    const row = await this.own(user, id);
    await this.prisma.userGame.update({ where: { id: row.id }, data: { promptedAt: new Date() } });
  }

  private async own(user: User, id: string): Promise<UserGame> {
    const row = await this.prisma.userGame.findUnique({ where: { id } });
    if (!row || row.userId !== user.id) throw Errors.notFound('Game');
    return row;
  }
}
