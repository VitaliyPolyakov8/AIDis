import { displayInChannel } from '../stores/guildStore';
import type { Message } from '../api/types';
import { emojiShortcodes } from '../emojis/tokens';
import { getAttachmentObjectUrl } from '../api/attachments';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { avatarColor, initials } from '../utils/avatar';
import { displayNicknameColor } from '../components/profile/nicknameColor';
import { frameUrl } from '../cosmetics/catalog';
import { isParticipantDeafened, useVoiceStore } from '../voice/voiceStore';
import { desktop } from './bridge';
import type { OverlayMessage, OverlayParticipant, OverlayVoiceState } from './contract';
import { useDesktopStore } from './desktopStore';
import { shouldNotify } from './notifications';
import { dmName } from '../utils/dm';
import { subscribeOwnStreamHints } from '../voice/streamInteractions';

/**
 * Feeds the in-game overlay window (desktop only) from the state the app already has: the voice
 * store (participants, fast speaking flags, mute), deafen states and profiles. Event driven: a
 * snapshot is sent only when something visible changed. Avatars are shrunk once to 64 px data URLs
 * (the overlay page has no network access and no login).
 */

const AVATAR_PX = 64;
const avatarCache = new Map<string, string | null>();
const avatarPending = new Set<string>();
let onAvatarReady: (() => void) | null = null;

async function renderAvatar(attachmentId: string): Promise<string | null> {
  const url = await getAttachmentObjectUrl(attachmentId);
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Cover-crop to a square (animated avatars: first frame only, the overlay stays static).
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  return canvas.toDataURL('image/webp', 0.85);
}

export function avatarFor(attachmentId: string | null | undefined): string | null {
  if (!attachmentId) return null;
  if (avatarCache.has(attachmentId)) return avatarCache.get(attachmentId) ?? null;
  if (!avatarPending.has(attachmentId)) {
    avatarPending.add(attachmentId);
    renderAvatar(attachmentId)
      .catch(() => null)
      .then((data) => {
        avatarCache.set(attachmentId, data);
        avatarPending.delete(attachmentId);
        onAvatarReady?.();
      })
      .catch(() => undefined);
  }
  return null;
}

export function buildOverlayState(): OverlayVoiceState {
  const voice = useVoiceStore.getState();
  const users = usePresenceStore.getState().users;
  const inCall = voice.status === 'connected' || voice.status === 'reconnecting';
  const channel = useChatStore.getState().channels.find((c) => c.id === voice.channelId);
  const viewers = new Set(Object.values(voice.streamViewers).flat());
  const participants: OverlayParticipant[] = inCall
    ? voice.participants.map((p) => {
        const user = users[p.identity];
        // 0.7.0: the server profile of the call's channel (DM calls: the global one).
        const shown = displayInChannel(voice.channelId, p.identity);
        const name = shown.name === '…' ? p.name : shown.name;
        return {
          id: p.identity,
          name,
          avatar: avatarFor(shown.avatarAttachmentId),
          color: avatarColor(p.identity),
          initials: initials(name),
          nameColor: displayNicknameColor(user?.nicknameColor),
          nameColor2: displayNicknameColor(user?.nicknameColor2),
          nameGlow: user?.nicknameGlow === true,
          nameFont: user?.nicknameFont ?? null,
          cosmeticFrame: frameUrl(user?.avatarFrameId) ? (user?.avatarFrameId ?? null) : null,
          speaking: p.isSpeaking,
          micMuted: p.micMuted,
          deafened: isParticipantDeafened(voice, p.identity, p.isLocal),
          isSelf: p.isLocal,
          streaming: p.screenSharing,
          watching: viewers.has(p.identity),
          frame: user?.profileFrame ?? null,
        };
      })
    : [];
  return { inCall, channelName: channel?.name ?? '', participants, micEnabled: voice.micEnabled, deafened: voice.deafened };
}

