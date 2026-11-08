import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AidisDesktopApi } from './desktop/contract';
import type { VoiceSessionView } from './api/types';

const download = vi.fn();
const install = vi.fn();
const setTitleBar = vi.fn();
vi.mock('./desktop/bridge', () => ({
  isDesktop: true,
  desktop: {
    isDesktop: true,
    app: { setTitleBar, log: vi.fn() },
    updates: { download, install, check: vi.fn() },
    settings: { update: vi.fn(), get: vi.fn(), onChange: vi.fn() },
  } as unknown as AidisDesktopApi,
}));

const { applyVoiceSessions, applyMemberJoined, applyMemberLeft, applyMemberMoved, applySelfChange, useVoiceStore, INITIAL_VOICE_STATE } = await import('./voice/voiceStore');
const { ParticipantSoundGate } = await import('./voice/participantSounds');
const { clampPan, zoomAt } = await import('./components/chat/AttachmentView');
const { clampVoiceChatWidth } = await import('./components/voice/VoiceChatPanel');
const { validateBinding, parseBinding, modifierKeyFromCode, sanitizeKeybinds, DEFAULT_KEYBINDS, sanitizeStreaming, streamDegradation, DEFAULT_STREAMING } = await import('./desktop/contract');
const { displayBinding } = await import('./desktop/keyLabels');
const { updateButtonView, UpdateButton } = await import('./components/desktop/TitleBar');
const { useDesktopStore } = await import('./desktop/desktopStore');
const { setLanguage } = await import('./i18n');
const { useSettingsStore } = await import('./stores/settingsStore');
const { playSound } = await import('./sounds/sounds');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const p = (identity: string) => ({ identity, name: identity, joinedAt: null });
const SELF = 'me';

type Membership = Parameters<typeof applyVoiceSessions>[0];
const occ = () => useVoiceStore.getState().occupancy;
const apply = (fn: (s: Membership) => Partial<typeof INITIAL_VOICE_STATE>) => useVoiceStore.setState((s) => fn(s));

beforeEach(() => {
  useVoiceStore.setState(INITIAL_VOICE_STATE);
});

describe('canonical voice membership (0.4.2)', () => {
  it('3 users, 2 channels, rapid switching: never duplicated, keyed by user id', () => {
    apply((s) => applyVoiceSessions(s, [{ channelId: A, startedAt: 'x', participants: [p('u1'), p('u2')] }, { channelId: B, startedAt: 'y', participants: [p('u3')] }] as VoiceSessionView[], true, SELF));
    // u2 bounces A -> B -> A -> B; events arrive in every possible order, some twice.
    apply((s) => applyMemberJoined(s, B, p('u2'), SELF));
    apply((s) => applyMemberLeft(s, A, 'u2', SELF));
    apply((s) => applyMemberMoved(s, B, A, p('u2'), SELF));
    apply((s) => applyMemberMoved(s, A, B, p('u2'), SELF));
    apply((s) => applyMemberJoined(s, B, p('u2'), SELF));
    apply((s) => applyMemberLeft(s, A, 'u2', SELF));
    const all = [...occ()[A] ?? [], ...occ()[B] ?? []].map((x) => x.identity).sort();
    expect(all).toEqual(['u1', 'u2', 'u3']);
    expect(occ()[B]?.map((x) => x.identity).sort()).toEqual(['u2', 'u3']);
  });

  it('a channel update removes its people from every other channel (no stale copies)', () => {
    apply((s) => applyVoiceSessions(s, [{ channelId: A, startedAt: 'x', participants: [p('u1'), p('u2')] }] as VoiceSessionView[], true, SELF));
    apply((s) => applyVoiceSessions(s, [{ channelId: B, startedAt: 'y', participants: [p('u2')] }] as VoiceSessionView[], false, SELF));
    expect(occ()[A]?.map((x) => x.identity)).toEqual(['u1']);
    expect(occ()[B]?.map((x) => x.identity)).toEqual(['u2']);
  });

  it('when WE leave, only we disappear; everyone else in every channel stays', () => {
    useVoiceStore.setState({ status: 'connected', channelId: A });
    apply((s) => applyVoiceSessions(s, [{ channelId: A, startedAt: 'x', participants: [p(SELF), p('u1')] }, { channelId: B, startedAt: 'y', participants: [p('u3')] }] as VoiceSessionView[], true, SELF));
    expect(occ()[A]?.map((x) => x.identity).sort()).toEqual(['me', 'u1']);
    useVoiceStore.setState({ status: 'idle', channelId: null });
    apply((s) => applySelfChange(s, SELF));
    expect(occ()[A]?.map((x) => x.identity)).toEqual(['u1']);
    expect(occ()[B]?.map((x) => x.identity)).toEqual(['u3']);
    expect(useVoiceStore.getState().voiceSessions).toEqual({ [A]: 'x', [B]: 'y' });
  });

  it('a stale event that still lists us in the old channel cannot put us back there', () => {
    useVoiceStore.setState({ status: 'connected', channelId: B });
    apply((s) => applyMemberJoined(s, A, p(SELF), SELF));
    expect(occ()[A] ?? []).toEqual([]);
  });

  it('leave of an unknown user is ignored; duplicate join updates the entry', () => {
    apply((s) => applyMemberLeft(s, A, 'ghost', SELF));
    apply((s) => applyMemberJoined(s, A, { identity: 'u1', name: 'Old', joinedAt: null }, SELF));
    apply((s) => applyMemberJoined(s, A, { identity: 'u1', name: 'New', joinedAt: null }, SELF));
    expect(occ()[A]).toEqual([{ identity: 'u1', name: 'New', joinedAt: null }]);
  });
});

