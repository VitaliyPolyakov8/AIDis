import { guildPerm } from '../stores/guildStore';
import {
  AudioPresets,
  type LocalVideoTrack,
  ConnectionQuality,
  ConnectionState,
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  RemoteAudioTrack,
  type AudioCaptureOptions,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  type RemoteParticipant,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type VideoTrack,
} from 'livekit-client';
import { voiceApi } from '../api/voice';
import { friendlyError, isApiError } from '../api/errors';
import { config } from '../config';
import { t } from '../i18n';
import { ParticipantSoundGate } from './participantSounds';
import { alignedTrack, canAlignFrames, captureSourceOf, releaseCapture } from '../desktop/frameAlign';
import { describeH264, hardwareH264Preferences, isConstrainedBaseline, parseProfileLevelId, type HardwareFallbackReason, type StreamEncoderDiagnostics } from './h264';
import { preferHardwareH264For, readEncoderReport, type EncoderReport } from './h264Publish';
import type { StreamDegradation } from '../desktop/contract';
import { playSound } from '../sounds/sounds';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore, type Settings } from '../stores/settingsStore';
import { desktop } from '../desktop/bridge';
import { toast } from '../stores/uiStore';
import { realtime } from '../realtime/socket';
import { listDevices, microphoneErrorMessage, onDeviceChange } from './devices';
import { ConnectionStatsSampler } from './connectionStats';
import { parseStreamStats, type StreamCounters } from './streamStats';
import { MicPipeline, type GateMode, type MicLevel } from './micPipeline';
import { SpeakingDetector } from './speakingDetector';
import { DEFAULT_SCREEN_SHARE_QUALITY, type ScreenShareQuality } from './screenShareQuality';
import { StreamThumbnailer } from './streamThumbnails';
import { bindStreamInteractions, streamInteractions } from './streamInteractions';
import { clampToRoom, defaultSpot, micBitrateBps, spatialMix, type RoomPoint } from './channelVoice';
import { useChatStore } from '../stores/chatStore';
import type { Channel } from '../api/types';
import { isIosDevice } from '../pwa/webApp';
import {
  INITIAL_VOICE_STATE,
  nextForDeafenToggle,
  nextForMicToggle,
  pruneWatched,
  parseStreamKey,
  streamKey,
  type StreamSource,
  reconcileParticipants,
  toOccupancy,
  useVoiceStore,
  type ConnectionQualityLevel,
  type ShareConfig,
  type VoiceParticipant,
  type VoiceState,
  applySelfChange,
} from './voiceStore';

/** Data-channel topic for small stream notices between AIDis clients (no user content). */
const STREAM_TOPIC = 'aidis.stream';
/** 0.5.5 "room" layout: positions ({ x, y } in room units), lossy while walking, reliable otherwise. */
const ROOM_TOPIC = 'aidis.room';

export type VoiceInputMode = 'voiceActivity' | 'pushToTalk';

export interface ScreenSharePublishOptions {
  frameRate: number;
  /** Encoder ceiling, bits per second. */
  maxBitrate: number;
  /** game: motion first; text: static detail first. */
  contentMode: 'game' | 'text';
  /**
   * 0.4.2: what WebRTC may give up under pressure. Default (when absent, e.g. the web build):
   * maintain-resolution, so a selected resolution is never silently scaled down.
   */
  degradation?: StreamDegradation;
  /** 0.4.2: the selected (requested) resolution, for stream details. */
  width?: number;
  height?: number;
  /**
   * 0.4.6: preferred video codec. 'h264' = try the GPU's hardware H.264 encoder (verified after
   * publishing; software H.264 falls back to VP8 automatically). Default VP8 (web build).
   */
  codec?: 'h264' | 'vp8';
}

/** 0.4.6 kept "software H.264 seen" forever per engine version; 0.4.7 checks every stream instead. */
const LEGACY_HW_H264_KEY = 'aidis.hwH264';
try {
  localStorage.removeItem(LEGACY_HW_H264_KEY);
} catch {
  /* ignore */
}

/** 0.4.7: how long a new H.264 stream may take to report its encoder before it counts as failed. */
const ENCODER_CHECK_WINDOW_MS = 8000;
/** 0.5.2: how often a running stream's FPS / bitrate / network estimate is written to the log. */
const STREAM_MONITOR_MS = 30_000;

/** The congestion controller's current send budget (bits/s) from the selected candidate pair. */
function availableOutgoingBitrate(report: RTCStatsReport | undefined): number | null {
  let value: number | null = null;
  report?.forEach((s: Record<string, unknown>) => {
    if (s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded' && typeof s.availableOutgoingBitrate === 'number') value = s.availableOutgoingBitrate;
  });
  return value;
}
const ENCODER_CHECK_POLL_MS = 500;

export { isHardwareEncoder } from './h264';

function degradationFor(options: ScreenSharePublishOptions): StreamDegradation {
  return options.degradation ?? 'maintain-resolution';
}

/** What LiveKit's typed API accepts; the exact value is enforced on the sender afterwards. */
function livekitDegradation(options: ScreenSharePublishOptions): RTCDegradationPreference {
  const wanted = degradationFor(options);
  return wanted === 'maintain-framerate-and-resolution' ? 'maintain-resolution' : wanted;
}

/** What the screen-share sender is really configured with (read back from RTCRtpSender). */
export interface ScreenShareSenderInfo {
  contentHint: string;
  degradationPreference: string | null;
  layers: { maxBitrate: number | null; maxFramerate: number | null; scaleResolutionDownBy: number | null; active: boolean }[];
}

/**
 * Browser automatic gain control (WebRTC AGC) keeps pulling the level back to its target, which
 * would undo a manual input volume. It is therefore only used while input volume is at 100 %.
 */
export function effectiveAgc(s: Pick<Settings, 'autoGainControl' | 'inputVolume'>): boolean {
  return s.autoGainControl && s.inputVolume === 100;
}

export function micCaptureOptions(s: Settings): AudioCaptureOptions {
  return {
    deviceId: s.inputDeviceId === 'default' ? undefined : s.inputDeviceId,
    echoCancellation: s.echoCancellation,
    // Standard = WebRTC's own suppression. Strong uses RNNoise in our pipeline instead (not both:
    // two suppressors in a row make speech sound processed).
    noiseSuppression: s.noiseSuppressionMode === 'standard',
    autoGainControl: effectiveAgc(s),
  };
}

function describeCapture(o: AudioCaptureOptions): string {
  const device = typeof o.deviceId === 'string' ? `device ${o.deviceId.slice(0, 8)}...` : 'default device';
  return `${device}, echo cancellation ${JSON.stringify(o.echoCancellation)}, noise suppression ${JSON.stringify(o.noiseSuppression)}, AGC ${JSON.stringify(o.autoGainControl)}`;
}

/** Microphone diagnostics go to the desktop log (never audio, never tokens); console in browsers. */
function micLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (desktop) desktop.app.log(level, `[mic] ${message}`);
  else if (level !== 'info') console.warn(`[mic] ${message}`);
}

/** Settings and caches that survive leaving a call. */
function persistentVoiceState(): Partial<VoiceState> {
  const s = useVoiceStore.getState();
  // 0.4.2: leaving a call must never drop what we know about OTHER channels (membership, timers).
  return {
    micEnabled: s.micEnabled,
    deafened: s.deafened,
    micBeforeDeafen: s.micBeforeDeafen,
    occupancy: s.occupancy,
    occupancyLiveAt: s.occupancyLiveAt,
    occupancyAvailable: s.occupancyAvailable,
    occupancyRealtime: s.occupancyRealtime,
    voiceSessions: s.voiceSessions,
    voiceMembers: s.voiceMembers,
    pttMode: s.pttMode,
    deafenedUsers: s.deafenedUsers,
    // 0.5.0: everyone's voice state (channel list icons) is realtime info, not tied to our call.
    memberStates: s.memberStates,
  };
}

function qualityLevel(quality: ConnectionQuality): ConnectionQualityLevel {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'excellent';
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
      return 'poor';
    case ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
}

/**
 * Owns the LiveKit Room. React components never touch the Room directly; they read
 * useVoiceStore and call the methods below. Exactly one Room exists at a time.
 */
/** 0.5.9: iPhone / iPad with "Sound in the background" on (the default there). */
function iosBackgroundAudio(): boolean {
  return isIosDevice && useSettingsStore.getState().iosBackgroundAudio;
}

class VoiceService {
  private room: Room | null = null;
  private stopStreamInteractions: (() => void) | null = null;
  private joinSeq = 0;
  private audioContainer: HTMLDivElement | null = null;
  /** Remote audio elements we attached, by track sid. */
  private audioElements = new Map<string, HTMLMediaElement[]>();
  private leaving = false;
  private syncQueued = false;
  private sampler: ConnectionStatsSampler | null = null;
  private inputMode: VoiceInputMode = 'voiceActivity';
  private pttReleaseDelayMs = 50;
  private pttHeld = false;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes microphone changes; each run applies the newest desired state. */
  private micQueue: Promise<void> = Promise.resolve();
  /** Raw capture tracks of a desktop screen share, stopped explicitly when the share ends. */
  private captureTracks: MediaStreamTrack[] = [];
  private stopDeviceWatch: (() => void) | null = null;
  private screenSenderInfo: ScreenShareSenderInfo | null = null;
  /** One-off check of the real capture/send FPS a few seconds after a share starts (logged). */
  private fpsCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 0.5.2: periodic stream measurement while sharing (see logScreenFps). */
  private fpsMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private fpsCounters: StreamCounters | null = null;
  /** 0.4.6: codec of our running screen share. */
  private screenCodec: 'h264' | 'vp8' = 'vp8';
  /** 0.4.7: requested / negotiated codec, real encoder and the fallback reason of our own stream. */
  private screenDiagnostics: StreamEncoderDiagnostics | null = null;
  /** Chromium's GPU video_encode status when the stream started (desktop), for the fallback reason. */
  private gpuVideoEncode: string | null = null;
  /** 0.5.0: true while the screen video is swapped for a codec retry / VP8 fallback (not a real stop). */
  private republishing = false;
  /** Bumped on every (re)publish of the screen video: a stale encoder check stops itself. */
  private screenGeneration = 0;
  /** 0.5.5: small previews of our screen share for people hovering our LIVE badge. */
  private readonly thumbnails = new StreamThumbnailer();
  /** 0.4.2: the selected stream resolution (null in the browser build). */
  private screenRequested: { width: number; height: number } | null = null;
  /** Local speaking detection (fast speaking rings); one per call. */
  private speaking: SpeakingDetector | null = null;
  /** Outgoing mic processing (input volume + voice gate) and its AudioContext, per call. */
  private micContext: AudioContext | null = null;
  private micPipeline: MicPipeline | null = null;
  private stopSettingsWatch: (() => void) | null = null;
  /**
   * 0.4.2 join / leave sounds for OTHER people: who we already know is in our room. Seeded
   * silently on connect, after a LiveKit reconnect and after a move, so snapshots and
   * reconnects never make a sound; only real transitions in our own room do.
   */
  private readonly soundGate = new ParticipantSoundGate();
  /** 0.4.0: when the server last announced that we are being moved. */
  private moveRequestedAt = 0;
  /**
   * 0.4.0: separate output for stream (screen-share) audio. Its own AudioContext whose sink is the
   * chosen device; voice keeps LiveKit's shared context. Only used where AudioContext.setSinkId exists.
   */
  private streamContext: AudioContext | null = null;
  private streamSinkMissing = false;

