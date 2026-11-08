import { useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, X } from 'lucide-react';
import type { GamePlatform, GameStatus, GameView } from '../api/types';
import { uploadAttachment } from '../api/attachments';
import { friendlyError } from '../api/errors';
import { Modal } from '../components/Modal';
import { gamesApi } from './api';
import { GameCover } from './GameCover';
import { GAME_PLATFORMS, GAME_STATUSES } from './gameMeta';

/** Add a game by hand (any platform) or edit one: name, platform, status and an optional cover. */
export function GameDialog({ game, onClose, onSaved }: { game: GameView | null; onClose: () => void; onSaved: (game: GameView) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(game?.name ?? '');
  const [platform, setPlatform] = useState<GamePlatform>(game?.platform ?? 'PC');
  const [status, setStatus] = useState<GameStatus>(game?.status ?? 'PLAYING');
  const [cover, setCover] = useState<string | null>(game?.coverAttachmentId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const upload = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(picked, () => undefined).promise;
      setCover(attachment.id);
    } catch (e) {
      setError(friendlyError(e, t('games.dialog.coverFailed')));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), platform, status, coverAttachmentId: cover };
      const saved = game ? await gamesApi.update(game.id, input) : await gamesApi.add(input);
      onSaved(saved);
    } catch (e) {
      setError(friendlyError(e, t('games.dialog.failed')));
      setBusy(false);
    }
  };

  return (
    <Modal title={game ? t('games.dialog.editTitle') : t('games.dialog.addTitle')} onClose={onClose} size="sm">
      <form className="game-dialog" onSubmit={(e) => void submit(e)}>
        <div className="game-dialog-cover">
          <GameCover game={{ name: name || '?', steamAppId: game?.steamAppId ?? null, coverAttachmentId: cover }} className="game-dialog-art" />
          <div className="game-dialog-cover-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => file.current?.click()}>
              <ImagePlus size={14} aria-hidden="true" /> {t('games.dialog.cover')}
            </button>
            {cover && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCover(null)}>
                <X size={14} aria-hidden="true" /> {t('games.dialog.coverRemove')}
              </button>
            )}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </div>
        <label className="field">
          <span className="field-label">{t('games.dialog.name')}</span>
          <input className="input" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span className="field-label">{t('games.dialog.platform')}</span>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as GamePlatform)}>
            {GAME_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {t(`games.platform.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('games.dialog.status')}</span>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as GameStatus)}>
            {GAME_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`games.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
