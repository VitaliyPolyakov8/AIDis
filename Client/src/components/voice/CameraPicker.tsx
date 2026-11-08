import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { TriangleAlert, Video } from 'lucide-react';
import { Modal } from '../Modal';
import { voice } from '../../voice/voiceService';
import { CameraError, listCameras, openCamera, presetsFor, trackCapabilities, type CameraDevice, type CameraErrorCode, type CameraPreset } from '../../voice/camera';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVoiceStore } from '../../voice/voiceStore';

const useCameraPickerStore = create<{ open: boolean }>(() => ({ open: false }));

/** 0.5.0: "Camera" in the voice controls opens this (nothing is captured before). */
export function openCameraPicker(): void {
  useCameraPickerStore.setState({ open: true });
}

function closeCameraPicker(): void {
  useCameraPickerStore.setState({ open: false });
}

/** Mounted once in the app shell (web and desktop). */
export function CameraPickerHost() {
  const open = useCameraPickerStore((s) => s.open);
  const inCall = useVoiceStore((s) => s.status === 'connected');
  useEffect(() => {
    if (!inCall) closeCameraPicker();
  }, [inCall]);
  return open && inCall ? <CameraPicker /> : null;
}

/**
 * Webcam dialog: choose the camera (local preview, mirrored like a mirror), a preset the device
 * really supports, then "Start camera". Cancel closes the camera again. Errors (permission denied,
 * camera busy, no camera, unplugged) are shown in place.
 */
function CameraPicker() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const [devices, setDevices] = useState<CameraDevice[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(settings.cameraDeviceId);
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [presets, setPresets] = useState<CameraPreset[]>([]);
  const [error, setError] = useState<CameraErrorCode | null>(null);
  const [starting, setStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const handedOver = useRef(false);

  const refreshDevices = useCallback(async () => {
    const list = await listCameras().catch(() => []);
    setDevices(list);
    return list;
  }, []);

  // Open (or switch) the camera for the preview.
  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      setError(null);
      try {
        const next = await openCamera(deviceId);
        if (run.cancelled) {
          next.stop();
          return;
        }
        trackRef.current?.stop();
        trackRef.current = next;
        setTrack(next);
        setPresets(presetsFor(trackCapabilities(next)));
        const list = await refreshDevices();
        const actual = next.getSettings().deviceId;
        if (!deviceId && actual && list.some((d) => d.deviceId === actual)) setDeviceId(actual);
        next.addEventListener('ended', () => {
          if (trackRef.current === next) setError('busy');
        });
      } catch (e) {
        // The remembered camera is gone (unplugged, or the platform changed its device ids):
        // fall back to the default camera instead of showing "no camera".
        if (!run.cancelled && e instanceof CameraError && e.code === 'notFound' && deviceId !== null) {
          setDeviceId(null);
          return;
        }
        if (!run.cancelled) setError(e instanceof CameraError ? e.code : 'failed');
        await refreshDevices();
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [deviceId, refreshDevices]);

  // Plugged / unplugged cameras update the list.
  useEffect(() => {
    const onChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // Closing without starting releases the camera.
  useEffect(
    () => () => {
      if (!handedOver.current) trackRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);

  const chosen = presets.find((p) => p.resolution === settings.cameraResolution && p.fps === settings.cameraFps) ?? presets[0] ?? null;
  const resolutions = [...new Set(presets.map((p) => p.resolution))];
  const fpsOptions = [...new Set(presets.filter((p) => p.resolution === (chosen?.resolution ?? '720p')).map((p) => p.fps))];

  const start = async () => {
    if (!track || !chosen) return;
    setStarting(true);
    await track.applyConstraints({ width: { ideal: chosen.width }, height: { ideal: chosen.height }, frameRate: { ideal: chosen.frameRate } }).catch(() => undefined);
    settings.update({ cameraDeviceId: deviceId });
    handedOver.current = true;
    const ok = await voice.publishCamera(track, chosen);
    setStarting(false);
    if (ok) closeCameraPicker();
    else {
      handedOver.current = false;
      trackRef.current = null;
      setTrack(null);
      setError('failed');
    }
  };

  return (
    <Modal
      title={t('camera.title')}
      onClose={closeCameraPicker}
      size="md"
      className="camera-picker"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={closeCameraPicker}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!track || !chosen || starting || error !== null} onClick={() => void start()}>
            <Video size={15} aria-hidden="true" />
            {starting ? t('camera.starting') : t('camera.startStream')}
          </button>
        </>
      }
    >
      <div className="camera-preview">
        <video ref={videoRef} autoPlay playsInline muted className="is-mirrored" />
        {!track && !error && <span className="spinner spinner-lg" aria-hidden="true" />}
        {error && (
          <p className="alert alert-warn camera-error" role="alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <span className="alert-text">{t(`camera.errors.${error}`)}</span>
          </p>
        )}
      </div>
      <div className="field-grid camera-fields">
        <div className="field">
          <label className="field-label" htmlFor="camera-device">
            {t('camera.device')}
          </label>
          <select id="camera-device" className="select" value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value || null)}>
            {(devices ?? []).length === 0 && <option value="">{t('camera.noCameras')}</option>}
            {(devices ?? []).map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="camera-resolution">
            {t('camera.resolution')}
          </label>
          <select
            id="camera-resolution"
            className="select"
            value={chosen?.resolution ?? '720p'}
            disabled={resolutions.length === 0}
            onChange={(e) => settings.update({ cameraResolution: e.target.value === '1080p' ? '1080p' : '720p' })}
          >
            {resolutions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="camera-fps">
            {t('camera.fps')}
          </label>
          <select id="camera-fps" className="select" value={chosen?.fps ?? 30} disabled={fpsOptions.length === 0} onChange={(e) => settings.update({ cameraFps: e.target.value === '60' ? 60 : 30 })}>
            {fpsOptions.map((f) => (
              <option key={f} value={f}>
                {f} FPS
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="field-hint">{t('camera.privacy')}</p>
    </Modal>
  );
}
