import { memo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useCallNames, useGuildStore } from '../../stores/guildStore';
import { NavLink, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, BellRing, CheckCheck, Hash, HeadphoneOff, Lock, MessageSquare, MicOff, Monitor, Pencil, Plus, Trash, Volume2, VolumeX, Video } from 'lucide-react';
import type { Channel, NotifyMode } from '../../api/types';
import { Avatar } from '../Avatar';
import { PlatformIcons } from '../profile/PlatformIcons';
import { usePresenceStore } from '../../stores/presenceStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { voice } from '../../voice/voiceService';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast, useUiStore } from '../../stores/uiStore';
import { isMutedRead, notifyModeOf, useReadStore } from '../../stores/readStore';
import { useCan } from '../../stores/permsStore';
import { friendlyError } from '../../api/errors';
import { openParticipantMenu } from '../voice/participantMenuState';
import { moveVoiceUser } from '../voice/ModerationDialogs';
import { LivePreview } from '../voice/LivePreview';
import { draggedOccupant, endOccupantDrag, occupantDropAction, startOccupantDrag } from '../voice/voiceDrag';
import { openProfile } from '../profile/profileState';
import { SpeakingFrame } from '../profile/ProfileBits';
import { VoiceSessionTimer } from '../voice/VoiceSessionTimer';
import { openMenu, type MenuEntry } from '../menu/MenuHost';
import { openCreateChannel, openDeleteChannel, openEditChannel } from '../admin/ChannelDialog';
import { useNameStyle } from '../profile/nameStyle';
import { useChannelLocked } from './channelTree';
import { linkTo } from './routes';

/* 0.7.0: channel rows of the server sidebar (moved out of ChannelSidebar.tsx). */

export function UnreadBadge({ channelId, dotOnly = false }: { channelId: string; dotOnly?: boolean }) {
  const { t } = useTranslation();
  const read = useReadStore((s) => s.reads[channelId]);
  const muted = isMutedRead(read);
  if (!read || read.unread === 0) return null;
  if (read.mentions > 0) {
    return (
      <span className="badge badge-mention" title={t('sidebar.mentions', { count: read.mentions })}>
        {read.mentions > 99 ? '99+' : read.mentions}
      </span>
    );
  }
  if (dotOnly || muted) return <span className="unread-dot" role="img" aria-label={t('sidebar.unread')} />;
  return (
    <span className="badge badge-unread" title={t('sidebar.unreadCount', { count: read.unread })}>
      {read.unread >= 100 ? '99+' : read.unread}
    </span>
  );
}

export function useNotifyMenu() {
  const { t } = useTranslation();
  const setNotify = useReadStore((s) => s.setNotify);
  return (channelId: string, current: NotifyMode): MenuEntry[] => {
    const pick = (m: NotifyMode) => () => {
      setNotify(channelId, m).catch((e: unknown) => toast.error(friendlyError(e, t('notify.failed')), 'notify'));
    };
    return [
      { kind: 'title', label: t('notify.title') },
      { label: t('notify.ALL'), icon: <Bell size={15} />, onSelect: pick('ALL'), checked: current === 'ALL' },
      { label: t('notify.MENTIONS'), icon: <BellRing size={15} />, onSelect: pick('MENTIONS'), checked: current === 'MENTIONS' },
      { label: t('notify.NONE'), icon: <BellOff size={15} />, onSelect: pick('NONE'), checked: current === 'NONE' },
    ];
  };
}

