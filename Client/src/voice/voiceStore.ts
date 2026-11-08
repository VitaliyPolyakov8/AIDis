import { create } from 'zustand';
import type { VoiceParticipantView, VoiceSessionView } from '../api/types';
import type { RoomPoint } from './channelVoice';
import type { ConnectionStats } from './connectionStats';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type ConnectionQualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface VoiceParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  micMuted: boolean;
  /** Publishing a screen-share video track. */
  screenSharing: boolean;
  /** Their screen share also carries sound (game / system audio). */
  screenShareAudio?: boolean;
  /** 0.5.0: publishing a camera (webcam) video track. */
  camera?: boolean;
  /** LiveKit reports this remote participant's connection as lost (they may still come back). */
  connectionLost?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  channelId: string | null;
  error: string | null;
  /** The user's intent; persists between calls like Discord's mute button. */
  micEnabled: boolean;
  deafened: boolean;
  /** Mic state to restore when undeafening. */
  micBeforeDeafen: boolean;
  micError: string | null;
  participants: VoiceParticipant[];
  localScreenSharing: boolean;
  /** Identity whose screen share is shown in the main stream view. */
  focusedShare: string | null;
  /**
   * 0.4.5 Discord-like streams: the shares this device is watching (identities, in the order they
   * were opened). Nobody is watched automatically; video (and stream audio) is only subscribed for
   * these. focusedShare is the big one when several are watched (null = equal grid).
   */
  watchedShares: string[];
  /** Only this remote screen's audio plays; null silences stream audio (voices are separate). */
  audioShare: string | null;
  /** Name of the presenter whose share just ended (for the "stream ended" state). */
  endedShare: string | null;
  quality: ConnectionQualityLevel;
  /** Live WebRTC stats of our voice connection (RTT, loss, transport); null when unknown. */
  stats: ConnectionStats | null;
  /** Autoplay policy blocked remote audio until a user gesture. */
  audioBlocked: boolean;
  /** Push-to-talk input mode (desktop only). */
  pttMode: boolean;
  /** The push-to-talk key is held (or within its release delay): the mic is transmitting. */
  pttActive: boolean;
  /**
   * Is input volume + sensitivity applied to what LiveKit sends? "bypassed" = the processing
   * pipeline could not start, the raw microphone is sent (the UI warns). "off" = no mic track.
   */
  micPipeline: 'off' | 'active' | 'bypassed';
  /** Who is in each voice channel. Live from LiveKit for our channel, polled for the others. */
  occupancy: Record<string, VoiceParticipantView[]>;
  /** When each channel's occupancy last came from the live room (ms); older polls must not override it. */
  occupancyLiveAt: Record<string, number>;
  occupancyAvailable: boolean;
  /** 0.4.1: the server pushes voice occupancy (voice.sessions / voice.session); polling is off. */
  occupancyRealtime: boolean;
  /** 0.4.1: channel id -> when its voice session started (ISO). Elapsed time is computed locally. */
  voiceSessions: Record<string, string>;
  /** 0.4.2: canonical voice membership from the server (occupancy is derived from it). */
  voiceMembers: VoiceMembers;
  /** Users who are deafened right now (from the realtime server; workspace-wide, by user id). */
  deafenedUsers: Record<string, true>;
  /**
   * 0.5.0: every user's voice state as the realtime server reports it (mic muted, deafened, screen
   * stream, camera), so the channel list shows them to people outside that voice channel too.
   */
  memberStates: Record<string, MemberVoiceState>;
  /** 0.5.0: viewers of the streams this device takes part in (stream key -> user ids). */
  streamViewers: Record<string, string[]>;
  /** 0.5.0: last viewer join / leave per stream (for the short "X joined the stream" line). */
  viewerEvents: Record<string, { userId: string; joined: boolean; at: number }>;
  /** 0.5.0: our camera is published. */
  localCamera: boolean;
  /** Our running screen share as it really is (read back from the track and the sender), or null. */
  shareConfig: ShareConfig | null;
  /** Presenter identity -> time they announced a source switch (viewers show a short notice). */
  shareSwitching: Record<string, number>;
  /** 0.5.5 "room" voice channels: where everyone stands (own position included), by identity. */
  roomPositions: Record<string, RoomPoint>;
  /** 0.7.0: server mute / deafen set by moderators, "guildId:userId" -> flags. */
  serverStates: Record<string, { muted: boolean; deafened: boolean }>;
}

