import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff, FolderOpen, Gamepad2, X } from 'lucide-react';
import { AUTO_AWAY_MINUTES, type AutoAwayMinutes } from '../../desktop/contract';
import { desktop } from '../../desktop/bridge';
import { useDesktopStore } from '../../desktop/desktopStore';
import { Toggle } from './Toggle';
import { ServerList } from './ServerList';

/** Settings → Desktop (desktop only): startup, tray, notifications, logs. */
export function DesktopSettings() {
  const { t } = useTranslation();
  const prefs = useDesktopStore((s) => s.settings.preferences);
  const update = useDesktopStore((s) => s.update);
  const [detected, setDetected] = useState<string | null>(null);

  // The game AIDis sees right now (local only), so it can be hidden from others.
  useEffect(() => {
    if (!desktop) return;
    void desktop.presence.getDetectedGame().then(setDetected, () => undefined);
    return desktop.presence.onActivity(setDetected);
  }, []);

  return (
    <div className="settings-stack">
      <ServerList />
      <div className="settings-card">
        <h4 className="settings-card-title">{t('presence.title')}</h4>
        <Toggle label={t('presence.autoAway')} hint={t('presence.autoAwayHint')} checked={prefs.autoAway} onChange={(v) => void update({ preferences: { autoAway: v } })} />
        <div className="field">
          <label className="field-label" htmlFor="auto-away-minutes">
            {t('presence.autoAwayAfter')}
          </label>
          <select
            id="auto-away-minutes"
            className="select"
            value={prefs.autoAwayMinutes}
            disabled={!prefs.autoAway}
            onChange={(e) => void update({ preferences: { autoAwayMinutes: Number(e.target.value) as AutoAwayMinutes } })}
          >
            {AUTO_AWAY_MINUTES.map((m) => (
              <option key={m} value={m}>
                {t('presence.minutes', { count: m })}
              </option>
            ))}
          </select>
        </div>
        <Toggle label={t('presence.showGame')} hint={t('presence.showGameHint')} checked={prefs.showGameActivity} onChange={(v) => void update({ preferences: { showGameActivity: v } })} />
        <div className="setting-row is-compact detected-game">
          <span className="setting-row-text">
            <span className="setting-row-title">
              <Gamepad2 size={14} aria-hidden="true" /> {detected ? t('presence.detected', { name: detected }) : t('presence.noGame')}
            </span>
          </span>
          {detected && !prefs.hiddenGames.includes(detected) && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void update({ preferences: { hiddenGames: [...prefs.hiddenGames, detected] } })}>
              <EyeOff size={14} aria-hidden="true" />
              {t('presence.hideGame')}
            </button>
          )}
        </div>
        {prefs.hiddenGames.length > 0 && (
          <div className="field">
            <span className="field-label">{t('presence.hiddenGames')}</span>
            <ul className="hidden-games">
              {prefs.hiddenGames.map((g) => (
                <li key={g} className="hidden-game">
                  <span>{g}</span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label={t('presence.unhideGame', { name: g })}
                    title={t('presence.unhideGame', { name: g })}
                    onClick={() => void update({ preferences: { hiddenGames: prefs.hiddenGames.filter((x) => x !== g) } })}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="field-hint">{t('presence.privacy')}</p>
      </div>
      <div className="settings-card">
        <Toggle label={t('desktop.prefs.startWithWindows')} hint={t('desktop.prefs.startWithWindowsHint')} checked={prefs.startWithWindows} onChange={(v) => void update({ preferences: { startWithWindows: v } })} />
        <Toggle label={t('desktop.prefs.closeToTray')} hint={t('desktop.prefs.closeToTrayHint')} checked={prefs.closeToTray} onChange={(v) => void update({ preferences: { closeToTray: v } })} />
        <Toggle label={t('desktop.prefs.notifications')} hint={t('desktop.prefs.notificationsHint')} checked={prefs.notifications} onChange={(v) => void update({ preferences: { notifications: v } })} />
      </div>
      <div className="settings-card">
        <h4 className="settings-card-title">{t('desktop.prefs.troubleshooting')}</h4>
        <p className="field-hint">{t('desktop.prefs.logsHint')}</p>
        <div className="settings-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => desktop?.app.openLogsFolder()}>
            <FolderOpen size={14} aria-hidden="true" />
            {t('desktop.prefs.openLogs')}
          </button>
        </div>
      </div>
    </div>
  );
}
