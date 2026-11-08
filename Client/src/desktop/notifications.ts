import { displayInChannel, useGuildStore } from '../stores/guildStore';
import type { Channel, Message } from '../api/types';
import { emojiShortcodes } from '../emojis/tokens';
import { t } from '../i18n';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useStatusStore } from '../stores/statusStore';
import { notifyModeOf, useReadStore } from '../stores/readStore';
import { dmName } from '../utils/dm';
import { desktop } from './bridge';
import { useDesktopStore } from './desktopStore';
import { avatarFor } from './overlayFeed';
import { avatarColor, initials } from '../utils/avatar';
import { displayNicknameColor } from '../components/profile/nicknameColor';
import { playSound } from '../sounds/sounds';
import { useVoiceStore } from '../voice/voiceStore';
import { useLocalGame } from './localGame';

const NOTIFY_INTERVAL_MS = 4000;
const lastNotified = new Map<string, number>();

/**
 * Shared eligibility: voice-channel messages require an active call in that same channel.
 * DND silences notifications, except current voice-chat messages in the game overlay.
 * Channel notification preferences and the focused chat still apply.
 */
/** 0.7.0: "Server · #channel" (the server name only when I am on more than one server). */
function channelWhere(channel: Channel): string {
  const name = `${channel.type === 'VOICE' ? '🔊 ' : '#'}${channel.name}`;
  const { guilds } = useGuildStore.getState();
  const guild = channel.guildId && guilds.length > 1 ? guilds.find((g) => g.id === channel.guildId) : undefined;
  return guild ? `${guild.name} · ${name}` : name;
}

export function shouldNotify(message: Message, opts: { ignoreFocus?: boolean; overlay?: boolean } = {}): { notify: boolean; mention: boolean } {
  const selfId = useAuthStore.getState().user?.id;
  if (!selfId || message.author.id === selfId) return { notify: false, mention: false };
  const voiceChat = useChatStore.getState().channels.some((c) => c.id === message.channelId && c.type === 'VOICE');
  if (voiceChat && !isCurrentVoiceChat(message.channelId)) return { notify: false, mention: false };
  const gameVoiceOverlay = opts.overlay && voiceChat && useLocalGame.getState().info !== null;
  if (useStatusStore.getState().status === 'DND' && !gameVoiceOverlay) return { notify: false, mention: false };
  const isDm = useChatStore.getState().dms.some((d) => d.id === message.channelId);
  const mention = isDm || message.mentions?.includes(selfId) === true;
  const mode = notifyModeOf(useReadStore.getState().reads[message.channelId]);
  if (mode === 'NONE' || (mode === 'MENTIONS' && !mention)) return { notify: false, mention };
  if (!opts.ignoreFocus && typeof document !== 'undefined' && document.hasFocus() && useChatStore.getState().activeChannelId === message.channelId) {
    return { notify: false, mention };
  }
  return { notify: true, mention };
}

function isCurrentVoiceChat(channelId: string): boolean {
  const voice = useVoiceStore.getState();
  return voice.channelId === channelId && (voice.status === 'connected' || voice.status === 'reconnecting');
}

/**
 * Native notification for a new message (desktop): respects the channel's notification mode, DND,
 * mentions and focus; at most one per channel every few seconds (mentions always get through).
 */
export function notifyNewMessage(message: Message): void {
  if (!desktop) return;
  if (!useDesktopStore.getState().settings.preferences.notifications) return;
  // Detect the game locally: invisible/DND and hidden public game activity must not add popups.
  if (useLocalGame.getState().info && isCurrentVoiceChat(message.channelId) && useChatStore.getState().channels.some((c) => c.id === message.channelId && c.type === 'VOICE')) return;
  const { notify, mention } = shouldNotify(message);
  if (!notify) return;
  // A focused window shows unread badges instead of pop-ups, except for mentions in other chats.
  if (typeof document !== 'undefined' && document.hasFocus() && !mention) return;
  const now = Date.now();
  if (!mention && now - (lastNotified.get(message.channelId) ?? 0) < NOTIFY_INTERVAL_MS) return;
  lastNotified.set(message.channelId, now);

  const chat = useChatStore.getState();
  const users = usePresenceStore.getState().users;
  const channel = chat.channels.find((c) => c.id === message.channelId);
  const dm = chat.dms.find((d) => d.id === message.channelId);
  const shown = displayInChannel(message.channelId, message.author.id, message.author);
  const author = shown.name;
  const text = emojiShortcodes(message.content).trim();
  const body = text ? (text.length > 160 ? `${text.slice(0, 157)}…` : text) : message.attachments.length > 0 ? t('desktop.notifications.attachment') : '';
  const label = dm ? ((dm.memberIds?.length ?? 0) > 2 ? dmName(dm, users, useAuthStore.getState().user?.id) : '') : channel ? channelWhere(channel) : '';
  const user = users[message.author.id];
  // 0.5.0: an AIDis card in the bottom-right corner (older shells: the Windows toast) + the sound.
  if (desktop.notifications.toast) {
    desktop.notifications.toast({
      author,
      channelLabel: label,
      body,
      channelId: message.channelId,
      avatar: avatarFor(shown.avatarAttachmentId),
      initials: initials(author),
      color: avatarColor(message.author.id),
      nameColor: displayNicknameColor(user?.nicknameColor ?? message.author.nicknameColor),
      mention: mention && !dm,
    });
  } else {
    desktop.notifications.show({
      title: `${mention && !dm ? '@ ' : ''}${author}${label ? ` · ${label}` : ''}`,
      body,
      channelId: message.channelId,
    });
  }
  playSound('notify');
}
