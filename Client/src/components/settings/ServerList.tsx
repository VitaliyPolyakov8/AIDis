import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Server, X } from 'lucide-react';
import { desktop } from '../../desktop/bridge';
import { useDesktopStore } from '../../desktop/desktopStore';
import { ServerAddressForm } from '../../pages/ConnectPage';

/** Settings → Desktop (desktop): the AIDis servers this app knows; switching reloads the window. */
export function ServerList() {
  const { t } = useTranslation();
  const servers = useDesktopStore((s) => s.servers);
  const current = useDesktopStore((s) => s.server);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!desktop?.servers) return null;
  const api = desktop.servers;

  const remove = async (origin: string) => {
    setRemoving(null);
    await api.remove(origin).catch(() => undefined);
    useDesktopStore.setState((s) => ({ servers: s.servers.filter((x) => x.origin !== origin) }));
  };

  return (
    <div className="settings-card">
      <h4 className="settings-card-title">{t('servers.title')}</h4>
      <p className="field-hint">{t('servers.hint')}</p>
      <ul className="server-list">
        {servers.map((s) => (
          <li key={s.origin} className="setting-row is-compact">
            <span className="setting-row-text">
              <span className="setting-row-title">
                <Server size={14} aria-hidden="true" /> {s.name}
                {s.origin === current?.origin && <span className="server-current"> · {t('servers.current')}</span>}
              </span>
              {removing === s.origin && <span className="field-hint">{t('servers.removeConfirm', { name: s.name })}</span>}
            </span>
            {removing === s.origin ? (
              <span className="settings-actions">
                <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove(s.origin)}>
                  {t('servers.removeYes')}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRemoving(null)}>
                  {t('servers.cancel')}
                </button>
              </span>
            ) : (
              <span className="settings-actions">
                {s.origin !== current?.origin && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void api.select(s.origin)}>
                    {t('servers.switch')}
                  </button>
                )}
                <button type="button" className="icon-btn icon-btn-sm" aria-label={t('servers.remove', { name: s.name })} title={t('servers.remove', { name: s.name })} onClick={() => setRemoving(s.origin)}>
                  <X size={14} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <ServerAddressForm autoFocus onAdded={() => setAdding(false)} />
      ) : (
        <div className="settings-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" />
            {t('servers.add')}
          </button>
        </div>
      )}
    </div>
  );
}
