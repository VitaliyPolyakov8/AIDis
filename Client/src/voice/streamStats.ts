import { useEffect, useState } from 'react';
import type { VideoTrack } from 'livekit-client';
import { statsValues, type StatsLike } from './rtcStats';

/**
 * Live statistics of a screen-share video track, read from WebRTC getStats() of the track's
 * RTCRtpSender (our own stream) or RTCRtpReceiver (someone else's). Nothing is estimated:
 * a value the browser does not report is shown as unknown.
 */
export interface StreamStats {
  direction: 'outbound' | 'inbound';
  width: number | null;
  height: number | null;
  /** Frames per second actually sent (outbound) or received and decoded (inbound). */
  fps: number | null;
  /**
   * Our own stream only: frames per second the screen capturer really delivers to the encoder
   * (WebRTC "media-source" stats). Lower than the setting = capture-limited, not encoder-limited.
   */
  captureFps: number | null;
  /** Bits per second over the last sample interval (all simulcast layers for our own stream). */
  bitrateBps: number | null;
  lossPercent: number | null;
  rttMs: number | null;
  /** e.g. "VP8", "H264". */
  codec: string | null;
  /** 0.4.7: sdpFmtpLine of the codec (H.264 profile-level-id), null when not reported. */
  fmtp?: string | null;
  /** Encoder/decoder as reported by Chromium (e.g. "libvpx", "MediaFoundationVideoEncodeAccelerator"). */
  implementation: string | null;
  /** Why the encoder is reducing quality: "cpu", "bandwidth", "none". */
  limitation: string | null;
  /** 0.4.2: how often the encoder changed the resolution because of `limitation` (outbound). */
  resolutionChanges?: number | null;
  /** 0.4.6: frames the encoder produced per second (outbound; differs from send FPS when packets wait). */
  encodeFps?: number | null;
  /** 0.4.6: frames decoded per second (inbound). */
  decodeFps?: number | null;
  /** 0.4.6: Chromium's own "power efficient" flag = hardware encoder / decoder. Null = not reported. */
  hardware?: boolean | null;
  /** 0.4.6: frames the receiver dropped (inbound, total). */
  framesDropped?: number | null;
}

export interface StreamCounters {
  timestamp: number;
  bytes: number;
  packets: number;
  lost: number;
  /** 0.4.6: framesEncoded (outbound) or framesDecoded (inbound). */
  frames?: number;
}


function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const isVideo = (s: StatsLike) => s.kind === 'video' || s.mediaType === 'video';

