import { describe, expect, it } from 'vitest';
import { initials } from './avatar';

describe('initials', () => {
  it('skips brackets and symbols (0.7.0 server nicknames like "Виталий (хозяин)")', () => {
    expect(initials('Виталий (хозяин)')).toBe('ВХ');
    expect(initials('[AFK] Боб')).toBe('AБ');
    expect(initials('Боб')).toBe('Б');
    expect(initials('  ')).toBe('?');
    expect(initials('🔥')).toBe('🔥');
  });
});
