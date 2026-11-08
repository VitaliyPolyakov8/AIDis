import { useEffect, useMemo } from 'react';
import { useCallNames } from '../stores/guildStore';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { HeadphoneOff, MessageSquare, Settings2, MicOff, MonitorOff, MonitorUp, MonitorX, PhoneOff, TriangleAlert, Video, Volume2, VolumeX, X } from 'lucide-react';
import { CenterHeader } from '../components/CenterHeader';
import { Avatar } from '../components/Avatar';
import { CameraButton, StreamStage } from '../components/voice/StreamView';
import { StreamTile } from '../components/voice/StreamTile';
import { SignalBars } from '../components/SignalBars';
import { DeafenButton, MicButton } from '../components/UserPanel';
import { DefaultChannelRedirect } from './DefaultChannelRedirect';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { isParticipantDeafened, liveStreams, useVoiceStore, type StreamRef, type VoiceParticipant } from '../voice/voiceStore';
import type { Channel } from '../api/types';
import { voice } from '../voice/voiceService';
import { canShareScreen } from '../voice/screenShareQuality';
import { requestScreenShare } from '../desktop/screenCapture';
import { RecentSoundBadge, SoundboardButton } from '../sounds-board/SoundboardButton';
import { openParticipantMenu } from '../components/voice/participantMenuState';
import { openProfile } from '../components/profile/profileState';
import { SpeakingFrame } from '../components/profile/ProfileBits';
import { VoiceSessionTimer } from '../components/voice/VoiceSessionTimer';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { useReadStore } from '../stores/readStore';
import { useAuthStore } from '../stores/authStore';
import { displayChannel } from '../utils/dm';
import { VoiceChatPanel } from '../components/voice/VoiceChatPanel';
import { config } from '../config';
import { useNameStyle } from '../components/profile/nameStyle';
import { VoiceRoom } from '../components/voice/VoiceRoom';
import { isDesktop } from '../desktop/bridge';

function ParticipantTile({ p, compact }: { p: VoiceParticipant; compact?: boolean }) {
  const { t } = useTranslation();
  const user = usePresenceStore((s) => s.users[p.identity]);
  const names = useCallNames();
  const name = names(p.identity, user?.displayName ?? p.name);
  const nameStyle = useNameStyle(p.identity);
  const locallyMuted = useSettingsStore((s) => s.userMutes[p.identity] === true);
  const deafened = useVoiceStore((s) => isParticipantDeafened(s, p.identity, p.isLocal));
  return (
    <li
      className={`participant-tile${p.isSpeaking ? ' is-speaking' : ''}${compact ? ' is-compact' : ''}${p.connectionLost ? ' is-lost' : ''}${p.screenSharing ? ' is-streaming' : ''}`}
      onContextMenu={(e) => openParticipantMenu(e, p.identity, name)}
    >
      <button type="button" className="participant-avatar-btn" aria-label={name} onClick={(e) => openProfile(e, p.identity)}>
        <SpeakingFrame frame={user?.profileFrame} speaking={p.isSpeaking} size={compact ? 32 : 76}>
          <Avatar userId={p.identity} name={name} avatarAttachmentId={user?.avatarAttachmentId} size={compact ? 32 : 76} speaking={p.isSpeaking} />
        </SpeakingFrame>
      </button>
      <span className="participant-name">
        <span className={nameStyle.className} style={nameStyle.style}>
          {name}
        </span>
        {p.isLocal && <span className="participant-you"> ({t('voice.you')})</span>}
      </span>
      {/* 0.5.8: streams have their own tiles (StreamTile); the person's tile only shows LIVE. */}
      <span className="participant-icons">
        {p.screenSharing && !p.isLocal && <span className="live-badge">{t('voice.live')}</span>}
        {p.screenSharing && p.isLocal && <span className="live-badge">{t('voice.live')}</span>}
        {p.camera && (
          <span className="live-badge is-camera" title={t('camera.live')}>
            <Video size={10} aria-hidden="true" />
          </span>
        )}
        {locallyMuted && !p.isLocal && (
          <span className="muted-chip" title={t('voice.menu.locallyMuted')}>
            <VolumeX size={13} role="img" aria-label={t('voice.menu.locallyMuted')} />
          </span>
        )}
        <RecentSoundBadge userId={p.identity} />
        {p.micMuted && (
          <span className="muted-chip" title={t('voice.muted')}>
            <MicOff size={13} role="img" aria-label={t('voice.muted')} />
          </span>
        )}
        {deafened && (
          <span className="muted-chip" title={t('voice.deafened')}>
            <HeadphoneOff size={13} role="img" aria-label={t('voice.deafened')} />
          </span>
        )}
      </span>
    </li>
  );
}

function ShareButton() {
  const { t } = useTranslation();
  const sharing = useVoiceStore((s) => s.localScreenSharing);
  const status = useVoiceStore((s) => s.status);
  if (!canShareScreen()) return null;
  return (
    <button
      type="button"
      className={`control-btn control-share${sharing ? ' is-sharing' : ''}`}
      aria-pressed={sharing}
      disabled={status !== 'connected'}
      onClick={() => (sharing ? void voice.stopScreenShare() : requestScreenShare())}
    >
      {sharing ? <MonitorOff size={19} aria-hidden="true" /> : <MonitorUp size={19} aria-hidden="true" />}
      <span className="control-label">{sharing ? t('voice.stopSharing') : t('voice.shareScreen')}</span>
    </button>
  );
}

