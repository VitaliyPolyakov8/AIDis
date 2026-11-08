/// <reference lib="webworker" />
/**
 * 0.4.6: makes captured frames safe for the hardware H.264 encoder.
 *
 * Windows Graphics Capture hands over GPU texture frames at the window's native pixel size, which
 * can be odd (e.g. 2864 x 1611 for a 1080p window on a 150 % display). Chromium's Media Foundation
 * encoder rejects a visible rectangle that is not 2-pixel aligned for 4:2:0 ("Source visible_rect is
 * not properly aligned for 4:2:0 subsampled format") and the renderer then crashed. Here each frame
 * is re-wrapped with an even visible rectangle and even display size: only frame METADATA changes,
 * the GPU texture is shared (zero-copy, no pixels are touched, nothing is duplicated). Runs in a
 * worker so the page's main thread never delays frames.
 *
 * 0.5.2: Windows Graphics Capture delivers a frame only when the picture CHANGES. A static window
 * (a document, a paused game, a minimized-then-restored window) produced no frames at all for
 * seconds: the hardware encoder never started (the 0.5.1 encoder check took that for a broken
 * encoder and fell back to software VP8), and viewers who joined later saw nothing until something
 * moved, because a new viewer's key frame request needs a frame to encode. A screen track keeps
 * that alive with Chromium's own refresh frames, but this generated track has no such path, so the
 * newest frame is repeated here while the source is idle (REPEAT_MS apart: cheap for the encoder,
 * an unchanged frame costs a few bytes). Timestamps are kept strictly increasing.
 *
 * A repeat must be a NEW frame: re-wrapping the same buffer (new VideoFrame(last, { timestamp }))
 * reaches the generator but WebRTC's source drops it as the frame it already has (measured: 64
 * writes, 1 frame at the sender). So the idle picture is drawn into an OffscreenCanvas (a GPU blit)
 * and each repeat is a fresh frame from it. Measured with a static window: 0 -> ~7-10 FPS, encoded
 * by NVENC, viewers get the picture; a moving 60 FPS window sends no repeats at all.
 */
interface Start {
  readable: ReadableStream<VideoFrame>;
  writable: WritableStream<VideoFrame>;
}

/** Idle gap after which the newest frame is sent again, and the repeat interval (10 FPS). */
const REPEAT_MS = 100;

let aligned = 0;
let passed = 0;
let repeated = 0;

function align(frame: VideoFrame): VideoFrame {
  const r = frame.visibleRect;
  if (!r) return frame;
  const x = r.x + (r.x & 1);
  const y = r.y + (r.y & 1);
  const width = (r.width - (x - r.x)) & ~1;
  const height = (r.height - (y - r.y)) & ~1;
  const displayWidth = frame.displayWidth & ~1;
  const displayHeight = frame.displayHeight & ~1;
  if (x === r.x && y === r.y && width === r.width && height === r.height && displayWidth === frame.displayWidth && displayHeight === frame.displayHeight) {
    passed += 1;
    return frame;
  }
  aligned += 1;
  const out = new VideoFrame(frame, { visibleRect: { x, y, width, height }, displayWidth, displayHeight });
  frame.close();
  return out;
}

/** Same frame with a new timestamp (metadata only, the texture is shared). */
function retimed(frame: VideoFrame, timestamp: number): VideoFrame {
  return new VideoFrame(frame, { timestamp });
}

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;

/** A new frame with the same picture (see the header: a re-wrapped frame would be dropped). */
function repeatOf(frame: VideoFrame, timestamp: number): VideoFrame | null {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', { alpha: false });
  }
  if (!context) return null;
  context.drawImage(frame, 0, 0, width, height);
  return new VideoFrame(canvas, { timestamp });
}

async function run({ readable, writable }: Start): Promise<void> {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  /** Newest frame sent (a clone we own), for repeats (an object: closures update it). */
  const held: { last: VideoFrame | null } = { last: null };
  let lastTimestamp = -1;
  let lastSentAt = 0;
  let closed = false;

  const send = (frame: VideoFrame) => {
    lastTimestamp = frame.timestamp;
    lastSentAt = performance.now();
    held.last?.close();
    held.last = frame.clone();
    // Not awaited: the stream queues writes in order. Backpressure is checked before each repeat.
    writer.write(frame).catch(() => frame.close());
  };

  const timer = setInterval(() => {
    const last = held.last;
    if (closed || !last) return;
    const idle = performance.now() - lastSentAt;
    // Only while the source is idle, and never on top of a queue the encoder has not taken yet.
    if (idle < REPEAT_MS || (writer.desiredSize ?? 0) <= 0) return;
    const repeat = repeatOf(last, lastTimestamp + Math.round(idle * 1000));
    if (!repeat) return;
    repeated += 1;
    send(repeat);
  }, REPEAT_MS / 2);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.ready;
      let frame = align(value);
      if (frame.timestamp <= lastTimestamp) {
        const fixed = retimed(frame, lastTimestamp + 1);
        frame.close();
        frame = fixed;
      }
      send(frame);
    }
  } catch {
    /* the capture or the encoder track ended */
  } finally {
    closed = true;
    clearInterval(timer);
    held.last?.close();
    held.last = null;
    writer.close().catch(() => undefined);
  }
}

self.onmessage = (event: MessageEvent<Start | 'stats'>) => {
  if (event.data === 'stats') {
    self.postMessage({ aligned, passed, repeated });
    return;
  }
  void run(event.data);
};
