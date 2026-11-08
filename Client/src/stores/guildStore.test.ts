import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { guildsApi } from '../api/guilds';
import type { Channel, MemberView, MyGuildView, PublicUser, RoleView } from '../api/types';
import { memberDisplay, useGuildStore } from './guildStore';
import { useChatStore } from './chatStore';

const guild = (id: string, extra: Partial<MyGuildView> = {}): MyGuildView => ({
  id,
  name: id.toUpperCase(),
  iconAttachmentId: null,
  bannerAttachmentId: null,
  ownerId: 'owner',
  systemChannelId: null,
  defaultNotifyMode: 'ALL',
  memberCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  me: { member: true, permissions: ['VIEW_CHANNEL'], roleIds: [], notifyMode: null, railPosition: null, profile: { nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null } },
  ...extra,
});
const channel = (id: string, guildId: string, type: Channel['type'] = 'TEXT'): Channel => ({ id, guildId, type, name: id, description: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', parentId: null, permissionsSynced: true });
const role = (id: string, position: number, color: string | null): RoleView => ({ id, guildId: 'a', name: id, color, position, permissions: [], hoist: false, mentionable: false, isEveryone: position === 0, memberCount: 0 });
const member = (userId: string, extra: Partial<MemberView> = {}): MemberView => ({ userId, joinedAt: '2026-01-01T00:00:00.000Z', roleIds: [], nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null, ...extra });
const user = (id: string): PublicUser => ({ id, username: id, displayName: `Global ${id}`, avatarAttachmentId: 'global-avatar', role: 'USER', lastSeenAt: null, nicknameColor: '#ff0000' });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('guildStore', () => {
  beforeEach(() => {
    useGuildStore.getState().reset();
    useChatStore.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads servers with their channels and mirrors all channels into the chat store', async () => {
    vi.spyOn(guildsApi, 'list').mockResolvedValue({ guilds: [guild('a'), guild('b')] });
    vi.spyOn(guildsApi, 'channels').mockImplementation((id) => Promise.resolve({ channels: [channel(`${id}-text`, id)] }));
    await useGuildStore.getState().loadGuilds();
    expect(useGuildStore.getState().guilds.map((g) => g.id)).toEqual(['a', 'b']);
    expect(useGuildStore.getState().byGuild.b?.channels.map((c) => c.id)).toEqual(['b-text']);
    expect(useChatStore.getState().channels.map((c) => c.id).sort()).toEqual(['a-text', 'b-text']);
    expect(useGuildStore.getState().channelById('b-text')?.guildId).toBe('b');
  });

  it('keeps a slow answer of the previous server out of the one that is open now', async () => {
    vi.spyOn(guildsApi, 'list').mockResolvedValue({ guilds: [guild('a'), guild('b')] });
    vi.spyOn(guildsApi, 'channels').mockResolvedValue({ channels: [] });
    await useGuildStore.getState().loadGuilds();
    const slowRoles = deferred<{ roles: RoleView[] }>();
    vi.spyOn(guildsApi, 'roles').mockImplementation((id) => (id === 'a' ? slowRoles.promise : Promise.resolve({ roles: [role('b-role', 1, null)] })));
    vi.spyOn(guildsApi, 'members').mockResolvedValue({ members: [] });
    const openA = useGuildStore.getState().openGuild('a');
    await useGuildStore.getState().openGuild('b');
    slowRoles.resolve({ roles: [role('a-role', 1, null)] });
    await openA;
    const s = useGuildStore.getState();
    expect(s.activeGuildId).toBe('b');
    expect(s.byGuild.b?.roles.map((r) => r.id)).toEqual(['b-role']);
    expect(s.byGuild.a?.roles.map((r) => r.id)).toEqual(['a-role']);
  });

  it('forgets a server that is gone and leaves it', async () => {
    vi.spyOn(guildsApi, 'list').mockResolvedValue({ guilds: [guild('a')] });
    vi.spyOn(guildsApi, 'channels').mockResolvedValue({ channels: [channel('a-text', 'a')] });
    await useGuildStore.getState().loadGuilds();
    vi.spyOn(guildsApi, 'roles').mockResolvedValue({ roles: [] });
    vi.spyOn(guildsApi, 'members').mockResolvedValue({ members: [] });
    await useGuildStore.getState().openGuild('a');
    useGuildStore.getState().removeGuild('a');
    const s = useGuildStore.getState();
    expect(s.guilds).toEqual([]);
    expect(s.byGuild.a).toBeUndefined();
    expect(s.activeGuildId).toBeNull();
    expect(useChatStore.getState().channels).toEqual([]);
  });

  it('shows the server profile and the colour of the highest coloured role', () => {
    const roles = [role('everyone', 0, null), role('low', 1, '#00ff00'), role('high', 2, '#0000ff'), role('top-plain', 3, null)];
    const withRoles = memberDisplay(user('u1'), member('u1', { nickname: 'Лиса', roleIds: ['low', 'high', 'top-plain'] }), roles);
    expect(withRoles).toMatchObject({ name: 'Лиса', roleColor: '#0000ff', avatarAttachmentId: 'global-avatar' });
    const plain = memberDisplay(user('u2'), member('u2', { avatarAttachmentId: 'server-avatar' }), roles);
    expect(plain).toMatchObject({ name: 'Global u2', roleColor: null, avatarAttachmentId: 'server-avatar' });
    expect(memberDisplay(user('u3'), undefined, roles)).toMatchObject({ name: 'Global u3', roleColor: null });
  });

  it('returns the same channel list between renders when nothing changed', async () => {
    vi.spyOn(guildsApi, 'list').mockResolvedValue({ guilds: [guild('a')] });
    vi.spyOn(guildsApi, 'channels').mockResolvedValue({ channels: [channel('a-text', 'a')] });
    await useGuildStore.getState().loadGuilds();
    useGuildStore.setState({ activeGuildId: 'a' });
    const { result, rerender } = renderHook(() => useGuildStore((s) => s.byGuild[s.activeGuildId ?? '']?.channels));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
