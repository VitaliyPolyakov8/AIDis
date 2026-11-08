import { afterEach, describe, expect, it, vi } from 'vitest';

const { parseTtsCommand, ttsText, shouldSpeak, pickVoice, TTS_MAX_CHARS } = await import('./voice/tts');
const { occupantDropAction } = await import('./components/voice/voiceDrag');
const steamArt = await import('./utils/steamArt');
const { metaApi } = await import('./api/meta');
const { sanitizeSettings } = await import('./stores/settingsStore');

describe('0.5.2 TTS', () => {
  it('turns "/tts text" into a TTS message and leaves other text alone', () => {
    expect(parseTtsCommand('/tts привет всем')).toEqual({ text: 'привет всем', tts: true });
    expect(parseTtsCommand('/TTS   hi')).toEqual({ text: 'hi', tts: true });
    expect(parseTtsCommand('/ttsno')).toEqual({ text: '/ttsno', tts: false });
    expect(parseTtsCommand('hello /tts')).toEqual({ text: 'hello /tts', tts: false });
  });

  it('reads links as a word, mentions as display names, and cuts long text', () => {
    const names = (u: string) => (u === 'bob' ? 'Боб' : null);
    expect(ttsText('Смотри https://example.com/a?b=1 @bob и @nobody', names, 'ссылка')).toBe('Смотри ссылка Боб и nobody');
    expect(ttsText('   ', names, 'link')).toBeNull();
    expect(ttsText('**жирный**', names, 'link')).toBe('жирный');
    const long = ttsText('а'.repeat(1000), names, 'link');
    expect(long?.length).toBe(TTS_MAX_CHARS + 1);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('speaks only TTS messages of the call we are in, from others, when listening and not deafened', () => {
    const ctx = { selfId: 'me', callChannelId: 'vc', deafened: false, listen: true, locallyMuted: (id: string) => id === 'muted' };
    const msg = { tts: true, channelId: 'vc', content: 'hi', author: { id: 'bob' } };
    expect(shouldSpeak(msg, ctx)).toBe(true);
    expect(shouldSpeak({ ...msg, tts: false }, ctx)).toBe(false);
    expect(shouldSpeak({ ...msg, tts: undefined }, ctx)).toBe(false);
    expect(shouldSpeak({ ...msg, channelId: 'other' }, ctx)).toBe(false);
    expect(shouldSpeak({ ...msg, author: { id: 'me' } }, ctx)).toBe(false);
    expect(shouldSpeak({ ...msg, author: { id: 'muted' } }, ctx)).toBe(false);
    expect(shouldSpeak(msg, { ...ctx, deafened: true })).toBe(false);
    expect(shouldSpeak(msg, { ...ctx, listen: false })).toBe(false);
    expect(shouldSpeak(msg, { ...ctx, callChannelId: null })).toBe(false);
  });

  it('uses the chosen voice, else one for the text language, else the default', () => {
    const voices = [
      { voiceURI: 'en', lang: 'en-US', default: true },
      { voiceURI: 'ru', lang: 'ru-RU', default: false },
    ];
    expect(pickVoice(voices, 'en', 'привет')).toBe(0);
    expect(pickVoice(voices, null, 'привет')).toBe(1);
    expect(pickVoice(voices, 'gone', 'hello')).toBe(0);
    expect(pickVoice([{ voiceURI: 'de', lang: 'de-DE', default: true }], null, 'привет')).toBe(0);
  });

  it('keeps TTS settings in range', () => {
    const s = sanitizeSettings({ ttsVolume: 500, ttsRate: 10, ttsListen: 'x' as never, ttsSend: 1 as never, ttsVoiceUri: 5 as never });
    expect(s.ttsVolume).toBe(100);
    expect(s.ttsRate).toBe(50);
    expect(s.ttsListen).toBe(true);
    expect(s.ttsSend).toBe(false);
    expect(s.ttsVoiceUri).toBeNull();
  });
});

describe('0.5.2 drag people between voice channels', () => {
  const dragged = { userId: 'bob', name: 'Bob', fromChannelId: 'a' };
  it('moves others only with MOVE_USERS, joins for yourself, ignores the same channel', () => {
    expect(occupantDropAction(dragged, 'b', 'me', true)).toBe('move');
    expect(occupantDropAction(dragged, 'b', 'me', false)).toBe('none');
    expect(occupantDropAction({ ...dragged, userId: 'me' }, 'b', 'me', false)).toBe('join');
    expect(occupantDropAction(dragged, 'a', 'me', true)).toBe('none');
    expect(occupantDropAction(null, 'b', 'me', true)).toBe('none');
  });
});

describe('0.5.2 Steam art for newer games', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    steamArt.resetSteamArtCache();
  });

  it('asks the server for the real (hashed) URL once both fixed CDN paths fail', async () => {
    const real = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2968420/abc/header.jpg';
    const spy = vi.spyOn(metaApi, 'steamArt').mockResolvedValue({ appId: 2968420, header: real, capsule: null });
    const first = steamArt.steamArtUrl(2968420, 'header') ?? '';
    const second = steamArt.steamArtFailed(2968420, 'header', first) ?? '';
    expect(steamArt.steamArtFailed(2968420, 'header', second)).toBeNull();
    expect(await steamArt.resolveSteamArt(2968420, 'header')).toBe(real);
    // Remembered: the next mount starts with the working URL, without another lookup.
    expect(steamArt.steamArtUrl(2968420, 'header')).toBe(real);
    expect(await steamArt.resolveSteamArt(2968420, 'capsule')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never offers a looked-up URL again after it failed (no retry loop)', async () => {
    const real = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/x/header.jpg';
    vi.spyOn(metaApi, 'steamArt').mockResolvedValue({ appId: 1, header: real, capsule: null });
    expect(await steamArt.resolveSteamArt(1, 'header')).toBe(real);
    expect(steamArt.steamArtFailed(1, 'header', real)).toBeNull();
    expect(await steamArt.resolveSteamArt(1, 'header')).toBeNull();
  });

  it('forgets "no image" after 6 hours (a network error must not hide art for a week)', () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const a = steamArt.steamArtUrl(42, 'header') ?? '';
    const b = steamArt.steamArtFailed(42, 'header', a) ?? '';
    steamArt.steamArtFailed(42, 'header', b);
    expect(steamArt.steamArtUrl(42, 'header')).toBeNull();
    spy.mockReturnValue(now + 7 * 3600_000);
    expect(steamArt.steamArtUrl(42, 'header')).toBe(a);
  });
});