export interface ShareConfig {
  sourceId: string | null;
  sourceKind: 'screen' | 'window' | null;
  /** Captured size and frame-rate request as the track reports them. */
  width: number | null;
  height: number | null;
  /** Encoder ceiling actually set on the sender. */
  maxFramerate: number | null;
  maxBitrate: number | null;
  contentMode: 'game' | 'text';
  systemAudio: boolean;
}

export const INITIAL_VOICE_STATE: VoiceState = {
  status: 'idle',
  channelId: null,
  error: null,
  micEnabled: true,
  deafened: false,
  micBeforeDeafen: true,
  micError: null,
  participants: [],
  localScreenSharing: false,
  focusedShare: null,
  watchedShares: [],
  audioShare: null,
  endedShare: null,
  quality: 'unknown',
  stats: null,
  audioBlocked: false,
  pttMode: false,
  pttActive: false,
  micPipeline: 'off',
  occupancy: {},
  occupancyLiveAt: {},
  occupancyAvailable: true,
  occupancyRealtime: false,
  voiceSessions: {},
  voiceMembers: {},
  deafenedUsers: {},
  memberStates: {},
  streamViewers: {},
  viewerEvents: {},
  localCamera: false,
  shareConfig: null,
  shareSwitching: {},
  roomPositions: {},
  serverStates: {},
};

export const useVoiceStore = create<VoiceState>(() => INITIAL_VOICE_STATE);

/** 0.5.0: a user's voice state as the realtime server reports it. */
export interface MemberVoiceState {
  muted: boolean;
  deafened: boolean;
  screen: boolean;
  camera: boolean;
}

// ---- 0.5.0 streams: screen and camera of one person are separate streams -----------------------

export type StreamSource = 'screen' | 'camera';

const CAMERA_SUFFIX = '#camera';

/**
 * Stable key of one stream: the streamer's identity for a screen share (as before 0.5.0, so pop-out
 * windows, volumes and the watch list keep working) and identity + "#camera" for a webcam. A user
 * may publish both at once; they are watched, popped out and listed independently.
 */
export function streamKey(identity: string, source: StreamSource): string {
  return source === 'camera' ? `${identity}${CAMERA_SUFFIX}` : identity;
}

export function parseStreamKey(key: string): { identity: string; source: StreamSource } {
  return key.endsWith(CAMERA_SUFFIX) ? { identity: key.slice(0, -CAMERA_SUFFIX.length), source: 'camera' } : { identity: key, source: 'screen' };
}

export interface StreamRef {
  key: string;
  identity: string;
  source: StreamSource;
  presenter: VoiceParticipant;
}

/** Every live stream in the room (screen before camera for each person). Pure. */
export function liveStreams(participants: readonly VoiceParticipant[]): StreamRef[] {
  const out: StreamRef[] = [];
  for (const p of participants) {
    if (p.screenSharing) out.push({ key: streamKey(p.identity, 'screen'), identity: p.identity, source: 'screen', presenter: p });
    if (p.camera) out.push({ key: streamKey(p.identity, 'camera'), identity: p.identity, source: 'camera', presenter: p });
  }
  return out;
}

/** Applies one voice.state event (null fields = everything off). Pure. */
export function applyMemberState(states: Record<string, MemberVoiceState>, userId: string, next: MemberVoiceState): Record<string, MemberVoiceState> {
  const off = !next.muted && !next.deafened && !next.screen && !next.camera;
  const { [userId]: _old, ...rest } = states;
  return off ? rest : { ...rest, [userId]: next };
}

// ---- pure state transitions (unit-tested) ----------------------------------------

export type MicDeafenState = Pick<VoiceState, 'micEnabled' | 'deafened' | 'micBeforeDeafen'>;

/** Toggling the microphone while deafened also undeafens (otherwise you could talk but not hear). */
/** 0.7.0: what a moderator (or a missing SPEAK permission) holds down on this server. */
export interface VoiceLock {
  muted: boolean;
  deafened: boolean;
}
const NO_LOCK: VoiceLock = { muted: false, deafened: false };

export function nextForMicToggle(state: MicDeafenState, lock: VoiceLock = NO_LOCK): MicDeafenState {
  if (lock.deafened) return { ...state, micEnabled: false, deafened: true };
  if (state.deafened) {
    return { micEnabled: !lock.muted, deafened: false, micBeforeDeafen: true };
  }
  if (lock.muted) return { ...state, micEnabled: false };
  return { ...state, micEnabled: !state.micEnabled };
}