/** Starts pushing state to the overlay window; returns the cleanup. */
export function startOverlayFeed(): () => void {
  if (!desktop) return () => undefined;
  const api = desktop;
  let last = '';
  let queued = false;
  const push = () => {
    if (queued) return;
    queued = true;
    // One snapshot per burst of store updates (speaking + participants often change together).
    queueMicrotask(() => {
      queued = false;
      if (!useDesktopStore.getState().settings.overlay.enabled) {
        last = '';
        api.overlay.pushStreamHint?.(null);
        return;
      }
      const state = buildOverlayState();
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      api.overlay.pushState(state);
    });
  };
  onAvatarReady = push;
  const unsubs = [
    useVoiceStore.subscribe(push),
    usePresenceStore.subscribe(push),
    useDesktopStore.subscribe(push),
    subscribeOwnStreamHints((hint) => {
      if (!hint) {
        api.overlay.pushStreamHint?.(null);
        return;
      }
      const state = useVoiceStore.getState();
      const sourceId = state.shareConfig?.sourceId;
      if (!sourceId || !state.localScreenSharing || hint.expiresAt <= Date.now() || !useDesktopStore.getState().settings.overlay.enabled) return;
      api.overlay.pushStreamHint?.(
        hint.type === 'pointer' ? { sourceId, expiresAt: hint.expiresAt, type: 'pointer', x: hint.x, y: hint.y } : { sourceId, expiresAt: hint.expiresAt, type: 'reaction', reaction: hint.reaction },
      );
    }),
  ];
  push();
  return () => {
    onAvatarReady = null;
    for (const u of unsubs) u();
    api.overlay.pushStreamHint?.(null);
  };
}

/**
 * 0.4.0: a new message -> a compact overlay notification, following the overlay's own mode (all /
 * mentions only / off) on top of the channel rules. Current voice-chat messages during a game
 * remain visible in DND; this does not re-enable native popups or notification sounds.
 */
export function overlayMessage(message: Message): void {
  if (!desktop) return;
  if (message.author.id === useAuthStore.getState().user?.id) return;
  const overlay = useDesktopStore.getState().settings.overlay;
  if (!overlay.enabled || overlay.messageMode === 'off') return;
  const { notify, mention } = shouldNotify(message, { ignoreFocus: true, overlay: true });
  if (!notify) return;
  if (overlay.messageMode === 'mentions' && !mention) return;
  const chat = useChatStore.getState();
  const channel = chat.channels.find((c) => c.id === message.channelId);
  const dm = chat.dms.find((d) => d.id === message.channelId);
  const channelLabel = dm
    ? (dm.memberIds?.length ?? 0) > 2
      ? dmName(dm, usePresenceStore.getState().users, useAuthStore.getState().user?.id)
      : 'DM'
    : channel
      ? `${channel.type === 'VOICE' ? '🔊 ' : '#'}${channel.name}`
      : '';
  const user = usePresenceStore.getState().users[message.author.id];
  const shown = displayInChannel(message.channelId, message.author.id, message.author);
  const name = shown.name;
  const text = emojiShortcodes(message.content).trim().replace(/\s+/g, ' ');
  const body = text ? (text.length > 200 ? `${text.slice(0, 197)}…` : text) : '📎';
  const payload: OverlayMessage = {
    id: message.id,
    authorName: name,
    avatar: avatarFor(shown.avatarAttachmentId),
    color: avatarColor(message.author.id),
    initials: initials(name),
    nameColor: displayNicknameColor(user?.nicknameColor ?? message.author.nicknameColor),
    nameColor2: displayNicknameColor(user?.nicknameColor2 ?? message.author.nicknameColor2),
    nameGlow: (user?.nicknameGlow ?? message.author.nicknameGlow) === true,
    nameFont: user?.nicknameFont ?? message.author.nicknameFont ?? null,
    text: body,
    at: Date.now(),
    channelId: message.channelId,
    channelLabel,
    mention,
  };
  desktop.overlay.pushMessage(payload);
}
