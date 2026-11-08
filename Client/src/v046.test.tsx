import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./voice/voiceService', async (orig) => {
  const real = await orig<typeof import('./voice/voiceService')>();
  return { ...real, voice: { getScreenShareResolutions: () => ({ requested: { width: 1920, height: 1080 }, capture: { width: 1920, height: 1080 }, captureRate: 120 }), getScreenEncoderDiagnostics: () => null } };
});

const { isHardwareEncoder } = await import('./voice/voiceService');
const { parseStreamStats } = await import('./voice/streamStats');
const { StatsPanel } = await import('./components/voice/StreamView');
const { setLanguage } = await import('./i18n');

const outbound = (frames: number, ts: number, extra: Record<string, unknown> = {}) =>
  new Map<string, Record<string, unknown>>([
    ['o', { id: 'o', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 59, framesEncoded: frames, bytesSent: frames * 25_000, packetsSent: frames * 20, timestamp: ts, codecId: 'c', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', powerEfficientEncoder: true, qualityLimitationReason: 'none', ...extra }],
    ['c', { id: 'c', type: 'codec', mimeType: 'video/H264' }],
    ['m', { id: 'm', type: 'media-source', kind: 'video', framesPerSecond: 60 }],
  ]);

describe('0.4.6 hardware encoder detection', () => {
  it('recognises hardware encoders and never calls a software one hardware', () => {
    expect(isHardwareEncoder('MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)')).toBe(true);
    expect(isHardwareEncoder('MediaFoundationVideoEncodeAccelerator (Intel® Quick Sync Video H.264 Encoder MFT)')).toBe(true);
    expect(isHardwareEncoder('OpenH264')).toBe(false);
    expect(isHardwareEncoder('libvpx')).toBe(false);
    expect(isHardwareEncoder(null, true)).toBe(true);
    expect(isHardwareEncoder(null)).toBe(false);
  });
});

describe('0.4.6 stream stats: every stage separately', () => {
  it('reports encode FPS from framesEncoded and the hardware flag', () => {
    const first = parseStreamStats(outbound(0, 1000), null);
    const second = parseStreamStats(outbound(59, 2000), first.counters);
    expect(second.stats).toMatchObject({ encodeFps: 59, fps: 59, captureFps: 60, hardware: true, codec: 'H264' });
  });

  it('shows Requested / Capture / Encode / Send / Display, Hardware, and "Unavailable" for what is not reported', () => {
    setLanguage('en');
    const first = parseStreamStats(outbound(0, 1000), null);
    const { stats } = parseStreamStats(outbound(58, 2000), first.counters);
    render(<StatsPanel stats={stats} sender={{ contentHint: 'motion', degradationPreference: 'maintain-framerate-and-resolution', layers: [{ maxBitrate: 12e6, maxFramerate: 60, scaleResolutionDownBy: 1, active: true }] }} renderFps={null} />);
    expect(screen.getByText('Requested').nextSibling?.textContent).toBe('1920×1080 @ 60 FPS');
    expect(screen.getByText('Encode FPS').nextSibling?.textContent).toBe('58 FPS');
    expect(screen.getByText('Display FPS').nextSibling?.textContent).toBe('Unavailable (compositor, not stream FPS)');
    expect(screen.getByText('Hardware')).toBeTruthy();
    expect(screen.getByText('Limited by').nextSibling?.textContent).toBe('None');
  });
});
