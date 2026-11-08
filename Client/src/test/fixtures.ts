import type { Channel, Message, MyGuildView, Permission, PublicUser, TokenPair } from '../api/types';

export const alice: PublicUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  displayName: 'Alice',
  avatarAttachmentId: null,
  role: 'USER',
  lastSeenAt: null,
};

export const bob: PublicUser = { ...alice, id: '22222222-2222-4222-8222-222222222222', username: 'bob', displayName: 'Bob' };

export const general: Channel = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  type: 'TEXT',
  name: 'general',
  description: 'General chat',
  position: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  guildId: '99999999-9999-4999-8999-999999999999',
  parentId: null,
  permissionsSynced: true,
};

export const games: Channel = { ...general, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'games', position: 1 };

/** 0.7.0: the server that general / games belong to. */
export const GUILD_ID = '99999999-9999-4999-8999-999999999999';
export function makeGuild(permissions: Permission[] = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'], extra: Partial<MyGuildView> = {}): MyGuildView {
  return {
    id: GUILD_ID,
    name: 'AIDis',
    iconAttachmentId: null,
    bannerAttachmentId: null,
    ownerId: 'owner',
    systemChannelId: null,
    defaultNotifyMode: 'ALL',
    memberCount: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    me: { member: true, permissions, roleIds: [], notifyMode: null, railPosition: null, profile: { nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null } },
    ...extra,
  };
}

/** 0.7.0 tests: I am on the fixture server with these permissions (it is the open one). */
export async function setGuildPermissions(permissions: Permission[]): Promise<void> {
  const { useGuildStore } = await import('../stores/guildStore');
  const current = useGuildStore.getState().byGuild[GUILD_ID];
  useGuildStore.setState({
    guilds: [makeGuild(permissions)],
    loaded: true,
    activeGuildId: GUILD_ID,
    byGuild: { [GUILD_ID]: current ?? { channels: [general, games], roles: [], members: [], rolesLoaded: true, membersLoaded: true } },
  });
}

/** 0.7.0 tests: everyone in the presence store is a member of the open fixture server. */
export async function asServerMembers(): Promise<void> {
  const [{ useGuildStore }, { usePresenceStore }] = await Promise.all([import('../stores/guildStore'), import('../stores/presenceStore')]);
  const members = Object.keys(usePresenceStore.getState().users).map((userId) => ({
    userId,
    roleIds: [],
    joinedAt: '2026-10-01T00:00:00.000Z',
    nickname: null,
    avatarAttachmentId: null,
    bannerAttachmentId: null,
    bio: null,
  }));
  const current = useGuildStore.getState().byGuild[GUILD_ID];
  useGuildStore.setState({
    guilds: useGuildStore.getState().guilds.length > 0 ? useGuildStore.getState().guilds : [makeGuild()],
    loaded: true,
    activeGuildId: GUILD_ID,
    byGuild: { [GUILD_ID]: { channels: current?.channels ?? [general, games], roles: current?.roles ?? [], members, rolesLoaded: true, membersLoaded: true } },
  });
}

let seq = 0;
export function makeMessage(partial: Partial<Message> = {}): Message {
  seq += 1;
  const createdAt = partial.createdAt ?? new Date(Date.UTC(2026, 9, 5, 10, 0, seq)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    channelId: general.id,
    author: alice,
    content: `message ${seq}`,
    nonce: null,
    replyToId: null,
    attachments: [],
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    edited: false,
    ...partial,
  };
}

export function tokenPair(n = 1): TokenPair {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    refreshToken: `cccccccc-cccc-4ccc-8ccc-cccccccccccc.refresh-${n}`,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    tokenType: 'Bearer',
    sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    user: alice,
  };
}

export function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}
