import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Gamepad2 } from 'lucide-react';
import type { ActivityView } from '../../api/types';
import { gameTheme, type GameTheme } from '../../utils/gameTheme';
import { cachedSteamColor, cachedSteamIdByName, isSteamAppId, resolveSteamArt, resolveSteamIdByName, sampleSteamColor, steamArtFailed, steamArtLoaded, steamArtUrl, type SteamArtKind } from '../../utils/steamArt';
import { elapsedSince, formatPlayDuration } from '../../utils/duration';
import { useNow } from '../../hooks/useNow';
import { useServerConfig } from '../../api/clientConfig';

/**
 * 0.4.1: a game's accent. The Steam header's dominant color when it could be sampled (once per
 * AppID, cached), otherwise the deterministic color from the name (gameTheme).
 */
export function useGameTheme(name: string, steamAppId: number | null | undefined): GameTheme {
  const base = gameTheme(name);
  // Steam images only when the server owner switched them on (STEAM_ART).
  const steamArt = useServerConfig((s) => s.steamArt);
  const id = steamArt && isSteamAppId(steamAppId) ? steamAppId : null;
  const [color, setColor] = useState<string | null>(() => (id ? (cachedSteamColor(id) ?? null) : null));
  useEffect(() => {
    if (!id || base.curated) return;
    let alive = true;
    void sampleSteamColor(id).then((c) => {
      if (alive) setColor(c);
    });
    return () => {
      alive = false;
    };
  }, [id, base.curated]);
  if (!color || base.curated) return base;
  return { accent: color, accent2: base.accent2, soft: `color-mix(in srgb, ${color} 14%, transparent)`, curated: false };
}

export function gameStyle(theme: GameTheme): CSSProperties {
  return { '--game-accent': theme.accent, '--game-accent-2': theme.accent2, '--game-soft': theme.soft } as CSSProperties;
}

/**
 * Game artwork with a safe fallback chain: Steam image (two CDN locations, then the real URL the
 * server looked up for newer games) -> local executable
 * icon (own game only) -> a generated gradient tile with a gamepad. The <img> stays invisible until
 * it has loaded, so a broken image is never shown.
 */
export function GameArt({
  name,
  steamAppId,
  icon,
  kind,
  className = '',
}: {
  name: string;
  steamAppId?: number | null;
  /** Local executable icon (data URL), only for the game running on this PC. */
  icon?: string | null;
  kind: SteamArtKind | 'icon';
  className?: string;
}) {
  const steamArt = useServerConfig((st) => st.steamArt);
  // 0.5.8: no Steam id (a game found by its process): look it up by name, once per name.
  const [byName, setByName] = useState<{ name: string; id: number | null } | null>(() => {
    const known = isSteamAppId(steamAppId) ? undefined : cachedSteamIdByName(name);
    return known === undefined ? null : { name, id: known };
  });
  useEffect(() => {
    if (!steamArt || isSteamAppId(steamAppId) || (byName && byName.name === name)) return;
    let alive = true;
    void resolveSteamIdByName(name).then((found) => {
      if (alive) setByName({ name, id: found });
    });
    return () => {
      alive = false;
    };
  }, [steamArt, steamAppId, name, byName]);
  // Steam images only when the server owner switched them on (STEAM_ART).
  const id = !steamArt ? null : isSteamAppId(steamAppId) ? steamAppId : byName?.name === name ? byName.id : null;
  const steamKind: SteamArtKind = kind === 'icon' ? 'capsule' : kind;
  // Another game: start over (state reset during render, the React-recommended pattern).
  const artKey = id ? `${String(id)}:${steamKind}` : '';
  const [art, setArt] = useState(() => ({ key: artKey, src: id ? steamArtUrl(id, steamKind) : null, loaded: false }));
  if (art.key !== artKey) setArt({ key: artKey, src: id ? steamArtUrl(id, steamKind) : null, loaded: false });
  const { src, loaded } = art;
  const setSrc = (next: string | null) => setArt((a) => ({ ...a, src: next, loaded: false }));
  const setLoaded = (value: boolean) => setArt((a) => ({ ...a, loaded: value }));
  // 0.5.2: no fixed CDN path works (remembered from earlier): try the looked-up URL directly.
  useEffect(() => {
    if (!id || src) return;
    let alive = true;
    void resolveSteamArt(id, steamKind).then((real) => {
      if (alive && real) setArt((a) => (a.key === artKey && !a.src ? { ...a, src: real, loaded: false } : a));
    });
    return () => {
      alive = false;
    };
  }, [id, steamKind, artKey, src]);
  const theme = gameTheme(name);
  const tile = { background: `linear-gradient(135deg, ${theme.accent2}, ${theme.accent})` };
  // Icons prefer the real executable icon; banners prefer Steam art.
  if (kind === 'icon' && icon) {
    return (
      <span className={`game-art is-icon has-local-icon ${className}`} aria-hidden="true">
        <img src={icon} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`game-art is-${kind} ${className}${loaded ? ' is-loaded' : ''}`} style={tile} aria-hidden="true">
      {!loaded && (icon ? <img className="game-art-local" src={icon} alt="" draggable={false} /> : <Gamepad2 className="game-art-fallback" size={kind === 'icon' ? 16 : 28} />)}
      {src && id && (
        <img
          key={src}
          className="game-art-img"
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => {
            steamArtLoaded(id, steamKind, src);
            setLoaded(true);
          }}
          onError={() => {
            const next = steamArtFailed(id, steamKind, src);
            setSrc(next);
            // 0.5.2: both fixed CDN paths are 404 (newer games): ask the server for the real URL.
            if (!next) {
              void resolveSteamArt(id, steamKind).then((real) => {
                if (real && real !== src) setArt((a) => (a.key === artKey ? { ...a, src: real, loaded: false } : a));
              });
            }
          }}
        />
      )}
    </span>
  );
}

/** "1 ч 24 мин" / "for 1h 24m" since the activity started (shared clock; only this span re-renders). */
export function PlayDuration({ startedAt }: { startedAt: string | undefined }) {
  const { t } = useTranslation();
  const now = useNow(1000, Boolean(startedAt));
  const ms = elapsedSince(startedAt, now);
  if (ms === null) return null;
  return <span className="game-duration">{t('activity.elapsed', { duration: formatPlayDuration(ms) })}</span>;
}

/** 0.4.1 profile activity card: artwork, accent gradient, name and how long they have been playing. */
export function GameActivityCard({ activity, icon }: { activity: ActivityView; icon?: string | null }) {
  const { t } = useTranslation();
  const theme = useGameTheme(activity.name, activity.steamAppId);
  return (
    <div className="profile-activity profile-game-card" style={gameStyle(theme)}>
      <GameArt name={activity.name} steamAppId={activity.steamAppId} icon={icon} kind="header" className="game-card-art" />
      <span className="profile-activity-text">
        <span className="profile-activity-label">{t('profile.playingNow')}</span>
        <span className="profile-activity-name" title={activity.name}>
          {activity.name}
        </span>
        <PlayDuration startedAt={activity.startedAt} />
      </span>
    </div>
  );
}
