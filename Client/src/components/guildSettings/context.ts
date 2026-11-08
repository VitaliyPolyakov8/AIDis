import { useEffect, useMemo } from 'react';
import type { MyGuildView, Permission, RoleView } from '../../api/types';
import { useGuildMembers, useGuildRoles, useGuildStore } from '../../stores/guildStore';
import { useAuthStore } from '../../stores/authStore';
import { myRank } from './hierarchy';

export interface GuildContext {
  guild: MyGuildView;
  roles: RoleView[];
  /** Highest first (as shown). */
  rolesDesc: RoleView[];
  selfId: string | undefined;
  superadmin: boolean;
  owner: boolean;
  rank: number;
  has: (permission: Permission) => boolean;
}

/** Everything a settings section needs about the server (loads roles and members once). */
export function useGuildContext(guildId: string): GuildContext | null {
  const guild = useGuildStore((s) => s.guilds.find((g) => g.id === guildId) ?? null);
  const roles = useGuildRoles(guildId);
  const members = useGuildMembers(guildId);
  const selfId = useAuthStore((s) => s.user?.id);
  const superadmin = useAuthStore((s) => s.user?.role === 'ADMIN');

  useEffect(() => {
    const data = useGuildStore.getState().byGuild[guildId];
    if (!data?.rolesLoaded)
      void useGuildStore
        .getState()
        .refreshRoles(guildId)
        .catch(() => undefined);
    if (!data?.membersLoaded)
      void useGuildStore
        .getState()
        .refreshMembers(guildId)
        .catch(() => undefined);
  }, [guildId]);

  return useMemo(() => {
    if (!guild) return null;
    const permissions = new Set(guild.me.permissions);
    return {
      guild,
      roles,
      rolesDesc: [...roles].sort((a, b) => b.position - a.position),
      selfId,
      superadmin,
      owner: guild.ownerId === selfId,
      rank: myRank(guild, roles, selfId, superadmin),
      has: (p: Permission) => superadmin || permissions.has('ADMINISTRATOR') || permissions.has(p),
    };
    // members: re-render sections when the member list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild, roles, selfId, superadmin, members]);
}
