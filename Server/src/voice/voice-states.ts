/**
 * 0.5.0 realtime voice member state and stream viewers (in server memory, no database).
 *
 * Voice member state: what a client reports about itself while it is in a voice call (microphone
 * muted, deafened, screen stream, camera). The server keeps it per connection and publishes the
 * per-user summary (any connection true = true), so people OUTSIDE the voice channel see the same
 * icons as people inside it, without joining the LiveKit room. LiveKit stays authoritative for the
 * media itself; this is the summary for the channel list.
 *
 * Stream viewers: who watches which stream (streamer + source). A viewer that stops watching (or
 * whose connection drops) stays listed for a short grace period, so reconnects, re-subscribes and
 * pop-out moves do not produce join/leave noise.
 */

export type StreamSource = 'screen' | 'camera';

export interface VoiceMemberFlags {
  muted: boolean;
  deafened: boolean;
  screen: boolean;
  camera: boolean;
}

export interface VoiceMemberState extends VoiceMemberFlags {
  userId: string;
}

const NONE: VoiceMemberFlags = { muted: false, deafened: false, screen: false, camera: false };

function sameFlags(a: VoiceMemberFlags, b: VoiceMemberFlags): boolean {
  return a.muted === b.muted && a.deafened === b.deafened && a.screen === b.screen && a.camera === b.camera;
}

export class VoiceStateRegistry {
  private readonly bySocket = new Map<string, { userId: string; flags: VoiceMemberFlags }>();

  /** The user's summary over all their connections. */
  stateOf(userId: string): VoiceMemberState {
    const out: VoiceMemberState = { userId, ...NONE };
    for (const entry of this.bySocket.values()) {
      if (entry.userId !== userId) continue;
      out.muted ||= entry.flags.muted;
      out.deafened ||= entry.flags.deafened;
      out.screen ||= entry.flags.screen;
      out.camera ||= entry.flags.camera;
    }
    return out;
  }

  /** Stores one connection's flags; returns the user's new summary when it changed, else null. */
  set(socketId: string, userId: string, flags: VoiceMemberFlags): VoiceMemberState | null {
    const before = this.stateOf(userId);
    if (sameFlags(flags, NONE)) this.bySocket.delete(socketId);
    else this.bySocket.set(socketId, { userId, flags: { ...flags } });
    const after = this.stateOf(userId);
    return sameFlags(before, after) ? null : after;
  }

  /** A connection went away. */
  drop(socketId: string): VoiceMemberState | null {
    const entry = this.bySocket.get(socketId);
    if (!entry) return null;
    return this.set(socketId, entry.userId, NONE);
  }

  /** Every user with at least one flag set (the snapshot sent after connecting). */
  snapshot(): VoiceMemberState[] {
    const users = new Set([...this.bySocket.values()].map((e) => e.userId));
    return [...users].map((id) => this.stateOf(id)).filter((s) => !sameFlags(s, NONE));
  }

  clear(): void {
    this.bySocket.clear();
  }
}

export interface StreamViewersEvent {
  streamerId: string;
  source: StreamSource;
  /** Everyone watching right now (user ids, in the order they started watching). */
  viewers: string[];
  /** What changed, when someone started or stopped watching (null for a plain snapshot). */
  change: { userId: string; joined: boolean } | null;
}

/** Who must hear about a stream's viewers: the streamer, the viewers, and whoever just left. */
export type ViewersListener = (event: StreamViewersEvent, audience: string[]) => void;

export const VIEWER_LEAVE_GRACE_MS = 4000;

interface StreamEntry {
  /** viewer user id -> their sockets watching this stream */
  viewers: Map<string, Set<string>>;
  /** viewer user id -> pending "left" timer (still listed during the grace period) */
  leaving: Map<string, ReturnType<typeof setTimeout>>;
}

const keyOf = (streamerId: string, source: StreamSource) => `${streamerId}:${source}`;

