import { describe, expect, it } from 'vitest';
import type { RoleView } from '../../api/types';
import { canActOnMember, canEditRole, memberTop, myRank } from './hierarchy';

const role = (id: string, position: number, isEveryone = false): RoleView => ({ id, guildId: 'G', name: id, color: null, position, permissions: [], hoist: false, mentionable: false, isEveryone, memberCount: 0 });
const roles = [role('everyone', 0, true), role('member', 1), role('mod', 2), role('admin', 3)];
const guild = { ownerId: 'owner', me: { roleIds: ['mod'] } };

describe('role hierarchy (same rules as the server)', () => {
  it('ranks me by my highest role; the owner and the superadmin are above everyone', () => {
    expect(myRank(guild, roles, 'me', false)).toBe(2);
    expect(myRank({ ...guild, me: { roleIds: [] } }, roles, 'me', false)).toBe(0);
    expect(myRank(guild, roles, 'owner', false)).toBe(Infinity);
    expect(myRank(guild, roles, 'me', true)).toBe(Infinity);
  });

  it('edits only roles strictly below; @everyone with MANAGE_ROLES', () => {
    expect(canEditRole(role('member', 1), 2)).toBe(true);
    expect(canEditRole(role('mod', 2), 2)).toBe(false);
    expect(canEditRole(role('admin', 3), 2)).toBe(false);
    expect(canEditRole(roles[0]!, 0)).toBe(true);
  });

  it('acts only on members strictly below, never on the owner or on myself', () => {
    expect(memberTop(['member', 'mod'], roles)).toBe(2);
    expect(canActOnMember({ userId: 'x', roleIds: ['member'] }, roles, 2, 'me', 'owner')).toBe(true);
    expect(canActOnMember({ userId: 'x', roleIds: ['mod'] }, roles, 2, 'me', 'owner')).toBe(false);
    expect(canActOnMember({ userId: 'owner', roleIds: [] }, roles, Infinity, 'me', 'owner')).toBe(false);
    expect(canActOnMember({ userId: 'me', roleIds: [] }, roles, 2, 'me', 'owner')).toBe(false);
  });
});
