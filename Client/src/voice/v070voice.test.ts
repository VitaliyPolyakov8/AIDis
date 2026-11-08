import { describe, expect, it } from 'vitest';
import type { Channel } from '../api/types';
import { nextForDeafenToggle, nextForMicToggle } from './voiceStore';
import { moveTargets } from '../components/voice/moveTargets';
import { searchScope } from '../components/chat/searchScope';

const ch = (id: string, guildId: string | null, type: Channel['type'] = 'VOICE'): Channel => ({
  id,
  guildId,
  type,
  name: id,
  description: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  parentId: null,
  permissionsSynced: true,
});

describe('0.7.0 server mute / deafen', () => {
  const muted = { muted: true, deafened: false };
  const deafened = { muted: false, deafened: true };

  it('a server-muted person cannot turn the microphone on', () => {
    expect(nextForMicToggle({ micEnabled: false, deafened: false, micBeforeDeafen: false }, muted)).toMatchObject({ micEnabled: false });
    // Undeafening still works, the microphone stays off.
    expect(nextForMicToggle({ micEnabled: false, deafened: true, micBeforeDeafen: true }, muted)).toMatchObject({ micEnabled: false, deafened: false });
    expect(nextForDeafenToggle({ micEnabled: false, deafened: true, micBeforeDeafen: true }, muted)).toMatchObject({ micEnabled: false, deafened: false });
  });

  it('a server-deafened person stays deafened', () => {
    expect(nextForDeafenToggle({ micEnabled: false, deafened: true, micBeforeDeafen: true }, deafened)).toMatchObject({ deafened: true, micEnabled: false });
    expect(nextForMicToggle({ micEnabled: false, deafened: true, micBeforeDeafen: true }, deafened)).toMatchObject({ deafened: true, micEnabled: false });
  });

  it('without a lock nothing changes from 0.6', () => {
    expect(nextForMicToggle({ micEnabled: false, deafened: false, micBeforeDeafen: false })).toMatchObject({ micEnabled: true });
    expect(nextForDeafenToggle({ micEnabled: true, deafened: false, micBeforeDeafen: false })).toMatchObject({ deafened: true, micEnabled: false });
  });
});

describe('0.7.0 moving people', () => {
  it('offers only voice channels of the same server', () => {
    const channels = [ch('a1', 'A'), ch('a2', 'A'), ch('b1', 'B'), ch('at', 'A', 'TEXT')];
    expect(moveTargets(channels, 'a1').map((c) => c.id)).toEqual(['a2']);
    expect(moveTargets(channels, 'unknown')).toEqual([]);
  });
});

describe('0.7.0 search scope', () => {
  it('searches the open server, a DM list, or one channel', () => {
    expect(searchScope('all', ch('t', 'G', 'TEXT'), 'G')).toEqual({ guildId: 'G' });
    expect(searchScope('all', ch('d', null, 'DM'), null)).toEqual({ dms: true });
    expect(searchScope('all', undefined, null)).toEqual({ dms: true });
    expect(searchScope('all', undefined, 'G')).toEqual({ guildId: 'G' });
    expect(searchScope('channel', ch('t', 'G', 'TEXT'), 'G')).toEqual({ channelId: 't' });
  });
});
