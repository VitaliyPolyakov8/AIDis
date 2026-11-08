import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { speak, stopSpeaking, ttsSupported, ttsVoices } from '../../voice/tts';
import { Toggle } from './Toggle';

/** 0.5.2: Settings → Voice → text-to-speech (how this device reads TTS messages aloud). */
export function TtsSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const update = useSettingsStore((s) => s.update);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => ttsVoices());

  // The system voice list arrives asynchronously (voiceschanged) on first use.
  useEffect(() => {
    if (!ttsSupported()) return;
    const refresh = () => setVoices(ttsVoices());
    window.speechSynthesis.addEventListener('voiceschanged', refresh);
    refresh();
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, []);

  if (!ttsSupported()) {
    return (
      <div className="settings-card">
        <h4 className="settings-card-title">{t('tts.settings.title')}</h4>
        <p className="field-hint">{t('tts.settings.unsupported')}</p>
      </div>
    );
  }
  return (
    <div className="settings-card">
      <h4 className="settings-card-title">{t('tts.settings.title')}</h4>
      <Toggle label={t('tts.settings.listen')} hint={t('tts.settings.listenHint')} checked={settings.ttsListen} onChange={(v) => update({ ttsListen: v })} />
      <Toggle label={t('tts.settings.send')} hint={t('tts.settings.sendHint')} checked={settings.ttsSend} onChange={(v) => update({ ttsSend: v })} />
      <div className="field">
        <label className="field-label" htmlFor="tts-voice">
          {t('tts.settings.voice')}
        </label>
        <select id="tts-voice" className="select" value={settings.ttsVoiceUri ?? ''} onChange={(e) => update({ ttsVoiceUri: e.target.value || null })}>
          <option value="">{t('tts.settings.voiceAuto')}</option>
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tts-volume">
          {t('tts.settings.volume')}: {settings.ttsVolume}%
        </label>
        <input id="tts-volume" className="range" type="range" min={0} max={100} step={5} value={settings.ttsVolume} onChange={(e) => update({ ttsVolume: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tts-rate">
          {t('tts.settings.rate')}: {(settings.ttsRate / 100).toFixed(1)}×
        </label>
        <input id="tts-rate" className="range" type="range" min={50} max={200} step={10} value={settings.ttsRate} onChange={(e) => update({ ttsRate: Number(e.target.value) })} />
      </div>
      <div className="mic-test-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            stopSpeaking();
            speak(t('tts.settings.sample'));
          }}
        >
          <Play size={13} aria-hidden="true" /> {t('tts.settings.test')}
        </button>
        <span className="field-hint">{t('tts.settings.hint')}</span>
      </div>
    </div>
  );
}
