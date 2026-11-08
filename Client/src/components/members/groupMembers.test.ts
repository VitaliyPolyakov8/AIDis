import { describe, expect, it } from 'vitest';
import type { MemberView, RoleView } from '../../api/types';
import { groupMembers } from './groupMembers';

const role = (id: string, position: number, hoist: boolean): RoleView => ({ id, guildId: 'G', name: id, color: null, position, permissions: [], hoist, mentionable: false, isEveryone: false, memberCount: 0 });
const member = (userId: string, roleIds: string[] = []): MemberView => ({ userId, roleIds, joinedAt: '2026-01-01T00:00:00.000Z', nickname: null, avatarAttachmentId: null, bannerAttachmentId: null, bio: null });

describe('groupMembers', () => {
  const roles = [role('mods', 2, true), role('vip', 1, true), role('quiet', 3, false), { ...role('everyone', 0, false), isEveryone: true }];
  const online = new Set(['ann', 'bob', 'cid', 'dan']);
  const name = (m: MemberView) => m.userId;

  it('groups online people under their highest displayed role, in role order, then the rest online, then offline', () => {
    const members = [member('dan'), member('bob', ['vip', 'mods']), member('ann', ['vip']), member('cid', ['quiet']), member('eve', ['mods'])];
    const result = groupMembers(members, roles, (id) => online.has(id), name);
    expect(result.groups.map((g) => [g.role?.id ?? 'online', g.members.map((m) => m.userId)])).toEqual([
      ['mods', ['bob']],
      ['vip', ['ann']],
      ['online', ['cid', 'dan']],
    ]);
    expect(result.offline.map((m) => m.userId)).toEqual(['eve']);
  });

  it('leaves out empty groups and sorts by name', () => {
    const result = groupMembers([member('zed'), member('amy')], roles, () => true, name);
    expect(result.groups).toEqual([{ role: null, members: [member('amy'), member('zed')] }]);
    expect(result.offline).toEqual([]);
  });
});
