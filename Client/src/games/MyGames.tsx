import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash } from 'lucide-react';
import type { GameView } from '../api/types';
import { friendlyError } from '../api/errors';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/uiStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { gamesApi } from './api';
import { GameCover } from './GameCover';
import { GameDialog } from './GameDialog';
import { StatusChip, forgetShelf } from './GameShelf';

/** Settings -> Profile -> "My games": the tracker list with add / edit / delete. */
export function MyGames() {
  const { t } = useTranslation();
  const me = useAuthStore((s) => s.user);
  const [games, setGames] = useState<GameView[] | null>(null);
  const [editing, setEditing] = useState<GameView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<GameView | null>(null);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    gamesApi.list(me.id).then(
      ({ games: list }) => alive && setGames(list),
      () => alive && setGames([]),
    );
    return () => {
      alive = false;
    };
  }, [me]);

  if (!me) return null;
  const saved = (game: GameView) => {
    setGames((list) => [game, ...(list ?? []).filter((g) => g.id !== game.id)]);
    setEditing(null);
    forgetShelf(me.id);
  };

  return (
    <div className="settings-group my-games">
      <div className="my-games-head">
        <h4 className="settings-group-title">{t('games.mine')}</h4>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden="true" /> {t('games.add')}
        </button>
      </div>
      <p className="field-hint">{t('games.mineHint')}</p>
      {games === null && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {games?.length === 0 && <p className="field-hint">{t('games.empty')}</p>}
      <ul className="my-games-list">
        {games?.map((g) => (
          <li key={g.id} className="my-games-item">
            <GameCover game={g} className="my-games-art" />
            <span className="my-games-name">{g.name}</span>
            <span className="field-hint">{t(`games.platform.${g.platform}`)}</span>
            <StatusChip game={g} />
            <button type="button" className="icon-btn" aria-label={t('games.edit', { name: g.name })} onClick={() => setEditing(g)}>
              <Pencil size={15} />
            </button>
            <button type="button" className="icon-btn is-danger-hover" aria-label={t('games.delete', { name: g.name })} onClick={() => setDeleting(g)}>
              <Trash size={15} />
            </button>
          </li>
        ))}
      </ul>
      {editing && <GameDialog game={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={saved} />}
      {deleting && (
        <ConfirmDialog
          title={t('games.delete', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await gamesApi.remove(deleting.id);
              setGames((list) => (list ?? []).filter((g) => g.id !== deleting.id));
              forgetShelf(me.id);
            } catch (e) {
              toast.error(friendlyError(e, t('games.dialog.failed')), 'games-delete');
            }
          }}
        >
          <p>{t('games.deleteHint')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
