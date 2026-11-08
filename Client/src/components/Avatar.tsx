import { memo, type CSSProperties } from 'react';
import type { PresenceState } from '../api/types';
import { useAttachmentUrl } from '../hooks/useAttachmentUrl';
import { avatarColor, initials } from '../utils/avatar';
import { usePresenceStore } from '../stores/presenceStore';
import { FRAME_MIN_SIZE, frameScale, frameUrl } from '../cosmetics/catalog';

interface AvatarProps {
  userId: string;
  name: string;
  avatarAttachmentId?: string | null;
  size?: number;
  /** undefined = no presence dot (legacy online/offline) */
  online?: boolean;
  /** Presence dot with Away / Do Not Disturb (wins over `online`). 'invisible' only for yourself. */
  status?: PresenceState | 'invisible';
  speaking?: boolean;
  className?: string;
  /** 0.5.1: draw the user's avatar frame (default true; previews pass a frame id or false). */
  frame?: boolean | string | null;
}

export const Avatar = memo(function Avatar({
  userId,
  name,
  avatarAttachmentId,
  size = 40,
  online,
  status,
  speaking,
  className,
  frame = true,
}: AvatarProps) {
  const { url } = useAttachmentUrl(avatarAttachmentId ?? null);
  const ownFrame = usePresenceStore((s) => (frame === true ? (s.users[userId]?.avatarFrameId ?? null) : null));
  const frameId = typeof frame === 'string' ? frame : frame === true ? ownFrame : null;
  const frameSrc = size >= FRAME_MIN_SIZE ? frameUrl(frameId) : null;
  const frameSize = size * frameScale(frameId);
  const classes = ['avatar', speaking ? 'is-speaking' : '', frameSrc ? 'has-cosmetic-frame' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      style={{
        width: size,
        height: size,
        background: url ? 'transparent' : avatarColor(userId),
        fontSize: Math.round(size * 0.4),
        // 0.5.6: how far the frame reaches past the avatar (list rows keep that room before the name).
        ...(frameSrc ? ({ '--frame-overhang': `${String((frameSize - size) / 2)}px` } as CSSProperties) : null),
      }}
      aria-hidden="true"
    >
      {url ? <img className="avatar-img" src={url} alt="" draggable={false} /> : <span className="avatar-initials">{initials(name)}</span>}
      {/* 0.5.1: avatar -> frame -> presence dot (the dot stays on top). Native WebP animation. */}
      {frameSrc && (
        <img
          className="avatar-cosmetic-frame"
          src={frameSrc}
          alt=""
          draggable={false}
          decoding="async"
          style={{ width: frameSize, height: frameSize, left: (size - frameSize) / 2, top: (size - frameSize) / 2 }}
        />
      )}
      {(status ?? (online === undefined ? undefined : online ? 'online' : 'offline')) !== undefined && (
        <span className={`presence-dot is-${status ?? (online ? 'online' : 'offline')}`} />
      )}
    </span>
  );
});
