import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '../db/prisma.js';
import type { PresenceStatus } from '../generated/prisma/client.js';
import type { GameHistoryService } from './game-history.js';
import { CLIENT_PLATFORMS, type ActivityView, type ClientPlatform, type CustomStatusView, type PresenceState, type PresenceView } from '../realtime/events.js';

/** 0.5.1: how long a closed client's platform icon stays (reconnects, reloads, app resume). */
export const PLATFORM_GRACE_MS = 5000;

/** What a user chose, cached in memory (source of truth: the users table). */
interface Preference {
  status: PresenceStatus;
  customText: string | null;
  customExpiresAt: Date | null;
  /** 0.4.0 */
  customEmoji: string | null;
}

interface Connection {
  /** The client reported no input for a while (desktop idle detection). */
  idle: boolean;
  activity: ActivityView | null;
  /** When the activity was set; the newest activity across connections wins. */
  activityAt: number;
  /** 0.5.1 */
  platform: ClientPlatform;
}

/**
 * Tracks live realtime connections per user (in memory, single backend process) and derives the
 * presence everyone else sees:
 *
 * - offline: no connection, or the user chose Invisible (they stay connected but look offline;
 *   their activity and custom status are not shown and lastSeenAt is not advanced while invisible);
 * - dnd / away: chosen by the user;
 * - away: also automatically when every connection of an Online user reports being idle;
 * - online otherwise.
 *
 * Game activity is transient: it lives only in memory with the connection that reported it.
 * Events are only broadcast when the public view actually changes, so going invisible looks
 * exactly like disconnecting.
 */