/** Right-click menu of a channel or category: mark read, notifications, and (MANAGE_CHANNELS) create / edit / delete. */
export function useChannelMenu() {
  const { t } = useTranslation();
  const canManage = useCan('MANAGE_CHANNELS');
  const markAllRead = useReadStore((s) => s.markAllRead);
  const notifyMenu = useNotifyMenu();
  return (e: ReactMouseEvent, channel: Channel) => {
    if (channel.type === 'CATEGORY') {
      const entries: MenuEntry[] = [];
      const guildId = channel.guildId;
      if (canManage && guildId) {
        entries.push({ label: t('channels.newChannel'), icon: <Plus size={15} />, onSelect: () => openCreateChannel(guildId, 'TEXT', channel.id) });
        entries.push({ label: t('channels.editCategory'), icon: <Pencil size={15} />, onSelect: () => openEditChannel(channel) });
        entries.push({ label: t('channels.deleteCategory'), icon: <Trash size={15} />, danger: true, onSelect: () => openDeleteChannel(channel) });
      }
      if (entries.length > 0) openMenu(e, entries, channel.name);
      return;
    }
    const read = useReadStore.getState().reads[channel.id];
    const entries: MenuEntry[] = [
      { label: t('chat.unread.markRead'), icon: <CheckCheck size={15} />, onSelect: () => markAllRead(channel.id), disabled: !read || read.unread === 0 },
      { kind: 'separator' },
      ...notifyMenu(channel.id, notifyModeOf(read)),
    ];
    if (canManage) {
      entries.push({ kind: 'separator' });
      entries.push({ label: t('admin.channels.edit'), icon: <Pencil size={15} />, onSelect: () => openEditChannel(channel) });
      if (!channel.protected) entries.push({ label: t('admin.channels.delete'), icon: <Trash size={15} />, danger: true, onSelect: () => openDeleteChannel(channel) });
    }
    openMenu(e, entries, channel.name);
  };
}

export function TextChannelLink({ channel, onMenu }: { channel: Channel; onMenu: (e: ReactMouseEvent, c: Channel) => void }) {
  const { t } = useTranslation();
  const unread = useReadStore((s) => (s.reads[channel.id]?.unread ?? 0) > 0 && !isMutedRead(s.reads[channel.id]));
  const muted = useReadStore((s) => isMutedRead(s.reads[channel.id]));
  const locked = useChannelLocked(channel);
  return (
    <NavLink
      to={linkTo(channel)}
      className={({ isActive }) => `channel-link${isActive ? ' is-active' : ''}${unread ? ' is-unread' : ''}${muted ? ' is-muted' : ''}`}
      title={channel.description ?? undefined}
      onContextMenu={(e) => onMenu(e, channel)}
    >
      {locked ? <Lock size={16} className="channel-icon" aria-label={t('channels.locked')} /> : <Hash size={17} className="channel-icon" aria-hidden="true" />}
      <span className="channel-name">{channel.name}</span>
      <UnreadBadge channelId={channel.id} />
    </NavLink>
  );
}

interface Occupant {
  identity: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  sharing: boolean;
  lost: boolean;
  /** 0.5.0 */
  camera: boolean;
  deafened: boolean;
}

/** 0.5.0: a voice participant's name in their own nickname color. */
function OccupantName({ identity, name }: { identity: string; name: string }) {
  const style = useNameStyle(identity);
  return (
    <span className={`voice-occupant-name ${style.className}`} style={style.style}>
      {name}
    </span>
  );
}

