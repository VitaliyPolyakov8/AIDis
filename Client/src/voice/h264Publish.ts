/**
 * 0.4.7: WebRTC glue for hardware H.264 screen sharing (the pure profile rules are in h264.ts).
 */
import { hardwareH264Preferences, isHardwareEncoder } from './h264';

/**
 * livekit-client creates the screen-share transceiver inside publishTrack() and never sets codec
 * preferences itself, so the offer would list every H.264 profile and LiveKit answers with
 * Constrained Baseline (software). For the duration of one publishTrack() call this wraps
 * RTCPeerConnection.addTransceiver: the transceiver created for `track` (and only that one) gets
 * the hardware-capable H.264 profiles first and no Constrained Baseline. The negotiation that
 * follows (and every renegotiation) uses them. Returns the function that removes the wrapper.
 */
export function preferHardwareH264For(track: MediaStreamTrack, warn: (message: string) => void): () => void {
  if (typeof RTCPeerConnection === 'undefined') return () => undefined;
  const proto = RTCPeerConnection.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'addTransceiver');
  const original = descriptor?.value as ((this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) => RTCRtpTransceiver) | undefined;
  if (!descriptor || !original) return () => undefined;
  const wrapped = function (this: RTCPeerConnection, trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const transceiver = original.call(this, trackOrKind, init);
    if (trackOrKind === track) applyHardwareH264Preferences(transceiver, warn);
    return transceiver;
  };
  Object.defineProperty(proto, 'addTransceiver', { ...descriptor, value: wrapped });
  return () => {
    if (Object.getOwnPropertyDescriptor(proto, 'addTransceiver')?.value === wrapped) Object.defineProperty(proto, 'addTransceiver', descriptor);
  };
}

function applyHardwareH264Preferences(transceiver: RTCRtpTransceiver, warn: (message: string) => void): void {
  // Chromium validates preferences against the capabilities of the transceiver's direction;
  // try the sender's list first (sendonly), then the receiver's.
  for (const caps of [RTCRtpSender.getCapabilities('video'), RTCRtpReceiver.getCapabilities('video')]) {
    const preferences = caps ? hardwareH264Preferences(caps.codecs) : null;
    if (!preferences) continue;
    try {
      transceiver.setCodecPreferences(preferences);
      return;
    } catch (error) {
      warn(`H.264 codec preferences rejected: ${error instanceof Error ? error.message : 'error'}`);
    }
  }
}

export interface EncoderReport {
  /** "H264", "VP8"... from the codec stats (null until negotiated). */
  codec: string | null;
  /** sdpFmtpLine of the negotiated codec (H.264 profile-level-id). */
  fmtp: string | null;
  implementation: string | null;
  powerEfficient: boolean | null;
  hardware: boolean;
  framesEncoded: number;
}

/** Codec, H.264 profile and real encoder of our published screen video, from WebRTC stats. */
export async function readEncoderReport(track: { getRTCStatsReport: () => Promise<RTCStatsReport | undefined> }): Promise<EncoderReport | null> {
  const report = await track.getRTCStatsReport().catch(() => undefined);
  if (!report) return null;
  let result: EncoderReport | null = null;
  report.forEach((s: Record<string, unknown>) => {
    if (s.type !== 'outbound-rtp' || (s.kind !== 'video' && s.mediaType !== 'video')) return;
    const codecStats = typeof s.codecId === 'string' ? (report.get(s.codecId) as Record<string, unknown> | undefined) : undefined;
    const mime = typeof codecStats?.mimeType === 'string' ? codecStats.mimeType : null;
    const implementation = typeof s.encoderImplementation === 'string' && s.encoderImplementation !== 'unknown' ? s.encoderImplementation : null;
    const powerEfficient = typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null;
    result = {
      codec: mime ? mime.replace(/^video\//i, '').toUpperCase() : null,
      fmtp: typeof codecStats?.sdpFmtpLine === 'string' ? codecStats.sdpFmtpLine : null,
      implementation,
      powerEfficient,
      hardware: isHardwareEncoder(implementation, powerEfficient),
      framesEncoded: typeof s.framesEncoded === 'number' ? s.framesEncoded : 0,
    };
  });
  return result;
}