  /** True while the WebRTC stats timer runs (only while in a call). */
  get statsActive(): boolean {
    return this.sampler?.active ?? false;
  }

  // ---- lifecycle -----------------------------------------------------------------

  async join(channelId: string): Promise<void> {
    const state = useVoiceStore.getState();
    if (state.channelId === channelId && (state.status === 'connected' || state.status === 'connecting' || state.status === 'reconnecting')) {
      return;
    }
    if (this.room) await this.leave({ silent: true });

    const seq = ++this.joinSeq;
    useVoiceStore.setState({
      status: 'connecting',
      channelId,
      error: null,
      micError: null,
      participants: [],
      localScreenSharing: false,
      focusedShare: null,
      endedShare: null,
      quality: 'unknown',
      audioBlocked: false,
    });

    let room: Room | null = null;
    try {
      const grant = await voiceApi.token(channelId);
      if (seq !== this.joinSeq) return;
      // QA builds only (VITE_LIVEKIT_FORCE=1, never in releases): use the build's LiveKit URL.
      const url = (import.meta.env.VITE_LIVEKIT_FORCE === '1' ? config.livekitUrl : grant.url) || config.livekitUrl;
      if (!url) throw new Error('No LiveKit URL configured');

      const settings = useSettingsStore.getState();
      room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // 0.4.5: nothing is subscribed automatically. Microphones are subscribed as they appear;
        // a stream's video and audio only when this device chooses "Watch stream".

        disconnectOnPageLeave: true,
        audioCaptureDefaults: micCaptureOptions(settings),
        audioOutput: settings.outputDeviceId === 'default' ? undefined : { deviceId: settings.outputDeviceId },
        // Remote audio plays through Web Audio, so per-user volume can go above 100 %.
        // 0.5.9: not on iPhone / iPad with "background sound" on: iOS suspends Web Audio when the
        // app is in the background or the phone is locked; plain <audio> elements keep playing.
        webAudioMix: !iosBackgroundAudio(),
      });
      this.room = room;
      micLog('info', `Joining voice with ${describeCapture(micCaptureOptions(settings))}, input mode ${this.inputMode}`);
      this.bindRoom(room);
      await room.connect(url, grant.token, { autoSubscribe: false });
      this.applySubscriptions(room);
      if (seq !== this.joinSeq) {
        await room.disconnect();
        return;
      }
      useVoiceStore.setState({ status: 'connected', audioBlocked: !room.canPlaybackAudio });
      this.seedKnownRemote(room);
      playSound('join');
      this.publishDeafen();
      this.sampler = new ConnectionStatsSampler(
        room,
        (stats) => {
          if (this.room === room) useVoiceStore.setState({ stats });
        },
        (message) => {
          if (desktop) desktop.app.log('info', `[stats] ${message}`);
        },
      );
      this.sampler.start();
      this.speaking = new SpeakingDetector(() => {
        if (this.room === room) this.scheduleSync();
      });
      // Our own ring: the level we actually send (after volume and the voice gate), only while transmitting.
      // (0.5.9: not on iPhone / iPad in background mode: no pipeline there, LiveKit's speaking state is used.)
      if (!iosBackgroundAudio())
        this.speaking.setLocalLevel(() => {
          const level = this.micPipeline?.getLevel();
          if (!level || !this.shouldTransmit()) return null;
          return level.open ? level.db : null;
        });
      for (const participant of room.remoteParticipants.values()) {
        const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
        if (track) this.speaking.addRemote(participant.identity, track.mediaStreamTrack);
      }
      this.syncParticipants();
      // Joining is a user gesture, so this normally unlocks audio playback.
      room.startAudio().catch(() => undefined);
      this.watchDevices();
      this.watchSettings();
      await this.applyMicrophone();
    } catch (error) {
      if (seq !== this.joinSeq) return;
      if (room) {
        this.leaving = true;
        await room.disconnect().catch(() => undefined);
        this.leaving = false;
      }
      this.cleanupRoom();
      const message = isApiError(error) ? friendlyError(error, t('voice.errors.joinFailed')) : t('voice.errors.connectFailed');
      useVoiceStore.setState({ status: 'error', error: message, participants: [] });
    }
  }

  async leave(options: { silent?: boolean } = {}): Promise<void> {
    this.joinSeq += 1;
    const { channelId, status } = useVoiceStore.getState();
    const room = this.room;
    if (room) {
      this.leaving = true;
      try {
        // disconnect(true) stops every local track (microphone and screen share).
        await room.disconnect(true);
      } catch {
        /* already gone */
      } finally {
        this.leaving = false;
      }
    }
    this.cleanupRoom();
    realtime.setWatchedStreams([]);
    if (!options.silent && (status === 'connected' || status === 'reconnecting')) playSound('leave');
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE, ...persistentVoiceState() });
    if (channelId) this.removeSelfFromOccupancy(channelId);
  }

  /** Full reset on logout. */
  async reset(): Promise<void> {
    await this.leave({ silent: true });
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE, pttMode: this.inputMode === 'pushToTalk' });
  }

  dismissError(): void {
    if (useVoiceStore.getState().status === 'error') useVoiceStore.setState({ status: 'idle', channelId: null, error: null });
  }

  dismissEndedShare(): void {
    useVoiceStore.setState({ endedShare: null });
  }

  // ---- microphone / deafen ---------------------------------------------------------

  /**
   * 0.7.0: a moderator server-muted / server-deafened me on this server. While muted the microphone
   * stays off (the server also withholds it from LiveKit); while deafened we hear nothing and send nothing.
   */
  applyServerState(guildId: string, flags: { muted: boolean; deafened: boolean }): void {
    const state = useVoiceStore.getState();
    const channel = state.channelId ? useChatStore.getState().channels.find((c) => c.id === state.channelId) : undefined;
    if (channel?.guildId !== guildId) return;
    if ((flags.muted || flags.deafened) && state.micEnabled) {
      useVoiceStore.setState({ micEnabled: false });
      void this.applyMicrophone();
    }
    if (flags.deafened !== state.deafened && flags.deafened) {
      useVoiceStore.setState({ deafened: true });
      this.applyDeafen(true);
    }
    this.publishDeafen();
  }

  /** 0.7.0: am I server-muted / server-deafened in the voice channel I am in? */
  serverLock(): { muted: boolean; deafened: boolean } {
    const state = useVoiceStore.getState();
    const channel = state.channelId ? useChatStore.getState().channels.find((c) => c.id === state.channelId) : undefined;
    const self = useAuthStore.getState().user?.id;
    if (!channel?.guildId || !self) return { muted: false, deafened: false };
    const server = state.serverStates[`${channel.guildId}:${self}`] ?? { muted: false, deafened: false };
    // Without SPEAK in this channel the microphone stays off too (the server withholds it anyway).
    return { muted: server.muted || !guildPerm('SPEAK', channel.id), deafened: server.deafened };
  }

  async toggleMic(): Promise<void> {
    const state = useVoiceStore.getState();
    const lock = this.serverLock();
    if ((lock.muted || lock.deafened) && !state.micEnabled && !state.deafened) toast.info(t(lock.deafened ? 'voiceLock.deafened' : 'voiceLock.muted'), 'voice-lock');
    const next = nextForMicToggle(state, lock);
    useVoiceStore.setState({ ...next, micError: null });
    playSound(next.micEnabled ? 'unmute' : 'mute');
    if (state.deafened !== next.deafened) this.applyDeafen(next.deafened);
    this.publishDeafen();
    await this.applyMicrophone();
  }

  async toggleDeafen(): Promise<void> {
    const next = nextForDeafenToggle(useVoiceStore.getState(), this.serverLock());
    useVoiceStore.setState(next);
    playSound(next.deafened ? 'mute' : 'unmute');
    this.applyDeafen(next.deafened);
    this.publishDeafen();
    await this.applyMicrophone();
  }

  /**
   * Other people see our microphone / headphones / LIVE / camera icons while we are in a call, also
   * from outside the channel (0.5.0, Socket.IO, see realtime.setVoiceState). Everything off otherwise.
   */
  private publishDeafen(): void {
    const s = useVoiceStore.getState();
    const inCall = this.room !== null;
    realtime.setVoiceState({
      deafened: inCall && s.deafened,
      muted: inCall && !s.micEnabled,
      screen: inCall && s.localScreenSharing,
      camera: inCall && s.localCamera,
    });
  }

  /** 0.5.0: the server learns which OTHER people's streams this device watches (viewer lists, sounds). */
  private publishWatching(): void {
    const room = this.room;
    const self = room?.localParticipant.identity;
    const streams = room
      ? useVoiceStore
          .getState()
          .watchedShares.map(parseStreamKey)
          .filter((k) => k.identity !== self)
          .map((k) => ({ streamerId: k.identity, source: k.source }))
      : [];
    realtime.setWatchedStreams(streams);
  }

  // ---- input mode / push-to-talk ------------------------------------------------------

  /** Voice activity (open mic) or push-to-talk. Set by the desktop shell; the web is always voice activity. */
  setInputMode(mode: VoiceInputMode, releaseDelayMs: number): void {
    this.pttReleaseDelayMs = Math.min(500, Math.max(0, releaseDelayMs));
    if (mode === this.inputMode) return;
    this.inputMode = mode;
    this.clearPttTimer();
    this.pttHeld = false;
    useVoiceStore.setState({ pttMode: mode === 'pushToTalk', pttActive: false });
    this.applyPipelineSettings();
    void this.applyMicrophone();
  }

  /** Global PTT key went down/up. Releasing keeps the mic open for the configured delay. */
  setPushToTalk(pressed: boolean): void {
    if (this.inputMode !== 'pushToTalk') return;
    if (pressed) {
      this.clearPttTimer();
      if (this.pttHeld) return;
      this.pttHeld = true;
      useVoiceStore.setState({ pttActive: true });
      void this.applyMicrophone();
      return;
    }
    if (!this.pttHeld || this.pttReleaseTimer) return;
    const release = () => {
      this.pttReleaseTimer = null;
      this.pttHeld = false;
      useVoiceStore.setState({ pttActive: false });
      void this.applyMicrophone();
    };
    if (this.pttReleaseDelayMs === 0) release();
    else this.pttReleaseTimer = setTimeout(release, this.pttReleaseDelayMs);
  }

  private clearPttTimer(): void {
    if (this.pttReleaseTimer) clearTimeout(this.pttReleaseTimer);
    this.pttReleaseTimer = null;
  }

  /** Whether the microphone should be sending audio right now. */
  private shouldTransmit(): boolean {
    const { micEnabled, deafened } = useVoiceStore.getState();
    if (!micEnabled || deafened) return false;
    return this.inputMode !== 'pushToTalk' || this.pttHeld;
  }

  /**
   * Brings LiveKit in line with the desired state. Calls are queued and each one reads the newest
   * state when it runs, so rapid toggles or PTT taps always end in the state the UI shows.
   */
  private applyMicrophone(): Promise<void> {
    const run = this.micQueue.then(() => this.applyMicrophoneNow());
    this.micQueue = run.catch(() => undefined);
    return run;
  }

  private async applyMicrophoneNow(): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    const transmit = this.shouldTransmit();
    try {
      const published = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const { micEnabled, deafened } = useVoiceStore.getState();
      if (!published) {
        // Muted or deafened before the first publish: no microphone at all until it is needed.
        // 0.5.9 iPhone / iPad: the microphone is captured (muted) for the whole call, because iOS
        // keeps a page with an active capture running in the background and on the lock screen.
        if ((micEnabled || iosBackgroundAudio()) && !deafened) await this.publishMicrophone(room, transmit);
      } else {
        await room.localParticipant.setMicrophoneEnabled(transmit);
      }
      useVoiceStore.setState({ micError: null });
    } catch (error) {
      micLog('warn', `Microphone could not be opened: ${error instanceof Error ? error.name : 'error'}`);
      useVoiceStore.setState({ micEnabled: false, micError: microphoneErrorMessage(error) });
    }
    this.reportPipeline();
    this.syncParticipants();
  }

  /**
   * First microphone publish of a call. The processing chain (input volume, limiter, voice gate) is
   * attached BEFORE LiveKit sees the track, so the raw microphone is never sent: earlier the track
   * was published first and the pipeline attached a moment later, which leaked the first second or
   * two of unprocessed start-up noise (AGC / noise suppression still settling) to everyone.
   * Push-to-talk publishes muted, so the first key press transmits instantly and nothing before it.
   */
  private async publishMicrophone(room: Room, transmit: boolean): Promise<void> {
    const track = await createLocalAudioTrack(room.options.audioCaptureDefaults);
    if (this.room !== room) {
      track.stop();
      return;
    }
    await this.attachMicPipeline(room, track);
    if (this.room !== room) {
      track.stop();
      return;
    }
    if (!transmit) await track.mute();
    // 0.4.5 voice quality: Opus mono at up to 64 kbps (LiveKit's default "music" preset is 48 kbps;
    // a 5-6 person server is not bandwidth-limited). DTX (nothing sent in silence; the gate already
    // outputs silence) and RED (redundancy against packet loss) stay on.
    // 0.5.5: the voice channel's own bitrate (channel setting, default 64 kbps).
    await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, audioPreset: { maxBitrate: this.channelMicBitrate() }, dtx: true, red: true });
    if (this.room !== room) return;
    if (this.shouldTransmit() !== transmit) await room.localParticipant.setMicrophoneEnabled(this.shouldTransmit());
  }

  private applyDeafen(_deafened: boolean): void {
    this.applyRemoteVolumes();
  }

  // ---- per-user playback volume (local only) --------------------------------------------

  /**
   * Volume this device plays each remote participant at: voice: deafened or locally muted -> 0;
   * stream audio: locally muted -> 0 (deafen does not touch streams since 0.4.5); else the per-user volume (default 100 %, up to 200 %). Applied to their microphone and their
   * screen-share audio through LiveKit's Web Audio gain; nothing is sent to the server or to them.
   */
  private applyRemoteVolumes(): void {
    const room = this.room;
    if (!room) return;
    const { deafened, roomPositions, audioShare } = useVoiceStore.getState();
    const { userVolumes, userMutes, streamVolumes } = useSettingsStore.getState();
    // 0.5.5 "room" layout: voices fade with distance and pan left / right.
    const self = this.isRoomLayout() ? (roomPositions[room.localParticipant.identity] ?? defaultSpot(room.localParticipant.identity)) : null;
    for (const participant of room.remoteParticipants.values()) {
      const muted = userMutes[participant.identity] === true;
      const mix = self ? spatialMix(self, roomPositions[participant.identity] ?? defaultSpot(participant.identity)) : { gain: 1, pan: 0 };
      this.applyPan(participant, mix.pan);
      // Voice and stream (game/system) audio are separate tracks with separate gains.
      participant.setVolume(deafened || muted ? 0 : ((userVolumes[participant.identity] ?? 100) / 100) * mix.gain, Track.Source.Microphone);
      // 0.4.5: deafen ("headphones off") silences VOICES only; a watched stream keeps playing.
      // Its own mute / volume (stream bar) is the way to silence a stream.
      participant.setVolume(muted || audioShare !== participant.identity ? 0 : (streamVolumes[participant.identity] ?? 100) / 100, Track.Source.ScreenShareAudio);
    }
  }

  // ---- 0.5.5 voice channel settings: bitrate and the "room" layout ---------------------------

  private currentChannel(): Channel | undefined {
    const id = useVoiceStore.getState().channelId;
    return id ? useChatStore.getState().channels.find((c) => c.id === id) : undefined;
  }

  private channelMicBitrate(): number {
    return micBitrateBps(this.currentChannel()?.voiceBitrate);
  }

  isRoomLayout(): boolean {
    return this.currentChannel()?.voiceLayout === 'room';
  }

  /** A manager changed the channel's bitrate during the call: the running microphone follows. */
  private async applyMicBitrate(): Promise<void> {
    const sender = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender;
    if (!sender) return;
    const bitrate = this.channelMicBitrate();
    const params = sender.getParameters();
    const encoding = params.encodings[0];
    if (!encoding || encoding.maxBitrate === bitrate) return;
    encoding.maxBitrate = bitrate;
    await sender.setParameters(params).catch((error: unknown) => micLog('warn', `Could not change the voice bitrate: ${error instanceof Error ? error.message : 'error'}`));
    micLog('info', `Voice bitrate ${String(bitrate / 1000)} kbps (channel setting)`);
  }

  /** Stereo position of a voice (best effort: Web Audio panner in front of LiveKit's gain). */
  private readonly panners = new Map<string, StereoPannerNode>();
  private applyPan(participant: RemoteParticipant, pan: number): void {
    const track = participant.getTrackPublication(Track.Source.Microphone)?.track as RemoteAudioTrack | undefined;
    if (!track) return;
    let panner = this.panners.get(participant.identity);
    if (!panner && pan !== 0) {
      // LiveKit keeps the Web Audio context private; it exists when webAudioMix is on (it is).
      const context = (track as unknown as { audioContext?: AudioContext }).audioContext;
      if (!context || typeof track.setWebAudioPlugins !== 'function') return;
      try {
        const created = context.createStereoPanner();
        track.setWebAudioPlugins([created]);
        this.panners.set(participant.identity, created);
        panner = created;
      } catch {
        return;
      }
    }
    if (panner) panner.pan.value = pan;
  }

  /** Our position in a "room" channel: shown at once, sent to the others (throttled while walking). */
  private lastRoomSend = 0;
  private roomSendTimer: ReturnType<typeof setTimeout> | null = null;
  setRoomPosition(point: RoomPoint, final = false): void {
    const room = this.room;
    const identity = room?.localParticipant.identity ?? useAuthStore.getState().user?.id;
    if (!identity) return;
    const p = clampToRoom(point);
    const { roomPositions } = useVoiceStore.getState();
    useVoiceStore.setState({ roomPositions: { ...roomPositions, [identity]: p } });
    if (!room) return;
    this.applyRemoteVolumes();
    const send = (reliable: boolean) => {
      this.lastRoomSend = Date.now();
      const payload = new TextEncoder().encode(JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }));
      void room.localParticipant.publishData(payload, { reliable, topic: ROOM_TOPIC }).catch(() => undefined);
    };
    if (this.roomSendTimer) clearTimeout(this.roomSendTimer);
    this.roomSendTimer = null;
    if (final) send(true);
    else if (Date.now() - this.lastRoomSend > 80) send(false);
    else this.roomSendTimer = setTimeout(() => send(false), 80);
  }

  /** Re-announces our position (someone joined, or the periodic refresh). */
  private announceRoomPosition(room: Room): void {
    if (!this.isRoomLayout()) return;
    const self = useVoiceStore.getState().roomPositions[room.localParticipant.identity] ?? defaultSpot(room.localParticipant.identity);
    const payload = new TextEncoder().encode(JSON.stringify({ x: Math.round(self.x), y: Math.round(self.y) }));
    void room.localParticipant.publishData(payload, { reliable: true, topic: ROOM_TOPIC }).catch(() => undefined);
  }

  setUserVolume(identity: string, percent: number): void {
    const { userVolumes } = useSettingsStore.getState();
    const value = Math.round(Math.min(200, Math.max(0, percent)));
    useSettingsStore.getState().update({ userVolumes: { ...userVolumes, [identity]: value } });
  }

  /** Local volume of someone's stream audio (0..200 %), independent of their voice volume. */
  setStreamVolume(identity: string, percent: number): void {
    const { streamVolumes } = useSettingsStore.getState();
    const value = Math.round(Math.min(200, Math.max(0, percent)));
    useSettingsStore.getState().update({ streamVolumes: { ...streamVolumes, [identity]: value } });
  }

  setUserMuted(identity: string, muted: boolean): void {
    const { userMutes } = useSettingsStore.getState();
    const { [identity]: _removed, ...rest } = userMutes;
    useSettingsStore.getState().update({ userMutes: muted ? { ...rest, [identity]: true } : rest });
  }

  // ---- outgoing microphone processing ------------------------------------------------------

  private gateMode(): GateMode {
    if (this.inputMode === 'pushToTalk') return 'open';
    return useSettingsStore.getState().autoSensitivity ? 'auto' : 'manual';
  }

  private applyPipelineSettings(): void {
    const s = useSettingsStore.getState();
    this.micPipeline?.setVolume(s.inputVolume);
    this.micPipeline?.setNoiseSuppression(s.noiseSuppressionMode === 'strong');
    this.micPipeline?.setGate(this.gateMode(), s.sensitivityDb);
  }

  /** Puts input volume + voice gate between the microphone and LiveKit. Falls back to the raw mic on failure. */
  private async attachMicPipeline(room: Room, track: LocalAudioTrack): Promise<void> {
    if (typeof AudioWorkletNode === 'undefined' || typeof AudioContext === 'undefined') return;
    // 0.5.9: iOS stops Web Audio in the background, which would silence what we send: the raw
    // microphone with the system's own echo / noise processing is used instead.
    if (iosBackgroundAudio()) {
      micLog('info', 'iPhone / iPad background mode: microphone without the Web Audio pipeline');
      return;
    }
    try {
      this.micContext ??= new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      const pipeline = new MicPipeline();
      this.micPipeline = pipeline;
      this.applyPipelineSettings();
      track.setAudioContext(this.micContext);
      await track.setProcessor(pipeline);
      if (this.room !== room) {
        await track.stopProcessor().catch(() => undefined);
        return;
      }
      const s = useSettingsStore.getState();
      const gate = this.gateMode();
      micLog(
        'info',
        `Microphone pipeline active: volume ${s.inputVolume} %, gate ${gate}${gate === 'manual' ? ` at ${s.sensitivityDb} dBFS` : ''}, noise suppression ${s.noiseSuppressionMode}${s.noiseSuppressionMode === 'strong' ? (pipeline.noiseActive ? ' (RNNoise running)' : ' (RNNoise unavailable)') : ''}`,
      );
    } catch (error) {
      this.micPipeline = null;
      micLog('error', `Microphone pipeline failed, sending the raw microphone: ${error instanceof Error ? error.message : 'error'}`);
      toast.warning(t('voice.errors.micProcessing'), 'mic-processing');
    }
    this.reportPipeline();
  }

  /** Tells the UI whether input volume and sensitivity are really applied to what LiveKit sends. */
  private reportPipeline(): void {
    const published = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const state = !published ? 'off' : this.micPipeline?.active ? 'active' : 'bypassed';
    useVoiceStore.setState({ micPipeline: state });
  }

  /**
   * Retry after the microphone could not be opened (another app holds it exclusively, it was
   * unplugged...). Also runs automatically when Windows reports a device change.
   */
  async retryMicrophone(): Promise<void> {
    if (!useVoiceStore.getState().micError) return;
    micLog('info', 'Retrying microphone');
    useVoiceStore.setState({ micError: null, micEnabled: true });
    await this.applyMicrophone();
  }

  /** Live microphone level after input volume, and whether the gate is open (null outside a call). */
  getMicLevel(): MicLevel | null {
    return this.micPipeline?.getLevel() ?? null;
  }

  private watchSettings(): void {
    this.stopSettingsWatch?.();
    this.stopSettingsWatch = useSettingsStore.subscribe((s, prev) => {
      if (s.inputVolume !== prev.inputVolume || s.autoSensitivity !== prev.autoSensitivity || s.sensitivityDb !== prev.sensitivityDb) {
        this.applyPipelineSettings();
      }
      // A new suppression mode means new capture constraints and a rebuilt pipeline.
      if (effectiveAgc(s) !== effectiveAgc(prev) || s.noiseSuppressionMode !== prev.noiseSuppressionMode) void this.applyAudioProcessing();
      if (s.userVolumes !== prev.userVolumes || s.userMutes !== prev.userMutes || s.streamVolumes !== prev.streamVolumes) this.applyRemoteVolumes();
    });
    // 0.5.5: channel settings changed during the call (bitrate, layout).
    this.stopChannelWatch?.();
    let previous = this.currentChannel();
    const unsubscribe = useChatStore.subscribe((s, prev) => {
      if (s.channels === prev.channels) return;
      const next = this.currentChannel();
      if (next?.voiceBitrate !== previous?.voiceBitrate) void this.applyMicBitrate();
      if (next?.voiceLayout !== previous?.voiceLayout) {
        this.applyRemoteVolumes();
        if (this.room) this.announceRoomPosition(this.room);
      }
      previous = next;
    });
    const refresh = setInterval(() => {
      if (this.room) this.announceRoomPosition(this.room);
    }, 15_000);
    this.stopChannelWatch = () => {
      unsubscribe();
      clearInterval(refresh);
    };
  }
  private stopChannelWatch: (() => void) | null = null;

  /**
   * 0.5.9 iPhone / iPad: back from the background or the lock screen, resume what iOS paused
   * (audio contexts, remote audio elements). Without a tap iOS may still refuse; then the usual
   * "enable sound" button shows up.
   */
  async resumeAfterBackground(): Promise<void> {
    for (const context of [this.micContext, this.streamContext]) {
      if (context && context.state !== 'running' && context.state !== 'closed') await context.resume().catch(() => undefined);
    }
    this.speaking?.resume();
    if (!this.room) return;
    await this.room.startAudio().catch(() => undefined);
    useVoiceStore.setState({ audioBlocked: !this.room.canPlaybackAudio });
  }

  /** Unlocks audio after the browser blocked autoplay. Must be called from a click handler. */
  async enableAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => undefined);
    useVoiceStore.setState({ audioBlocked: !(this.room?.canPlaybackAudio ?? true) });
  }

  // ---- devices -------------------------------------------------------------------

  async setInputDevice(deviceId: string): Promise<void> {
    useSettingsStore.getState().update({ inputDeviceId: deviceId });
    if (this.room?.state === ConnectionState.Connected) {
      await this.room.switchActiveDevice('audioinput', deviceId).catch(() => {
        toast.error(t('voice.errors.inputSwitch'), 'voice-device');
      });
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    useSettingsStore.getState().update({ outputDeviceId: deviceId });
    if (this.room) {
      await this.room.switchActiveDevice('audiooutput', deviceId).catch(() => {
        toast.error(t('voice.errors.outputSwitch'), 'voice-device');
      });
    }
  }

  /** 0.4.0: where stream audio plays ('same' = with voice). Applied live to every screen-share audio track. */
  async setStreamOutputDevice(deviceId: string): Promise<void> {
    useSettingsStore.getState().update({ streamOutputDeviceId: deviceId });
    this.streamSinkMissing = false;
    await this.applyStreamOutput();
  }

  private streamTracks(): RemoteAudioTrack[] {
    const out: RemoteAudioTrack[] = [];
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      const track = participant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (track instanceof RemoteAudioTrack) out.push(track);
    }
    return out;
  }

  /**
   * Routes screen-share audio: with "same as voice" the tracks stay on LiveKit's shared context;
   * otherwise they move to our stream context whose sink is the chosen device. Per-stream volume
   * keeps working (LiveKit's gain node lives in whichever context the track uses).
   */
  private async applyStreamOutput(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const wanted = useSettingsStore.getState().streamOutputDeviceId;
    const supported = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    const tracks = this.streamTracks();
    if (wanted === 'same' || !supported) {
      for (const track of tracks) {
        const shared = this.sharedContext.get(track.mediaStreamTrack.id);
        if (shared && (track as unknown as { audioContext?: AudioContext }).audioContext !== shared) track.setAudioContext(shared);
      }
      return;
    }
    if (!this.streamContext || this.streamContext.state === 'closed') this.streamContext = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.streamContext as AudioContext & { setSinkId: (id: string) => Promise<void> };
    const sink = wanted === 'default' || this.streamSinkMissing ? '' : wanted;
    await ctx.setSinkId(sink).catch(() => undefined);
    for (const track of tracks) {
      const current = (track as unknown as { audioContext?: AudioContext }).audioContext;
      if (current && current !== ctx && !this.sharedContext.has(track.mediaStreamTrack.id)) this.sharedContext.set(track.mediaStreamTrack.id, current);
      if (current !== ctx) track.setAudioContext(ctx);
    }
    void ctx.resume().catch(() => undefined);
    this.applyRemoteVolumes();
  }

  /** LiveKit's shared context per stream track, to move it back for "same as voice". */
  private readonly sharedContext = new Map<string, AudioContext>();

  /** Re-acquires the microphone with new processing options (echo cancellation etc.). */
  async applyAudioProcessing(): Promise<void> {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    const options = micCaptureOptions(useSettingsStore.getState());
    micLog('info', `Restarting microphone with new processing (${describeCapture(options)})`);
    try {
      // The pipeline's restart() rebuilds volume + gate on the new track (see MicPipeline).
      await track.restartTrack(options);
      this.reportPipeline();
    } catch (error) {
      micLog('warn', `Microphone restart failed: ${error instanceof Error ? error.name : 'error'}`);
      useVoiceStore.setState({ micError: microphoneErrorMessage(error) });
    }
  }

  /**
   * While in a call: if the chosen microphone or output disappears (unplugged headset), switch to
   * the system default and tell the user once; switch back when it returns. The saved preference is
   * kept, so re-plugging the device restores it.
   */
  private watchDevices(): void {
    this.stopDeviceWatch?.();
    let missing = { input: false, output: false };
    const check = async () => {
      const room = this.room;
      if (!room || room.state !== ConnectionState.Connected) return;
      if (useVoiceStore.getState().micError) await this.retryMicrophone();
      const s = useSettingsStore.getState();
      const [inputs, outputs] = await Promise.all([listDevices('audioinput'), listDevices('audiooutput')]);
      if (this.room !== room) return;
      const next = {
        input: s.inputDeviceId !== 'default' && inputs.length > 0 && !inputs.some((d) => d.deviceId === s.inputDeviceId),
        output: s.outputDeviceId !== 'default' && outputs.length > 0 && !outputs.some((d) => d.deviceId === s.outputDeviceId),
      };
      if (next.input && !missing.input) {
        toast.warning(t('voice.devices.inputLost'), 'voice-device');
        await room.switchActiveDevice('audioinput', 'default').catch(() => undefined);
      } else if (!next.input && missing.input) {
        toast.info(t('voice.devices.inputBack'), 'voice-device');
        await room.switchActiveDevice('audioinput', s.inputDeviceId).catch(() => undefined);
      }
      // 0.4.0: the stream output device can disappear on its own (e.g. speakers unplugged).
      const streamId = s.streamOutputDeviceId;
      const streamMissing = streamId !== 'same' && streamId !== 'default' && outputs.length > 0 && !outputs.some((d) => d.deviceId === streamId);
      if (streamMissing !== this.streamSinkMissing) {
        this.streamSinkMissing = streamMissing;
        if (streamMissing) toast.warning(t('voice.devices.streamOutputLost'), 'voice-stream-output');
        else toast.info(t('voice.devices.streamOutputBack'), 'voice-stream-output');
        await this.applyStreamOutput();
      }
      if (next.output && !missing.output) {
        toast.warning(t('voice.devices.outputLost'), 'voice-output');
        await room.switchActiveDevice('audiooutput', 'default').catch(() => undefined);
      } else if (!next.output && missing.output) {
        await room.switchActiveDevice('audiooutput', s.outputDeviceId).catch(() => undefined);
      }
      missing = next;
    };
    this.stopDeviceWatch = onDeviceChange(() => {
      void check();
    });
  }

  /** 0..1 level of the local microphone as measured by LiveKit. */
  getLocalAudioLevel(): number {
    return this.room?.localParticipant.audioLevel ?? 0;
  }

  // ---- screen sharing --------------------------------------------------------------

  /** 0.7.0: STREAM on a server channel (DM calls: always). Shows why when it is missing. */
  canStream(): boolean {
    const channelId = useVoiceStore.getState().channelId;
    const channel = channelId ? useChatStore.getState().channels.find((c) => c.id === channelId) : undefined;
    if (!channel?.guildId || guildPerm('STREAM', channel.id)) return true;
    toast.error(t('voiceLock.noStream'), 'no-stream');
    return false;
  }

  async startScreenShare(quality: ScreenShareQuality = DEFAULT_SCREEN_SHARE_QUALITY): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    if (!this.canStream()) return;
    try {
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: true, // Chromium offers "Share tab/system audio" when available
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          suppressLocalAudioPlayback: false,
          resolution: { width: quality.width, height: quality.height, frameRate: quality.frameRate },
          contentHint: 'detail',
        },
        {
          screenShareEncoding: { maxBitrate: quality.maxBitrate, maxFramerate: quality.frameRate },
        },
      );
      if (room.localParticipant.isScreenShareEnabled) {
        playSound('shareStart');
        // Show our own share until we pick someone else's.
        this.watchOwnShare(room);
        const shared = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
        if (shared) this.thumbnails.start(shared);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        toast.info(t('voice.errors.screenCancelled'), 'screen-share');
      } else if (name === 'NotSupportedError' || name === 'TypeError') {
        toast.warning(t('voice.errors.screenUnsupported'), 'screen-share');
      } else {
        toast.error(t('voice.errors.screenFailed'), 'screen-share');
      }
    }
    this.syncParticipants();
  }

  async stopScreenShare(): Promise<void> {
    const room = this.room;
    if (!room) return;
    // LocalTrackUnpublished plays the stop sound and updates state (also covers the browser's own stop bar).
    // setScreenShareEnabled(false) unpublishes both the screen video and its audio.
    await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
    this.stopCaptureTracks();
    this.syncParticipants();
  }

  /**
   * Publishes an already captured screen (desktop app: getDisplayMedia armed with a chosen source
   * and exact resolution/frame rate). Video goes out as the ScreenShare source, system audio as
   * ScreenShareAudio, separate from the microphone. Resolves false when nothing was published;
   * every captured track is stopped in that case.
   */
  async publishScreenShare(stream: MediaStream, options: ScreenSharePublishOptions, source: Pick<ShareConfig, 'sourceId' | 'sourceKind'> = { sourceId: null, sourceKind: null }): Promise<boolean> {
    const room = this.room;
    const tracks = stream.getTracks();
    const stopAll = () => {
      for (const track of tracks) track.stop();
    };
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (!room || room.state !== ConnectionState.Connected || !video) {
      stopAll();
      return false;
    }
    if (room.localParticipant.isScreenShareEnabled) await this.stopScreenShare();
    // 0.4.7 hardware H.264 (desktop): only when this machine can really do it; otherwise VP8 with the reason.
    const blocker = options.codec === 'h264' ? await this.hardwareH264Blocker() : null;
    const useH264 = options.codec === 'h264' && blocker === null;
    this.screenDiagnostics = {
      requestedCodec: options.codec === 'h264' ? 'H264' : 'VP8',
      negotiatedCodec: null,
      negotiatedProfile: null,
      encoder: null,
      hardware: null,
      fallbackReason: blocker,
      attempts: useH264 ? 1 : 0,
      state: useH264 ? 'checking' : 'done',
    };
    if (blocker && desktop) desktop.app.log('warn', `[stream] hardware H.264 not used: ${blocker}; publishing VP8`);
    this.captureTracks = tracks;
    this.applyContentHint(video, options.contentMode);
    if (video.contentHint === '') micLog('warn', 'contentHint is not supported for the screen track');
    try {
      await this.publishScreenVideo(room, video, options, useH264 ? 'h264' : 'vp8');
      if (audio && this.room === room) await this.publishScreenAudio(room, audio);
    } catch {
      if (this.room === room) await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      this.stopCaptureTracks();
      toast.error(t('voice.errors.screenFailed'), 'screen-share');
      this.syncParticipants();
      return false;
    }
    if (this.room !== room) {
      this.stopCaptureTracks();
      return false;
    }
    playSound('shareStart');
    this.watchOwnShare(room);
    this.updateShareConfig(options, source);
    this.syncParticipants();
    this.thumbnails.start(video);
    if (useH264) void this.checkScreenEncoder(room, video, options, this.screenGeneration);
    return true;
  }

  /**
   * Publishes the screen video with one codec. H.264 goes through the frame alignment step and the
   * transceiver offers only hardware-capable H.264 profiles (see h264.ts), so the SFU cannot answer
   * with Constrained Baseline, which Chromium encodes in software.
   */
  private async publishScreenVideo(room: Room, video: MediaStreamTrack, options: ScreenSharePublishOptions, codec: 'h264' | 'vp8'): Promise<void> {
    const sendVideo = codec === 'h264' ? alignedTrack(video) : video;
    if (sendVideo !== video) {
      this.applyContentHint(sendVideo, options.contentMode);
      this.captureTracks = [...this.captureTracks, sendVideo];
    }
    this.screenCodec = codec;
    this.screenGeneration += 1;
    const restore = codec === 'h264' ? preferHardwareH264For(sendVideo, (message) => micLog('warn', message)) : null;
    try {
      // NOTE: for ScreenShare sources LiveKit reads `screenShareEncoding`, not `videoEncoding`.
      // Passing videoEncoding (as before) was silently ignored and LiveKit's default applied:
      // 2.5 Mbps at 15 FPS plus a half-resolution simulcast layer, which smeared fast motion.
      await room.localParticipant.publishTrack(sendVideo, {
        source: Track.Source.ScreenShare,
        name: 'screen',
        videoCodec: codec,
        backupCodec: false,
        screenShareEncoding: { maxBitrate: options.maxBitrate, maxFramerate: options.frameRate, priority: 'high' },
        // One full-quality layer: every viewer gets the real resolution/bitrate instead of a
        // half-resolution layer chosen because their video element is small.
        simulcast: false,
        // 0.4.2: maintain-framerate let the VP8 encoder halve the picture (1080p -> 720p -> 480x270,
        // qualityLimitationReason "bandwidth" = its QP quality scaler) while FPS stayed ~55.
        degradationPreference: livekitDegradation(options),
      });
    } finally {
      restore?.();
    }
    await this.enforceScreenEncoding(room, options);
  }

  /** 0.4.7: a reason hardware H.264 cannot work on this machine, known before publishing (null = try it). */
  private async hardwareH264Blocker(): Promise<HardwareFallbackReason | null> {
    this.gpuVideoEncode = null;
    if (desktop) {
      const info = await desktop.app.getInfo().catch(() => null);
      this.gpuVideoEncode = info?.videoEncodeStatus ?? null;
      desktop.app.log('info', `[stream] GPU video encoding: ${info?.videoEncodeStatus ?? 'unknown'}, hardware acceleration ${String(info?.hardwareAccelerationActive)}`);
      // Hardware acceleration switched off in Settings: no GPU encoder at all, VP8 directly.
      // (Chromium's own video_encode status reads "disabled" for a moment while the GPU process starts,
      // so it does not block on its own; it names the reason if the encoder check later fails.)
      if (info && !info.hardwareAccelerationActive) return 'gpuDisabled';
    }
    if (!canAlignFrames()) return 'alignUnsupported';
    const codecs = typeof RTCRtpSender !== 'undefined' && 'getCapabilities' in RTCRtpSender ? RTCRtpSender.getCapabilities('video')?.codecs : undefined;
    if (!codecs || !hardwareH264Preferences(codecs)) return 'noHardwareProfile';
    return null;
  }

  /** 0.4.7: what our own stream really runs on (stream statistics). */
  getScreenEncoderDiagnostics(): StreamEncoderDiagnostics | null {
    return this.screenDiagnostics;
  }

  private setScreenDiagnostics(patch: Partial<StreamEncoderDiagnostics>): void {
    if (this.screenDiagnostics) this.screenDiagnostics = { ...this.screenDiagnostics, ...patch };
  }

  /**
   * 0.4.7: after an H.264 start, waits (up to ENCODER_CHECK_WINDOW_MS) until WebRTC reports the
   * negotiated codec and the encoder that really runs, then:
   *  - hardware H.264: done;
   *  - the SFU answered another codec: that codec stays (no republish), reason "serverRejected";
   *  - H.264 Constrained Baseline in software: VP8 right away, reason "softwareProfile";
   *  - a hardware profile but a software encoder, or no report at all: ONE clean H.264 retry, then VP8.
   * Every decision is logged and shown in the stream statistics.
   */
  private async checkScreenEncoder(room: Room, original: MediaStreamTrack, options: ScreenSharePublishOptions, generation: number): Promise<void> {
    let started = Date.now();
    let last: EncoderReport | null = null;
    let waitingLogged = false;
    while (Date.now() - started < ENCODER_CHECK_WINDOW_MS) {
      await new Promise((r) => setTimeout(r, ENCODER_CHECK_POLL_MS));
      if (this.room !== room || this.screenGeneration !== generation) return;
      const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (!track) return;
      last = await readEncoderReport(track);
      // 0.5.2: no frame encoded yet because the SOURCE sent none (a minimized or static window:
      // Windows Graphics Capture only delivers changes). That says nothing about the encoder, so
      // the check window starts over instead of ending in "timeout" -> software VP8 (seen in 0.5.1).
      if (original.readyState === 'live' && (!last || last.framesEncoded === 0) && (await this.captureIdle(track))) {
        if (!waitingLogged && desktop) desktop.app.log('info', '[stream] encoder check: waiting for the first captured frame');
        waitingLogged = true;
        started = Date.now();
        continue;
      }
      if (!last) continue;
      this.setScreenDiagnostics({
        negotiatedCodec: last.codec,
        negotiatedProfile: last.codec === 'H264' ? describeH264(last.fmtp) : null,
        encoder: last.implementation,
        hardware: last.implementation ? last.hardware : null,
      });
      if (last.codec && last.codec !== 'H264') break;
      // Decide on a settled encoder: frames went out and the first second (hardware init) has passed.
      if (last.implementation && last.framesEncoded > 0 && Date.now() - started >= 1500) break;
    }
    if (this.room !== room || this.screenGeneration !== generation) return;
    const attempts = this.screenDiagnostics?.attempts ?? 1;
    const summary = last
      ? `codec ${last.codec ?? '?'}${last.fmtp ? ` (${describeH264(last.fmtp) ?? last.fmtp})` : ''}, implementation ${last.implementation ?? '?'}, hardware ${String(last.hardware)}, frames ${last.framesEncoded}`
      : 'no report';
    if (desktop) desktop.app.log('info', `[stream] encoder check (attempt ${attempts}): ${summary}`);
    let reason: HardwareFallbackReason;
    let retry = false;
    if (!last?.codec || !last.implementation) {
      reason = 'timeout';
      retry = attempts < 2;
    } else if (last.codec !== 'H264') {
      // The SFU picked another codec for this publish; it already runs, nothing to republish.
      this.screenCodec = 'vp8';
      this.setScreenDiagnostics({ fallbackReason: 'serverRejected', state: 'done' });
      if (desktop) desktop.app.log('warn', `[stream] the server accepted no hardware H.264 profile; running ${last.codec}`);
      return;
    } else if (last.hardware) {
      this.setScreenDiagnostics({ fallbackReason: null, state: 'done' });
      return;
    } else if (isConstrainedBaseline(parseProfileLevelId(last.fmtp))) {
      reason = 'softwareProfile';
    } else {
      reason = 'encoderUnavailable';
      retry = attempts < 2;
    }
    // The GPU reported no video encoding: name that instead of a generic encoder failure.
    if ((reason === 'encoderUnavailable' || reason === 'timeout') && this.gpuVideoEncode !== null && !this.gpuVideoEncode.startsWith('enabled')) reason = 'gpuDisabled';
    if (retry) {
      if (desktop) desktop.app.log('warn', `[stream] hardware H.264 not ready (${reason}); one clean retry`);
      this.setScreenDiagnostics({ attempts: attempts + 1, encoder: null, hardware: null, negotiatedCodec: null, negotiatedProfile: null });
      if (await this.republishScreenVideo(room, original, options, 'h264')) void this.checkScreenEncoder(room, original, options, this.screenGeneration);
      return;
    }
    if (desktop) desktop.app.log('warn', `[stream] hardware H.264 unavailable (${reason}); republishing the stream with VP8`);
    this.setScreenDiagnostics({ fallbackReason: reason, state: 'done', encoder: null, hardware: null, negotiatedCodec: null, negotiatedProfile: null });
    await this.republishScreenVideo(room, original, options, 'vp8');
  }

  /** 0.5.2: true while the capture has delivered no frame at all (media-source stats). */
  private async captureIdle(track: { getRTCStatsReport: () => Promise<RTCStatsReport | undefined> }): Promise<boolean> {
    const report = await track.getRTCStatsReport().catch(() => undefined);
    if (!report) return false;
    const found = { frames: -1 };
    report.forEach((s: Record<string, unknown>) => {
      if (s.type === 'media-source' && s.kind === 'video' && typeof s.frames === 'number') found.frames = s.frames;
    });
    return found.frames === 0;
  }

  /** Replaces the published screen video (same capture, audio untouched) with a new codec. */
  private async republishScreenVideo(room: Room, original: MediaStreamTrack, options: ScreenSharePublishOptions, codec: 'h264' | 'vp8'): Promise<boolean> {
    const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    try {
      if (track) {
        // The aligned track may stop, the capture behind it must not.
        const old = track.mediaStreamTrack;
        releaseCapture(old);
        // 0.5.0 fix: without this, LocalTrackUnpublished treated the swap as "stream stopped" and
        // stopped the capture (in 0.4.6 the VP8 fallback ended the whole stream).
        this.republishing = true;
        try {
          await room.localParticipant.unpublishTrack(track, old !== original);
        } finally {
          this.republishing = false;
        }
        this.captureTracks = this.captureTracks.filter((t) => t !== old || t === original);
      }
      if (this.room !== room || original.readyState === 'ended') return false;
      await this.publishScreenVideo(room, original, options, codec);
      this.syncParticipants();
      return true;
    } catch (error) {
      micLog('warn', `Stream codec switch failed: ${error instanceof Error ? error.message : 'error'}`);
      return false;
    }
  }

  /**
   * Live change of a running share (0.3.1): a new source (other window / screen, system audio on or
   * off) or new quality, WITHOUT ending the stream. The captured track is swapped inside the same
   * LiveKit publications (RTCRtpSender.replaceTrack), so viewers keep the same stream view and the
   * new picture simply continues; they get a short "switching source" notice. Every new source gets
   * exactly the same treatment as the first one: content hint, degradation preference, bitrate and
   * frame-rate limits are applied again and read back.
   */
  async replaceScreenShare(stream: MediaStream, options: ScreenSharePublishOptions, source: Pick<ShareConfig, 'sourceId' | 'sourceKind'>): Promise<boolean> {
    const room = this.room;
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    const publication = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const current = publication?.track as LocalVideoTrack | undefined;
    if (!room || room.state !== ConnectionState.Connected || !video || !current) {
      // Nothing running (or it just ended): a normal start.
      return this.publishScreenShare(stream, options, source);
    }
    this.announceSwitch(room);
    const previous = this.captureTracks;
    this.captureTracks = stream.getTracks();
    try {
      this.applyContentHint(video, options.contentMode);
      // Same codec as the running stream: hardware H.264 needs the aligned frames again.
      const sendVideo = this.screenCodec === 'h264' ? alignedTrack(video) : video;
      if (sendVideo !== video) {
        this.applyContentHint(sendVideo, options.contentMode);
        this.captureTracks = [...this.captureTracks, sendVideo];
      }
      await current.replaceTrack(sendVideo, true);
      await current.setDegradationPreference(livekitDegradation(options));
      await this.enforceScreenEncoding(room, options);
      const audioPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      if (audio && audioPub?.track) await audioPub.track.replaceTrack(audio, true);
      else if (audio) await this.publishScreenAudio(room, audio);
      else if (audioPub?.track) await room.localParticipant.unpublishTrack(audioPub.track, false);
    } catch (error) {
      micLog('warn', `Stream source switch failed: ${error instanceof Error ? error.message : 'error'}`);
      for (const t of stream.getTracks()) t.stop();
      this.captureTracks = previous;
      toast.error(t('voice.errors.screenFailed'), 'screen-share');
      return false;
    }
    for (const t of previous) if (!this.captureTracks.includes(t)) t.stop();
    this.updateShareConfig(options, source);
    this.thumbnails.start(video);
    return true;
  }

  /** Quality-only change of the running share (same source): constraints + sender, no new capture. */
  async updateScreenShareQuality(options: ScreenSharePublishOptions, size: { width: number; height: number }, captureFps: number): Promise<boolean> {
    const room = this.room;
    const current = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
    if (!room || !current) return false;
    // 0.4.6: constraints go to the capture itself (behind the frame-alignment step, if any).
    const track = captureSourceOf(current.mediaStreamTrack);
    try {
      await track.applyConstraints({ width: { max: size.width }, height: { max: size.height }, frameRate: { ideal: captureFps, max: captureFps } });
      this.applyContentHint(track, options.contentMode);
      if (track !== current.mediaStreamTrack) this.applyContentHint(current.mediaStreamTrack, options.contentMode);
      await current.setDegradationPreference(livekitDegradation(options));
      await this.enforceScreenEncoding(room, options);
    } catch (error) {
      micLog('warn', `Stream quality change failed: ${error instanceof Error ? error.message : 'error'}`);
      return false;
    }
    const prev = useVoiceStore.getState().shareConfig;
    this.updateShareConfig(options, { sourceId: prev?.sourceId ?? null, sourceKind: prev?.sourceKind ?? null });
    return true;
  }

  private applyContentHint(video: MediaStreamTrack, mode: 'game' | 'text'): void {
    // "text" is the sharpest hint for code/documents; fall back to "detail" where it is unknown.
    video.contentHint = mode === 'game' ? 'motion' : 'text';
    if (mode !== 'game' && video.contentHint !== 'text') video.contentHint = 'detail';
  }

  private async publishScreenAudio(room: Room, audio: MediaStreamTrack): Promise<void> {
    await room.localParticipant.publishTrack(audio, {
      source: Track.Source.ScreenShareAudio,
      name: 'screen-audio',
      audioPreset: AudioPresets.musicHighQualityStereo,
      forceStereo: true,
      dtx: false,
      red: false,
    });
  }

  /** Viewers show "switching stream source…" until the next frame (best effort, no content). */
  private announceSwitch(room: Room): void {
    const payload = new TextEncoder().encode(JSON.stringify({ type: 'switching' }));
    void room.localParticipant.publishData(payload, { reliable: true, topic: STREAM_TOPIC }).catch(() => undefined);
    // Ordered after the switching notice so viewers accept the new generation, with consent off.
    streamInteractions.sourceChanged();
  }

  /** Records what the share really runs with (track settings + sender limits), for the UI. */
  private updateShareConfig(options: ScreenSharePublishOptions, source: Pick<ShareConfig, 'sourceId' | 'sourceKind'>): void {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (!track) {
      useVoiceStore.setState({ shareConfig: null });
      return;
    }
    const settings = track.mediaStreamTrack.getSettings();
    const layer = this.readScreenSenderInfo()?.layers[0];
    useVoiceStore.setState({
      shareConfig: {
        ...source,
        width: settings.width ?? null,
        height: settings.height ?? null,
        maxFramerate: layer?.maxFramerate ?? null,
        maxBitrate: layer?.maxBitrate ?? null,
        contentMode: options.contentMode,
        systemAudio: this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined,
      },
    });
  }

  /** Reads the sender parameters back, re-applies the requested limits if needed and logs them. */
  private async enforceScreenEncoding(room: Room, options: ScreenSharePublishOptions): Promise<void> {
    const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    const sender = track?.sender;
    if (!track || !sender) return;
    try {
      const params = sender.getParameters() as Omit<RTCRtpSendParameters, 'degradationPreference'> & { degradationPreference?: StreamDegradation };
      const top = params.encodings[0];
      const wanted = degradationFor(options);
      // 0.4.2: the single layer must stay full size (scaleResolutionDownBy 1) and keep the priority.
      if (top && (top.maxBitrate !== options.maxBitrate || top.maxFramerate !== options.frameRate || (top.scaleResolutionDownBy ?? 1) !== 1 || params.degradationPreference !== wanted)) {
        top.maxBitrate = options.maxBitrate;
        top.maxFramerate = options.frameRate;
        top.scaleResolutionDownBy = 1;
        params.degradationPreference = wanted;
        try {
          await sender.setParameters(params as unknown as RTCRtpSendParameters);
        } catch (error) {
          // An older engine without 'maintain-framerate-and-resolution': keep the resolution at least.
          if (wanted !== 'maintain-framerate-and-resolution') throw error;
          const retry = sender.getParameters() as Omit<RTCRtpSendParameters, 'degradationPreference'> & { degradationPreference?: StreamDegradation };
          if (retry.encodings[0]) Object.assign(retry.encodings[0], { maxBitrate: options.maxBitrate, maxFramerate: options.frameRate, scaleResolutionDownBy: 1 });
          retry.degradationPreference = 'maintain-resolution';
          await sender.setParameters(retry as unknown as RTCRtpSendParameters);
          micLog('warn', 'maintain-framerate-and-resolution is not supported here; using maintain-resolution');
        }
      }
      this.screenRequested = options.width && options.height ? { width: options.width, height: options.height } : null;
    } catch (error) {
      micLog('warn', `Could not apply screen-share encoding: ${error instanceof Error ? error.message : 'error'}`);
    }
    this.screenSenderInfo = this.readScreenSenderInfo();
    const info = this.screenSenderInfo;
    if (info) {
      const layers = info.layers.map((l) => `${l.maxBitrate ?? '?'} bps @ ${l.maxFramerate ?? '?'} fps${l.scaleResolutionDownBy && l.scaleResolutionDownBy > 1 ? ` /${l.scaleResolutionDownBy}` : ''}`).join(', ');
      if (desktop) desktop.app.log('info', `[stream] published ${options.contentMode}: hint ${info.contentHint}, degradation ${info.degradationPreference ?? 'default'}, layers: ${layers}`);
    }
    // What the capturer really agreed to, then what it really delivers once running.
    const settings = captureSourceOf(track.mediaStreamTrack).getSettings();
    if (desktop) desktop.app.log('info', `[stream] capture settings: ${settings.width ?? '?'}x${settings.height ?? '?'} @ ${settings.frameRate ?? '?'} fps (requested ${options.frameRate})`);
    this.clearFpsCheck();
    this.fpsCounters = null;
    this.fpsCheckTimer = setTimeout(() => {
      this.fpsCheckTimer = null;
      void this.logScreenFps(room, options.frameRate);
      // 0.5.2: keep measuring while the stream runs (one line every 30 s), so a drop that starts
      // later (game load, network) is in the log with its reason, not only the first seconds.
      this.fpsMonitorTimer = setInterval(() => void this.logScreenFps(room, options.frameRate), STREAM_MONITOR_MS);
    }, 6000);
  }

  private async logScreenFps(room: Room, target: number): Promise<void> {
    const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (this.room !== room || !desktop || !track) {
      if (!track) this.clearFpsCheck();
      return;
    }
    try {
      const report = await track.getRTCStatsReport();
      const parsed = parseStreamStats(report, this.fpsCounters);
      this.fpsCounters = parsed.counters;
      const stats = parsed.stats;
      if (!stats) return;
      const available = availableOutgoingBitrate(report);
      const mbps = (bps: number | null) => (bps === null ? '?' : (bps / 1_000_000).toFixed(1));
      const low = stats.fps !== null && stats.fps < target * 0.85;
      desktop.app.log(
        low ? 'warn' : 'info',
        `[stream] measured: capture ${stats.captureFps ?? '?'} fps, encode ${stats.encodeFps ?? '?'} fps, sending ${stats.fps ?? '?'} fps at ${stats.width ?? '?'}x${stats.height ?? '?'} (target ${target}), ` +
          `${mbps(stats.bitrateBps)} Mbps (network estimate ${mbps(available)} Mbps), loss ${stats.lossPercent === null ? '?' : stats.lossPercent.toFixed(1)} %, rtt ${stats.rttMs ?? '?'} ms, ` +
          `limitation ${stats.limitation ?? 'unknown'}, encoder ${stats.implementation ?? '?'}`,
      );
    } catch {
      /* stats unavailable */
    }
  }

  private clearFpsCheck(): void {
    if (this.fpsCheckTimer) clearTimeout(this.fpsCheckTimer);
    if (this.fpsMonitorTimer) clearInterval(this.fpsMonitorTimer);
    this.fpsCheckTimer = null;
    this.fpsMonitorTimer = null;
  }

  private readScreenSenderInfo(): ScreenShareSenderInfo | null {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    const sender = track?.sender;
    if (!track || !sender) return null;
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    return {
      contentHint: track.mediaStreamTrack.contentHint || 'none',
      degradationPreference: params.degradationPreference ?? null,
      layers: params.encodings.map((e) => ({
        maxBitrate: e.maxBitrate ?? null,
        maxFramerate: e.maxFramerate ?? null,
        scaleResolutionDownBy: e.scaleResolutionDownBy ?? null,
        active: e.active !== false,
      })),
    };
  }

  /** Live sender configuration of our own screen share (for "Stream details"). */
  getScreenShareSenderInfo(): ScreenShareSenderInfo | null {
    return this.readScreenSenderInfo() ?? this.screenSenderInfo;
  }

  /** 0.4.2: the selected resolution and what the capturer really delivers (for "Stream details"). */
  getScreenShareResolutions(): {
    requested: { width: number; height: number } | null;
    capture: { width: number | null; height: number | null } | null;
    /** 0.4.6: the capture track's own frame rate setting (the 120 Hz poll), or null. */
    captureRate: number | null;
  } {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    const settings = track ? captureSourceOf(track.mediaStreamTrack).getSettings() : undefined;
    return {
      requested: this.screenRequested,
      capture: settings ? { width: settings.width ?? null, height: settings.height ?? null } : null,
      captureRate: settings?.frameRate ?? null,
    };
  }

  private stopCaptureTracks(): void {
    this.clearFpsCheck();
    this.thumbnails.stop();
    for (const track of this.captureTracks) track.stop();
    this.captureTracks = [];
  }

  /** Our own share shows as a preview tile (it is local: nothing is subscribed). */
  private watchOwnShare(room: Room, source: StreamSource = 'screen'): void {
    const key = streamKey(room.localParticipant.identity, source);
    const { watchedShares } = useVoiceStore.getState();
    if (!watchedShares.includes(key)) useVoiceStore.setState({ watchedShares: [...watchedShares, key], endedShare: null });
  }

  /**
   * 0.4.5 "Watch stream": subscribe to that stream and add it to the viewer. 0.5.0: `key` is a
   * stream key (see streamKey): the identity for a screen share, identity + "#camera" for a webcam.
   */
  watchShare(key: string): void {
    const { watchedShares } = useVoiceStore.getState();
    if (!watchedShares.includes(key)) {
      const firstRemoteScreen = !key.endsWith('#camera') && key !== this.room?.localParticipant.identity && !watchedShares.some((id) => !id.endsWith('#camera') && id !== this.room?.localParticipant.identity);
      useVoiceStore.setState({ watchedShares: [...watchedShares, key], endedShare: null, ...(firstRemoteScreen ? { audioShare: key } : {}) });
      playSound('streamWatch');
    }
    if (this.room) this.applySubscriptions(this.room);
    this.applyRemoteVolumes();
    this.publishWatching();
  }

  selectStreamAudio(key: string | null): void {
    const state = useVoiceStore.getState();
    if (key !== null && (!state.watchedShares.includes(key) || key.endsWith('#camera') || key === this.room?.localParticipant.identity)) return;
    useVoiceStore.setState({ audioShare: key });
    this.applyRemoteVolumes();
  }

  /** Stops watching one stream (its video and audio are unsubscribed; the streamer is not affected). */
  stopWatching(key: string): void {
    const { watchedShares, focusedShare, audioShare } = useVoiceStore.getState();
    useVoiceStore.setState({ watchedShares: watchedShares.filter((id) => id !== key), focusedShare: focusedShare === key ? null : focusedShare, audioShare: audioShare === key ? null : audioShare });
    if (this.room) this.applySubscriptions(this.room);
    this.applyRemoteVolumes();
    this.publishWatching();
  }

  /** Makes one watched share the big one (watching it first if needed); null = equal grid. */
  focusShare(identity: string | null): void {
    if (identity) this.watchShare(identity);
    useVoiceStore.setState({ focusedShare: identity, endedShare: null });
    if (this.room) this.applyStreamQuality(this.room);
  }

  /**
   * 0.4.5: microphones always; screen-share video + audio only for watched shares. Idempotent,
   * runs on every publication change. Only the subscription changes: the streamer never republishes.
   */
  private applySubscriptions(room: Room): void {
    if (this.room !== room) return;
    const watched = new Set(useVoiceStore.getState().watchedShares);
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        const remote = publication;
        const screen = watched.has(streamKey(participant.identity, 'screen'));
        const camera = watched.has(streamKey(participant.identity, 'camera'));
        const want =
          remote.source === Track.Source.Microphone || ((remote.source === Track.Source.ScreenShare || remote.source === Track.Source.ScreenShareAudio) && screen) || (remote.source === Track.Source.Camera && camera);
        if (remote.isSubscribed !== want) remote.setSubscribed(want);
      }
    }
    this.applyStreamQuality(room);
  }

  /** The focused (or only) watched stream asks for the highest layer; the others for medium. */
  private applyStreamQuality(room: Room): void {
    const { watchedShares, focusedShare } = useVoiceStore.getState();
    for (const key of watchedShares) {
      const { identity, source } = parseStreamKey(key);
      const publication = room.remoteParticipants.get(identity)?.getTrackPublication(source === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare);
      if (!publication) continue;
      const high = watchedShares.length === 1 || focusedShare === key || focusedShare === null;
      publication.setVideoQuality(high ? VideoQuality.HIGH : VideoQuality.MEDIUM);
    }
  }

  /**
   * 0.4.0 diagnostics: raw WebRTC stats of our microphone sender and of one remote microphone,
   * plus LiveKit's connection state. Nothing is sent anywhere.
   */
  async getVoiceStatsReports(): Promise<{ state: string; local: RTCStatsReport | null; remote: RTCStatsReport | null; remoteName: string | null }> {
    const room = this.room;
    if (!room) return { state: 'disconnected', local: null, remote: null, remoteName: null };
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    const local = mic ? ((await mic.getRTCStatsReport().catch(() => undefined)) ?? null) : null;
    let remote: RTCStatsReport | null = null;
    let remoteName: string | null = null;
    for (const participant of room.remoteParticipants.values()) {
      const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track) continue;
      remote = (await track.getRTCStatsReport().catch(() => undefined)) ?? null;
      remoteName = participant.name ?? participant.identity;
      if (remote) break;
    }
    return { state: room.state, local, remote, remoteName };
  }

  /** The screen-share video track of a participant (local or remote), for the stream view. */
  getScreenShareTrack(identity: string): VideoTrack | null {
    return this.getStreamTrack(identity);
  }

  /** 0.5.0: the video track of one stream (screen share or camera, by stream key). */
  getStreamTrack(key: string): VideoTrack | null {
    const room = this.room;
    if (!room) return null;
    const { identity, source } = parseStreamKey(key);
    const participant: Participant | undefined = room.localParticipant.identity === identity ? room.localParticipant : room.remoteParticipants.get(identity);
    const track = participant?.getTrackPublication(source === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare)?.track;
    return track && track.kind === Track.Kind.Video ? (track as VideoTrack) : null;
  }

  // ---- 0.5.0 webcam ------------------------------------------------------------------

  /**
   * Publishes a camera track the picker already opened (its preview), as the Camera source: a
   * normal LiveKit publication next to the microphone and (if any) the screen share, watched by
   * choice like a stream. Standard getUserMedia only (no Electron API), so the web and a future
   * mobile client use the same code. VP8, one layer; the screen-share codec path is untouched.
   */
  async publishCamera(track: MediaStreamTrack, preset: { width: number; height: number; frameRate: number }): Promise<boolean> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected || track.readyState === 'ended') {
      track.stop();
      return false;
    }
    if (!this.canStream()) {
      track.stop();
      return false;
    }
    if (room.localParticipant.isCameraEnabled) await this.stopCamera();
    const bitrate = cameraBitrate(preset);
    try {
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Camera,
        name: 'camera',
        videoCodec: 'vp8',
        backupCodec: false,
        simulcast: false,
        videoEncoding: { maxBitrate: bitrate, maxFramerate: preset.frameRate, priority: 'high' },
        degradationPreference: 'balanced',
      });
    } catch (error) {
      track.stop();
      micLog('warn', `Camera publish failed: ${error instanceof Error ? error.message : 'error'}`);
      toast.error(t('camera.errors.publish'), 'camera');
      return false;
    }
    if (this.room !== room) {
      track.stop();
      return false;
    }
    // Unplugged / taken by another app: the track ends; the publication goes with it.
    track.addEventListener('ended', () => {
      if (this.room !== room || !room.localParticipant.isCameraEnabled) return;
      toast.error(t('camera.errors.disconnected'), 'camera');
      void this.stopCamera();
    });
    useVoiceStore.setState({ localCamera: true });
    this.watchOwnShare(room, 'camera');
    playSound('shareStart');
    this.publishDeafen();
    this.syncParticipants();
    if (desktop) desktop.app.log('info', `[camera] published ${preset.width}x${preset.height} @ ${preset.frameRate} (${Math.round(bitrate / 1000)} kbps)`);
    return true;
  }

  async stopCamera(): Promise<void> {
    const room = this.room;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera);
    if (room && publication?.track) await room.localParticipant.unpublishTrack(publication.track, true).catch(() => undefined);
    useVoiceStore.setState((s) => ({ localCamera: false, watchedShares: room ? s.watchedShares.filter((k) => k !== streamKey(room.localParticipant.identity, 'camera')) : s.watchedShares }));
    this.publishDeafen();
    this.syncParticipants();
  }

  // ---- internals -------------------------------------------------------------------

  private bindRoom(room: Room): void {
    this.stopStreamInteractions?.();
    this.stopStreamInteractions = bindStreamInteractions(room);
    // Every room event re-derives the participant list, but one microtask later: during a full
    // reconnect LiveKit first emits ParticipantDisconnected for everybody and only then switches
    // to Reconnecting. Deferring lets reconcileParticipants() see the real connection phase.
    const sync = () => {
      if (this.room === room) this.scheduleSync();
    };
    room
      .on(RoomEvent.ParticipantConnected, sync)
      .on(RoomEvent.ParticipantDisconnected, sync)
      .on(RoomEvent.ParticipantNameChanged, sync)
      .on(RoomEvent.TrackPublished, () => {
        this.applySubscriptions(room);
        sync();
      })
      .on(RoomEvent.TrackUnpublished, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync)
      .on(RoomEvent.ActiveSpeakersChanged, sync)
      .on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        // Safety net for a microphone published some other way: attach the pipeline if it is missing.
        if (publication.source === Track.Source.Microphone && publication.track instanceof LocalAudioTrack && !publication.track.getProcessor() && this.room === room) {
          void this.attachMicPipeline(room, publication.track);
        }
        sync();
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        // 0.5.5: a newcomer in a "room" channel learns where everyone stands.
        this.announceRoomPosition(room);
        if (this.room !== room) return;
        this.applyRemoteVolumes();
        if (this.soundGate.joined(participant.identity, this.isStableRoom(room))) playSound('userJoin');
        this.applySubscriptions(room);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        if (this.room !== room) return;
        // While we leave, LiveKit "disconnects" everybody: that is not them leaving.
        if (this.soundGate.left(participant.identity, this.isStableRoom(room))) playSound('userLeave');
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
        // The browser's own "Stop sharing" bar ends the track without going through stopScreenShare().
        if (publication.source === Track.Source.Camera && this.room === room) {
          useVoiceStore.setState({ localCamera: false });
          playSound('shareStop');
          this.publishDeafen();
        }
        if (publication.source === Track.Source.ScreenShare && this.room === room && !this.republishing) {
          useVoiceStore.setState({ localScreenSharing: false, shareConfig: null });
          playSound('shareStop');
          // The shared window closed or the display went away: drop the matching system audio too.
          const screenAudio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
          if (screenAudio) void room.localParticipant.unpublishTrack(screenAudio).catch(() => undefined);
          this.stopCaptureTracks();
        }
        sync();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
        if (track.kind === Track.Kind.Audio) {
          this.attachAudio(track, publication.trackSid);
          if (publication.source === Track.Source.ScreenShareAudio && this.room === room) void this.applyStreamOutput();
          this.applyRemoteVolumes();
          if (publication.source === Track.Source.Microphone && this.room === room) this.speaking?.addRemote(participant.identity, track.mediaStreamTrack);
        }
        sync();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
        if (track.kind === Track.Kind.Audio) this.detachAudio(track, publication.trackSid);
        if (publication.source === Track.Source.Microphone) this.speaking?.removeRemote(participant.identity);
        sync();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
        if (this.room !== room) return;
        if (participant.identity === room.localParticipant.identity) useVoiceStore.setState({ quality: qualityLevel(quality) });
        sync();
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
        if (topic === ROOM_TOPIC && participant && this.room === room) {
          try {
            const data = JSON.parse(new TextDecoder().decode(payload)) as { x?: unknown; y?: unknown };
            if (typeof data.x !== 'number' || typeof data.y !== 'number' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
            const { roomPositions } = useVoiceStore.getState();
            useVoiceStore.setState({ roomPositions: { ...roomPositions, [participant.identity]: clampToRoom({ x: data.x, y: data.y }) } });
            this.applyRemoteVolumes();
          } catch {
            /* not a position */
          }
          return;
        }
        if (topic !== STREAM_TOPIC || !participant || this.room !== room) return;
        try {
          const data = JSON.parse(new TextDecoder().decode(payload)) as { type?: unknown };
          if (data.type !== 'switching') return;
        } catch {
          return;
        }
        const { shareSwitching } = useVoiceStore.getState();
        useVoiceStore.setState({ shareSwitching: { ...shareSwitching, [participant.identity]: Date.now() } });
      })
      .on(RoomEvent.Moved, (roomName: string) => {
        // 0.4.0: a moderator moved us; LiveKit already switched our connection to the new room.
        if (this.room !== room) return;
        const channelId = roomName.startsWith('voice-') ? roomName.slice('voice-'.length) : null;
        if (!channelId) return;
        const previous = useVoiceStore.getState().channelId;
        useVoiceStore.setState({ channelId });
        this.seedKnownRemote(room);
        if (previous) this.removeSelfFromOccupancy(previous);
        toast.info(t('voice.moved'), 'voice-moved');
        sync();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (this.room === room) useVoiceStore.setState({ audioBlocked: !room.canPlaybackAudio });
      })
      .on(RoomEvent.MediaDevicesError, (error: Error) => {
        micLog('warn', `Media device error: ${error.name}`);
        if (this.room === room) useVoiceStore.setState({ micError: microphoneErrorMessage(error) });
      })
      .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
        if (this.room !== room) return;
        if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
          // Old numbers would be stale; the sampler fills them in again once media flows.
          useVoiceStore.setState({ status: 'reconnecting', stats: null });
        } else if (state === ConnectionState.Connected) {
          useVoiceStore.setState({ status: 'connected' });
          // Restored participants are not new arrivals.
          this.seedKnownRemote(room);
          this.applySubscriptions(room);
          sync();
        }
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.room !== room || this.leaving) return;
        // Removed as part of a move (old LiveKit without MoveParticipant): followMove() rejoins quietly.
        if (reason === DisconnectReason.PARTICIPANT_REMOVED && Date.now() - this.moveRequestedAt < 5000) {
          this.cleanupRoom();
          return;
        }
        // LiveKit already retried and gave up, or the server ended our participation.
        const channelId = useVoiceStore.getState().channelId;
        this.cleanupRoom();
        playSound('leave');
        const message = reason === DisconnectReason.DUPLICATE_IDENTITY ? t('voice.errors.duplicate') : reason === DisconnectReason.PARTICIPANT_REMOVED ? t('voice.errors.removed') : t('voice.errors.lost');
        useVoiceStore.setState({ ...INITIAL_VOICE_STATE, ...persistentVoiceState(), status: 'error', channelId, error: message });
        if (channelId) this.removeSelfFromOccupancy(channelId);
      });
  }

  /**
   * 0.4.0: the server told us we were moved to another voice channel. Normally LiveKit has already
   * moved the connection (RoomEvent.Moved); otherwise (fallback) we were removed and rejoin here.
   */
  async followMove(channelId: string, rejoin = false): Promise<void> {
    this.moveRequestedAt = Date.now();
    // 0.5.9: the server says LiveKit did not move us: rejoin at once (this wait cost 1.5 s per move).
    for (let i = 0; i < (rejoin ? 0 : 15); i += 1) {
      const s = useVoiceStore.getState();
      if (s.channelId === channelId && s.status === 'connected' && this.room) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = useVoiceStore.getState();
    if (s.channelId === channelId && s.status === 'connected') return;
    await this.join(channelId);
    if (useVoiceStore.getState().status === 'connected') toast.info(t('voice.moved'), 'voice-moved');
  }

  /** Remembers who is in the room now, without sounds, and stays quiet briefly (LiveKit catch-up). */
  private seedKnownRemote(room: Room): void {
    this.soundGate.seed([...room.remoteParticipants.values()].map((p) => p.identity));
  }

  /** Our room is up and settled: not connecting, reconnecting, leaving or just (re)seeded. */
  private isStableRoom(room: Room): boolean {
    return !this.leaving && room.state === ConnectionState.Connected && useVoiceStore.getState().status === 'connected';
  }

  private scheduleSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.syncParticipants();
    });
  }

  /** After we leave, the sidebar must not keep showing us under that channel (and only us). */
  private removeSelfFromOccupancy(channelId: string): void {
    const selfId = useAuthStore.getState().user?.id;
    if (useVoiceStore.getState().occupancyRealtime) {
      useVoiceStore.setState((state) => applySelfChange(state, selfId));
      return;
    }
    const { occupancy, occupancyLiveAt } = useVoiceStore.getState();
    const list = occupancy[channelId] ?? [];
    useVoiceStore.setState({
      occupancy: { ...occupancy, [channelId]: list.filter((p) => p.identity !== selfId) },
      occupancyLiveAt: { ...occupancyLiveAt, [channelId]: Date.now() },
    });
  }

  private attachAudio(track: RemoteTrack, sid: string): void {
    if (!this.audioContainer) {
      this.audioContainer = document.createElement('div');
      this.audioContainer.id = 'aidis-voice-audio';
      this.audioContainer.hidden = true;
      document.body.appendChild(this.audioContainer);
    }
    const el = track.attach();
    this.audioContainer.appendChild(el);
    this.audioElements.set(sid, [...(this.audioElements.get(sid) ?? []), el]);
  }

  private detachAudio(track: RemoteTrack, sid: string): void {
    for (const el of track.detach()) el.remove();
    for (const el of this.audioElements.get(sid) ?? []) el.remove();
    this.audioElements.delete(sid);
  }

  private cleanupRoom(): void {
    this.stopStreamInteractions?.();
    this.stopStreamInteractions = null;
    this.sharedContext.clear();
    if (this.streamContext) {
      void this.streamContext.close().catch(() => undefined);
      this.streamContext = null;
    }
    this.speaking?.stop();
    this.speaking = null;
    this.sampler?.stop();
    this.sampler = null;
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    this.stopSettingsWatch?.();
    this.stopSettingsWatch = null;
    this.stopChannelWatch?.();
    this.stopChannelWatch = null;
    if (this.roomSendTimer) clearTimeout(this.roomSendTimer);
    this.roomSendTimer = null;
    this.panners.clear();
    useVoiceStore.setState({ roomPositions: {} });
    this.micPipeline = null;
    void this.micContext?.close().catch(() => undefined);
    this.micContext = null;
    this.clearPttTimer();
    this.pttHeld = false;
    this.stopCaptureTracks();
    const room = this.room;
    this.room = null;
    this.publishDeafen();
    if (room) {
      room.removeAllListeners();
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.track) for (const el of pub.track.detach()) el.remove();
        }
      }
    }
    for (const elements of this.audioElements.values()) for (const el of elements) el.remove();
    this.audioElements.clear();
    this.audioContainer?.remove();
    this.audioContainer = null;
  }

  private syncParticipants(): void {
    const room = this.room;
    if (!room) return;
    const toView = (p: Participant, isLocal: boolean): VoiceParticipant => ({
      identity: p.identity,
      name: p.name || p.identity,
      isLocal,
      // Measured on this device when possible (fast); LiveKit's server-side flag otherwise.
      isSpeaking: (isLocal && !this.micPipeline ? undefined : this.speaking?.isSpeaking(p.identity, isLocal)) ?? p.isSpeaking,
      micMuted: !p.isMicrophoneEnabled,
      screenSharing: p.isScreenShareEnabled,
      screenShareAudio: p.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined,
      camera: p.isCameraEnabled,
      connectionLost: !isLocal && p.connectionQuality === ConnectionQuality.Lost,
    });
    const live = [toView(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => toView(p, false))];
    const phase = room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting ? 'reconnecting' : 'connected';

    const current = useVoiceStore.getState();
    const participants = reconcileParticipants(current.participants, live, phase);
    // 0.4.5: streams are never opened automatically. A watched share that ended leaves the viewer
    // (only its tile; the others keep playing) and shows "stream ended" with the streamer's name.
    const { watched: watchedShares } = pruneWatched(participants, current.watchedShares);
    let endedShare = current.endedShare;
    if (phase === 'connected') {
      for (const key of current.watchedShares) {
        if (watchedShares.includes(key)) continue;
        const previous = current.participants.find((p) => p.identity === parseStreamKey(key).identity);
        if (previous && !previous.isLocal) endedShare = previous.name;
      }
    }
    const focusedShare = current.focusedShare && watchedShares.includes(current.focusedShare) ? current.focusedShare : null;
    const watchChanged = watchedShares.length !== current.watchedShares.length;
    // A new remote stream: a short sound, like Discord ("someone went live"), but nothing opens.
    const wasLive = new Set(current.participants.filter((p) => p.screenSharing && !p.isLocal).map((p) => p.identity));
    if (phase === 'connected' && current.participants.length > 0 && participants.some((p) => p.screenSharing && !p.isLocal && !wasLive.has(p.identity))) {
      playSound('streamWatch');
    }

    const channelId = current.channelId;
    // 0.4.2 root-cause fix: the shared sidebar membership is NOT written from the LiveKit room any
    // more when the server pushes it (0.4.1+). While leaving, LiveKit emits ParticipantDisconnected
    // for everyone still in the room; writing that emptied list made the people who stayed vanish,
    // and writing under the store's channelId while switching put people into the wrong channel.
    // Older servers (polling): only a fully connected room that is still ours may update it.
    const writeOccupancy = !current.occupancyRealtime && !this.leaving && room.state === ConnectionState.Connected && this.room === room;
    useVoiceStore.setState({
      participants,
      localScreenSharing: room.localParticipant.isScreenShareEnabled,
      localCamera: room.localParticipant.isCameraEnabled,
      focusedShare,
      watchedShares,
      audioShare: current.audioShare && watchedShares.includes(current.audioShare) ? current.audioShare : null,
      endedShare,
      ...(channelId && writeOccupancy
        ? {
            occupancy: { ...current.occupancy, [channelId]: toOccupancy(participants) },
            occupancyLiveAt: { ...current.occupancyLiveAt, [channelId]: Date.now() },
          }
        : {}),
    });
    if (watchChanged) this.publishWatching();
    if (watchChanged) this.applyRemoteVolumes();
    if (current.localScreenSharing !== room.localParticipant.isScreenShareEnabled || current.localCamera !== room.localParticipant.isCameraEnabled) this.publishDeafen();
  }
}

export const voice = new VoiceService();

/** 0.5.0 camera bitrate: enough for a sharp face cam without hurting a parallel game stream. */
export function cameraBitrate(preset: { width: number; height: number; frameRate: number }): number {
  const base = preset.height >= 1080 ? 4_500_000 : 2_500_000;
  return preset.frameRate >= 50 ? Math.round(base * 1.5) : base;
}
