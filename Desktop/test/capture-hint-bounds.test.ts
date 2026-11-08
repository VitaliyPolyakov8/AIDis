import { describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('electron', () => ({ desktopCapturer: {}, screen: {} }));
vi.mock('../src/main/permissions', () => ({ isRendererUrl: () => true }));
vi.mock('../src/main/streamHints', () => ({ foregroundWindowBounds: boundary.resolve }));
const { CaptureService } = await import('../src/main/capture');
describe('capture hint geometry ownership', () => {
  it('discards window bounds resolved after the capture switched to a different source', async () => {
    let finish!: (value: { x: number; y: number; width: number; height: number }) => void;
    boundary.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const capture = new CaptureService(() => null);
    Object.assign(capture, { activeSource: 'window:1:0' });
    const result = capture.hintBounds('window:1:0');
    Object.assign(capture, { activeSource: 'window:2:0' });
    finish({ x: 0, y: 0, width: 800, height: 600 });
    expect(await result).toBeNull();
  });
});
