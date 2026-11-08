import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { alice, bob, general, makeMessage } from './test/fixtures';
import { GameActivityCard } from './components/profile/GameArt';
import { Composer } from './components/chat/Composer';
import { ChannelSidebar } from './components/ChannelSidebar';
import { useChatStore } from './stores/chatStore';
import { useAuthStore } from './stores/authStore';
import { usePresenceStore } from './stores/presenceStore';
import { useReadStore } from './stores/readStore';
import { useStatusStore } from './stores/statusStore';

beforeEach(() => {
  useChatStore.getState().reset();
  useReadStore.getState().reset();
  useAuthStore.setState({ status: 'authenticated', user: alice });
  usePresenceStore.setState({ users: { [alice.id]: alice, [bob.id]: bob }, presence: {} });
  useStatusStore.setState({ status: 'DND' });
});

describe('0.5.93 profile and messages', () => {
  it('keeps profile game activity independent from library-card styles', () => {
    const { container } = render(<GameActivityCard activity={{ type: 'playing', name: 'Path of Exile', steamAppId: 238960, startedAt: new Date().toISOString() }} />);
    expect(container.querySelector('.profile-activity')).not.toHaveClass('game-card');
    expect(screen.getByText('Path of Exile')).toBeVisible();
  });

  it('explicitly enables native spelling in the message composer', () => {
    render(<Composer channel={general} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('spellcheck', 'true');
  });

  it('highlights unread DM rows and keeps a visible counter in DND', () => {
    const dm = { ...general, id: 'dm-0593', type: 'DM' as const, memberIds: [alice.id, bob.id] };
    useChatStore.setState({ dms: [dm], channels: [general], channelsLoaded: true });
    // 0.7.0: no server open = Home (DM list).
    const { container } = render(
      <MemoryRouter>
        <ChannelSidebar />
      </MemoryRouter>,
    );
    act(() => useReadStore.getState().onMessage(makeMessage({ channelId: dm.id, author: bob }), alice.id));
    const link = container.querySelector(`a[href="/channels/@me/${dm.id}"]`);
    expect(link).toHaveClass('is-unread');
    expect(link?.querySelector('.badge-unread')).toHaveTextContent('1');
    expect(container.querySelector('.guild-badge')).toHaveTextContent('1');
  });
});
