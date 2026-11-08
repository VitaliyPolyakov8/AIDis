import { describe, expect, it, vi } from 'vitest';
import {
  applySettingsPatch,
  blocksTyping,
  DEFAULT_DESKTOP_SETTINGS,
  DEFAULT_KEYBINDS,
  estimatedUploadMbps,
  findConflict,
  keyFromCode,
  keyFromMouseButton,
  parseBinding,
  sanitizeDesktopSettings,
  sanitizeKeybinds,
  streamBitrateMbps,
  validateBinding,
} from './contract';
import { DesktopTokenStore } from './desktopTokenStore';
import { captureConstraints } from './screenCapture';
import { parseStreamStats, isCaptureLimited } from '../voice/streamStats';

describe('keybinds', () => {
  it('parses only canonical bindings', () => {
    expect(parseBinding('Ctrl+Shift+M')).toEqual({ ctrl: true, alt: false, shift: true, key: 'M' });
    expect(parseBinding('Shift+Ctrl+M')).toBeNull();
    expect(parseBinding('Ctrl+Ctrl+M')).toBeNull();
    expect(parseBinding('Ctrl+Shift')).toBeNull();
    expect(parseBinding('Win+M')).toBeNull();
    expect(parseBinding(42)).toBeNull();
  });

  it('applies the toggle rules', () => {
    expect(validateBinding('toggleMute', 'Ctrl+Shift+M')).toBeNull();
    // Single keys are valid since 0.2.3 (F8, Insert, even M); modifiers are optional.
    expect(validateBinding('toggleMute', 'M')).toBeNull();
    expect(validateBinding('toggleMute', 'F8')).toBeNull();
    expect(validateBinding('toggleMute', 'Insert')).toBeNull();
    expect(validateBinding('toggleMute', 'Shift+M')).toBeNull();
    expect(validateBinding('toggleMute', 'Space')).toBe('reserved');
    expect(validateBinding('toggleMute', 'Enter')).toBe('reserved');
    expect(blocksTyping('toggleMute', 'M')).toBe(true);
    expect(blocksTyping('toggleMute', 'F8')).toBe(false);
    expect(blocksTyping('pushToTalk', 'V')).toBe(false);
    expect(findConflict({ ...DEFAULT_KEYBINDS, toggleMute: 'F8' }, 'pushToTalk', 'F8')).toBe('toggleMute');
    expect(validateBinding('toggleMute', 'F13')).toBeNull();
    expect(validateBinding('toggleMute', 'Alt+F4')).toBe('reserved');
    expect(validateBinding('toggleMute', 'Ctrl+C')).toBe('reserved');
    expect(validateBinding('toggleMute', 'Mouse4')).toBe('mouseNotAllowed');
  });

  it('allows single keys and side buttons for push-to-talk', () => {
    expect(validateBinding('pushToTalk', 'V')).toBeNull();
    expect(validateBinding('pushToTalk', 'CapsLock')).toBeNull();
    expect(validateBinding('pushToTalk', 'Mouse5')).toBeNull();
    expect(validateBinding('pushToTalk', 'Ctrl+Mouse5')).toBe('invalid');
  });

  it('finds conflicts and repairs stored duplicates', () => {
    expect(findConflict(DEFAULT_KEYBINDS, 'toggleDeafen', 'Ctrl+Shift+M')).toBe('toggleMute');
    expect(findConflict(DEFAULT_KEYBINDS, 'toggleMute', 'Ctrl+Shift+M')).toBeNull();
    const repaired = sanitizeKeybinds({ toggleMute: 'Ctrl+Shift+X', toggleDeafen: 'Ctrl+Shift+X', pushToTalk: 'garbage' });
    expect(repaired.toggleMute).toBe('Ctrl+Shift+X');
    expect(repaired.toggleDeafen).toBeNull();
    expect(repaired.pushToTalk).toBeNull();
  });

  it('maps physical keys independent of the keyboard layout', () => {
    expect(keyFromCode('KeyM')).toBe('M');
    expect(keyFromCode('Digit7')).toBe('7');
    expect(keyFromCode('Numpad4')).toBe('Num4');
    expect(keyFromCode('ArrowUp')).toBe('Up');
    expect(keyFromCode('F24')).toBe('F24');
    expect(keyFromCode('Backquote')).toBe('Backquote');
    expect(keyFromCode('ControlLeft')).toBeNull();
    expect(keyFromCode('Mouse4')).toBeNull();
    expect(keyFromMouseButton(3)).toBe('Mouse4');
    expect(keyFromMouseButton(0)).toBeNull();
  });
});

