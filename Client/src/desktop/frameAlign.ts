/**
 * 0.4.6: a capture track whose frames are 2-pixel aligned for the hardware H.264 encoder
 * (see frameAlign.worker.ts). The returned track feeds the encoder; the original capture track
 * stays the source (constraints such as resolution / frame rate are applied to it).
 */
interface Generator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
declare const MediaStreamTrackGenerator: new (init: { kind: 'video' }) => Generator;

const sources = new WeakMap<MediaStreamTrack, MediaStreamTrack>();
/** 0.4.7: aligned tracks whose stop() must leave the capture running (codec retry / VP8 fallback). */
const released = new WeakSet<MediaStreamTrack>();

export function canAlignFrames(): boolean {
  return typeof window !== 'undefined' && 'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window && typeof Worker !== 'undefined';
}

/** The capture track behind an aligned track (or the track itself). */
export function captureSourceOf(track: MediaStreamTrack): MediaStreamTrack {
  return sources.get(track) ?? track;
}

export function alignedTrack(source: MediaStreamTrack): MediaStreamTrack {
  if (!canAlignFrames()) return source;
  const processor = new MediaStreamTrackProcessor({ track: source });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const worker = new Worker(new URL('./frameAlign.worker.ts', import.meta.url), { type: 'module', name: 'aidis-frame-align' });
  worker.postMessage({ readable: processor.readable, writable: generator.writable }, [processor.readable, generator.writable]);
  generator.contentHint = source.contentHint;
  // The capture ended (window closed, "stop sharing"): end the encoder's track too, and the other way round.
  // (stop() does not fire 'ended', so it is dispatched for LiveKit's "stopped by the browser" handling.)
  source.addEventListener('ended', () => {
    generator.stop();
    generator.dispatchEvent(new Event('ended'));
  });
  const stop = generator.stop.bind(generator);
  generator.stop = () => {
    stop();
    worker.terminate();
    if (!released.has(generator)) source.stop();
  };
  sources.set(generator, source);
  return generator;
}

/**
 * 0.4.7: lets the aligned track be stopped (e.g. by unpublishing it) WITHOUT ending the capture
 * behind it, so the same capture can be published again (H.264 retry or VP8 fallback).
 */
export function releaseCapture(track: MediaStreamTrack): void {
  if (sources.has(track)) released.add(track);
}
