import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff } from 'lucide-react';
import type { GameView } from '../api/types';
import { formatPlayDuration } from '../utils/duration';
import { gamesApi } from './api';
import { GameCover } from './GameCover';
import { STATUS_COLORS, playedAgo } from './gameMeta';

/** Shelves already loaded in this session (opening a profile again shows them at once). */
const cache = new Map<string, { at: number; games: GameView[]; hidden: boolean }>();
const CACHE_MS = 60_000;
const listeners = new Set<(userId: string) => void>();

/** Drops a cached shelf (realtime "games.changed", a privacy switch, own edits). */
export function forgetShelf(userId: string): void {
  cache.delete(userId);
  for (const l of listeners) l(userId);
}

export function StatusChip({ game }: { game: Pick<GameView, 'status'> }) {
  const { t } = useTranslation();
  const c = STATUS_COLORS[game.status];
  return (
    <span className="tracker-status-chip" style={{ background: c.bg, color: c.fg }}>
      {t(`games.status.${game.status}`)}
    </span>
  );
}

/** Game tracker shelf in a profile: playing first, then the rest; the owner can hide it from others. */
export function GameShelf({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<{ games: GameView[]; hidden: boolean } | null>(cache.get(userId) ?? null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onChange = (changed: string) => {
      if (changed === userId) setVersion((v) => v + 1);
    };
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [userId]);

  useEffect(() => {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return;
    let alive = true;
    gamesApi.list(userId).then(
      (result) => {
        cache.set(userId, { at: Date.now(), ...result });
        if (alive) setData(result);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [userId, version]);

  if (!data || data.games.length === 0) return null;
  return (
    <section className="profile-section game-shelf">
      <h3>
        {t('games.shelf')}
        {isSelf && data.hidden && (
          <span className="game-shelf-hidden" title={t('games.hiddenHint')}>
            <EyeOff size={12} aria-hidden="true" /> {t('games.hidden')}
          </span>
        )}
      </h3>
      <ul className="game-shelf-list">
        {data.games.slice(0, 8).map((g) => (
          <li key={g.id} className="game-shelf-item" title={g.name}>
            <GameCover game={g} className="game-shelf-art" />
            <span className="game-shelf-name">{g.name}</span>
            <span className="game-shelf-meta">
              <StatusChip game={g} />
              <span>
                {t(`games.platform.${g.platform}`)}
                {g.totalSeconds >= 60 ? ` · ${formatPlayDuration(g.totalSeconds * 1000)}` : ''}
                {!g.manual || g.totalSeconds > 0 ? ` · ${playedAgo(g.lastPlayedAt, i18n.language)}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
