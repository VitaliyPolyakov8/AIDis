import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { RoleDef, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { isPrintable, parseInput, sanitizeText } from '../common/validation.js';
import { cleanPermissions, PERMISSIONS, type Permission } from '../permissions/catalog.js';
import { outranks } from '../permissions/resolve.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { LimitsService } from '../limits/limits.service.js';

export interface RoleView {
  id: string;
  guildId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: Permission[];
  hoist: boolean;
  mentionable: boolean;
  /** The built-in @everyone role (cannot be deleted or renamed). */
  isEveryone: boolean;
  memberCount: number;
}

export interface BadgeView {
  id: string;
  key: string;
  label: string;
  icon: string;
  color: string;
}

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #rrggbb')
  .nullable();
const roleName = z.string().transform(sanitizeText).pipe(z.string().min(1).max(32).refine(isPrintable));
const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const createSchema = z.object({ name: roleName, color: color.optional(), permissions: permissionList.default([]), hoist: z.boolean().optional(), mentionable: z.boolean().optional() });
const updateSchema = z.object({ name: roleName.optional(), color: color.optional(), permissions: permissionList.optional(), hoist: z.boolean().optional(), mentionable: z.boolean().optional() });
const idsSchema = z.object({ roleIds: z.array(z.uuid()).max(100) });
const orderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(1000) });
const badgeIdsSchema = z.object({ badgeIds: z.array(z.uuid()).max(20) });

type RoleRow = RoleDef & { _count: { members: number } };

/**
 * Server roles (0.7.0). MANAGE_ROLES lets a member create roles and change / assign the roles BELOW
 * their own highest role, and never grant (or take away) a permission they do not have themselves.
 * The owner and the superadmin are above everyone.
 */
