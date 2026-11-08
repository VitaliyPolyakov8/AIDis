import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const { seasonOf, activeSeason, isBirthdayToday } = await import('./utils/season');
const { nameStyleOf } = await import('./components/profile/nameStyle');
const { spatialMix, defaultSpot, micBitrateBps, bitrateIndex, clampToRoom, ROOM_FULL_DISTANCE, ROOM_SILENT_DISTANCE, ROOM_WIDTH } = await import('./voice/channelVoice');
const { thumbnailSize } = await import('./voice/streamThumbnails');
const { resumeKeyOf, isRetryableUploadError, LARGE_UPLOAD_THRESHOLD } = await import('./api/attachments');
const { ApiError } = await import('./api/errors');
const { playedAgo } = await import('./games/gameMeta');
const { Confetti } = await import('./components/profile/Confetti');
const { sanitizeSettings } = await import('./stores/settingsStore');

describe('0.5.5 seasons and birthdays', () => {
  it('knows the New Year and Halloween windows', () => {
    expect(seasonOf(new Date(2026, 11, 19))).toBeNull();
    expect(seasonOf(new Date(2026, 11, 20))).toBe('newyear');
    expect(seasonOf(new Date(2027, 0, 10))).toBe('newyear');
    expect(seasonOf(new Date(2027, 0, 11))).toBeNull();
    expect(seasonOf(new Date(2026, 9, 24))).toBeNull();
    expect(seasonOf(new Date(2026, 9, 31))).toBe('halloween');
    expect(seasonOf(new Date(2026, 10, 1))).toBe('halloween');
    expect(seasonOf(new Date(2026, 10, 2))).toBeNull();
  });

  it('lets the setting force or disable the season', () => {
    const july = new Date(2026, 6, 1);
    expect(activeSeason('auto', july)).toBeNull();
    expect(activeSeason('halloween', july)).toBe('halloween');
    expect(activeSeason('off', new Date(2026, 11, 31))).toBeNull();
    expect(sanitizeSettings({ seasonalTheme: 'summer' as never }).seasonalTheme).toBe('auto');
  });

  it('shows Feb 29 birthdays on Feb 28 in other years', () => {
    expect(isBirthdayToday({ month: 3, day: 5 }, new Date(2026, 2, 5))).toBe(true);
    expect(isBirthdayToday({ month: 3, day: 5 }, new Date(2026, 2, 6))).toBe(false);
    expect(isBirthdayToday({ month: 2, day: 29 }, new Date(2027, 1, 28))).toBe(true);
    expect(isBirthdayToday({ month: 2, day: 29 }, new Date(2028, 1, 28))).toBe(false);
    expect(isBirthdayToday({ month: 2, day: 29 }, new Date(2028, 1, 29))).toBe(true);
    expect(isBirthdayToday(null, new Date())).toBe(false);
  });

  it('draws confetti pieces', () => {
    const { container } = render(<Confetti count={12} />);
    expect(container.querySelectorAll('.confetti-piece')).toHaveLength(12);
  });
});

describe('0.5.5 name styles', () => {
  it('builds a gradient, glow and font only from known values', () => {
    const plain = nameStyleOf({ nicknameColor: '#ff6b6b' });
    expect(plain.className).toBe('styled-name');
    expect(plain.style.color).toBe('#ff6b6b');
    const fancy = nameStyleOf({ nicknameColor: '#ff6b6b', nicknameColor2: '#48dbfb', nicknameGlow: true, nicknameFont: 'lobster' });
    expect(fancy.className).toContain('is-gradient');
    expect(fancy.className).toContain('is-glow');
    expect(fancy.style.backgroundImage).toBe('linear-gradient(90deg, #ff6b6b, #48dbfb)');
    expect(String(fancy.style.fontFamily)).toContain('Lobster');
    // A font id from nowhere and CSS instead of a color are ignored.
    const hostile = nameStyleOf({ nicknameColor: 'red; background: url(x)', nicknameFont: 'comic' as never });
    expect(hostile.className).toBe('styled-name');
    expect(hostile.style.color).toBeUndefined();
    expect(hostile.style.fontFamily).toBeUndefined();
  });

  it('uses the fallback color (role / accent) when no name color is set', () => {
    expect(nameStyleOf({}, '#abcdef').style.color).toBe('#abcdef');
  });
});

