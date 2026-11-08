import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { Channel, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import { CHANNEL_SCOPED, cleanPermissions, PERMISSIONS, type Permission } from '../permissions/catalog.js';
import { outranks } from '../permissions/resolve.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { OverwriteView } from './channels.service.js';

const targetSchema = z.object({ channelId: z.uuid(), targetType: z.enum(['ROLE', 'MEMBER']), targetId: z.uuid() });
const bodySchema = z.object({ allow: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]), deny: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]) });

/**
 * 0.7.0 channel / category overwrites. Needs MANAGE_ROLES in that channel; only channel-scoped
 * permissions; never a permission the author does not have there; only for roles / members below
 * the author. Changing a synced channel first copies its category's overwrites (Discord behaviour).
 */
export class OverwritesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
  ) {}

  private async check(user: User, params: unknown, perms: readonly Permission[]): Promise<{ channel: Channel; targetType: 'ROLE' | 'MEMBER'; targetId: string }> {
    const { channelId, targetType, targetId } = parseInput(targetSchema, params);
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel?.guildId) throw Errors.notFound('Channel');
    const guildId = channel.guildId;
    await this.permissions.requireChannel(user, channel, 'MANAGE_ROLES');
    const outside = perms.filter((p) => !CHANNEL_SCOPED.has(p));
    if (outside.length > 0) throw Errors.badRequest('NOT_CHANNEL_PERMISSION', `Not a channel permission: ${outside.join(', ')}`);
    const mine = await this.permissions.channelPermissions(user, channel);
    const missing = perms.filter((p) => !mine.has(p));
    if (missing.length > 0) throw Errors.forbidden(`You cannot grant permissions you do not have: ${missing.join(', ')}`);
    const top = await this.permissions.topPosition(user, guildId);
    if (targetType === 'ROLE') {
      const role = await this.prisma.roleDef.findUnique({ where: { id: targetId } });
      if (role?.guildId !== guildId) throw Errors.badRequest('INVALID_ROLE', 'Unknown role');
      if (!outranks(top, role.position)) throw Errors.forbidden('This role is not below your highest role');
    } else {
      if (!(await this.permissions.isMember(targetId, guildId))) throw Errors.badRequest('NOT_A_MEMBER', 'Unknown member');
      if (targetId === user.id || !outranks(top, await this.permissions.memberTopPosition(targetId, guildId))) throw Errors.forbidden('This member is not below you');
    }
    return { channel, targetType, targetId };
  }

  /** Copies the category's overwrites into a synced channel and marks it as not synced. */
  private async desync(channel: Channel): Promise<void> {
    if (!channel.permissionsSynced) return;
    if (channel.parentId) {
      const parentOverwrites = await this.prisma.permissionOverwrite.findMany({ where: { channelId: channel.parentId } });
      await this.prisma.$transaction([
        this.prisma.permissionOverwrite.deleteMany({ where: { channelId: channel.id } }),
        this.prisma.permissionOverwrite.createMany({ data: parentOverwrites.map((o) => ({ channelId: channel.id, targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny })) }),
      ]);
    }
    await this.prisma.channel.update({ where: { id: channel.id }, data: { permissionsSynced: false } });
  }

  async set(user: User, params: unknown, input: unknown): Promise<OverwriteView> {
    const data = parseInput(bodySchema, input);
    const allow = [...new Set(data.allow)];
    const deny = [...new Set(data.deny)].filter((p) => !allow.includes(p));
    // Unchanged permissions are fine even if the author lacks them; only changes must be grantable.
    const { channelId, targetType, targetId } = parseInput(targetSchema, params);
    const current = await this.prisma.permissionOverwrite.findUnique({ where: { channelId_targetType_targetId: { channelId, targetType, targetId } } });
    const changed = [
      ...allow.filter((p) => !current?.allow.includes(p)),
      ...deny.filter((p) => !current?.deny.includes(p)),
      ...cleanPermissions([...(current?.allow ?? []), ...(current?.deny ?? [])]).filter((p) => !allow.includes(p) && !deny.includes(p)),
    ];
    const { channel } = await this.check(user, params, changed);
    await this.desync(channel);
    if (allow.length === 0 && deny.length === 0) {
      await this.prisma.permissionOverwrite.deleteMany({ where: { channelId, targetType, targetId } });
    } else {
      await this.prisma.permissionOverwrite.upsert({
        where: { channelId_targetType_targetId: { channelId, targetType, targetId } },
        create: { channelId, targetType, targetId, allow, deny },
        update: { allow, deny },
      });
    }
    this.permissions.invalidateGuild(channel.guildId ?? '');
    return { targetType, targetId, allow, deny };
  }

  async remove(user: User, params: unknown): Promise<Channel> {
    const { channelId, targetType, targetId } = parseInput(targetSchema, params);
    const current = await this.prisma.permissionOverwrite.findUnique({ where: { channelId_targetType_targetId: { channelId, targetType, targetId } } });
    const { channel } = await this.check(user, params, cleanPermissions([...(current?.allow ?? []), ...(current?.deny ?? [])]));
    await this.desync(channel);
    await this.prisma.permissionOverwrite.deleteMany({ where: { channelId, targetType, targetId } });
    this.permissions.invalidateGuild(channel.guildId ?? '');
    return channel;
  }
}
