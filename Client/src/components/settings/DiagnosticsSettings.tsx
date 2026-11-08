import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ClipboardCopy, FolderOpen, Monitor, Radio, Server, Smartphone } from 'lucide-react';
import { config, apiUrl } from '../../config';
import { desktop } from '../../desktop/bridge';
import type { DesktopAppInfo } from '../../desktop/contract';
import { useConnectionStore } from '../../stores/connectionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/uiStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { voice } from '../../voice/voiceService';
import { listDevices, type DeviceOption } from '../../voice/devices';
import { parseAudioStats, type AudioCounters, type AudioDiagnostics } from '../../voice/voiceDiagnostics';
import { useStreamStats, type StreamStats } from '../../voice/streamStats';

interface ServerProbe {
  reachable: boolean | null;
  latencyMs: number | null;
  version: string | null;
}

/** /health three times; the best round trip is the API latency (no auth, no data). */
async function probeServer(): Promise<ServerProbe> {
  const times: number[] = [];
  let version: string | null = null;
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    try {
      const res = await fetch(apiUrl('/health'), { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) continue;
      times.push(performance.now() - started);
      const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
      if (typeof body?.version === 'string') version = body.version;
    } catch {
      /* unreachable */
    }
  }
  return { reachable: times.length > 0, latencyMs: times.length > 0 ? Math.round(Math.min(...times)) : null, version };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="diag-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="diag-card">
      <h4 className="diag-card-title">
        {icon} {title}
      </h4>
      <dl className="diag-list">{children}</dl>
    </section>
  );
}

const dash = '—';
const fmt = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? dash : `${v}${unit}`);

function useVoiceDiagnostics(active: boolean) {
  const [state, setState] = useState<{ connection: string; local: AudioDiagnostics | null; remote: AudioDiagnostics | null; remoteName: string | null }>({ connection: 'disconnected', local: null, remote: null, remoteName: null });
  const prev = useRef<{ local: AudioCounters | null; remote: AudioCounters | null }>({ local: null, remote: null });
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = async () => {
      const r = await voice.getVoiceStatsReports();
      if (stopped) return;
      const local = r.local ? parseAudioStats(r.local, prev.current.local) : null;
      const remote = r.remote ? parseAudioStats(r.remote, prev.current.remote) : null;
      prev.current = { local: local?.counters ?? null, remote: remote?.counters ?? null };
      setState({ connection: r.state, local: local?.diag ?? null, remote: remote?.diag ?? null, remoteName: r.remoteName });
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active]);
  return state;
}

function deviceLabel(list: DeviceOption[], id: string, fallback: string): string {
  if (id === 'default' || id === 'same') return fallback;
  return list.find((d) => d.deviceId === id)?.label || fallback;
}

