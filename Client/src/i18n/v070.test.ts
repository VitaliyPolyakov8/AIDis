import { describe, expect, it } from 'vitest';
import { enV070, mergeDictionaries, ruV070 } from './v070';
import { i18next } from './index';

type Tree = { [key: string]: string | Tree };
function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
}

describe('0.7.0 dictionaries', () => {
  it('Russian and English have the same 0.7.0 keys', () => {
    expect(keys(enV070 as unknown as Tree).sort()).toEqual(keys(ruV070 as unknown as Tree).sort());
  });

  it('merges into the base dictionaries without dropping old keys', () => {
    const merged = mergeDictionaries({ errors: { OLD: 'a' }, other: 'b' }, { errors: { NEW: 'c' } }) as unknown as Tree;
    expect(merged).toEqual({ errors: { OLD: 'a', NEW: 'c' }, other: 'b' });
    expect(i18next.exists('errors.NOT_FRIENDS')).toBe(true);
    expect(i18next.exists('errors.fallback')).toBe(true);
  });
});
