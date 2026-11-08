import { create } from 'zustand';
import { rolesApi } from '../api/roles';
import type { BadgeView, Permission } from '../api/types';
import { guildPerm, useGuildPerm, useGuildStore } from './guildStore';

/**
 * Badge definitions (instance-wide). 0.7.0: permissions and roles are per server and live in the
 * guild store; useCan / can below answer for the server that is open. They only show or hide
 * controls: the server checks every action again.
 */
interface PermsStore {
  badges: BadgeView[];
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
}

export const usePermsStore = create<PermsStore>((set) => ({
  badges: [],
  loaded: false,
  load: async () => {
    const { badges } = await rolesApi.badges();
    set({ badges, loaded: true });
  },
  reset: () => set({ badges: [], loaded: false }),
}));

const NONE: Permission[] = [];

/** My permissions on the open server (stable reference). */
export function useMyPermissions(): Permission[] {
  return useGuildStore((s) => s.guilds.find((g) => g.id === s.activeGuildId)?.me.permissions ?? NONE);
}

export function useCan(permission: Permission, channelId?: string): boolean {
  return useGuildPerm(permission, channelId);
}

export function can(permission: Permission, channelId?: string): boolean {
  return guildPerm(permission, channelId);
}
