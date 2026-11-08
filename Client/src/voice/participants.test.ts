import { describe, expect, it } from 'vitest';
import { mergePolledOccupancy, reconcileParticipants, type VoiceParticipant } from './voiceStore';

const p = (identity: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  identity,
  name: identity,
  isLocal: identity === 'me',
  isSpeaking: false,
  micMuted: false,
  screenSharing: false,
  ...extra,
});

describe('reconcileParticipants', () => {
  it('removes a participant immediately when LiveKit reports them gone while we are connected', () => {
    const before = [p('me'), p('bob')];
    expect(reconcileParticipants(before, [p('me')], 'connected').map((x) => x.identity)).toEqual(['me']);
  });

  it('keeps participants while our own connection is reconnecting', () => {
    const before = [p('me'), p('bob', { isSpeaking: true })];
    // A full LiveKit reconnect clears the remote participant list although nobody left.
    const during = reconcileParticipants(before, [p('me')], 'reconnecting');
    expect(during.map((x) => x.identity)).toEqual(['me', 'bob']);
    expect(during.find((x) => x.identity === 'bob')?.isSpeaking).toBe(false);
  });

  it('after reconnecting, removes whoever really left and keeps the rest', () => {
    const during = reconcileParticipants([p('me'), p('bob'), p('carol')], [p('me')], 'reconnecting');
    const after = reconcileParticipants(during, [p('me'), p('carol')], 'connected');
    expect(after.map((x) => x.identity)).toEqual(['me', 'carol']);
  });

  it('adds people who joined during the reconnect and refreshes known ones', () => {
    const during = reconcileParticipants([p('me'), p('bob')], [p('me'), p('bob', { micMuted: true }), p('dave')], 'reconnecting');
    expect(during.map((x) => x.identity)).toEqual(['me', 'bob', 'dave']);
    expect(during.find((x) => x.identity === 'bob')?.micMuted).toBe(true);
  });
});

describe('mergePolledOccupancy', () => {
  const base = {
    occupancy: { general: [{ identity: 'me', name: 'Me', joinedAt: null }], gaming: [] },
    occupancyLiveAt: {} as Record<string, number>,
    channelId: null as string | null,
    status: 'idle' as const,
  };

  it('updates channels we are not in', () => {
    const next = mergePolledOccupancy(base, { gaming: [{ identity: 'bob', name: 'Bob', joinedAt: null }] }, 1000);
    expect(next.gaming).toHaveLength(1);
  });

  it('never overrides the channel we are connected to (LiveKit is the source of truth there)', () => {
    const state = { ...base, channelId: 'general', status: 'connected' as const };
    const next = mergePolledOccupancy(state, { general: [{ identity: 'ghost', name: 'Ghost', joinedAt: null }] }, 1000);
    expect(next.general?.map((x) => x.identity)).toEqual(['me']);
  });

  it('ignores a poll that started before the live update (e.g. right after we left)', () => {
    const state = { ...base, occupancy: { general: [] }, occupancyLiveAt: { general: 2000 } };
    // This poll was sent at t=1000 while we were still in the call and returned us as a member.
    const stale = mergePolledOccupancy(state, { general: [{ identity: 'me', name: 'Me', joinedAt: null }] }, 1000);
    expect(stale.general).toEqual([]);
    // A poll started after we left is applied normally.
    const fresh = mergePolledOccupancy(state, { general: [{ identity: 'bob', name: 'Bob', joinedAt: null }] }, 3000);
    expect(fresh.general?.map((x) => x.identity)).toEqual(['bob']);
  });
});
