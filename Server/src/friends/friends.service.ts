import { z } from 'zod';
import type { PrismaClient } from '../db/prisma.js';
import type { User } from '../generated/prisma/client.js';
import { AppError, Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import type { LimitsService } from '../limits/limits.service.js';
import type { PermissionsService } from '../permissions/permissions.service.js';
import type { EventPublisher } from '../realtime/events.js';

export interface FriendView {
  userId: string;
  since: string;
}

export interface FriendsState {
  friends: FriendView[];
  incoming: { userId: string; createdAt: string }[];
  outgoing: { userId: string; createdAt: string }[];
}

const requestSchema = z.object({ username: z.string().trim().min(1).max(64) });

const pair = (a: string, b: string): { userAId: string; userBId: string } => (a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a });

/**
 * 0.7.0 friends. Mutual; a request to someone who already asked you becomes a friendship at once.
 * Who can see whom: friends + members of shared servers (+ yourself); the superadmin sees everyone.
 */
export class FriendsService {
  private readonly friendCache = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionsService,
    private readonly limits: LimitsService,
    private readonly publisher: EventPublisher,
  ) {}

  private changed(...userIds: string[]): void {
    for (const id of userIds) this.friendCache.delete(id);
    this.publisher.friendsChanged(userIds);
  }

  /** Friendships changed outside this service (migrations, tests). */
  invalidate(): void {
    this.friendCache.clear();
  }

  async friendIdsOf(userId: string): Promise<Set<string>> {
    let set = this.friendCache.get(userId);
    if (!set) {
      const rows = await this.prisma.friendship.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
      set = new Set(rows.map((r) => (r.userAId === userId ? r.userBId : r.userAId)));
      this.friendCache.set(userId, set);
    }
    return set;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    return (await this.friendIdsOf(a)).has(b);
  }

  async state(user: User): Promise<FriendsState> {
    const [friends, incoming, outgoing] = await Promise.all([
      this.prisma.friendship.findMany({ where: { OR: [{ userAId: user.id }, { userBId: user.id }] }, orderBy: { createdAt: 'asc' } }),
      this.prisma.friendRequest.findMany({ where: { toId: user.id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.friendRequest.findMany({ where: { fromId: user.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      friends: friends.map((f) => ({ userId: f.userAId === user.id ? f.userBId : f.userAId, since: f.createdAt.toISOString() })),
      incoming: incoming.map((r) => ({ userId: r.fromId, createdAt: r.createdAt.toISOString() })),
      outgoing: outgoing.map((r) => ({ userId: r.toId, createdAt: r.createdAt.toISOString() })),
    };
  }

  private async befriend(a: string, b: string): Promise<void> {
    await this.limits.assertBelow('friends', { userId: a }, (await this.friendIdsOf(a)).size);
    await this.limits.assertBelow('friends', { userId: b }, (await this.friendIdsOf(b)).size);
    await this.prisma.$transaction([
      this.prisma.friendRequest.deleteMany({
        where: {
          OR: [
            { fromId: a, toId: b },
            { fromId: b, toId: a },
          ],
        },
      }),
      this.prisma.friendship.upsert({ where: { userAId_userBId: pair(a, b) }, create: pair(a, b), update: {} }),
    ]);
    this.changed(a, b);
  }

  async request(user: User, input: unknown): Promise<{ status: 'sent' | 'accepted' }> {
    const { username } = parseInput(requestSchema, input);
    const target = await this.prisma.user.findUnique({ where: { usernameNormalized: username.toLowerCase() } });
    if (!target || target.disabled) throw new AppError(404, 'USER_NOT_FOUND', 'No user with this name');
    if (target.id === user.id) throw Errors.badRequest('SELF', 'You cannot add yourself');
    if (await this.areFriends(user.id, target.id)) throw Errors.conflict('ALREADY_FRIENDS', 'You are already friends');
    if (await this.prisma.friendRequest.findUnique({ where: { fromId_toId: { fromId: target.id, toId: user.id } } })) {
      await this.befriend(user.id, target.id);
      return { status: 'accepted' };
    }
    const pending = await this.prisma.friendRequest.count({ where: { fromId: user.id } });
    await this.limits.assertBelow('friends.pending', { userId: user.id }, pending);
    await this.prisma.friendRequest.upsert({ where: { fromId_toId: { fromId: user.id, toId: target.id } }, create: { fromId: user.id, toId: target.id }, update: {} });
    this.changed(user.id, target.id);
    return { status: 'sent' };
  }

  async accept(user: User, fromUserId: string): Promise<void> {
    const request = await this.prisma.friendRequest.findUnique({ where: { fromId_toId: { fromId: fromUserId, toId: user.id } } });
    if (!request) throw Errors.notFound('Friend request');
    await this.befriend(user.id, fromUserId);
  }

  /** Declines an incoming request or cancels an outgoing one. */
  async decline(user: User, otherUserId: string): Promise<void> {
    const { count } = await this.prisma.friendRequest.deleteMany({
      where: {
        OR: [
          { fromId: otherUserId, toId: user.id },
          { fromId: user.id, toId: otherUserId },
        ],
      },
    });
    if (count === 0) throw Errors.notFound('Friend request');
    this.changed(user.id, otherUserId);
  }

  async remove(user: User, otherUserId: string): Promise<void> {
    const { count } = await this.prisma.friendship.deleteMany({ where: pair(user.id, otherUserId) });
    if (count === 0) throw Errors.notFound('Friend');
    this.changed(user.id, otherUserId);
  }

  /** Ids this user may see (profiles, presence, user list); 'all' for the superadmin. */
  async visibleUserIds(user: Pick<User, 'id' | 'role'>): Promise<Set<string> | 'all'> {
    if (user.role === 'ADMIN') return 'all';
    const out = new Set<string>([user.id, ...(await this.friendIdsOf(user.id))]);
    for (const guildId of await this.permissions.guildIdsOf(user.id)) for (const id of await this.permissions.memberIdsOf(guildId)) out.add(id);
    // People with a pending request either way (you must see who asks) and everyone you share a DM with
    // (group DMs, and 1:1 partners after unfriending: those conversations stay readable).
    const [requests, dmMembers] = await Promise.all([
      this.prisma.friendRequest.findMany({ where: { OR: [{ fromId: user.id }, { toId: user.id }] }, select: { fromId: true, toId: true } }),
      this.prisma.channelMember.findMany({ where: { channel: { type: 'DM', members: { some: { userId: user.id } } } }, select: { userId: true } }),
    ]);
    for (const r of requests) out.add(r.fromId === user.id ? r.toId : r.fromId);
    for (const m of dmMembers) out.add(m.userId);
    return out;
  }

  async canSee(user: Pick<User, 'id' | 'role'>, otherId: string): Promise<boolean> {
    const visible = await this.visibleUserIds(user);
    return visible === 'all' || visible.has(otherId);
  }

  /**
   * Who should hear about this user's presence / profile changes: friends + members of shared servers
   * (the reverse of visibleUserIds; superadmins are added by the gateway).
   */
  async watchersOf(userId: string): Promise<string[]> {
    const out = new Set<string>([userId, ...(await this.friendIdsOf(userId))]);
    for (const guildId of await this.permissions.guildIdsOf(userId)) for (const id of await this.permissions.memberIdsOf(guildId)) out.add(id);
    return [...out];
  }
}
