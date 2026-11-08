import { useState, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Code, Crown, FlaskConical, Gamepad2, Shield, Star } from 'lucide-react';
import type { PublicUser } from '../../api/types';
import { usePermsStore } from '../../stores/permsStore';
import { useGuildStore, useMemberDisplay } from '../../stores/guildStore';
import { gameTheme } from '../../utils/gameTheme';

const BADGE_ICONS: Record<string, typeof Shield> = { shield: Shield, code: Code, crown: Crown, flask: FlaskConical };

/** Small icon badges (Admin, Developer, Founder, Tester); definitions come from the server. */
export function UserBadges({ user, size = 14 }: { user: Pick<PublicUser, 'badges'>; size?: number }) {
  const defs = usePermsStore((s) => s.badges);
  const keys = user.badges ?? [];
  if (keys.length === 0) return null;
  return (
    <span className="user-badges">
      {keys.map((key) => {
        const def = defs.find((b) => b.key === key);
        if (!def) return null;
        const Icon = BADGE_ICONS[def.icon] ?? Star;
        return (
          <span key={key} className="user-badge" title={def.label} style={{ color: def.color }} role="img" aria-label={def.label}>
            <Icon size={size} />
          </span>
        );
      })}
    </span>
  );
}

/**
 * The game a member is playing (0.4.7). Compact = member list: the activity has its own row under
 * the avatar and the name (the full width of the row). It reads "🎮 Playing <game>" when that fits;
 * when it does not, the "Playing" prefix is dropped first (the gamepad icon already says it) so the
 * game's name keeps the room. Only a name that still does not fit ends in an ellipsis; it slides
 * once to its end on hover (no constant motion). Tooltip and screen readers: the full text.
 */
export function ActivityPill({ name, compact = false }: { name: string; compact?: boolean }) {
  const { t } = useTranslation();
  const theme = gameTheme(name);
  const [fit, setFit] = useState({ prefix: true, overflow: 0 });
  const prefixWidth = useRef(0);
  const style = {
    '--game-accent': theme.accent,
    '--game-accent-2': theme.accent2,
    '--game-soft': theme.soft,
    '--reveal': `-${fit.overflow}px`,
    '--reveal-ms': `${Math.max(900, fit.overflow * 25)}ms`,
  } as CSSProperties;
  // Re-measured whenever the row's width changes (sidebar resize, window size, font load).
  const observe = (el: HTMLSpanElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const prefix = el.querySelector<HTMLElement>('.activity-pill-prefix');
      const inner = el.querySelector<HTMLElement>('.activity-pill-name-inner');
      if (!inner) return;
      if (prefix) prefixWidth.current = prefix.getBoundingClientRect().width;
      const available = el.clientWidth;
      const nameWidth = inner.getBoundingClientRect().width;
      const next = { prefix: prefixWidth.current + nameWidth <= available + 0.5, overflow: Math.max(0, Math.ceil(nameWidth - available)) };
      setFit((prev) => (prev.prefix === next.prefix && prev.overflow === next.overflow ? prev : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  };
  return (
    <span
      className={`activity-pill${compact ? ' is-compact' : ''}${compact && fit.overflow > 0 ? ' can-reveal' : ''}`}
      style={style}
      title={t('activity.playing', { name })}
      aria-label={t('activity.playing', { name })}
    >
      <Gamepad2 size={compact ? 12 : 13} aria-hidden="true" />
      {compact ? (
        <span className="activity-pill-name" aria-hidden="true" ref={observe}>
          {fit.prefix && <span className="activity-pill-prefix">{t('activity.playingShort')} </span>}
          <span className="activity-pill-name-inner">{name}</span>
        </span>
      ) : (
        <span className="activity-pill-text">{t('activity.playing', { name })}</span>
      )}
    </span>
  );
}

/** Built-in decorative frames (ids stored on the server; drawn here). */
export const PROFILE_FRAMES = ['neon', 'scifi', 'gold', 'pulse', 'violet'] as const;
export type ProfileFrame = (typeof PROFILE_FRAMES)[number];

export function isProfileFrame(value: unknown): value is ProfileFrame {
  return typeof value === 'string' && (PROFILE_FRAMES as readonly string[]).includes(value);
}

/** Wraps an avatar with the user's frame (CSS only; animations respect reduced motion). */
export function FramedAvatar({ frame, children, size }: { frame: string | null | undefined; children: ReactNode; size: number }) {
  if (!isProfileFrame(frame)) return <>{children}</>;
  return (
    <span className={`avatar-frame frame-${frame}`} style={{ '--frame-size': `${size}px` } as CSSProperties}>
      {children}
    </span>
  );
}

/**
 * 0.4.1 voice views: the user's frame (and its animation) shows ONLY while they speak. Without a
 * frame the usual green speaking ring is used. CSS only (opacity on a pseudo-element); the
 * speaking state is LiveKit's, nothing is polled.
 */
export function SpeakingFrame({ frame, speaking, size, children }: { frame: string | null | undefined; speaking: boolean; size: number; children: ReactNode }) {
  const framed = isProfileFrame(frame);
  return (
    <span
      className={`speaking-frame${framed ? ` avatar-frame frame-${frame}` : ''}${speaking ? ' is-speaking' : ''}`}
      style={{ '--frame-size': `${size}px` } as CSSProperties}
    >
      {children}
    </span>
  );
}

/** 0.7.0: the colour of the person's highest coloured role on the open server (null outside servers). */
export function useRoleColor(user: Pick<PublicUser, 'id'> | undefined): string | null {
  const guildId = useGuildStore((s) => s.activeGuildId);
  return useMemberDisplay(guildId, user?.id ?? '').roleColor;
}
