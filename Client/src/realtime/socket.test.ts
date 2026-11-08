import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useVoiceStore } from '../voice/voiceStore';
import { alice, bob, general, makeMessage } from '../test/fixtures';
import { useReadStore } from '../stores/readStore';
import { useStatusStore } from '../stores/statusStore';

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, Handler[]>();
  connected = false;
  active = true;
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
    this.connected = false;
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

describe('realtime client', () => {
  beforeEach(() => {
    realtime.disconnect();
    sockets.length = 0;
    useChatStore.getState().reset();
    usePresenceStore.getState().reset();
    usePresenceStore.getState().setUsers([alice, bob]);
    useAuthStore.setState({ status: 'authenticated', user: alice });
    useReadStore.getState().reset();
    useStatusStore.setState({ status: 'ONLINE' });
    useChatStore.setState({
      channels: [general],
      byChannel: { [general.id]: { messages: [], hasMore: false, hasNewer: false, loadingNewer: false, status: 'ready', loadingOlder: false, error: null } },
    });
  });

  it('creates exactly one socket and binds each listener once', () => {
    realtime.connect();
    realtime.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.handlers.get('message.created')).toHaveLength(1);
  });

  it('keeps unread DM messages and mentions when DND suppresses notifications', () => {
    const dm = { ...general, id: 'dm-dnd', type: 'DM' as const, memberIds: [alice.id, bob.id] };
    useChatStore.setState({ dms: [dm] });
    useStatusStore.setState({ status: 'DND' });
    realtime.connect();
    sockets[0]!.fire('message.created', makeMessage({ author: bob, channelId: dm.id, mentions: [alice.id] }));
    expect(useReadStore.getState().reads[dm.id]).toMatchObject({ unread: 1, mentions: 1 });
  });

  it('applies profile updates (new avatar) for other users and for ourselves, once', () => {
    realtime.connect();
    const socket = sockets[0]!;
    expect(socket.handlers.get('user.updated')).toHaveLength(1);
    socket.fire('user.updated', { ...bob, avatarAttachmentId: 'bbbbbbbb-0000-4000-8000-000000000001', displayName: 'Bobby' });
    expect(usePresenceStore.getState().users[bob.id]).toMatchObject({ displayName: 'Bobby', avatarAttachmentId: 'bbbbbbbb-0000-4000-8000-000000000001' });
    socket.fire('user.updated', { ...alice, avatarAttachmentId: 'aaaaaaaa-0000-4000-8000-000000000002' });
    expect(useAuthStore.getState().user?.avatarAttachmentId).toBe('aaaaaaaa-0000-4000-8000-000000000002');
    // Reconnect does not add a second listener.
    realtime.disconnect();
    realtime.connect();
    expect(sockets.at(-1)!.handlers.get('user.updated')).toHaveLength(1);
  });

  it('applies message, presence and typing events to the stores', () => {
    realtime.connect();
    const socket = sockets[0]!;
    socket.fire('connect');
    expect(useConnectionStore.getState().socket).toBe('connected');

    socket.fire('ready', { user: alice, presence: [{ userId: bob.id, status: 'offline', lastSeenAt: null }] });
    socket.fire('presence.updated', { userId: bob.id, status: 'online', lastSeenAt: new Date().toISOString() });
    expect(usePresenceStore.getState().presence[bob.id]?.status).toBe('online');

    socket.fire('typing.started', { channelId: general.id, userId: bob.id, expiresInMs: 8000 });
    expect(useChatStore.getState().typing[general.id]?.[bob.id]).toBeDefined();

    const message = makeMessage({ author: bob, content: 'from bob' });
    socket.fire('message.created', message);
    socket.fire('message.created', message); // duplicate delivery after reconnect
    expect(useChatStore.getState().byChannel[general.id]!.messages).toHaveLength(1);
    expect(useChatStore.getState().typing[general.id]?.[bob.id]).toBeUndefined();

    socket.fire('message.updated', { ...message, content: 'edited', edited: true });
    expect(useChatStore.getState().byChannel[general.id]!.messages[0]!.content).toBe('edited');

    socket.fire('message.deleted', { id: message.id, channelId: general.id, deletedAt: new Date().toISOString() });
    expect(useChatStore.getState().byChannel[general.id]!.messages).toHaveLength(0);
  });

  it('shows reconnecting state and ignores own typing', () => {
    realtime.connect();
    const socket = sockets[0]!;
    socket.fire('connect');
    socket.fire('disconnect', 'transport close');
    expect(useConnectionStore.getState().socket).toBe('reconnecting');
    socket.fire('typing.started', { channelId: general.id, userId: alice.id, expiresInMs: 8000 });
    expect(useChatStore.getState().typing[general.id]).toBeUndefined();
  });

  it('logs out when the server revokes the session', () => {
    const handle = vi.fn();
    useAuthStore.setState({ handleAuthFailure: handle });
    realtime.connect();
    sockets[0]!.fire('session.revoked', { reason: 'revoked_by_admin' });
    expect(handle).toHaveBeenCalledWith('revoked_by_admin');
  });

  it('tracks who is deafened (snapshot + live changes) and re-sends our own state after a reconnect', () => {
    realtime.connect();
    const socket = sockets[0]!;
    expect(socket.handlers.get('voice.state')).toHaveLength(1);
    socket.fire('voice.states', { deafened: [bob.id] });
    expect(useVoiceStore.getState().deafenedUsers).toEqual({ [bob.id]: true });
    socket.fire('voice.state', { userId: bob.id, deafened: false });
    expect(useVoiceStore.getState().deafenedUsers).toEqual({});
    socket.fire('voice.state', { userId: bob.id, deafened: true });
    socket.fire('voice.state', { userId: bob.id, deafened: true }); // duplicate: no change
    expect(useVoiceStore.getState().deafenedUsers).toEqual({ [bob.id]: true });

    socket.connected = true;
    const on = { deafened: true, muted: true, screen: false, camera: false };
    const off = { deafened: false, muted: false, screen: false, camera: false };
    realtime.setVoiceState(on);
    realtime.setVoiceState({ ...on }); // unchanged: sent once
    expect(socket.emitted).toEqual([['voice.state', on]]);
    socket.emitted.length = 0;
    socket.fire('ready', { user: alice, presence: [] }); // reconnected: the server forgot it
    expect(socket.emitted).toEqual([['voice.state', on]]);
    realtime.setVoiceState(off);
    expect(socket.emitted.at(-1)).toEqual(['voice.state', off]);
  });

  it('sends idle and the game activity once, again after a reconnect, and keeps them per device', () => {
    realtime.connect();
    const socket = sockets[0]!;
    socket.connected = true;
    realtime.setIdle(true);
    realtime.setActivity('Helldivers 2');
    realtime.setActivity('Helldivers 2');
    expect(socket.emitted).toEqual([
      ['presence.idle', { idle: true }],
      ['activity.set', { name: 'Helldivers 2' }],
    ]);
    socket.emitted.length = 0;
    socket.fire('ready', { user: alice, presence: [] });
    expect(socket.emitted).toEqual([
      ['presence.idle', { idle: true }],
      ['activity.set', { name: 'Helldivers 2' }],
    ]);
    realtime.setActivity(null);
    realtime.setIdle(false);
    expect(socket.emitted.slice(-2)).toEqual([
      ['activity.set', { name: null }],
      ['presence.idle', { idle: false }],
    ]);
  });

  it('keeps the last known lastSeenAt when an update does not carry one', () => {
    realtime.connect();
    const socket = sockets[0]!;
    socket.fire('presence.updated', { userId: bob.id, status: 'offline', state: 'offline', lastSeenAt: '2026-10-05T10:00:00.000Z' });
    socket.fire('presence.updated', { userId: bob.id, status: 'online', state: 'dnd', lastSeenAt: null });
    expect(usePresenceStore.getState().presence[bob.id]).toMatchObject({ state: 'dnd', lastSeenAt: '2026-10-05T10:00:00.000Z' });
  });

  it('sends typing only while connected and cleans up on disconnect', () => {
    realtime.connect();
    const socket = sockets[0]!;
    realtime.emitTyping(general.id, true);
    expect(socket.emitted).toHaveLength(0);
    socket.connected = true;
    realtime.emitTyping(general.id, true);
    expect(socket.emitted).toEqual([['typing.start', { channelId: general.id }]]);
    realtime.disconnect();
    expect(socket.handlers.size).toBe(0);
    expect(useConnectionStore.getState().socket).toBe('idle');
  });
});
