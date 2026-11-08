import { asServerMembers } from './test/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AidisDesktopApi } from './desktop/contract';
import type { VoiceSessionView } from './api/types';
import { alice, bob } from './test/fixtures';

// 0.4.1 runs inside a fake AIDis Desktop (the bridge reads window.aidisDesktop at import time).
const findGameSource = vi.fn<() => Promise<string | null>>();
vi.mock('./desktop/bridge', () => ({
  isDesktop: true,
  desktop: {
    isDesktop: true,
    capture: { getSources: vi.fn(() => Promise.resolve([])), select: vi.fn(), findGameSource },
    settings: { update: vi.fn(), get: vi.fn(), onChange: vi.fn() },
  } as unknown as AidisDesktopApi,
}));

const { formatVoiceElapsed, formatPlayDuration } = await import('./utils/duration');
const { applyVoiceSessions, useVoiceStore, INITIAL_VOICE_STATE } = await import('./voice/voiceStore');
const { VoiceSessionTimer } = await import('./components/voice/VoiceSessionTimer');
const { clockSubscribers } = await import('./hooks/useNow');
const { steamArtUrl, steamArtFailed, steamArtLoaded, resetSteamArtCache, pickVivid } = await import('./utils/steamArt');
const { useServerConfig } = await import('./api/clientConfig');
const { GameArt, GameActivityCard } = await import('./components/profile/GameArt');
const { SpeakingFrame } = await import('./components/profile/ProfileBits');
const { useLocalGame } = await import('./desktop/localGame');
const { VoiceDock } = await import('./components/VoiceDock');
const { useUiStore } = await import('./stores/uiStore');
const { useSettingsStore, sanitizeSettings } = await import('./stores/settingsStore');
const { MembersSidebar } = await import('./components/MembersSidebar');
const { MenuHost } = await import('./components/menu/MenuHost');
const { ProfilePopoutHost } = await import('./components/profile/ProfilePopout');
const { useProfilePopout } = await import('./components/profile/profileState');
const { usePresenceStore } = await import('./stores/presenceStore');
const { useAuthStore } = await import('./stores/authStore');
const { useChatStore } = await import('./stores/chatStore');
const { setLanguage } = await import('./i18n');

const VOICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const person = (identity: string) => ({ identity, name: identity, joinedAt: null });

beforeEach(() => {
  useVoiceStore.setState(INITIAL_VOICE_STATE);
  useLocalGame.setState({ info: null });
  useUiStore.setState({ sourcePickerOpen: false, sourcePickerPreselect: null });
  useProfilePopout.setState({ target: null });
  findGameSource.mockReset();
  resetSteamArtCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('voice session timer', () => {
  it('formats elapsed time like 0:42, 12:18, 1:03:42', () => {
    expect(formatVoiceElapsed(42_000)).toBe('0:42');
    expect(formatVoiceElapsed(12 * 60_000 + 18_000)).toBe('12:18');
    expect(formatVoiceElapsed(3_600_000 + 3 * 60_000 + 42_000)).toBe('1:03:42');
    expect(formatVoiceElapsed(-5)).toBe('0:00');
  });

  it('A joins (starts), B joins (same start), A leaves (keeps running), B leaves (hidden)', () => {
    const start = new Date(Date.now() - 42_000).toISOString();
    const apply = (sessions: VoiceSessionView[], snapshot = false) => useVoiceStore.setState((s) => applyVoiceSessions(s, sessions, snapshot));
    apply([{ channelId: VOICE, startedAt: start, participants: [person('a')] }]);
    expect(useVoiceStore.getState().voiceSessions[VOICE]).toBe(start);
    apply([{ channelId: VOICE, startedAt: start, participants: [person('a'), person('b')] }]);
    apply([{ channelId: VOICE, startedAt: start, participants: [person('b')] }]);
    expect(useVoiceStore.getState().voiceSessions[VOICE]).toBe(start);
    expect(useVoiceStore.getState().occupancy[VOICE]).toHaveLength(1);
    apply([{ channelId: VOICE, startedAt: null, participants: [] }]);
    expect(useVoiceStore.getState().voiceSessions[VOICE]).toBeUndefined();
    expect(useVoiceStore.getState().occupancy[VOICE]).toEqual([]);
    expect(useVoiceStore.getState().occupancyRealtime).toBe(true);
  });

  it('a snapshot after reconnect empties channels the server no longer lists', () => {
    useVoiceStore.setState({ voiceMembers: { [VOICE]: { a: person('a') } }, voiceSessions: { [VOICE]: new Date().toISOString() } });
    useVoiceStore.setState((s) => applyVoiceSessions(s, [], true));
    expect(useVoiceStore.getState().occupancy[VOICE]).toEqual([]);
    expect(useVoiceStore.getState().voiceSessions).toEqual({});
  });

  it('renders from the server start with one shared clock, and hides when the channel is empty', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:42.000Z'));
    useVoiceStore.setState({ occupancy: { [VOICE]: [person('a')] }, voiceSessions: { [VOICE]: '2026-10-06T12:00:00.000Z' } });
    const view = render(
      <>
        <VoiceSessionTimer channelId={VOICE} />
        <VoiceSessionTimer channelId={VOICE} chip />
        <VoiceSessionTimer channelId={VOICE} />
      </>,
    );
    expect(screen.getAllByText('0:42')).toHaveLength(3);
    // Three timers, one clock: each subscribes a listener to the same ticker.
    expect(clockSubscribers()).toBe(3);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getAllByText('0:44')).toHaveLength(3);
    act(() => {
      useVoiceStore.setState({ occupancy: { [VOICE]: [] }, voiceSessions: {} });
    });
    expect(screen.queryByText(/0:4/)).toBeNull();
    view.unmount();
    expect(clockSubscribers()).toBe(0);
  });
});