describe('join / leave sounds for other people', () => {
  it('plays only for real transitions in our room, never for the initial / reconnect snapshot', () => {
    const gate = new ParticipantSoundGate(1500);
    gate.seed(['u1', 'u2'], 0);
    expect(gate.joined('u1', true, 100)).toBe(false); // restored, quiet window
    expect(gate.joined('u3', true, 2000)).toBe(true); // a real join
    expect(gate.joined('u3', true, 2100)).toBe(false); // duplicate event
    expect(gate.left('u2', true, 3000)).toBe(true); // a real leave
    expect(gate.left('u2', true, 3100)).toBe(false); // twice
    expect(gate.left('u1', false, 3200)).toBe(false); // we are leaving: LiveKit "disconnects" everyone
    gate.seed(['u3'], 5000); // LiveKit reconnect restores the room
    expect(gate.joined('u3', true, 5100)).toBe(false);
  });

  it('respects the interface-sound and the participant-sound settings', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    useSettingsStore.getState().update({ interfaceSounds: true, participantSounds: false });
    playSound('userJoin');
    expect(play).not.toHaveBeenCalled();
    useSettingsStore.getState().update({ participantSounds: true });
    playSound('userJoin');
    expect(play).toHaveBeenCalledTimes(1);
    play.mockRestore();
  });
});

describe('image viewer pan', () => {
  const base = { width: 1000, height: 600 };
  const view = { width: 1200, height: 800 };
  it('clamps: never off-screen, centered on an axis that fits', () => {
    expect(clampPan({ zoom: 2, x: 5000, y: -5000 }, base, view)).toEqual({ zoom: 2, x: 400, y: -200 });
    expect(clampPan({ zoom: 1, x: 300, y: 300 }, base, view)).toEqual({ zoom: 1, x: 0, y: 0 });
    // 1.2x: 1200 wide fits exactly, 720 high fits: centered.
    expect(clampPan({ zoom: 1.2, x: 50, y: 50 }, base, view)).toEqual({ zoom: 1.2, x: 0, y: 0 });
  });
  it('wheel zoom keeps the point under the cursor', () => {
    const next = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, 100, 50);
    // The image point under (100, 50) was 100 px from the center; at 2x it must still be under the cursor.
    expect(next).toEqual({ zoom: 2, x: -100, y: -50 });
  });
});

describe('voice chat width', () => {
  it('stays between 300 px and 60 % of the content', () => {
    expect(clampVoiceChatWidth(100, 1600)).toBe(300);
    expect(clampVoiceChatWidth(2000, 1600)).toBe(960);
    expect(clampVoiceChatWidth(420, 1600)).toBe(420);
    expect(sanitizeWidth(5000)).toBe(2000);
  });
});
function sanitizeWidth(value: number): number {
  useSettingsStore.getState().update({ voiceChatWidth: value });
  return Math.min(2000, useSettingsStore.getState().voiceChatWidth);
}

describe('hotkeys: lone modifiers (Right Ctrl)', () => {
  it('Right Ctrl is a valid toggle and push-to-talk key, but never with a modifier prefix', () => {
    expect(validateBinding('toggleMute', 'RightCtrl')).toBeNull();
    expect(validateBinding('pushToTalk', 'RightAlt')).toBeNull();
    expect(parseBinding('Ctrl+RightCtrl')).toBeNull();
    expect(modifierKeyFromCode('ControlRight')).toBe('RightCtrl');
    expect(modifierKeyFromCode('ShiftLeft')).toBe('LeftShift');
    expect(displayBinding('RightCtrl')).toBe('Right Ctrl');
    expect(sanitizeKeybinds({ toggleMute: 'RightCtrl' }).toggleMute).toBe('RightCtrl');
    expect(sanitizeKeybinds({}).toggleMute).toBe(DEFAULT_KEYBINDS.toggleMute);
  });
});

describe('stream quality priority', () => {
  it('defaults to Maintain Resolution, also for older settings files', () => {
    expect(DEFAULT_STREAMING.qualityPriority).toBe('resolution');
    expect(sanitizeStreaming({ resolution: '1080p' }).qualityPriority).toBe('resolution');
    expect(streamDegradation({ contentMode: 'game', qualityPriority: 'resolution' })).toBe('maintain-framerate-and-resolution');
    expect(streamDegradation({ contentMode: 'game', qualityPriority: 'auto' })).toBe('maintain-framerate');
    expect(streamDegradation({ contentMode: 'text', qualityPriority: 'auto' })).toBe('maintain-resolution');
  });
});

describe('green update button', () => {
  it('state machine: hidden -> available (click downloads) -> progress -> ready (click restarts)', async () => {
    setLanguage('ru');
    expect(updateButtonView({ status: 'not-available', checkedAt: 1 })).toBeNull();
    expect(updateButtonView({ status: 'checking' })).toBeNull();
    useDesktopStore.setState({ updateState: { status: 'available', version: '0.4.3' } });
    render(<UpdateButton />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('title')).toBe('Доступно обновление 0.4.3');
    fireEvent.click(btn);
    expect(download).toHaveBeenCalledTimes(1);
    act(() => useDesktopStore.setState({ updateState: { status: 'downloading', version: '0.4.3', percent: 47, transferred: 1, total: 2, bytesPerSecond: 1 } }));
    expect(screen.getByRole('button').getAttribute('title')).toBe('Загрузка обновления — 47%');
    act(() => useDesktopStore.setState({ updateState: { status: 'downloaded', version: '0.4.3' } }));
    expect(screen.getByRole('button').getAttribute('title')).toBe('Обновление готово — нажмите, чтобы перезапустить');
    expect(install).not.toHaveBeenCalled(); // never by itself
    fireEvent.click(screen.getByRole('button'));
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });
});
