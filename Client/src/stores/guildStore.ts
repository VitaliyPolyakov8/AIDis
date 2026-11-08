import { useMemo } from 'react';
import { create } from 'zustand';
import { guildsApi } from '../api/guilds';
import type { Channel, GuildView, MemberView, MyGuildView, Permission, PublicUser, RoleView } from '../api/types';
import { useChatStore } from './chatStore';
import { usePresenceStore } from './presenceStore';
import { useVoiceStore } from '../voice/voiceStore';

/** Everything that belongs to one server. Lists are replaced, never mutated (stable references). */
export interface GuildData {
  channels: Channel[];
  roles: RoleView[];
  members: MemberView[];
  rolesLoaded: boolean;
  membersLoaded: boolean;
}

interface GuildState {
  /** My servers, in my order (server list on the left). */
  guilds: MyGuildView[];
  loaded: boolean;
  /** null = Home (friends and DMs). */
  activeGuildId: string | null;
  byGuild: Record<string, GuildData>;
  /** channelId -> my permissions in that channel (loaded on demand). */
  channelPerms: Record<string, Permission[]>;

  loadGuilds: () => Promise<void>;
  openGuild: (guildId: string | null) => Promise<void>;
  refreshChannels: (guildId: string) => Promise<void>;
  refreshRoles: (guildId: string) => Promise<void>;
  refreshMembers: (guildId: string) => Promise<void>;
  refreshMe: (guildId: string) => Promise<void>;
  loadChannelPerms: (channelId: string) => Promise<void>;
  applyGuild: (view: GuildView | MyGuildView) => void;
  removeGuild: (guildId: string) => void;
  applyMember: (guildId: string, member: MemberView) => void;
  dropMember: (guildId: string, userId: string) => void;
  setOrder: (guildIds: string[]) => void;
  channelById: (channelId: string) => Channel | undefined;
  /** Optimistic drag & drop: new positions / categories before the server confirms (channels.changed). */
  applyChannelOrder: (guildId: string, items: { id: string; parentId: string | null; position: number }[]) => void;
  reset: () => void;
}

const EMPTY_DATA: GuildData = { channels: [], roles: [], members: [], rolesLoaded: false, membersLoaded: false };

function isMyView(view: GuildView | MyGuildView): view is MyGuildView {
  return 'me' in view;
}

