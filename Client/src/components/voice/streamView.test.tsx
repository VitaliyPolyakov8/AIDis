import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const attached: HTMLMediaElement[] = [];
const fakeTrack = {
  attach: (el: HTMLMediaElement) => {
    attached.push(el);
    return el;
  },
  detach: vi.fn(),
  getRTCStatsReport: () => Promise.resolve(new Map()),
};

vi.mock('../../voice/voiceService', () => ({
  voice: {
    getScreenShareTrack: () => fakeTrack,
    getStreamTrack: () => fakeTrack,
    getScreenShareSenderInfo: () => null,
    setStreamVolume: vi.fn(),
    toggleMic: vi.fn(),
    toggleDeafen: vi.fn(),
    leave: vi.fn(),
    stopScreenShare: vi.fn(),
    focusShare: vi.fn(),
    stopWatching: vi.fn(),
    watchShare: vi.fn(),
    selectStreamAudio: vi.fn(),
  },
}));
vi.mock('./VoiceChatPanel', () => ({
  VoiceChatPanel: () => <aside aria-label="voice chat panel" />,
}));

const { StreamStage } = await import('./StreamView');
const { voice } = await import('../../voice/voiceService');
const { useUiStore } = await import('../../stores/uiStore');
const { useVoiceStore, INITIAL_VOICE_STATE, liveStreams } = await import('../../voice/voiceStore');
const { useSettingsStore } = await import('../../stores/settingsStore');

const channel = { id: 'vc1', name: 'General', type: 'VOICE', description: null, position: 0 } as never;
const presenter = { identity: 'bob', name: 'Bob', isLocal: false, isSpeaking: false, micMuted: false, screenSharing: true, screenShareAudio: true };

function enableFullscreen() {
  Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
  const holder: { el: Element | null } = { el: null };
  Object.defineProperty(document, 'fullscreenElement', { get: () => holder.el, configurable: true });
  Element.prototype.requestFullscreen = function requestFullscreen(this: Element) {
    holder.el = this;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    holder.el = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
}

describe('stream viewer', () => {
  beforeEach(() => {
    attached.length = 0;
    enableFullscreen();
    useUiStore.setState({ voiceChatOpen: false, streamFullscreen: false, streamBarCollapsed: false });
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE, status: 'connected', channelId: 'vc1' });
    useSettingsStore.setState({ streamVolumes: {} });
    vi.mocked(voice.setStreamVolume).mockClear();
  });

  it('keeps only Statistics, Fullscreen and Stop watching on the video; voice controls are in the bottom bar', () => {
    const { container } = render(<StreamStage streams={liveStreams([presenter])} channel={channel} />);
    const overlay = container.querySelector('.stream-actions') as HTMLElement;
    expect(within(overlay).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Listen to this stream', 'Statistics', 'Fullscreen', 'Stop watching']);
    const bar = screen.getByRole('toolbar', { name: 'Stream controls' });
    for (const name of ['Mute microphone', 'Deafen', 'Open chat', 'Leave voice channel', 'Hide controls']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
    // 0.4.5: each stream has its own volume on its tile.
    expect(screen.getByRole('slider', { name: 'Stream Volume' })).toHaveValue('100');
  });

  it('stream volume is local, 0..200 %, and does not touch the microphone', () => {
    render(<StreamStage streams={liveStreams([presenter])} channel={channel} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Stream Volume' }), { target: { value: '35' } });
    expect(voice.setStreamVolume).toHaveBeenLastCalledWith('bob', 35);
    expect(screen.getByRole('slider', { name: 'Stream Volume' })).toHaveAttribute('max', '200');
    expect(voice.toggleMic).not.toHaveBeenCalled();
  });

  it('opens the voice chat inside fullscreen without re-creating the video', async () => {
    render(<StreamStage streams={liveStreams([presenter])} channel={channel} />);
    const video = document.querySelector('video');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await Promise.resolve();
    });
    expect(useUiStore.getState().streamFullscreen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(screen.getByRole('complementary', { name: 'voice chat panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide chat' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }));
    expect(screen.queryByRole('complementary', { name: 'voice chat panel' })).toBeNull();
    // Same element the whole time, attached once.
    expect(document.querySelector('video')).toBe(video);
    expect(attached).toHaveLength(1);
  });

  it('the bottom bar can be hidden and shown again, and mirrors mic / headphones state', () => {
    useVoiceStore.setState({ micEnabled: false, deafened: true });
    render(<StreamStage streams={liveStreams([presenter])} channel={channel} />);
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Undeafen' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide controls' }));
    expect(screen.queryByRole('toolbar', { name: 'Stream controls' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show controls' }));
    expect(screen.getByRole('toolbar', { name: 'Stream controls' })).toBeInTheDocument();
  });

  it('fades the overlay after the mouse rests and brings it back on movement', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<StreamStage streams={liveStreams([presenter])} channel={channel} />);
      const shell = container.querySelector('.stream-shell') as HTMLElement;
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(shell).toHaveClass('is-idle');
      fireEvent.pointerMove(shell);
      expect(shell).not.toHaveClass('is-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('0.4.5 multi-stream: one tile per watched stream, independent volume, one ending removes only its tile', () => {
    const alice = { ...presenter, identity: 'alice', name: 'Alice' };
    useSettingsStore.setState({ streamVolumes: { bob: 100, alice: 20 } });
    const { container, rerender } = render(<StreamStage streams={liveStreams([presenter, alice])} channel={channel} />);
    expect(container.querySelectorAll('.stream-tile')).toHaveLength(2);
    expect(container.querySelector('.stream-grid')).toHaveClass('count-2');
    const sliders = screen.getAllByRole('slider', { name: 'Stream Volume' });
    expect(sliders.map((el) => (el as HTMLInputElement).value)).toEqual(['100', '20']);
    fireEvent.change(sliders[1] as HTMLElement, { target: { value: '0' } });
    expect(voice.setStreamVolume).toHaveBeenLastCalledWith('alice', 0);
    // Clicking a tile focuses it (it becomes the large one).
    fireEvent.click(container.querySelectorAll('.stream-tile')[1] as HTMLElement);
    expect(voice.focusShare).toHaveBeenLastCalledWith('alice');
    rerender(<StreamStage streams={liveStreams([alice])} channel={channel} />);
    expect(container.querySelectorAll('.stream-tile')).toHaveLength(1);
    expect(container.querySelector('.stream-presenter-name')?.textContent).toBe('Alice');
  });
  it('can pin audio without changing video focus, and return focused streams to an equal grid', () => {
    const alice = { ...presenter, identity: 'alice', name: 'Alice' };
    useVoiceStore.setState({ watchedShares: ['bob', 'alice'], audioShare: 'bob', focusedShare: 'bob' });
    render(<StreamStage streams={liveStreams([presenter, alice])} channel={channel} />);
    vi.mocked(voice.focusShare).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Listen to this stream' }));
    expect(voice.selectStreamAudio).toHaveBeenLastCalledWith('alice');
    expect(voice.focusShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View side by side' }));
    expect(voice.focusShare).toHaveBeenLastCalledWith(null);
  });
});
