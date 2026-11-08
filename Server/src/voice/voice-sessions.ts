import type { FastifyBaseLogger } from 'fastify';
import type { VoiceParticipantView } from './voice.service.js';

/** One active voice channel: when it became occupied, and who is in it right now. */
export interface VoiceSessionView {
  channelId: string;
  /** Set when the channel went from 0 to 1 participant; null = empty (the event that ends a session). */
  startedAt: string | null;
  participants: VoiceParticipantView[];
}

/** 0.4.2 explicit membership changes (realtime voice.participant.joined / left / moved). */
export type VoiceMemberEvent =
  | { type: 'joined'; channelId: string; participant: VoiceParticipantView }
  | { type: 'left'; channelId: string; userId: string }
  | { type: 'moved'; fromChannelId: string; channelId: string; participant: VoiceParticipantView };

/** What the tracker needs from LiveKit (VoiceService implements it; tests pass a fake). */
export interface VoiceRoomSource {
  /** Participants of one channel's room ([] when the room does not exist). Throws when LiveKit is unreachable. */
  listParticipants(channelId: string): Promise<VoiceParticipantView[]>;
  /** Channel ids whose LiveKit room has at least one participant. Throws when LiveKit is unreachable. */
  occupiedChannels(): Promise<string[]>;
}

const SWEEP_MS = 10_000;
const REFRESH_DEBOUNCE_MS = 400;

/**
 * 0.4.1 voice session timer, server-authoritative and in memory only (nothing is written to the
 * database, nothing every second):
 *
 * - LiveKit is the source of truth for who is in a room. The tracker refreshes one room right
 *   after something happens there (a token was issued, a client says it joined or left, a
 *   moderator moved or disconnected someone) and sweeps all rooms with one `listRooms` call every
 *   10 s to catch crashes and lost connections.
 * - `startedAt` is set when a channel goes from 0 to 1 participant and cleared when it becomes
 *   empty. It is the earliest LiveKit `joinedAt` of the people inside, so a late refresh still
 *   gives the right time.
 * - After a backend restart the map is empty; the first sweep rebuilds it from LiveKit using the
 *   participants' `joinedAt`. If the first person already left and others stayed, the timer starts
 *   at the earliest join among those still inside (documented; accepted by the spec).
 *
 * Clients get `voice.session` events (one channel) and compute elapsed time themselves.
 */