describe('member list profile (0.4.1 regression)', () => {
  it('opens the profile from a click AND from the right-click "Profile" item', async () => {
    useAuthStore.setState({ status: 'authenticated', user: alice });
    usePresenceStore.setState({
      users: { [alice.id]: alice, [bob.id]: bob },
      presence: { [bob.id]: { userId: bob.id, status: 'online', state: 'online', lastSeenAt: null, customStatus: null, activity: null } },
      loaded: true,
    });
    useChatStore.setState({ channels: [] });
    await asServerMembers();
    render(
      <MemoryRouter>
        <MembersSidebar />
        <MenuHost />
        <ProfilePopoutHost />
      </MemoryRouter>,
    );
    const row = screen.getByTitle(/Bob \(@bob\)/);
    fireEvent.click(row);
    expect(useProfilePopout.getState().target?.userId).toBe(bob.id);
    act(() => useProfilePopout.setState({ target: null }));

    // The menu item runs after the contextmenu event is over (React cleared currentTarget):
    // before 0.4.1 this threw "Cannot read properties of null (reading 'getBoundingClientRect')".
    fireEvent.contextMenu(row);
    const item = await screen.findByRole('menuitem', { name: /profile|профиль/i });
    fireEvent.click(item);
    expect(useProfilePopout.getState().target?.userId).toBe(bob.id);
    expect(document.querySelector('.profile-card')).not.toBeNull();
  });
});

