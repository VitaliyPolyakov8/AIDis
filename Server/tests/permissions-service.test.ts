import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE } from '../src/permissions/catalog.js';
import { PermissionsService } from '../src/permissions/permissions.service.js';
import type { Channel, User } from '../src/generated/prisma/client.js';
import { createDb, dbUser } from './db.js';

describe('PermissionsService (per server)', () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let perms: PermissionsService;
  let owner: User, alice: User, bob: User, outsider: User, superadmin: User, ghost: User;
  let guildId: string, everyoneId: string, vipId: string;
  let category: Channel, synced: Channel, own: Channel;

  beforeAll(async () => {
    db = await createDb();
    const p = db.prisma;
    [owner, alice, bob, outsider, superadmin, ghost] = [
      await dbUser(p, 'owner'),
      await dbUser(p, 'alice'),
      await dbUser(p, 'bob'),
      await dbUser(p, 'outsider'),
      await dbUser(p, 'super', 'ADMIN'),
      await dbUser(p, 'ghost', 'USER', true),
    ];
    const guild = await p.guild.create({ data: { name: 'G', ownerId: owner.id } });
    guildId = guild.id;
    everyoneId = (await p.roleDef.create({ data: { guildId, key: 'everyone', name: '@everyone', position: 0, permissions: [...DEFAULT_EVERYONE] } })).id;
    vipId = (await p.roleDef.create({ data: { guildId, name: 'VIP', position: 1, permissions: ['KICK_MEMBERS'] } })).id;
    for (const u of [owner, alice, bob, ghost]) await p.guildMember.create({ data: { guildId, userId: u.id } });
    await p.guildMemberRole.create({ data: { guildId, userId: alice.id, roleId: vipId } });
    category = await p.channel.create({ data: { guildId, type: 'CATEGORY', name: 'cat' } });
    synced = await p.channel.create({ data: { guildId, type: 'TEXT', name: 'synced', parentId: category.id, permissionsSynced: true } });
    own = await p.channel.create({ data: { guildId, type: 'TEXT', name: 'own', parentId: category.id, permissionsSynced: false } });
    await p.permissionOverwrite.create({ data: { channelId: category.id, targetType: 'ROLE', targetId: everyoneId, deny: ['VIEW_CHANNEL'] } });
    await p.permissionOverwrite.create({ data: { channelId: category.id, targetType: 'ROLE', targetId: vipId, allow: ['VIEW_CHANNEL'] } });
    perms = new PermissionsService(p);
  });
  afterAll(async () => {
    await db.close();
  });

  it('gives a non-member nothing and hides the server', async () => {
    expect((await perms.guildPermissions(outsider, guildId)).size).toBe(0);
    await expect(perms.requireGuild(outsider, guildId)).rejects.toMatchObject({ statusCode: 404, code: 'GUILD_NOT_FOUND' });
    expect(await perms.canView(outsider, own)).toBe(false);
  });

  it('gives a superadmin everything without membership', async () => {
    expect((await perms.guildPermissions(superadmin, guildId)).has('BAN_MEMBERS')).toBe(true);
    expect(await perms.canView(superadmin, synced)).toBe(true);
  });

  it('requires the permission and answers 403 when a member lacks it', async () => {
    await expect(perms.requireGuild(bob, guildId, 'KICK_MEMBERS')).rejects.toMatchObject({ statusCode: 403 });
    await expect(perms.requireGuild(alice, guildId, 'KICK_MEMBERS')).resolves.toBeUndefined();
  });

  it('applies category overwrites to a synced child only', async () => {
    expect(await perms.canView(bob, synced)).toBe(false);
    expect(await perms.canView(alice, synced)).toBe(true);
    expect(await perms.canView(bob, own)).toBe(true);
    expect(await perms.canView(bob, category)).toBe(false);
  });

  it('builds the audience of a hidden channel from the allowed role and the owner, without disabled users', async () => {
    expect((await perms.audience(synced)).sort()).toEqual([alice.id, owner.id].sort());
    expect((await perms.audience(own)).sort()).toEqual([alice.id, bob.id, owner.id].sort());
  });

  it('sees a role change after invalidateGuild', async () => {
    await db.prisma.guildMemberRole.create({ data: { guildId, userId: bob.id, roleId: vipId } });
    expect(await perms.canView(bob, synced)).toBe(false);
    perms.invalidateGuild(guildId);
    expect(await perms.canView(bob, synced)).toBe(true);
    expect(await perms.topPosition(bob, guildId)).toBe(1);
    expect(await perms.topPosition(owner, guildId)).toBe(Infinity);
  });

  it('lists membership both ways', async () => {
    expect(await perms.isMember(alice.id, guildId)).toBe(true);
    expect(await perms.isMember(outsider.id, guildId)).toBe(false);
    expect(await perms.guildIdsOf(alice.id)).toEqual([guildId]);
    expect((await perms.memberIdsOf(guildId)).sort()).toEqual([owner.id, alice.id, bob.id].sort());
  });

  it('invalidating one server keeps the caches of another', async () => {
    const other = await db.prisma.guild.create({ data: { name: 'Other', ownerId: outsider.id } });
    await db.prisma.roleDef.create({ data: { guildId: other.id, key: 'everyone', name: '@everyone', permissions: [...DEFAULT_EVERYONE] } });
    await db.prisma.guildMember.create({ data: { guildId: other.id, userId: outsider.id } });
    const otherChannel = await db.prisma.channel.create({ data: { guildId: other.id, type: 'TEXT', name: 'x' } });
    // count the database reads a fresh service makes
    let reads = 0;
    const counting = new Proxy(db.prisma, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop === 'guild' || prop === 'permissionOverwrite' || prop === 'user' || prop === 'guildMember') {
          return new Proxy(value as object, {
            get(delegate, method, r) {
              const fn: unknown = Reflect.get(delegate, method, r);
              return typeof fn === 'function'
                ? (...args: unknown[]) => {
                    reads += 1;
                    return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
                  }
                : fn;
            },
          });
        }
        return value;
      },
    });
    const fresh = new PermissionsService(counting);
    await fresh.audience(otherChannel);
    await fresh.guildIdsOf(outsider.id);
    const warm = reads;
    fresh.invalidateGuild(guildId);
    expect(await fresh.audience(otherChannel)).toEqual([outsider.id]);
    expect(await fresh.guildIdsOf(outsider.id)).toEqual([other.id]);
    expect(reads).toBe(warm);
  });
});