export class VoiceSessionTracker {
  private readonly sessions = new Map<string, { startedAt: string; participants: VoiceParticipantView[] }>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly source: VoiceRoomSource,
    private readonly emit: (session: VoiceSessionView) => void,
    private readonly log: FastifyBaseLogger,
    /** 0.4.2: explicit joined / left / moved events (optional). */
    private readonly onMember?: (event: VoiceMemberEvent) => void,
  ) {}

  start(): void {
    if (this.sweepTimer) return;
    void this.sweep();
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Active sessions (sent after `ready`; the gateway filters them by what the user may see). */
  snapshot(): VoiceSessionView[] {
    return [...this.sessions.entries()].map(([channelId, s]) => ({ channelId, startedAt: s.startedAt, participants: s.participants }));
  }

  /** Something happened in this channel: re-read it from LiveKit soon (coalesces bursts). */
  touch(channelId: string, delayMs = REFRESH_DEBOUNCE_MS): void {
    const existing = this.pending.get(channelId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(channelId);
      void this.refresh(channelId);
    }, delayMs);
    timer.unref();
    this.pending.set(channelId, timer);
  }

  /** Reads one room from LiveKit and applies it. */
  async refresh(channelId: string): Promise<void> {
    try {
      this.apply(channelId, await this.source.listParticipants(channelId));
    } catch (error) {
      // LiveKit unreachable: keep what we know; the sweep tries again.
      this.log.debug({ err: error, channelId }, 'Voice session refresh failed');
    }
  }

  /** 0.5.5: the voice channel a user is in right now (canonical membership), or null. */
  channelOf(userId: string): string | null {
    for (const [channelId, session] of this.sessions) if (session.participants.some((p) => p.identity === userId)) return channelId;
    return null;
  }

  /** Every room at once: new occupied rooms are read, rooms that emptied are closed. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const occupied = new Set(await this.source.occupiedChannels());
      for (const channelId of [...this.sessions.keys()]) if (!occupied.has(channelId)) this.apply(channelId, []);
      // Rooms we already track are re-read too: the sweep is the safety net for missed joins/leaves.
      for (const channelId of occupied) await this.refresh(channelId);
    } catch (error) {
      this.log.debug({ err: error }, 'Voice session sweep failed');
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Applies a fresh participant list; emits only when something visible changed.
   *
   * 0.4.2: membership is keyed by the stable AIDis user id (LiveKit identity). A user is in at most
   * one voice channel: if a refreshed room lists someone the tracker still has in another channel
   * (that room was not re-read yet), they are moved, not duplicated. Duplicate identities inside
   * one room collapse into one entry. Joined / left / moved events are emitted for every real change.
   */
  apply(channelId: string, participants: VoiceParticipantView[]): void {
    const byId = new Map<string, VoiceParticipantView>();
    for (const p of participants) byId.set(p.identity, p);
    const sorted = [...byId.values()].sort((a, b) => a.identity.localeCompare(b.identity));
    const current = this.sessions.get(channelId);
    const before = new Set((current?.participants ?? []).map((p) => p.identity));

    // Someone listed here is still in another channel in our map: that is a move.
    const movedFrom = new Map<string, string>();
    for (const p of sorted) {
      if (before.has(p.identity)) continue;
      for (const [otherId, other] of this.sessions) {
        if (otherId === channelId || !other.participants.some((q) => q.identity === p.identity)) continue;
        movedFrom.set(p.identity, otherId);
        this.replace(otherId, other.participants.filter((q) => q.identity !== p.identity));
      }
    }

    this.replace(channelId, sorted);

    const after = new Set(sorted.map((p) => p.identity));
    for (const p of sorted) {
      if (before.has(p.identity)) continue;
      const from = movedFrom.get(p.identity);
      this.member(from ? { type: 'moved', fromChannelId: from, channelId, participant: p } : { type: 'joined', channelId, participant: p });
    }
    for (const id of before) if (!after.has(id)) this.member({ type: 'left', channelId, userId: id });
  }

  /** Sets one channel's list and emits its voice.session when it changed. */
  private replace(channelId: string, sorted: VoiceParticipantView[]): void {
    const current = this.sessions.get(channelId);
    if (sorted.length === 0) {
      if (!current) return;
      this.sessions.delete(channelId);
      this.emit({ channelId, startedAt: null, participants: [] });
      return;
    }
    if (current) {
      if (sameParticipants(current.participants, sorted)) return;
      current.participants = sorted;
      this.emit({ channelId, startedAt: current.startedAt, participants: sorted });
      return;
    }
    // 0 -> 1: the session starts with the earliest join LiveKit knows about.
    const joins = sorted.map((p) => (p.joinedAt ? Date.parse(p.joinedAt) : NaN)).filter((t) => Number.isFinite(t) && t <= Date.now());
    const startedAt = new Date(joins.length > 0 ? Math.min(...joins) : Date.now()).toISOString();
    this.sessions.set(channelId, { startedAt, participants: sorted });
    this.emit({ channelId, startedAt, participants: sorted });
  }

  private member(event: VoiceMemberEvent): void {
    this.onMember?.(event);
  }
}

function sameParticipants(a: VoiceParticipantView[], b: VoiceParticipantView[]): boolean {
  return a.length === b.length && a.every((p, i) => {
      const q = b[i];
      return q !== undefined && p.identity === q.identity && p.name === q.name;
    });
}
