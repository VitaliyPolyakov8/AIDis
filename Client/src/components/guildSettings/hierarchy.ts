import type { RoleView } from '../../api/types';

/**
 * Role hierarchy as the server checks it (Server/src/permissions/resolve.ts topPosition / outranks):
 * a role or a member can be changed only from strictly above. The owner and the superadmin are
 * above everyone. Only shows or hides controls; the server decides.
 */
export function memberTop(roleIds: readonly string[], roles: readonly RoleView[]): number {
  let top = 0;
  for (const r of roles) if (!r.isEveryone && roleIds.includes(r.id) && r.position > top) top = r.position;
  return top;
}

export function myRank(guild: { ownerId: string; me: { roleIds: string[] } }, roles: readonly RoleView[], selfId: string | undefined, superadmin: boolean): number {
  if (superadmin || (selfId !== undefined && guild.ownerId === selfId)) return Infinity;
  return memberTop(guild.me.roleIds, roles);
}

/** @everyone is edited by anyone with MANAGE_ROLES; other roles only from above. */
export function canEditRole(role: RoleView, rank: number): boolean {
  return role.isEveryone || rank > role.position;
}

export function canActOnMember(member: { userId: string; roleIds: readonly string[] }, roles: readonly RoleView[], rank: number, selfId: string | undefined, ownerId: string): boolean {
  if (member.userId === selfId || member.userId === ownerId) return false;
  return rank > memberTop(member.roleIds, roles);
}