export class PresenceService {
  private readonly connections = new Map<string, Map<string, Connection>>();
  private readonly prefs = new Map<string, Preference>();
  /** 0.5.1: platforms of connections that just closed, kept for PLATFORM_GRACE_MS. */
  private readonly lingering = new Map<string, Map<ClientPlatform, ReturnType<typeof setTimeout>>>();
  /** 0.5.1: changes that happen later (a lingering platform expiring); set by the gateway. */
  onLateChange: ((change: PresenceView) => void) | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
    /** 0.5.5: game sessions for "Recently played" (not recorded while invisible). */
    private readonly games: GameHistoryService | null = null,
  ) {}

  private recordGames(userId: string, previous: ActivityView | null, next: ActivityView | null): void {
    if (!this.games || this.prefs.get(userId)?.status === 'INVISIBLE') return;
    if (previous && previous.name !== next?.name) this.games.ended(userId, previous);
    if (next && next.name !== previous?.name) this.games.started(userId, next);
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Returns the presence change to broadcast, or null when nothing visible changed. */
  async connect(userId: string, connectionId: string, platform: ClientPlatform = 'web'): Promise<PresenceView | null> {
    const pref = await this.loadPreference(userId);
    const before = this.view(userId, null);
    let set = this.connections.get(userId);
    if (!set) {
      set = new Map();
      this.connections.set(userId, set);
    }
    set.set(connectionId, { idle: false, activity: null, activityAt: 0, platform });
    this.clearLingering(userId, platform);
    const lastSeenAt = pref.status === 'INVISIBLE' ? null : await this.touch(userId);
    return this.changed(before, this.view(userId, lastSeenAt));
  }

  /** Returns the presence change to broadcast, or null when nothing visible changed. */
  async disconnect(userId: string, connectionId: string): Promise<PresenceView | null> {
    const set = this.connections.get(userId);
    if (!set?.has(connectionId)) return null;
    const before = this.view(userId, null);
    const closed = set.get(connectionId)?.platform;
    this.recordGames(userId, set.get(connectionId)?.activity ?? null, null);
    set.delete(connectionId);
    // The platform icon stays a moment unless another connection of that kind is still there.
    if (closed && set.size > 0 && ![...set.values()].some((c) => c.platform === closed)) this.linger(userId, closed);
    let lastSeenAt: string | null = null;
    if (set.size === 0) {
      this.clearLingering(userId);
      this.connections.delete(userId);
      if (this.prefs.get(userId)?.status !== 'INVISIBLE') lastSeenAt = await this.touch(userId);
    }
    return this.changed(before, this.view(userId, lastSeenAt));
  }

  /** Desktop idle detection of one connection. */
  setIdle(userId: string, connectionId: string, idle: boolean): PresenceView | null {
    const conn = this.connections.get(userId)?.get(connectionId);
    if (!conn || conn.idle === idle) return null;
    const before = this.view(userId, null);
    conn.idle = idle;
    return this.changed(before, this.view(userId, null));
  }

  /** Game activity reported by one connection (desktop app); null clears it. */
  setActivity(userId: string, connectionId: string, activity: ActivityView | null): PresenceView | null {
    const conn = this.connections.get(userId)?.get(connectionId);
    if (!conn) return null;
    const before = this.view(userId, null);
    const now = Date.now();
    // 0.4.1 game timer: none -> game and game A -> game B start a new session; the same game
    // reported again (re-scan, reconnect) keeps the earlier start unless the client knows better.
    if (activity) {
      const same = conn.activity?.name === activity.name;
      const startedAt = activity.startedAt ?? (same ? conn.activity?.startedAt : undefined) ?? new Date(now).toISOString();
      activity = { ...activity, startedAt, steamAppId: activity.steamAppId ?? (same ? conn.activity?.steamAppId : null) ?? null };
      if (same && conn.activity?.startedAt === activity.startedAt && conn.activity?.steamAppId === activity.steamAppId) return null;
    }
    this.recordGames(userId, conn.activity, activity);
    conn.activity = activity;
    conn.activityAt = now;
    return this.changed(before, this.view(userId, null));
  }

  /** The user's own choice (REST). Persists it and returns the change to broadcast, if any. */
  async setPreference(
    userId: string,
    input: { status?: PresenceStatus; customStatus?: { text: string; expiresAt: Date | null; emoji?: string | null } | null },
  ): Promise<{ preference: Preference; change: PresenceView | null }> {
    const current = await this.loadPreference(userId);
    const before = this.view(userId, null);
    const next: Preference = {
      status: input.status ?? current.status,
      customText: input.customStatus === undefined ? current.customText : (input.customStatus?.text ?? null),
      customExpiresAt: input.customStatus === undefined ? current.customExpiresAt : (input.customStatus?.expiresAt ?? null),
      customEmoji: input.customStatus === undefined ? current.customEmoji : (input.customStatus?.emoji ?? null),
    };
    const goingInvisible = current.status !== 'INVISIBLE' && next.status === 'INVISIBLE';
    const leavingInvisible = current.status === 'INVISIBLE' && next.status !== 'INVISIBLE';
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        presenceStatus: next.status,
        customStatusText: next.customText,
        customStatusExpiresAt: next.customExpiresAt,
        customStatusEmoji: next.customEmoji,
        // Last time others saw them = the moment they went invisible / came back.
        ...((goingInvisible || leavingInvisible) && this.isOnline(userId) ? { lastSeenAt: new Date() } : {}),
      },
    });
    this.prefs.set(userId, next);
    let lastSeenAt: string | null = null;
    if (goingInvisible || leavingInvisible) {
      const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { lastSeenAt: true } });
      lastSeenAt = row?.lastSeenAt?.toISOString() ?? null;
    }
    return { preference: next, change: this.changed(before, this.view(userId, lastSeenAt)) };
  }

  async getPreference(userId: string): Promise<Preference> {
    return this.loadPreference(userId);
  }

  /** Clears custom statuses whose time is up; returns the changes to broadcast. */
  async expireCustomStatuses(now = new Date()): Promise<PresenceView[]> {
    const expired = await this.prisma.user.findMany({
      where: { customStatusExpiresAt: { lte: now } },
      select: { id: true },
    });
    const changes: PresenceView[] = [];
    for (const { id } of expired) {
      const { change } = await this.setPreference(id, { customStatus: null });
      if (change) changes.push(change);
    }
    return changes;
  }

  /** Presence of every enabled user. */
  async snapshot(): Promise<PresenceView[]> {
    const users = await this.prisma.user.findMany({
      where: { disabled: false },
      select: { id: true, lastSeenAt: true, presenceStatus: true, customStatusText: true, customStatusExpiresAt: true, customStatusEmoji: true },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => {
      this.prefs.set(u.id, { status: u.presenceStatus, customText: u.customStatusText, customExpiresAt: u.customStatusExpiresAt, customEmoji: u.customStatusEmoji });
      return this.view(u.id, u.lastSeenAt?.toISOString() ?? null);
    });
  }

  /** Called periodically so lastSeenAt stays fresh for users who stay connected for days (not while invisible). */
  async refreshOnlineUsers(): Promise<void> {
    const ids = this.onlineUserIds().filter((id) => this.prefs.get(id)?.status !== 'INVISIBLE');
    if (ids.length === 0) return;
    await this.prisma.user.updateMany({ where: { id: { in: ids } }, data: { lastSeenAt: new Date() } });
  }

  // ---- internals ----------------------------------------------------------------

  /** Public view. `lastSeenAt` null = unknown here (the comparison ignores it). */
  private view(userId: string, lastSeenAt: string | null): PresenceView {
    const pref = this.prefs.get(userId) ?? { status: 'ONLINE', customText: null, customExpiresAt: null, customEmoji: null };
    const conns = [...(this.connections.get(userId)?.values() ?? [])];
    const connected = conns.length > 0;
    let state: PresenceState = 'offline';
    if (connected && pref.status !== 'INVISIBLE') {
      if (pref.status === 'DND') state = 'dnd';
      else if (pref.status === 'AWAY' || conns.every((c) => c.idle)) state = 'away';
      else state = 'online';
    }
    const visible = state !== 'offline';
    const custom: CustomStatusView | null =
      visible && pref.customText && (!pref.customExpiresAt || pref.customExpiresAt.getTime() > Date.now())
        ? { text: pref.customText, expiresAt: pref.customExpiresAt?.toISOString() ?? null, emoji: pref.customEmoji }
        : null;
    let activity: ActivityView | null = null;
    if (visible) {
      let newest = -1;
      for (const c of conns) {
        if (c.activity && c.activityAt > newest) {
          activity = c.activity;
          newest = c.activityAt;
        }
      }
    }
    const active = new Set<ClientPlatform>(conns.map((c) => c.platform));
    for (const p of this.lingering.get(userId)?.keys() ?? []) active.add(p);
    return {
      userId,
      // `status` keeps its 0.2.x meaning (online/offline) so older clients keep working.
      status: visible ? 'online' : 'offline',
      state,
      lastSeenAt,
      customStatus: custom,
      activity,
      platforms: visible ? CLIENT_PLATFORMS.filter((p) => active.has(p)) : [],
    };
  }

  private linger(userId: string, platform: ClientPlatform): void {
    let map = this.lingering.get(userId);
    if (!map) {
      map = new Map();
      this.lingering.set(userId, map);
    }
    const existing = map.get(platform);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const before = this.view(userId, null);
      this.clearLingering(userId, platform);
      const change = this.changed(before, this.view(userId, null));
      if (change) this.onLateChange?.(change);
    }, PLATFORM_GRACE_MS);
    timer.unref();
    map.set(platform, timer);
  }

  private clearLingering(userId: string, platform?: ClientPlatform): void {
    const map = this.lingering.get(userId);
    if (!map) return;
    for (const [p, timer] of map) {
      if (platform && p !== platform) continue;
      clearTimeout(timer);
      map.delete(p);
    }
    if (map.size === 0) this.lingering.delete(userId);
  }

  /** Stops pending grace timers (shutdown). */
  dispose(): void {
    for (const map of this.lingering.values()) for (const timer of map.values()) clearTimeout(timer);
    this.lingering.clear();
  }

  private changed(before: PresenceView, after: PresenceView): PresenceView | null {
    // lastSeenAt alone is not a visible change (it would also leak an invisible user's activity).
    const key = (v: PresenceView) => JSON.stringify({ ...v, lastSeenAt: null });
    return key(before) === key(after) ? null : after;
  }

  private async loadPreference(userId: string): Promise<Preference> {
    const cached = this.prefs.get(userId);
    if (cached) return cached;
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { presenceStatus: true, customStatusText: true, customStatusExpiresAt: true, customStatusEmoji: true },
    });
    const pref: Preference = {
      status: row?.presenceStatus ?? 'ONLINE',
      customText: row?.customStatusText ?? null,
      customExpiresAt: row?.customStatusExpiresAt ?? null,
      customEmoji: row?.customStatusEmoji ?? null,
    };
    this.prefs.set(userId, pref);
    return pref;
  }

  private async touch(userId: string): Promise<string> {
    const now = new Date();
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { lastSeenAt: now } });
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to update lastSeenAt');
    }
    return now.toISOString();
  }
}
