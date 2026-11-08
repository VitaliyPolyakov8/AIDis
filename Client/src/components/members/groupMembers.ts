import type { MemberView, RoleView } from '../../api/types';

export interface MemberGroup {
  /** null = online people without a displayed role. */
  role: RoleView | null;
  members: MemberView[];
}

/**
 * Discord-like member list: online people under their highest "display separately" (hoist) role,
 * groups in role order, then everyone else online, then all offline people.
 */
export function groupMembers(members: readonly MemberView[], roles: readonly RoleView[], isOnline: (userId: string) => boolean, nameOf: (member: MemberView) => string): { groups: MemberGroup[]; offline: MemberView[] } {
  const hoisted = roles.filter((r) => r.hoist && !r.isEveryone).sort((a, b) => b.position - a.position);
  const byRole = new Map<string, MemberView[]>(hoisted.map((r) => [r.id, []]));
  const rest: MemberView[] = [];
  const offline: MemberView[] = [];
  for (const m of members) {
    if (!isOnline(m.userId)) {
      offline.push(m);
      continue;
    }
    const top = hoisted.find((r) => m.roleIds.includes(r.id));
    if (top) byRole.get(top.id)?.push(m);
    else rest.push(m);
  }
  const sort = (list: MemberView[]) => list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const groups: MemberGroup[] = hoisted.map((role) => ({ role, members: sort(byRole.get(role.id) ?? []) })).filter((g) => g.members.length > 0);
  if (rest.length > 0) groups.push({ role: null, members: sort(rest) });
  return { groups, offline: sort(offline) };
}
