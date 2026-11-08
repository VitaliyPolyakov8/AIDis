import { PERMISSIONS, type Permission } from './catalog.js';

/** Pure permission math (0.7.0), in Discord's order. No database access here. */

export interface RoleInput {
  id: string;
  position: number;
  permissions: readonly Permission[];
  isEveryone: boolean;
}

export interface OverwriteInput {
  targetType: 'ROLE' | 'MEMBER';
  targetId: string;
  allow: readonly Permission[];
  deny: readonly Permission[];
}

export interface MemberContext {
  userId: string;
  roleIds: readonly string[];
  isOwner: boolean;
  isSuperadmin: boolean;
}

const VOICE_NEEDS_CONNECT: readonly Permission[] = ['SPEAK', 'STREAM', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_USERS', 'DISCONNECT_USERS'];
const TEXT_NEEDS_SEND: readonly Permission[] = ['ATTACH_FILES', 'EMBED_LINKS', 'MENTION_EVERYONE', 'SEND_TTS', 'SEND_VOICE_MESSAGES'];

function all(): Set<Permission> {
  return new Set(PERMISSIONS);
}

function isAlmighty(member: MemberContext): boolean {
  return member.isOwner || member.isSuperadmin;
}

/** @everyone + all of the member's roles (server-wide). ADMINISTRATOR / owner / superadmin = everything. */
export function basePermissions(member: MemberContext, roles: readonly RoleInput[]): Set<Permission> {
  if (isAlmighty(member)) return all();
  const mine = new Set(member.roleIds);
  const out = new Set<Permission>();
  for (const role of roles) {
    if (role.isEveryone || mine.has(role.id)) for (const p of role.permissions) out.add(p);
  }
  return out.has('ADMINISTRATOR') ? all() : out;
}

/** Effective permissions in one channel, given the overwrites that apply to it (its own or its category's when synced). */
export function channelPermissions(member: MemberContext, roles: readonly RoleInput[], overwrites: readonly OverwriteInput[], channelType: 'TEXT' | 'VOICE' | 'CATEGORY'): Set<Permission> {
  const perms = basePermissions(member, roles);
  if (perms.has('ADMINISTRATOR')) return perms;

  const everyoneId = roles.find((r) => r.isEveryone)?.id;
  const mine = new Set(member.roleIds);
  const apply = (deny: Iterable<Permission>, allow: Iterable<Permission>) => {
    for (const p of deny) perms.delete(p);
    for (const p of allow) perms.add(p);
  };

  const everyone = overwrites.find((o) => o.targetType === 'ROLE' && o.targetId === everyoneId);
  if (everyone) apply(everyone.deny, everyone.allow);

  const roleDeny = new Set<Permission>();
  const roleAllow = new Set<Permission>();
  for (const o of overwrites) {
    if (o.targetType !== 'ROLE' || o.targetId === everyoneId || !mine.has(o.targetId)) continue;
    for (const p of o.deny) roleDeny.add(p);
    for (const p of o.allow) roleAllow.add(p);
  }
  apply(roleDeny, roleAllow);

  const own = overwrites.find((o) => o.targetType === 'MEMBER' && o.targetId === member.userId);
  if (own) apply(own.deny, own.allow);

  if (!perms.has('VIEW_CHANNEL')) return new Set();
  if (channelType === 'VOICE' && !perms.has('CONNECT_VOICE')) for (const p of VOICE_NEEDS_CONNECT) perms.delete(p);
  if (channelType === 'TEXT' && !perms.has('SEND_MESSAGES')) for (const p of TEXT_NEEDS_SEND) perms.delete(p);
  return perms;
}

/** The member's highest role position (owner / superadmin: Infinity, no roles: 0 = @everyone). */
export function topPosition(member: MemberContext, roles: readonly RoleInput[]): number {
  if (isAlmighty(member)) return Infinity;
  const mine = new Set(member.roleIds);
  let top = 0;
  for (const role of roles) if (!role.isEveryone && mine.has(role.id) && role.position > top) top = role.position;
  return top;
}

/** Strictly higher in the hierarchy (equal positions cannot act on each other). */
export function outranks(actorTop: number, targetTop: number): boolean {
  return actorTop > targetTop;
}
