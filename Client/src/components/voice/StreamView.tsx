import { useCallback, useEffect, useRef, useState } from 'react';
import { useCallNames } from '../../stores/guildStore';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Settings2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  LayoutGrid,
  Maximize,
  MessageSquare,
  MessageSquareX,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  PictureInPicture2,
  Video,
  VideoOff,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { Channel } from '../../api/types';
import type { StreamRef, VoiceParticipant } from '../../voice/voiceStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { voice, type ScreenShareSenderInfo } from '../../voice/voiceService';
import { attachVideo } from '../../voice/popoutVideo';
import { canShareScreen } from '../../voice/screenShareQuality';
import { isCaptureLimited, useStreamStats, type StreamStats } from '../../voice/streamStats';
import { describeH264 } from '../../voice/h264';
import { requestScreenShare } from '../../desktop/screenCapture';
import { isDesktop } from '../../desktop/bridge';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { getLanguage } from '../../i18n';
import { DeafenButton, MicButton } from '../UserPanel';
import { VoiceChatPanel } from './VoiceChatPanel';
import { usePresenceStore } from '../../stores/presenceStore';
import { openStreamPopout, usePopouts } from './StreamPopout';
import { Avatar } from '../Avatar';
import { useAuthStore } from '../../stores/authStore';
import { openCameraPicker } from './CameraPicker';
import { canUseCamera } from '../../voice/camera';
import { useNicknameColor } from '../profile/nicknameColor';
import { StreamInteractions } from './StreamInteractions';

/** Overlay controls fade out after this long without mouse movement. */
const IDLE_MS = 2500;

/**
 * Stream statistics (0.4.7). The real stream frame rate is Encode / Send (streamer) and Receive /
 * Decode (viewer); every row is a measured value, a requested value is labelled as such. "Display
 * FPS" counts how often this client's compositor presented the video element: it can be higher
 * than the number of unique frames received, so it is labelled and explained separately.
 * Whatever the browser does not report is shown as "Unavailable".
 */