/** Deafen mutes playback and the mic; undeafen restores the mic to what it was. */
export function nextForDeafenToggle(state: MicDeafenState, lock: VoiceLock = NO_LOCK): MicDeafenState {
  if (lock.deafened) return { ...state, micEnabled: false, deafened: true };
  if (state.deafened) {
    return { micEnabled: state.micBeforeDeafen && !lock.muted, deafened: false, micBeforeDeafen: state.micBeforeDeafen };
  }
  return { micEnabled: false, deafened: true, micBeforeDeafen: state.micEnabled };
}

/**
 * 0.4.5: keeps only watched shares that are still live; returns the names of the ones that
 * ended (for the "stream ended" notice). Pure (unit-tested).
 */
export function pruneWatched(participants: readonly VoiceParticipant[], watched: readonly string[]): { watched: string[]; ended: VoiceParticipant[] } {
  // 0.5.0: keys cover screen and camera streams (see streamKey).
  const live = new Set(liveStreams(participants).map((s) => s.key));
  return { watched: watched.filter((key) => live.has(key)), ended: [] };
}

/** Picks which screen share to show: keep the focused one while it exists, else the first remote one. */
export function pickFocusedShare(participants: VoiceParticipant[], current: string | null): string | null {
  const sharing = participants.filter((p) => p.screenSharing);
  if (current && sharing.some((p) => p.identity === current)) return current;
  const remote = sharing.find((p) => !p.isLocal);
  return remote?.identity ?? sharing[0]?.identity ?? null;
}

export type RoomPhase = 'connected' | 'reconnecting';

/**
 * Merges what LiveKit currently reports with what we showed before.
 *
 * - While our own connection is healthy the live list is the truth: someone missing has left,
 *   so they disappear immediately.
 * - While WE are reconnecting, LiveKit tears down its remote participant list (a full reconnect
 *   emits ParticipantDisconnected for everyone) although nobody actually left. During that phase
 *   we keep the previous participants and only refresh the ones LiveKit still knows about. Once
 *   reconnected the next live snapshot removes whoever really left.
 */
export function reconcileParticipants(previous: VoiceParticipant[], live: VoiceParticipant[], phase: RoomPhase): VoiceParticipant[] {
  if (phase === 'connected') return live;
  const byId = new Map(live.map((p) => [p.identity, p]));
  const kept = previous.map((p) => {
    const fresh = byId.get(p.identity);
    if (fresh) return fresh;
    // Unknown during the outage: keep them, but they cannot be speaking right now.
    return { ...p, isSpeaking: false };
  });
  const known = new Set(previous.map((p) => p.identity));
  return [...kept, ...live.filter((p) => !known.has(p.identity))];
}

/** Is this participant deafened? Our own state is local and instant; others come from the realtime server. */
export function isParticipantDeafened(state: Pick<VoiceState, 'deafened' | 'deafenedUsers'>, identity: string, isLocal: boolean): boolean {
  return isLocal ? state.deafened : state.deafenedUsers[identity] === true;
}

export function toOccupancy(participants: VoiceParticipant[]): VoiceParticipantView[] {
  return participants.map((p) => ({ identity: p.identity, name: p.name, joinedAt: null }));
}

/** 0.4.2 canonical voice membership: channel id -> user id -> participant (never arrays, never names). */
export type VoiceMembers = Record<string, Record<string, VoiceParticipantView>>;

type MembershipState = Pick<VoiceState, 'voiceMembers' | 'voiceSessions' | 'channelId' | 'status'>;
type MembershipResult = Pick<VoiceState, 'voiceMembers' | 'occupancy' | 'voiceSessions' | 'occupancyRealtime'>;

function inCallStatus(status: VoiceState['status']): boolean {
  return status === 'connected' || status === 'reconnecting' || status === 'connecting';
}

/** Removes a user from every channel except `keep` (one user is in at most one voice channel). */
function removeEverywhere(members: VoiceMembers, userId: string, keep: string | null): VoiceMembers {
  let next = members;
  for (const [channelId, list] of Object.entries(members)) {
    if (channelId === keep || !(userId in list)) continue;
    const { [userId]: _gone, ...rest } = list;
    next = { ...next, [channelId]: rest };
  }
  return next;
}

/**
 * Derives what the UI shows. We are authoritative about ourselves: while in a call we are listed
 * only under our own channel (the server confirms a moment later), otherwise nowhere.
 */
