import { describe, expect, it } from 'vitest';
import { CHANNEL_PERMISSIONS, PERMISSIONS } from '../../api/types';
import { i18next } from '../../i18n';
import { PERMISSION_GROUPS, channelPermissionGroups } from './permissionGroups';

describe('permission groups', () => {
  it('puts every permission in exactly one group', () => {
    const all = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect([...all].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('names and explains every permission and group in both languages', () => {
    for (const lng of ['ru', 'en']) {
      for (const group of PERMISSION_GROUPS) expect(i18next.exists(`perms.groups.${group.id}`, { lng }), `${lng} group ${group.id}`).toBe(true);
      for (const p of PERMISSIONS) {
        expect(i18next.exists(`admin.perms.${p}.name`, { lng }), `${lng} ${p}.name`).toBe(true);
        expect(i18next.exists(`admin.perms.${p}.hint`, { lng }), `${lng} ${p}.hint`).toBe(true);
      }
    }
  });

  it('channel overwrites offer only channel permissions, without empty groups', () => {
    const groups = channelPermissionGroups();
    const offered = groups.flatMap((g) => g.permissions);
    expect(offered.every((p) => CHANNEL_PERMISSIONS.includes(p))).toBe(true);
    expect([...offered].sort()).toEqual([...CHANNEL_PERMISSIONS].sort());
    expect(groups.every((g) => g.permissions.length > 0)).toBe(true);
  });
});
