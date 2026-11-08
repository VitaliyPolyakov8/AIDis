import { useTranslation } from 'react-i18next';
import { PTT_RELEASE_DELAY_MAX_MS, type VoiceInputMode } from '../../desktop/contract';
import { useDesktopStore } from '../../desktop/desktopStore';
import { useUiStore } from '../../stores/uiStore';
import { displayBinding } from '../../desktop/keyLabels';

/** Voice & audio → input mode (desktop only): voice activity or global push-to-talk. */
export function VoiceInputModeCard() {
  const { t } = useTranslation();
  const input = useDesktopStore((s) => s.settings.voiceInput);
  const pttKey = useDesktopStore((s) => s.settings.keybinds.pushToTalk);
  const pttAvailable = useDesktopStore((s) => s.hotkeyStatus.pttAvailable);
  const update = useDesktopStore((s) => s.update);
  const openSettings = useUiStore((s) => s.openSettings);

  const modes: VoiceInputMode[] = ['voiceActivity', 'pushToTalk'];

  return (
    <div className="settings-card">
      <h4 className="settings-card-title">{t('desktop.input.title')}</h4>
      <div className="choice-row" role="radiogroup" aria-label={t('desktop.input.title')}>
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={input.mode === mode}
            className={`choice choice-text${input.mode === mode ? ' is-active' : ''}`}
            onClick={() => void update({ voiceInput: { mode } })}
          >
            {t(`desktop.input.${mode}`)}
            <span className="field-hint">{t(`desktop.input.${mode}Hint`)}</span>
          </button>
        ))}
      </div>
      {input.mode === 'pushToTalk' && (
        <>
          <div className="setting-row">
            <span className="setting-row-text">
              <span className="setting-row-title">{t('desktop.input.pttKey')}</span>
              <span className="field-hint">{pttKey ? displayBinding(pttKey) : t('desktop.input.pttKeyMissing')}</span>
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openSettings('keybinds')}>
              {pttKey ? t('desktop.input.changeKey') : t('desktop.input.setKey')}
            </button>
          </div>
          {!pttAvailable && <p className="alert alert-warn">{t('desktop.keybinds.pttUnavailable')}</p>}
          <div className="field">
            <label className="field-label" htmlFor="ptt-delay">
              {t('desktop.input.releaseDelay')}: {t('desktop.input.ms', { value: input.pttReleaseDelayMs })}
            </label>
            <input
              id="ptt-delay"
              className="range"
              type="range"
              min={0}
              max={PTT_RELEASE_DELAY_MAX_MS}
              step={10}
              value={input.pttReleaseDelayMs}
              onChange={(e) => void update({ voiceInput: { pttReleaseDelayMs: Number(e.target.value) } })}
            />
            <span className="field-hint">{t('desktop.input.releaseDelayHint')}</span>
          </div>
        </>
      )}
    </div>
  );
}