export function StatsPanel({ stats, sender, renderFps, camera = false }: { stats: StreamStats | null; sender: ScreenShareSenderInfo | null; renderFps?: number | null; camera?: boolean }) {
  const { t } = useTranslation();
  const locale = getLanguage() === 'ru' ? 'ru-RU' : 'en-US';
  const unknown = t('voice.stats.unavailable');
  if (!stats) {
    return (
      <div className="stream-stats" role="status">
        {t('voice.stats.measuring')}
      </div>
    );
  }
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const fpsText = (value: number | null | undefined) => (value === null || value === undefined ? unknown : t('voice.streamStats.fpsValue', { fps: Math.round(value) }));
  const size = (w: number | null | undefined, h: number | null | undefined) => (w && h ? `${w}×${h}` : unknown);
  const outbound = stats.direction === 'outbound';
  const targetFps = sender?.layers[0]?.maxFramerate ?? null;
  const res = outbound && !camera ? voice.getScreenShareResolutions() : null;
  const diag = outbound && !camera ? voice.getScreenEncoderDiagnostics() : null;
  const captureLimited = outbound && isCaptureLimited(stats, targetFps);
  const reason = stats.limitation ?? (outbound ? null : undefined);
  const reasonText =
    reason === undefined
      ? null
      : reason === null
        ? unknown
        : reason === 'none'
          ? t('voice.streamStats.limitation.none')
          : t(`voice.streamStats.limitation.${reason === 'cpu' || reason === 'bandwidth' ? reason : 'other'}`);
  const scaled = res?.requested && stats.width && stats.height && (stats.width < res.requested.width || stats.height < res.requested.height);
  const hw = stats.hardware === true ? t('voice.streamStats.hardware') : stats.hardware === false ? t('voice.streamStats.software') : null;
  const profile = stats.codec === 'H264' ? (diag?.negotiatedProfile ?? describeH264(stats.fmtp)) : null;
  const hwH264 = !diag
    ? null
    : diag.requestedCodec !== 'H264'
      ? t('voice.streamStats.hwH264.notRequested')
      : diag.state === 'checking'
        ? t('voice.streamStats.hwH264.checking')
        : diag.fallbackReason
          ? t(`voice.streamStats.hwH264.${diag.fallbackReason}`)
          : stats.codec === 'H264' && stats.hardware === true
            ? t('voice.streamStats.hwH264.active')
            : stats.codec === 'H264' && stats.hardware === false
              ? t('voice.streamStats.hwH264.encoderUnavailable')
              : t('voice.streamStats.hwH264.checking');
  return (
    <dl className="stream-stats">
      {outbound && (
        <>
          <dt>{t('voice.streamStats.requested')}</dt>
          <dd>{res?.requested ? `${size(res.requested.width, res.requested.height)}${targetFps ? ` @ ${t('voice.streamStats.fpsValue', { fps: targetFps })}` : ''}` : unknown}</dd>
          <dt>{t('voice.streamStats.fpsCapture')}</dt>
          <dd>
            {fpsText(stats.captureFps)}
            <span className="stream-stats-sub">
              {' '}
              ({res?.capture ? size(res.capture.width, res.capture.height) : unknown}
              {res?.captureRate ? `, ${t('voice.streamStats.captureTrack', { fps: Math.round(res.captureRate) })}` : ''})
            </span>
          </dd>
          <dt>{t('voice.streamStats.fpsEncode')}</dt>
          <dd>{fpsText(stats.encodeFps)}</dd>
          <dt>{t('voice.streamStats.fpsSend')}</dt>
          <dd>{fpsText(stats.fps)}</dd>
          <dt>{t('voice.streamStats.sending')}</dt>
          <dd>{size(stats.width, stats.height)}</dd>
        </>
      )}
      {!outbound && (
        <>
          <dt>{t('voice.streamStats.fpsReceive')}</dt>
          <dd>{fpsText(stats.fps)}</dd>
          <dt>{t('voice.streamStats.fpsDecode')}</dt>
          <dd>{fpsText(stats.decodeFps)}</dd>
          <dt>{t('voice.streamStats.receiving')}</dt>
          <dd>{size(stats.width, stats.height)}</dd>
        </>
      )}
      <dt title={t('voice.streamStats.fpsDisplayHint')}>{t('voice.streamStats.fpsDisplay')}</dt>
      <dd title={t('voice.streamStats.fpsDisplayHint')}>
        {fpsText(renderFps)}
        <span className="stream-stats-sub"> {t('voice.streamStats.fpsDisplayNote')}</span>
      </dd>
      <dt>{t('voice.streamStats.bitrate')}</dt>
      <dd>{stats.bitrateBps === null ? unknown : t('voice.streamStats.mbps', { value: format(stats.bitrateBps / 1_000_000) })}</dd>
      {diag && (
        <>
          <dt>{t('voice.streamStats.codecRequested')}</dt>
          <dd>{diag.requestedCodec}</dd>
        </>
      )}
      <dt>{t('voice.streamStats.codec')}</dt>
      <dd>
        {stats.codec ?? unknown}
        {profile ? <span className="stream-stats-sub"> · {profile}</span> : null}
      </dd>
      <dt>{outbound ? t('voice.streamStats.encoder') : t('voice.streamStats.decoder')}</dt>
      <dd className="stream-stats-impl">
        {hw ? <strong className={stats.hardware ? 'is-hardware' : 'is-software'}>{hw}</strong> : null}
        {hw && stats.implementation ? ' · ' : null}
        {stats.implementation ?? (hw ? null : unknown)}
      </dd>
      {hwH264 && (
        <>
          <dt>{t('voice.streamStats.hwH264.label')}</dt>
          <dd className={diag?.fallbackReason ? 'stream-stats-fallback' : undefined}>{hwH264}</dd>
        </>
      )}
      <dt>{t('voice.stats.loss')}</dt>
      <dd>{stats.lossPercent === null ? unknown : `${format(stats.lossPercent)}%`}</dd>
      <dt>{t('voice.stats.ping')}</dt>
      <dd>{stats.rttMs === null ? unknown : t('voice.stats.ms', { value: stats.rttMs })}</dd>
      {!outbound && (
        <>
          <dt>{t('voice.streamStats.dropped')}</dt>
          <dd>{stats.framesDropped ?? unknown}</dd>
        </>
      )}
      {sender && (
        <>
          <dt>{t('voice.streamStats.target')}</dt>
          <dd>
            {sender.layers[0]?.maxBitrate ? t('voice.streamStats.mbps', { value: format(sender.layers[0].maxBitrate / 1_000_000) }) : unknown}
            {targetFps ? ` · ${targetFps} FPS` : ''}
          </dd>
          <dt>{t('voice.streamStats.hint')}</dt>
          <dd>
            {sender.contentHint}
            {sender.degradationPreference ? ` · ${sender.degradationPreference}` : ''}
          </dd>
        </>
      )}
      {reasonText && (
        <>
          <dt>{t('voice.streamStats.limited')}</dt>
          <dd>{captureLimited ? t('voice.streamStats.limitation.capture') : reasonText}</dd>
        </>
      )}
      {(scaled || (stats.resolutionChanges ?? 0) > 0) && (
        <>
          <dt>{t('voice.streamStats.scaled')}</dt>
          <dd>
            {t('voice.streamStats.scaledValue', { reason: reasonText ?? '—', count: stats.resolutionChanges ?? 0 })}
            {sender?.layers[0]?.scaleResolutionDownBy && sender.layers[0].scaleResolutionDownBy > 1 ? ` · /${sender.layers[0].scaleResolutionDownBy}` : ''}
          </dd>
        </>
      )}
      {captureLimited && <dd className="stream-stats-note">{t('voice.streamStats.captureHint')}</dd>}
    </dl>
  );
}