function ControlBar() {
  const { t } = useTranslation();
  return (
    <div className="voice-controls" role="toolbar" aria-label={t('voice.controls')}>
      <MicButton className="control-btn" />
      <DeafenButton className="control-btn" />
      <ShareButton />
      <CameraButton className="control-btn" connected withLabel />
      <SoundboardButton variant="control" />
      <button type="button" className="control-btn is-leave" aria-label={t('voice.leaveChannel')} onClick={() => void voice.leave()}>
        <PhoneOff size={19} aria-hidden="true" />
        <span className="control-label">{t('voice.leave')}</span>
      </button>
    </div>
  );
}

function PresenterStage({ watched, shares, channel }: { watched: StreamRef[]; shares: StreamRef[]; channel: Channel }) {
  const { t } = useTranslation();
  const users = usePresenceStore((s) => s.users);
  const participants = useVoiceStore((s) => s.participants);
  const notWatched = shares.filter((st) => !watched.some((w) => w.key === st.key));
  return (
    <div className="voice-stream-layout">
      <StreamStage streams={watched} channel={channel} />
      <div className="stream-footer">
        {notWatched.length > 0 && (
          <div className="share-switcher" aria-label={t('voice.screenShares')}>
            {notWatched.map((st) => {
              const name = users[st.identity]?.displayName ?? st.presenter.name;
              const label = st.source === 'camera' ? (st.presenter.isLocal ? t('camera.yourCamera') : t('camera.watchNamed', { name })) : st.presenter.isLocal ? t('voice.yourScreen') : t('voice.watch', { name });
              return (
                <button key={st.key} type="button" className="share-tab" onClick={() => voice.watchShare(st.key)}>
                  <span className="live-badge">
                    {st.source === 'camera' && <Video size={10} aria-hidden="true" />}
                    {t('voice.live')}
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <ul className="participant-strip">
          {participants.map((p) => (
            <ParticipantTile key={p.identity} p={p} compact />
          ))}
        </ul>
      </div>
    </div>
  );
}

export function VoiceView() {
  const { t } = useTranslation();
  const { channelId = '' } = useParams();
  const voiceChannel = useChatStore((s) => s.channels.find((c) => c.id === channelId && c.type === 'VOICE'));
  // 0.4.0: DM calls use this same view (their chat is the DM).
  const dm = useChatStore((s) => s.dms.find((c) => c.id === channelId));
  const allUsers = usePresenceStore((s) => s.users);
  const selfId = useAuthStore((s) => s.user?.id);
  const channel = useMemo(() => voiceChannel ?? (dm ? displayChannel(dm, allUsers, selfId) : undefined), [voiceChannel, dm, allUsers, selfId]);
  const status = useVoiceStore((s) => s.status);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const participants = useVoiceStore((s) => s.participants);
  const watchedShares = useVoiceStore((s) => s.watchedShares);
  const endedShare = useVoiceStore((s) => s.endedShare);
  const localSharing = useVoiceStore((s) => s.localScreenSharing);
  const quality = useVoiceStore((s) => s.quality);
  const error = useVoiceStore((s) => s.error);
  const micError = useVoiceStore((s) => s.micError);
  const audioBlocked = useVoiceStore((s) => s.audioBlocked);
  const occupancy = useVoiceStore((s) => s.occupancy[channelId]);
  const users = usePresenceStore((s) => s.users);
  const names = useCallNames(channelId);
  const chatOpen = useUiStore((s) => s.voiceChatOpen);
  // In fullscreen the stream viewer shows the chat itself (only one chat panel at a time).
  const streamFullscreen = useUiStore((s) => s.streamFullscreen);
  const setVoiceChat = useUiStore((s) => s.setVoiceChat);
  const chatUnread = useReadStore((s) => (s.reads[channelId]?.unread ?? 0) > 0);

  useEffect(() => {
    if (channel) document.title = `${channel.name} · ${config.appName}`;
  }, [channel]);

  if (!channel) return <DefaultChannelRedirect />;

  const here = voiceChannelId === channel.id && status !== 'idle';
  // 0.5.0: screen shares and cameras are separate streams (stream keys).
  const shares = liveStreams(participants);
  // 0.4.5: only what this device chose to watch (in the order it was opened).
  const watched = here ? watchedShares.map((key) => shares.find((st) => st.key === key)).filter((st): st is StreamRef => st !== undefined) : [];
  const presenter = watched[0];

  return (
    <div className={`voice-view${chatOpen ? ' has-chat' : ''}`}>
      <CenterHeader icon={<Volume2 size={19} />} title={channel.name} description={channel.description}>
        <VoiceSessionTimer channelId={channel.id} chip />
        {here && status !== 'error' && (
          <span className={`status-chip is-${status}`} title={status === 'connected' ? t(`voice.quality.${quality}`) : undefined}>
            <SignalBars quality={quality} status={status} />
            <span className="header-label">{t(`voice.status.${status}`)}</span>
          </span>
        )}
        <button
          type="button"
          className={`btn btn-sm ${chatOpen ? 'btn-secondary is-active' : 'btn-ghost'} voice-chat-toggle${chatUnread ? ' is-unread' : ''}`}
          aria-pressed={chatOpen}
          onClick={() => setVoiceChat(!chatOpen)}
          title={chatOpen ? t('voice.chat.close') : t('voice.chat.open')}
          aria-label={chatOpen ? t('voice.chat.close') : t('voice.chat.open')}
        >
          <MessageSquare size={15} aria-hidden="true" />
          <span className="header-label">{chatOpen ? t('voice.chat.close') : t('voice.chat.open')}</span>
        </button>
      </CenterHeader>

      <div className="voice-body">
        <div className="voice-main">
          {!here || status === 'error' ? (
            <div className="voice-join">
              <span className="voice-join-icon" aria-hidden="true">
                <Volume2 size={28} />
              </span>
              <h2 className="voice-join-title">{channel.name}</h2>
              {occupancy && occupancy.length > 0 ? (
                <ul className="voice-join-people" aria-label={t('voice.alreadyHere')}>
                  {occupancy.map((p) => {
                    const name = names(p.identity, users[p.identity]?.displayName ?? p.name);
                    return (
                      <li key={p.identity} className="voice-join-person">
                        <Avatar userId={p.identity} name={name} avatarAttachmentId={users[p.identity]?.avatarAttachmentId} size={34} />
                        <span>{name}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="voice-join-text">{t('voice.nobodyHere')}</p>
              )}
              {here && error && (
                <p className="alert alert-error" role="alert">
                  <TriangleAlert size={16} aria-hidden="true" />
                  {error}
                </p>
              )}
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void voice.join(channel.id)}>
                {here && error ? t('common.tryAgain') : voiceChannelId && voiceChannelId !== channel.id && status === 'connected' ? t('voice.switchHere') : t('voice.join')}
              </button>
            </div>
          ) : (
            <div className="voice-stage">
              {status === 'connecting' && participants.length === 0 ? (
                <div className="voice-connecting" role="status">
                  <span className="spinner spinner-lg" aria-hidden="true" />
                  {t('voice.connectingTo', { channel: channel.name })}
                </div>
              ) : (
                <>
                  {(micError || audioBlocked || localSharing || (endedShare && !presenter)) && (
                    <div className="voice-alerts">
                      {localSharing && (
                        <div className="share-banner" role="status">
                          <span className="live-dot" aria-hidden="true" />
                          <span className="share-banner-text">{t('voice.youAreSharing')}</span>
                          {isDesktop && (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => useUiStore.getState().setSourcePicker(true, 'change')}>
                              <Settings2 size={14} aria-hidden="true" />
                              {t('voice.changeStream')}
                            </button>
                          )}
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => void voice.stopScreenShare()}>
                            <MonitorOff size={14} aria-hidden="true" />
                            {t('voice.stopSharing')}
                          </button>
                        </div>
                      )}
                      {endedShare && !presenter && (
                        <div className="alert alert-neutral" role="status">
                          <MonitorX size={16} aria-hidden="true" />
                          <span className="alert-text">
                            {t('voice.streamEnded')}. {t('voice.stoppedSharing', { name: endedShare })}
                          </span>
                          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('common.dismiss')} onClick={() => voice.dismissEndedShare()}>
                            <X size={14} />
                          </button>
                        </div>
                      )}
                      {micError && (
                        <p className="alert alert-warn" role="alert">
                          <MicOff size={16} aria-hidden="true" />
                          <span className="alert-text">{micError}</span>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void voice.retryMicrophone()}>
                            {t('common.retry')}
                          </button>
                        </p>
                      )}
                      {audioBlocked && (
                        <p className="alert alert-info">
                          <span className="alert-text">{t('voice.audioBlocked')}</span>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => void voice.enableAudio()}>
                            {t('voice.enableSound')}
                          </button>
                        </p>
                      )}
                    </div>
                  )}
                  {presenter ? (
                    <PresenterStage watched={watched} shares={shares} channel={channel} />
                  ) : channel.voiceLayout === 'room' ? (
                    <VoiceRoom participants={participants} />
                  ) : (
                    <ul className={`participant-grid count-${String(Math.min(participants.length + shares.length, 6))}`}>
                      {participants.map((p) => (
                        <ParticipantTile key={p.identity} p={p} />
                      ))}
                      {shares.map((st) => (
                        <StreamTile key={st.key} stream={st} />
                      ))}
                    </ul>
                  )}
                </>
              )}
              {/* While watching a stream its own bottom bar has these controls. */}
              {!presenter && <ControlBar />}
            </div>
          )}
        </div>
        {chatOpen && !(presenter && streamFullscreen) && <VoiceChatPanel channel={channel} />}
      </div>
    </div>
  );
}
