import type { ElementInfo, Track } from 'livekit-client';

/**
 * 0.7.0 fix: lost frames while watching a stream in its own (pop-out) window.
 *
 * LiveKit's adaptive stream watches every attached <video> with the MAIN window's
 * IntersectionObserver / ResizeObserver. A pop-out <video> lives in another window: those observers
 * only report when the main window itself renders (measured in Electron 44: a pop-out resize was
 * reported only after the main window repainted, nothing while it was minimized). LiveKit then sends
 * the SFU stale size / visibility for the stream (updateTrackSettings), and the viewer loses frames
 * until the stream is back in the main window. Here the pop-out <video> is watched by the observers
 * of the window it is shown in.
 */
export class WindowElementInfo implements ElementInfo {
  readonly element: HTMLVideoElement;
  visible = true;
  pictureInPicture = false;
  visibilityChangedAt: number | undefined = 0;
  handleResize?: () => void;
  handleVisibilityChanged?: () => void;
  private intersecting = true;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private readonly onPageVisibility = () => this.updateVisible();

  constructor(element: HTMLVideoElement) {
    this.element = element;
  }

  width(): number {
    return this.element.clientWidth;
  }

  height(): number {
    return this.element.clientHeight;
  }

  private get doc(): Document {
    return this.element.ownerDocument;
  }

  private updateVisible(): void {
    const visible = this.intersecting && this.doc.visibilityState !== 'hidden';
    if (visible === this.visible) return;
    this.visible = visible;
    this.visibilityChangedAt = Date.now();
    this.handleVisibilityChanged?.();
  }

  observe(): void {
    const win = this.doc.defaultView;
    if (!win) return;
    this.io = new win.IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.target === this.element) this.intersecting = entry.isIntersecting;
      this.updateVisible();
    });
    this.ro = new win.ResizeObserver(() => this.handleResize?.());
    this.io.observe(this.element);
    this.ro.observe(this.element);
    this.doc.addEventListener('visibilitychange', this.onPageVisibility);
  }

  stopObserving(): void {
    this.io?.disconnect();
    this.ro?.disconnect();
    this.io = null;
    this.ro = null;
    this.doc.removeEventListener('visibilitychange', this.onPageVisibility);
  }
}

type AttachableTrack = Pick<Track, 'attach'> & { observeElementInfo?: (info: ElementInfo) => void };

/**
 * Attaches a stream track to its <video>. A <video> shown in another window (a pop-out) first gets
 * the observer of that window: LiveKit's attach() then sees the element is already observed and does
 * not add its main-window one. detach(element) later removes it (LiveKit matches info.element).
 */
export function attachVideo(track: AttachableTrack, element: HTMLVideoElement, mainWindow: Window = window): void {
  if (track.observeElementInfo && element.ownerDocument.defaultView !== mainWindow) track.observeElementInfo(new WindowElementInfo(element));
  track.attach(element);
}
