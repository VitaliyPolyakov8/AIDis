import { create } from 'zustand';
import { ConnectionState, RoomEvent, Track, type Participant, type Room } from 'livekit-client';

const TOPIC = 'aidis.stream.interactions.v1';
const MAX_BYTES = 768;
const TOKEN = /^[A-Za-z0-9_-]{1,80}$/;
export type StreamReactionKind = 'laugh' | 'clap' | 'f';
interface HintBase { id: string; at: number; expiresAt: number; owner: string; sender: string }
export type PointerMarker = HintBase & { type: 'pointer'; x: number; y: number };
export type StreamReaction = HintBase & { type: 'reaction'; reaction: StreamReactionKind };
export type OwnStreamHint = PointerMarker | StreamReaction;
export interface InteractionStream { sid: string; generation: string | null; pointers: boolean; seq: number }
interface State { streams: Record<string, InteractionStream>; pointers: PointerMarker[]; reactions: StreamReaction[] }
const EMPTY: State = { streams: {}, pointers: [], reactions: [] };
export const useStreamInteractions = create<State>(() => EMPTY);
const listeners = new Set<(hint: OwnStreamHint | null) => void>();
/** Null clears previously forwarded native hints on consent/source/session changes. */
export function subscribeOwnStreamHints(callback: (hint: OwnStreamHint | null) => void): () => void {
  listeners.add(callback); return () => { listeners.delete(callback); };
}
function notify(hint: OwnStreamHint | null): void { for (const cb of listeners) { try { cb(hint); } catch { /* optional overlay */ } } }