export const useGuildStore = create<GuildState>((set, get) => {
  const patch = (guildId: string, next: Partial<GuildData>) => set((s) => ({ byGuild: { ...s.byGuild, [guildId]: { ...(s.byGuild[guildId] ?? EMPTY_DATA), ...next } } }));
  /** The chat store keeps one flat list of the channels of all my servers (lookups by id everywhere). */
  const mirrorChannels = () => {
    const all = Object.values(get().byGuild).flatMap((d) => d.channels);
    useChatStore.getState().setChannels(all);
  };

  return {
    guilds: [],
    loaded: false,
    activeGuildId: null,
    byGuild: {},
    channelPerms: {},

    loadGuilds: async () => {
      const { guilds } = await guildsApi.list();
      set({ guilds, loaded: true });
      const known = new Set(guilds.map((g) => g.id));
      set((s) => ({ byGuild: Object.fromEntries(Object.entries(s.byGuild).filter(([id]) => known.has(id))) }));
      await Promise.all(
        guilds.map((g) =>
          get()
            .refreshChannels(g.id)
            .catch(() => undefined),
        ),
      );
      mirrorChannels();
    },

    openGuild: async (guildId) => {
      set({ activeGuildId: guildId });
      if (!guildId) return;
      const data = get().byGuild[guildId];
      // Each answer is stored under the server it was asked for, so switching quickly never mixes them.
      await Promise.all([data?.rolesLoaded ? undefined : get().refreshRoles(guildId), data?.membersLoaded ? undefined : get().refreshMembers(guildId)]);
    },

    refreshChannels: async (guildId) => {
      const { channels } = await guildsApi.channels(guildId);
      if (!get().guilds.some((g) => g.id === guildId)) return;
      patch(guildId, { channels });
      set((s) => ({ channelPerms: Object.fromEntries(Object.entries(s.channelPerms).filter(([id]) => !channels.some((c) => c.id === id))) }));
      mirrorChannels();
    },

    refreshRoles: async (guildId) => {
      const { roles } = await guildsApi.roles(guildId);
      if (!get().guilds.some((g) => g.id === guildId)) return;
      patch(guildId, { roles, rolesLoaded: true });
    },

    refreshMembers: async (guildId) => {
      const { members } = await guildsApi.members(guildId);
      if (!get().guilds.some((g) => g.id === guildId)) return;
      patch(guildId, { members, membersLoaded: true });
      for (const m of members) usePresenceStore.getState().ensureUser(m.userId);
    },

    /** My permissions / roles on a server changed (roles.changed): re-read the server as I see it. */
    refreshMe: async (guildId) => {
      const { guild } = await guildsApi.get(guildId);
      get().applyGuild(guild);
      const channels = get().byGuild[guildId]?.channels ?? [];
      set((s) => ({ channelPerms: Object.fromEntries(Object.entries(s.channelPerms).filter(([id]) => !channels.some((c) => c.id === id))) }));
    },

    loadChannelPerms: async (channelId) => {
      const channel = get().channelById(channelId);
      if (!channel?.guildId) return;
      const { permissions } = await guildsApi.permissions(channel.guildId, channelId);
      set((s) => ({ channelPerms: { ...s.channelPerms, [channelId]: permissions } }));
    },

    applyGuild: (view) => {
      set((s) => {
        const index = s.guilds.findIndex((g) => g.id === view.id);
        if (index === -1) return isMyView(view) ? { guilds: [...s.guilds, view] } : {};
        const current = s.guilds[index];
        if (!current) return {};
        const next = isMyView(view) ? view : { ...current, ...view, me: current.me };
        const guilds = [...s.guilds];
        guilds[index] = next;
        return { guilds };
      });
    },

    removeGuild: (guildId) => {
      set((s) => {
        const byGuild = Object.fromEntries(Object.entries(s.byGuild).filter(([id]) => id !== guildId));
        return { guilds: s.guilds.filter((g) => g.id !== guildId), byGuild, activeGuildId: s.activeGuildId === guildId ? null : s.activeGuildId };
      });
      mirrorChannels();
    },

    applyMember: (guildId, member) => {
      const data = get().byGuild[guildId];
      if (!data) return;
      const exists = data.members.some((m) => m.userId === member.userId);
      patch(guildId, { members: exists ? data.members.map((m) => (m.userId === member.userId ? member : m)) : [...data.members, member] });
      usePresenceStore.getState().ensureUser(member.userId);
    },

    dropMember: (guildId, userId) => {
      const data = get().byGuild[guildId];
      if (!data) return;
      patch(guildId, { members: data.members.filter((m) => m.userId !== userId) });
    },

    setOrder: (guildIds) => {
      set((s) => {
        const rank = new Map(guildIds.map((id, i) => [id, i]));
        return { guilds: [...s.guilds].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)) };
      });
    },

    channelById: (channelId) => {
      for (const data of Object.values(get().byGuild)) {
        const found = data.channels.find((c) => c.id === channelId);
        if (found) return found;
      }
      return undefined;
    },

    applyChannelOrder: (guildId, items) => {
      const data = get().byGuild[guildId];
      if (!data) return;
      const byId = new Map(items.map((i) => [i.id, i]));
      patch(guildId, {
        channels: data.channels.map((c) => {
          const item = byId.get(c.id);
          return item ? { ...c, position: item.position, parentId: c.type === 'CATEGORY' ? null : item.parentId } : c;
        }),
      });
      mirrorChannels();
    },

    reset: () => set({ guilds: [], loaded: false, activeGuildId: null, byGuild: {}, channelPerms: {} }),
  };
});

const NO_CHANNELS: Channel[] = [];
const NO_ROLES: RoleView[] = [];
const NO_MEMBERS: MemberView[] = [];

export const useActiveGuild = () => useGuildStore((s) => s.guilds.find((g) => g.id === s.activeGuildId) ?? null);
export const useGuildChannels = (guildId: string | null) => useGuildStore((s) => (guildId ? (s.byGuild[guildId]?.channels ?? NO_CHANNELS) : NO_CHANNELS));
export const useGuildRoles = (guildId: string | null) => useGuildStore((s) => (guildId ? (s.byGuild[guildId]?.roles ?? NO_ROLES) : NO_ROLES));
export const useGuildMembers = (guildId: string | null) => useGuildStore((s) => (guildId ? (s.byGuild[guildId]?.members ?? NO_MEMBERS) : NO_MEMBERS));

