import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendsApi } from '../api/friends';
import { ApiError } from '../api/errors';
import { friendsErrorText, useFriendsStore } from './friendsStore';

describe('friendsStore', () => {
  beforeEach(() => {
    useFriendsStore.getState().reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads friends and requests', async () => {
    vi.spyOn(friendsApi, 'state').mockResolvedValue({ friends: [{ userId: 'b', since: 'x' }], incoming: [{ userId: 'c', createdAt: 'x' }], outgoing: [] });
    await useFriendsStore.getState().load();
    const s = useFriendsStore.getState();
    expect(s.friendIds).toEqual(['b']);
    expect(s.incoming).toEqual(['c']);
    expect(s.isFriend('b')).toBe(true);
    expect(s.isFriend('c')).toBe(false);
  });

  it('reloads after a request and reports an accepted one', async () => {
    vi.spyOn(friendsApi, 'request').mockResolvedValue({ status: 'accepted' });
    const state = vi.spyOn(friendsApi, 'state').mockResolvedValue({ friends: [{ userId: 'bob', since: 'x' }], incoming: [], outgoing: [] });
    expect(await useFriendsStore.getState().request('bob')).toBe('accepted');
    expect(state).toHaveBeenCalledTimes(1);
    expect(useFriendsStore.getState().friendIds).toEqual(['bob']);
  });

  it('turns server error codes into readable text', () => {
    const notFound = new ApiError('http', 404, 'USER_NOT_FOUND', 'No user with this name');
    const generic = friendsErrorText(new Error('boom'));
    expect(friendsErrorText(notFound)).not.toBe(generic);
    expect(friendsErrorText(new ApiError('http', 409, 'ALREADY_FRIENDS', 'x'))).not.toBe(friendsErrorText(notFound));
  });
});
