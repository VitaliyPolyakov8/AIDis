import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alice, bob, general, makeMessage } from '../test/fixtures';
import type { Channel } from '../api/types';

const shell = vi.hoisted(() => ({
  notifications: { toast: vi.fn(), show: vi.fn() },
  overlay: { pushMessage: vi.fn() },
}));
vi.mock('./bridge', () => ({ desktop: shell, isDesktop: true }));
vi.mock('../sounds/sounds', () => ({ playSound: vi.fn() }));
vi.mock('../android/native', () => ({ isAndroidApp: false }));

const { notifyNewMessage, shouldNotify } = await import('./notifications');
const { overlayMessage } = await import('./overlayFeed');
const { useAuthStore } = await import('../stores/authStore');
const { useChatStore } = await import('../stores/chatStore');
const { useReadStore } = await import('../stores/readStore');
const { useStatusStore } = await import('../stores/statusStore');
const { useVoiceStore, INITIAL_VOICE_STATE } = await import('../voice/voiceStore');
const { useDesktopStore } = await import('./desktopStore');
const { DEFAULT_DESKTOP_SETTINGS } = await import('./contract');
const { useLocalGame } = await import('./localGame');
const { playSound } = await import('../sounds/sounds');

const voiceChannel: Channel = { ...general, id: 'voice', type: 'VOICE', name: 'Voice' };
const otherVoice: Channel = { ...voiceChannel, id: 'other-voice' };
const dm: Channel = { ...general, id: 'dm', type: 'DM', memberIds: [alice.id, bob.id] };
const message = () => makeMessage({ author: bob, channelId: voiceChannel.id });
const join = () => useVoiceStore.setState({ status: 'connected', channelId: voiceChannel.id });
const play = () => useLocalGame.setState({ info: { name: 'Hades', steamAppId: 1145360, startedAt: '', icon: null } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  useAuthStore.setState({ status: 'authenticated', user: alice });
  useChatStore.getState().reset();
  useChatStore.setState({ channels: [general, voiceChannel, otherVoice], dms: [dm] });
  useReadStore.getState().reset();
  useStatusStore.setState({ status: 'ONLINE' });
  useVoiceStore.setState(INITIAL_VOICE_STATE);
  useDesktopStore.setState({ settings: structuredClone(DEFAULT_DESKTOP_SETTINGS) });
  useLocalGame.setState({ info: null });
});

describe('voice chat notifications', () => {
  it('does not notify voice messages or mentions while outside that call', () => {
    for (const mentions of [[], [alice.id]]) {
      const msg = { ...message(), mentions };
      expect(shouldNotify(msg, { ignoreFocus: true }).notify).toBe(false);
      notifyNewMessage(msg);
      overlayMessage(msg);
    }
    expect(shell.notifications.toast).not.toHaveBeenCalled();
    expect(shell.overlay.pushMessage).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });

  it('does not notify another voice channel while connected elsewhere', () => {
    join();
    const msg = makeMessage({ author: bob, channelId: otherVoice.id, mentions: [alice.id] });
    expect(shouldNotify(msg, { ignoreFocus: true }).notify).toBe(false);
  });

  it('keeps voice popups outside games', () => {
    join();
    notifyNewMessage(message());
    expect(shell.notifications.toast).toHaveBeenCalledOnce();
    expect(playSound).toHaveBeenCalledWith('notify');
  });

  it('delivers voice messages only to the overlay while gaming, including mentions', () => {
    join();
    play();
    const msg = { ...message(), mentions: [alice.id] };
    notifyNewMessage(msg);
    overlayMessage(msg);
    expect(shell.notifications.toast).not.toHaveBeenCalled();
    expect(shell.notifications.show).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
    expect(shell.overlay.pushMessage).toHaveBeenCalledWith(expect.objectContaining({ id: msg.id, channelId: voiceChannel.id }));
  });

  it('keeps current voice messages in the game overlay in DND, without a popup or sound', () => {
    join();
    play();
    useStatusStore.setState({ status: 'DND' });
    const msg = message();
    notifyNewMessage(msg);
    overlayMessage(msg);
    expect(shell.overlay.pushMessage).toHaveBeenCalledOnce();
    expect(shell.notifications.toast).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
    // Other channels still respect DND.
    overlayMessage(makeMessage({ author: bob, mentions: [alice.id] }));
    expect(shell.overlay.pushMessage).toHaveBeenCalledOnce();
  });

  it('keeps the routing while reconnecting to the same voice channel', () => {
    join();
    play();
    useVoiceStore.setState({ status: 'reconnecting' });
    useStatusStore.setState({ status: 'DND' });
    overlayMessage(message());
    expect(shell.overlay.pushMessage).toHaveBeenCalledOnce();
  });

  it('respects an explicitly disabled overlay and channel notifications', () => {
    join();
    play();
    useDesktopStore.setState({ settings: { ...DEFAULT_DESKTOP_SETTINGS, overlay: { ...DEFAULT_DESKTOP_SETTINGS.overlay, messageMode: 'off' } } });
    overlayMessage(message());
    expect(shell.overlay.pushMessage).not.toHaveBeenCalled();
    useDesktopStore.setState({ settings: DEFAULT_DESKTOP_SETTINGS });
    useReadStore.setState({ reads: { [voiceChannel.id]: { channelId: voiceChannel.id, lastReadAt: '', unread: 0, mentions: 0, notifyMode: 'NONE' } } });
    overlayMessage(message());
    expect(shell.overlay.pushMessage).not.toHaveBeenCalled();
  });

  it('preserves text and DM notifications outside voice and during games', () => {
    for (const channelId of [general.id, dm.id]) {
      notifyNewMessage(makeMessage({ author: bob, channelId }));
    }
    expect(shell.notifications.toast).toHaveBeenCalledTimes(2);
    join();
    play();
    notifyNewMessage(makeMessage({ author: bob, channelId: general.id, mentions: [alice.id] }));
    expect(shell.notifications.toast).toHaveBeenCalledTimes(3);
  });

  it('keeps text and DM unread indicators while DND blocks their sound, popup and overlay alert', () => {
    useStatusStore.setState({ status: 'DND' });
    for (const channelId of [general.id, dm.id]) {
      const msg = makeMessage({ author: bob, channelId, mentions: [alice.id] });
      useReadStore.getState().onMessage(msg, alice.id);
      notifyNewMessage(msg);
      overlayMessage(msg);
      expect(useReadStore.getState().reads[channelId]).toMatchObject({ unread: 1, mentions: 1 });
    }
    expect(shell.notifications.toast).not.toHaveBeenCalled();
    expect(shell.notifications.show).not.toHaveBeenCalled();
    expect(shell.overlay.pushMessage).not.toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();
  });
});
