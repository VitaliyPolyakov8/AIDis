/**
 * 0.4.0 live voice diagnostics from WebRTC stats (Settings -> Diagnostics). Pure parsing of
 * RTCStatsReport-like objects so it is testable without a browser.
 */
export interface AudioDiagnostics {
  codec: string | null;
  /** Outgoing (our microphone) or incoming bitrate, kbit/s, between two samples. */
  bitrateKbps: number | null;
  jitterMs: number | null;
  lossPercent: number | null;
  rttMs: number | null;
  /** host / srflx / prflx / relay (relay = through TURN). */
  candidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
}

export interface AudioCounters {
  timestamp: number;
  bytes: number;
}

type StatsLike = Record<string, unknown> & { id: string; type: string };

function values(report: unknown): StatsLike[] {
  if (!report || typeof (report as { forEach?: unknown }).forEach !== 'function') return [];
  const out: StatsLike[] = [];
  (report as { forEach: (cb: (v: unknown) => void) => void }).forEach((v) => {
    if (v && typeof v === 'object' && typeof (v as StatsLike).id === 'string' && typeof (v as StatsLike).type === 'string') out.push(v as StatsLike);
  });
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isAudio = (s: StatsLike) => s.kind === 'audio' || s.mediaType === 'audio';

export function parseAudioStats(report: unknown, previous: AudioCounters | null): { diag: AudioDiagnostics; counters: AudioCounters | null } {
  const entries = values(report);
  const byId = new Map(entries.map((s) => [s.id, s]));
  const outbound = entries.find((s) => s.type === 'outbound-rtp' && isAudio(s));
  const inbound = entries.find((s) => s.type === 'inbound-rtp' && isAudio(s));
  const rtp = outbound ?? inbound;
  const remoteInbound = entries.find((s) => s.type === 'remote-inbound-rtp' && isAudio(s));

  const codecEntry = rtp ? byId.get(String(rtp.codecId)) : undefined;
  const codec = str(codecEntry?.mimeType)?.replace(/^audio\//i, '') ?? null;

  const bytes = num(outbound ? outbound.bytesSent : inbound?.bytesReceived);
  const timestamp = num(rtp?.timestamp);
  let bitrateKbps: number | null = null;
  if (previous && bytes !== null && timestamp !== null && timestamp > previous.timestamp && bytes >= previous.bytes) {
    bitrateKbps = Math.round(((bytes - previous.bytes) * 8) / (timestamp - previous.timestamp));
  }

  // Jitter: what the other side measured of our audio (remote-inbound) or what we measure (inbound).
  const jitterSec = num(remoteInbound?.jitter) ?? num(inbound?.jitter);
  const lossFraction = num(remoteInbound?.fractionLost);
  let lossPercent: number | null = lossFraction !== null ? lossFraction * 100 : null;
  if (lossPercent === null && inbound) {
    const lost = num(inbound.packetsLost);
    const got = num(inbound.packetsReceived);
    if (lost !== null && got !== null && lost + got > 0) lossPercent = (lost / (lost + got)) * 100;
  }

  const pair =
    entries.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded') ??
    entries.find((s) => s.type === 'candidate-pair' && s.selected === true) ??
    (() => {
      const transport = entries.find((s) => s.type === 'transport');
      return transport ? byId.get(String(transport.selectedCandidatePairId)) : undefined;
    })();
  const local = pair ? byId.get(String(pair.localCandidateId)) : undefined;
  const rttSec = num(pair?.currentRoundTripTime) ?? num(remoteInbound?.roundTripTime);

  return {
    diag: {
      codec,
      bitrateKbps,
      jitterMs: jitterSec !== null ? Math.round(jitterSec * 1000) : null,
      lossPercent: lossPercent !== null ? Math.round(lossPercent * 10) / 10 : null,
      rttMs: rttSec !== null ? Math.round(rttSec * 1000) : null,
      candidateType: str(local?.candidateType),
      protocol: str(local?.protocol),
      relayProtocol: str(local?.relayProtocol),
    },
    counters: bytes !== null && timestamp !== null ? { bytes, timestamp } : null,
  };
}
