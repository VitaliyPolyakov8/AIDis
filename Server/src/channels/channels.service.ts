import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import { isUniqueViolation } from '../db/prisma.js';
import type { Channel, ChannelType, User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { isPrintable, parseInput, sanitizeText } from '../common/validation.js';
import { cleanPermissions, type Permission } from '../permissions/catalog.js';

/** 0.7.0: DMs are for friends only. */
export const notFriends = () => new AppError(403, 'NOT_FRIENDS', 'You can only message your friends');
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { LimitsService } from '../limits/limits.service.js';

export interface OverwriteView {
  targetType: 'ROLE' | 'MEMBER';
  targetId: string;
  allow: Permission[];
  deny: Permission[];
}

export interface ChannelView {
  id: string;
  /** 0.7.0: the server (null for DMs). */
  guildId: string | null;
  type: ChannelType;
  name: string;
  description: string | null;
  position: number;
  /** 0.7.0: category id (null = top level). */
  parentId: string | null;
  /** 0.7.0: uses the category's overwrites. */
  permissionsSynced: boolean;
  createdAt: string;
  protected: boolean;
  /** 0.7.0: the channel's own overwrites, only for people who may manage it. */
  overwrites?: OverwriteView[];
  /** DMs only. */
  title?: string | null;
  memberIds?: string[];
  ownerId?: string | null;
  lastMessageAt?: string | null;
  /** 0.5.5 voice channels: microphone bitrate for everyone (kbps) and layout. */
  voiceBitrate?: number;
  voiceLayout?: VoiceLayout;
  /** 0.7.1 voice channels: the extra voice server, null = the main one. */
  voiceNodeId?: string | null;
}

/** 0.5.5: "standard" participant grid, or "room" (2D room, voices fade with distance). */
export const VOICE_LAYOUTS = ['standard', 'room'] as const;
export type VoiceLayout = (typeof VOICE_LAYOUTS)[number];
/** Microphone bitrate choices (kbps), like Discord's 8-96 plus 128 / 256 for music. */
export const VOICE_BITRATE_MIN = 8;
export const VOICE_BITRATE_MAX = 256;
export const DEFAULT_VOICE_BITRATE = 64;

type ChannelWithExtras = Channel & { members?: { userId: string }[]; overwrites?: { targetType: 'ROLE' | 'MEMBER'; targetId: string; allow: string[]; deny: string[] }[] };

export function toChannelView(channel: ChannelWithExtras, opts: { withOverwrites?: boolean } = {}): ChannelView {
  const view: ChannelView = {
    id: channel.id,
    guildId: channel.guildId,
    type: channel.type,
    name: channel.name,
    description: channel.description,
    position: channel.position,
    parentId: channel.parentId,
    permissionsSynced: channel.permissionsSynced,
    createdAt: channel.createdAt.toISOString(),
    protected: channel.protected,
  };
  if (channel.type === 'VOICE') {
    view.voiceBitrate = channel.voiceBitrate ?? DEFAULT_VOICE_BITRATE;
    view.voiceLayout = (VOICE_LAYOUTS as readonly string[]).includes(channel.voiceLayout) ? (channel.voiceLayout as VoiceLayout) : 'standard';
    view.voiceNodeId = channel.voiceNodeId;
  }
  if (channel.type === 'DM') {
    view.title = channel.title;
    view.memberIds = (channel.members ?? []).map((m) => m.userId);
    view.ownerId = channel.ownerId;
    view.lastMessageAt = channel.lastMessageAt?.toISOString() ?? null;
  } else if (opts.withOverwrites) {
    view.overwrites = (channel.overwrites ?? []).map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: cleanPermissions(o.allow), deny: cleanPermissions(o.deny) }));
  }
  return view;
}

/** Group DMs: the creator plus up to this many others. */
export const MAX_GROUP_DM_MEMBERS = 10;

const channelName = z
  .string()
  .transform((v) => sanitizeText(v).replace(/\s+/g, '-'))
  .pipe(z.string().min(1, 'Name is required').max(64, 'Name must be at most 64 characters').refine(isPrintable, 'Name contains invalid characters'));
