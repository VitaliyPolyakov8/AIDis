import { describe, expect, it } from 'vitest';
import { nextSpeaking, RELEASE_MS, SPEAKING_DB } from './speakingDetector';

describe('speaking detection', () => {
  const quiet = { speaking: false, lastLoudAt: 0 };

  it('starts on the first loud sample (no start delay)', () => {
    expect(nextSpeaking(quiet, SPEAKING_DB + 1, 1000)).toEqual({ speaking: true, lastLoudAt: 1000 });
    expect(nextSpeaking(quiet, SPEAKING_DB - 10, 1000).speaking).toBe(false);
  });

  it('holds briefly after the voice stops, then releases', () => {
    let s = nextSpeaking(quiet, -20, 1000);
    s = nextSpeaking(s, -90, 1000 + RELEASE_MS - 50); // pause between syllables
    expect(s.speaking).toBe(true);
    s = nextSpeaking(s, -20, 1000 + RELEASE_MS); // talking again keeps it on
    s = nextSpeaking(s, -90, 1000 + RELEASE_MS * 2 + 10);
    expect(s.speaking).toBe(false);
  });
});
