import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StreamEncoderDiagnostics } from './voice/h264';

let diagnostics: StreamEncoderDiagnostics | null = null;
vi.mock('./voice/voiceService', async (orig) => {
  const real = await orig<typeof import('./voice/voiceService')>();
  return {
    ...real,
    voice: {
      getScreenShareResolutions: () => ({ requested: { width: 1920, height: 1080 }, capture: { width: 1920, height: 1080 }, captureRate: 120 }),
      getScreenEncoderDiagnostics: () => diagnostics,
    },
  };
});

const { describeH264, hardwareH264Preferences, isConstrainedBaseline, isHardwareCapableProfile, parseProfileLevelId } = await import('./voice/h264');
const { preferHardwareH264For, readEncoderReport } = await import('./voice/h264Publish');
const { parseStreamStats } = await import('./voice/streamStats');
const { StatsPanel } = await import('./components/voice/StreamView');
const { setLanguage } = await import('./i18n');

// Chromium 152's video sender capabilities (order as reported), trimmed to what matters here.
const CHROMIUM_CODECS = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=f4001f' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f' },
  { mimeType: 'video/AV1', clockRate: 90000 },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
];

describe('0.4.7 H.264 profiles', () => {
  it('tells Constrained Baseline (software in Chromium) from the hardware-capable profiles', () => {
    expect(isConstrainedBaseline(parseProfileLevelId('packetization-mode=1;profile-level-id=42e01f'))).toBe(true);
    expect(isConstrainedBaseline(parseProfileLevelId('profile-level-id=42001f'))).toBe(false);
    expect(isHardwareCapableProfile(parseProfileLevelId('profile-level-id=42001f'))).toBe(true);
    expect(isHardwareCapableProfile(parseProfileLevelId('profile-level-id=4d001f'))).toBe(true);
    expect(isHardwareCapableProfile(parseProfileLevelId('profile-level-id=640032'))).toBe(true);
    expect(isHardwareCapableProfile(parseProfileLevelId('profile-level-id=42e01f'))).toBe(false);
    expect(isHardwareCapableProfile(parseProfileLevelId('profile-level-id=f4001f'))).toBe(false);
    expect(parseProfileLevelId('packetization-mode=1')).toBeNull();
    expect(describeH264('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f')).toBe('42001f Baseline');
    expect(describeH264('profile-level-id=42e01f')).toBe('42e01f Constrained Baseline');
    expect(describeH264('profile-level-id=640032')).toBe('640032 High');
  });

  it('offers the hardware profiles first and never Constrained Baseline; other codecs stay as fallback', () => {
    const prefs = hardwareH264Preferences(CHROMIUM_CODECS);
    expect(prefs?.map((c) => c.sdpFmtpLine?.match(/profile-level-id=(\w+)/)?.[1] ?? c.mimeType)).toEqual([
      '64001f',
      '4d001f',
      '42001f',
      'video/VP8',
      'video/rtx',
      'video/AV1',
      'video/red',
      'video/ulpfec',
    ]);
    expect(prefs?.some((c) => /42e01f|packetization-mode=0|f4001f/.test(c.sdpFmtpLine ?? ''))).toBe(false);
  });

  it('returns null when the engine has no hardware-capable H.264 profile', () => {
    expect(hardwareH264Preferences(CHROMIUM_CODECS.filter((c) => !/42001f|4d001f|64001f/.test(c.sdpFmtpLine ?? '')))).toBeNull();
  });
});

describe('0.4.7 transceiver codec preferences', () => {
  const realPc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  const realSender = (globalThis as { RTCRtpSender?: unknown }).RTCRtpSender;
  const realReceiver = (globalThis as { RTCRtpReceiver?: unknown }).RTCRtpReceiver;
  afterEach(() => {
    Object.assign(globalThis, { RTCPeerConnection: realPc, RTCRtpSender: realSender, RTCRtpReceiver: realReceiver });
  });

  it('sets the preferences only on the screen track transceiver and only while publishing', () => {
    const calls: unknown[][] = [];
    class FakePc {
      addTransceiver(trackOrKind: unknown) {
        const transceiver = { trackOrKind, setCodecPreferences: (codecs: unknown[]) => calls.push(codecs) };
        return transceiver;
      }
    }
    Object.assign(globalThis, {
      RTCPeerConnection: FakePc,
      RTCRtpSender: { getCapabilities: () => ({ codecs: CHROMIUM_CODECS }) },
      RTCRtpReceiver: { getCapabilities: () => ({ codecs: CHROMIUM_CODECS }) },
    });
    const screen = { kind: 'video' } as MediaStreamTrack;
    const other = { kind: 'video' } as MediaStreamTrack;
    const pc = new FakePc() as unknown as RTCPeerConnection;
    const restore = preferHardwareH264For(screen, () => undefined);
    pc.addTransceiver(other);
    pc.addTransceiver(screen);
    restore();
    pc.addTransceiver(screen);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { sdpFmtpLine?: string }[])[0]?.sdpFmtpLine).toContain('64001f');
  });
});