/** 0.4.6: frames actually painted by this video element per second (requestVideoFrameCallback). */
export function useRenderFps(videoRef: React.RefObject<HTMLVideoElement | null>, enabled: boolean): number | null {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!enabled || !el || !('requestVideoFrameCallback' in el)) return;
    let frames = 0;
    let handle = 0;
    const onFrame = () => {
      frames += 1;
      handle = el.requestVideoFrameCallback(onFrame);
    };
    handle = el.requestVideoFrameCallback(onFrame);
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      setFps((frames * 1000) / (now - last));
      frames = 0;
      last = now;
    }, 1000);
    return () => {
      clearInterval(timer);
      el.cancelVideoFrameCallback(handle);
    };
  }, [videoRef, enabled]);
  return enabled ? fps : null;
}

/** Volume to restore when the stream speaker button unmutes (per streamer, this session). */
const volumeBeforeMute = new Map<string, number>();

/** Local volume of the presenter's stream (game / system) audio. Separate from their voice. */
export function StreamVolume({ presenter }: { presenter: VoiceParticipant }) {
  const { t } = useTranslation();
  const volume = useSettingsStore((s) => s.streamVolumes[presenter.identity] ?? 100);
  const hasAudio = presenter.screenShareAudio === true;
  const Icon = volume === 0 ? VolumeX : volume < 60 ? Volume1 : Volume2;
  const label = t('voice.streamBar.volume');
  return (
    <div className={`stream-volume${hasAudio ? '' : ' is-unavailable'}`} title={hasAudio ? `${label}: ${volume}%` : t('voice.streamBar.noAudio')}>
      <button
        type="button"
        className={`stream-bar-btn${volume === 0 ? ' is-off' : ''}`}
        aria-label={volume === 0 ? t('voice.streamBar.unmuteStream') : t('voice.streamBar.muteStream')}
        aria-pressed={volume === 0}
        disabled={!hasAudio}
        onClick={() => {
          if (volume > 0) volumeBeforeMute.set(presenter.identity, volume);
          voice.setStreamVolume(presenter.identity, volume === 0 ? (volumeBeforeMute.get(presenter.identity) ?? 100) : 0);
        }}
      >
        <Icon size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={volume}
        disabled={!hasAudio}
        aria-label={label}
        aria-valuetext={`${volume}%`}
        onChange={(e) => voice.setStreamVolume(presenter.identity, Number(e.target.value))}
      />
      <span className="stream-volume-value" aria-hidden="true">
        {volume}%
      </span>
    </div>
  );
}

