import { describe, expect, it } from 'vitest';
import { buildOverlayState } from './overlayFeed';
import { useVoiceStore, INITIAL_VOICE_STATE } from '../voice/voiceStore';
import { usePresenceStore } from '../stores/presenceStore';
import { alice, bob, games, GUILD_ID, makeGuild } from '../test/fixtures';
import { useGuildStore } from '../stores/guildStore';
import { useChatStore } from '../stores/chatStore';

describe('overlay feed', () => {
  it('mirrors the call: names, fast speaking flags, mute and deafen (own deafen is local)', () => {
    usePresenceStore.setState({ users: { [alice.id]: alice, [bob.id]: { ...bob, displayName: 'Bobby' } } });
    useVoiceStore.setState({
      ...INITIAL_VOICE_STATE,
      status: 'connected',
      channelId: 'vc1',
      deafened: true,
      micEnabled: false,
      deafenedUsers: { [bob.id]: true },
      participants: [
        { identity: alice.id, name: 'alice', isLocal: true, isSpeaking: false, micMuted: true, screenSharing: false },
        { identity: bob.id, name: 'bob', isLocal: false, isSpeaking: true, micMuted: false, screenSharing: false },
      ],
    });
    const state = buildOverlayState();
    expect(state).toMatchObject({ inCall: true, micEnabled: false, deafened: true });
    expect(state.participants).toEqual([
      expect.objectContaining({ id: alice.id, name: 'Alice', isSelf: true, micMuted: true, deafened: true, speaking: false, initials: 'A' }),
      expect.objectContaining({ id: bob.id, name: 'Bobby', isSelf: false, deafened: true, speaking: true, avatar: null }),
    ]);
  });

  it('0.7.0: shows the server nickname of the call channel', () => {
    const voiceChannel = { ...games, type: 'VOICE' as const };
    usePresenceStore.setState({ users: { [alice.id]: alice, [bob.id]: bob } });
    useChatStore.setState({ channels: [voiceChannel] });
    useGuildStore.setState({
      guilds: [makeGuild()],
      byGuild: {
        [GUILD_ID]: {
          channels: [voiceChannel],
          roles: [],
          members: [{ userId: bob.id, roleIds: [], joinedAt: '2026-01-01T00:00:00.000Z', nickname: 'Бобби на сервере', avatarAttachmentId: null, bannerAttachmentId: null, bio: null }],
          rolesLoaded: true,
          membersLoaded: true,
        },
      },
    });
    useVoiceStore.setState({
      ...INITIAL_VOICE_STATE,
      status: 'connected',
      channelId: voiceChannel.id,
      participants: [{ identity: bob.id, name: 'bob', isLocal: false, isSpeaking: false, micMuted: false, screenSharing: false }],
    });
    expect(buildOverlayState().participants[0]).toMatchObject({ name: 'Бобби на сервере', initials: 'БС' });
    useGuildStore.getState().reset();
  });

  it('is empty outside a call', () => {
    useVoiceStore.setState({ ...INITIAL_VOICE_STATE });
    expect(buildOverlayState()).toMatchObject({ inCall: false, participants: [] });
  });

  it('marks only canonical stream viewers, and clears the eye when they stop watching', () => {
    useVoiceStore.setState({
      ...INITIAL_VOICE_STATE,
      status: 'connected',
      participants: [
        { identity: alice.id, name: 'Alice', isLocal: true, isSpeaking: false, micMuted: false, screenSharing: true },
        { identity: bob.id, name: 'Bob', isLocal: false, isSpeaking: false, micMuted: false, screenSharing: false },
      ],
      streamViewers: { [alice.id]: [bob.id] },
    });
    expect(buildOverlayState().participants.find((p) => p.id === bob.id)?.watching).toBe(true);
    expect(buildOverlayState().participants.find((p) => p.id === alice.id)?.watching).toBe(false);
    useVoiceStore.setState({ streamViewers: {} });
    expect(buildOverlayState().participants.find((p) => p.id === bob.id)?.watching).toBe(false);
  });
});
