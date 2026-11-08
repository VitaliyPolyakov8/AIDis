/**
 * 0.5.2 text-to-speech: messages sent with "read aloud" (TTS) in a voice channel's chat or a DM are
 * spoken on the devices of the people in that call. Speech is produced locally by the system's own
 * voices (Web Speech API: SAPI / OneCore voices on Windows); nothing goes through the server or
 * LiveKit. Each listener decides: Settings → Voice → "Read TTS messages aloud", voice, volume, rate.
 */
import type { Message } from '../api/types';
import { t } from '../i18n';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceStore } from './voiceStore';
import { emojiShortcodes } from '../emojis/tokens';

/** Longest text that is read aloud (the rest is cut, so a pasted wall of text cannot hold the call hostage). */
export const TTS_MAX_CHARS = 300;
/** A message typed as "/tts text" is sent as a TTS message. */
export const TTS_COMMAND = /^\/tts\s+/i;

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** "/tts hello" -> { text: "hello", tts: true }; anything else unchanged. Pure (unit-tested). */
export function parseTtsCommand(text: string): { text: string; tts: boolean } {
  return TTS_COMMAND.test(text) ? { text: text.replace(TTS_COMMAND, '').trim(), tts: true } : { text, tts: false };
}

/**
 * The words to say for a message: links become "link", @username becomes the display name,
 * markup-ish runs and whitespace collapse, at most TTS_MAX_CHARS. Null when nothing is left.
 * Pure (unit-tested).
 */
export function ttsText(content: string, displayNameOf: (username: string) => string | null, linkWord: string): string | null {
  let text = emojiShortcodes(content).replace(/https?:\/\/\S+/gi, ` ${linkWord} `);
  text = text.replace(/(^|[^\w@])@([A-Za-z0-9_.-]{2,32})/g, (_m, prefix: string, username: string) => `${prefix}${displayNameOf(username) ?? username}`);
  text = text.replace(/[*_~`|>#]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > TTS_MAX_CHARS ? `${text.slice(0, TTS_MAX_CHARS).trimEnd()}…` : text;
}

export interface TtsContext {
  selfId: string | null;
  /** The call we are in (voice channel or DM), null when none. */
  callChannelId: string | null;
  deafened: boolean;
  listen: boolean;
  locallyMuted: (userId: string) => boolean;
}

/** Whether this device reads `message` aloud. Pure (unit-tested). */
export function shouldSpeak(message: Pick<Message, 'tts' | 'channelId' | 'content'> & { author: { id: string } }, ctx: TtsContext): boolean {
  if (message.tts !== true || !ctx.listen || ctx.deafened || !message.content.trim()) return false;
  if (!ctx.callChannelId || message.channelId !== ctx.callChannelId) return false;
  if (message.author.id === ctx.selfId) return false;
  return !ctx.locallyMuted(message.author.id);
}

/** The system voice to use: the chosen one if it still exists, otherwise one for the text's language. */
export function pickVoice(voices: readonly Pick<SpeechSynthesisVoice, 'voiceURI' | 'lang' | 'default'>[], chosenUri: string | null, text: string): number {
  if (chosenUri) {
    const chosen = voices.findIndex((v) => v.voiceURI === chosenUri);
    if (chosen >= 0) return chosen;
  }
  const lang = /[Ѐ-ӿ]/.test(text) ? 'ru' : 'en';
  const match = voices.findIndex((v) => v.lang.toLowerCase().startsWith(lang));
  if (match >= 0) return match;
  return voices.findIndex((v) => v.default);
}

export function ttsVoices(): SpeechSynthesisVoice[] {
  return ttsSupported() ? window.speechSynthesis.getVoices() : [];
}

/** Speaks `text` with the listener's voice / volume / rate settings (queued after earlier messages). */
export function speak(text: string): void {
  if (!ttsSupported()) return;
  const { ttsVoiceUri, ttsVolume, ttsRate } = useSettingsStore.getState();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = ttsVoices();
  const index = pickVoice(voices, ttsVoiceUri, text);
  const voice = index >= 0 ? voices[index] : undefined;
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = /[Ѐ-ӿ]/.test(text) ? 'ru-RU' : 'en-US';
  }
  utterance.volume = Math.min(1, Math.max(0, ttsVolume / 100));
  utterance.rate = Math.min(2, Math.max(0.5, ttsRate / 100));
  window.speechSynthesis.speak(utterance);
}

/** Stops whatever is being read and clears the queue (leaving the call, deafening). */
export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

function callChannelId(): string | null {
  const v = useVoiceStore.getState();
  return v.channelId && v.status === 'connected' ? v.channelId : null;
}

/** Realtime hook: reads a new message aloud when it is a TTS message for the call we are in. */
export function speakIfTts(message: Message): void {
  if (message.tts !== true || !ttsSupported()) return;
  const settings = useSettingsStore.getState();
  const ok = shouldSpeak(message, {
    selfId: useAuthStore.getState().user?.id ?? null,
    callChannelId: callChannelId(),
    deafened: useVoiceStore.getState().deafened,
    listen: settings.ttsListen,
    locallyMuted: (id) => settings.userMutes[id] === true,
  });
  if (!ok) return;
  const users = Object.values(usePresenceStore.getState().users);
  const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u.displayName]));
  const text = ttsText(message.content, (name) => byUsername.get(name.toLowerCase()) ?? null, t('tts.link'));
  if (!text) return;
  const author = usePresenceStore.getState().users[message.author.id]?.displayName ?? message.author.displayName;
  speak(t('tts.said', { name: author, text }));
}

// Leaving the call or deafening silences what is still queued.
useVoiceStore.subscribe((s, prev) => {
  if ((prev.status === 'connected' && s.status !== 'connected') || (s.deafened && !prev.deafened)) stopSpeaking();
});
