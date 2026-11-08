import { useTranslation } from 'react-i18next';
import { Volume2 } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { playSound, type SoundName } from '../../sounds/sounds';
import { Toggle } from './Toggle';

export function InterfaceSettings() {
  const { t } = useTranslation();
  const sounds = useSettingsStore((s) => s.interfaceSounds);
  const speakingAnimation = useSettingsStore((s) => s.speakingAnimation);
  const participantSounds = useSettingsStore((s) => s.participantSounds);
  const streamViewerSounds = useSettingsStore((s) => s.streamViewerSounds);
  const notificationSound = useSettingsStore((s) => s.notificationSound);
  const notificationVolume = useSettingsStore((s) => s.notificationVolume);
  const update = useSettingsStore((s) => s.update);
  const PREVIEWS: { name: SoundName; key: string }[] = [
    { name: 'join', key: 'join' },
    { name: 'leave', key: 'leave' },
    { name: 'shareStart', key: 'streamStart' },
    { name: 'viewerJoin', key: 'viewer' },
    { name: 'notify', key: 'message' },
  ];
  return (
    <div className="settings-stack">
      <div className="settings-card">
        <div className="setting-row-text">
          <span className="setting-row-title">{t('settings.interface.soundPreviewTitle')}</span>
          <span className="field-hint">{t('settings.interface.soundPreviewHint')}</span>
        </div>
        <div className="sound-previews">
          {PREVIEWS.map(({ name, key }) => (
            <button key={key} type="button" className="btn btn-secondary btn-sm" onClick={() => playSound(name, { force: true })}>
              <Volume2 size={14} aria-hidden="true" />
              {t(`settings.interface.soundPreview.${key}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <Toggle
          label={t('settings.interface.sounds')}
          hint={t('settings.interface.soundsHint')}
          checked={sounds}
          onChange={(v) => {
            update({ interfaceSounds: v });
            if (v) playSound('unmute', { force: true });
          }}
        />
        <Toggle
          label={t('settings.interface.participantSounds')}
          hint={t('settings.interface.participantSoundsHint')}
          checked={participantSounds && sounds}
          disabled={!sounds}
          onChange={(v) => {
            update({ participantSounds: v });
            if (v) playSound('userJoin', { force: true });
          }}
        />
        <Toggle
          label={t('settings.interface.viewerSounds')}
          hint={t('settings.interface.viewerSoundsHint')}
          checked={streamViewerSounds && sounds}
          disabled={!sounds}
          onChange={(v) => {
            update({ streamViewerSounds: v });
            if (v) playSound('viewerJoin', { force: true });
          }}
        />
        <div className="setting-row is-compact">
          <span />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!sounds} onClick={() => playSound('join', { force: true })}>
            <Volume2 size={14} aria-hidden="true" />
            {t('settings.interface.preview')}
          </button>
        </div>
      </div>
      <div className="settings-card">
        <Toggle
          label={t('settings.interface.notificationSound')}
          hint={t('settings.interface.notificationSoundHint')}
          checked={notificationSound}
          onChange={(v) => {
            update({ notificationSound: v });
            if (v) playSound('notify', { force: true });
          }}
        />
        <div className="setting-row">
          <label className="setting-row-title" htmlFor="notify-volume">
            {t('settings.interface.notificationVolume')}
          </label>
          <span className="setting-row-control">
            <input
              id="notify-volume"
              type="range"
              min={0}
              max={100}
              step={5}
              value={notificationVolume}
              disabled={!notificationSound}
              onChange={(e) => update({ notificationVolume: Number(e.target.value) })}
              onPointerUp={() => playSound('notify', { force: true })}
            />
            <span className="setting-row-value">{notificationVolume}%</span>
          </span>
        </div>
      </div>
      <div className="settings-card">
        <Toggle label={t('settings.interface.speakingAnimation')} hint={t('settings.interface.speakingAnimationHint')} checked={speakingAnimation} onChange={(v) => update({ speakingAnimation: v })} />
      </div>
    </div>
  );
}
