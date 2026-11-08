import { UpdateRequired } from '../components/desktop/UpdateRequired';
import { GamePromptHost } from '../games/GamePrompt';
import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import { friendlyError } from '../api/errors';
import { ChannelSidebar } from '../components/ChannelSidebar';
import { MembersSidebar } from '../components/MembersSidebar';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { InstallHint } from '../pwa/InstallHint';
import { SettingsModal } from '../components/settings/SettingsModal';
import { ParticipantMenuHost } from '../components/voice/ParticipantMenu';
import { ProfilePopoutHost } from '../components/profile/ProfilePopout';
import { MenuHost } from '../components/menu/MenuHost';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { DmDialogHost } from '../components/dm/DmDialogs';
import { ChannelDialogHost } from '../components/admin/ChannelDialog';
import { GuildDialogHost } from '../components/guilds/GuildDialogHost';
import { SearchPanel } from '../components/chat/ChannelTools';
import { IncomingCallBanner, VoiceMoveWatcher } from '../components/voice/CallWatchers';
import { ModerationDialogHost } from '../components/voice/ModerationDialogs';
import { UpdateBanner } from '../components/desktop/UpdatePanel';
import { isDesktop } from '../desktop/bridge';
import { SplashScreen } from '../components/Splash';
import { useAuthStore } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useGuildStore } from '../stores/guildStore';
import { activeGuildFromPath, lastGuild } from '../components/guilds/routes';
import { startSession } from '../session';
import { config } from '../config';
import { t as translate } from '../i18n';
import { CameraPickerHost } from '../components/voice/CameraPicker';
import { WhatsNewHost } from '../whatsNew/WhatsNew';

/** Authenticated layout: channels | center (chat or voice) | members. */
export function AppShell() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const channelDrawerOpen = useUiStore((s) => s.channelDrawerOpen);
  const membersDrawerOpen = useUiStore((s) => s.membersDrawerOpen);
  const membersOpen = useUiStore((s) => s.membersOpen);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setChannelDrawer = useUiStore((s) => s.setChannelDrawer);
  const setMembersDrawer = useUiStore((s) => s.setMembersDrawer);
  const density = useSettingsStore((s) => s.messageDensity);
  const logout = useAuthStore((s) => s.logout);
  const location = useLocation();
  const playing = location.pathname.startsWith('/play');
  const searchOpen = useUiStore((s) => s.search.open);
  const updateRequired = useUiStore((s) => s.updateRequired);
  const guildsLoaded = useGuildStore((s) => s.loaded);

  // 0.7.0: the open server follows the URL (/channels/@me = Home). Other sections keep the last one.
  useEffect(() => {
    const segment = activeGuildFromPath(location.pathname);
    if (segment === undefined) {
      // A section page (games, F1...) opened directly: show the last server's channels next to it.
      const { activeGuildId, guilds } = useGuildStore.getState();
      const last = lastGuild();
      const target = guilds.find((g) => g.id === last) ?? guilds[0];
      if (activeGuildId === null && target)
        void useGuildStore
          .getState()
          .openGuild(target.id)
          .catch(() => undefined);
      return;
    }
    const target = segment && useGuildStore.getState().guilds.some((g) => g.id === segment) ? segment : null;
    if (useGuildStore.getState().activeGuildId !== target)
      void useGuildStore
        .getState()
        .openGuild(target)
        .catch(() => undefined);
  }, [location.pathname, guildsLoaded]);

  const load = useCallback(() => {
    startSession().then(
      () => setPhase('ready'),
      (e: unknown) => {
        if (useAuthStore.getState().status !== 'authenticated') return;
        setError(friendlyError(e, translate('splash.loadFailed')));
        setPhase('error');
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = () => {
    setPhase('loading');
    setError(null);
    load();
  };

  // Close mobile drawers after navigating.
  useEffect(() => {
    setChannelDrawer(false);
    setMembersDrawer(false);
  }, [location.pathname, setChannelDrawer, setMembersDrawer]);

  // 0.7.0: this version is too old for the server: only the update screen (cannot be closed).
  if (updateRequired) return <UpdateRequired />;
  if (phase === 'loading') return <SplashScreen label={t('splash.loadingWorkspace')} />;
  if (phase === 'error') {
    return (
      <div className="splash">
        <CircleAlert size={36} className="splash-icon" aria-hidden="true" />
        <h1 className="splash-title">{t('splash.loadFailedTitle', { app: config.appName })}</h1>
        <p className="splash-text">{error}</p>
        <div className="splash-actions">
          <button type="button" className="btn btn-primary" onClick={retry}>
            {t('common.tryAgain')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
            {t('common.logOut')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={['shell', `density-${density}`, membersOpen && !playing ? 'members-open' : 'members-closed', channelDrawerOpen ? 'channel-drawer-open' : '', membersDrawerOpen ? 'members-drawer-open' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <ChannelSidebar />
      <main className="center">
        <ConnectionBanner />
        <AnnouncementBanner />
        <InstallHint />
        {isDesktop && <UpdateBanner />}
        <ErrorBoundary key={location.pathname} area="view">
          <Outlet />
        </ErrorBoundary>
      </main>
      {searchOpen ? <SearchPanel /> : <MembersSidebar />}
      {(channelDrawerOpen || membersDrawerOpen) && (
        <button
          type="button"
          className="drawer-scrim"
          aria-label={t('header.closePanel')}
          onClick={() => {
            setChannelDrawer(false);
            setMembersDrawer(false);
          }}
        />
      )}
      {settingsOpen && (
        <ErrorBoundary area="settings">
          <SettingsModal />
        </ErrorBoundary>
      )}
      <ParticipantMenuHost />
      <ProfilePopoutHost />
      <MenuHost />
      <CameraPickerHost />
      <DmDialogHost />
      <ChannelDialogHost />
      <GuildDialogHost />
      <IncomingCallBanner />
      <ModerationDialogHost />
      <VoiceMoveWatcher />
      <WhatsNewHost />
      <GamePromptHost />
    </div>
  );
}
