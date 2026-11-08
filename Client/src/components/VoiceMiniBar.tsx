import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PhoneOff } from 'lucide-react';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { pathForChannelId } from './guilds/links';
import { SignalBars } from './SignalBars';
import { DeafenButton, MicButton } from './UserPanel';

/** Phone-only strip above the chat so voice controls stay reachable while the sidebar is a drawer. */
export function VoiceMiniBar() {
  const { t } = useTranslation();
  const status = useVoiceStore((s) => s.status);
  const channelId = useVoiceStore((s) => s.channelId);
  const quality = useVoiceStore((s) => s.quality);
  const channel = useChatStore((s) => s.channels.find((c) => c.id === channelId));
  if (!channelId || (status !== 'connected' && status !== 'connecting' && status !== 'reconnecting')) return null;
  return (
    <div className={`voice-minibar only-mobile is-${status}`}>
      <Link to={pathForChannelId(channelId, { call: true })} className="voice-minibar-link">
        <SignalBars quality={quality} status={status} interactive={false} />
        <span>{status === 'connected' ? (channel?.name ?? '') : t(`voice.status.${status}`)}</span>
      </Link>
      <MicButton />
      <DeafenButton />
      <button type="button" className="icon-btn icon-btn-danger" aria-label={t('voice.leaveChannel')} onClick={() => void voice.leave()}>
        <PhoneOff size={18} />
      </button>
    </div>
  );
}
