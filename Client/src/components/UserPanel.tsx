import { useState } from 'react';
import { StyledName } from './profile/StyledName';
import { useTranslation } from 'react-i18next';
import { Headphones, HeadphoneOff, Mic, MicOff, Settings } from 'lucide-react';
import { Avatar } from './Avatar';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useVoiceStore } from '../voice/voiceStore';
import { voice } from '../voice/voiceService';
import { useStatusStore } from '../stores/statusStore';
import { StatusMenu } from './profile/StatusMenu';
import { activeCustomStatus, ownPresenceState } from '../utils/presence';

/** Mute / deafen toggles shared by the user panel and the phone voice bar. */
export function MicButton({ className = 'icon-btn' }: { className?: string }) {
  const { t } = useTranslation();
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  return (
    <button
      type="button"
      className={`${className} toggle-btn${micEnabled ? '' : ' is-off'}`}
      aria-label={micEnabled ? t('voice.muteMic') : t('voice.unmuteMic')}
      aria-pressed={!micEnabled}
      title={micEnabled ? t('voice.mute') : t('voice.unmute')}
      onClick={() => void voice.toggleMic()}
    >
      {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
    </button>
  );
}

export function DeafenButton({ className = 'icon-btn' }: { className?: string }) {
  const { t } = useTranslation();
  const deafened = useVoiceStore((s) => s.deafened);
  return (
    <button
      type="button"
      className={`${className} toggle-btn${deafened ? ' is-off' : ''}`}
      aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')}
      aria-pressed={deafened}
      title={deafened ? t('voice.undeafen') : t('voice.deafen')}
      onClick={() => void voice.toggleDeafen()}
    >
      {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
    </button>
  );
}

export function UserPanel() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const socket = useConnectionStore((s) => s.socket);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const pttMode = useVoiceStore((s) => s.pttMode);
  const pttActive = useVoiceStore((s) => s.pttActive);
  const inCall = useVoiceStore((s) => s.status === 'connected' || s.status === 'reconnecting');
  const openSettings = useUiStore((s) => s.openSettings);
  const statusPref = useStatusStore((s) => s.status);
  const customStatus = useStatusStore((s) => s.customStatus);
  const statusSupported = useStatusStore((s) => s.supported);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!user) return null;
  const online = socket === 'connected';
  const custom = activeCustomStatus({ customStatus });
  const subtitle = !online
    ? t('connection.reconnecting')
    : deafened
      ? t('voice.deafened')
      : !micEnabled
        ? t('voice.muted')
        : pttMode && inCall
          ? pttActive
            ? t('voice.pttTransmitting')
            : t('voice.pttIdle')
          : (custom?.text ?? `@${user.username}`);
  return (
    <div className="user-panel">
      <button
        type="button"
        className="user-panel-identity"
        aria-haspopup={statusSupported ? 'menu' : undefined}
        aria-label={statusSupported ? t('status.title') : t('settings.tabs.account')}
        onClick={(e) => {
          if (!statusSupported) {
            openSettings('account');
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.top - 8 });
        }}
      >
        <Avatar
          userId={user.id}
          name={user.displayName}
          avatarAttachmentId={user.avatarAttachmentId}
          size={32}
          status={statusSupported ? ownPresenceState(statusPref, online) : online ? 'online' : 'offline'}
        />
        <span className="user-panel-names">
          {/* 0.5.8: own name in its name style (color, gradient, glow, font) like everywhere else. */}
          <span className="user-panel-display">
            <StyledName userId={user.id} name={user.displayName} fallback={user} />
          </span>
          <span className={`user-panel-sub${!micEnabled || deafened ? ' is-warn' : ''}`}>{subtitle}</span>
        </span>
      </button>
      <div className="user-panel-actions">
        <MicButton />
        <DeafenButton />
        <button
          type="button"
          className="icon-btn"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          onClick={() => openSettings('account')}
        >
          <Settings size={18} />
        </button>
      </div>
      {menu && <StatusMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
