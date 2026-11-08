import { asServerMembers } from './test/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { alice, bob } from './test/fixtures';

const { sanitizeVoicePrefs, startVoicePrefs, loadVoicePrefs } = await import('./voice/voicePrefs');
const { useVoiceStore, INITIAL_VOICE_STATE, pruneWatched } = await import('./voice/voiceStore');
const { voice } = await import('./voice/voiceService');
const { streamAudioFor, captureConstraints } = await import('./desktop/screenCapture');
const { DEFAULT_STREAMING, streamDegradation } = await import('./desktop/contract');
const { usePopoutStore, openStreamPopout, StreamPopoutHost, popoutName } = await import('./components/voice/StreamPopout');
const { MembersSidebar } = await import('./components/MembersSidebar');
const { usePresenceStore } = await import('./stores/presenceStore');
const { useAuthStore } = await import('./stores/authStore');

const sharing = (identity: string) => ({ identity, name: identity, isLocal: false, isSpeaking: false, micMuted: false, screenSharing: true, screenShareAudio: true });

beforeEach(() => {
  useVoiceStore.setState(INITIAL_VOICE_STATE);
  usePopoutStore.setState({ popouts: [], entries: [] });
  localStorage.clear();
});

describe('remembered mute / deafen (per account)', () => {
  it('restores mic mute after a restart and saves changes', () => {
    localStorage.setItem('aidis.voiceState.u1', JSON.stringify({ micEnabled: false, deafened: false, micBeforeDeafen: false }));
    const stop = startVoicePrefs('u1');
    expect(useVoiceStore.getState().micEnabled).toBe(false);
    useVoiceStore.setState({ micEnabled: true });
    expect(loadVoicePrefs('u1')).toEqual({ micEnabled: true, deafened: false, micBeforeDeafen: true });
    stop();
    // Another account has its own state.
    expect(loadVoicePrefs('u2')).toBeNull();
  });

  it('never restores an impossible state: deafened means the microphone is off', () => {
    expect(sanitizeVoicePrefs({ micEnabled: true, deafened: true, micBeforeDeafen: true })).toEqual({ micEnabled: false, deafened: true, micBeforeDeafen: true });
    expect(sanitizeVoicePrefs({ micEnabled: 'yes' })).toBeNull();
    expect(sanitizeVoicePrefs(null)).toBeNull();
  });
});

describe('Watch Stream (nothing opens automatically)', () => {
  it('a live share is only watched after the user chooses it; stopping removes only that one', () => {
    useVoiceStore.setState({ participants: [sharing('a'), sharing('b')] });
    expect(useVoiceStore.getState().watchedShares).toEqual([]);
    voice.watchShare('a');
    voice.watchShare('b');
    voice.watchShare('a'); // idempotent
    expect(useVoiceStore.getState().watchedShares).toEqual(['a', 'b']);
    voice.focusShare('b');
    expect(useVoiceStore.getState().focusedShare).toBe('b');
    voice.stopWatching('b');
    expect(useVoiceStore.getState().watchedShares).toEqual(['a']);
    expect(useVoiceStore.getState().focusedShare).toBeNull();
  });

  it('a share that ends leaves the watched list; the others stay', () => {
    expect(pruneWatched([sharing('a'), { ...sharing('b'), screenSharing: false }], ['a', 'b']).watched).toEqual(['a']);
  });
});

describe('stream capture settings', () => {
  it('application audio for windows by default, system audio for screens, none when off', () => {
    expect(streamAudioFor('window:12:0', DEFAULT_STREAMING)).toBe('app');
    expect(streamAudioFor('screen:0:0', DEFAULT_STREAMING)).toBe('system');
    expect(streamAudioFor('window:12:0', { ...DEFAULT_STREAMING, appAudio: false })).toBe('system');
    expect(streamAudioFor('window:12:0', { ...DEFAULT_STREAMING, systemAudio: false })).toBe('none');
  });

  it('1080p60 captures at 120 Hz (no 60 Hz aliasing) and keeps resolution AND frame rate', () => {
    const c = captureConstraints(DEFAULT_STREAMING, false).video as MediaTrackConstraints;
    expect(c.frameRate).toEqual({ ideal: 120, max: 120 });
    expect(c.width).toEqual({ max: 1920 });
    expect(streamDegradation(DEFAULT_STREAMING)).toBe('maintain-framerate-and-resolution');
  });
});

describe('pop-out window', () => {
  it('renders the stream into its own window and returns it when that window closes', async () => {
    const child = document.implementation.createHTMLDocument('popout');
    const fakeWin = Object.assign(new EventTarget(), { document: child, closed: false, close: vi.fn() });
    const open = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);
    vi.spyOn(voice, 'getStreamTrack').mockReturnValue(null);
    useVoiceStore.setState({ status: 'connected', participants: [sharing('bob')] });
    render(<StreamPopoutHost />);
    act(() => openStreamPopout('bob'));
    expect(open).toHaveBeenCalledWith('about:blank', popoutName('bob'), expect.any(String));
    await vi.waitFor(() => expect(child.querySelector('.stream-tile')).not.toBeNull());
    expect(child.documentElement.classList.contains('is-popout')).toBe(true);
    expect(useVoiceStore.getState().watchedShares).toEqual(['bob']);
    act(() => {
      fakeWin.dispatchEvent(new Event('pagehide'));
    });
    expect(usePopoutStore.getState().popouts).toEqual([]);
    expect(fakeWin.close).not.toHaveBeenCalled(); // the user closed it already
    open.mockRestore();
  });
});

describe('member list game names', () => {
  it('the voice icon is on the name line, so the activity line gets the whole width', async () => {
    useAuthStore.setState({ status: 'authenticated', user: alice });
    usePresenceStore.setState({
      users: { [bob.id]: bob },
      presence: {
        [bob.id]: { userId: bob.id, status: 'online', state: 'online', lastSeenAt: null, customStatus: null, activity: { type: 'playing', name: 'DARK SOULS™: REMASTERED — a deliberately very long game name' } },
      },
      loaded: true,
    });
    useVoiceStore.setState({ occupancy: { vc: [{ identity: bob.id, name: 'Bob', joinedAt: null }] } });
    await asServerMembers();
    const { container } = render(
      <MemoryRouter>
        <MembersSidebar />
      </MemoryRouter>,
    );
    expect(container.querySelector('.member-name .member-voice')).not.toBeNull();
    const pill = container.querySelector('.activity-pill') as HTMLElement;
    expect(pill.getAttribute('title')).toContain('DARK SOULS™: REMASTERED — a deliberately very long game name');
  });
});
