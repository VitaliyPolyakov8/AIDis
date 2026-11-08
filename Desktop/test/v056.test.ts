import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.5.6' },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn(), off: vi.fn(), getSystemIdleTime: () => 0 },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { sanitizeOverlayState, sanitizeOverlayMessage } = await import('../src/main/overlay');

describe('0.5.6 overlay name styles', () => {
  it('passes the name color, gradient, glow and font of participants (they were dropped before)', () => {
    const state = sanitizeOverlayState({
      inCall: true,
      participants: [
        { id: 'u1', name: 'Anna', color: '#123456', initials: 'A', nameColor: '#ff5577', nameColor2: '#55aaff', nameGlow: true, nameFont: 'press-start', cosmeticFrame: 'neon_pulse' },
        { id: 'u2', name: 'Bob', color: '#123456', initials: 'B', nameColor: 'red; background:url(x)', nameColor2: 'expression()', nameGlow: 'yes', nameFont: '../evil' },
      ],
    });
    expect(state?.participants[0]).toMatchObject({ nameColor: '#ff5577', nameColor2: '#55aaff', nameGlow: true, nameFont: 'press-start', cosmeticFrame: 'neon_pulse' });
    expect(state?.participants[1]).toMatchObject({ nameColor: null, nameColor2: null, nameGlow: false, nameFont: null });
  });

  it('passes the author name style of chat messages', () => {
    expect(sanitizeOverlayMessage({ id: 'm1', text: 'hi', authorName: 'A', nameColor: '#abcdef', nameGlow: true, nameFont: 'lobster' })).toMatchObject({
      nameColor: '#abcdef',
      nameColor2: null,
      nameGlow: true,
      nameFont: 'lobster',
    });
  });
});
