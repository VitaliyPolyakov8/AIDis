import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { GameStatus, GameView } from '../api/types';
import { friendlyError } from '../api/errors';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/uiStore';
import { gamesApi } from './api';
import { GameCover } from './GameCover';
import { forgetShelf } from './GameShelf';
import { STATUS_COLORS } from './gameMeta';

const ANSWERS: GameStatus[] = ['COMPLETED', 'HUNDRED', 'DROPPED', 'PAUSED'];

/**
 * "Hades: how did it end?" — for a game in progress that was not launched for two weeks (the server
 * picks them). Asked a little after the app starts, one game at a time.
 */
export function GamePromptHost({ delayMs = 20_000 }: { delayMs?: number }) {
  const { t } = useTranslation();
  const me = useAuthStore((s) => s.user?.id);
  const [queue, setQueue] = useState<GameView[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me) return;
    const timer = window.setTimeout(() => {
      gamesApi.prompts().then(
        ({ games }) => setQueue(games),
        () => undefined,
      );
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [me, delayMs]);

  const game = queue[0];
  if (!game || !me) return null;

  const answer = async (status: GameStatus | null) => {
    setBusy(true);
    try {
      if (status) await gamesApi.update(game.id, { status });
      await gamesApi.prompted(game.id);
      if (status) forgetShelf(me);
      setQueue((q) => q.slice(1));
    } catch (e) {
      toast.error(friendlyError(e, t('games.dialog.failed')), 'game-prompt');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="game-prompt" role="status">
      <GameCover game={game} className="game-prompt-art" />
      <div className="game-prompt-body">
        <strong>{t('games.prompt.title', { name: game.name })}</strong>
        <span className="field-hint">{t('games.prompt.text')}</span>
        <div className="game-prompt-actions">
          {ANSWERS.map((s) => (
            <button key={s} type="button" className="btn btn-sm" style={{ background: STATUS_COLORS[s].bg, color: STATUS_COLORS[s].fg }} disabled={busy} onClick={() => void answer(s)}>
              {t(`games.status.${s}`)}
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void answer(null)}>
            {t('games.prompt.still')}
          </button>
        </div>
      </div>
      <button type="button" className="icon-btn icon-btn-xs game-prompt-close" aria-label={t('common.close')} onClick={() => setQueue((q) => q.slice(1))}>
        <X size={14} />
      </button>
    </aside>
  );
}
