import { LocalAudioTrack, RemoteAudioTrack, type Room, Track } from 'livekit-client';
import type { ConnectionQualityLevel } from './voiceStore';
import { statsValues, type StatsLike } from './rtcStats';

/**
 * Real WebRTC statistics for the voice connection, read from the browser's RTCPeerConnection
 * via LiveKit's track.getRTCStatsReport() (RTCRtpSender/Receiver.getStats()). Nothing is
 * estimated and no HTTP ping is used.
 *
 * - RTT: currentRoundTripTime of the selected ICE candidate pair (STUN consent checks on the
 *   media path), falling back to remote-inbound-rtp.roundTripTime (RTCP).
 * - Packet loss: change of packetsLost / packets between two samples (so it reflects the last
 *   ~1.5 s, not the whole call). Outgoing audio uses remote-inbound-rtp (what the server reports
 *   it lost from us); otherwise incoming audio uses inbound-rtp.
 * - Transport: the local candidate of the selected pair: relay -> TURN, else its protocol.
 */

export type Transport = 'UDP' | 'TCP' | 'TURN';

export interface ConnectionStats {
  rttMs: number | null;
  lossPercent: number | null;
  transport: Transport | null;
  /** TURN carrying protocol when known (udp/tcp/tls). */
  relayProtocol: string | null;
}

export interface LossCounters {
  lost: number;
  total: number;
}

/** Where the RTT came from (for diagnostics). */
export type RttSource = 'candidate-pair' | 'remote-inbound-rtp' | 'candidate-pair-average';

export interface ParsedReport {
  rttMs: number | null;
  rttSource: RttSource | null;
  /** A selected/nominated ICE candidate pair was found in the report. */
  pairFound: boolean;
  transport: Transport | null;
  relayProtocol: string | null;
  /** Cumulative counters for the audio stream in this report. */
  counters: LossCounters | null;
}


