import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app', getVersion: () => '0.5.93' },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });
const { StreamPopouts } = await import('../src/main/streamPopouts');

describe('stream overlay windows', () => {
  it('creates a bounded frameless overlay, then restores click access with the overlay hotkey', () => {
    const service = new StreamPopouts('C:/nonexistent-aidis-test');
    const options = service.options('aidis-popout-overlay-bob');
    expect(options).toMatchObject({ frame: false, skipTaskbar: true, alwaysOnTop: true, focusable: false });
    expect(service.options('aidis-popout-bob').frame).not.toBe(false);
    const win = {
      setMenu: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setFocusable: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    };
    service.register(win as never, 'aidis-popout-overlay-bob');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    service.toggleOverlayInteractive();
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);
    service.toggleOverlayInteractive();
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    // A regular pop-out must remain interactive.
    const plain = { ...win, setIgnoreMouseEvents: vi.fn(), on: vi.fn() };
    service.register(plain as never, 'aidis-popout-bob');
    service.toggleOverlayInteractive();
    expect(plain.setIgnoreMouseEvents).not.toHaveBeenCalled();
  });
});
