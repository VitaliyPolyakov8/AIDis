import { voiceApi } from '../api/voice';

/**
 * 0.5.5 stream previews: while we share our screen, a small snapshot (320 px wide JPEG, a few KB)
 * goes to the server every THUMBNAIL_INTERVAL_MS. People who hover our LIVE badge see it, also
 * from outside the voice channel, without joining the stream. Snapshots are taken from the capture
 * itself (never the encoder) on a tiny canvas, so the stream is not affected.
 */
export const THUMBNAIL_INTERVAL_MS = 5000;
export const THUMBNAIL_WIDTH = 320;

/** Snapshot size for a source, keeping its aspect ratio (even numbers). Pure (unit-tested). */
export function thumbnailSize(width: number, height: number, maxWidth = THUMBNAIL_WIDTH): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxWidth, height: Math.round((maxWidth * 9) / 16) };
  const w = Math.min(maxWidth, width);
  return { width: w & ~1, height: Math.max(2, Math.round((w * height) / width) & ~1) };
}

export class StreamThumbnailer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sending = false;
  private active = false;

  /** Starts (or switches to) snapshots of `track`. */
  start(track: MediaStreamTrack): void {
    this.stopCapture();
    if (typeof document === 'undefined' || typeof MediaStream === 'undefined') return;
    this.active = true;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    this.video = video;
    this.canvas ??= document.createElement('canvas');
    // First snapshot soon after the start, then every few seconds.
    setTimeout(() => void this.capture(), 1500);
    this.timer = setInterval(() => void this.capture(), THUMBNAIL_INTERVAL_MS);
  }

  /** The stream ended: stop and remove our preview from the server. */
  stop(): void {
    const wasActive = this.active;
    this.stopCapture();
    this.active = false;
    if (wasActive) void voiceApi.clearStreamThumbnail().catch(() => undefined);
  }

  private stopCapture(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
  }

  /** A method (not the field): the stream may stop while a snapshot is being encoded. */
  private isActive(): boolean {
    return this.active;
  }

  private async capture(): Promise<void> {
    const video = this.video;
    const canvas = this.canvas;
    if (!this.active || !video || !canvas || this.sending || video.readyState < 2) return;
    const size = thumbnailSize(video.videoWidth, video.videoHeight);
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    context.drawImage(video, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    if (!blob || !this.isActive()) return;
    this.sending = true;
    try {
      await voiceApi.putStreamThumbnail(blob);
    } catch {
      /* an older server or a short network problem: the next snapshot tries again */
    } finally {
      this.sending = false;
    }
  }
}
