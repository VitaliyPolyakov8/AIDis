import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesApi } from '../api/messages';
import { ApiError } from '../api/errors';
import { prependPage, upsertMessage, useChatStore, type ChatMessage } from './chatStore';
import { alice, bob, games, general, makeMessage } from '../test/fixtures';

vi.mock('../api/messages', () => ({
  HISTORY_PAGE_SIZE: 50,
  messagesApi: { history: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn() },
}));

const api = vi.mocked(messagesApi);

beforeEach(() => {
  useChatStore.getState().reset();
  useChatStore.setState({ channels: [general, games], channelsLoaded: true });
  vi.resetAllMocks();
});

describe('message list helpers', () => {
  it('replaces an optimistic message when the server copy with the same nonce arrives', () => {
    const local: ChatMessage = { ...makeMessage({ id: 'local:abc', nonce: 'abc' }), localStatus: 'pending' };
    const server = makeMessage({ nonce: 'abc' });
    const result = upsertMessage([makeMessage(), local], server);
    expect(result.map((m) => m.id)).not.toContain('local:abc');
    expect(result.filter((m) => m.id === server.id)).toHaveLength(1);
  });

  it('keeps chronological order and never duplicates by id', () => {
    const a = makeMessage();
    const b = makeMessage();
    const c = makeMessage();
    let list = upsertMessage(upsertMessage([], c), a);
    list = upsertMessage(list, b);
    list = upsertMessage(list, b);
    expect(list.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  it('prepends older pages without duplicates', () => {
    const a = makeMessage();
    const b = makeMessage();
    const c = makeMessage();
    expect(prependPage([b, c], [a, b]).map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('chat store', () => {
  it('loads the latest page and older pages', async () => {
    const newer = [makeMessage(), makeMessage()];
    const older = [makeMessage({ createdAt: '2026-10-01T00:00:00.000Z' })];
    api.history.mockResolvedValueOnce({ messages: newer, hasMore: true }).mockResolvedValueOnce({ messages: older, hasMore: false });

    await useChatStore.getState().loadLatest(general.id);
    await useChatStore.getState().loadOlder(general.id);

    const state = useChatStore.getState().byChannel[general.id]!;
    expect(state.messages.map((m) => m.id)).toEqual([older[0]!.id, newer[0]!.id, newer[1]!.id]);
    expect(state.hasMore).toBe(false);
    expect(api.history).toHaveBeenLastCalledWith(general.id, { before: newer[0]!.id });
  });

  it('shows a sent message immediately and does not duplicate it when the realtime echo arrives', async () => {
    api.history.mockResolvedValueOnce({ messages: [], hasMore: false });
    await useChatStore.getState().loadLatest(general.id);

    let resolveSend: (value: { message: ReturnType<typeof makeMessage> }) => void = () => undefined;
    api.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const sending = useChatStore.getState().sendMessage(general.id, alice, 'hello');

    const pending = useChatStore.getState().byChannel[general.id]!.messages;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ content: 'hello', localStatus: 'pending' });
    const nonce = pending[0]!.nonce!;
    expect(api.send).toHaveBeenCalledWith(general.id, expect.objectContaining({ content: 'hello', nonce }));

    const saved = makeMessage({ content: 'hello', nonce });
    // Realtime event arrives before the HTTP response.
    useChatStore.getState().applyCreated(saved, alice.id);
    resolveSend({ message: saved });
    await sending;

    const messages = useChatStore.getState().byChannel[general.id]!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe(saved.id);
    expect(messages[0]!.localStatus).toBeUndefined();
  });

  it('marks a failed send and retries with the same nonce', async () => {
    api.history.mockResolvedValueOnce({ messages: [], hasMore: false });
    await useChatStore.getState().loadLatest(general.id);
    api.send.mockRejectedValueOnce(ApiError.network());
    await useChatStore.getState().sendMessage(general.id, alice, 'hi');

    const failed = useChatStore.getState().byChannel[general.id]!.messages[0]!;
    expect(failed.localStatus).toBe('failed');
    expect(failed.localError).toMatch(/reach the server/);

    api.send.mockResolvedValueOnce({ message: makeMessage({ content: 'hi', nonce: failed.nonce }) });
    await useChatStore.getState().retryMessage(general.id, failed.id);
    expect(api.send).toHaveBeenLastCalledWith(general.id, expect.objectContaining({ nonce: failed.nonce }));
    expect(useChatStore.getState().byChannel[general.id]!.messages[0]!.localStatus).toBeUndefined();
  });

  it('applies realtime edits and deletes', async () => {
    const m = makeMessage();
    api.history.mockResolvedValueOnce({ messages: [m], hasMore: false });
    await useChatStore.getState().loadLatest(general.id);

    useChatStore.getState().applyUpdated({ ...m, content: 'changed', edited: true, editedAt: new Date().toISOString() });
    expect(useChatStore.getState().byChannel[general.id]!.messages[0]).toMatchObject({ content: 'changed', edited: true });

    useChatStore.getState().applyDeleted({ id: m.id, channelId: general.id, deletedAt: new Date().toISOString() });
    expect(useChatStore.getState().byChannel[general.id]!.messages).toHaveLength(0);
  });

  it('marks other channels unread, but not for own messages', () => {
    useChatStore.getState().setActiveChannel(general.id);
    useChatStore.getState().applyCreated(makeMessage({ channelId: games.id, author: alice }), alice.id);
    expect(useChatStore.getState().unread[games.id]).toBeUndefined();
    useChatStore.getState().applyCreated(makeMessage({ channelId: games.id, author: bob }), alice.id);
    expect(useChatStore.getState().unread[games.id]).toBe(true);
    useChatStore.getState().setActiveChannel(games.id);
    expect(useChatStore.getState().unread[games.id]).toBe(false);
  });

  it('clears typing when that user posts', () => {
    useChatStore.getState().typingStarted(general.id, bob.id, 8000);
    expect(useChatStore.getState().typing[general.id]?.[bob.id]).toBeGreaterThan(Date.now());
    useChatStore.getState().applyCreated(makeMessage({ author: bob }), alice.id);
    expect(useChatStore.getState().typing[general.id]?.[bob.id]).toBeUndefined();
  });
});
