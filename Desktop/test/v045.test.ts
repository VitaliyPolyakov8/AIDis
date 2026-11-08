import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.4.5', getPath: () => 'C:/tmp' },
  BrowserWindow: vi.fn(),
  MessageChannelMain: vi.fn(),
  screen: { getAllDisplays: () => [], on: vi.fn(), off: vi.fn() },
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { hwndFromSourceId } = await import('../src/main/appAudio');
const { isPopoutRequest, sanitizePopoutBounds } = await import('../src/main/streamPopouts');

describe('0.4.5 application audio', () => {
  it('only window sources can get application audio (the helper targets that window)', () => {
    expect(hwndFromSourceId('window:2884:0')).toBe('2884');
    expect(hwndFromSourceId('screen:0:0')).toBeNull();
    expect(hwndFromSourceId('window:1;calc:0')).toBeNull();
    expect(hwndFromSourceId(42)).toBeNull();
  });

  it('the native helper is built and packaged with the app', () => {
    expect(existsSync('assets/native/aidis-app-audio.exe')).toBe(true);
  });
});

describe('0.4.5 stream pop-out windows', () => {
  it('only blank windows with the pop-out name are allowed', () => {
    expect(isPopoutRequest('about:blank', 'aidis-popout-11111111-2222-4333-8444-555555555555')).toBe(true);
    expect(isPopoutRequest('https://evil.example', 'aidis-popout-x')).toBe(false);
    expect(isPopoutRequest('about:blank', 'other')).toBe(false);
    expect(isPopoutRequest('about:blank', 'aidis-popout-../../x')).toBe(false);
  });

  it('restores size and position only onto a connected monitor', () => {
    const areas = [{ x: 0, y: 0, width: 2560, height: 1392 }];
    expect(sanitizePopoutBounds({ x: 100, y: 100, width: 960, height: 540 }, areas)).toEqual({ x: 100, y: 100, width: 960, height: 540 });
    // Saved on a second monitor that is no longer connected.
    expect(sanitizePopoutBounds({ x: 3000, y: 100, width: 960, height: 540 }, areas)).toBeNull();
    expect(sanitizePopoutBounds({ x: 0, y: 0, width: 50, height: 50 }, areas)).toBeNull();
    expect(sanitizePopoutBounds('nope', areas)).toBeNull();
  });
});