export class RolesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
    private readonly limits: LimitsService,
  ) {}

  private toView(role: RoleRow): RoleView {
    return {
      id: role.id,
      guildId: role.guildId,
      name: role.name,
      color: role.color,
      position: role.position,
      permissions: cleanPermissions(role.permissions),
      hoist: role.hoist,
      mentionable: role.mentionable,
      isEveryone: role.key === 'everyone',
      memberCount: role._count.members,
    };
  }

  async list(user: User, guildId: string): Promise<RoleView[]> {
    await this.permissions.requireGuild(user, guildId);
    const rows = await this.prisma.roleDef.findMany({ where: { guildId }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { _count: { select: { members: true } } } });
    return rows.map((r) => this.toView(r));
  }

  private async getRole(guildId: string, roleId: string): Promise<RoleRow> {
    const role = await this.prisma.roleDef.findUnique({ where: { id: roleId }, include: { _count: { select: { members: true } } } });
    if (role?.guildId !== guildId) throw Errors.notFound('Role');
    return role;
  }

  private async assertGrantable(actor: User, guildId: string, perms: readonly Permission[]): Promise<void> {
    const mine = await this.permissions.guildPermissions(actor, guildId);
    const missing = perms.filter((p) => !mine.has(p));
    if (missing.length > 0) throw Errors.forbidden(`You cannot grant permissions you do not have: ${missing.join(', ')}`);
  }

  /** The role must be strictly below the actor's highest role. */
  private async assertBelow(actor: User, guildId: string, role: Pick<RoleDef, 'position'>): Promise<void> {
    if (!outranks(await this.permissions.topPosition(actor, guildId), role.position)) throw Errors.forbidden('This role is not below your highest role');
  }

  async create(actor: User, guildId: string, input: unknown): Promise<RoleView> {
    await this.permissions.requireGuild(actor, guildId, 'MANAGE_ROLES');
    const data = parseInput(createSchema, input);
    await this.assertGrantable(actor, guildId, data.permissions);
    const count = await this.prisma.roleDef.count({ where: { guildId, key: null } });
    await this.limits.assertBelow('guild.roles', { guildId }, count);
    // Like Discord: a new role starts right above @everyone; every other role moves up by one.
    const role = await this.prisma.$transaction(async (tx) => {
      await tx.roleDef.updateMany({ where: { guildId, key: null }, data: { position: { increment: 1 } } });
      return tx.roleDef.create({
        data: { guildId, name: data.name, color: data.color ?? null, permissions: [...new Set(data.permissions)], position: 1, hoist: data.hoist ?? false, mentionable: data.mentionable ?? false },
        include: { _count: { select: { members: true } } },
      });
    });
    this.permissions.invalidateGuild(guildId);
    return this.toView(role);
  }

  async update(actor: User, guildId: string, roleId: string, input: unknown): Promise<{ before: RoleView; after: RoleView }> {
    await this.permissions.requireGuild(actor, guildId, 'MANAGE_ROLES');
    const data = parseInput(updateSchema, input);
    const current = await this.getRole(guildId, roleId);
    await this.assertBelow(actor, guildId, current);
    if (current.key === 'everyone' && data.name !== undefined) throw Errors.badRequest('ROLE_BUILT_IN', '@everyone cannot be renamed');
    if (data.permissions) {
      const had = cleanPermissions(current.permissions);
      const next: readonly Permission[] = data.permissions;
      const added = next.filter((p) => !had.includes(p));
      const removed = had.filter((p) => !next.includes(p));
      await this.assertGrantable(actor, guildId, [...added, ...removed]);
    }
    const updated = await this.prisma.roleDef.update({
      where: { id: roleId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.permissions !== undefined ? { permissions: [...new Set(data.permissions)] } : {}),
        ...(data.hoist !== undefined ? { hoist: data.hoist } : {}),
        ...(data.mentionable !== undefined ? { mentionable: data.mentionable } : {}),
      },
      include: { _count: { select: { members: true } } },
    });
    this.permissions.invalidateGuild(guildId);
    return { before: this.toView(current), after: this.toView(updated) };
  }

  async delete(actor: User, guildId: string, roleId: string): Promise<RoleView> {
    await this.permissions.requireGuild(actor, guildId, 'MANAGE_ROLES');
    const role = await this.getRole(guildId, roleId);
    if (role.key === 'everyone') throw Errors.conflict('ROLE_BUILT_IN', '@everyone cannot be deleted');
    await this.assertBelow(actor, guildId, role);
    await this.assertGrantable(actor, guildId, cleanPermissions(role.permissions));
    await this.prisma.$transaction(async (tx) => {
      await tx.roleDef.delete({ where: { id: roleId } });
      await tx.roleDef.updateMany({ where: { guildId, key: null, position: { gt: role.position } }, data: { position: { decrement: 1 } } });
    });
    this.permissions.invalidateGuild(guildId);
    return this.toView(role);
  }

  /**
   * New order of roles, from the lowest to the highest. Only roles below the actor move: they
   * keep the same set of position slots, re-assigned in the requested order.
   */
  async reorder(actor: User, guildId: string, input: unknown): Promise<void> {
    await this.permissions.requireGuild(actor, guildId, 'MANAGE_ROLES');
    const { ids } = parseInput(orderSchema, input);
    const top = await this.permissions.topPosition(actor, guildId);
    const roles = await this.prisma.roleDef.findMany({ where: { guildId, key: null }, orderBy: { position: 'asc' } });
    const movable = roles.filter((r) => outranks(top, r.position));
    const movableIds = new Set(movable.map((r) => r.id));
    const requested = [...new Set(ids)].filter((id) => movableIds.has(id));
    const ordered = [...requested, ...movable.filter((r) => !requested.includes(r.id)).map((r) => r.id)];
    const slots = movable.map((r) => r.position);
    await this.prisma.$transaction(ordered.map((id, i) => this.prisma.roleDef.update({ where: { id }, data: { position: slots[i] ?? 1 } })));
    this.permissions.invalidateGuild(guildId);
  }

  /** Replaces a member's roles (@everyone is implicit and never assigned). */
  async setMemberRoles(actor: User, guildId: string, userId: string, input: unknown): Promise<{ before: string[]; after: string[] }> {
    await this.permissions.requireGuild(actor, guildId, 'MANAGE_ROLES');
    const { roleIds } = parseInput(idsSchema, input);
    if (!(await this.permissions.isMember(userId, guildId))) throw Errors.notFound('Member');
    const wanted = [...new Set(roleIds)];
    const roles = await this.prisma.roleDef.findMany({ where: { id: { in: wanted }, guildId } });
    if (roles.length !== wanted.length || roles.some((r) => r.key === 'everyone')) throw Errors.badRequest('INVALID_ROLE', 'Unknown role');
    const top = await this.permissions.topPosition(actor, guildId);
    if (userId !== actor.id && !outranks(top, await this.permissions.memberTopPosition(userId, guildId))) throw Errors.forbidden('This member is not below you');
    const before = await this.permissions.roleIdsOf(userId, guildId);
    const changedIds = [...wanted.filter((id) => !before.includes(id)), ...before.filter((id) => !wanted.includes(id))];
    const changed = await this.prisma.roleDef.findMany({ where: { id: { in: changedIds } } });
    if (changed.some((r) => !outranks(top, r.position))) throw Errors.forbidden('You can only give or take roles below your highest role');
    await this.assertGrantable(
      actor,
      guildId,
      changed.flatMap((r) => cleanPermissions(r.permissions)),
    );
    await this.prisma.$transaction([this.prisma.guildMemberRole.deleteMany({ where: { guildId, userId } }), this.prisma.guildMemberRole.createMany({ data: wanted.map((roleId) => ({ guildId, userId, roleId })) })]);
    this.permissions.invalidateGuild(guildId);
    return { before, after: wanted };
  }

  async badges(): Promise<BadgeView[]> {
    const rows = await this.prisma.badge.findMany({ orderBy: { position: 'asc' } });
    return rows.map((b) => ({ id: b.id, key: b.key, label: b.label, icon: b.icon, color: b.color }));
  }

  /** Superadmin only (checked by the route). */
  async setUserBadges(userId: string, input: unknown): Promise<string[]> {
    const { badgeIds } = parseInput(badgeIdsSchema, input);
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('User');
    const found = await this.prisma.badge.findMany({ where: { id: { in: badgeIds } } });
    if (found.length !== new Set(badgeIds).size) throw Errors.badRequest('INVALID_BADGE', 'Unknown badge');
    await this.prisma.$transaction([this.prisma.userBadge.deleteMany({ where: { userId } }), this.prisma.userBadge.createMany({ data: found.map((b) => ({ userId, badgeId: b.id })) })]);
    return found.map((b) => b.key);
  }
}