/** Categories keep their spaces ("Текстовые каналы"). */
const categoryName = z.string().transform(sanitizeText).pipe(z.string().min(1, 'Name is required').max(64).refine(isPrintable, 'Name contains invalid characters'));
const description = z.string().transform(sanitizeText).pipe(z.string().max(300)).nullable();

export const createChannelSchema = z.object({
  type: z.enum(['TEXT', 'VOICE', 'CATEGORY']),
  name: z.string(),
  description: description.optional(),
  parentId: z.uuid().nullable().optional(),
  voiceBitrate: z.number().int().min(VOICE_BITRATE_MIN).max(VOICE_BITRATE_MAX).optional(),
  voiceLayout: z.enum(VOICE_LAYOUTS).optional(),
  voiceNodeId: z.uuid().nullable().optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().optional(),
  description: description.optional(),
  parentId: z.uuid().nullable().optional(),
  /** true: drop own overwrites and use the category's again. */
  syncWithParent: z.literal(true).optional(),
  /** 0.5.5 voice channels only (ignored for text channels). */
  voiceBitrate: z.number().int().min(VOICE_BITRATE_MIN).max(VOICE_BITRATE_MAX).optional(),
  voiceLayout: z.enum(VOICE_LAYOUTS).optional(),
  /** 0.7.1: the extra voice server (must be enabled and given to this server), null = the main one. */
  voiceNodeId: z.uuid().nullable().optional(),
});

const reorderSchema = z.object({
  items: z
    .array(z.object({ id: z.uuid(), parentId: z.uuid().nullable(), position: z.number().int().min(0).max(10_000) }))
    .min(1)
    .max(2000),
});
const dmCreateSchema = z.object({ userIds: z.array(z.uuid()).min(1).max(MAX_GROUP_DM_MEMBERS), title: z.string().optional() });
const dmTitle = z.string().transform(sanitizeText).pipe(z.string().max(64).refine(isPrintable)).nullable();

/** Who may open a DM / write to whom (0.7.0: friends). Wired in app.ts. */
export interface FriendshipChecker {
  areFriends(a: string, b: string): Promise<boolean>;
}

