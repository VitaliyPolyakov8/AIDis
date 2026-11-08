import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GameView } from '../api/types';
import { gamesApi } from './api';
import { GameShelf, forgetShelf } from './GameShelf';
import { MyGames } from './MyGames';
import { GamePromptHost } from './GamePrompt';
import { useServerConfig } from '../api/clientConfig';
import { useAuthStore } from '../stores/authStore';
import { alice } from '../test/fixtures';

const game = (over: Partial<GameView> = {}): GameView => ({
  id: 'g1',
  name: 'Hades',
  platform: 'PLAYSTATION',
  status: 'PLAYING',
  manual: true,
  steamAppId: null,
  totalSeconds: 7200,
  sessions: 3,
  firstPlayedAt: '2026-10-01T00:00:00.000Z',
  lastPlayedAt: '2026-11-01T00:00:00.000Z',
  coverAttachmentId: null,
  ...over,
});

describe('game tracker (client)', () => {
  beforeEach(() => {
    forgetShelf(alice.id);
    useAuthStore.setState({ status: 'authenticated', user: alice });
    useServerConfig.setState({ steamArt: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('the profile shelf shows statuses and platforms', async () => {
    vi.spyOn(gamesApi, 'list').mockResolvedValue({ games: [game(), game({ id: 'g2', name: 'Celeste', platform: 'PC', status: 'COMPLETED', manual: false })], hidden: false });
    render(<GameShelf userId={alice.id} isSelf />);
    expect(await screen.findByText('Hades')).toBeInTheDocument();
    expect(screen.getByText('Celeste')).toBeInTheDocument();
    expect(screen.getByText('Playing')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText(/PlayStation/)).toBeInTheDocument();
  });

  it('adds a game by hand (works without the desktop app) and shows it', async () => {
    const list = vi.spyOn(gamesApi, 'list').mockResolvedValue({ games: [], hidden: false });
    const add = vi.spyOn(gamesApi, 'add').mockResolvedValue(game({ id: 'g9', name: 'Zelda', platform: 'SWITCH', status: 'COMPLETED' }));
    render(<MyGames />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Add a game' }));
    await userEvent.type(screen.getByLabelText('Game'), 'Zelda');
    await userEvent.selectOptions(screen.getByLabelText('Platform'), 'SWITCH');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'COMPLETED');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(add).toHaveBeenCalledWith({ name: 'Zelda', platform: 'SWITCH', status: 'COMPLETED', coverAttachmentId: null });
    expect(await screen.findByText('Zelda')).toBeInTheDocument();
  });

  it('"How did it end?" sets the status and marks the game as asked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(gamesApi, 'prompts').mockResolvedValue({ games: [game()] });
    const update = vi.spyOn(gamesApi, 'update').mockResolvedValue(game({ status: 'COMPLETED' }));
    const prompted = vi.spyOn(gamesApi, 'prompted').mockResolvedValue(undefined);
    render(<GamePromptHost delayMs={10} />);
    expect(await screen.findByText('Hades: how did it end?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(update).toHaveBeenCalledWith('g1', { status: 'COMPLETED' });
    expect(prompted).toHaveBeenCalledWith('g1');
    await waitFor(() => expect(screen.queryByText('Hades: how did it end?')).not.toBeInTheDocument());
  });

  it('"Still playing" only marks the game as asked', async () => {
    vi.spyOn(gamesApi, 'prompts').mockResolvedValue({ games: [game()] });
    const update = vi.spyOn(gamesApi, 'update');
    const prompted = vi.spyOn(gamesApi, 'prompted').mockResolvedValue(undefined);
    render(<GamePromptHost delayMs={10} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Still playing' }));
    expect(prompted).toHaveBeenCalledWith('g1');
    expect(update).not.toHaveBeenCalled();
  });

  it('a hidden shelf is not shown to others', async () => {
    vi.spyOn(gamesApi, 'list').mockResolvedValue({ games: [], hidden: true });
    const { container } = render(<GameShelf userId="someone-else" isSelf={false} />);
    await waitFor(() => expect(gamesApi.list).toHaveBeenCalled());
    expect(container.querySelector('.game-shelf')).toBeNull();
  });
});
