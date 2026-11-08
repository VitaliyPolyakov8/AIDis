/**
 * 0.4.7: H.264 profile handling for hardware-encoded screen sharing.
 *
 * Chromium's hardware H.264 encoder (Media Foundation: NVENC / Quick Sync / AMF) is used for the
 * profiles Baseline (42001f), Main (4d001f) and High (64001f), but NOT for Constrained Baseline
 * (42e01f): that one always runs in software (OpenH264). LiveKit 1.13 with its default codec list
 * only accepts 42e01f and High from a publisher, and it answers with 42e01f first, so a plain
 * `videoCodec: 'h264'` publish ends up in OpenH264 (seen in the real 0.4.6 install). The screen
 * share therefore offers only the hardware-capable profiles; with the default LiveKit config that
 * is High (64001f), encoded by NVENC / Quick Sync / AMF and decoded in hardware by viewers.
 */

export interface H264Profile {
  /** profile_idc, e.g. 0x42 Baseline, 0x4d Main, 0x64 High. */
  profileIdc: number;
  /** profile_iop (constraint flags). */
  profileIop: number;
  levelIdc: number;
}

/** profile-level-id of an fmtp line ("level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"). */
export function parseProfileLevelId(fmtp: string | null | undefined): H264Profile | null {
  const match = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})\s*(?:;|$)/i.exec(fmtp ?? '');
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 16);
  return { profileIdc: (value >> 16) & 0xff, profileIop: (value >> 8) & 0xff, levelIdc: value & 0xff };
}

/** Constrained Baseline: profile_idc 0x42 with constraint_set1 (0x40), e.g. 42e01f. Software-only in Chromium. */
export function isConstrainedBaseline(profile: H264Profile | null): boolean {
  return profile !== null && profile.profileIdc === 0x42 && (profile.profileIop & 0x40) !== 0;
}

/** Profiles Chromium's Media Foundation encoder accepts: Baseline, Main, High (not constrained baseline, not 4:4:4). */
export function isHardwareCapableProfile(profile: H264Profile | null): boolean {
  if (!profile || isConstrainedBaseline(profile)) return false;
  return profile.profileIdc === 0x42 || profile.profileIdc === 0x4d || profile.profileIdc === 0x64;
}

export function packetizationMode(fmtp: string | null | undefined): number {
  const match = /(?:^|;)\s*packetization-mode=(\d)/i.exec(fmtp ?? '');
  return match?.[1] ? Number(match[1]) : 0;
}

/** "42001f Baseline", "64001f High"... for diagnostics. */
export function describeH264(fmtp: string | null | undefined): string | null {
  const match = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp ?? '');
  const profile = parseProfileLevelId(fmtp);
  if (!match?.[1] || !profile) return null;
  const name = isConstrainedBaseline(profile)
    ? 'Constrained Baseline'
    : profile.profileIdc === 0x42
      ? 'Baseline'
      : profile.profileIdc === 0x4d
        ? 'Main'
        : profile.profileIdc === 0x64
          ? 'High'
          : 'other';
  return `${match[1].toLowerCase()} ${name}`;
}

type Codec = { mimeType: string; sdpFmtpLine?: string };

/**
 * Codec preference list for the screen-share transceiver: hardware-capable H.264 profiles first
 * (packetization-mode 1; High, then Main, then Baseline), then every non-H.264 codec unchanged
 * (VP8 stays as the SFU's fallback; RTX / RED / FEC stay for repair). Constrained Baseline and
 * the other H.264 variants are left out so the SFU cannot pick a software profile.
 *
 * Order matters twice: LiveKit 1.13 with its default codec list accepts High (640032) and answers
 * with it (verified on a real SFU), and livekit-client adds its x-google-start-bitrate hint only to
 * the FIRST H.264 payload of the offer, so High goes first to get the fast bandwidth ramp-up too.
 * Returns null when this engine offers no hardware-capable H.264 profile at all.
 */
export function hardwareH264Preferences<T extends Codec>(codecs: readonly T[]): T[] | null {
  const isH264 = (c: Codec) => c.mimeType.toLowerCase() === 'video/h264';
  const rank = (c: Codec) => ({ 0x64: 0, 0x4d: 1, 0x42: 2 })[parseProfileLevelId(c.sdpFmtpLine)?.profileIdc ?? 0] ?? 3;
  const preferred = codecs
    .filter((c) => isH264(c) && isHardwareCapableProfile(parseProfileLevelId(c.sdpFmtpLine)) && packetizationMode(c.sdpFmtpLine) === 1)
    .sort((a, b) => rank(a) - rank(b));
  if (preferred.length === 0) return null;
  return [...preferred, ...codecs.filter((c) => !isH264(c))];
}

/** Why a desktop stream is not on hardware H.264 (null = it is). Shown in the stream statistics. */
export type HardwareFallbackReason =
  | 'gpuDisabled' // hardware acceleration is off (setting) or Chromium has no GPU video encoding
  | 'noHardwareProfile' // this engine offers no hardware-capable H.264 profile
  | 'alignUnsupported' // the frame alignment step (MediaStreamTrackProcessor) is missing
  | 'serverRejected' // the SFU answered with another codec (no accepted H.264 profile)
  | 'softwareProfile' // the SFU accepted only Constrained Baseline (software OpenH264)
  | 'encoderUnavailable' // H.264 negotiated with a hardware profile but Chromium encoded in software (after one retry)
  | 'timeout'; // no encoder report after the start window (and one retry)

export interface StreamEncoderDiagnostics {
  requestedCodec: 'H264' | 'VP8';
  /** Codec of the running stream, from WebRTC stats ("H264", "VP8"), null until known. */
  negotiatedCodec: string | null;
  /** e.g. "42001f Baseline", only for H.264. */
  negotiatedProfile: string | null;
  /** encoderImplementation from WebRTC stats. */
  encoder: string | null;
  /** true/false once known from stats, null while unknown. */
  hardware: boolean | null;
  fallbackReason: HardwareFallbackReason | null;
  /** H.264 start attempts used (1 or 2). */
  attempts: number;
  /** "checking" while the start window runs. */
  state: 'checking' | 'done';
}

/** Encoder names Chromium reports for real hardware encoders (Media Foundation, NVENC, QSV, AMF...). */
export function isHardwareEncoder(implementation: string | null | undefined, powerEfficient?: boolean | null): boolean {
  if (powerEfficient === true) return true;
  if (!implementation) return false;
  return /MediaFoundation|Hardware|NVIDIA|Intel|AMD|Qualcomm|VideoToolbox|VaapiVideoEncodeAccelerator|D3D12/i.test(implementation) && !/OpenH264|libvpx|libaom|SimulcastEncoderAdapter \(libvpx/i.test(implementation);
}