export class StreamViewerRegistry {
  private readonly streams = new Map<string, StreamEntry>();

  constructor(
    private readonly listener: ViewersListener,
    private readonly graceMs = VIEWER_LEAVE_GRACE_MS,
  ) {}

  viewersOf(streamerId: string, source: StreamSource): string[] {
    const entry = this.streams.get(keyOf(streamerId, source));
    return entry ? [...entry.viewers.keys()] : [];
  }

  /** A connection started watching. Returns the current list (for the watcher itself). */
  watch(socketId: string, viewerId: string, streamerId: string, source: StreamSource): StreamViewersEvent {
    const key = keyOf(streamerId, source);
    let entry = this.streams.get(key);
    if (!entry) {
      entry = { viewers: new Map(), leaving: new Map() };
      this.streams.set(key, entry);
    }
    const pending = entry.leaving.get(viewerId);
    if (pending) {
      // Back within the grace period (reconnect, re-subscribe): nobody hears anything.
      clearTimeout(pending);
      entry.leaving.delete(viewerId);
    }
    const sockets = entry.viewers.get(viewerId);
    const isNew = !sockets && !pending;
    if (sockets) sockets.add(socketId);
    else entry.viewers.set(viewerId, new Set([socketId]));
    const event: StreamViewersEvent = { streamerId, source, viewers: [...entry.viewers.keys()], change: isNew ? { userId: viewerId, joined: true } : null };
    if (isNew && viewerId !== streamerId) this.listener(event, this.audience(streamerId, entry));
    return event;
  }

  /** A connection stopped watching; the user leaves after the grace period if no other connection watches. */
  unwatch(socketId: string, viewerId: string, streamerId: string, source: StreamSource): void {
    const key = keyOf(streamerId, source);
    const entry = this.streams.get(key);
    const sockets = entry?.viewers.get(viewerId);
    if (!entry || !sockets) return;
    sockets.delete(socketId);
    if (sockets.size > 0 || entry.leaving.has(viewerId)) return;
    const timer = setTimeout(() => {
      entry.leaving.delete(viewerId);
      const still = entry.viewers.get(viewerId);
      if (still && still.size > 0) return;
      entry.viewers.delete(viewerId);
      const event: StreamViewersEvent = { streamerId, source, viewers: [...entry.viewers.keys()], change: { userId: viewerId, joined: false } };
      if (entry.viewers.size === 0 && entry.leaving.size === 0) this.streams.delete(key);
      if (viewerId !== streamerId) this.listener(event, [...this.audience(streamerId, entry), viewerId]);
    }, this.graceMs);
    timer.unref();
    entry.leaving.set(viewerId, timer);
  }

  /** A connection went away: it stops watching everything (each with the grace period). */
  dropSocket(socketId: string, viewerId: string): void {
    for (const [key, entry] of [...this.streams]) {
      if (!entry.viewers.get(viewerId)?.has(socketId)) continue;
      const split = key.lastIndexOf(':');
      this.unwatch(socketId, viewerId, key.slice(0, split), key.slice(split + 1) as StreamSource);
    }
  }

  /** The stream itself ended: its viewer list is cleared without join/leave sounds. */
  endStream(streamerId: string, source: StreamSource): void {
    const key = keyOf(streamerId, source);
    const entry = this.streams.get(key);
    if (!entry) return;
    for (const timer of entry.leaving.values()) clearTimeout(timer);
    const audience = this.audience(streamerId, entry);
    this.streams.delete(key);
    this.listener({ streamerId, source, viewers: [], change: null }, audience);
  }

  clear(): void {
    for (const entry of this.streams.values()) for (const timer of entry.leaving.values()) clearTimeout(timer);
    this.streams.clear();
  }

  private audience(streamerId: string, entry: StreamEntry): string[] {
    return [...new Set([streamerId, ...entry.viewers.keys()])];
  }
}