const VoiceOccupants = memo(function VoiceOccupants({ occupants, channelId }: { occupants: Occupant[]; channelId: string }) {
  const { t } = useTranslation();
  const canMove = useCan('MOVE_USERS');
  const users = usePresenceStore((s) => s.users);
  const localMutes = useSettingsStore((s) => s.userMutes);
  const selfDeafened = useVoiceStore((s) => s.deafened);
  const deafenedUsers = useVoiceStore((s) => s.deafenedUsers);
  const selfId = useAuthStore((s) => s.user?.id);
  const names = useCallNames(channelId);
  // 0.7.0: server mute / deafen set by a moderator (shown in red).
  const guildId = useGuildStore((s) => s.channelById(channelId)?.guildId ?? null);
  const serverStates = useVoiceStore((s) => s.serverStates);
  if (occupants.length === 0) return null;
  return (
    <ul className="voice-occupants" aria-label={t('sidebar.connectedUsers')}>
      {occupants.map((o) => {
        const user = users[o.identity];
        const name = names(o.identity, user?.displayName ?? o.name);
        const server = guildId ? serverStates[`${guildId}:${o.identity}`] : undefined;
        // 0.5.2: drag to another voice channel (MOVE_USERS; yourself = join that channel).
        const draggable = canMove || o.identity === selfId;
        const deafened = o.identity === selfId ? selfDeafened : o.deafened || deafenedUsers[o.identity] === true;
        // 0.5.6: many icons at once: LIVE shows only its icon, so the name keeps its room.
        const crowded = o.sharing && [o.camera, localMutes[o.identity] === true, o.muted, deafened].filter(Boolean).length >= 2;
        return (
          <li
            key={o.identity}
            className={`voice-occupant${o.speaking ? ' is-speaking' : ''}${o.muted ? ' is-muted' : ''}${o.lost ? ' is-lost' : ''}${draggable ? ' is-draggable' : ''}`}
            onContextMenu={(e) => openParticipantMenu(e, o.identity, name)}
            onClick={(e) => openProfile(e, o.identity)}
            draggable={draggable || undefined}
            onDragStart={draggable ? (e) => startOccupantDrag(e, { userId: o.identity, name, fromChannelId: channelId }) : undefined}
            onDragEnd={draggable ? endOccupantDrag : undefined}
            title={draggable && o.identity !== selfId ? t('voice.moderation.dragHint') : undefined}
          >
            <SpeakingFrame frame={user?.profileFrame} speaking={o.speaking} size={22}>
              <Avatar userId={o.identity} name={name} avatarAttachmentId={user?.avatarAttachmentId} size={22} speaking={o.speaking} />
            </SpeakingFrame>
            <OccupantName identity={o.identity} name={name} />
            {o.speaking && <span className="visually-hidden">{t('sidebar.speaking')}</span>}
            {/* 0.5.6: one right-aligned group in a fixed order, so icons line up from row to row and
                the name always keeps room (with many icons the LIVE label shrinks to its icon). */}
            <span className={`voice-occupant-icons${crowded ? ' is-crowded' : ''}`}>
              {o.sharing && (
                <LivePreview streamerId={o.identity} name={name}>
                  <span className="live-badge" title={t('sidebar.sharing')}>
                    <Monitor size={10} aria-hidden="true" />
                    <span className="live-badge-text">{t('voice.live')}</span>
                  </span>
                </LivePreview>
              )}
              {o.camera && (
                <span className="live-badge is-camera" title={t('camera.live')}>
                  <Video size={10} aria-hidden="true" />
                </span>
              )}
              <PlatformIcons userId={o.identity} size={11} />
              {localMutes[o.identity] && <VolumeX size={13} className="voice-occupant-muted" role="img" aria-label={t('voice.menu.locallyMuted')} />}
              {o.muted && <MicOff size={13} className="voice-occupant-muted" role="img" aria-label={t('sidebar.muted')} />}
              {deafened && <HeadphoneOff size={13} className="voice-occupant-muted" role="img" aria-label={t('voice.deafened')} />}
              {server?.muted && <MicOff size={13} className="voice-occupant-muted is-server" role="img" aria-label={t('voiceLock.serverMuted')} />}
              {server?.deafened && <HeadphoneOff size={13} className="voice-occupant-muted is-server" role="img" aria-label={t('voiceLock.serverDeafened')} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
});

type ReorderHandlers = Partial<Record<'onDragOver' | 'onDragLeave' | 'onDrop', (e: DragEvent) => void>>;

export function VoiceChannelItem({ channel, onMenu, dragProps }: { channel: Channel; onMenu: (e: ReactMouseEvent, c: Channel) => void; dragProps: object }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canMove = useCan('MOVE_USERS');
  const selfId = useAuthStore((s) => s.user?.id);
  const [moveOver, setMoveOver] = useState(false);
  const isJoined = useVoiceStore((s) => s.channelId === channel.id && s.status !== 'idle' && s.status !== 'error');
  const live = useVoiceStore((s) => (s.channelId === channel.id && s.status !== 'idle' && s.status !== 'error' ? s.participants : null));
  const known = useVoiceStore((s) => s.occupancy[channel.id]);
  // 0.5.0: mute / deafen / LIVE / camera of people in a channel we are NOT in (realtime server).
  const memberStates = useVoiceStore((s) => s.memberStates);
  const chatUnread = useReadStore((s) => (s.reads[channel.id]?.unread ?? 0) > 0);
  const locked = useChannelLocked(channel);

  const occupants: Occupant[] =
    live && live.length > 0
      ? live.map((p) => ({
          identity: p.identity,
          name: p.name,
          speaking: p.isSpeaking,
          muted: p.micMuted,
          sharing: p.screenSharing,
          lost: p.connectionLost === true,
          camera: p.camera === true,
          deafened: memberStates[p.identity]?.deafened === true,
        }))
      : (known ?? []).map((p) => {
          const st = memberStates[p.identity];
          return { identity: p.identity, name: p.name, speaking: false, muted: st?.muted === true, sharing: st?.screen === true, lost: false, camera: st?.camera === true, deafened: st?.deafened === true };
        });
  const anyoneSpeaking = occupants.some((o) => o.speaking);

  const join = () => {
    void navigate(linkTo(channel));
    void voice.join(channel.id);
  };
  // 0.5.2: this channel as a drop target for people dragged from another voice channel; any other
  // drag (channel reordering) goes to the reorder handlers as before.
  const reorder = dragProps as ReorderHandlers;
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      const dragged = draggedOccupant(e);
      if (!dragged) return reorder.onDragOver?.(e);
      if (occupantDropAction(dragged, channel.id, selfId, canMove) === 'none') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setMoveOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setMoveOver(false);
      reorder.onDragLeave?.(e);
    },
    onDrop: (e: DragEvent) => {
      const dragged = draggedOccupant(e);
      if (!dragged) return reorder.onDrop?.(e);
      e.preventDefault();
      setMoveOver(false);
      endOccupantDrag();
      const action = occupantDropAction(dragged, channel.id, selfId, canMove);
      if (action === 'join') join();
      else if (action === 'move') {
        void moveVoiceUser({ id: dragged.userId, displayName: dragged.name }, dragged.fromChannelId, channel.id, channel.name).then((error) => {
          if (error) toast.error(error, 'voice-move');
        });
      }
    },
  };

  return (
    <li className={`voice-channel${occupants.length > 0 ? ' is-occupied' : ' is-empty'}${isJoined ? ' is-joined' : ''}${moveOver ? ' is-move-target' : ''}`} {...dragProps} {...dropHandlers}>
      {/* 0.4.2: one flex row (name ellipsizes first; timer, count and the chat button never overlap). */}
      <div className="voice-row">
        <button
          type="button"
          className={`channel-link voice-link${isJoined ? ' is-joined' : ''}${anyoneSpeaking ? ' is-live' : ''}`}
          onClick={join}
          onContextMenu={(e) => onMenu(e, channel)}
          title={channel.description ?? undefined}
          aria-label={isJoined ? t('sidebar.openVoice', { channel: channel.name }) : t('sidebar.joinVoice', { channel: channel.name })}
        >
          {locked ? <Lock size={16} className="channel-icon" aria-label={t('channels.locked')} /> : <Volume2 size={17} className="channel-icon" aria-hidden="true" />}
          <span className="channel-name">{channel.name}</span>
          {occupants.length > 0 && <VoiceSessionTimer channelId={channel.id} />}
          {occupants.length > 0 && (
            <span className="channel-count" title={t('sidebar.inVoice', { count: occupants.length })}>
              {occupants.length}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`voice-chat-link${chatUnread ? ' is-unread' : ''}`}
          aria-label={t('voice.chat.openIn', { channel: channel.name })}
          title={t('voice.chat.open')}
          onClick={() => {
            useUiStore.getState().setVoiceChat(true);
            void navigate(linkTo(channel));
          }}
        >
          <MessageSquare size={14} aria-hidden="true" />
          {chatUnread && <UnreadBadge channelId={channel.id} dotOnly />}
        </button>
      </div>
      <VoiceOccupants occupants={occupants} channelId={channel.id} />
    </li>
  );
}
