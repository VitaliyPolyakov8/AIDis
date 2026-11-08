import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bob, general, makeMessage } from '../test/fixtures';
import type { ReadState } from '../api/types';

vi.mock('../api/channels', () => ({ channelsApi: { reads: vi.fn(), markRead: vi.fn(), setNotify: vi.fn() } }));
vi.mock('../api/messages', () => ({ messagesApi: { history: vi.fn() } }));
const { channelsApi } = await import('../api/channels');
const { messagesApi } = await import('../api/messages');
const { ApiError } = await import('../api/errors');
const { useReadStore } = await import('./readStore');

const first = makeMessage({ author: bob, createdAt: '2026-10-22T12:00:00.000Z' });
const second = makeMessage({ author: bob, createdAt: '2026-10-22T12:01:00.000Z' });
const initial: ReadState = { channelId: general.id, lastReadAt: '2026-10-22T11:00:00.000Z', unread: 1, mentions: 0, notifyMode: null };
const readAt = (lastReadAt: string): ReadState => ({ ...initial, lastReadAt, unread: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useReadStore.getState().reset();
  useReadStore.setState({ reads: { [general.id]: initial } });
  vi.mocked(channelsApi.markRead).mockResolvedValue({ read: readAt(first.createdAt) });
  vi.mocked(messagesApi.history).mockResolvedValue({ messages: [first], hasMore: false });
});
afterEach(() => {
  useReadStore.getState().reset();
  vi.useRealTimers();
});

describe('read acknowledgement persistence', () => {
  it('does not resurrect read messages from a delayed REST snapshot', async () => {
    const response = deferred<{ reads: ReadState[] }>();
    vi.mocked(channelsApi.reads).mockReturnValue(response.promise);
    const load = useReadStore.getState().load();
    useReadStore.getState().markRead(general.id, first);
    response.resolve({ reads: [initial] });
    await load;
    expect(useReadStore.getState().reads[general.id]).toMatchObject({ lastReadAt: first.createdAt, unread: 0 });
  });

  it('keeps genuinely newer unread messages when an older socket snapshot arrives', () => {
    useReadStore.getState().markRead(general.id, first);
    useReadStore.getState().onMessage(second, 'self');
    useReadStore.getState().apply(initial);
    expect(useReadStore.getState().reads[general.id]).toMatchObject({ lastReadAt: first.createdAt, unread: 1 });
  });

  it('retries an acknowledgement lost to a temporary network error', async () => {
    vi.mocked(channelsApi.markRead).mockRejectedValueOnce(ApiError.network());
    useReadStore.getState().markRead(general.id, first);
    await vi.advanceTimersByTimeAsync(400);
    expect(channelsApi.markRead).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(channelsApi.markRead).toHaveBeenCalledTimes(2);
    expect(useReadStore.getState().reads[general.id]?.unread).toBe(0);
  });

  it('serializes acknowledgements and saves the newest marker after the earlier request finishes', async () => {
    const response = deferred<{ read: ReadState }>();
    vi.mocked(channelsApi.markRead).mockReturnValueOnce(response.promise).mockResolvedValue({ read: readAt(second.createdAt) });
    useReadStore.getState().markRead(general.id, first);
    await vi.advanceTimersByTimeAsync(400);
    useReadStore.getState().markRead(general.id, second);
    await vi.advanceTimersByTimeAsync(400);
    expect(channelsApi.markRead).toHaveBeenCalledOnce();
    response.resolve({ read: readAt(first.createdAt) });
    await vi.advanceTimersByTimeAsync(400);
    expect(channelsApi.markRead).toHaveBeenLastCalledWith(general.id, second.id);
    expect(useReadStore.getState().reads[general.id]).toMatchObject({ lastReadAt: second.createdAt, unread: 0 });
  });

  it('ignores a response after logout/reset', async () => {
    const response = deferred<{ read: ReadState }>();
    vi.mocked(channelsApi.markRead).mockReturnValue(response.promise);
    useReadStore.getState().markRead(general.id, first);
    await vi.advanceTimersByTimeAsync(400);
    useReadStore.getState().reset();
    response.resolve({ read: readAt(first.createdAt) });
    await vi.advanceTimersByTimeAsync(0);
    expect(useReadStore.getState().reads).toEqual({});
  });

  it('keeps a newer unread mention that arrives while the read acknowledgement is in flight', async () => {
    const response = deferred<{ read: ReadState }>();
    vi.mocked(channelsApi.markRead).mockReturnValue(response.promise);
    useReadStore.getState().markRead(general.id, first);
    await vi.advanceTimersByTimeAsync(400);
    useReadStore.getState().onMessage({ ...second, mentions: ['self'] }, 'self');
    response.resolve({ read: readAt(first.createdAt) });
    await vi.advanceTimersByTimeAsync(0);
    expect(useReadStore.getState().reads[general.id]).toMatchObject({ lastReadAt: first.createdAt, unread: 1, mentions: 1 });
  });

  it('does not double count a locally observed message already included in the server snapshot', () => {
    useReadStore.getState().onMessage(second, 'self');
    useReadStore.getState().apply({ ...initial, unread: 2 });
    expect(useReadStore.getState().reads[general.id]?.unread).toBe(2);
  });

  it('does not count the same socket message twice', () => {
    useReadStore.getState().onMessage(second, 'self');
    useReadStore.getState().onMessage(second, 'self');
    expect(useReadStore.getState().reads[general.id]?.unread).toBe(2);
  });

  it('preserves an existing unread baseline plus a new mention across a delayed snapshot', async () => {
    const response = deferred<{ reads: ReadState[] }>();
    vi.mocked(channelsApi.reads).mockReturnValue(response.promise);
    useReadStore.setState({ reads: { [general.id]: { ...initial, mentions: 1 } } });
    const load = useReadStore.getState().load();
    useReadStore.getState().onMessage({ ...second, mentions: ['self'] }, 'self');
    response.resolve({ reads: [{ ...initial, mentions: 1 }] });
    await load;
    expect(useReadStore.getState().reads[general.id]).toMatchObject({ unread: 2, mentions: 2 });
  });

  it('reconciles deleted messages from a fresh authoritative snapshot', async () => {
    useReadStore.setState({ reads: { [general.id]: { ...initial, unread: 0 } } });
    useReadStore.getState().onMessage(second, 'self');
    vi.mocked(channelsApi.reads).mockResolvedValue({ reads: [{ ...initial, unread: 0 }] });
    await useReadStore.getState().load();
    expect(useReadStore.getState().reads[general.id]?.unread).toBe(0);
  });

  it('freezes mark-all at its original message when a lost response is retried after a new arrival', async () => {
    vi.mocked(channelsApi.markRead).mockRejectedValueOnce(ApiError.network());
    useReadStore.getState().markAllRead(general.id);
    await vi.advanceTimersByTimeAsync(400);
    useReadStore.getState().onMessage(second, 'self');
    await vi.advanceTimersByTimeAsync(2000);
    expect(channelsApi.markRead).toHaveBeenLastCalledWith(general.id, first.id);
    expect(messagesApi.history).toHaveBeenCalledOnce();
    expect(useReadStore.getState().reads[general.id]?.unread).toBe(1);
  });

  it('does not postpone persistence forever while messages keep arriving', async () => {
    for (let n = 0; n < 5; n += 1) {
      useReadStore.getState().markRead(general.id, { id: `message-${n}`, createdAt: new Date(Date.parse(first.createdAt) + n * 1000).toISOString() });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(channelsApi.markRead).toHaveBeenCalled();
  });
});
