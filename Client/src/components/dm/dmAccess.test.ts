import { beforeAll, describe, expect, it } from 'vitest';
import type { Channel } from '../../api/types';
import { ApiError, friendlyError } from '../../api/errors';
import { friendsErrorText } from '../../stores/friendsStore';
import { i18next } from '../../i18n';
import { canWriteDm, dmPeer } from './dmAccess';

const dm = (memberIds: string[]): Channel => ({
  id: 'd',
  type: 'DM',
  name: 'dm',
  description: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  guildId: null,
  parentId: null,
  permissionsSynced: true,
  memberIds,
});

describe('0.7.0 direct messages need friendship', () => {
  beforeAll(async () => {
    await i18next.changeLanguage('en');
  });

  it('1:1 DMs need a friend; group DMs stay writable', () => {
    expect(canWriteDm(dm(['me', 'bob']), 'me', () => false)).toBe(false);
    expect(canWriteDm(dm(['me', 'bob']), 'me', (id) => id === 'bob')).toBe(true);
    expect(canWriteDm(dm(['me', 'bob', 'cid']), 'me', () => false)).toBe(true);
    expect(dmPeer(dm(['me', 'bob']), 'me')).toBe('bob');
    expect(dmPeer(dm(['me', 'bob', 'cid']), 'me')).toBeNull();
  });

  it('explains a NOT_FRIENDS send error and ALREADY_FRIENDS in plain words', () => {
    expect(friendlyError(new ApiError('http', 403, 'NOT_FRIENDS', 'raw'))).toBe('You can only send direct messages to friends.');
    expect(friendsErrorText(new ApiError('http', 409, 'ALREADY_FRIENDS', 'raw'))).toBe('You are already friends.');
  });
});
