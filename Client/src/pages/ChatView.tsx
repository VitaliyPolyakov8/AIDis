import { useEffect, useMemo, type ReactNode } from 'react';
import { friendsErrorText, useFriendsStore } from '../stores/friendsStore';
import { dmPeer, useCanWriteDm } from '../components/dm/dmAccess';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Hash, Lock, Phone, UserPlus, Users } from 'lucide-react';
import type { Channel } from '../api/types';
import { CenterHeader } from '../components/CenterHeader';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/chat/Composer';
import { TypingIndicator } from '../components/chat/TypingIndicator';
import { ChannelTools } from '../components/chat/ChannelTools';
import { VoiceMiniBar } from '../components/VoiceMiniBar';
import { Avatar } from '../components/Avatar';
import { DefaultChannelRedirect } from './DefaultChannelRedirect';
import { useChatStore } from '../stores/chatStore';
import { useChannelLocked } from '../components/guilds/channelTree';
import { dmCallPath } from '../components/guilds/routes';
import { useReadStore } from '../stores/readStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/uiStore';
import { dmsApi } from '../api/channels';
import { friendlyError } from '../api/errors';
import { displayChannel, dmOthers, isGroupDm } from '../utils/dm';
import { voice } from '../voice/voiceService';
import { openAddPeople } from '../components/dm/DmDialogs';

/** Message list + composer for a text channel or a DM, with the shared header tools. */
function ChatPane({ channel, icon, extra, locked }: { channel: Channel; icon: ReactNode; extra?: ReactNode; locked?: ReactNode }) {
  const setActive = useChatStore((s) => s.setActiveChannel);
  const loadLatest = useChatStore((s) => s.loadLatest);
  const noteOpened = useReadStore((s) => s.noteOpened);

  useEffect(() => {
    setActive(channel.id);
    noteOpened(channel.id);
    void loadLatest(channel.id);
    document.title = `${channel.type === 'DM' ? '@' : '#'}${channel.name} · AIDis`;
    return () => setActive(null);
    // Only when the channel changes (a renamed DM keeps its "new messages" line).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, setActive, loadLatest, noteOpened]);

  return (
    <div className="chat-view">
      <CenterHeader icon={icon} title={channel.name} description={channel.description}>
        {extra}
        <ChannelTools channel={channel} />
      </CenterHeader>
      <VoiceMiniBar />
      <MessageList key={channel.id} channel={channel} />
      <div className="chat-footer">
        {locked ?? <Composer key={channel.id} channel={channel} />}
        <TypingIndicator channelId={channel.id} />
      </div>
    </div>
  );
}

export function ChatView() {
  const { channelId = '' } = useParams();
  const channel = useChatStore((s) => s.channels.find((c) => c.id === channelId && c.type === 'TEXT'));
  const locked = useChannelLocked(channel);

  if (!channel) return <DefaultChannelRedirect />;
  return <ChatPane channel={channel} icon={locked ? <Lock size={19} /> : <Hash size={20} />} />;
}

/** 0.4.0 direct message (1:1 or group). */
export function DmView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { channelId = '' } = useParams();
  const raw = useChatStore((s) => s.dms.find((c) => c.id === channelId));
  const users = usePresenceStore((s) => s.users);
  const selfId = useAuthStore((s) => s.user?.id);
  const channel = useMemo(() => (raw ? displayChannel(raw, users, selfId) : undefined), [raw, users, selfId]);
  // 0.7.0: a 1:1 DM is writable only between friends.
  const canWrite = useCanWriteDm(raw);
  const outgoing = useFriendsStore((s) => s.outgoing);

  if (!channel) return <DefaultChannelRedirect />;
  const others = dmOthers(channel, selfId);
  const peer = dmPeer(channel, selfId);
  const peerUser = peer ? users[peer] : undefined;
  const addFriend = () => {
    if (!peerUser) return;
    useFriendsStore
      .getState()
      .request(peerUser.username)
      .then(
        (status) => toast.success(t(status === 'accepted' ? 'friends.accepted' : 'friends.requestSent'), 'friend-request'),
        (e: unknown) => toast.error(friendsErrorText(e), 'friend-request'),
      );
  };
  const locked = canWrite ? undefined : (
    <div className="dm-locked" role="status">
      <span>{t('friends.notFriendsBanner')}</span>
      {peerUser && !outgoing.includes(peerUser.id) && (
        <button type="button" className="btn btn-primary btn-sm" onClick={addFriend}>
          <UserPlus size={14} aria-hidden="true" /> {t('friends.add')}
        </button>
      )}
      {peerUser && outgoing.includes(peerUser.id) && <span className="field-hint">{t('friends.requestSent')}</span>}
    </div>
  );
  const group = isGroupDm(channel);
  const first = others[0];
  const icon = group ? <Users size={19} /> : first ? <Avatar userId={first} name={channel.name} avatarAttachmentId={users[first]?.avatarAttachmentId} size={22} /> : <Users size={19} />;
  const startCall = () => {
    void navigate(dmCallPath(channel.id));
    void voice.join(channel.id);
    dmsApi.ring(channel.id).catch((e: unknown) => toast.error(friendlyError(e, t('dm.callFailed')), 'dm-call'));
  };
  return (
    <ChatPane
      channel={channel}
      icon={icon}
      locked={locked}
      extra={
        <>
          {canWrite && (
            <button type="button" className="icon-btn" aria-label={t('dm.call')} title={t('dm.call')} onClick={startCall}>
              <Phone size={18} />
            </button>
          )}
          {group && (
            <button type="button" className="icon-btn" aria-label={t('dm.addPeople')} title={t('dm.addPeople')} onClick={() => openAddPeople(channel)}>
              <UserPlus size={18} />
            </button>
          )}
        </>
      }
    />
  );
}