/** Bottom bar of the stream viewer: own mic / headphones, voice chat, share, leave (volume is per tile since 0.4.5). */
function StreamBar({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const canShowGrid = useVoiceStore((s) => s.watchedShares.length > 1 && s.focusedShare !== null);
  const chatOpen = useUiStore((s) => s.voiceChatOpen);
  const chatUnread = useChatStore((s) => s.unread[channel.id] === true);
  const collapsed = useUiStore((s) => s.streamBarCollapsed);
  const sharing = useVoiceStore((s) => s.localScreenSharing);
  const connected = useVoiceStore((s) => s.status === 'connected');
  const setCollapsed = useUiStore((s) => s.setStreamBarCollapsed);
  if (collapsed) {
    return (
      <button type="button" className="stream-bar-handle" aria-label={t('voice.streamBar.show')} title={t('voice.streamBar.show')} onClick={() => setCollapsed(false)}>
        <ChevronUp size={16} />
      </button>
    );
  }
  return (
    <div className="stream-bar" role="toolbar" aria-label={t('voice.streamBar.label')}>
      {canShowGrid && (
        <button type="button" className="stream-bar-btn" aria-label={t('streamExtras.grid')} title={t('streamExtras.grid')} onClick={() => voice.focusShare(null)}>
          <LayoutGrid size={18} />
        </button>
      )}
      <MicButton className="stream-bar-btn" />
      <DeafenButton className="stream-bar-btn" />
      <button
        type="button"
        className={`stream-bar-btn stream-bar-chat${chatOpen ? ' is-active' : ''}${chatUnread && !chatOpen ? ' is-unread' : ''}`}
        aria-pressed={chatOpen}
        aria-label={chatOpen ? t('voice.chat.close') : t('voice.chat.open')}
        title={chatOpen ? t('voice.chat.close') : t('voice.chat.open')}
        onClick={() => useUiStore.getState().setVoiceChat(!chatOpen)}
      >
        {chatOpen ? <MessageSquareX size={18} /> : <MessageSquare size={18} />}
        <span className="stream-bar-label">{t('voice.streamBar.chat')}</span>
      </button>
      {sharing && isDesktop && (
        <button type="button" className="stream-bar-btn" aria-label={t('voice.changeStream')} title={t('voice.changeStream')} onClick={() => useUiStore.getState().setSourcePicker(true, 'change')}>
          <Settings2 size={18} />
        </button>
      )}
      {canShareScreen() && (
        <button
          type="button"
          className={`stream-bar-btn${sharing ? ' is-active' : ''}`}
          aria-pressed={sharing}
          disabled={!connected}
          aria-label={sharing ? t('voice.stopSharing') : t('voice.shareScreen')}
          title={sharing ? t('voice.stopSharing') : t('voice.shareScreen')}
          onClick={() => (sharing ? void voice.stopScreenShare() : requestScreenShare())}
        >
          {sharing ? <MonitorOff size={18} /> : <MonitorUp size={18} />}
        </button>
      )}
      <CameraButton className="stream-bar-btn" connected={connected} />
      <button type="button" className="stream-bar-btn is-leave" aria-label={t('voice.leaveChannel')} title={t('voice.leaveChannel')} onClick={() => void voice.leave()}>
        <PhoneOff size={18} />
      </button>
      <span className="stream-bar-sep" aria-hidden="true" />
      <button type="button" className="stream-bar-btn" aria-label={t('voice.streamBar.hide')} title={t('voice.streamBar.hide')} onClick={() => setCollapsed(true)}>
        <ChevronDown size={18} />
      </button>
    </div>
  );
}

/** 0.5.0: start (opens the camera picker with a preview) / stop our webcam. */
export function CameraButton({ className, connected, withLabel = false }: { className: string; connected: boolean; withLabel?: boolean }) {
  const { t } = useTranslation();
  const on = useVoiceStore((s) => s.localCamera);
  if (!canUseCamera()) return null;
  const label = on ? t('camera.stop') : t('camera.start');
  return (
    <button type="button" className={`${className}${on ? ' is-active' : ''}`} aria-pressed={on} disabled={!connected} aria-label={label} title={label} onClick={() => (on ? void voice.stopCamera() : openCameraPicker())}>
      {on ? <VideoOff size={18} aria-hidden="true" /> : <Video size={18} aria-hidden="true" />}
      {withLabel && <span className="control-label">{label}</span>}
    </button>
  );
}

const VIEWERS_VISIBLE_MS = 3000;
const VIEWER_EVENT_MS = 3500;

/**
 * 0.5.0: who is watching THIS stream (avatars at the top, Discord-like). It floats over the video
 * (no space taken), shows when the stream opens, when the mouse moves over it and when someone
 * comes or goes, and fades out after a few seconds of inactivity. Fullscreen and pop-out included.
 */
function StreamViewersBar({ stream, wakeAt }: { stream: StreamRef; wakeAt: number }) {
  const { t } = useTranslation();
  const viewers = useVoiceStore((s) => s.streamViewers[stream.key]);
  const event = useVoiceStore((s) => s.viewerEvents[stream.key]);
  const users = usePresenceStore((s) => s.users);
  const selfId = useAuthStore((s) => s.user?.id);
  const [visible, setVisible] = useState(true);
  const [recent, setRecent] = useState<{ userId: string; joined: boolean } | null>(null);
  const list = (viewers ?? []).filter((id) => id !== stream.identity);
  const lastChange = Math.max(wakeAt, event?.at ?? 0);
  // Shown on open, on mouse movement and on every join / leave; hidden again after a few seconds.
  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 0);
    const hide = setTimeout(() => setVisible(false), VIEWERS_VISIBLE_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [lastChange, list.length]);
  // "X joined the stream" for a moment (never about yourself).
  useEffect(() => {
    if (!event || event.userId === selfId) return;
    const show = setTimeout(() => {
      if (Date.now() - event.at < VIEWER_EVENT_MS) setRecent({ userId: event.userId, joined: event.joined });
    }, 0);
    const hide = setTimeout(() => setRecent(null), VIEWER_EVENT_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [event, selfId]);
  if (list.length === 0 && !recent) return null;
  const shown = list.slice(0, 8);
  return (
    <div className={`stream-viewers${visible ? ' is-visible' : ''}`} aria-live="polite">
      {shown.length > 0 && (
        <ul className="stream-viewers-avatars" aria-label={t('stream.viewers.label', { count: list.length })}>
          {shown.map((id) => {
            const user = users[id];
            const name = user?.displayName ?? id.slice(0, 6);
            return (
              <li key={id} title={name}>
                <Avatar userId={id} name={name} avatarAttachmentId={user?.avatarAttachmentId} size={24} />
              </li>
            );
          })}
          {list.length > shown.length && <li className="stream-viewers-more">+{list.length - shown.length}</li>}
        </ul>
      )}
      {list.length > 0 && (
        <span className="stream-viewers-count">
          <Eye size={13} aria-hidden="true" />
          {t('stream.viewers.count', { count: list.length })}
        </span>
      )}
      {recent && <span className="stream-viewers-event">{t(recent.joined ? 'stream.viewers.joined' : 'stream.viewers.left', { name: users[recent.userId]?.displayName ?? '' })}</span>}
    </div>
  );
}

/** A watched stream's game / app title (the streamer's current activity), if any. */
function useStreamTitle(identity: string): string | null {
  return usePresenceStore((s) => s.presence[identity]?.activity?.name ?? null);
}

/** Shows "switching source…" after the presenter announced a switch, until a new frame arrives. */
function useSwitching(identity: string, videoRef: React.RefObject<HTMLVideoElement | null>): boolean {
  const switchedAt = useVoiceStore((s) => s.shareSwitching[identity] ?? 0);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!switchedAt || Date.now() - switchedAt > 6000) return;
    const el = videoRef.current;
    let done = false;
    const started = Date.now();
    const finish = () => {
      if (done) return;
      done = true;
      setSwitching(false);
    };
    const show = setTimeout(() => setSwitching(true), 0);
    const cap = setTimeout(finish, 6000);
    let handle = 0;
    const onFrame = () => {
      setTimeout(finish, Math.max(0, 500 - (Date.now() - started)));
    };
    if (el && 'requestVideoFrameCallback' in el) {
      const arm = setTimeout(() => {
        handle = el.requestVideoFrameCallback(onFrame);
      }, 300);
      return () => {
        done = true;
        clearTimeout(show);
        clearTimeout(cap);
        clearTimeout(arm);
        if (handle) el.cancelVideoFrameCallback(handle);
      };
    }
    return () => {
      done = true;
      clearTimeout(show);
      clearTimeout(cap);
    };
  }, [switchedAt, videoRef]);
  return switching;
}

