import { describe, expect, it } from 'vitest';
import { enV071, ruV071 } from './v071';
import { i18next } from './index';

type Tree = { [key: string]: string | Tree };
function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
}

describe('0.7.1 dictionaries', () => {
  it('Russian and English have the same 0.7.1 keys', () => {
    expect(keys(enV071 as unknown as Tree).sort()).toEqual(keys(ruV071 as unknown as Tree).sort());
  });

  it('are merged in without dropping 0.7.0 keys', () => {
    expect(i18next.exists('errors.TOKEN_INVALID')).toBe(true);
    expect(i18next.exists('errors.INVITE_INVALID')).toBe(true);
    expect(i18next.exists('adminPanel.tabs.mail')).toBe(true);
    expect(i18next.exists('adminPanel.tabs.nodes')).toBe(true);
    expect(i18next.exists('login.submit')).toBe(true);
  });
});