function finish(state: MembershipState, members: VoiceMembers, voiceSessions: Record<string, string>, selfId: string | null | undefined): MembershipResult {
  let voiceMembers = members;
  if (selfId) voiceMembers = removeEverywhere(voiceMembers, selfId, inCallStatus(state.status) ? state.channelId : null);
  const occupancy: Record<string, VoiceParticipantView[]> = {};
  for (const [channelId, list] of Object.entries(voiceMembers)) {
    occupancy[channelId] = Object.values(list).sort((a, b) => (a.joinedAt ?? '').localeCompare(b.joinedAt ?? '') || a.identity.localeCompare(b.identity));
  }
  return { voiceMembers, occupancy, voiceSessions, occupancyRealtime: true };
}

function withSession(sessions: Record<string, string>, channelId: string, startedAt: string | null): Record<string, string> {
  if (startedAt) return { ...sessions, [channelId]: startedAt };
  const { [channelId]: _ended, ...rest } = sessions;
  return rest;
}

/**
 * 0.4.1/0.4.2: applies voice sessions pushed by the server. `snapshot` = the full authoritative
 * list (after ready, or a requested resync): channels missing from it are empty. A single channel
 * update replaces that channel and removes its people from every other channel.
 */
export function applyVoiceSessions(state: MembershipState, sessions: readonly VoiceSessionView[], snapshot: boolean, selfId?: string | null): MembershipResult {
  let members: VoiceMembers = snapshot ? {} : { ...state.voiceMembers };
  let voiceSessions: Record<string, string> = snapshot ? {} : { ...state.voiceSessions };
  if (snapshot) for (const channelId of Object.keys(state.voiceMembers)) members[channelId] = {};
  for (const s of sessions) {
    const list: Record<string, VoiceParticipantView> = {};
    for (const p of s.participants) {
      list[p.identity] = p;
      members = removeEverywhere(members, p.identity, s.channelId);
    }
    members[s.channelId] = list;
    voiceSessions = withSession(voiceSessions, s.channelId, s.startedAt);
  }
  return finish(state, members, voiceSessions, selfId);
}

/** 0.4.2 voice.participant.joined (idempotent: a duplicate join updates the entry). */
export function applyMemberJoined(state: MembershipState, channelId: string, participant: VoiceParticipantView, selfId?: string | null): MembershipResult {
  const members = removeEverywhere(state.voiceMembers, participant.identity, channelId);
  return finish(state, { ...members, [channelId]: { ...(members[channelId] ?? {}), [participant.identity]: participant } }, state.voiceSessions, selfId);
}

/** 0.4.2 voice.participant.left (a user we do not have is ignored). */
export function applyMemberLeft(state: MembershipState, channelId: string, userId: string, selfId?: string | null): MembershipResult {
  const list = state.voiceMembers[channelId];
  if (!list || !(userId in list)) return finish(state, state.voiceMembers, state.voiceSessions, selfId);
  const { [userId]: _gone, ...rest } = list;
  return finish(state, { ...state.voiceMembers, [channelId]: rest }, state.voiceSessions, selfId);
}

/** 0.4.2 voice.participant.moved. */
export function applyMemberMoved(state: MembershipState, fromChannelId: string, channelId: string, participant: VoiceParticipantView, selfId?: string | null): MembershipResult {
  const left = applyMemberLeft(state, fromChannelId, participant.identity, selfId);
  return applyMemberJoined({ ...state, voiceMembers: left.voiceMembers }, channelId, participant, selfId);
}

/** Re-derives the view after our own call state changed (joined, left, switched). */
export function applySelfChange(state: MembershipState, selfId: string | null | undefined): MembershipResult {
  return finish(state, state.voiceMembers, state.voiceSessions, selfId);
}

/**
 * Applies a polled occupancy result. Channels whose live data is newer than the moment the
 * poll was started (we are in that call, or just left it) keep the live data, so a slow poll
 * can never resurrect someone who already left.
 */
export function mergePolledOccupancy(
  state: Pick<VoiceState, 'occupancy' | 'occupancyLiveAt' | 'channelId' | 'status'>,
  polled: Record<string, VoiceParticipantView[]>,
  pollStartedAt: number,
): Record<string, VoiceParticipantView[]> {
  const next = { ...state.occupancy };
  const inCall = state.status === 'connected' || state.status === 'reconnecting' || state.status === 'connecting';
  for (const [channelId, list] of Object.entries(polled)) {
    if (inCall && state.channelId === channelId) continue;
    if ((state.occupancyLiveAt[channelId] ?? 0) > pollStartedAt) continue;
    next[channelId] = list;
  }
  return next;
}
