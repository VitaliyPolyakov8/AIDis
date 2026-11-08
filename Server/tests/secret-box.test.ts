import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/common/secret-box.js';

describe('0.7.1 secret box (voice node secrets, SMTP password)', () => {
  const box = createSecretBox('a-server-secret-that-is-long-enough-0123456789');

  it('opens what it sealed', () => {
    expect(box.open(box.seal('livekit-api-secret'))).toBe('livekit-api-secret');
    expect(box.open(box.seal(''))).toBe('');
  });

  it('never seals the same text the same way', () => {
    expect(box.seal('x')).not.toBe(box.seal('x'));
  });

  it('rejects a changed byte and another server secret', () => {
    const sealed = Buffer.from(box.seal('secret'), 'base64');
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    expect(() => box.open(sealed.toString('base64'))).toThrow();
    const other = createSecretBox('another-server-secret-that-is-long-enough-012345');
    expect(() => other.open(box.seal('secret'))).toThrow();
  });
});