/**
 * 0.4.5: one watched stream (main window or pop-out). Its own video element, LIVE badge, title,
 * volume / mute, statistics, focus, pop-out and close. Stable key: streamer id + publication id.
 */
export function StreamTile({ stream, focused, multi, poppedOut = false, onFullscreen }: { stream: StreamRef; focused: boolean; multi: boolean; poppedOut?: boolean; onFullscreen?: () => void }) {
  const { t } = useTranslation();
  const presenter = stream.presenter;
  const camera = stream.source === 'camera';
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showStats, setShowStats] = useState(false);
  const [playingTrack, setPlayingTrack] = useState<unknown>(null);
  const [wakeAt, setWakeAt] = useState(() => Date.now());
  const lastWake = useRef(0);
  const globalName = usePresenceStore((s) => s.users[presenter.identity]?.displayName) ?? presenter.name;
  const names = useCallNames();
  const name = names(presenter.identity, globalName);
  const nameColor = useNicknameColor(presenter.identity);
  const screenTitle = useStreamTitle(presenter.identity);
  const title = camera ? null : screenTitle;
  const track = voice.getStreamTrack(stream.key);
  const hasFrames = track !== null && playingTrack === track;
  const stats = useStreamStats(track, showStats);
  const renderFps = useRenderFps(videoRef, showStats);
  const switching = useSwitching(presenter.identity, videoRef);
  const selectedAudio = useVoiceStore((s) => s.audioShare === stream.key);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    // 0.7.0: a pop-out <video> is watched by its own window (see voice/popoutVideo.ts).
    attachVideo(track, el);
    const onPlaying = () => setPlayingTrack(track);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('loadeddata', onPlaying);
    return () => {
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('loadeddata', onPlaying);
      track.detach(el);
    };
  }, [track]);

  const label = presenter.isLocal ? (camera ? t('camera.yourCamera') : t('voice.youAreSharing')) : name;
  const popOut = isDesktop && !poppedOut && !presenter.isLocal;
  // Mouse movement over the stream brings the viewer bar back (throttled).
  const wake = () => {
    const now = Date.now();
    if (now - lastWake.current < 500) return;
    lastWake.current = now;
    setWakeAt(now);
  };
  return (
    <div
      className={`stream-tile${focused ? ' is-focused' : ''}${hasFrames ? ' has-frames' : ''}${camera ? ' is-camera' : ''}`}
      onPointerMove={wake}
      onClick={() => {
        if (multi && !poppedOut) voice.focusShare(focused ? null : stream.key);
      }}
    >
      <video ref={videoRef} className={`stream-video${hasFrames ? ' is-playing' : ''}${camera && presenter.isLocal ? ' is-mirrored' : ''}`} autoPlay playsInline muted onDoubleClick={onFullscreen} />
      <StreamViewersBar stream={stream} wakeAt={wakeAt} />
      {!camera && <StreamInteractions owner={presenter.identity} local={presenter.isLocal} videoRef={videoRef} ready={hasFrames && !switching} />}
      {hasFrames && switching && (
        <div className="stream-switching" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('streamSwitch.switching')}
        </div>
      )}
      {!hasFrames && (
        <div className="stream-waiting" role="status">
          <span className="spinner spinner-lg" aria-hidden="true" />
          <span>{presenter.isLocal ? t('voice.streamStarting') : t('voice.streamWaiting')}</span>
          {!presenter.isLocal && <span className="stream-waiting-name">{name}</span>}
        </div>
      )}
      <div className="stream-topbar stream-overlay">
        <span className="stream-presenter">
          <span className="live-badge">
            {camera && <Video size={10} aria-hidden="true" />}
            {t('voice.live')}
          </span>
          <span className="stream-presenter-name" style={nameColor && !presenter.isLocal ? { color: nameColor } : undefined}>
            {label}
          </span>
          {title && <span className="stream-presenter-title">{title}</span>}
        </span>
        <div className="stream-actions" onClick={(e) => e.stopPropagation()}>
          {!camera && !presenter.isLocal && (
            <button
              type="button"
              className={`stream-btn${selectedAudio ? ' is-active' : ''}`}
              aria-pressed={selectedAudio}
              aria-label={t(selectedAudio ? 'streamExtras.audioOff' : 'streamExtras.audio')}
              title={t(selectedAudio ? 'streamExtras.audioOff' : 'streamExtras.audio')}
              onClick={() => voice.selectStreamAudio(selectedAudio ? null : stream.key)}
            >
              <Volume2 size={16} />
            </button>
          )}
          <button
            type="button"
            className={`stream-btn${showStats ? ' is-active' : ''}`}
            aria-pressed={showStats}
            aria-label={t('voice.streamStats.toggle')}
            title={t('voice.streamStats.toggle')}
            onClick={() => setShowStats((v) => !v)}
          >
            <Activity size={16} />
          </button>
          {popOut && (
            <button type="button" className="stream-btn" aria-label={t('streamExtras.overlay')} title={t('streamExtras.overlayHint')} onClick={() => openStreamPopout(stream.key, true)}>
              <PictureInPicture2 size={16} />
            </button>
          )}
          {popOut && (
            <button type="button" className="stream-btn" aria-label={t('voice.popOut')} title={t('voice.popOut')} onClick={() => openStreamPopout(stream.key)}>
              <ExternalLink size={16} />
            </button>
          )}
          {onFullscreen && (
            <button type="button" className="stream-btn" aria-label={t('voice.fullscreen')} title={t('voice.fullscreen')} onClick={onFullscreen}>
              <Maximize size={16} />
            </button>
          )}
          {!poppedOut && (
            <button
              type="button"
              className="stream-btn"
              aria-label={presenter.isLocal ? t('voice.hidePreview') : t('voice.stopWatching')}
              title={presenter.isLocal ? t('voice.hidePreview') : t('voice.stopWatching')}
              onClick={() => voice.stopWatching(stream.key)}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      {!presenter.isLocal && !camera && (
        <div className="stream-tile-volume stream-overlay" onClick={(e) => e.stopPropagation()}>
          <StreamVolume presenter={presenter} />
        </div>
      )}
      {showStats && <StatsPanel stats={stats} sender={presenter.isLocal && !camera ? voice.getScreenShareSenderInfo() : null} renderFps={renderFps} camera={camera} />}
    </div>
  );
}

