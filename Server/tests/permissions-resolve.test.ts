import { describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, PERMISSIONS, type Permission } from '../src/permissions/catalog.js';
import { basePermissions, channelPermissions, outranks, topPosition, type MemberContext, type OverwriteInput, type RoleInput } from '../src/permissions/resolve.js';

const everyone: RoleInput = { id: 'everyone', position: 0, permissions: DEFAULT_EVERYONE, isEveryone: true };
const mod: RoleInput = { id: 'mod', position: 3, permissions: ['MANAGE_MESSAGES', 'KICK_MEMBERS'], isEveryone: false };
const vip: RoleInput = { id: 'vip', position: 5, permissions: [], isEveryone: false };
const admin: RoleInput = { id: 'admin', position: 6, permissions: ['ADMINISTRATOR'], isEveryone: false };
const roles = [everyone, mod, vip, admin];

const member = (roleIds: string[] = [], extra: Partial<MemberContext> = {}): MemberContext => ({ userId: 'u1', roleIds, isOwner: false, isSuperadmin: false, ...extra });
const ow = (targetType: 'ROLE' | 'MEMBER', targetId: string, allow: Permission[], deny: Permission[]): OverwriteInput => ({ targetType, targetId, allow, deny });
const denyViewEveryone = ow('ROLE', 'everyone', [], ['VIEW_CHANNEL']);

describe('permission resolution (Discord order)', () => {
  it('owner and superadmin get everything, even with deny overwrites', () => {
    expect(channelPermissions(member([], { isOwner: true }), roles, [denyViewEveryone], 'TEXT').size).toBe(PERMISSIONS.length);
    expect(channelPermissions(member([], { isSuperadmin: true }), roles, [denyViewEveryone], 'TEXT').size).toBe(PERMISSIONS.length);
  });

  it('base permissions are @everyone plus the member roles', () => {
    const base = basePermissions(member(['mod']), roles);
    expect(base.has('SEND_MESSAGES')).toBe(true);
    expect(base.has('KICK_MEMBERS')).toBe(true);
    expect(base.has('BAN_MEMBERS')).toBe(false);
  });

  it('ADMINISTRATOR ignores overwrites', () => {
    const perms = channelPermissions(member(['admin']), roles, [denyViewEveryone, ow('MEMBER', 'u1', [], ['VIEW_CHANNEL'])], 'TEXT');
    expect(perms.has('VIEW_CHANNEL')).toBe(true);
    expect(perms.size).toBe(PERMISSIONS.length);
  });

  it('everyone deny then role allow restores access', () => {
    const perms = channelPermissions(member(['vip']), roles, [denyViewEveryone, ow('ROLE', 'vip', ['VIEW_CHANNEL'], [])], 'TEXT');
    expect(perms.has('VIEW_CHANNEL')).toBe(true);
    expect(channelPermissions(member([]), roles, [denyViewEveryone, ow('ROLE', 'vip', ['VIEW_CHANNEL'], [])], 'TEXT').has('VIEW_CHANNEL')).toBe(false);
  });

  it('role allow wins over another role deny on the same channel', () => {
    const perms = channelPermissions(member(['mod', 'vip']), roles, [ow('ROLE', 'mod', [], ['SEND_MESSAGES']), ow('ROLE', 'vip', ['SEND_MESSAGES'], [])], 'TEXT');
    expect(perms.has('SEND_MESSAGES')).toBe(true);
  });

  it('member overwrite beats roles', () => {
    const perms = channelPermissions(member(['vip']), roles, [ow('ROLE', 'vip', ['SEND_MESSAGES'], []), ow('MEMBER', 'u1', [], ['SEND_MESSAGES'])], 'TEXT');
    expect(perms.has('SEND_MESSAGES')).toBe(false);
    expect(perms.has('VIEW_CHANNEL')).toBe(true);
  });

  it('no VIEW_CHANNEL means nothing at all', () => {
    expect(channelPermissions(member(['mod']), roles, [denyViewEveryone], 'TEXT').size).toBe(0);
  });

  it('a voice channel without CONNECT_VOICE loses SPEAK and STREAM', () => {
    const perms = channelPermissions(member([]), roles, [ow('ROLE', 'everyone', [], ['CONNECT_VOICE'])], 'VOICE');
    expect(perms.has('VIEW_CHANNEL')).toBe(true);
    expect(perms.has('SPEAK')).toBe(false);
    expect(perms.has('STREAM')).toBe(false);
  });

  it('a text channel without SEND_MESSAGES loses ATTACH_FILES and SEND_TTS', () => {
    const perms = channelPermissions(member([]), roles, [ow('ROLE', 'everyone', [], ['SEND_MESSAGES'])], 'TEXT');
    expect(perms.has('READ_MESSAGE_HISTORY')).toBe(true);
    expect(perms.has('ATTACH_FILES')).toBe(false);
    expect(perms.has('SEND_TTS')).toBe(false);
  });

  it('overwrites for roles the member does not have are ignored', () => {
    const perms = channelPermissions(member([]), roles, [ow('ROLE', 'mod', ['MANAGE_MESSAGES'], [])], 'TEXT');
    expect(perms.has('MANAGE_MESSAGES')).toBe(false);
  });

  it('topPosition and outranks', () => {
    expect(topPosition(member(['mod', 'vip']), roles)).toBe(5);
    expect(topPosition(member([]), roles)).toBe(0);
    expect(topPosition(member([], { isOwner: true }), roles)).toBe(Infinity);
    expect(outranks(5, 5)).toBe(false);
    expect(outranks(Infinity, 5)).toBe(true);
    expect(outranks(3, 5)).toBe(false);
  });
});
