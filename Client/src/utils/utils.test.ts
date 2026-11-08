import { describe, expect, it } from 'vitest';
import { formatDayDivider, formatLastSeen, formatMessageTimestamp } from './time';
import { linkify } from './linkify';
import { initials, avatarColor } from './avatar';
import { createNonce } from './nonce';
import { formatBytes } from './format';
import { describeTyping, isGroupedWith } from './chat';
import { validateLogin } from './validation';
import { makeMessage, bob } from '../test/fixtures';

const now = new Date(2026, 9, 5, 15, 0, 0);

describe('timestamps', () => {
  it('formats today, yesterday and older dates without raw ISO strings', () => {
    expect(formatMessageTimestamp(new Date(2026, 9, 5, 13, 42).toISOString(), now)).toBe('Today at 13:42');
    expect(formatMessageTimestamp(new Date(2026, 9, 4, 9, 5).toISOString(), now)).toBe('Yesterday at 09:05');
    expect(formatMessageTimestamp(new Date(2026, 8, 30, 21, 15).toISOString(), now)).toBe('30.09.2026 21:15');
    expect(formatDayDivider(new Date(2026, 9, 5, 1).toISOString(), now)).toBe('Today');
  });

  it('describes last seen', () => {
    expect(formatLastSeen(null, now)).toBe('Never seen');
    expect(formatLastSeen(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('Last seen 5 min ago');
    expect(formatLastSeen(new Date(now.getTime() - 3 * 3_600_000).toISOString(), now)).toBe('Last seen 3 h ago');
  });
});

describe('linkify', () => {
  it('extracts http(s) links and keeps trailing punctuation as text', () => {
    expect(linkify('see https://example.com/a. ok')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com/a', href: 'https://example.com/a' },
      { type: 'text', value: '. ok' },
    ]);
  });

  it('never turns javascript: or html into links', () => {
    expect(linkify('<img src=x onerror=alert(1)> javascript:alert(1)')).toEqual([
      { type: 'text', value: '<img src=x onerror=alert(1)> javascript:alert(1)' },
    ]);
  });
});

describe('misc helpers', () => {
  it('builds initials and stable colours', () => {
    expect(initials('Valentine')).toBe('V');
    expect(initials('Friend Two')).toBe('FT');
    expect(avatarColor('abc')).toBe(avatarColor('abc'));
  });

  it('creates server-compatible nonces', () => {
    expect(createNonce()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(createNonce()).not.toBe(createNonce());
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5.9 * 1024)).toBe('5.9 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('groups consecutive messages of one author within 7 minutes', () => {
    const a = makeMessage({ createdAt: '2026-10-05T10:00:00.000Z' });
    const b = makeMessage({ createdAt: '2026-10-05T10:05:00.000Z' });
    const c = makeMessage({ createdAt: '2026-10-05T10:20:00.000Z' });
    const d = makeMessage({ createdAt: '2026-10-05T10:21:00.000Z', author: bob });
    expect(isGroupedWith(a, b)).toBe(true);
    expect(isGroupedWith(b, c)).toBe(false);
    expect(isGroupedWith(c, d)).toBe(false);
    expect(isGroupedWith(undefined, a)).toBe(false);
  });

  it('describes who is typing', () => {
    expect(describeTyping([])).toBe('');
    expect(describeTyping(['Friend'])).toBe('Friend is typing…');
    expect(describeTyping(['A', 'B'])).toBe('A and B are typing…');
    expect(describeTyping(['A', 'B', 'C'])).toBe('Several people are typing…');
  });

  it('validates the login form', () => {
    expect(validateLogin('', '')).toEqual({ username: 'Enter your username.', password: 'Enter your password.' });
    expect(validateLogin('  ', 'x')).toEqual({ username: 'Enter your username.' });
    expect(validateLogin('valentine', 'secret')).toEqual({});
  });
});
