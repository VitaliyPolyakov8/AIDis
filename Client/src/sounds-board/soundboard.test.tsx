import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Channel, SoundView } from '../api/types';
import { GUILD_ID, general, setGuildPermissions } from '../test/fixtures';
import { useChatStore } from '../stores/chatStore';
import { useGuildStore } from '../stores/guildStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceStore } from '../voice/voiceStore';
import { soundPlayer } from './player';
import { useSoundboardStore } from './store';
import { SoundboardButton } from './SoundboardButton';

const voiceChannel: Channel = { ...general, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'VOICE', name: 'General' };
const otherVoice: Channel = { ...voiceChannel, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Second' };
const sound: SoundView = { id: 'ssssssss-ssss-4sss-8sss-ssssssssssss', guildId: GUILD_ID, name: 'boom', emoji: '💥', volume: 100, durationMs: 1000, createdById: 'u', createdAt: '2026-11-07T00:00:00.000Z' };
const event = (channelId: string) => ({ channelId, soundId: sound.id, userId: 'someone' });

describe('0.7.1 soundboard', () => {
  let play: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await setGuildPermissions(['VIEW_CHANNEL', 'CONNECT_VOICE', 'USE_SOUNDBOARD']);
    useChatStore.setState({ channels: [general, voiceChannel, otherVoice] });
    useVoiceStore.setState({ channelId: voiceChannel.id, status: 'connected', deafened: false });
    useSettingsStore.getState().update({ soundboardMuted: false, soundboardVolume: 80 });
    useSoundboardStore.setState({ byGuild: { [GUILD_ID]: [sound] }, lastPlayed: {} });
    play = vi.spyOn(soundPlayer, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useVoiceStore.setState({ channelId: null, status: 'idle', deafened: false });
  });

  it('plays a sound pressed in my channel once, not one from another channel', () => {
    useSoundboardStore.getState().heard(event(voiceChannel.id));
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(sound);
    expect(useSoundboardStore.getState().lastPlayed.someone).toEqual(expect.any(Number));
    useSoundboardStore.getState().heard(event(otherVoice.id));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('stays silent while deafened or with "Do not play sounds"', () => {
    useVoiceStore.setState({ deafened: true });
    useSoundboardStore.getState().heard(event(voiceChannel.id));
    useVoiceStore.setState({ deafened: false });
    useSettingsStore.getState().update({ soundboardMuted: true });
    useSoundboardStore.getState().heard(event(voiceChannel.id));
    expect(play).not.toHaveBeenCalled();
  });

  it('loads the server list first when a sound is not known yet', async () => {
    useSoundboardStore.setState({ byGuild: {} });
    const load = vi.spyOn(useSoundboardStore.getState(), 'load').mockResolvedValue([sound]);
    useSoundboardStore.getState().heard(event(voiceChannel.id));
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith(sound));
    expect(load).toHaveBeenCalledWith(GUILD_ID);
  });

  it('the "Sounds" button needs USE_SOUNDBOARD in that channel', () => {
    const { unmount } = render(<SoundboardButton variant="control" />);
    expect(screen.getByRole('button', { name: 'Sounds' })).toBeInTheDocument();
    unmount();
    useGuildStore.setState({ channelPerms: { [voiceChannel.id]: ['VIEW_CHANNEL', 'CONNECT_VOICE'] } });
    render(<SoundboardButton variant="control" />);
    expect(screen.queryByRole('button', { name: 'Sounds' })).not.toBeInTheDocument();
  });

  it('settings keep the soundboard volume in 0..100 with 80 by default', () => {
    useSettingsStore.getState().update({ soundboardVolume: 80 });
    expect(useSettingsStore.getState().soundboardVolume).toBe(80);
  });
});
