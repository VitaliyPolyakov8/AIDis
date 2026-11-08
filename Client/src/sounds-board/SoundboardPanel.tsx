import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Headphones } from 'lucide-react';
import type { SoundView } from '../api/types';
import { toast } from '../stores/uiStore';
import { soundPlayer } from './player';
import { useGuildSounds, useSoundboardStore } from './store';

const REFUSALS = ['RATE_LIMITED', 'FORBIDDEN', 'NOT_IN_VOICE', 'NOT_FOUND', 'OFFLINE', 'TIMEOUT'];

/** 0.7.1: the grid of a server's sounds; a press is heard by everyone in the voice channel. */
export function SoundboardPanel({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const sounds = useGuildSounds(guildId);
  const [loading, setLoading] = useState(sounds.length === 0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    useSoundboardStore
      .getState()
      .load(guildId)
      .then(
        () => setLoading(false),
        () => {
          setLoading(false);
          setFailed(true);
        },
      );
  }, [guildId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const press = async (sound: SoundView) => {
    const result = await useSoundboardStore.getState().play(sound.id);
    if (result !== 'ok') toast.error(t(`soundboard.refused.${REFUSALS.includes(result) ? result : 'other'}`), 'soundboard');
  };

  return (
    <div className="soundboard-panel" role="dialog" aria-label={t('soundboard.title')}>
      <div className="soundboard-head">
        <strong>{t('soundboard.title')}</strong>
        <span className="field-hint">{t('soundboard.hint')}</span>
      </div>
      {loading && <span className="spinner" role="status" aria-label={t('common.loading')} />}
      {failed && <p className="field-error">{t('soundboard.loadFailed')}</p>}
      {!loading && !failed && sounds.length === 0 && <p className="field-hint">{t('soundboard.empty')}</p>}
      <div className="soundboard-grid">
        {sounds.map((sound) => (
          <div key={sound.id} className="soundboard-item">
            <button type="button" className="soundboard-sound" title={sound.name} onClick={() => void press(sound)}>
              <span className="soundboard-emoji" aria-hidden="true">
                {sound.emoji ?? '🔊'}
              </span>
              <span className="soundboard-name">{sound.name}</span>
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-sm soundboard-preview"
              aria-label={t('soundboard.preview', { name: sound.name })}
              title={t('soundboard.previewHint')}
              onClick={() => void soundPlayer.play(sound).catch(() => undefined)}
            >
              <Headphones size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
