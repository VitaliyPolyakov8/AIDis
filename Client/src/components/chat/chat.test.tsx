import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { MessageItem } from './MessageItem';
import { MenuHost } from '../menu/MenuHost';
import { Composer } from './Composer';
import { ChatView } from '../../pages/ChatView';
import { ChannelSidebar } from '../ChannelSidebar';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { messagesApi } from '../../api/messages';
import { alice, bob, games, general, GUILD_ID, makeGuild, makeMessage } from '../../test/fixtures';
import { useGuildStore } from '../../stores/guildStore';

vi.mock('../../api/messages', () => ({
  HISTORY_PAGE_SIZE: 50,
  messagesApi: { history: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn() },
}));
const api = vi.mocked(messagesApi);

beforeEach(() => {
  vi.resetAllMocks();
  useChatStore.getState().reset();
  useGuildStore.getState().reset();
  useChatStore.setState({ channels: [general, games], channelsLoaded: true });
  useAuthStore.setState({ status: 'authenticated', user: alice });
});

describe('MessageItem', () => {
  it('renders author, readable timestamp, text and edited marker', () => {
    const createdAt = new Date().toISOString();
    render(<MessageItem message={makeMessage({ content: 'Hello there', createdAt, edited: true, editedAt: createdAt })} grouped={false} isOwn canDelete />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText(/^Today at \d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
    expect(screen.queryByText(createdAt)).not.toBeInTheDocument();
  });

  it('renders message content as text, never as HTML', () => {
    const { container } = render(<MessageItem message={makeMessage({ content: '<img src=x onerror="alert(1)"><b>bold</b>' })} grouped={false} isOwn={false} canDelete={false} />);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)"><b>bold</b>')).toBeInTheDocument();
  });

  it('only offers edit on own messages; delete (in "More") for own or admin', async () => {
    const { rerender } = render(
      <>
        <MessageItem message={makeMessage({ author: bob })} grouped={false} isOwn={false} canDelete={false} />
        <MenuHost />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    rerender(
      <>
        <MessageItem message={makeMessage({ author: bob })} grouped={false} isOwn={false} canDelete />
        <MenuHost />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('edits with Enter and cancels with Escape', async () => {
    const message = makeMessage({ content: 'typo' });
    api.edit.mockResolvedValueOnce({ message: { ...message, content: 'fixed', edited: true } });
    render(<MessageItem message={message} grouped={false} isOwn canDelete />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect(box).toHaveValue('typo');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box2 = screen.getByRole('textbox', { name: 'Edit message' });
    await userEvent.clear(box2);
    await userEvent.type(box2, 'fixed{Enter}');
    expect(api.edit).toHaveBeenCalledWith(message.id, 'fixed');
  });

  it('asks for confirmation in a dialog before deleting', async () => {
    const message = makeMessage();
    api.remove.mockResolvedValueOnce(undefined);
    render(
      <>
        <MessageItem message={message} grouped={false} isOwn canDelete />
        <MenuHost />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete message' });
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(message.id));
  });
});

describe('Composer', () => {
  it('sends on Enter, inserts a newline on Shift+Enter, ignores whitespace-only input', async () => {
    useChatStore.setState({ byChannel: { [general.id]: { messages: [], hasMore: false, hasNewer: false, loadingNewer: false, status: 'ready', loadingOlder: false, error: null } } });
    api.send.mockImplementation((_c, input) => Promise.resolve({ message: makeMessage({ content: input.content, nonce: input.nonce }) }));
    render(<Composer channel={general} />);
    const input = screen.getByRole('textbox', { name: 'Message #general' });
    const send = screen.getByRole('button', { name: 'Send message' });

    expect(send).toBeDisabled();
    await userEvent.type(input, '   ');
    expect(send).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    expect(api.send).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(input).toHaveValue('line one\nline two');
    await userEvent.keyboard('{Enter}');

    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0]![1]).toMatchObject({ content: 'line one\nline two' });
    expect(input).toHaveValue('');
  });
});

describe('channel switching', () => {
  it('loads history for the selected channel and switches on click', async () => {
    api.history.mockImplementation((channelId) =>
      Promise.resolve({
        messages: [makeMessage({ channelId, content: channelId === general.id ? 'in general' : 'in games' })],
        hasMore: false,
      }),
    );
    useGuildStore.setState({ guilds: [makeGuild()], loaded: true, activeGuildId: GUILD_ID, byGuild: { [GUILD_ID]: { channels: [general, games], roles: [], members: [], rolesLoaded: true, membersLoaded: true } } });
    render(
      <MemoryRouter initialEntries={[`/channels/${GUILD_ID}/${general.id}`]}>
        <ChannelSidebar />
        <Routes>
          <Route path="/channels/:guildId/:channelId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('in general')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /games/ }));
    expect(await screen.findByText('in games')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'games' })).toBeInTheDocument();
    expect(api.history).toHaveBeenCalledWith(games.id, {}, 50, expect.any(AbortSignal));
    expect(useChatStore.getState().activeChannelId).toBe(games.id);
  });

  it('shows an empty state for a channel without messages', async () => {
    api.history.mockResolvedValueOnce({ messages: [], hasMore: false });
    render(
      <MemoryRouter initialEntries={[`/channels/${general.id}`]}>
        <Routes>
          <Route path="/channels/:channelId" element={<ChatView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('No messages yet. Start the conversation.')).toBeInTheDocument();
  });
});
