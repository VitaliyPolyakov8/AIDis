import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AidisDesktopApi, DesktopAddServerResult, DesktopServer } from '../desktop/contract';

// Pretend to run inside AIDis Desktop (the bridge reads window.aidisDesktop at import time).
const server = (origin: string): DesktopServer => ({
  origin,
  name: new URL(origin).host,
  config: { serverVersion: '1.0.0', livekitUrl: `wss://rtc.${new URL(origin).host}`, voiceNodeDomain: new URL(origin).host, steamArt: true, minimumVersion: '', updateMirrorUrl: null },
});
const add = vi.fn<(address: string) => Promise<DesktopAddServerResult>>();
const current = vi.fn<() => Promise<DesktopServer | null>>();
const list = vi.fn<() => Promise<DesktopServer[]>>();
const select = vi.fn(() => Promise.resolve());
const remove = vi.fn(() => Promise.resolve());
vi.mock('../desktop/bridge', () => ({
  isDesktop: true,
  desktop: {
    isDesktop: true,
    servers: { add, current, list, select, remove },
    auth: { load: () => Promise.resolve(null), save: vi.fn(), clear: vi.fn() },
    settings: { get: () => Promise.reject(new Error('x')), onChange: vi.fn(), update: vi.fn() },
    app: { getInfo: () => Promise.resolve(null), relaunch: vi.fn(), openLogsFolder: vi.fn() },
    hotkeys: { getStatus: () => Promise.reject(new Error('x')), onStatus: vi.fn(), setCapturing: vi.fn() },
    updates: { getState: () => Promise.reject(new Error('x')), onState: vi.fn() },
    presence: { getDetectedGame: () => Promise.resolve(null), onActivity: () => () => undefined },
  } as unknown as AidisDesktopApi,
}));

const { ConnectPage } = await import('./ConnectPage');
const { ServerList } = await import('../components/settings/ServerList');
const { initDesktop, useDesktopStore } = await import('../desktop/desktopStore');
const { getApiOrigin, config } = await import('../config');
const { useServerConfig } = await import('../api/clientConfig');

describe('desktop app: which server', () => {
  beforeEach(() => {
    add.mockReset();
    select.mockClear();
    remove.mockClear();
  });

  it('starts pointed at the chosen server: API origin, LiveKit and the server settings', async () => {
    current.mockResolvedValue(server('https://chat.example.com'));
    list.mockResolvedValue([server('https://chat.example.com')]);
    await initDesktop();
    expect(useDesktopStore.getState()).toMatchObject({ needsServer: false, server: { origin: 'https://chat.example.com' } });
    expect(getApiOrigin()).toBe('https://chat.example.com');
    expect(config.livekitUrl).toBe('wss://rtc.chat.example.com');
    expect(useServerConfig.getState()).toMatchObject({ steamArt: true, voiceNodeDomain: 'chat.example.com', loaded: true });
  });

  it('first start: asks for the address and explains each refusal in plain words', async () => {
    render(<ConnectPage />);
    expect(screen.getByText('Connect to a server')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('alert')).toHaveTextContent('does not look like a site address');
    expect(add).not.toHaveBeenCalled();

    const cases: [Extract<DesktopAddServerResult, { ok: false }>['code'], string][] = [
      ['NOT_HTTPS', 'must use https://'],
      ['UNREACHABLE', 'does not answer'],
      ['NOT_AIDIS', 'it is not AIDis'],
    ];
    for (const [code, text] of cases) {
      add.mockResolvedValueOnce({ ok: false, code });
      await userEvent.clear(screen.getByLabelText('Server address'));
      await userEvent.type(screen.getByLabelText('Server address'), 'chat.example.com');
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
    }
    expect(add).toHaveBeenLastCalledWith('chat.example.com');
  });

  it('a broken bridge call reads as "does not answer", not a crash', async () => {
    add.mockRejectedValueOnce(new Error('ipc'));
    render(<ConnectPage />);
    await userEvent.type(screen.getByLabelText('Server address'), 'chat.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not answer');
  });

  it('settings: switch to another server, remove one only after confirming', async () => {
    useDesktopStore.setState({ server: server('https://a.example.com'), servers: [server('https://a.example.com'), server('https://b.example.com')] });
    render(<ServerList />);
    expect(screen.getByText(/current/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect(select).toHaveBeenCalledWith('https://b.example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Remove "b.example.com"' }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Your login there is forgotten/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledWith('https://b.example.com');
    await waitFor(() => expect(screen.queryByText('b.example.com')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add a server' }));
    expect(screen.getByLabelText('Server address')).toBeInTheDocument();
  });
});
