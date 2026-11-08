import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { ActivityView } from '../realtime/events.js';

/** A session longer than this is cut (a stuck process must not add days). */
const MAX_SESSION_SECONDS = 48 * 3600;
/** Shorter launches (a crash, a launcher) count for "last played" but not for the play time. */
const MIN_SESSION_SECONDS = 60;

export function gameKey(name: string): string {
  return name.trim().toLowerCase().slice(0, 160);
}

/**
 * Game sessions from the desktop's game activity (feeds the game tracker, games/games.service.ts) (which only exists when
 * the user shares it). A game becomes "last played" when it starts, its play time is added when it
 * ends. Failures are logged and never affect presence.
 */
export class GameHistoryService {
  /** Told when a person's game list changed (a new game, more play time). */
  onChanged: ((userId: string) => void) | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  started(userId: string, activity: ActivityView): void {
    const key = gameKey(activity.name);
    if (!key) return;
    const name = activity.name.trim().slice(0, 128);
    const steamAppId = activity.steamAppId ?? null;
    void (async () => {
      const existing = await this.prisma.userGame.findUnique({ where: { userId_gameKey: { userId, gameKey: key } } });
      if (existing) {
        // A game added by hand keeps its name, platform and status; launching it only counts.
        await this.prisma.userGame.update({ where: { id: existing.id }, data: { lastPlayedAt: new Date(), ...(existing.manual ? {} : { name }), ...(steamAppId ? { steamAppId } : {}) } });
      } else {
        await this.prisma.userGame.create({ data: { userId, gameKey: key, name, steamAppId } });
      }
      this.onChanged?.(userId);
    })().catch((error: unknown) => {
      this.fail('start', error);
    });
  }

  ended(userId: string, activity: ActivityView, endedAt = Date.now()): void {
    const key = gameKey(activity.name);
    if (!key) return;
    const startedAt = activity.startedAt ? Date.parse(activity.startedAt) : NaN;
    const seconds = Number.isFinite(startedAt) ? Math.min(MAX_SESSION_SECONDS, Math.max(0, Math.round((endedAt - startedAt) / 1000))) : 0;
    const counted = seconds >= MIN_SESSION_SECONDS;
    void this.prisma.userGame
      .upsert({
        where: { userId_gameKey: { userId, gameKey: key } },
        create: { userId, gameKey: key, name: activity.name.trim().slice(0, 128), steamAppId: activity.steamAppId ?? null, totalSeconds: counted ? seconds : 0, sessions: counted ? 1 : 0 },
        update: { lastPlayedAt: new Date(endedAt), ...(counted ? { totalSeconds: { increment: seconds }, sessions: { increment: 1 } } : {}) },
      })
      .then(() => {
        if (counted) this.onChanged?.(userId);
      })
      .catch((error: unknown) => {
        this.fail('end', error);
      });
  }

  private fail(step: string, error: unknown): void {
    this.log.warn({ event: 'game_history.failed', step, reason: error instanceof Error ? error.message : 'error' }, 'Game history update failed');
  }
}
