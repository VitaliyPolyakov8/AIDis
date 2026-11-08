import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useCallNames } from '../../stores/guildStore';
import { useTranslation } from 'react-i18next';
import { HeadphoneOff, MicOff, Monitor } from 'lucide-react';
import { Avatar } from '../Avatar';
import { SpeakingFrame } from '../profile/ProfileBits';
import { useNameStyle } from '../profile/nameStyle';
import { openProfile } from '../profile/profileState';
import { openParticipantMenu } from './participantMenuState';
import { usePresenceStore } from '../../stores/presenceStore';
import { voice } from '../../voice/voiceService';
import { isParticipantDeafened, streamKey, useVoiceStore, type VoiceParticipant } from '../../voice/voiceStore';
import { clampToRoom, defaultSpot, ROOM_FULL_DISTANCE, ROOM_HEIGHT, ROOM_SILENT_DISTANCE, ROOM_WIDTH, spatialMix, type RoomPoint } from '../../voice/channelVoice';

/** Walking speed in room units per second (the room is 1000 wide: about 3 s across). */
const SPEED = 340;
const AVATAR = 56;

/**
 * 0.5.5 "room" voice channels: a 2D room where everyone has a place. Click the floor (or use the
 * arrow keys / WASD) to walk; voices get quieter with distance and come from the left or right, so
 * people can step aside and talk on their own. Positions travel over the LiveKit data channel
 * (voiceService), nothing is stored on the server.
 */
export function VoiceRoom({ participants }: { participants: VoiceParticipant[] }) {
  const { t } = useTranslation();
  const positions = useVoiceStore((s) => s.roomPositions);
  const self = participants.find((p) => p.isLocal);
  const selfId = self?.identity ?? null;
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const target = useRef<RoomPoint | null>(null);
  const keys = useRef(new Set<string>());
  const frame = useRef<number | null>(null);
  const last = useRef(0);

  // The room keeps its proportions and scales to the space it has.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setScale(el.clientWidth / ROOM_WIDTH));
    observer.observe(el);
    setScale(el.clientWidth / ROOM_WIDTH);
    return () => observer.disconnect();
  }, []);

  // Our first spot (stable per user) is announced as soon as we are in.
  useEffect(() => {
    if (selfId && !useVoiceStore.getState().roomPositions[selfId]) voice.setRoomPosition(defaultSpot(selfId), true);
  }, [selfId]);

  const myPosition = (): RoomPoint => (selfId ? (useVoiceStore.getState().roomPositions[selfId] ?? defaultSpot(selfId)) : { x: ROOM_WIDTH / 2, y: ROOM_HEIGHT / 2 });

  const step = (time: number) => {
    const dt = last.current ? Math.min(0.05, (time - last.current) / 1000) : 0;
    last.current = time;
    const now = myPosition();
    let next: RoomPoint | null = null;
    const k = keys.current;
    const kx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    const ky = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
    if (kx || ky) {
      target.current = null;
      const len = Math.hypot(kx, ky);
      next = { x: now.x + (kx / len) * SPEED * dt, y: now.y + (ky / len) * SPEED * dt };
    } else if (target.current) {
      const dx = target.current.x - now.x;
      const dy = target.current.y - now.y;
      const dist = Math.hypot(dx, dy);
      const move = SPEED * dt;
      if (dist <= move) {
        next = target.current;
        target.current = null;
      } else next = { x: now.x + (dx / dist) * move, y: now.y + (dy / dist) * move };
    }
    if (next) voice.setRoomPosition(next, !target.current && !kx && !ky);
    if (target.current || keys.current.size > 0) frame.current = requestAnimationFrame(step);
    else {
      frame.current = null;
      last.current = 0;
    }
  };
  const run = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(step);
  };
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onFloor = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box.current || (e.target as HTMLElement).closest('.room-avatar')) return;
    const rect = box.current.getBoundingClientRect();
    target.current = clampToRoom({ x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale });
    run();
  };
  const KEY_DIRS: Record<string, string> = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  const onKey = (e: KeyboardEvent<HTMLDivElement>, down: boolean) => {
    const dir = KEY_DIRS[e.code];
    if (!dir) return;
    e.preventDefault();
    if (down) keys.current.add(dir);
    else keys.current.delete(dir);
    if (down) run();
  };

  const selfPos = selfId ? (positions[selfId] ?? defaultSpot(selfId)) : null;
  return (
    <div className={`voice-room-wrap${scale < 0.55 ? ' is-small' : ''}`}>
      <div
        ref={box}
        className="voice-room"
        style={{ aspectRatio: `${String(ROOM_WIDTH)} / ${String(ROOM_HEIGHT)}` }}
        tabIndex={0}
        role="application"
        aria-label={t('voice.room.label')}
        onPointerDown={onFloor}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        onBlur={() => keys.current.clear()}
      >
        <span className="voice-room-rug is-center" style={{ left: 380 * scale, top: 210 * scale, width: 240 * scale, height: 200 * scale }} aria-hidden="true" />
        <span className="voice-room-rug is-corner" style={{ left: 40 * scale, top: 40 * scale, width: 170 * scale, height: 130 * scale }} aria-hidden="true" />
        <span className="voice-room-rug is-corner" style={{ left: 790 * scale, top: 450 * scale, width: 170 * scale, height: 130 * scale }} aria-hidden="true" />
        {selfPos && (
          <>
            <span className="voice-room-range is-silent" style={ring(selfPos, ROOM_SILENT_DISTANCE, scale)} aria-hidden="true" />
            <span className="voice-room-range is-full" style={ring(selfPos, ROOM_FULL_DISTANCE, scale)} aria-hidden="true" />
          </>
        )}
        {participants.map((p) => (
          <RoomAvatar key={p.identity} p={p} position={positions[p.identity] ?? defaultSpot(p.identity)} self={selfPos} scale={scale} />
        ))}
      </div>
      {/* 0.5.6: phones have no arrow keys, so touch screens get their own hint (switched in CSS). */}
      <p className="voice-room-hint">
        <span className="voice-room-hint-keys">{t('voice.room.hint')}</span>
        <span className="voice-room-hint-touch">{t('voice.room.hintTouch')}</span>
      </p>
    </div>
  );
}

