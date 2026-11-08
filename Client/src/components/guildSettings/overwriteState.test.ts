import { describe, expect, it } from 'vitest';
import type { OverwriteView } from '../../api/types';
import { cycle, fromOverwrite, isEmpty, stateOf, toPayload, withState } from './overwriteState';

describe('channel overwrite editing', () => {
  const o: OverwriteView = { targetType: 'ROLE', targetId: 'r', allow: ['SEND_MESSAGES', 'CONNECT_VOICE'], deny: ['VIEW_CHANNEL'] };

  it('round-trips an overwrite', () => {
    const payload = toPayload(fromOverwrite(o));
    expect([...payload.allow].sort()).toEqual([...o.allow].sort());
    expect(payload.deny).toEqual(['VIEW_CHANNEL']);
  });

  it('cycles inherit -> allow -> deny -> inherit', () => {
    expect(cycle('inherit')).toBe('allow');
    expect(cycle('allow')).toBe('deny');
    expect(cycle('deny')).toBe('inherit');
  });

  it('sets one permission and knows when nothing is left', () => {
    let map = fromOverwrite(o);
    expect(stateOf(map, 'VIEW_CHANNEL')).toBe('deny');
    expect(stateOf(map, 'ATTACH_FILES')).toBe('inherit');
    map = withState(map, 'VIEW_CHANNEL', 'allow');
    expect(toPayload(map).allow).toContain('VIEW_CHANNEL');
    map = withState(withState(withState(map, 'VIEW_CHANNEL', 'inherit'), 'SEND_MESSAGES', 'inherit'), 'CONNECT_VOICE', 'inherit');
    expect(isEmpty(map)).toBe(true);
  });

  it('drops server-wide permissions (e.g. BAN_MEMBERS) that mean nothing in a channel', () => {
    const map = fromOverwrite({ ...o, allow: ['BAN_MEMBERS', 'SEND_MESSAGES'] });
    expect(toPayload(map).allow).toEqual(['SEND_MESSAGES']);
    expect(withState(map, 'BAN_MEMBERS', 'allow')).toEqual(map);
  });
});