export interface VideoRect { left: number; top: number; width: number; height: number }
export function videoContentRect(rect: VideoRect, width: number, height: number): VideoRect | null {
  if (![rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  return { left: rect.left + (rect.width - width * scale) / 2, top: rect.top + (rect.height - height * scale) / 2, width: width * scale, height: height * scale };
}
export function normaliseVideoPoint(rect: VideoRect, width: number, height: number, clientX: number, clientY: number): { x: number; y: number } | null {
  const content = videoContentRect(rect, width, height);
  if (!content || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
function reaction(value: unknown): value is StreamReactionKind { return value === 'laugh' || value === 'clap' || value === 'f'; }
function token(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
function point(x: unknown, y: unknown): boolean { return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1; }
let active: Session | null = null;

class Session {
  private streams: Record<string, InteractionStream> = {};
  private signatures = new Map<string, string>();
  private seen = new Map<string, number>();
  private rates = new Map<string, number[]>();
  private seq = 0;
  private disposed = false;
  private roomName: string;
  private room: Room;
  private timer: ReturnType<typeof setInterval>;
  private bound: { event: RoomEvent; fn: (...args: never[]) => void }[] = [];
  constructor(room: Room) {
    this.room = room;
    this.roomName = room.name;
    this.on(RoomEvent.DataReceived, this.receive);
    for (const event of [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ParticipantDisconnected]) this.on(event, this.refresh);
    for (const event of [RoomEvent.Connected, RoomEvent.Reconnected, RoomEvent.ParticipantConnected]) this.on(event, this.sync);
    this.on(RoomEvent.Moved, this.moved); this.on(RoomEvent.Disconnected, this.clear);
    this.timer = setInterval(() => { this.refresh(); this.expire(); }, 250);
    this.refresh(); this.publish({ type: 'sync' }, true);
  }
  private on(event: RoomEvent, fn: (...args: never[]) => void): void { this.room.on(event, fn); this.bound.push({ event, fn }); }
  private me(): string { return this.room.localParticipant.identity; }
  private clear = (): void => { this.streams = {}; this.signatures.clear(); this.seen.clear(); this.rates.clear(); useStreamInteractions.setState(EMPTY); notify(null); };
  private moved = (): void => { this.clear(); this.roomName = this.room.name; this.refresh(); this.publish({ type: 'sync' }, true); };
  private sync = (): void => { this.refresh(); this.announce(); this.publish({ type: 'sync' }, true); };
  private publish(body: Record<string, unknown>, reliable: boolean, destination?: string): boolean {
    if (this.disposed || this.room.state !== ConnectionState.Connected) return false;
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, id: crypto.randomUUID(), at: Date.now(), ...body }));
    if (payload.byteLength > MAX_BYTES) return false;
    try { void this.room.localParticipant.publishData(payload, { reliable, topic: TOPIC, ...(destination ? { destinationIdentities: [destination] } : {}) }).catch(() => undefined); return true; } catch { return false; }
  }
  private announce(destination?: string): void {
    const own = this.streams[this.me()]; if (!own) return;
    const state = { ...own, seq: ++this.seq };
    this.streams = { ...this.streams, [this.me()]: state }; useStreamInteractions.setState({ streams: this.streams });
    this.publish({ type: 'state', ...state }, true, destination);
  }
  private refresh = (): void => {
    if (this.disposed) return;
    if (this.room.state !== ConnectionState.Connected) { if (Object.keys(this.streams).length) this.clear(); return; }
    if (this.roomName !== this.room.name) { this.moved(); return; }
    const next: Record<string, InteractionStream> = {};
    const signatures = new Map<string, string>();
    const changed = new Set<string>(); let localChanged = false;
    for (const member of [this.room.localParticipant, ...this.room.remoteParticipants.values()]) {
      const pub = member.getTrackPublication(Track.Source.ScreenShare);
      if (!pub || !member.identity || pub.track?.mediaStreamTrack.readyState === 'ended') continue;
      const local = member === this.room.localParticipant;
      const signature = `${pub.trackSid}:${local ? pub.track?.mediaStreamTrack.id ?? '' : ''}`;
      signatures.set(member.identity, signature);
      const old = this.streams[member.identity];
      if (old && this.signatures.get(member.identity) === signature) next[member.identity] = old;
      else { next[member.identity] = { sid: pub.trackSid, generation: local ? crypto.randomUUID() : null, pointers: false, seq: 0 }; changed.add(member.identity); if (local) localChanged = true; }
    }
    for (const owner of Object.keys(this.streams)) if (!next[owner]) changed.add(owner);
    this.signatures = signatures;
    if (!changed.size) return;
    this.streams = next;
    useStreamInteractions.setState((s) => ({ streams: next, pointers: s.pointers.filter((h) => !changed.has(h.owner)), reactions: s.reactions.filter((h) => !changed.has(h.owner)) }));
    if (changed.has(this.me())) notify(null);
    if (localChanged) this.announce();
  };
  private expire(): void {
    const now = Date.now(); const s = useStreamInteractions.getState();
    const pointers = s.pointers.filter((h) => h.expiresAt > now); const reactions = s.reactions.filter((h) => h.expiresAt > now);
    if (pointers.length !== s.pointers.length || reactions.length !== s.reactions.length) useStreamInteractions.setState({ pointers, reactions });
    for (const [key, at] of this.seen) if (at < now - 5000) this.seen.delete(key);
    for (const [key, times] of this.rates) if (times.every((at) => at <= now - 1000)) this.rates.delete(key);
  }
  private allow(sender: string, type: string, max: number): boolean {
    const key = `${sender}:${type}`; const now = Date.now(); const times = (this.rates.get(key) ?? []).filter((at) => at > now - 1000);
    if (times.length >= max) return false; this.rates.set(key, [...times, now]); return true;
  }
  private remember(sender: string, id: string): boolean {
    const key = `${sender}:${id}`; if (this.seen.has(key)) return false; this.seen.set(key, Date.now());
    while (this.seen.size > 512) { const first = this.seen.keys().next().value; if (first === undefined) break; this.seen.delete(first); } return true;
  }
  private receive = (payload: Uint8Array, member?: Participant, _kind?: unknown, topic?: string): void => {
    if (this.disposed || this.room.state !== ConnectionState.Connected || !member || this.room.remoteParticipants.get(member.identity) !== member || payload.byteLength > MAX_BYTES || (topic !== TOPIC && topic !== 'aidis.stream')) return;
    let data: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(new TextDecoder().decode(payload)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return; data = parsed as Record<string, unknown>; } catch { return; }
    this.refresh(); const sender = member.identity; const now = Date.now();
    if (topic === 'aidis.stream') { if (data.type === 'switching') this.revoke(sender, null); return; }
    if (data.v !== 1 || !token(data.id) || typeof data.at !== 'number' || !Number.isSafeInteger(data.at) || data.at < now - 5000 || data.at > now + 1000) return;
    if (data.type === 'sync') { if (this.remember(sender, data.id) && this.allow(sender, 'sync', 1)) this.announce(sender); return; }
    if (data.type === 'state') {
      const owner = this.streams[sender];
      if (!owner || data.sid !== owner.sid || !token(data.generation) || typeof data.pointers !== 'boolean' || typeof data.seq !== 'number' || !Number.isSafeInteger(data.seq) || data.seq <= owner.seq) return;
      if (!this.remember(sender, data.id) || !this.allow(sender, 'state', 10)) return;
      if (owner.generation !== data.generation || !data.pointers) this.revoke(sender, data.generation);
      this.streams = { ...this.streams, [sender]: { ...owner, generation: data.generation, pointers: data.pointers, seq: data.seq } }; useStreamInteractions.setState({ streams: this.streams }); return;
    }
    if ((data.type !== 'pointer' && data.type !== 'reaction') || typeof data.owner !== 'string') return;
    const owner = this.streams[data.owner]; const lifetime = data.type === 'pointer' ? 2000 : 2500;
    if (!owner?.generation || data.sid !== owner.sid || data.generation !== owner.generation || data.at <= now - lifetime) return;
    if (data.type === 'pointer') { if (data.owner !== this.me() || sender === data.owner || !owner.pointers || !point(data.x, data.y)) return; }
    else if (!reaction(data.reaction)) return;
    if (!this.remember(sender, data.id) || !this.allow(sender, data.type, data.type === 'pointer' ? 2 : 3)) return;
    const base = { id: `${sender}:${data.id}`, at: data.at, expiresAt: Math.min(data.at + lifetime, now + lifetime), owner: data.owner, sender };
    this.add(data.type === 'pointer' ? { ...base, type: 'pointer', x: data.x as number, y: data.y as number } : { ...base, type: 'reaction', reaction: data.reaction as StreamReactionKind });
  };
  private add(hint: OwnStreamHint): void {
    if (hint.type === 'pointer') useStreamInteractions.setState((s) => ({ pointers: [...s.pointers, hint].slice(-8) }));
    else useStreamInteractions.setState((s) => ({ reactions: [...s.reactions, hint].slice(-24) }));
    if (hint.owner === this.me()) notify(hint);
  }
  private revoke(owner: string, generation: string | null): void {
    const stream = this.streams[owner]; if (!stream) return;
    this.streams = { ...this.streams, [owner]: { ...stream, generation, pointers: false } };
    useStreamInteractions.setState((s) => ({ streams: this.streams, pointers: s.pointers.filter((h) => h.owner !== owner), reactions: s.reactions.filter((h) => h.owner !== owner) }));
    if (owner === this.me()) notify(null);
  }
  setPointers(enabled: boolean): boolean {
    this.refresh(); const own = this.streams[this.me()]; if (!own || this.room.state !== ConnectionState.Connected) return false;
    if (own.pointers === enabled) return true;
    this.revoke(this.me(), crypto.randomUUID());
    this.streams = { ...this.streams, [this.me()]: { ...own, generation: crypto.randomUUID(), pointers: enabled } }; this.announce(); return true;
  }
  point(owner: string, coordinates: { x: number; y: number }): boolean {
    this.refresh(); const target = this.streams[owner];
    if (!target?.generation || owner === this.me() || !target.pointers || !point(coordinates.x, coordinates.y) || !this.allow(this.me(), 'pointer', 2)) return false;
    return this.publish({ type: 'pointer', owner, sid: target.sid, generation: target.generation, ...coordinates }, false, owner);
  }
  react(owner: string, kind: StreamReactionKind): boolean {
    this.refresh(); const target = this.streams[owner];
    if (!target?.generation || !reaction(kind) || this.room.state !== ConnectionState.Connected || !this.allow(this.me(), 'reaction', 3)) return false;
    const id = crypto.randomUUID(); const at = Date.now();
    if (!this.publish({ type: 'reaction', id, at, owner, sid: target.sid, generation: target.generation, reaction: kind }, false)) return false;
    this.remember(this.me(), id); this.add({ type: 'reaction', id: `${this.me()}:${id}`, at, expiresAt: at + 2500, owner, sender: this.me(), reaction: kind }); return true;
  }
  sourceChanged(): void { this.refresh(); this.revoke(this.me(), crypto.randomUUID()); this.announce(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); for (const { event, fn } of this.bound) this.room.off?.(event, fn); this.clear(); }
}

export function bindStreamInteractions(room: Room): () => void {
  active?.dispose(); const session = new Session(room); active = session;
  return () => { session.dispose(); if (active === session) active = null; };
}
export const streamInteractions = {
  setPointers(enabled: boolean): boolean { return active?.setPointers(enabled) ?? false; },
  point(owner: string, coordinates: { x: number; y: number }): boolean { return active?.point(owner, coordinates) ?? false; },
  react(owner: string, kind: StreamReactionKind): boolean { return active?.react(owner, kind) ?? false; },
  sourceChanged(): void { active?.sourceChanged(); },
};