/** Pure parser (unit-tested). Returns the stats plus counters to diff against on the next sample. */
export function parseStreamStats(
  report: unknown,
  previous: StreamCounters | null,
): { stats: StreamStats | null; counters: StreamCounters | null } {
  const entries = statsValues(report);
  const byId = new Map<string, StatsLike>(entries.map((s) => [s.id, s]));

  const outbound = entries.filter((s) => s.type === 'outbound-rtp' && isVideo(s));
  const inbound = entries.filter((s) => s.type === 'inbound-rtp' && isVideo(s));
  const direction = outbound.length > 0 ? 'outbound' : inbound.length > 0 ? 'inbound' : null;
  if (!direction) return { stats: null, counters: null };

  const rtps = direction === 'outbound' ? outbound : inbound;
  // The largest active layer is what the best-connected viewer receives.
  const main = rtps.reduce((best, s) => ((num(s.frameWidth) ?? 0) > (num(best.frameWidth) ?? 0) ? s : best), rtps[0] as StatsLike);

  let bytes = 0;
  let packets = 0;
  let lost = 0;
  let timestamp = 0;
  for (const s of rtps) {
    bytes += num(direction === 'outbound' ? s.bytesSent : s.bytesReceived) ?? 0;
    packets += num(direction === 'outbound' ? s.packetsSent : s.packetsReceived) ?? 0;
    if (direction === 'inbound') lost += Math.max(0, num(s.packetsLost) ?? 0);
    timestamp = Math.max(timestamp, num(s.timestamp) ?? 0);
  }

  let rtt: number | null = null;
  if (direction === 'outbound') {
    for (const s of entries) {
      if (s.type !== 'remote-inbound-rtp' || !isVideo(s)) continue;
      lost += Math.max(0, num(s.packetsLost) ?? 0);
      rtt ??= num(s.roundTripTime);
    }
  }
  if (rtt === null) {
    const transport = entries.find((s) => s.type === 'transport' && str(s.selectedCandidatePairId));
    const pair =
      (transport ? byId.get(str(transport.selectedCandidatePairId) ?? '') : undefined) ??
      entries.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded');
    rtt = num(pair?.currentRoundTripTime);
  }

  const frames = num(direction === 'outbound' ? main.framesEncoded : main.framesDecoded);
  const counters: StreamCounters = { timestamp, bytes, packets: direction === 'inbound' ? packets + lost : packets, lost, ...(frames === null ? {} : { frames }) };
  let frameRate: number | null = null;
  let bitrateBps: number | null = null;
  let lossPercent: number | null = null;
  if (previous && timestamp > previous.timestamp) {
    const seconds = (timestamp - previous.timestamp) / 1000;
    const deltaBytes = bytes - previous.bytes;
    if (deltaBytes >= 0) bitrateBps = Math.round((deltaBytes * 8) / seconds);
    const deltaPackets = counters.packets - previous.packets;
    const deltaLost = lost - previous.lost;
    if (deltaPackets > 0 && deltaLost >= 0) lossPercent = Math.min(100, (deltaLost / deltaPackets) * 100);
    if (counters.frames !== undefined && previous.frames !== undefined && counters.frames >= previous.frames) frameRate = Math.round((counters.frames - previous.frames) / seconds);
  }

  const codecStat = byId.get(str(main.codecId) ?? '');
  const mime = str(codecStat?.mimeType);
  return {
    stats: {
      direction,
      width: num(main.frameWidth),
      height: num(main.frameHeight),
      fps: num(main.framesPerSecond),
      captureFps:
        direction === 'outbound'
          ? num(entries.find((s) => s.type === 'media-source' && isVideo(s) && num(s.framesPerSecond) !== null)?.framesPerSecond)
          : null,
      bitrateBps,
      lossPercent,
      rttMs: rtt === null ? null : Math.round(rtt * 1000),
      codec: mime ? (mime.split('/')[1] ?? mime).toUpperCase() : null,
      fmtp: str(codecStat?.sdpFmtpLine),
      implementation: str(direction === 'outbound' ? main.encoderImplementation : main.decoderImplementation),
      limitation: direction === 'outbound' ? str(main.qualityLimitationReason) : null,
      resolutionChanges: direction === 'outbound' ? num(main.qualityLimitationResolutionChanges) : null,
      encodeFps: direction === 'outbound' ? frameRate : null,
      decodeFps: direction === 'inbound' ? frameRate : null,
      hardware: typeof (direction === 'outbound' ? main.powerEfficientEncoder : main.powerEfficientDecoder) === 'boolean' ? Boolean(direction === 'outbound' ? main.powerEfficientEncoder : main.powerEfficientDecoder) : null,
      framesDropped: direction === 'inbound' ? num(main.framesDropped) : null,
    },
    counters,
  };
}

/**
 * Our own stream: the capturer delivers clearly fewer frames than configured while the encoder
 * reports no limit, i.e. screen capture (not CPU/bandwidth for encoding) is the bottleneck.
 */
export function isCaptureLimited(stats: Pick<StreamStats, 'captureFps' | 'limitation'>, targetFps: number | null): boolean {
  if (stats.captureFps === null || !targetFps) return false;
  return stats.captureFps < targetFps * 0.85 && (stats.limitation === null || stats.limitation === 'none');
}

const INTERVAL_MS = 1000;

/** Samples the track once a second while `enabled` (the stats panel is open); stops otherwise. */
export function useStreamStats(track: VideoTrack | null, enabled: boolean): StreamStats | null {
  const [stats, setStats] = useState<StreamStats | null>(null);

  useEffect(() => {
    if (!enabled || !track) return;
    let previous: StreamCounters | null = null;
    let cancelled = false;
    let running = false;
    const sample = async () => {
      if (running) return;
      running = true;
      try {
        const report = await track.getRTCStatsReport();
        if (cancelled || !report) return;
        const parsed = parseStreamStats(report, previous);
        previous = parsed.counters;
        setStats(parsed.stats);
      } catch {
        /* stats briefly unavailable (renegotiation): try again next tick */
      } finally {
        running = false;
      }
    };
    void sample();
    const timer = setInterval(() => void sample(), INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [track, enabled]);

  return enabled && track ? stats : null;
}
