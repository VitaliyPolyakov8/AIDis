import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';
import { useGuildStore } from '../stores/guildStore';
import { useUiStore } from '../stores/uiStore';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { guildsApi } from '../api/guilds';
import type { Channel, MyGuildView } from '../api/types';
import { alice, bob } from '../test/fixtures';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  connected = false;
  active = false;
  emitted: [string, unknown][] = [];
  io = { removeAllListeners: vi.fn(), reconnection: vi.fn() };
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.emitted.push([event, payload]);
    return this;
  }
  connect() {
    return this;
  }
  disconnect() {
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}
const sockets: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));
const { realtime } = await import('./socket');

const guild = (id: string): MyGuildView => ({
  id,
  name: id,
  iconAttachmentId: null,
  bannerAttachmentId: null,
  ownerId: 'o',
  systemChannelId: null,
  defaultNotifyMode: 'ALL',
  memberCount: 2,
  createdAt: 'x',
  me: { member: true, permissions: [], roleIds: [], notifyMode: null, railPosition: null, profile: { nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null } },
});
const voiceChannel: Channel = { id: 'v-a', guildId: 'a', type: 'VOICE', name: 'v', description: null, position: 0, createdAt: 'x', parentId: null, permissionsSynced: true };

describe('realtime 0.7.0 events', () => {
  let socket: FakeSocket;
  beforeEach(() => {
    vi.restoreAllMocks();
    realtime.disconnect();
    sockets.length = 0;
    useChatStore.getState().reset();
    useGuildStore.getState().reset();
    usePresenceStore.getState().setUsers([alice, bob]);
    useAuthStore.setState({ status: 'authenticated', user: alice });
    useUiStore.setState({ updateRequired: false });
    useGuildStore.setState({ guilds: [guild('a'), guild('b')], activeGuildId: 'a', byGuild: { a: { channels: [voiceChannel], roles: [], members: [], rolesLoaded: true, membersLoaded: true } } });
    realtime.connect();
    socket = sockets[0] as FakeSocket;
  });

  it('removes a server I was kicked from and leaves its voice channel', () => {
    useVoiceStore.setState({ status: 'connected', channelId: 'v-a' });
    const leave = vi.spyOn(voice, 'leave').mockResolvedValue();
    socket.fire('guild.member.removed', { guildId: 'a', userId: alice.id, reason: 'kicked' });
    expect(useGuildStore.getState().guilds.map((g) => g.id)).toEqual(['b']);
    expect(useGuildStore.getState().activeGuildId).toBeNull();
    expect(leave).toHaveBeenCalled();
  });

  it('only drops the member when someone else leaves', () => {
    useGuildStore.getState().applyMember('a', { userId: bob.id, joinedAt: 'x', roleIds: [], nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null });
    socket.fire('guild.member.removed', { guildId: 'a', userId: bob.id, reason: 'left' });
    expect(useGuildStore.getState().guilds).toHaveLength(2);
    expect(useGuildStore.getState().byGuild.a?.members).toEqual([]);
  });

  it('reloads the channels of the server named in channels.changed only', () => {
    const channels = vi.spyOn(guildsApi, 'channels').mockResolvedValue({ channels: [] });
    socket.fire('channels.changed', { scope: 'channels', guildId: 'b' });
    expect(channels).toHaveBeenCalledTimes(1);
    expect(channels).toHaveBeenCalledWith('b');
  });

  it('stops reconnecting and asks for an update on CLIENT_OUTDATED', () => {
    vi.useFakeTimers();
    try {
      socket.fire('connect_error', Object.assign(new Error('Update AIDis to continue'), { data: { code: 'CLIENT_OUTDATED' } }));
      expect(useUiStore.getState().updateRequired).toBe(true);
      vi.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a server mute aimed at me', () => {
    const apply = vi.spyOn(voice, 'applyServerState').mockImplementation(() => undefined);
    socket.fire('voice.server_state', { guildId: 'a', userId: alice.id, muted: true, deafened: false });
    expect(apply).toHaveBeenCalledWith('a', { muted: true, deafened: false });
    expect(useVoiceStore.getState().serverStates[`a:${alice.id}`]).toEqual({ muted: true, deafened: false });
  });
});
