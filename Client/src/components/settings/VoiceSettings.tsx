import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Circle, Mic, Play, Square } from 'lucide-react';
import { t as translate } from '../../i18n';
import { Track } from 'livekit-client';
import { Toggle } from './Toggle';
import { TtsSettings } from './TtsSettings';
import { GateIndicator, MicLevelMeter } from './MicLevel';
import { useSettingsStore, type Settings } from '../../stores/settingsStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { effectiveAgc, voice } from '../../voice/voiceService';
import { MicPipeline, type GateMode, type MicLevel } from '../../voice/micPipeline';
import { isDesktop } from '../../desktop/bridge';
import { VoiceInputModeCard } from './VoiceInputMode';
import { isIosDevice } from '../../pwa/webApp';
import { toast } from '../../stores/uiStore';
import { canSelectOutputDevice, listDevices, mediaDevicesSupported, microphoneErrorMessage, onDeviceChange, type DeviceOption } from '../../voice/devices';

function useDevices() {
  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const refresh = useCallback(() => {
    void listDevices('audioinput').then(setInputs);
    void listDevices('audiooutput').then(setOutputs);
  }, []);
  useEffect(() => {
    refresh();
    return onDeviceChange(refresh);
  }, [refresh]);
  return { inputs, outputs, refresh };
}

function gateModeFor(settings: Settings, pttMode: boolean): GateMode {
  if (pttMode) return 'open';
  return settings.autoSensitivity ? 'auto' : 'manual';
}

/**
 * Local microphone test: the selected microphone goes through the same pipeline as a call
 * (input volume + voice gate) but nowhere else. "Hear myself" plays the processed result on this
 * device only, so the user hears exactly what the channel would get; nothing is sent to LiveKit.
 */
function useMicTest(settings: Settings, gateMode: GateMode) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState<MicLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playback, setPlayback] = useState(false);
  const session = useRef<{ pipeline: MicPipeline; stop: () => void; audio: HTMLAudioElement | null } | null>(null);

  const stop = useCallback(() => {
    session.current?.stop();
    session.current = null;
    setTesting(false);
    setLevel(null);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.inputDeviceId !== 'default' ? { exact: settings.inputDeviceId } : undefined,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppressionMode === 'standard',
          autoGainControl: effectiveAgc({ autoGainControl: settings.autoGainControl, inputVolume: settings.inputVolume }),
        },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No audio track');
      context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      const pipeline = new MicPipeline();
      pipeline.setNoiseSuppression(settings.noiseSuppressionMode === 'strong');
      pipeline.setVolume(settings.inputVolume);
      pipeline.setGate(gateMode, settings.sensitivityDb);
      await pipeline.init({ kind: Track.Kind.Audio, track, audioContext: context });
      const off = pipeline.onLevel(setLevel);
      const ctx = context;
      const media = stream;
      session.current = {
        pipeline,
        audio: null,
        stop: () => {
          off();
          const audio = session.current?.audio;
          if (audio) {
            audio.pause();
            audio.srcObject = null;
          }
          void pipeline.destroy();
          for (const t of media.getTracks()) t.stop();
          void ctx.close().catch(() => undefined);
        },
      };
      setTesting(true);
    } catch (e) {
      for (const t of stream?.getTracks() ?? []) t.stop();
      void context?.close().catch(() => undefined);
      setError(microphoneErrorMessage(e));
    }
  }, [settings.inputDeviceId, settings.echoCancellation, settings.noiseSuppressionMode, settings.autoGainControl, settings.inputVolume, settings.sensitivityDb, gateMode]);

  // Volume and threshold changes apply to the running test immediately.
  useEffect(() => {
    session.current?.pipeline.setVolume(settings.inputVolume);
    session.current?.pipeline.setGate(gateMode, settings.sensitivityDb);
  }, [settings.inputVolume, settings.sensitivityDb, gateMode]);

  // Optional local playback of the processed signal ("hear myself").
  useEffect(() => {
    const current = session.current;
    if (!testing || !current) return;
    const processed = current.pipeline.processedTrack;
    if (!playback || !processed) return;
    const audio = new Audio();
    audio.srcObject = new MediaStream([processed]);
    const sink = settings.outputDeviceId === 'default' ? '' : settings.outputDeviceId;
    if ('setSinkId' in audio) void audio.setSinkId(sink).catch(() => undefined);
    void audio.play().catch(() => undefined);
    current.audio = audio;
    return () => {
      audio.pause();
      audio.srcObject = null;
      if (session.current) session.current.audio = null;
    };
  }, [playback, testing, settings.outputDeviceId]);

  // ---- 0.4.0: record a few seconds locally and play them back (never uploaded) ----------------
  const [recording, setRecording] = useState<{ phase: 'idle' | 'recording' | 'ready'; url: string | null; secondsLeft: number }>({ phase: 'idle', url: null, secondsLeft: 0 });
  const recorderRef = useRef<{ recorder: MediaRecorder; timer: ReturnType<typeof setInterval> } | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const dropRecording = useCallback(() => {
    playerRef.current?.pause();
    playerRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const record = useCallback(async () => {
    if (recorderRef.current) return;
    if (!session.current) await start();
    const processed = session.current?.pipeline.processedTrack;
    if (!processed || typeof MediaRecorder === 'undefined') {
      setError(translate('settings.voice.recordUnsupported'));
      return;
    }
    dropRecording();
    const chunks: Blob[] = [];
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(new MediaStream([processed]), type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const entry = recorderRef.current;
      if (entry) clearInterval(entry.timer);
      recorderRef.current = null;
      const url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      urlRef.current = url;
      setRecording({ phase: 'ready', url, secondsLeft: 0 });
    };
    let left = RECORD_SECONDS;
    setRecording({ phase: 'recording', url: null, secondsLeft: left });
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        if (recorder.state !== 'inactive') recorder.stop();
      } else {
        setRecording((r) => ({ ...r, secondsLeft: left }));
      }
    }, 1000);
    recorderRef.current = { recorder, timer };
    recorder.start();
  }, [start, dropRecording]);

  const playRecording = useCallback(() => {
    if (!urlRef.current) return;
    playerRef.current?.pause();
    const audio = new Audio(urlRef.current);
    const sink = settings.outputDeviceId === 'default' ? '' : settings.outputDeviceId;
    if ('setSinkId' in audio) void audio.setSinkId(sink).catch(() => undefined);
    playerRef.current = audio;
    void audio.play().catch(() => undefined);
  }, [settings.outputDeviceId]);

  // Leaving the page: stop recording, free the blob URL and the player.
  useEffect(
    () => () => {
      const entry = recorderRef.current;
      if (entry) {
        clearInterval(entry.timer);
        entry.recorder.ondataavailable = null;
        entry.recorder.onstop = null;
        if (entry.recorder.state !== 'inactive') entry.recorder.stop();
      }
      recorderRef.current = null;
      dropRecording();
    },
    [dropRecording],
  );

  useEffect(() => stop, [stop]);
  return { testing, level, error, start, stop, playback, setPlayback, recording, record, playRecording };
}

