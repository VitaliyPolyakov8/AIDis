import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupGate } from './pages/SetupPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/ResetPasswordPage';
import { PublicInvite } from './components/guilds/PublicInvite';
import { AppShell } from './pages/AppShell';
import { DmView } from './pages/ChatView';
import { HomeView } from './pages/HomeView';
import { VoiceView } from './pages/VoiceView';
import { DefaultRedirect, GuildRedirect, LegacyRedirect } from './components/guilds/GuildRedirect';
import { GuildChannelView } from './pages/GuildChannelView';
import { InvitePage } from './pages/InvitePage';
import { savePendingInvite } from './components/guilds/inviteLinks';
import { normalizeInviteInput } from './api/invites';
import { OfflineScreen, SplashScreen } from './components/Splash';
import { Toasts } from './components/Toasts';
import { useAuthStore } from './stores/authStore';
import { useServerConfig } from './api/clientConfig';
import { ConnectPage } from './pages/ConnectPage';
import { useDesktopStore } from './desktop/desktopStore';
import { isDesktop } from './desktop/bridge';
import { DesktopBridge } from './components/desktop/DesktopBridge';
import { TitleBar, hasThemedTitleBar } from './components/desktop/TitleBar';
import './session';

/** Redirects to /login when not authenticated, remembering where the user wanted to go. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const status = useAuthStore((s) => s.status);
  const location = useLocation();
  if (status === 'authenticated') return children;
  if (status === 'unknown') return <SplashScreen label={t('splash.restoring')} />;
  if (status === 'offline') return <OfflineScreen />;
  // 0.7.0: an invite opened while logged out survives the login (also after a reload).
  const invite = /^\/invite\/([^/]+)/.exec(location.pathname)?.[1];
  const code = invite ? normalizeInviteInput(invite) : null;
  if (code) savePendingInvite(code);
  // 0.7.1: with registration on, a logged-out visitor sees the server and can sign up.
  if (code) return <PublicInvite code={code} />;
  return <Navigate to="/login" replace state={{ from: location.pathname }} />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/channels/@me" element={<HomeView />} />
        <Route path="/channels/@me/:channelId" element={<DmView />} />
        <Route path="/channels/@me/:channelId/call" element={<VoiceView />} />
        <Route path="/channels/:guildId" element={<GuildRedirect />} />
        <Route path="/channels/:guildId/:channelId" element={<GuildChannelView />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/voice/:channelId" element={<LegacyRedirect />} />
        <Route path="/dm/:channelId" element={<LegacyRedirect />} />
        <Route path="/dm" element={<LegacyRedirect />} />
        <Route path="*" element={<DefaultRedirect />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const needsServer = useDesktopStore((s) => s.needsServer);
  useEffect(() => {
    if (needsServer) return;
    void bootstrap();
    void useServerConfig.getState().load();
  }, [bootstrap, needsServer]);

  // Desktop app on first start (or after the last server was removed): ask for the address.
  if (needsServer) {
    return (
      <>
        {hasThemedTitleBar && <TitleBar />}
        <ConnectPage />
      </>
    );
  }

  return (
    <BrowserRouter>
      {hasThemedTitleBar && <TitleBar />}
      <SetupGate>
        <AppRoutes />
      </SetupGate>
      <Toasts />
      {isDesktop && <DesktopBridge />}
    </BrowserRouter>
  );
}