describe('0.4.7 encoder report', () => {
  const statsOf = (codec: Record<string, unknown>, outbound: Record<string, unknown>) => ({
    getRTCStatsReport: () =>
      Promise.resolve(
        new Map<string, Record<string, unknown>>([
          ['o', { id: 'o', type: 'outbound-rtp', kind: 'video', codecId: 'c', ...outbound }],
          ['c', { id: 'c', type: 'codec', ...codec }],
        ]) as unknown as RTCStatsReport,
      ),
  });

  it('reads codec, profile and a real hardware encoder', async () => {
    const r = await readEncoderReport(
      statsOf(
        { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
        { encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', powerEfficientEncoder: true, framesEncoded: 120 },
      ),
    );
    expect(r).toMatchObject({ codec: 'H264', hardware: true, framesEncoded: 120 });
    expect(r?.fmtp).toContain('42001f');
  });

  it('reports OpenH264 as software, and VP8 as the codec the server chose', async () => {
    const soft = await readEncoderReport(statsOf({ mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' }, { encoderImplementation: 'OpenH264', powerEfficientEncoder: false, framesEncoded: 30 }));
    expect(soft).toMatchObject({ codec: 'H264', hardware: false });
    const vp8 = await readEncoderReport(statsOf({ mimeType: 'video/VP8' }, { encoderImplementation: 'libvpx', framesEncoded: 30 }));
    expect(vp8).toMatchObject({ codec: 'VP8', hardware: false });
  });
});

describe('0.4.7 stream statistics', () => {
  const outbound = (frames: number, ts: number, codec: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    new Map<string, Record<string, unknown>>([
      ['o', { id: 'o', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 59, framesEncoded: frames, bytesSent: frames * 25_000, packetsSent: frames * 20, timestamp: ts, codecId: 'c', qualityLimitationReason: 'none', ...extra }],
      ['c', { id: 'c', type: 'codec', ...codec }],
      ['m', { id: 'm', type: 'media-source', kind: 'video', framesPerSecond: 60 }],
    ]);
  const sender = { contentHint: 'motion', degradationPreference: 'maintain-framerate-and-resolution', layers: [{ maxBitrate: 12e6, maxFramerate: 60, scaleResolutionDownBy: 1, active: true }] };

  it('shows requested and negotiated codec, the H.264 profile and hardware H.264 in use', () => {
    setLanguage('en');
    diagnostics = { requestedCodec: 'H264', negotiatedCodec: 'H264', negotiatedProfile: '42001f Baseline', encoder: 'NVIDIA', hardware: true, fallbackReason: null, attempts: 1, state: 'done' };
    const codec = { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' };
    const hw = { encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', powerEfficientEncoder: true };
    const first = parseStreamStats(outbound(0, 1000, codec, hw), null);
    const { stats } = parseStreamStats(outbound(58, 2000, codec, hw), first.counters);
    render(<StatsPanel stats={stats} sender={sender} renderFps={144} />);
    expect(screen.getByText('Requested codec').nextSibling?.textContent).toBe('H264');
    expect(screen.getByText('Codec').nextSibling?.textContent).toBe('H264 · 42001f Baseline');
    expect(screen.getByText('Hardware H.264').nextSibling?.textContent).toBe('In use');
    expect(screen.getByText('Capture FPS').nextSibling?.textContent).toBe('60 FPS (1920×1080, track 120 Hz)');
    // The compositor rate is labelled as such, with the explanation as a tooltip.
    const display = screen.getByText('Display FPS');
    expect(display.nextSibling?.textContent).toBe('144 FPS (compositor, not stream FPS)');
    expect(display.getAttribute('title')).toMatch(/does not represent stream frames/);
  });

  it('names the reason when the stream fell back to VP8', () => {
    setLanguage('en');
    diagnostics = { requestedCodec: 'H264', negotiatedCodec: null, negotiatedProfile: null, encoder: null, hardware: null, fallbackReason: 'softwareProfile', attempts: 1, state: 'done' };
    const codec = { mimeType: 'video/VP8' };
    const first = parseStreamStats(outbound(0, 1000, codec, { encoderImplementation: 'libvpx' }), null);
    const { stats } = parseStreamStats(outbound(40, 2000, codec, { encoderImplementation: 'libvpx' }), first.counters);
    render(<StatsPanel stats={stats} sender={sender} renderFps={null} />);
    expect(screen.getByText('Codec').nextSibling?.textContent).toBe('VP8');
    expect(screen.getByText('Hardware H.264').nextSibling?.textContent).toMatch(/only H\.264 Constrained Baseline/);
  });
});