const RECORD_SECONDS = 5;

/** AudioContext.setSinkId (Chromium 110+): needed to send stream audio to a different device. */
function canRouteStreamAudio(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

export function VoiceSettings() {
  const { t } = useTranslation();
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const pttMode = useVoiceStore((s) => s.pttMode);
  const settings = useSettingsStore();
  const update = useSettingsStore((s) => s.update);
  const inCall = useVoiceStore((s) => s.status === 'connected');
  const micPipeline = useVoiceStore((s) => s.micPipeline);
  const micError = useVoiceStore((s) => s.micError);
  const { inputs, outputs, refresh } = useDevices();
  const gateMode = gateModeFor(settings, pttMode);
  const test = useMicTest(settings, gateMode);
  const [callLevel, setCallLevel] = useState<MicLevel | null>(null);

  // While in a call, show the live level of the call's own pipeline instead of opening a second stream.
  const stopTest = test.stop;
  useEffect(() => {
    if (!inCall) return;
    stopTest();
    const timer = setInterval(() => setCallLevel(voice.getMicLevel()), 50);
    return () => clearInterval(timer);
  }, [inCall, stopTest]);

  if (!mediaDevicesSupported()) {
    return <p className="alert alert-warn">{t('settings.voice.unsupported')}</p>;
  }

  const labelsHidden = inputs.length > 0 && inputs.every((d, i) => d.label === t('mic.defaultMic', { n: i + 1 }));
  const level = inCall ? (callLevel ?? (test.testing ? test.level : null)) : test.level;
  const thresholdDb = settings.autoSensitivity && level ? level.threshold : settings.sensitivityDb;

  const setProcessing = (patch: Partial<Settings>) => {
    update(patch);
    if (test.testing) test.stop();
    void voice.applyAudioProcessing();
  };

  return (
    <div className="settings-stack">
      {isIosDevice && (
        // 0.5.9: iPhone / iPad home-screen app: keep the call audible in the background.
        <div className="settings-card">
          <Toggle
            label={t('pwa.backgroundAudio')}
            hint={t('pwa.backgroundAudioHint')}
            checked={settings.iosBackgroundAudio}
            onChange={(v) => {
              settings.update({ iosBackgroundAudio: v });
              if (useVoiceStore.getState().status !== 'idle') toast.info(t('pwa.backgroundAudioRejoin'));
            }}
          />
        </div>
      )}
      <div className="settings-card">
        <Toggle
          label={t('settings.voice.micState')}
          hint={`${micEnabled ? t('settings.voice.micOn') : t('settings.voice.micOff')} · ${t('settings.voice.micStateHint')}`}
          checked={micEnabled}
          onChange={() => void voice.toggleMic()}
        />
      </div>
      <div className="settings-card">
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="input-device">
              {t('settings.voice.microphone')}
            </label>
            <select
              id="input-device"
              className="select"
              value={inputs.some((d) => d.deviceId === settings.inputDeviceId) ? settings.inputDeviceId : 'default'}
              onChange={(e) => {
                if (test.testing) test.stop();
                void voice.setInputDevice(e.target.value);
              }}
            >
              {!inputs.some((d) => d.deviceId === 'default') && <option value="default">{t('settings.voice.systemDefault')}</option>}
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.deviceId === 'default' ? t('settings.voice.systemDefault') : d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="stream-output-device">
              {t('settings.voice.streamOutput')}
            </label>
            {canRouteStreamAudio() && canSelectOutputDevice() ? (
              <select
                id="stream-output-device"
                className="select"
                value={settings.streamOutputDeviceId === 'same' || outputs.some((d) => d.deviceId === settings.streamOutputDeviceId) ? settings.streamOutputDeviceId : 'same'}
                onChange={(e) => void voice.setStreamOutputDevice(e.target.value)}
              >
                <option value="same">{t('settings.voice.sameAsVoice')}</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.deviceId === 'default' ? t('settings.voice.systemDefault') : d.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="readonly-value">{t('settings.voice.streamOutputUnsupported')}</span>
            )}
            <span className="field-hint">{t('settings.voice.streamOutputHint')}</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="output-device">
              {t('settings.voice.speaker')}
            </label>
            {canSelectOutputDevice() ? (
              <select
                id="output-device"
                className="select"
                value={outputs.some((d) => d.deviceId === settings.outputDeviceId) ? settings.outputDeviceId : 'default'}
                onChange={(e) => void voice.setOutputDevice(e.target.value)}
              >
                {!outputs.some((d) => d.deviceId === 'default') && <option value="default">{t('settings.voice.systemDefault')}</option>}
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.deviceId === 'default' ? t('settings.voice.systemDefault') : d.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="readonly-value">{t('settings.voice.outputUnsupported')}</span>
            )}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="input-volume">
            {t('settings.voice.inputVolume')}: {settings.inputVolume}%
          </label>
          <input id="input-volume" className="range" type="range" min={0} max={200} step={5} value={settings.inputVolume} onChange={(e) => update({ inputVolume: Number(e.target.value) })} />
          <span className="field-hint">{settings.autoGainControl && settings.inputVolume !== 100 ? t('settings.voice.inputVolumeAgcHint') : t('settings.voice.inputVolumeHint')}</span>
        </div>
        {labelsHidden && (
          <p className="field-hint">
            {t('settings.voice.labelsHidden')}{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                void navigator.mediaDevices
                  .getUserMedia({ audio: true })
                  .then((s) => {
                    for (const tr of s.getTracks()) tr.stop();
                    refresh();
                  })
                  .catch(() => undefined);
              }}
            >
              {t('settings.voice.allowNow')}
            </button>
          </p>
        )}
      </div>

      {isDesktop && <VoiceInputModeCard />}

      <div className="settings-card">
        <h4 className="settings-card-title">{t('settings.voice.sensitivity')}</h4>
        {pttMode ? (
          <p className="field-hint">{t('settings.voice.sensitivityPtt')}</p>
        ) : (
          <Toggle label={t('settings.voice.autoSensitivity')} hint={t('settings.voice.autoSensitivityHint')} checked={settings.autoSensitivity} onChange={(v) => update({ autoSensitivity: v })} />
        )}
        {inCall && micPipeline === 'bypassed' && <p className="alert alert-warn">{t('settings.voice.pipelineBypassed')}</p>}
        {inCall && micError && (
          <p className="alert alert-warn" role="alert">
            <span className="alert-text">{micError}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void voice.retryMicrophone()}>
              {t('common.retry')}
            </button>
          </p>
        )}
        <MicLevelMeter level={level} thresholdDb={thresholdDb} showThreshold={!pttMode} editable={!pttMode && !settings.autoSensitivity} onThreshold={(db) => update({ sensitivityDb: db })} />
        <div className="mic-test">
          {!pttMode && <GateIndicator level={level} />}
          <span className="mic-test-actions">
            {test.testing && !inCall && (
              <label className="inline-check">
                <input type="checkbox" checked={test.playback} onChange={(e) => test.setPlayback(e.target.checked)} />
                {t('settings.voice.hearMyself')}
              </label>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={inCall && !test.testing}
              title={inCall ? t('settings.voice.testInCall') : undefined}
              onClick={() => (test.testing ? test.stop() : void test.start())}
            >
              {test.testing ? <Square size={13} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
              {test.testing ? t('settings.voice.stopTest') : t('settings.voice.testMic')}
            </button>
          </span>
        </div>
        <p className="field-hint">
          {test.testing && test.playback
            ? t('settings.voice.hearMyselfHint')
            : inCall && !test.testing
              ? t('settings.voice.levelInCall')
              : !pttMode && !settings.autoSensitivity
                ? t('settings.voice.manualSensitivityHint')
                : t('settings.voice.levelHint')}
        </p>
        <div className="mic-record">
          <button type="button" className="btn btn-secondary btn-sm" disabled={inCall || test.recording.phase === 'recording'} onClick={() => void test.record()}>
            <Circle size={12} aria-hidden="true" className={test.recording.phase === 'recording' ? 'rec-dot is-on' : 'rec-dot'} />
            {test.recording.phase === 'recording' ? t('settings.voice.recording', { seconds: test.recording.secondsLeft }) : t('settings.voice.record', { seconds: RECORD_SECONDS })}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={test.recording.phase !== 'ready'} onClick={test.playRecording}>
            <Play size={13} aria-hidden="true" /> {t('settings.voice.playRecording')}
          </button>
          <span className="field-hint">{t('settings.voice.recordHint')}</span>
        </div>
        {test.error && <p className="alert alert-error">{test.error}</p>}
      </div>

      <div className="settings-card">
        <h4 className="settings-card-title">{t('settings.voice.processing')}</h4>
        <div className="setting-row">
          <span className="setting-row-text">
            <span className="setting-row-title">{t('settings.voice.noiseSuppression')}</span>
            <span className="field-hint">{t(`settings.voice.noise.${settings.noiseSuppressionMode}Hint`)}</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label={t('settings.voice.noiseSuppression')}>
            {(['off', 'standard', 'strong'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.noiseSuppressionMode === mode}
                className={settings.noiseSuppressionMode === mode ? 'is-active' : ''}
                onClick={() => setProcessing({ noiseSuppressionMode: mode, noiseSuppression: mode !== 'off' })}
              >
                {t(`settings.voice.noise.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <Toggle label={t('settings.voice.echoCancellation')} hint={t('settings.voice.echoCancellationHint')} checked={settings.echoCancellation} onChange={(v) => setProcessing({ echoCancellation: v })} />
        <Toggle
          label={t('settings.voice.autoGain')}
          hint={settings.inputVolume !== 100 ? t('settings.voice.autoGainManualHint') : t('settings.voice.autoGainHint')}
          checked={effectiveAgc(settings)}
          disabled={settings.inputVolume !== 100}
          onChange={(v) => setProcessing({ autoGainControl: v })}
        />
      </div>

      <div className="settings-card">
        <h4 className="settings-card-title">{t('soundboard.settingsTitle')}</h4>
        <div className="field">
          <label className="field-label" htmlFor="soundboard-volume">
            {t('soundboard.volume')}: {settings.soundboardVolume}%
          </label>
          <input
            id="soundboard-volume"
            className="range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.soundboardVolume}
            disabled={settings.soundboardMuted}
            onChange={(e) => settings.update({ soundboardVolume: Number(e.target.value) })}
          />
        </div>
        <Toggle label={t('soundboard.muted')} hint={t('soundboard.mutedHint')} checked={settings.soundboardMuted} onChange={(v) => settings.update({ soundboardMuted: v })} />
      </div>

      <TtsSettings />
    </div>
  );
}
