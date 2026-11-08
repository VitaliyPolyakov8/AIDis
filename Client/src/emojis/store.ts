import { create } from 'zustand';
import type { ServerEmoji } from '../api/types';
import { emojisApi } from './api';
import { clearEmojiImages, retainEmojiImages } from './images';

interface EmojiState {
  emojis: ServerEmoji[]; loaded: boolean; error: unknown; revision: number;
  load: () => Promise<void>; reset: () => void;
}
let sequence = 0;
export const useEmojiStore = create<EmojiState>(set => ({
  emojis: [], loaded: false, error: null, revision: 0,
  load: async () => {
    const request = ++sequence;
    try {
      const { emojis } = await emojisApi.list();
      if (request !== sequence) return;
      retainEmojiImages(new Set(emojis.map(e => e.id))); set(s => ({ emojis, loaded: true, error: null, revision: s.revision + 1 }));
    } catch (error) { if (request === sequence) set({ error, loaded: true }); }
  },
  reset: () => { sequence++; clearEmojiImages(); set({ emojis: [], loaded: false, error: null, revision: 0 }); },
}));
