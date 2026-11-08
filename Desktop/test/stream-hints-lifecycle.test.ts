import { afterEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ windows: [] as { destroyed: boolean; rejectLoad(error: Error): void }[] }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => 'C:/app' },
  screen: {},
  BrowserWindow: class {
    destroyed = false;
    rejectLoad!: (error: Error) => void;
    load = new Promise<void>((_resolve, reject) => {
      this.rejectLoad = reject;
    });
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn() };
    constructor() {
      native.windows.push(this);
    }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setContentProtection() {}
    destroy() {
      this.destroyed = true;
    }
    loadFile() {
      return this.load;
    }
  },
}));
Object.assign(process, { resourcesPath: 'C:/app/resources' });
const { StreamHints } = await import('../src/main/streamHints');
afterEach(() => {
  vi.useRealTimers();
  native.windows.length = 0;
});
describe('native hint ownership', () => {
  it('an aborted old window load cannot destroy the replacement marker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const hints = new StreamHints(() => Promise.resolve({ x: 0, y: 0, width: 800, height: 600 }));
    const marker = { sourceId: 'window:123:0', type: 'pointer', x: 0.5, y: 0.5 };
    await hints.show(marker);
    vi.advanceTimersByTime(300);
    await hints.show(marker);
    const [old, replacement] = native.windows;
    expect(old?.destroyed).toBe(true);
    old?.rejectLoad(new Error('ERR_ABORTED'));
    await Promise.resolve();
    expect(replacement?.destroyed).toBe(false);
    hints.clear();
  });
  it('discarding consent while bounds resolve prevents the native window from appearing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    let finish!: (value: { x: number; y: number; width: number; height: number }) => void;
    const hints = new StreamHints(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const show = hints.show({ sourceId: 'window:123:0', type: 'pointer', x: 0.5, y: 0.5 });
    hints.clear();
    finish({ x: 0, y: 0, width: 800, height: 600 });
    await show;
    expect(native.windows).toHaveLength(0);
  });
  it('does not restart an expired pointer after an asynchronous bounds lookup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    let finish!: (value: { x: number; y: number; width: number; height: number }) => void;
    const hints = new StreamHints(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const show = hints.show({ sourceId: 'window:123:0', type: 'pointer', x: 0.5, y: 0.5, expiresAt: 10100 });
    vi.advanceTimersByTime(200);
    finish({ x: 0, y: 0, width: 800, height: 600 });
    await show;
    expect(native.windows).toHaveLength(0);
  });
});
