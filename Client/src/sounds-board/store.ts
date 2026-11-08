import { create } from 'zustand';
import type { SoundView, VoiceSoundEvent } from '../api/types';
import { realtime } from '../realtime/socket';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceStore } from '../voice/voiceStore';
import { soundsApi } from './api';
import { soundPlayer } from './player';

const NO_SOUNDS: SoundView[] = [];

interface SoundboardState {
  /** Loaded sound lists by server id. */
  byGuild: Record<string, SoundView[]>;
  /** When each person last played a sound (for the small badge on their tile). */
  lastPlayed: Record<string, number>;
  load: (guildId: string) => Promise<SoundView[]>;
  /** Press a sound in my voice channel: 'ok' or the server's refusal code. */
  play: (soundId: string) => Promise<string>;
  /** Realtime voice.sound: plays it when it is for my channel and I want to hear sounds. */
  heard: (event: VoiceSoundEvent) => void;
  /** Realtime sounds.changed: reload a list that is already loaded. */
  changed: (guildId: string) => void;
}

export const useSoundboardStore = create<SoundboardState>((set, get) => ({
  byGuild: {},
  lastPlayed: {},

  load: async (guildId) => {
    const { sounds } = await soundsApi.list(guildId);
    const before = get().byGuild[guildId] ?? NO_SOUNDS;
    for (const old of before) if (!sounds.some((s) => s.id === old.id)) soundPlayer.forget(old.id);
    set((s) => ({ byGuild: { ...s.byGuild, [guildId]: sounds } }));
    return sounds;
  },

  play: (soundId) => realtime.playSound(soundId),

  heard: (event) => {
    if (event.channelId !== useVoiceStore.getState().channelId) return;
    set((s) => ({ lastPlayed: { ...s.lastPlayed, [event.userId]: Date.now() } }));
    const settings = useSettingsStore.getState();
    if (settings.soundboardMuted || useVoiceStore.getState().deafened) return;
    const guildId = useChatStore.getState().channels.find((c) => c.id === event.channelId)?.guildId;
    const find = (list: SoundView[] | undefined) => list?.find((s) => s.id === event.soundId);
    const known = find(guildId ? get().byGuild[guildId] : Object.values(get().byGuild).flat());
    const start = (sound: SoundView | undefined) => {
      if (sound) void soundPlayer.play(sound).catch(() => undefined);
    };
    if (known || !guildId) {
      start(known);
      return;
    }
    void get()
      .load(guildId)
      .then(
        (list) => start(find(list)),
        () => undefined,
      );
  },

  changed: (guildId) => {
    if (get().byGuild[guildId])
      void get()
        .load(guildId)
        .catch(() => undefined);
  },
}));

/** The sounds of one server (stable empty list while not loaded). */
export function useGuildSounds(guildId: string | null | undefined): SoundView[] {
  return useSoundboardStore((s) => (guildId ? (s.byGuild[guildId] ?? NO_SOUNDS) : NO_SOUNDS));
}
