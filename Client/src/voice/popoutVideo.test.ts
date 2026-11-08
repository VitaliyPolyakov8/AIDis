import { describe, expect, it, vi } from 'vitest';
import { WindowElementInfo, attachVideo } from './popoutVideo';

/** A fake pop-out window with its own observers (what LiveKit's main-window observers miss). */
function fakeWindow() {
  const io: { callback?: (entries: { target: unknown; isIntersecting: boolean }[]) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } = { observe: vi.fn(), disconnect: vi.fn() };
  const ro: { callback?: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } = { observe: vi.fn(), disconnect: vi.fn() };
  const listeners: Record<string, () => void> = {};
  const doc = { visibilityState: 'visible', addEventListener: (type: string, fn: () => void) => (listeners[type] = fn), removeEventListener: vi.fn() };
  const win = {
    IntersectionObserver: function (cb: typeof io.callback) {
      io.callback = cb;
      return io;
    },
    ResizeObserver: function (cb: typeof ro.callback) {
      ro.callback = cb;
      return ro;
    },
    document: doc,
  };
  const element = { clientWidth: 1280, clientHeight: 720, ownerDocument: { defaultView: win, ...doc } };
  return { win, io, ro, doc, listeners, element };
}

describe('0.7.0 pop-out stream video (LiveKit adaptive stream)', () => {
  it("watches size and visibility with the pop-out window's own observers", () => {
    const { io, ro, element } = fakeWindow();
    const info = new WindowElementInfo(element as unknown as HTMLVideoElement);
    info.handleResize = vi.fn();
    info.handleVisibilityChanged = vi.fn();
    info.observe();
    expect(io.observe).toHaveBeenCalledWith(element);
    expect(ro.observe).toHaveBeenCalledWith(element);
    expect(info.width()).toBe(1280);
    expect(info.visible).toBe(true);

    ro.callback?.();
    expect(info.handleResize).toHaveBeenCalledTimes(1);

    io.callback?.([{ target: element, isIntersecting: false }]);
    expect(info.visible).toBe(false);
    expect(info.visibilityChangedAt).toBeGreaterThan(0);
    expect(info.handleVisibilityChanged).toHaveBeenCalledTimes(1);

    info.stopObserving();
    expect(io.disconnect).toHaveBeenCalled();
    expect(ro.disconnect).toHaveBeenCalled();
  });

  it('a hidden (minimized) pop-out window counts as not visible', () => {
    const { element, listeners } = fakeWindow();
    const info = new WindowElementInfo(element as unknown as HTMLVideoElement);
    info.handleVisibilityChanged = vi.fn();
    info.observe();
    element.ownerDocument.visibilityState = 'hidden';
    listeners.visibilitychange?.();
    expect(info.visible).toBe(false);
    expect(info.handleVisibilityChanged).toHaveBeenCalled();
  });

  it('registers the pop-out observer BEFORE attach (so LiveKit does not add its main-window one)', () => {
    const { element } = fakeWindow();
    const calls: string[] = [];
    const track = { observeElementInfo: vi.fn((_info: unknown) => calls.push('observe')), attach: vi.fn((_el: unknown) => calls.push('attach')) };
    attachVideo(track as never, element as unknown as HTMLVideoElement, {} as Window);
    expect(calls).toEqual(['observe', 'attach']);
    expect(track.observeElementInfo.mock.calls[0]?.[0]).toBeInstanceOf(WindowElementInfo);
  });

  it('a video in the main window is attached exactly as before', () => {
    const { element, win } = fakeWindow();
    const track = { observeElementInfo: vi.fn(), attach: vi.fn() };
    attachVideo(track as never, element as unknown as HTMLVideoElement, win as unknown as Window);
    expect(track.observeElementInfo).not.toHaveBeenCalled();
    expect(track.attach).toHaveBeenCalledWith(element);
  });
});
