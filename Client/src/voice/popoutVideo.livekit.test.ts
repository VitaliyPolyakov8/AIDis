import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteVideoTrack } from 'livekit-client';
import { WindowElementInfo, attachVideo } from './popoutVideo';

/** jsdom has no WebRTC: just enough MediaStream for LiveKit's attach(). */
class FakeMediaStream {
  private tracks: unknown[] = [];
  constructor(tracks: unknown[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return [];
  }
  addTrack(t: unknown) {
    this.tracks.push(t);
  }
  removeTrack(t: unknown) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

const mediaTrack = () =>
  ({ kind: 'video', id: 'v1', enabled: true, readyState: 'live', muted: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), getSettings: () => ({}), stop: vi.fn() }) as unknown as MediaStreamTrack;

describe('0.7.0 pop-out video with the real LiveKit RemoteVideoTrack', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(async () => {
    // LiveKit re-plays attached video on a 0 ms timer (its Safari path, which jsdom triggers).
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attach() keeps the pop-out window's observer and adds no main-window one; detach() removes it", () => {
    const track = new RemoteVideoTrack(mediaTrack(), 'TR_x', undefined as unknown as RTCRtpReceiver, {});
    const video = document.createElement('video');
    document.body.appendChild(video);
    const stop = vi.spyOn(WindowElementInfo.prototype, 'stopObserving');
    // The pop-out case: pretend the main window is another window.
    attachVideo(track, video, {} as Window);
    const infos = (track as unknown as { elementInfos: unknown[] }).elementInfos;
    expect(infos).toHaveLength(1);
    expect(infos[0]).toBeInstanceOf(WindowElementInfo);
    track.detach(video);
    expect((track as unknown as { elementInfos: unknown[] }).elementInfos).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it('in the main window LiveKit keeps observing as before', () => {
    const track = new RemoteVideoTrack(mediaTrack(), 'TR_y', undefined as unknown as RTCRtpReceiver, {});
    const video = document.createElement('video');
    document.body.appendChild(video);
    attachVideo(track, video);
    const infos = (track as unknown as { elementInfos: unknown[] }).elementInfos;
    expect(infos).toHaveLength(1);
    expect(infos[0]).not.toBeInstanceOf(WindowElementInfo);
    track.detach(video);
  });
});