export class ChannelsService {
  private friends: FriendshipChecker | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService | null = null,
    private readonly limits: LimitsService | null = null,
  ) {}

  attachFriends(friends: FriendshipChecker): void {
    this.friends = friends;
  }

  /** 0.7.1: which voice servers a server may use (set in app.ts). */
  private voiceNodes: { usableBy(nodeId: string, guildId: string): Promise<boolean> } | null = null;
  /** 0.7.1: a voice channel moved to another voice server: the people in it must rejoin. */
  onVoiceNodeChanged: (channelId: string) => void = () => undefined;

  attachVoiceNodes(nodes: { usableBy(nodeId: string, guildId: string): Promise<boolean> }): void {
    this.voiceNodes = nodes;
  }

  private async assertVoiceNode(guildId: string, nodeId: string | null | undefined): Promise<void> {
    if (!nodeId) return;
    if (!this.voiceNodes || !(await this.voiceNodes.usableBy(nodeId, guildId))) throw Errors.badRequest('INVALID_VOICE_NODE', 'This voice server is not available to this server');
  }

  /** Channels of a server this user may see (categories with at least one visible child or visible themselves). */
  async listVisible(user: User, guildId: string): Promise<ChannelView[]> {
    const perms = this.perms();
    await perms.requireGuild(user, guildId);
    const rows = await this.prisma.channel.findMany({
      where: { guildId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: { overwrites: true },
    });
    const visible = new Set<string>();
    const manage = new Set<string>();
    for (const c of rows) {
      const p = await perms.channelPermissions(user, c);
      if (p.has('VIEW_CHANNEL')) visible.add(c.id);
      if (p.has('MANAGE_ROLES') || p.has('MANAGE_CHANNELS')) manage.add(c.id);
    }
    const out: ChannelView[] = [];
    for (const c of rows) {
      const show = c.type === 'CATEGORY' ? visible.has(c.id) || rows.some((child) => child.parentId === c.id && visible.has(child.id)) : visible.has(c.id);
      if (show) out.push(toChannelView(c, { withOverwrites: manage.has(c.id) }));
    }
    return out;
  }

  /** Every channel this user can see, across all servers (read state). */
  async listAllVisible(user: User): Promise<ChannelView[]> {
    const out: ChannelView[] = [];
    for (const guildId of await this.perms().guildIdsOf(user.id)) out.push(...(await this.listVisible(user, guildId)).filter((c) => c.type !== 'CATEGORY'));
    return out;
  }

  async get(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw Errors.notFound('Channel');
    return channel;
  }

  /** A channel visible to the user (any type), or NOT_FOUND. */
  async getVisible(user: User, id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel || !(await this.perms().canView(user, channel))) throw Errors.notFound('Channel');
    return channel;
  }

  /** The view of one visible channel (overwrites when the user may manage it). */
  async viewFor(user: User, channel: Channel): Promise<ChannelView> {
    if (channel.type === 'DM') return this.getDmView(channel.id);
    const perms = await this.perms().channelPermissions(user, channel);
    const withOverwrites = perms.has('MANAGE_ROLES') || perms.has('MANAGE_CHANNELS');
    const row = withOverwrites ? await this.prisma.channel.findUniqueOrThrow({ where: { id: channel.id }, include: { overwrites: true } }) : channel;
    return toChannelView(row, { withOverwrites });
  }

  /**
   * A channel that has a message history: every text channel, every voice channel (its built-in
   * chat) and (0.4.0) every DM. Categories have none.
   */
  async getChat(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel || channel.type === 'CATEGORY') throw Errors.notFound('Channel');
    return channel;
  }

  async getOfType(id: string, type: ChannelType): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (channel?.type !== type) {
      throw Errors.notFound(type === 'TEXT' ? 'Text channel' : 'Voice channel');
    }
    return channel;
  }

  /** A channel with a voice room: VOICE channels and (0.4.0) DMs (1:1 and group calls). */
  async getCallable(id: string): Promise<Channel> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (channel?.type !== 'VOICE' && channel?.type !== 'DM') throw Errors.notFound('Voice channel');
    return channel;
  }

  // ---- management -----------------------------------------------------------------------------

  private async resolveParent(guildId: string, parentId: string | null | undefined): Promise<Channel | null> {
    if (!parentId) return null;
    const parent = await this.prisma.channel.findUnique({ where: { id: parentId } });
    if (parent?.guildId !== guildId || parent.type !== 'CATEGORY') throw Errors.badRequest('INVALID_PARENT', 'Pick a category of this server');
    return parent;
  }

  private async assertBitrate(guildId: string, bitrate: number | undefined): Promise<void> {
    if (bitrate === undefined || !this.limits) return;
    const max = await this.limits.resolve('voice.bitrateMax', { guildId });
    if (bitrate > max) throw Errors.badRequest('BITRATE_TOO_HIGH', `At most ${max} kbps on this server`);
  }

  /** MANAGE_CHANNELS on the server, or in the category the channel goes into. */
  async create(user: User, guildId: string, input: unknown): Promise<Channel> {
    const data = parseInput(createChannelSchema, input);
    const name = parseInput(data.type === 'CATEGORY' ? categoryName : channelName, data.name);
    const perms = this.perms();
    await perms.requireGuild(user, guildId);
    const parent = data.type === 'CATEGORY' ? null : await this.resolveParent(guildId, data.parentId);
    if (parent) await perms.requireChannel(user, parent, 'MANAGE_CHANNELS');
    else await perms.requireGuild(user, guildId, 'MANAGE_CHANNELS');
    if (data.type === 'CATEGORY' && data.parentId) throw Errors.badRequest('INVALID_PARENT', 'A category cannot be inside another category');
    if (this.limits) await this.limits.assertBelow('guild.channels', { guildId }, await this.prisma.channel.count({ where: { guildId } }));
    await this.assertBitrate(guildId, data.voiceBitrate);
    if (data.type === 'VOICE') await this.assertVoiceNode(guildId, data.voiceNodeId);
    const last = await this.prisma.channel.findFirst({ where: { guildId, parentId: parent?.id ?? null }, orderBy: { position: 'desc' } });
    const channel = await this.prisma.channel.create({
      data: {
        guildId,
        type: data.type,
        name,
        description: data.description ?? null,
        position: (last?.position ?? -1) + 1,
        parentId: parent?.id ?? null,
        permissionsSynced: true,
        ...(data.type === 'VOICE' ? { voiceBitrate: data.voiceBitrate ?? null, voiceLayout: data.voiceLayout ?? 'standard', voiceNodeId: data.voiceNodeId ?? null } : {}),
      },
    });
    perms.invalidateGuild(guildId);
    return channel;
  }

  /** Copies the category's overwrites into the channel and marks it as not synced (before own changes). */
  private async desync(channel: Channel): Promise<void> {
    if (!channel.permissionsSynced || !channel.parentId) {
      if (channel.permissionsSynced) await this.prisma.channel.update({ where: { id: channel.id }, data: { permissionsSynced: false } });
      return;
    }
    const parentOverwrites = await this.prisma.permissionOverwrite.findMany({ where: { channelId: channel.parentId } });
    await this.prisma.$transaction([
      this.prisma.permissionOverwrite.deleteMany({ where: { channelId: channel.id } }),
      this.prisma.permissionOverwrite.createMany({ data: parentOverwrites.map((o) => ({ channelId: channel.id, targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny })) }),
      this.prisma.channel.update({ where: { id: channel.id }, data: { permissionsSynced: false } }),
    ]);
  }

  async update(user: User, id: string, input: unknown): Promise<{ before: Channel; after: Channel }> {
    const data = parseInput(updateChannelSchema, input);
    const before = await this.get(id);
    if (before.type === 'DM' || !before.guildId) throw Errors.notFound('Channel');
    const guildId = before.guildId;
    const perms = this.perms();
    await perms.requireChannel(user, before, 'MANAGE_CHANNELS');
    const name = data.name === undefined ? undefined : parseInput(before.type === 'CATEGORY' ? categoryName : channelName, data.name);
    let parentId: string | null | undefined;
    if (data.parentId !== undefined) {
      if (before.type === 'CATEGORY' && data.parentId) throw Errors.badRequest('INVALID_PARENT', 'A category cannot be inside another category');
      parentId = (await this.resolveParent(guildId, data.parentId))?.id ?? null;
      // Leaving a category must not drop the access rules it gave: keep a copy as the channel's own.
      if (parentId === null && before.parentId) await this.desync(before);
    }
    if (before.type === 'VOICE') await this.assertBitrate(guildId, data.voiceBitrate);
    if (before.type === 'VOICE') await this.assertVoiceNode(guildId, data.voiceNodeId);
    if (data.syncWithParent) {
      await perms.requireChannel(user, before, 'MANAGE_ROLES');
      await this.prisma.permissionOverwrite.deleteMany({ where: { channelId: id } });
    }
    const after = await this.prisma.channel.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(data.syncWithParent ? { permissionsSynced: true } : {}),
        ...(before.type === 'VOICE' && data.voiceBitrate !== undefined ? { voiceBitrate: data.voiceBitrate } : {}),
        ...(before.type === 'VOICE' && data.voiceLayout !== undefined ? { voiceLayout: data.voiceLayout } : {}),
        ...(before.type === 'VOICE' && data.voiceNodeId !== undefined ? { voiceNodeId: data.voiceNodeId } : {}),
      },
    });
    perms.invalidateGuild(guildId);
    if (before.type === 'VOICE' && data.voiceNodeId !== undefined && data.voiceNodeId !== before.voiceNodeId) this.onVoiceNodeChanged(id);
    return { before, after };
  }

  /** Deletes a channel with its history; a category's channels move to the top level (keeping their access). */
  async delete(user: User, id: string): Promise<Channel> {
    const channel = await this.get(id);
    if (channel.type === 'DM' || !channel.guildId) throw Errors.notFound('Channel');
    const guildId = channel.guildId;
    await this.perms().requireChannel(user, channel, 'MANAGE_CHANNELS');
    if (channel.protected) throw Errors.conflict('CHANNEL_PROTECTED', 'This default channel cannot be deleted');
    if (channel.type === 'TEXT' && (await this.prisma.channel.count({ where: { guildId, type: 'TEXT' } })) <= 1) throw Errors.conflict('LAST_CHANNEL', 'The last text channel cannot be deleted');
    if (channel.type === 'CATEGORY') {
      // Synced children would lose the category's access rules (a hidden category would become public).
      for (const child of await this.prisma.channel.findMany({ where: { parentId: id, permissionsSynced: true } })) await this.desync(child);
    }
    await this.prisma.$transaction([
      // Keep uploaded files (and their rows) but unlink them; messages go with the channel.
      this.prisma.attachment.updateMany({ where: { message: { channelId: id } }, data: { messageId: null } }),
      this.prisma.guild.updateMany({ where: { id: guildId, systemChannelId: id }, data: { systemChannelId: null } }),
      this.prisma.channel.delete({ where: { id } }),
    ]);
    this.perms().invalidateGuild(guildId);
    return channel;
  }

  /** New positions / categories (MANAGE_CHANNELS on the server). Unknown ids are ignored. */
  async reorder(user: User, guildId: string, input: unknown): Promise<void> {
    await this.perms().requireGuild(user, guildId, 'MANAGE_CHANNELS');
    const { items } = parseInput(reorderSchema, input);
    const existing = new Map((await this.prisma.channel.findMany({ where: { guildId } })).map((c) => [c.id, c]));
    const updates = [];
    for (const item of items) {
      const channel = existing.get(item.id);
      if (!channel) continue;
      let parentId: string | null = null;
      if (item.parentId && channel.type !== 'CATEGORY') {
        if (existing.get(item.parentId)?.type !== 'CATEGORY') throw Errors.badRequest('INVALID_PARENT', 'Pick a category of this server');
        parentId = item.parentId;
      }
      // Leaving a category must not drop the access rules it gave: keep a copy as the channel's own.
      if (parentId === null && channel.parentId) await this.desync(channel);
      updates.push(this.prisma.channel.update({ where: { id: item.id }, data: { position: item.position, parentId } }));
    }
    await this.prisma.$transaction(updates);
    this.perms().invalidateGuild(guildId);
  }

  // ---- direct messages -------------------------------------------------------------------

  async listDms(user: User): Promise<ChannelView[]> {
    const rows = await this.prisma.channel.findMany({
      where: { type: 'DM', members: { some: { userId: user.id } } },
      include: { members: { select: { userId: true }, orderBy: { addedAt: 'asc' } } },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return rows.map((c) => toChannelView(c));
  }

  async getDmView(id: string): Promise<ChannelView> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include: { members: { select: { userId: true }, orderBy: { addedAt: 'asc' } } },
    });
    if (channel?.type !== 'DM') throw Errors.notFound('Conversation');
    return toChannelView(channel);
  }

  /** 0.7.0: only friends of the user (403 NOT_FRIENDS otherwise). */
  private async assertFriends(user: User, others: string[]): Promise<void> {
    if (!this.friends) return;
    for (const other of others) {
      if (!(await this.friends.areFriends(user.id, other))) throw notFriends();
    }
  }

  /** 1:1 DM: may this user write / call there right now (friends only)? Group DMs: any member. */
  async canWriteDm(user: User, channel: Channel): Promise<boolean> {
    if (channel.type !== 'DM' || !channel.dmKey || !this.friends) return true;
    const other = channel.dmKey.split(':').find((id) => id !== user.id);
    return other ? this.friends.areFriends(user.id, other) : true;
  }

  /**
   * Opens a DM: with one other user the same pair always gets the same conversation; with several
   * a new group DM is created (creator + up to MAX_GROUP_DM_MEMBERS others). 0.7.0: friends only.
   */
  async openDm(user: User, input: unknown): Promise<{ channel: ChannelView; created: boolean }> {
    const data = parseInput(dmCreateSchema, input);
    const others = [...new Set(data.userIds.filter((id) => id !== user.id))];
    if (others.length === 0) throw Errors.badRequest('DM_NEEDS_USER', 'Pick at least one other person');
    const found = await this.prisma.user.findMany({ where: { id: { in: others }, disabled: false }, select: { id: true } });
    if (found.length !== others.length) throw Errors.badRequest('DM_UNKNOWN_USER', 'Unknown or disabled user');
    if (others.length === 1) {
      const other = others[0] ?? '';
      const dmKey = [user.id, other].sort().join(':');
      const existing = await this.prisma.channel.findUnique({ where: { dmKey } });
      if (existing) return { channel: await this.getDmView(existing.id), created: false };
      await this.assertFriends(user, others);
      try {
        const id = randomUUID();
        await this.prisma.channel.create({
          data: { id, type: 'DM', name: `dm-${id}`, dmKey, ownerId: user.id, members: { create: [{ userId: user.id }, { userId: other }] } },
        });
        this.perms().invalidateDm(id);
        return { channel: await this.getDmView(id), created: true };
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await this.prisma.channel.findUnique({ where: { dmKey } });
          if (raced) return { channel: await this.getDmView(raced.id), created: false };
        }
        throw error;
      }
    }
    await this.assertFriends(user, others);
    const title = data.title === undefined ? null : parseInput(dmTitle, data.title) || null;
    const id = randomUUID();
    await this.prisma.channel.create({
      data: { id, type: 'DM', name: `dm-${id}`, title, ownerId: user.id, members: { create: [user.id, ...others].map((userId) => ({ userId })) } },
    });
    this.perms().invalidateDm(id);
    return { channel: await this.getDmView(id), created: true };
  }

  private async requireDmMember(user: User, id: string): Promise<Channel & { members: { userId: string }[] }> {
    const channel = await this.prisma.channel.findUnique({ where: { id }, include: { members: { select: { userId: true } } } });
    if (channel?.type !== 'DM' || !channel.members.some((m) => m.userId === user.id)) throw Errors.notFound('Conversation');
    return channel;
  }

  /** Group DMs only: rename, add people (0.7.0: only your friends). 1:1 DMs stay exactly two people. */
  async updateGroupDm(user: User, id: string, input: unknown): Promise<ChannelView> {
    const data = parseInput(z.object({ title: dmTitle.optional(), addUserIds: z.array(z.uuid()).max(MAX_GROUP_DM_MEMBERS).optional() }), input);
    const channel = await this.requireDmMember(user, id);
    if (channel.dmKey) throw Errors.badRequest('DM_NOT_GROUP', 'Only group conversations can be renamed or extended');
    if (data.title !== undefined) await this.prisma.channel.update({ where: { id }, data: { title: data.title || null } });
    if (data.addUserIds && data.addUserIds.length > 0) {
      const current = new Set(channel.members.map((m) => m.userId));
      const add = [...new Set(data.addUserIds)].filter((u) => !current.has(u));
      if (current.size + add.length > MAX_GROUP_DM_MEMBERS + 1) throw Errors.badRequest('DM_TOO_MANY', `A group conversation has at most ${MAX_GROUP_DM_MEMBERS + 1} people`);
      const valid = await this.prisma.user.findMany({ where: { id: { in: add }, disabled: false }, select: { id: true } });
      if (valid.length !== add.length) throw Errors.badRequest('DM_UNKNOWN_USER', 'Unknown or disabled user');
      await this.assertFriends(user, add);
      await this.prisma.channelMember.createMany({ data: add.map((userId) => ({ channelId: id, userId })), skipDuplicates: true });
      this.perms().invalidateDm(id);
    }
    return this.getDmView(id);
  }

  /** Leave a group DM (the last person leaving deletes it). 1:1 DMs cannot be left. */
  async leaveDm(user: User, id: string): Promise<{ memberIds: string[] }> {
    const channel = await this.requireDmMember(user, id);
    if (channel.dmKey) throw Errors.badRequest('DM_NOT_GROUP', 'A direct conversation cannot be left');
    await this.prisma.channelMember.delete({ where: { channelId_userId: { channelId: id, userId: user.id } } });
    const memberIds = channel.members.map((m) => m.userId).filter((m) => m !== user.id);
    if (memberIds.length === 0) {
      await this.prisma.attachment.updateMany({ where: { message: { channelId: id } }, data: { messageId: null } });
      await this.prisma.channel.delete({ where: { id } });
    }
    this.perms().invalidateDm(id);
    return { memberIds };
  }

  async touchLastMessage(id: string, at: Date): Promise<void> {
    await this.prisma.channel.update({ where: { id }, data: { lastMessageAt: at } });
  }

  private perms(): PermissionsService {
    if (!this.permissions) throw new Error('PermissionsService not wired');
    return this.permissions;
  }
}
