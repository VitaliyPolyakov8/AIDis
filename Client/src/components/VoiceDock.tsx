import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MonitorOff, MonitorUp, PhoneOff, TriangleAlert, X, Settings2 } from 'lucide-react';
import { useChatStore } from '../stores/chatStore';
import { useVoiceStore } from '../voice/voiceStore';
import { SignalBars } from './SignalBars';
import { voice } from '../voice/voiceService';
import { pathForChannelId } from './guilds/links';
import { canShareScreen } from '../voice/screenShareQuality';
import { requestScreenShare } from '../desktop/screenCapture';
import { SoundboardButton } from '../sounds-board/SoundboardButton';
import { StreamGameSuggestion } from './voice/StreamGameSuggestion';
import { isDesktop } from '../desktop/bridge';
import { useUiStore } from '../stores/uiStore';

/** Persistent block above the user panel while in (or failing to join) a voice channel. */
export function VoiceDock() {
  const { t } = useTranslation();
  const status = useVoiceStore((s) => s.status);
  const channelId = useVoiceStore((s) => s.channelId);
  const error = useVoiceStore((s) => s.error);
  const quality = useVoiceStore((s) => s.quality);
  const audioBlocked = useVoiceStore((s) => s.audioBlocked);
  const sharing = useVoiceStore((s) => s.localScreenSharing);
  const channel = useChatStore((s) => s.channels.find((c) => c.id === channelId));

  if (status === 'idle' || !channelId) return null;

  if (status === 'error') {
    return (
      <div className="voice-dock is-error" role="alert">
        <div className="voice-dock-row">
          <TriangleAlert size={16} className="voice-dock-error-icon" aria-hidden="true" />
          <span className="voice-dock-error">{error}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('common.dismiss')} onClick={() => voice.dismissError()}>
            <X size={15} />
          </button>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void voice.join(channelId)}>
          {t('common.tryAgain')}
        </button>
      </div>
    );
  }

  const statusText = status === 'connected' && quality !== 'unknown' ? t(`voice.quality.${quality}`) : t(`voice.status.${status}`);

  return (
    <div className={`voice-dock is-${status}`}>
      <div className="voice-dock-row">
        <SignalBars quality={quality} status={status} />
        <div className="voice-dock-text">
          <span className="voice-dock-status" role="status">
            {status === 'connected' ? t('voice.status.connected') : t(`voice.status.${status}`)}
          </span>
          <Link className="voice-dock-channel" to={pathForChannelId(channelId, { call: true })} title={statusText}>
            {channel?.name ?? '—'}
          </Link>
        </div>
        <button type="button" className="icon-btn icon-btn-danger" aria-label={t('voice.leaveChannel')} title={t('voice.disconnect')} onClick={() => void voice.leave()}>
          <PhoneOff size={18} />
        </button>
      </div>
      {sharing && isDesktop && (
        <button type="button" className="dock-action" onClick={() => useUiStore.getState().setSourcePicker(true, 'change')}>
          <Settings2 size={16} aria-hidden="true" />
          {t('voice.changeStream')}
        </button>
      )}
      {!sharing && isDesktop && status === 'connected' && <StreamGameSuggestion />}
      <SoundboardButton variant="dock" />
      {canShareScreen() && (
        <button
          type="button"
          className={`dock-action${sharing ? ' is-live' : ''}`}
          aria-pressed={sharing}
          disabled={status !== 'connected'}
          onClick={() => (sharing ? void voice.stopScreenShare() : requestScreenShare())}
        >
          {sharing ? <MonitorOff size={16} aria-hidden="true" /> : <MonitorUp size={16} aria-hidden="true" />}
          {sharing ? t('voice.stopSharing') : t('voice.shareScreen')}
        </button>
      )}
      {audioBlocked && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void voice.enableAudio()}>
          {t('voice.clickToEnableSound')}
        </button>
      )}
    </div>
  );
}