/** 0.4.0 Settings -> Diagnostics: versions, server, voice and stream health, copyable report. */
export function DiagnosticsSettings() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DesktopAppInfo | null>(null);
  const [server, setServer] = useState<ServerProbe>({ reachable: null, latencyMs: null, version: null });
  const [devices, setDevices] = useState<{ inputs: DeviceOption[]; outputs: DeviceOption[] }>({ inputs: [], outputs: [] });
  const socket = useConnectionStore((s) => s.socket);
  const status = useVoiceStore((s) => s.status);
  const stats = useVoiceStore((s) => s.stats);
  const localSharing = useVoiceStore((s) => s.localScreenSharing);
  const focusedShare = useVoiceStore((s) => s.focusedShare);
  const selfId = useAuthStore((s) => s.user?.id);
  const settings = useSettingsStore();
  const inCall = status === 'connected' || status === 'reconnecting';
  const voiceDiag = useVoiceDiagnostics(inCall);
  const shareIdentity = localSharing ? (selfId ?? null) : focusedShare;
  const stream = useStreamStats(inCall && shareIdentity ? voice.getScreenShareTrack(shareIdentity) : null, inCall && !!shareIdentity);

  useEffect(() => {
    void desktop?.app.getInfo().then(setInfo);
    void probeServer().then(setServer);
    void Promise.all([listDevices('audioinput'), listDevices('audiooutput')]).then(([inputs, outputs]) => setDevices({ inputs, outputs }));
  }, []);

  const defaultLabel = t('diagnostics.default');
  const mic = deviceLabel(devices.inputs, settings.inputDeviceId, defaultLabel);
  const out = deviceLabel(devices.outputs, settings.outputDeviceId, defaultLabel);
  const streamOut = settings.streamOutputDeviceId === 'same' ? t('diagnostics.sameAsVoice') : deviceLabel(devices.outputs, settings.streamOutputDeviceId, defaultLabel);
  const transport = (d: AudioDiagnostics | null) => {
    if (!d?.candidateType && !stats?.transport) return stats?.transport ?? dash;
    const relay = d?.candidateType === 'relay' || stats?.transport === 'TURN';
    const proto = (d?.relayProtocol ?? d?.protocol ?? '').toUpperCase();
    return relay ? `TURN${proto ? ` (${proto})` : ''}` : proto || dash;
  };

  const reportText = (): string => {
    const lines = [
      `AIDis diagnostics · ${new Date().toISOString()}`,
      `Client: web ${config.clientVersion}${info ? ` · desktop ${info.appVersion} · Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · ${info.platform}/${info.arch}` : ' · browser'}`,
      `Server: ${server.reachable === null ? 'checking' : server.reachable ? 'reachable' : 'unreachable'} · API ${fmt(server.latencyMs, ' ms')}${server.version ? ` · ${server.version}` : ''} · Socket.IO ${socket}`,
      `Voice: ${status} · LiveKit ${voiceDiag.connection} · RTT ${fmt(voiceDiag.local?.rttMs ?? stats?.rttMs ?? null, ' ms')} · jitter ${fmt(voiceDiag.remote?.jitterMs ?? voiceDiag.local?.jitterMs, ' ms')} · loss ${fmt(voiceDiag.local?.lossPercent ?? stats?.lossPercent ?? null, '%')} · codec ${voiceDiag.local?.codec ?? dash} · out ${fmt(voiceDiag.local?.bitrateKbps, ' kbps')} · transport ${transport(voiceDiag.local)}`,
      `Devices: mic "${mic}" · voice out "${out}" · stream out "${streamOut}" · noise ${settings.noiseSuppressionMode}`,
      stream ? `Stream: ${stream.direction} ${stream.width ?? '?'}x${stream.height ?? '?'} · capture ${fmt(stream.captureFps)} fps · ${stream.direction === 'outbound' ? 'send' : 'receive'} ${fmt(stream.fps)} fps · ${stream.bitrateBps ? `${(stream.bitrateBps / 1e6).toFixed(1)} Mbps` : dash} · ${stream.codec ?? dash} · loss ${fmt(stream.lossPercent, '%')}` : 'Stream: none',
    ];
    // Sanitized on purpose: no tokens, ids, passwords, server secrets or message content.
    return lines.join('\n');
  };

  const copy = () => {
    navigator.clipboard.writeText(reportText()).then(
      () => toast.success(t('diagnostics.copied'), 'diag-copy'),
      () => toast.error(t('diagnostics.copyFailed'), 'diag-copy'),
    );
  };

  return (
    <div className="settings-section diagnostics">
      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={copy}>
          <ClipboardCopy size={15} aria-hidden="true" /> {t('diagnostics.copy')}
        </button>
        {desktop && (
          <button type="button" className="btn btn-secondary" onClick={() => desktop?.app.openLogsFolder()}>
            <FolderOpen size={15} aria-hidden="true" /> {t('diagnostics.openLogs')}
          </button>
        )}
      </div>
      <div className="diag-grid">
        <Card icon={desktop ? <Monitor size={16} /> : <Smartphone size={16} />} title={t('diagnostics.client')}>
          <Row label={t('diagnostics.webVersion')}>{config.clientVersion}</Row>
          {info ? (
            <>
              <Row label={t('diagnostics.desktopVersion')}>{info.appVersion}</Row>
              <Row label="Electron">{info.electronVersion}</Row>
              <Row label="Chromium">{info.chromeVersion}</Row>
              <Row label={t('diagnostics.platform')}>{`${info.platform} ${info.arch}`}</Row>
            </>
          ) : (
            <Row label={t('diagnostics.browser')}>{navigator.userAgent.match(/(Chrome|Firefox|Edg|Safari)\/[\d.]+/)?.[0] ?? dash}</Row>
          )}
        </Card>
        <Card icon={<Server size={16} />} title={t('diagnostics.server')}>
          <Row label={t('diagnostics.reachable')}>
            <span className={`diag-state is-${server.reachable === null ? 'pending' : server.reachable ? 'ok' : 'bad'}`}>
              {server.reachable === null ? t('diagnostics.checking') : server.reachable ? t('diagnostics.yes') : t('diagnostics.no')}
            </span>
          </Row>
          <Row label={t('diagnostics.apiLatency')}>{fmt(server.latencyMs, ` ${t('diagnostics.ms')}`)}</Row>
          <Row label="Socket.IO">
            <span className={`diag-state is-${socket === 'connected' ? 'ok' : socket === 'idle' ? 'pending' : 'bad'}`}>{t(`diagnostics.socket.${socket}`)}</span>
          </Row>
        </Card>
        <Card icon={<Radio size={16} />} title={t('diagnostics.voice')}>
          <Row label="LiveKit">
            <span className={`diag-state is-${inCall ? 'ok' : 'pending'}`}>{inCall ? voiceDiag.connection : t('diagnostics.notInCall')}</span>
          </Row>
          <Row label="RTT">{fmt(voiceDiag.local?.rttMs ?? stats?.rttMs ?? null, ` ${t('diagnostics.ms')}`)}</Row>
          <Row label={t('diagnostics.jitter')}>{fmt(voiceDiag.remote?.jitterMs ?? voiceDiag.local?.jitterMs, ` ${t('diagnostics.ms')}`)}</Row>
          <Row label={t('diagnostics.loss')}>{fmt(voiceDiag.local?.lossPercent ?? stats?.lossPercent ?? null, '%')}</Row>
          <Row label={t('diagnostics.codec')}>{voiceDiag.local?.codec ?? voiceDiag.remote?.codec ?? dash}</Row>
          <Row label={t('diagnostics.bitrate')}>{voiceDiag.local && voiceDiag.local.bitrateKbps !== null ? `${voiceDiag.local.bitrateKbps} kbps ↑` : dash}</Row>
          <Row label={t('diagnostics.transport')}>{transport(voiceDiag.local)}</Row>
          <Row label={t('diagnostics.mic')}>{mic}</Row>
          <Row label={t('diagnostics.voiceOut')}>{out}</Row>
          <Row label={t('diagnostics.streamOut')}>{streamOut}</Row>
        </Card>
        <Card icon={<Activity size={16} />} title={t('diagnostics.stream')}>
          {stream ? <StreamRows stream={stream} /> : <Row label={t('diagnostics.state')}>{t('diagnostics.noStream')}</Row>}
        </Card>
      </div>
      <p className="field-hint">{t('diagnostics.privacy')}</p>
    </div>
  );
}

function StreamRows({ stream }: { stream: StreamStats }) {
  const { t } = useTranslation();
  return (
    <>
      <Row label={t('diagnostics.direction')}>{stream.direction === 'outbound' ? t('diagnostics.sending') : t('diagnostics.receiving')}</Row>
      <Row label={t('diagnostics.resolution')}>{stream.width && stream.height ? `${stream.width}×${stream.height}` : dash}</Row>
      {stream.direction === 'outbound' && <Row label={t('diagnostics.captureFps')}>{fmt(stream.captureFps)}</Row>}
      <Row label={stream.direction === 'outbound' ? t('diagnostics.sendFps') : t('diagnostics.receiveFps')}>{fmt(stream.fps)}</Row>
      <Row label={t('diagnostics.bitrate')}>{stream.bitrateBps ? `${(stream.bitrateBps / 1e6).toFixed(1)} Mbps` : dash}</Row>
      <Row label={t('diagnostics.codec')}>{stream.codec ?? dash}</Row>
      <Row label={t('diagnostics.loss')}>{fmt(stream.lossPercent, '%')}</Row>
      <Row label={t('diagnostics.limitation')}>{stream.limitation ?? dash}</Row>
    </>
  );
}
