import { useAuthStore } from '../../stores/authStore';
import { useGuildStore } from '../../stores/guildStore';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, HeadphoneOff, MicOff, PhoneOff, Volume2, VolumeX } from 'lucide-react';
import { useCan } from '../../stores/permsStore';
import { openMoveUser, openVoiceDisconnect } from './ModerationDialogs';
import { voiceApi } from '../../api/voice';
import { friendlyError, isApiError } from '../../api/errors';
import { t as translate } from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../stores/uiStore';
import { useVoiceStore } from '../../voice/voiceStore';
import { voice } from '../../voice/voiceService';
import { ConfirmDialog } from '../ConfirmDialog';
import { closeParticipantMenu as closeMenu, useParticipantMenu, type MenuTarget } from './participantMenuState';

const MARGIN = 8;

function Menu({ target }: { target: MenuTarget }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: target.x, top: target.y, visibility: 'hidden' });
  const volume = useSettingsStore((s) => s.userVolumes[target.identity] ?? 100);
  const muted = useSettingsStore((s) => s.userMutes[target.identity] === true);
  const canMove = useCan('MOVE_USERS');
  const canDisconnect = useCan('DISCONNECT_USERS');
  // 0.7.0 server mute / deafen (MUTE_MEMBERS / DEAFEN_MEMBERS on this server).
  const canMute = useCan('MUTE_MEMBERS', target.channelId);
  const canDeafen = useCan('DEAFEN_MEMBERS', target.channelId);
  const guildId = useGuildStore((s) => s.channelById(target.channelId)?.guildId ?? null);
  const serverState = useVoiceStore((s) => (guildId ? s.serverStates[`${guildId}:${target.identity}`] : undefined));
  const isSelf = useAuthStore((s) => s.user?.id === target.identity);
  const serverAction = (kind: 'mute' | 'deafen', on: boolean) => {
    closeMenu();
    const call = kind === 'mute' ? voiceApi.serverMute(target.channelId, target.identity, on) : voiceApi.serverDeafen(target.channelId, target.identity, on);
    call.catch((e: unknown) => toast.error(friendlyError(e, translate('voiceLock.failed')), 'server-mute'));
  };
  const stillHere = useVoiceStore((s) => s.channelId === target.channelId && s.participants.some((p) => p.identity === target.identity));

  // Keep the menu inside the window whatever its size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(target.x, window.innerWidth - width - MARGIN));
    const top = Math.max(MARGIN, Math.min(target.y, window.innerHeight - height - MARGIN));
    setStyle({ left, top });
  }, [target]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, []);

  // The participant left: nothing left to control.
  useEffect(() => {
    if (!stillHere) closeMenu();
  }, [stillHere]);

  return (
    <div ref={ref} className="context-menu participant-menu" role="menu" aria-label={target.name} style={style} onContextMenu={(e) => e.preventDefault()}>
      <div className="context-menu-title">{target.name}</div>
      <div className="context-menu-section">
        <label className="context-menu-label" htmlFor="participant-volume">
          <span>{t('voice.menu.userVolume')}</span>
          <span className="context-menu-value">{muted ? t('voice.menu.mutedValue') : `${volume}%`}</span>
        </label>
        <input id="participant-volume" className="range" type="range" min={0} max={200} step={5} value={volume} onChange={(e) => voice.setUserVolume(target.identity, Number(e.target.value))} />
      </div>
      <button type="button" role="menuitemcheckbox" aria-checked={muted} className={`context-menu-item${muted ? ' is-checked' : ''}`} onClick={() => voice.setUserMuted(target.identity, !muted)}>
        {muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
        <span>{t('voice.menu.mute')}</span>
        <span className="context-menu-check" aria-hidden="true">
          {muted ? '✓' : ''}
        </span>
      </button>
      <p className="context-menu-hint">{t('voice.menu.localHint')}</p>
      {guildId && !isSelf && (canMute || canDeafen) && (
        <>
          <div className="context-menu-separator" role="separator" />
          {canMute && (
            <button type="button" role="menuitemcheckbox" aria-checked={serverState?.muted === true} className="context-menu-item is-admin" onClick={() => serverAction('mute', serverState?.muted !== true)}>
              <MicOff size={15} aria-hidden="true" />
              <span>{t('voiceLock.serverMute')}</span>
              <span className="context-menu-check" aria-hidden="true">
                {serverState?.muted ? '✓' : ''}
              </span>
            </button>
          )}
          {canDeafen && (
            <button type="button" role="menuitemcheckbox" aria-checked={serverState?.deafened === true} className="context-menu-item is-admin" onClick={() => serverAction('deafen', serverState?.deafened !== true)}>
              <HeadphoneOff size={15} aria-hidden="true" />
              <span>{t('voiceLock.serverDeafen')}</span>
              <span className="context-menu-check" aria-hidden="true">
                {serverState?.deafened ? '✓' : ''}
              </span>
            </button>
          )}
        </>
      )}
      {(canMove || canDisconnect) && (
        <>
          <div className="context-menu-separator" role="separator" />
          {canMove && (
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={() => {
                closeMenu();
                openMoveUser({ id: target.identity, displayName: target.name }, target.channelId);
              }}
            >
              <ArrowRightLeft size={15} aria-hidden="true" />
              <span>{t('voice.moderation.moveTo')}</span>
            </button>
          )}
          {canDisconnect && (
            <button
              type="button"
              role="menuitem"
              className="context-menu-item is-admin"
              onClick={() => {
                closeMenu();
                openVoiceDisconnect({ id: target.identity, displayName: target.name }, target.channelId);
              }}
            >
              <PhoneOff size={15} aria-hidden="true" />
              <span>{t('voice.menu.disconnect')}</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Mounted once in the app shell: renders the open menu and the admin confirmation. */
export function ParticipantMenuHost() {
  const { t } = useTranslation();
  const target = useParticipantMenu((s) => s.target);
  const confirm = useParticipantMenu((s) => s.confirm);
  const inCall = useVoiceStore((s) => s.status === 'connected' || s.status === 'reconnecting');

  useEffect(() => {
    if (!inCall) useParticipantMenu.setState({ target: null });
  }, [inCall]);

  return (
    <>
      {target && createPortal(<Menu target={target} />, document.body)}
      {confirm && (
        <ConfirmDialog
          title={t('voice.menu.disconnectTitle', { name: confirm.name })}
          confirmLabel={t('voice.menu.disconnectConfirm')}
          tone="primary"
          onClose={() => useParticipantMenu.setState({ confirm: null })}
          onConfirm={async () => {
            try {
              await voiceApi.disconnectParticipant(confirm.channelId, confirm.identity);
              toast.info(translate('voice.menu.disconnected', { name: confirm.name }), 'voice-disconnect');
            } catch (error) {
              // VOICE_PARTICIPANT_NOT_FOUND: they left before we confirmed. Plain NOT_FOUND ("Route not
              // found"): the server does not have the disconnect endpoint yet (not redeployed).
              const code = isApiError(error) ? error.code : '';
              const message =
                code === 'VOICE_PARTICIPANT_NOT_FOUND'
                  ? translate('voice.menu.alreadyLeft')
                  : code === 'NOT_FOUND'
                    ? translate('voice.menu.serverOutdated')
                    : friendlyError(error, translate('voice.menu.disconnectFailed'));
              throw new Error(message, { cause: error });
            }
          }}
        >
          <p>{t('voice.menu.disconnectBody')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
