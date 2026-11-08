import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.5.0' },
  BrowserWindow: vi.fn(),
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  screen: { on: vi.fn(), off: vi.fn() },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });

const { ToastQueue, sanitizeToast, MAX_VISIBLE, MAX_QUEUED } = await import('../src/main/toasts');
const { computeOverlayBounds, findSavedDisplay } = await import('../src/main/overlay');
const { SettingsStore } = await import('../src/main/settings');
const { sanitizeOverlay } = await import('../../Client/src/desktop/contract');

const request = (n: number) => ({ author: `User ${n}`, channelLabel: '#general', body: `hello ${n}`, channelId: 'c1', avatar: null, initials: 'U', color: '#5b6ee1', nameColor: null, mention: false });

describe('0.5.0 AIDis notifications', () => {
  it('validates a card request (no script, no remote images, no CSS)', () => {
    expect(sanitizeToast(request(1))).toMatchObject({ author: 'User 1', channelId: 'c1' });
    expect(sanitizeToast({ ...request(1), channelId: '../x' })).toBeNull();
    expect(sanitizeToast({ ...request(1), author: '' })).toBeNull();
    const s = sanitizeToast({ ...request(1), avatar: 'https://evil/x.png', nameColor: 'red; background:url(x)', color: 'javascript:1', body: 'x'.repeat(1000) });
    expect(s?.avatar).toBeNull();
    expect(s?.nameColor).toBeNull();
    expect(s?.color).toBe('#5b7cff');
    expect(s?.body.length).toBe(240);
    expect(sanitizeToast({ ...request(1), avatar: 'data:image/webp;base64,AAAA' })?.avatar).toBe('data:image/webp;base64,AAAA');
  });

  it('shows at most three cards, queues the rest and moves the next one up when a card goes', () => {
    const q = new ToastQueue();
    for (let i = 1; i <= 5; i++) q.push(request(i));
    expect(q.visible.map((t) => t.author)).toEqual(['User 1', 'User 2', 'User 3']);
    expect(q.waiting.map((t) => t.author)).toEqual(['User 4', 'User 5']);
    expect(MAX_VISIBLE).toBe(3);
    const first = q.visible[0];
    expect(first).toBeDefined();
    const next = q.remove(first?.id ?? -1);
    expect(next?.author).toBe('User 4');
    expect(q.visible.map((t) => t.author)).toEqual(['User 2', 'User 3', 'User 4']);
    // A burst never piles up endlessly.
    for (let i = 0; i < 50; i++) q.push(request(100 + i));
    expect(q.waiting.length).toBe(MAX_QUEUED);
  });
});

describe('0.5.0 overlay position survives restarts and updates', () => {
  const size = { width: 300, height: 420 };
  const left = { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const right = { id: 12, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
  const saved = { displayId: 12, x: 700, y: 300, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };

  it('finds the display again when Windows hands out new display ids (the 0.4.x reset)', () => {
    const afterRestart = [
      { ...left, id: 901 },
      { ...right, id: 902 },
    ];
    expect(findSavedDisplay(saved, afterRestart)?.id).toBe(902);
    expect(computeOverlayBounds({ corner: 'top-left', displayId: null, custom: saved }, size, afterRestart, afterRestart[0]!)).toEqual({ x: 1920 + 700, y: 300, ...size });
  });

  it('never restores off-screen: a removed monitor puts it on the nearest screen, clamped', () => {
    const onlyLeft = [left];
    const b = computeOverlayBounds({ corner: 'top-left', displayId: null, custom: saved }, size, onlyLeft, left);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1920);
    expect(b.y + b.height).toBeLessThanOrEqual(1040);
  });

  it('keeps old 0.4.x positions (no rectangle) working as before', () => {
    expect(findSavedDisplay({ displayId: 11, x: 10, y: 10 }, [left, right])?.id).toBe(11);
    expect(findSavedDisplay({ displayId: 99, x: 10, y: 10 }, [left, right])).toBeNull();
    expect(sanitizeOverlay({ custom: { displayId: 1, x: 5, y: 6, bounds: { x: 0, y: 0, width: 0, height: 9 } } }).custom).toEqual({ displayId: 1, x: 5, y: 6 });
  });

  it('is stored in userData settings.json (not in the app folder an update replaces) and read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidis-050-'));
    const first = new SettingsStore(dir, 'en');
    first.update({ overlay: { custom: saved, scale: 125, opacity: 55, corner: 'bottom-right', mode: 'minimal' } });
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { overlay: { custom: unknown; scale: number } };
    expect(onDisk.overlay.custom).toEqual(saved);
    // "Restart" / "update": a new store over the same userData folder.
    const second = new SettingsStore(dir, 'ru');
    expect(second.get().overlay).toMatchObject({ custom: saved, scale: 125, opacity: 55, corner: 'bottom-right', mode: 'minimal' });
  });
});
