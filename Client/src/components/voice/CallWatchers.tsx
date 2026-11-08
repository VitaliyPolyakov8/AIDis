import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Phone, PhoneOff } from 'lucide-react';
import { useCallStore } from '../../stores/callStore';
import { useChatStore } from '../../stores/chatStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useAuthStore } from '../../stores/authStore';
import { useStatusStore } from '../../stores/statusStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { voice } from '../../voice/voiceService';
import { dmCallPath } from '../guilds/routes';
import { pathForChannelId } from '../guilds/links';
import { Avatar } from '../Avatar';
import { dmName } from '../../utils/dm';
import { playSound } from '../../sounds/sounds';
import { desktop } from '../../desktop/bridge';

/** "X is calling you" for DM calls (accept joins the DM's voice room, decline just hides it). */
export function IncomingCallBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const incoming = useCallStore((s) => s.incoming);
  const dismiss = useCallStore((s) => s.dismiss);
  const dm = useChatStore((s) => (incoming ? s.dms.find((d) => d.id === incoming.channelId) : undefined));
  const users = usePresenceStore((s) => s.users);
  const selfId = useAuthStore((s) => s.user?.id);
  const alreadyIn = useVoiceStore((s) => incoming !== null && s.channelId === incoming.channelId && s.status === 'connected');
  const dnd = useStatusStore((s) => s.status === 'DND');

  useEffect(() => {
    if (!incoming) return;
    if (alreadyIn || dnd) {
      dismiss();
      return;
    }
    playSound('join');
    const from = users[incoming.fromUserId]?.displayName ?? '';
    if (desktop && typeof document !== 'undefined' && !document.hasFocus()) {
      desktop.notifications.show({ title: t('dm.incomingTitle', { name: from }), body: t('dm.incomingBody'), channelId: incoming.channelId });
    }
    // Only when a new call arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.at]);

  if (!incoming || alreadyIn || dnd) return null;
  const caller = users[incoming.fromUserId];
  const title = dm ? dmName(dm, users, selfId) : (caller?.displayName ?? '');
  return (
    <div className="incoming-call" role="alertdialog" aria-label={t('dm.incomingTitle', { name: caller?.displayName ?? '' })}>
      <span className="incoming-call-avatar">
        <Avatar userId={incoming.fromUserId} name={caller?.displayName ?? '?'} avatarAttachmentId={caller?.avatarAttachmentId} size={44} speaking />
      </span>
      <span className="incoming-call-text">
        <strong>{t('dm.incomingTitle', { name: caller?.displayName ?? '' })}</strong>
        <span>{title}</span>
      </span>
      <button
        type="button"
        className="btn btn-success"
        onClick={() => {
          dismiss();
          void navigate(dmCallPath(incoming.channelId));
          void voice.join(incoming.channelId);
        }}
      >
        <Phone size={16} aria-hidden="true" /> {t('dm.accept')}
      </button>
      <button type="button" className="btn btn-danger-soft" onClick={dismiss}>
        <PhoneOff size={16} aria-hidden="true" /> {t('dm.decline')}
      </button>
    </div>
  );
}

/** After a moderator moved us, the open voice view follows to the new channel. */
export function VoiceMoveWatcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const channelId = useVoiceStore((s) => s.channelId);
  const status = useVoiceStore((s) => s.status);
  const previous = useRef<string | null>(channelId);
  useEffect(() => {
    const before = previous.current;
    previous.current = channelId;
    if (!before || !channelId || before === channelId || status !== 'connected') return;
    if (location.pathname === pathForChannelId(before, { call: true })) void navigate(pathForChannelId(channelId, { call: true }), { replace: true });
  }, [channelId, status, location.pathname, navigate]);
  return null;
}
