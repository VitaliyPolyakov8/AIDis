import { create } from 'zustand';
import type { DesktopGameInfo } from './contract';

/**
 * 0.4.1: the game detected on THIS PC (desktop app only), with its local executable icon.
 * Used for the "Stream <game>" suggestion and our own profile card. What is published to others
 * is decided in integration.ts (respecting "Display current game" and hidden games).
 */
export const useLocalGame = create<{ info: DesktopGameInfo | null }>(() => ({ info: null }));
