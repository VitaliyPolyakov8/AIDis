import { describe, expect, it, vi } from 'vitest';

// Pure main-process modules import 'electron' only for types or not at all, except config.ts.
vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.1.0' },
  net: {},
  protocol: {},
  screen: {},
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { redact } = await import('../src/main/redact');
const { toAccelerator, toHookMatcher, modifiersSatisfied } = await import('../src/main/keymap');
const { resolveAppFile } = await import('../src/main/protocol');
const { rewriteRequestOrigin, rewriteResponseOrigin } = await import('../src/main/network');
const { sanitizeWindowState } = await import('../src/main/windowState');
const { sanitizeNotification } = await import('../src/main/notifications');
const { progressState, updateErrorMessage } = await import('../src/main/updater');
const { isSafeExternalUrl } = await import('../src/main/mainWindow');
const { originOf } = await import('../src/main/permissions');

describe('redact', () => {
  it('removes JWTs, bearer tokens, token fields and long opaque strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop';
    expect(redact(`token ${jwt}`)).not.toContain('eyJhbGci');
    expect(redact('Authorization: Bearer abc.def-ghi')).not.toContain('abc.def-ghi');
    expect(redact('{"refreshToken":"r3fr3sh-v4lue"}')).not.toContain('r3fr3sh-v4lue');
    expect(redact('password=hunter2')).not.toContain('hunter2');
    expect(redact('x'.repeat(10) + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0')).toContain('[redacted]');
  });

  it('keeps ordinary log text', () => {
    expect(redact('Capture started: screen + system audio')).toBe('Capture started: screen + system audio');
    expect(redact('Hotkey: toggleMute')).toBe('Hotkey: toggleMute');
  });
});

describe('keymap', () => {
  it('maps canonical bindings to Electron accelerators', () => {
    expect(toAccelerator('Ctrl+Shift+M')).toBe('Ctrl+Shift+M');
    expect(toAccelerator('Ctrl+Alt+Shift+A')).toBe('Ctrl+Alt+Shift+A');
    expect(toAccelerator('Ctrl+Num5')).toBe('Ctrl+num5');
    expect(toAccelerator('Alt+NumAdd')).toBe('Alt+numadd');
    expect(toAccelerator('Ctrl+Backquote')).toBe('Ctrl+`');
    expect(toAccelerator('F13')).toBe('F13');
    expect(toAccelerator('Mouse4')).toBeNull();
    expect(toAccelerator('Shift+Ctrl+M')).toBeNull();
  });

  it('maps push-to-talk bindings to hook key codes and mouse buttons', () => {
    const table = { V: 47, Enter: 28, NumpadEnter: 3612, ArrowUp: 57416, Numpad5: 76 };
    expect(toHookMatcher('V', table)?.keycodes).toEqual([47]);
    expect(toHookMatcher('Enter', table)?.keycodes).toEqual([28, 3612]);
    expect(toHookMatcher('Up', table)?.keycodes).toEqual([57416]);
    expect(toHookMatcher('Num5', table)?.keycodes).toEqual([76]);
    expect(toHookMatcher('Mouse4', table)).toMatchObject({ keycodes: [], mouseButton: 4 });
    expect(toHookMatcher('F13', table)).toBeNull();
  });

  it('treats required modifiers as a minimum', () => {
    const matcher = toHookMatcher('Ctrl+V', { V: 47 });
    expect(matcher).not.toBeNull();
    const binding = matcher!.binding;
    expect(modifiersSatisfied(binding, { ctrlKey: true, altKey: false, shiftKey: true })).toBe(true);
    expect(modifiersSatisfied(binding, { ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});

describe('app protocol', () => {
  const root = 'C:\\app\\build\\renderer';
  const files = new Set([`${root}\\index.html`, `${root}\\assets\\index.js`]);
  const exists = (f: string) => files.has(f);

  it('serves files and falls back to index.html for client routes', () => {
    expect(resolveAppFile(root, 'aidis://app/assets/index.js', exists)).toBe(`${root}\\assets\\index.js`);
    expect(resolveAppFile(root, 'aidis://app/channels/abc', exists)).toBe(`${root}\\index.html`);
    expect(resolveAppFile(root, 'aidis://app/', exists)).toBe(`${root}\\index.html`);
  });

  it('never escapes the renderer folder', () => {
    expect(resolveAppFile(root, 'aidis://app/..%2f..%2fmain%2fmain.cjs', exists)).toBeNull();
    expect(resolveAppFile(root, 'aidis://app/%2e%2e/%2e%2e/package.json', exists)).toBeNull();
    expect(resolveAppFile(root, 'aidis://evil/index.html', exists)).toBeNull();
    expect(resolveAppFile(root, 'aidis://app/missing.js', exists)).toBeNull();
  });
});

describe('CORS bridge', () => {
  it('rewrites only requests from the app origin', () => {
    expect(rewriteRequestOrigin({ Origin: 'aidis://app', Accept: '*/*' }, 'https://chat.example.com')).toEqual({ Origin: 'https://chat.example.com', Accept: '*/*' });
    expect(rewriteRequestOrigin({ origin: 'https://evil.example' }, 'https://chat.example.com')).toEqual({ origin: 'https://evil.example' });
    expect(rewriteRequestOrigin({ Accept: '*/*' }, 'https://chat.example.com')).toEqual({ Accept: '*/*' });
  });

  it('maps the allowed origin back to the app', () => {
    expect(rewriteResponseOrigin({ 'access-control-allow-origin': ['https://chat.example.com'] }, 'https://chat.example.com')).toEqual({
      'access-control-allow-origin': ['aidis://app'],
    });
    expect(rewriteResponseOrigin({ 'access-control-allow-origin': ['*'] }, 'https://chat.example.com')).toEqual({ 'access-control-allow-origin': ['*'] });
  });

  it('computes origins of custom schemes', () => {
    expect(originOf('aidis://app/channels/1')).toBe('aidis://app');
    expect(originOf('http://127.0.0.1:5173/x')).toBe('http://127.0.0.1:5173');
    expect(originOf('not a url')).toBeNull();
  });
});

describe('window state', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1040 };

  it('restores a visible saved state', () => {
    expect(sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 700, maximized: true }, [display])).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 700,
      maximized: true,
    });
  });

  it('drops positions on disconnected monitors and enforces the minimum size', () => {
    expect(sanitizeWindowState({ x: 4000, y: 80, width: 300, height: 200 }, [display])).toEqual({ width: 940, height: 600, maximized: false });
    expect(sanitizeWindowState('garbage', [display])).toEqual({ width: 1280, height: 800, maximized: false });
  });
});

