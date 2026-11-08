import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { metaApi } from '../../api/meta';
import type { ReleaseInfo } from '../../api/types';
import { apiUrl, config, getApiOrigin } from '../../config';
import { LogoMark } from '../Logo';
import { isDesktop } from '../../desktop/bridge';
import { UpdatePanel } from '../desktop/UpdatePanel';
import { useDesktopStore } from '../../desktop/desktopStore';
import { Sparkles } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { openWhatsNew } from '../../whatsNew/whatsNewStore';

type Health = 'checking' | 'ok' | 'down';

export function AboutSettings() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<ReleaseInfo | null | 'error'>(null);
  const [health, setHealth] = useState<Health>('checking');
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const info = useDesktopStore((s) => s.info);
  const updateState = useDesktopStore((s) => s.updateState);
  const latestFromUpdater =
    updateState.status === 'available' || updateState.status === 'downloading' || updateState.status === 'downloaded' ? updateState.version : updateState.status === 'not-available' ? (info?.appVersion ?? null) : null;

  useEffect(() => {
    let cancelled = false;
    metaApi.desktopRelease().then(
      (r) => {
        if (!cancelled) setRelease(r);
      },
      () => {
        if (!cancelled) setRelease('error');
      },
    );
    // 0.5.1: the server's own version (GET /api/v1/version).
    fetch(apiUrl('/api/v1/version'), { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
      .then(
        (v) => {
          if (!cancelled) setApiVersion(v?.version ?? '—');
        },
        () => {
          if (!cancelled) setApiVersion('—');
        },
      );
    fetch(apiUrl('/ready'), { cache: 'no-store' }).then(
      (r) => {
        if (!cancelled) setHealth(r.ok ? 'ok' : 'down');
      },
      () => {
        if (!cancelled) setHealth('down');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-stack">
      <div className="settings-card about-hero">
        <LogoMark size={64} />
        <div>
          <div className="about-name">{config.appName}</div>
          <div className="about-version">{isDesktop && info ? t('settings.about.desktopApp', { version: info.appVersion }) : `${t('settings.about.webClient')} ${config.clientVersion}`}</div>
          {/* 0.5.6: the release notes; settings close first so the two dialogs never stack. */}
          <button
            type="button"
            className="btn btn-secondary btn-sm about-whats-new"
            onClick={() => {
              useUiStore.getState().closeSettings();
              openWhatsNew();
            }}
          >
            <Sparkles size={14} aria-hidden="true" /> {t('settings.about.whatsNew')}
          </button>
        </div>
      </div>
      <div className="settings-card">
        <dl className="about-list">
          {isDesktop && info && (
            <>
              <dt>{t('settings.about.desktopVersionLabel')}</dt>
              <dd>{info.appVersion}</dd>
              <dt>{t('settings.about.engine')}</dt>
              <dd>
                Electron {info.electronVersion} · Chromium {info.chromeVersion}
              </dd>
            </>
          )}
          <dt>{isDesktop ? t('settings.about.interface') : t('settings.about.webClient')}</dt>
          <dd>{config.clientVersion}</dd>
          <dt>{t('settings.about.apiVersion')}</dt>
          <dd>{apiVersion ?? t('settings.about.checking')}</dd>
          <dt>{t('settings.about.server')}</dt>
          <dd>
            <span className="about-host">{getApiOrigin() || window.location.origin}</span>
            <span className={`health-chip is-${health}`}>{health === 'checking' ? t('settings.about.checking') : health === 'ok' ? t('settings.about.online') : t('settings.about.unreachable')}</span>
          </dd>
          <dt>{isDesktop ? t('settings.about.latestRelease') : t('settings.about.desktop')}</dt>
          <dd>
            {/* 0.4.2: in the app, latest.yml (electron-updater) is the only source of truth. */}
            {isDesktop && info ? (
              (latestFromUpdater ?? t('settings.about.checking'))
            ) : (
              <>
                {release === null && t('settings.about.checking')}
                {release === 'error' && t('settings.about.unavailable')}
                {release && release !== 'error' && t('settings.about.desktopVersion', { latest: release.latestVersion, minimum: release.minimumVersion })}
              </>
            )}
          </dd>
        </dl>
        {!isDesktop && <p className="field-hint">{t('settings.about.hint')}</p>}
      </div>
      {isDesktop && (
        <div className="settings-card">
          <h4 className="settings-card-title">{t('settings.about.updates')}</h4>
          <UpdatePanel />
        </div>
      )}
    </div>
  );
}
