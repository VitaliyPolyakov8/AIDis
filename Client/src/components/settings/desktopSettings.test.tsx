import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_DESKTOP_SETTINGS, type AidisDesktopApi, type SettingsUpdateResult } from '../../desktop/contract';

// Pretend to run inside AIDis Desktop: the bridge module reads window.aidisDesktop at import time.
const update = vi.fn((patch: { keybinds?: Record<string, string | null> }): Promise<SettingsUpdateResult> => {
  const keybinds = { ...DEFAULT_DESKTOP_SETTINGS.keybinds, ...(patch.keybinds ?? {}) };
  return Promise.resolve({ ok: true, settings: { ...DEFAULT_DESKTOP_SETTINGS, keybinds } });
});
const setCapturing = vi.fn();
const updatesCheck = vi.fn();
const updatesInstall = vi.fn();
vi.mock('../../desktop/bridge', () => ({
  isDesktop: true,
  desktop: {
    isDesktop: true,
    settings: { update, get: vi.fn(), onChange: vi.fn() },
    hotkeys: { setCapturing },
    app: { relaunch: vi.fn(), openLogsFolder: vi.fn() },
    updates: { check: updatesCheck, install: updatesInstall },
  } as unknown as AidisDesktopApi,
}));

const { KeybindsSettings } = await import('./KeybindsSettings');
const { SettingsModal } = await import('./SettingsModal');
const { useDesktopStore } = await import('../../desktop/desktopStore');
const { UpdatePanel, UpdateBanner } = await import('../desktop/UpdatePanel');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('../../voice/voiceStore');

describe('keybind capture (desktop)', () => {
  beforeEach(() => {
    useDesktopStore.setState({ settings: DEFAULT_DESKTOP_SETTINGS });
    update.mockClear();
  });

  it('records a new combination with the global hotkeys paused', async () => {
    render(<KeybindsSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Change shortcut for Mute \/ unmute microphone/ }));
    expect(screen.getByText('Press a key combination…')).toBeInTheDocument();
    expect(setCapturing).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.keyDown(window, { code: 'KeyK', key: 'л', ctrlKey: true, shiftKey: true });
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith({ keybinds: { toggleMute: 'Ctrl+Shift+K' } });
    expect(setCapturing).toHaveBeenLastCalledWith(false);
  });

  it('shows a conflict instead of overriding the other action', () => {
    render(<KeybindsSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Change shortcut for Deafen \/ undeafen/ }));
    fireEvent.keyDown(window, { code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Already used by "Mute / unmute microphone"');
  });

  it('accepts a single key immediately, without waiting for a modifier', async () => {
    render(<KeybindsSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Change shortcut for Show \/ hide AIDis/ }));
    await act(async () => {
      fireEvent.keyDown(window, { code: 'F8' });
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith({ keybinds: { toggleWindow: 'F8' } });
  });

  it('refuses keys that would break typing everywhere', () => {
    render(<KeybindsSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Change shortcut for Show \/ hide AIDis/ }));
    fireEvent.keyDown(window, { code: 'Space' });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('already use');
  });

  it('lists the desktop sections in settings', () => {
    render(<SettingsModal />);
    for (const name of ['Streaming', 'Keybinds', 'Desktop']) expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  });
});

describe('update UI (desktop)', () => {
  it('shows real download progress and checks on request', () => {
    useDesktopStore.setState({
      updateState: { status: 'downloading', version: '0.2.0', percent: 42, transferred: 44_040_192, total: 104_857_600, bytesPerSecond: 2_097_152 },
    });
    render(<UpdatePanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Downloading version 0.2.0: 42%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42 of 100 MB · 2 MB/s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  });

  it('only installs when the user clicks, after leaving voice', async () => {
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE });
    useDesktopStore.setState({ updateState: { status: 'downloaded', version: '0.2.0' }, updateBannerDismissed: null });
    render(<UpdateBanner />);
    expect(screen.getByText('Update 0.2.0 is ready to install.')).toBeInTheDocument();
    expect(updatesInstall).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart and update' }));
    });
    expect(updatesInstall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('Update 0.2.0 is ready to install.')).toBeNull();
  });

  it('manual check calls the main process', () => {
    useDesktopStore.setState({ updateState: { status: 'not-available', checkedAt: 1 } });
    render(<UpdatePanel />);
    expect(screen.getByRole('status')).toHaveTextContent('You have the latest version.');
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(updatesCheck).toHaveBeenCalledTimes(1);
  });
});