function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Extracts RTT, transport and loss counters from one RTCStatsReport (pure, unit-tested). */
export function parseStatsReport(report: unknown): ParsedReport {
  const entries = statsValues(report);
  const byId = new Map<string, StatsLike>(entries.map((s) => [s.id, s]));

  // Selected candidate pair: transport.selectedCandidatePairId (Chromium/Firefox), else the
  // nominated succeeded pair.
  let pair: StatsLike | undefined;
  for (const s of entries) {
    if (s.type === 'transport') {
      const id = str(s.selectedCandidatePairId);
      if (id) pair = byId.get(id);
    }
  }
  pair ??= entries.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded');
  pair ??= entries.find((s) => s.type === 'candidate-pair' && s.selected === true);

  // RTT, best source first. All WebRTC RTT fields are in SECONDS (x1000 -> ms).
  //  1. selected pair currentRoundTripTime (ICE consent checks on the media path)
  //  2. remote-inbound-rtp roundTripTime (RTCP, latest measurement), see below
  //  3. selected pair totalRoundTripTime / responsesReceived (average since connect)
  let rtt = num(pair?.currentRoundTripTime);
  let rttSource: RttSource | null = rtt !== null ? 'candidate-pair' : null;
  let transport: Transport | null = null;
  let relayProtocol: string | null = null;
  const local = pair ? byId.get(str(pair.localCandidateId) ?? '') : undefined;
  if (local) {
    const candidateType = str(local.candidateType);
    const protocol = str(local.protocol)?.toLowerCase();
    if (candidateType === 'relay') {
      transport = 'TURN';
      relayProtocol = str(local.relayProtocol)?.toUpperCase() ?? null;
    } else if (protocol === 'udp') transport = 'UDP';
    else if (protocol === 'tcp') transport = 'TCP';
  }

  let counters: LossCounters | null = null;
  const remoteInbound = entries.find((s) => s.type === 'remote-inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'));
  if (remoteInbound) {
    const rtcpRtt = num(remoteInbound.roundTripTime);
    if (rtt === null && rtcpRtt !== null) {
      rtt = rtcpRtt;
      rttSource = 'remote-inbound-rtp';
    }
    const lost = num(remoteInbound.packetsLost);
    const outbound = entries.find((s) => s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'));
    const sent = num(outbound?.packetsSent);
    if (lost !== null && sent !== null) counters = { lost: Math.max(0, lost), total: sent };
  }
  if (!counters) {
    const inbound = entries.find((s) => s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'));
    const lost = num(inbound?.packetsLost);
    const received = num(inbound?.packetsReceived);
    if (lost !== null && received !== null) counters = { lost: Math.max(0, lost), total: received + Math.max(0, lost) };
  }

  if (rtt === null && pair) {
    const total = num(pair.totalRoundTripTime);
    const responses = num(pair.responsesReceived);
    if (total !== null && responses !== null && responses > 0) {
      rtt = total / responses;
      rttSource = 'candidate-pair-average';
    }
  }

  return {
    rttMs: rtt === null ? null : Math.round(rtt * 1000),
    rttSource,
    pairFound: pair !== undefined,
    transport,
    relayProtocol,
    counters,
  };
}

/** Loss between two cumulative samples, in percent. Null until there is something to compare. */
export function lossBetween(previous: LossCounters | null, current: LossCounters | null): number | null {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  const lost = current.lost - previous.lost;
  if (total <= 0 || lost < 0) return null;
  return Math.min(100, (lost / total) * 100);
}

/**
 * The tooltip label. Bars follow LiveKit's own quality score; the extra "fair" step is shown when
 * LiveKit says "good" but the measured path is clearly degraded (RTT >= 150 ms or loss >= 2 %).
 */
export type QualityLabel = 'excellent' | 'good' | 'fair' | 'poor' | 'lost' | 'unknown';

export function describeQuality(level: ConnectionQualityLevel, stats: ConnectionStats | null): QualityLabel {
  if (level === 'good' && stats && ((stats.rttMs ?? 0) >= 150 || (stats.lossPercent ?? 0) >= 2)) return 'fair';
  return level;
}

const INTERVAL_MS = 1500;

/** One sampler per room. start() is idempotent; stop() clears the timer immediately. */
export class ConnectionStatsSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private previous: { key: string; counters: LossCounters } | null = null;
  private running = false;
  private readonly room: Room;
  private readonly onStats: (stats: ConnectionStats | null) => void;
  private readonly onDiagnostic?: (message: string) => void;
  private lastDiagnostic = '';

  constructor(room: Room, onStats: (stats: ConnectionStats | null) => void, onDiagnostic?: (message: string) => void) {
    this.room = room;
    this.onStats = onStats;
    this.onDiagnostic = onDiagnostic;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => {
      void this.sample();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.previous = null;
    this.lastDiagnostic = '';
  }

  private pickTrack(): { key: string; track: LocalAudioTrack | RemoteAudioTrack } | null {
    const mic = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (mic instanceof LocalAudioTrack && !mic.isMuted) return { key: `out:${mic.sid ?? ''}`, track: mic };
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track instanceof RemoteAudioTrack) return { key: `in:${pub.trackSid}`, track: pub.track };
      }
    }
    if (mic instanceof LocalAudioTrack) return { key: `out:${mic.sid ?? ''}`, track: mic };
    return null;
  }

  private async sample(): Promise<void> {
    if (this.running) return; // never overlap two getStats() calls
    this.running = true;
    try {
      const picked = this.pickTrack();
      if (!picked) {
        this.onStats(null);
        return;
      }
      const report = await picked.track.getRTCStatsReport();
      if (!this.timer) return; // stopped while waiting
      if (!report) {
        this.onStats(null);
        return;
      }
      const parsed = parseStatsReport(report);
      const diag = `${picked.key.startsWith('out') ? 'outgoing' : 'incoming'} audio: candidate pair ${parsed.pairFound ? 'found' : 'missing'}, RTT from ${parsed.rttSource ?? 'nothing yet'}, transport ${parsed.transport ?? 'unknown'}`;
      if (diag !== this.lastDiagnostic) {
        // Logged when it changes, not every tick.
        this.lastDiagnostic = diag;
        this.onDiagnostic?.(diag);
      }
      const lossPercent =
        this.previous && this.previous.key === picked.key ? lossBetween(this.previous.counters, parsed.counters) : null;
      this.previous = parsed.counters ? { key: picked.key, counters: parsed.counters } : null;
      this.onStats({ rttMs: parsed.rttMs, lossPercent, transport: parsed.transport, relayProtocol: parsed.relayProtocol });
    } catch {
      // Stats can be briefly unavailable (track restarting, ICE restart): keep quiet, retry next tick.
    } finally {
      this.running = false;
    }
  }
}