/**
 * 0.4.5 stream stage: every watched stream as its own tile (1 = full, 2 = side by side, 3-4 =
 * grid; a focused stream is large with the others in a strip). Each tile has its own volume, mute
 * and statistics; one ending removes only its tile. The bottom bar (mic, headphones, chat, share,
 * leave) is shared. Fullscreen covers the whole stage (with the voice chat inside, as before).
 * Pop-out streams are shown in their own windows instead of a tile here.
 */
export function StreamStage({ streams, channel }: { streams: StreamRef[]; channel: Channel }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const chatOpen = useUiStore((s) => s.voiceChatOpen);
  const focusedShare = useVoiceStore((s) => s.focusedShare);
  const popouts = usePopouts();
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inline = streams.filter((st) => !popouts.includes(st.key));
  const multi = inline.length > 1;
  const focused = multi && focusedShare && inline.some((st) => st.key === focusedShare) ? focusedShare : null;

  useEffect(() => {
    const onChange = () => {
      const isFull = document.fullscreenElement === shellRef.current && shellRef.current !== null;
      setFullscreen(isFull);
      useUiStore.getState().setStreamFullscreen(isFull);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      useUiStore.getState().setStreamFullscreen(false);
    };
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFullscreen = (key?: string) => {
    const el = shellRef.current;
    if (!el || !canFullscreen) return;
    if (key && multi) voice.focusShare(key);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  };
  const keepVisible = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
  };

  // Focused first, then the rest in watch order.
  const ordered = focused ? [...inline.filter((st) => st.key === focused), ...inline.filter((st) => st.key !== focused)] : inline;
  return (
    <div ref={shellRef} className={`stream-shell${fullscreen ? ' is-fullscreen' : ''}${idle ? ' is-idle' : ''}${fullscreen && chatOpen ? ' has-chat' : ''}`} onPointerMove={wake} onPointerLeave={() => setIdle(true)}>
      <div className="stream-view">
        <div className={`stream-grid count-${Math.min(ordered.length, 4)}${focused ? ' has-focus' : ''}`}>
          {ordered.map((st) => (
            <StreamTile
              key={`${st.key}:${voice.getStreamTrack(st.key)?.sid ?? 'pending'}`}
              stream={st}
              focused={st.key === focused}
              multi={multi}
              onFullscreen={canFullscreen ? () => toggleFullscreen(st.key) : undefined}
            />
          ))}
          {ordered.length === 0 && <PoppedOutNotice />}
        </div>
        <div className="stream-bottom stream-overlay" onPointerMove={keepVisible} onFocus={keepVisible}>
          <StreamBar channel={channel} />
        </div>
      </div>
      {fullscreen && chatOpen && <VoiceChatPanel channel={channel} />}
    </div>
  );
}

function PoppedOutNotice() {
  const { t } = useTranslation();
  return <div className="stream-popped-notice">{t('voice.poppedOutHere')}</div>;
}
