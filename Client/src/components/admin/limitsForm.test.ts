import { describe, expect, it } from 'vitest';
import { fromInput, isBytesLimit, toInput, validate } from './limitsForm';

const upload = { key: 'upload.size', scopes: ['USER' as const], default: 50 * 1024 * 1024, min: 1024, max: 100 * 1024 * 1024 };
const members = { key: 'guild.members', scopes: ['GUILD' as const], default: 500, min: 1, max: 100000 };

describe('limits form', () => {
  it('shows byte limits in MB and sends bytes', () => {
    expect(isBytesLimit('upload.size')).toBe(true);
    expect(isBytesLimit('upload.largeSize')).toBe(true);
    expect(isBytesLimit('guild.members')).toBe(false);
    expect(toInput(upload, 25 * 1024 * 1024)).toBe('25');
    expect(fromInput(upload, '25')).toBe(25 * 1024 * 1024);
    expect(fromInput(upload, '0.5')).toBe(512 * 1024);
    expect(toInput(members, 42)).toBe('42');
    expect(fromInput(members, '42')).toBe(42);
  });

  it('an empty field means "back to the default" (null)', () => {
    expect(fromInput(members, '')).toBeNull();
    expect(fromInput(members, '   ')).toBeNull();
    expect(validate(members, '')).toBeNull();
    expect(toInput(members, undefined)).toBe('');
  });

  it('rejects values outside min..max (and non-numbers) before sending', () => {
    expect(validate(members, '0')).toEqual({ min: 1, max: 100000 });
    expect(validate(members, '100001')).toEqual({ min: 1, max: 100000 });
    expect(validate(members, 'abc')).toEqual({ min: 1, max: 100000 });
    expect(validate(members, '2.5')).toEqual({ min: 1, max: 100000 });
    expect(validate(members, '250')).toBeNull();
    expect(validate(upload, '101')).toEqual({ min: 0.0009765625, max: 100 });
  });
});