describe('Steam artwork', () => {
  // Steam images are only used when the server allows them (STEAM_ART).
  beforeEach(() => {
    useServerConfig.setState({ steamArt: true });
  });
  it('tries the CDN, then store_item_assets, then caches "no image" (never a broken image)', () => {
    const first = steamArtUrl(553850, 'header');
    expect(first).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/553850/header.jpg');
    const second = steamArtFailed(553850, 'header', first ?? '');
    expect(second).toBe('https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/553850/header.jpg');
    expect(steamArtFailed(553850, 'header', second ?? '')).toBeNull();
    // Cached per AppID: no further requests for this image.
    expect(steamArtUrl(553850, 'header')).toBeNull();
    steamArtLoaded(730, 'header', 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/730/header.jpg');
    expect(steamArtUrl(730, 'header')).toContain('store_item_assets');
  });

  it('offline: the image fails everywhere -> the gradient tile with a gamepad, no <img> left', () => {
    const { container } = render(<GameArt name="Offline Game" steamAppId={42} kind="header" />);
    let img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    img = container.querySelector('img');
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.game-art-fallback')).not.toBeNull();
    expect(container.querySelector('.game-art')?.getAttribute('style')).toContain('linear-gradient');
  });

  it('no AppID: generated tile; the local exe icon wins for the icon variant', () => {
    const { container, rerender } = render(<GameArt name="Indie" kind="icon" />);
    expect(container.querySelector('img')).toBeNull();
    rerender(<GameArt name="Indie" kind="icon" icon="data:image/png;base64,AAAA" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('picks a vivid dominant color and ignores grey / dark pixels', () => {
    const px = (r: number, g: number, b: number, n: number) => Array.from({ length: n }, () => [r, g, b, 255]).flat();
    expect(pickVivid([...px(20, 20, 20, 50), ...px(128, 128, 128, 50), ...px(40, 160, 255, 20)])).toMatch(/^#/);
    expect(pickVivid(px(120, 120, 120, 100))).toBeNull();
  });
});

describe('game activity duration', () => {
  it('shows how long the game has been running (RU / EN)', () => {
    setLanguage('ru');
    expect(formatPlayDuration(84 * 60_000)).toBe('1 ч 24 мин');
    expect(formatPlayDuration(12 * 60_000)).toBe('12 мин');
    expect(formatPlayDuration(20_000)).toBe('меньше минуты');
    setLanguage('en');
    expect(formatPlayDuration(84 * 60_000)).toBe('1h 24m');
    const startedAt = new Date(Date.now() - 84 * 60_000 - 5000).toISOString();
    render(<GameActivityCard activity={{ type: 'playing', name: 'PowerWash Simulator 2', startedAt, steamAppId: null }} />);
    expect(screen.getByText('PowerWash Simulator 2')).toBeTruthy();
    expect(screen.getByText('for 1h 24m')).toBeTruthy();
  });
});

describe('speaking frame', () => {
  it('the frame is "on" only while speaking; without a frame nothing extra is drawn', () => {
    const { container, rerender } = render(
      <SpeakingFrame frame="neon" speaking={false} size={76}>
        <span />
      </SpeakingFrame>,
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('frame-neon');
    expect(el?.className).not.toContain('is-speaking');
    rerender(
      <SpeakingFrame frame="neon" speaking size={76}>
        <span />
      </SpeakingFrame>,
    );
    expect(container.firstElementChild?.className).toContain('is-speaking');
    rerender(
      <SpeakingFrame frame={null} speaking size={76}>
        <span />
      </SpeakingFrame>,
    );
    expect(container.firstElementChild?.className).not.toContain('avatar-frame');
  });
});

describe('"Stream <game>" suggestion', () => {
  const inVoice = () => useVoiceStore.setState({ status: 'connected', channelId: VOICE });
  const game = { name: 'PowerWash Simulator 2', steamAppId: 1290000, startedAt: new Date().toISOString(), icon: null };

  it('appears only when a game is detected and we are in voice; opens the picker with the window preselected', async () => {
    setLanguage('en');
    const { rerender } = render(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Stream PowerWash/)).toBeNull(); // not in voice: no dock at all
    act(() => {
      inVoice();
      useLocalGame.setState({ info: null });
    });
    rerender(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText(/Stream PowerWash/)).toBeNull(); // no game
    act(() => useLocalGame.setState({ info: game }));
    findGameSource.mockResolvedValue('window:1234:0');
    fireEvent.click(screen.getByLabelText('Stream PowerWash Simulator 2'));
    await vi.waitFor(() => expect(useUiStore.getState().sourcePickerOpen).toBe(true));
    // Preselected, but nothing started: the picker waits for "Share".
    expect(useUiStore.getState().sourcePickerPreselect).toBe('window:1234:0');
    expect(useVoiceStore.getState().localScreenSharing).toBe(false);
  });

  it('window not found -> the normal picker without a preselection', async () => {
    inVoice();
    useLocalGame.setState({ info: game });
    findGameSource.mockResolvedValue(null);
    render(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText(/PowerWash Simulator 2/));
    await vi.waitFor(() => expect(useUiStore.getState().sourcePickerOpen).toBe(true));
    expect(useUiStore.getState().sourcePickerPreselect).toBeNull();
  });
});

describe('interface gradient themes', () => {
  it('applies live as an attribute on <html>, persists, and survives a restart', () => {
    useSettingsStore.getState().update({ uiTheme: 'sunset' });
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('sunset');
    const stored = JSON.parse(localStorage.getItem('aidis.settings') ?? '{}') as { uiTheme?: string };
    expect(stored.uiTheme).toBe('sunset');
    // "Restart": settings are read back from storage and sanitized.
    expect(sanitizeSettings(stored as never).uiTheme).toBe('sunset');
    expect(sanitizeSettings({ uiTheme: 'hotpink' as never }).uiTheme).toBe('default');
    useSettingsStore.getState().update({ uiTheme: 'default' });
    expect(document.documentElement.hasAttribute('data-ui-theme')).toBe(false);
  });
});
