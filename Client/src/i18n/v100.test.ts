import { describe, expect, it } from 'vitest';
import { enV100, ruV100 } from './v100';
import { i18next } from './index';

type Tree = { [key: string]: string | string[] | Tree };
function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' || Array.isArray(v) ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
}

describe('1.0 dictionaries', () => {
  it('Russian and English have the same 1.0 keys', () => {
    expect(keys(enV100 as unknown as Tree).sort()).toEqual(keys(ruV100 as unknown as Tree).sort());
    expect(enV100.setup.steps).toHaveLength(ruV100.setup.steps.length);
  });

  it('are merged in after the older dictionaries', () => {
    expect(i18next.exists('setup.title')).toBe(true);
    expect(i18next.exists('errors.SETUP_CODE_INVALID')).toBe(true);
    expect(i18next.exists('errors.TOKEN_INVALID')).toBe(true);
  });
});
