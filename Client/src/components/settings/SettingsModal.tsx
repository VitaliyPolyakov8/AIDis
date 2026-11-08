import { useTranslation } from 'react-i18next';
import { Activity, Gamepad2, Info, Keyboard, Languages, LogOut, Mic, MonitorCog, MonitorUp, Palette, ShieldCheck, SlidersHorizontal, Sparkles, UserRound } from 'lucide-react';
import { Modal } from '../Modal';
import { useUiStore, type SettingsTab } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AccountSettings } from './AccountSettings';
import { VoiceSettings } from './VoiceSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { AboutSettings } from './AboutSettings';
import { LanguageSettings } from './LanguageSettings';
import { InterfaceSettings } from './InterfaceSettings';
import { StreamingSettings } from './StreamingSettings';
import { KeybindsSettings } from './KeybindsSettings';
import { DesktopSettings } from './DesktopSettings';
import { OverlaySettings } from './OverlaySettings';
import { isDesktop } from '../../desktop/bridge';
import { ProfileSettings } from './ProfileSettings';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { AdminPanel } from '../admin/AdminPanel';

const ALL_TABS: { id: SettingsTab; icon: typeof Info; desktopOnly?: boolean; adminOnly?: boolean }[] = [
  { id: 'account', icon: UserRound },
  { id: 'profile', icon: Sparkles },
  { id: 'voice', icon: Mic },
  { id: 'streaming', icon: MonitorUp, desktopOnly: true },
  { id: 'keybinds', icon: Keyboard, desktopOnly: true },
  { id: 'language', icon: Languages },
  { id: 'interface', icon: SlidersHorizontal },
  { id: 'appearance', icon: Palette },
  { id: 'overlay', icon: Gamepad2, desktopOnly: true },
  { id: 'desktop', icon: MonitorCog, desktopOnly: true },
  // 0.5.8: accounts, devices, system health, storage, announcement (ADMIN accounts only).
  { id: 'admin', icon: ShieldCheck, adminOnly: true },
  { id: 'diagnostics', icon: Activity },
  { id: 'about', icon: Info },
];

/** Desktop-only sections (global hotkeys, capture quality, tray) are hidden in the browser. */
const PLATFORM_TABS = ALL_TABS.filter((tab) => isDesktop || !tab.desktopOnly);

export function SettingsModal() {
  const { t } = useTranslation();
  const requested = useUiStore((s) => s.settingsTab);
  // 0.7.0: server administration moved to each server's own settings (server menu).
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  const TABS = PLATFORM_TABS.filter((tab) => isAdmin || !tab.adminOnly);
  const tab = TABS.some((item) => item.id === requested) ? requested : 'account';
  const open = useUiStore((s) => s.openSettings);
  const close = useUiStore((s) => s.closeSettings);
  const logout = useAuthStore((s) => s.logout);

  return (
    <Modal title={t('settings.title')} onClose={close} size="lg" className="settings-modal" hideTitle>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.sectionsLabel')}>
          <div className="settings-nav-title">{t('settings.title')}</div>
          <div role="tablist" aria-orientation="vertical" className="settings-tabs">
            {TABS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="settings-panel"
                className={`settings-tab${tab === id ? ' is-active' : ''}`}
                onClick={() => open(id)}
              >
                <Icon size={16} aria-hidden="true" />
                {t(`settings.tabs.${id}`)}
              </button>
            ))}
          </div>
          <button type="button" className="settings-tab is-danger" onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            {t('common.logOut')}
          </button>
        </nav>
        <section id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-panel">
          <h3 className="settings-panel-title">{t(`settings.tabs.${tab}`)}</h3>
          {tab === 'account' && <AccountSettings />}
          {tab === 'voice' && <VoiceSettings />}
          {tab === 'language' && <LanguageSettings />}
          {tab === 'interface' && <InterfaceSettings />}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'streaming' && <StreamingSettings />}
          {tab === 'keybinds' && <KeybindsSettings />}
          {tab === 'desktop' && <DesktopSettings />}
          {tab === 'overlay' && <OverlaySettings />}
          {tab === 'profile' && <ProfileSettings />}
          {tab === 'admin' && <AdminPanel />}
          {tab === 'diagnostics' && <DiagnosticsSettings />}
          {tab === 'about' && <AboutSettings />}
        </section>
      </div>
    </Modal>
  );
}
