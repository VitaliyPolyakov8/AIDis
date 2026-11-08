import { act, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { alice, bob, general, makeMessage } from '../../test/fixtures';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore, EMPTY_CHANNEL } from '../../stores/chatStore';
import { useReadStore } from '../../stores/readStore';
import { MessageList } from './MessageList';

vi.mock('./MessageItem', () => ({ MessageItem: () => <div>Message</div> }));

const message = makeMessage({ author: bob });
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  useAuthStore.setState({ user: alice });
  useReadStore.getState().reset();
  useReadStore.setState({ reads: { [general.id]: { channelId: general.id, lastReadAt: message.createdAt, unread: 0, mentions: 0, notifyMode: null } } });
  useChatStore.setState({ byChannel: { [general.id]: { ...EMPTY_CHANNEL, status: 'ready', hasMore: false, messages: [message] } } });
});

it('marks a visible newest message read when its unread state arrives after the message list', () => {
  const mark = vi.spyOn(useReadStore.getState(), 'markRead').mockImplementation(() => undefined);
  render(<MessageList channel={general} />);
  expect(mark).not.toHaveBeenCalled();
  act(() => {
    useReadStore.setState({ reads: { [general.id]: { channelId: general.id, lastReadAt: '2026-10-01T00:00:00.000Z', unread: 1, mentions: 0, notifyMode: null } } });
  });
  expect(mark).toHaveBeenCalledWith(general.id, message);
});
