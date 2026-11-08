import { beforeEach, describe, expect, it } from 'vitest';
import { findInviteCodes, savePendingInvite, takePendingInvite } from './inviteLinks';

describe('invite links in messages', () => {
  it('finds invite codes in links, once each, and leaves other links alone', () => {
    expect(findInviteCodes('смотри https://d.example/invite/abcd2345 и ещё')).toEqual(['abcd2345']);
    expect(findInviteCodes('https://d.example/invite/ABCD2345 http://x.test:8080/invite/zzzz9999?x=1 https://d.example/invite/abcd2345')).toEqual(['abcd2345', 'zzzz9999']);
    expect(findInviteCodes('https://d.example/channels/abcd2345 https://d.example/invite/short /invite/abcd2345')).toEqual([]);
    // Ambiguous letters (l, i, o, 0, 1) are not in the code alphabet.
    expect(findInviteCodes('https://d.example/invite/abcd1234')).toEqual([]);
  });
});

describe('pending invite (opened before login)', () => {
  beforeEach(() => sessionStorage.clear());
  it('is kept once and read once', () => {
    savePendingInvite('abcd2345');
    expect(takePendingInvite()).toBe('abcd2345');
    expect(takePendingInvite()).toBeNull();
  });
  it('ignores garbage', () => {
    sessionStorage.setItem('aidis.pendingInvite', 'not a code');
    expect(takePendingInvite()).toBeNull();
  });
});