describe('0.5.5 voice channel settings', () => {
  it('maps channel bitrates to the microphone', () => {
    expect(micBitrateBps(undefined)).toBe(64_000);
    expect(micBitrateBps(128)).toBe(128_000);
    expect(micBitrateBps(1000)).toBe(256_000);
    expect(micBitrateBps(2)).toBe(8_000);
    expect(bitrateIndex(64)).toBe(5);
    expect(bitrateIndex(999)).toBe(10);
  });

  it('fades voices with distance and pans them', () => {
    const me = { x: 500, y: 300 };
    expect(spatialMix(me, { x: 500 + ROOM_FULL_DISTANCE - 1, y: 300 })).toEqual({ gain: 1, pan: expect.any(Number) as number });
    expect(spatialMix(me, { x: 500 + ROOM_SILENT_DISTANCE, y: 300 }).gain).toBe(0);
    const middle = spatialMix(me, { x: 500, y: 300 + (ROOM_FULL_DISTANCE + ROOM_SILENT_DISTANCE) / 2 });
    expect(middle.gain).toBeGreaterThan(0);
    expect(middle.gain).toBeLessThan(1);
    expect(spatialMix(me, { x: 200, y: 300 }).pan).toBeLessThan(0);
    expect(spatialMix(me, { x: 800, y: 300 }).pan).toBeGreaterThan(0);
  });

  it('keeps everyone inside the room with a stable starting spot', () => {
    expect(clampToRoom({ x: -50, y: 9999 }).x).toBe(30);
    expect(defaultSpot('user-a')).toEqual(defaultSpot('user-a'));
    const spot = defaultSpot('user-b');
    expect(spot.x).toBeGreaterThanOrEqual(30);
    expect(spot.x).toBeLessThanOrEqual(ROOM_WIDTH - 30);
  });
});

describe('0.5.5 stream previews and large files', () => {
  it('sizes snapshots to 320 px wide, keeping the aspect ratio', () => {
    expect(thumbnailSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(thumbnailSize(1280, 1024)).toEqual({ width: 320, height: 256 });
    expect(thumbnailSize(200, 100)).toEqual({ width: 200, height: 100 });
    expect(thumbnailSize(0, 0)).toEqual({ width: 320, height: 180 });
  });

  it('resumes the same file and retries only temporary failures', () => {
    expect(resumeKeyOf({ name: 'movie.mp4', size: 5, lastModified: 7 })).toBe('movie.mp4|5|7');
    expect(LARGE_UPLOAD_THRESHOLD).toBe(40 * 1024 * 1024);
    expect(isRetryableUploadError(ApiError.network())).toBe(true);
    expect(isRetryableUploadError(ApiError.timeout())).toBe(true);
    expect(isRetryableUploadError(new ApiError('http', 503, 'X', 'x'))).toBe(true);
    expect(isRetryableUploadError(new ApiError('http', 413, 'PAYLOAD_TOO_LARGE', 'x'))).toBe(false);
    expect(isRetryableUploadError(ApiError.aborted())).toBe(false);
  });
});

describe('0.5.5 recently played', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('says when a game was played in the UI language', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(playedAgo('2026-10-19T11:30:00Z', 'en', now)).toBe('30 minutes ago');
    expect(playedAgo('2026-10-18T12:00:00Z', 'en', now)).toBe('yesterday');
    expect(playedAgo('2026-10-16T12:00:00Z', 'ru', now)).toBe('3 дня назад');
  });
});