describe('notifications, links, updates', () => {
  it('validates notification requests', () => {
    expect(sanitizeNotification({ title: ' Anna · #general ', body: 'hi', channelId: 'cm1abc' })).toEqual({
      title: 'Anna · #general',
      body: 'hi',
      channelId: 'cm1abc',
    });
    expect(sanitizeNotification({ title: 'x', body: 'y', channelId: '../../etc' })).toBeNull();
    expect(sanitizeNotification({ title: '', body: 'y', channelId: 'a' })).toBeNull();
    expect(sanitizeNotification(null)).toBeNull();
  });

  it('opens only web and mail links externally', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeExternalUrl('file:///C:/Windows/system32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('maps updater progress and errors to UI state', () => {
    expect(progressState('0.2.0', { percent: 42.7, transferred: 42_000_000, total: 100_000_000, bytesPerSecond: 5_000_000 })).toEqual({
      status: 'downloading',
      version: '0.2.0',
      percent: 42,
      transferred: 42_000_000,
      total: 100_000_000,
      bytesPerSecond: 5_000_000,
    });
    expect(updateErrorMessage(new Error('getaddrinfo ENOTFOUND updates.example.com'))).toBe('network');
    expect(updateErrorMessage(new Error('HttpError: 404 Not Found\nmore'))).toBe('not-published');
    expect(updateErrorMessage(new Error('sha512 checksum mismatch'))).toBe('integrity');
  });
});
