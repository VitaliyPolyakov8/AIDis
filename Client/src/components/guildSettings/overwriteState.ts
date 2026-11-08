import { CHANNEL_PERMISSIONS, type OverwriteView, type Permission } from '../../api/types';

/** One permission in a channel overwrite: allowed, denied, or as the role / category says. */
export type OverwriteState = 'allow' | 'inherit' | 'deny';

/** Only channel permissions (server CHANNEL_SCOPED); missing = inherit. */
export type OverwriteMap = Partial<Record<Permission, 'allow' | 'deny'>>;

const scoped = (p: Permission) => CHANNEL_PERMISSIONS.includes(p);

export function fromOverwrite(o: Pick<OverwriteView, 'allow' | 'deny'> | undefined): OverwriteMap {
  const map: OverwriteMap = {};
  if (!o) return map;
  for (const p of o.allow) if (scoped(p)) map[p] = 'allow';
  // Allow wins if a permission is in both (the server stores it that way).
  for (const p of o.deny) if (scoped(p) && !map[p]) map[p] = 'deny';
  return map;
}

export function toPayload(map: OverwriteMap): { allow: Permission[]; deny: Permission[] } {
  const allow: Permission[] = [];
  const deny: Permission[] = [];
  for (const p of CHANNEL_PERMISSIONS) {
    if (map[p] === 'allow') allow.push(p);
    else if (map[p] === 'deny') deny.push(p);
  }
  return { allow, deny };
}

export const stateOf = (map: OverwriteMap, p: Permission): OverwriteState => map[p] ?? 'inherit';

export function withState(map: OverwriteMap, p: Permission, state: OverwriteState): OverwriteMap {
  if (!scoped(p)) return map;
  const next = Object.fromEntries(Object.entries(map).filter(([k]) => k !== p)) as OverwriteMap;
  if (state !== 'inherit') next[p] = state;
  return next;
}

export function cycle(state: OverwriteState): OverwriteState {
  return state === 'inherit' ? 'allow' : state === 'allow' ? 'deny' : 'inherit';
}

/** Nothing set: the overwrite is removed instead of saved. */
export const isEmpty = (map: OverwriteMap) => Object.keys(map).length === 0;

export function sameMap(a: OverwriteMap, b: OverwriteMap): boolean {
  const pa = toPayload(a);
  const pb = toPayload(b);
  return pa.allow.join() === pb.allow.join() && pa.deny.join() === pb.deny.join();
}
