import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, Play, Trash, Upload, X } from 'lucide-react';
import type { Permission, SoundView } from '../../api/types';
import { friendlyError, isApiError } from '../../api/errors';
import { useAuthStore } from '../../stores/authStore';
import { useGuildStore } from '../../stores/guildStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { MAX_SOUND_BYTES, MAX_SOUND_SECONDS, SOUND_TYPES, soundsApi } from '../../sounds-board/api';
import { soundPlayer } from '../../sounds-board/player';
import { useGuildSounds, useSoundboardStore } from '../../sounds-board/store';

const NO_PERMISSIONS: Permission[] = [];

/** Length of an audio file in the browser (null when it cannot be read). */
function audioSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

/** 0.7.1 server settings → "Sounds": upload, edit and delete by CREATE_SOUNDS / MANAGE_SOUNDS (like emojis). */
export function SoundsSection({ guildId }: { guildId: string }) {
  const { t } = useTranslation();
  const sounds = useGuildSounds(guildId);
  const permissions = useGuildStore((s) => s.guilds.find((g) => g.id === guildId)?.me.permissions ?? NO_PERMISSIONS);
  const user = useAuthStore((s) => s.user);
  const manage = user?.role === 'ADMIN' || permissions.includes('MANAGE_SOUNDS');
  const create = manage || permissions.includes('CREATE_SOUNDS');
  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [volume, setVolume] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; emoji: string; volume: number } | null>(null);
  const [deleting, setDeleting] = useState<SoundView | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    useSoundboardStore
      .getState()
      .load(guildId)
      .then(
        () => setLoaded(true),
        (e: unknown) => {
          setLoaded(true);
          setError(friendlyError(e, t('sounds.loadFailed')));
        },
      );
  }, [guildId, t]);

  const problem = (value: unknown) => {
    if (isApiError(value)) {
      const keys: Record<string, string> = { SOUND_TOO_LONG: 'tooLong', SOUND_TYPE: 'type', SOUND_NAME_TAKEN: 'nameTaken', PAYLOAD_TOO_LARGE: 'tooBig', FORBIDDEN: 'forbidden' };
      const key = keys[value.code];
      if (key) return t(`sounds.${key}`);
    }
    return friendlyError(value, t('sounds.failed'));
  };

  const choose = async (next: File | undefined) => {
    setError(null);
    setFile(null);
    if (!next) return;
    if (next.size > MAX_SOUND_BYTES) {
      setError(t('sounds.tooBig'));
      return;
    }
    if (next.type && !SOUND_TYPES.includes(next.type)) {
      setError(t('sounds.type'));
      return;
    }
    const seconds = await audioSeconds(next);
    if (seconds !== null && seconds > MAX_SOUND_SECONDS + 0.1) {
      setError(t('sounds.tooLong'));
      return;
    }
    setFile(next);
    if (!name) setName(next.name.replace(/\.[^.]+$/, '').slice(0, 32));
  };

  const upload = async () => {
    if (!file || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await soundsApi.create(guildId, { name: name.trim(), emoji: emoji.trim() || null, volume }, file);
      await useSoundboardStore.getState().load(guildId);
      setFile(null);
      setName('');
      setEmoji('');
      setVolume(100);
      if (input.current) input.current.value = '';
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await soundsApi.update(editing.id, { name: editing.name.trim(), emoji: editing.emoji.trim() || null, volume: editing.volume });
      await useSoundboardStore.getState().load(guildId);
      setEditing(null);
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  };

  const canEdit = (sound: SoundView) => manage || (create && sound.createdById === user?.id);

  return (
    <div className="server-sounds-settings">
      <p className="field-hint">{t('sounds.description')}</p>
      {create ? (
        <form
          className="server-sound-upload"
          onSubmit={(e) => {
            e.preventDefault();
            void upload();
          }}
        >
          <label className="field">
            <span className="field-label">{t('sounds.file')}</span>
            <input ref={input} type="file" accept=".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          <div className="server-sound-fields">
            <label className="field">
              <span className="field-label">{t('sounds.name')}</span>
              <input className="input" maxLength={32} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder={t('sounds.namePlaceholder')} />
            </label>
            <label className="field server-sound-emoji">
              <span className="field-label">{t('sounds.emoji')}</span>
              <input className="input" maxLength={16} value={emoji} disabled={busy} onChange={(e) => setEmoji(e.target.value)} placeholder="🎺" />
            </label>
            <label className="field">
              <span className="field-label">
                {t('sounds.volume')}: {volume}%
              </span>
              <input className="range" type="range" min={0} max={100} step={5} value={volume} disabled={busy} onChange={(e) => setVolume(Number(e.target.value))} />
            </label>
          </div>
          <span className="field-hint">{t('sounds.rules')}</span>
          <div>
            <button type="submit" className="btn btn-secondary" disabled={busy || !file || !name.trim()}>
              <Upload size={15} /> {t('sounds.upload')}
            </button>
          </div>
        </form>
      ) : (
        <p className="field-hint">{t('sounds.noUpload')}</p>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && <span role="status">{t('common.loading')}</span>}
      {loaded && sounds.length === 0 && <p className="field-hint">{t('sounds.empty')}</p>}
      <div className="server-sound-list">
        {sounds.map((sound) => (
          <div className="server-sound-row" key={sound.id}>
            <button type="button" className="icon-btn" aria-label={t('sounds.listen', { name: sound.name })} onClick={() => void soundPlayer.play(sound).catch(() => undefined)}>
              <Play size={15} />
            </button>
            {editing?.id === sound.id ? (
              <>
                <input className="input server-sound-emoji" maxLength={16} value={editing.emoji} aria-label={t('sounds.emoji')} onChange={(e) => setEditing({ ...editing, emoji: e.target.value })} />
                <input className="input" maxLength={32} value={editing.name} aria-label={t('sounds.name')} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <input className="range" type="range" min={0} max={100} step={5} value={editing.volume} aria-label={t('sounds.volume')} onChange={(e) => setEditing({ ...editing, volume: Number(e.target.value) })} />
                <button type="button" className="icon-btn" disabled={busy || !editing.name.trim()} aria-label={t('common.save')} onClick={() => void saveEdit()}>
                  <Check size={16} />
                </button>
                <button type="button" className="icon-btn" disabled={busy} aria-label={t('common.cancel')} onClick={() => setEditing(null)}>
                  <X size={16} />
                </button>
              </>
            ) : (
              <>
                <span className="server-sound-emoji-view" aria-hidden="true">
                  {sound.emoji ?? '🔊'}
                </span>
                <span className="server-sound-name">{sound.name}</span>
                <span className="field-hint">
                  {(sound.durationMs / 1000).toFixed(1)} {t('sounds.seconds')} · {sound.volume}%
                </span>
                {canEdit(sound) && (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={busy}
                      aria-label={t('sounds.edit', { name: sound.name })}
                      onClick={() => setEditing({ id: sound.id, name: sound.name, emoji: sound.emoji ?? '', volume: sound.volume })}
                    >
                      <Pencil size={15} />
                    </button>
                    <button type="button" className="icon-btn" disabled={busy} aria-label={t('sounds.delete', { name: sound.name })} onClick={() => setDeleting(sound)}>
                      <Trash size={15} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {deleting && (
        <ConfirmDialog
          title={t('sounds.delete', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await soundsApi.remove(deleting.id);
              await useSoundboardStore.getState().load(guildId);
            } catch (e) {
              throw new Error(problem(e), { cause: e });
            }
          }}
        >
          <p>{t('sounds.deleteHint')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
