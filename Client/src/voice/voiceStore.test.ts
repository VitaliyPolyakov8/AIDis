import { describe, expect, it } from 'vitest';
import { nextForDeafenToggle, nextForMicToggle, pickFocusedShare, type VoiceParticipant } from './voiceStore';

const p = (identity: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  identity,
  name: identity,
  isLocal: false,
  isSpeaking: false,
  micMuted: false,
  screenSharing: false,
  ...extra,
});

describe('mute / deafen logic', () => {
  it('toggles the microphone', () => {
    const muted = nextForMicToggle({ micEnabled: true, deafened: false, micBeforeDeafen: true });
    expect(muted.micEnabled).toBe(false);
    expect(nextForMicToggle(muted).micEnabled).toBe(true);
  });

  it('deafen mutes the mic and undeafen restores the previous mic state', () => {
    const deaf = nextForDeafenToggle({ micEnabled: true, deafened: false, micBeforeDeafen: true });
    expect(deaf).toEqual({ micEnabled: false, deafened: true, micBeforeDeafen: true });
    expect(nextForDeafenToggle(deaf)).toEqual({ micEnabled: true, deafened: false, micBeforeDeafen: true });

    const mutedThenDeaf = nextForDeafenToggle({ micEnabled: false, deafened: false, micBeforeDeafen: true });
    expect(nextForDeafenToggle(mutedThenDeaf).micEnabled).toBe(false);
  });

  it('unmuting while deafened also undeafens', () => {
    expect(nextForMicToggle({ micEnabled: false, deafened: true, micBeforeDeafen: false })).toEqual({
      micEnabled: true,
      deafened: false,
      micBeforeDeafen: true,
    });
  });
});

describe('screen share focus', () => {
  it('prefers a remote share, keeps the current one while it exists', () => {
    const list = [p('me', { isLocal: true, screenSharing: true }), p('friend', { screenSharing: true }), p('other')];
    expect(pickFocusedShare(list, null)).toBe('friend');
    expect(pickFocusedShare(list, 'me')).toBe('me');
    expect(pickFocusedShare([p('other')], 'friend')).toBeNull();
  });
});