describe('settings patches', () => {
  it('rejects a conflicting keybind without saving anything', () => {
    const result = applySettingsPatch(DEFAULT_DESKTOP_SETTINGS, { keybinds: { toggleDeafen: 'Ctrl+Shift+M' }, language: 'ru' });
    expect(result).toEqual({ ok: false, error: 'conflict', action: 'toggleMute', conflictWith: 'toggleDeafen' });
  });

  it('merges sections and clamps numbers', () => {
    const result = applySettingsPatch(DEFAULT_DESKTOP_SETTINGS, {
      streaming: { resolution: '1440p', customBitrateMbps: 0.2, bitrateMode: 'custom' },
      voiceInput: { mode: 'pushToTalk', pttReleaseDelayMs: 9000 },
      preferences: { closeToTray: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.streaming).toMatchObject({ resolution: '1440p', frameRate: 60, bitrateMode: 'custom', customBitrateMbps: 1 });
    expect(result.settings.voiceInput).toEqual({ mode: 'pushToTalk', pttReleaseDelayMs: 500 });
    expect(result.settings.preferences).toMatchObject({ closeToTray: false, startWithWindows: false });
  });

  it('sanitizes corrupted files to defaults', () => {
    expect(sanitizeDesktopSettings('nope')).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(sanitizeDesktopSettings({ streaming: { frameRate: 144, resolution: '4k' } }).streaming).toMatchObject({ frameRate: 60, resolution: '1080p' });
  });
});

describe('streaming', () => {
  it('picks the bitrate ceiling and estimates upload', () => {
    const base = DEFAULT_DESKTOP_SETTINGS.streaming;
    expect(streamBitrateMbps(base)).toBe(12); // game, 1080p60
    expect(streamBitrateMbps({ ...base, contentMode: 'text' })).toBe(8);
    expect(streamBitrateMbps({ ...base, resolution: '1440p' })).toBe(18);
    expect(streamBitrateMbps({ ...base, bitrateMode: '12' })).toBe(12);
    expect(streamBitrateMbps({ ...base, bitrateMode: 'custom', customBitrateMbps: 99 })).toBe(30);
    expect(estimatedUploadMbps({ ...base, bitrateMode: '8', systemAudio: true })).toBe(10);
  });

  it('builds capture constraints that never upscale and exclude our own audio', () => {
    const c = captureConstraints({ ...DEFAULT_DESKTOP_SETTINGS.streaming, resolution: '1440p', frameRate: 30 }, true);
    // The capturer polls at twice the stream rate so frames of a 30/60 FPS source are not missed.
    expect(c.video).toEqual({ width: { max: 2560 }, height: { max: 1440 }, frameRate: { ideal: 60, max: 60 } });
    expect((captureConstraints(DEFAULT_DESKTOP_SETTINGS.streaming, false).video as MediaTrackConstraints).frameRate).toEqual({ ideal: 120, max: 120 });
    expect(c.audio).toMatchObject({ restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false });
    expect(captureConstraints(DEFAULT_DESKTOP_SETTINGS.streaming, false).audio).toBe(false);
  });
});

describe('stream statistics', () => {
  const outbound = (bytes: number, timestamp: number) =>
    new Map<string, Record<string, unknown> & { type: string; id: string }>([
      ['o1', { id: 'o1', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, bytesSent: bytes, packetsSent: 1000 + bytes / 1000, codecId: 'c1', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', qualityLimitationReason: 'none', timestamp }],
      ['o2', { id: 'o2', type: 'outbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 360, bytesSent: 0, packetsSent: 0, timestamp }],
      ['r1', { id: 'r1', type: 'remote-inbound-rtp', kind: 'video', packetsLost: bytes / 100_000, roundTripTime: 0.032 }],
      ['c1', { id: 'c1', type: 'codec', mimeType: 'video/H264' }],
    ]);

  it('reports real outbound values and bitrate between samples', () => {
    const first = parseStreamStats(outbound(1_000_000, 1000), null);
    expect(first.stats).toMatchObject({ direction: 'outbound', width: 1920, height: 1080, fps: 60, bitrateBps: null, rttMs: 32, codec: 'H264' });
    const second = parseStreamStats(outbound(2_250_000, 2000), first.counters);
    expect(second.stats?.bitrateBps).toBe(10_000_000);
    expect(second.stats?.implementation).toBe('MediaFoundationVideoEncodeAccelerator');
    expect(second.stats?.lossPercent).toBeCloseTo((12.5 / 1250) * 100, 5);
  });

  it('reports the real capture FPS separately and spots a capture-limited stream', () => {
    const report = new Map([
      ['o1', { id: 'o1', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 41, bytesSent: 1, packetsSent: 1, timestamp: 1, qualityLimitationReason: 'none' }],
      ['m1', { id: 'm1', type: 'media-source', kind: 'video', framesPerSecond: 41, frames: 900 }],
    ]);
    const stats = parseStreamStats(report, null).stats!;
    expect(stats).toMatchObject({ captureFps: 41, fps: 41, limitation: 'none' });
    expect(isCaptureLimited(stats, 60)).toBe(true); // 60 configured, 41 captured, encoder not limited
    expect(isCaptureLimited({ ...stats, captureFps: 59 }, 60)).toBe(false);
    expect(isCaptureLimited({ ...stats, limitation: 'cpu' }, 60)).toBe(false); // encoder-limited instead
    expect(isCaptureLimited(stats, null)).toBe(false);
  });

  it('handles inbound streams and empty reports', () => {
    const inbound = new Map([
      ['i1', { id: 'i1', type: 'inbound-rtp', kind: 'video', frameWidth: 2560, frameHeight: 1440, framesPerSecond: 59, bytesReceived: 500, packetsReceived: 90, packetsLost: 10, timestamp: 1 }],
    ]);
    expect(parseStreamStats(inbound, null).stats).toMatchObject({ direction: 'inbound', width: 2560, fps: 59, limitation: null });
    expect(parseStreamStats(new Map(), null).stats).toBeNull();
    // A real RTCStatsReport is not a Map: iterating it yields [id, stat] pairs.
    const reportLike = { values: () => inbound.values(), [Symbol.iterator]: () => inbound.entries() };
    expect(parseStreamStats(reportLike, null).stats).toMatchObject({ direction: 'inbound', width: 2560 });
  });
});

describe('desktop token store', () => {
  function fakeAuth() {
    return { load: vi.fn(() => Promise.resolve(null)), save: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) };
  }

  it('hands remembered sessions to the main process and keeps others in memory', async () => {
    const api = fakeAuth();
    const store = new DesktopTokenStore(api, { refreshToken: 'r0', sessionId: 's' });
    expect(store.loadSession()).toEqual({ refreshToken: 'r0', sessionId: 's', remember: true });
    store.saveSession({ refreshToken: 'r1', sessionId: 's', remember: true });
    store.saveSession({ refreshToken: 'r2', sessionId: 's', remember: false });
    store.clear();
    await store.flush();
    expect(api.save).toHaveBeenCalledWith({ refreshToken: 'r1', sessionId: 's' });
    expect(api.clear).toHaveBeenCalledTimes(2);
    expect(store.loadSession()).toBeNull();
    expect(store.getAccessToken()).toBeNull();
  });

  it('serializes refreshes', async () => {
    const store = new DesktopTokenStore(fakeAuth(), null);
    const order: number[] = [];
    await Promise.all([
      store.withRefreshLock(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      store.withRefreshLock(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