function ring(center: RoomPoint, radius: number, scale: number) {
  return { left: (center.x - radius) * scale, top: (center.y - radius) * scale, width: radius * 2 * scale, height: radius * 2 * scale };
}

function RoomAvatar({ p, position, self, scale }: { p: VoiceParticipant; position: RoomPoint; self: RoomPoint | null; scale: number }) {
  const { t } = useTranslation();
  const user = usePresenceStore((s) => s.users[p.identity]);
  const names = useCallNames();
  const name = names(p.identity, user?.displayName ?? p.name);
  const nameStyle = useNameStyle(p.identity);
  const deafened = useVoiceStore((s) => isParticipantDeafened(s, p.identity, p.isLocal));
  const gain = p.isLocal || !self ? 1 : spatialMix(self, position).gain;
  // 0.5.6: avatars follow the room's scale (down to 24 px), so on a phone they no longer pile up.
  const size = Math.round(Math.max(24, AVATAR * Math.min(1.2, scale)));
  return (
    <div
      className={`room-avatar${p.isLocal ? ' is-self' : ''}${p.isSpeaking ? ' is-speaking' : ''}${gain === 0 ? ' is-far' : ''}`}
      style={{ left: position.x * scale - size / 2, top: position.y * scale - size / 2, opacity: p.isLocal ? 1 : 0.45 + gain * 0.55 }}
      onContextMenu={(e) => openParticipantMenu(e, p.identity, name)}
    >
      <button type="button" className="room-avatar-btn" aria-label={name} onClick={(e) => openProfile(e, p.identity)}>
        <SpeakingFrame frame={user?.profileFrame} speaking={p.isSpeaking} size={size}>
          <Avatar userId={p.identity} name={name} avatarAttachmentId={user?.avatarAttachmentId} size={size} speaking={p.isSpeaking} />
        </SpeakingFrame>
      </button>
      <span className="room-avatar-name">
        <span className={nameStyle.className} style={nameStyle.style}>
          {name}
        </span>
        {p.micMuted && <MicOff size={12} role="img" aria-label={t('voice.muted')} />}
        {deafened && <HeadphoneOff size={12} role="img" aria-label={t('voice.deafened')} />}
      </span>
      {p.screenSharing && (
        <button type="button" className="live-badge room-avatar-live" onClick={() => voice.watchShare(streamKey(p.identity, 'screen'))} title={p.isLocal ? t('voice.yourScreen') : t('voice.watch', { name })}>
          <Monitor size={10} aria-hidden="true" />
          {t('voice.live')}
        </button>
      )}
    </div>
  );
}