/**
 * My permission on the active server (or in one of its channels when channelId is given and known).
 * The server decides; this only shows or hides controls.
 */
export function guildPerm(permission: Permission, channelId?: string): boolean {
  const s = useGuildStore.getState();
  if (channelId) {
    const inChannel = s.channelPerms[channelId];
    if (inChannel) return inChannel.includes(permission);
    const channel = s.channelById(channelId);
    if (channel?.guildId) return s.guilds.find((g) => g.id === channel.guildId)?.me.permissions.includes(permission) ?? false;
  }
  return s.guilds.find((g) => g.id === s.activeGuildId)?.me.permissions.includes(permission) ?? false;
}

export function useGuildPerm(permission: Permission, channelId?: string): boolean {
  return useGuildStore((s) => {
    if (channelId) {
      const inChannel = s.channelPerms[channelId];
      if (inChannel) return inChannel.includes(permission);
    }
    const guildId = channelId ? (s.channelById(channelId)?.guildId ?? s.activeGuildId) : s.activeGuildId;
    return s.guilds.find((g) => g.id === guildId)?.me.permissions.includes(permission) ?? false;
  });
}

export interface MemberDisplay {
  name: string;
  avatarAttachmentId: string | null;
  bannerAttachmentId: string | null;
  bio: string | null;
  /** Colour of the highest coloured role (replaces the personal name colour on that server), or null. */
  roleColor: string | null;
}

/** Server profile over the global one (spec §9); null fields fall back to the global profile. */
export function memberDisplay(user: PublicUser | undefined, member: MemberView | undefined, roles: readonly RoleView[]): MemberDisplay {
  let roleColor: string | null = null;
  let best = -1;
  if (member) {
    const mine = new Set(member.roleIds);
    for (const role of roles) {
      if (mine.has(role.id) && role.color && role.position > best) {
        best = role.position;
        roleColor = role.color;
      }
    }
  }
  return {
    name: member?.nickname || user?.displayName || user?.username || '…',
    avatarAttachmentId: member?.avatarAttachmentId ?? user?.avatarAttachmentId ?? null,
    bannerAttachmentId: member?.bannerAttachmentId ?? user?.bannerAttachmentId ?? null,
    bio: member?.bio ?? user?.bio ?? null,
    roleColor,
  };
}

/** How a person appears on a server (or globally when guildId is null: DMs, friends). */
export function useMemberDisplay(guildId: string | null, userId: string): MemberDisplay {
  const user = usePresenceStore((s) => s.users[userId]);
  const member = useGuildStore((s) => (guildId ? s.byGuild[guildId]?.members.find((m) => m.userId === userId) : undefined));
  const roles = useGuildRoles(guildId);
  return useMemo(() => memberDisplay(user, member, roles), [user, member, roles]);
}

/** Non-hook: how a person appears in a channel (its server's profile; global in DMs or unknown channels). */
export function displayInChannel(channelId: string | null | undefined, userId: string, fallback?: PublicUser): MemberDisplay {
  const user = usePresenceStore.getState().users[userId] ?? fallback;
  const s = useGuildStore.getState();
  const guildId = channelId ? s.channelById(channelId)?.guildId : null;
  const data = guildId ? s.byGuild[guildId] : undefined;
  return memberDisplay(
    user,
    data?.members.find((m) => m.userId === userId),
    data?.roles ?? NO_ROLES,
  );
}

/**
 * 0.7.0: server nicknames in a call (the channel's server; the current call when no channel is
 * given). DM calls and unknown channels keep the global name (the fallback).
 */
export function useCallNames(channelId?: string | null): (userId: string, fallback: string) => string {
  const callChannelId = useVoiceStore((s) => s.channelId);
  const id = channelId === undefined ? callChannelId : channelId;
  const guildId = useGuildStore((s) => (id ? (s.channelById(id)?.guildId ?? null) : null));
  const members = useGuildMembers(guildId);
  return useMemo(() => {
    const nick = new Map(members.filter((m) => m.nickname).map((m) => [m.userId, m.nickname as string]));
    return (userId: string, fallback: string) => nick.get(userId) ?? fallback;
  }, [members]);
}

/** 0.7.0: a person as shown in a channel (its server's profile; global in DMs). */
export function useChannelMemberDisplay(channelId: string, userId: string): MemberDisplay {
  const guildId = useGuildStore((s) => s.channelById(channelId)?.guildId ?? null);
  return useMemberDisplay(guildId, userId);
}
