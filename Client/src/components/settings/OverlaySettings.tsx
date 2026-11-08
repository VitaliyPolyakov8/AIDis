import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Move } from 'lucide-react';
import { desktop } from '../../desktop/bridge';
import { useDesktopStore } from '../../desktop/desktopStore';
import {
  OVERLAY_MESSAGE_COUNTS,
  OVERLAY_MESSAGE_SECONDS,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  OVERLAY_POSITIONS,
  OVERLAY_SCALE_MAX,
  OVERLAY_SCALE_MIN,
  type OverlaySettings as OverlayPrefs,
} from '../../desktop/contract';
import { Toggle } from './Toggle';
import { Gamepad2, Trash } from 'lucide-react';
import { profileFromSettings, OVERLAY_MAX_PROFILES } from '../../desktop/contract';

/** 0.4.0 per-game layouts: the running game can get its own position / size / mode. */
function GameProfiles({ overlay, disabled, onChange }: { overlay: OverlayPrefs; disabled: boolean; onChange: (patch: Partial<OverlayPrefs>) => void }) {
  const { t } = useTranslation();
  const [game, setGame] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void desktop.presence.getDetectedGame().then((name) => {
      if (alive) setGame(name);
    });
    const off = desktop.presence.onActivity((name) => setGame(name));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const names = Object.keys(overlay.profiles).sort((a, b) => a.localeCompare(b));
  const remove = (name: string) => {
    const { [name]: _removed, ...rest } = overlay.profiles;
    onChange({ profiles: rest });
  };
  return (
    <div className="settings-card">
      <h4 className="settings-card-title">{t('overlay.profiles.title')}</h4>
      <p className="field-hint">{t('overlay.profiles.hint')}</p>
      {game ? (
        <div className="setting-row">
          <span className="setting-row-text">
            <span className="setting-row-title">
              <Gamepad2 size={14} aria-hidden="true" /> {game}
            </span>
            <span className="field-hint">{overlay.profiles[game] ? t('overlay.profiles.active') : t('overlay.profiles.usesGlobal')}</span>
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || (!overlay.profiles[game] && names.length >= OVERLAY_MAX_PROFILES)}
            onClick={() => onChange({ profiles: { ...overlay.profiles, [game]: profileFromSettings(overlay) } })}
          >
            {overlay.profiles[game] ? t('overlay.profiles.resave') : t('overlay.profiles.save')}
          </button>
        </div>
      ) : (
        <p className="field-hint">{t('overlay.profiles.noGame')}</p>
      )}
      {names.length > 0 && (
        <ul className="admin-list">
          {names.map((name) => {
            const p = overlay.profiles[name];
            return (
              <li key={name} className="admin-row">
                <Gamepad2 size={15} aria-hidden="true" />
                <span className="admin-row-name">{name}</span>
                {p && <span className="admin-tag">{p.custom ? t('overlay.corners.custom') : t(`overlay.corners.${p.corner}`)} · {p.scale}%</span>}
                <button type="button" className="icon-btn is-danger-hover" aria-label={t('overlay.profiles.delete', { game: name })} disabled={disabled} onClick={() => remove(name)}>
                  <Trash size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Settings → Game overlay (desktop only). */
export function OverlaySettings() {
  const { t } = useTranslation();
  const overlay = useDesktopStore((s) => s.settings.overlay);
  const keybinds = useDesktopStore((s) => s.settings.keybinds);
  const update = useDesktopStore((s) => s.update);
  const [displays, setDisplays] = useState<{ id: number; label: string; primary: boolean }[]>([]);
  const set = (patch: Partial<OverlayPrefs>) => void update({ overlay: patch });

  useEffect(() => {
    let alive = true;
    desktop?.overlay
      .getDisplays()
      .then((list) => {
        if (alive) setDisplays(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const off = !overlay.enabled;
  return (
    <div className="settings-stack">
      <div className="settings-card">
        <Toggle label={t('overlay.enabled')} hint={t('overlay.enabledHint')} checked={overlay.enabled} onChange={(v) => set({ enabled: v })} />
        <Toggle label={t('overlay.onlyInGames')} hint={t('overlay.onlyInGamesHint')} checked={overlay.onlyInGames} disabled={off} onChange={(v) => set({ onlyInGames: v })} />
        <p className="field-hint overlay-note">{t('overlay.fullscreenNote')}</p>
      </div>

      <div className="settings-card">
        <h4 className="settings-card-title">{t('overlay.content')}</h4>
        <div className="setting-row">
          <span className="setting-row-text">
            <span className="setting-row-title">{t('overlay.mode')}</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label={t('overlay.mode')}>
            {(['minimal', 'extended'] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={overlay.mode === mode} className={overlay.mode === mode ? 'is-active' : ''} disabled={off} onClick={() => set({ mode })}>
                {t(`overlay.modes.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="field-hint">{t(`overlay.modes.${overlay.mode}Hint`)}</p>
        <Toggle label={t('overlay.showParticipants')} checked={overlay.showParticipants} disabled={off} onChange={(v) => set({ showParticipants: v })} />
        <Toggle label={t('overlay.showSpeaking')} checked={overlay.showSpeaking} disabled={off} onChange={(v) => set({ showSpeaking: v })} />
        <Toggle label={t('overlay.hideInactive')} hint={t('overlay.hideInactiveHint')} checked={overlay.hideInactive} disabled={off || overlay.mode === 'minimal'} onChange={(v) => set({ hideInactive: v })} />
      </div>

      <div className="settings-card">
        <h4 className="settings-card-title">{t('overlay.messages')}</h4>
        <div className="setting-row">
          <span className="setting-row-text">
            <span className="setting-row-title">{t('overlay.messageMode')}</span>
            <span className="field-hint">{t(`overlay.messageModes.${overlay.messageMode}Hint`)}</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label={t('overlay.messageMode')}>
            {(['all', 'mentions', 'off'] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={overlay.messageMode === mode} className={overlay.messageMode === mode ? 'is-active' : ''} disabled={off} onClick={() => set({ messageMode: mode, showMessages: mode !== 'off' })}>
                {t(`overlay.messageModes.${mode}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="overlay-count">
              {t('overlay.messageCount')}
            </label>
            <select id="overlay-count" className="select" value={overlay.messageCount} disabled={off || overlay.messageMode === 'off'} onChange={(e) => set({ messageCount: Number(e.target.value) as OverlayPrefs['messageCount'] })}>
              {OVERLAY_MESSAGE_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="overlay-seconds">
              {t('overlay.messageSeconds')}
            </label>
            <select id="overlay-seconds" className="select" value={overlay.messageSeconds} disabled={off || overlay.messageMode === 'off'} onChange={(e) => set({ messageSeconds: Number(e.target.value) as OverlayPrefs['messageSeconds'] })}>
              {OVERLAY_MESSAGE_SECONDS.map((n) => (
                <option key={n} value={n}>
                  {t('overlay.seconds', { count: n })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <GameProfiles overlay={overlay} disabled={off} onChange={set} />

      <div className="settings-card">
        <h4 className="settings-card-title">{t('overlay.placement')}</h4>
        <div className="field-grid">
          <div className="field">
            <label className="field-label" htmlFor="overlay-corner">
              {t('overlay.position')}
            </label>
            <select
              id="overlay-corner"
              className="select"
              value={overlay.custom ? 'custom' : overlay.corner}
              disabled={off}
              onChange={(e) => {
                const value = e.target.value;
                if (value !== 'custom') set({ corner: value as OverlayPrefs['corner'], custom: null });
              }}
            >
              {OVERLAY_POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`overlay.corners.${p}`)}
                </option>
              ))}
              {overlay.custom && <option value="custom">{t('overlay.corners.custom')}</option>}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="overlay-display">
              {t('overlay.display')}
            </label>
            <select
              id="overlay-display"
              className="select"
              value={overlay.displayId ?? 'primary'}
              disabled={off}
              onChange={(e) => set({ displayId: e.target.value === 'primary' ? null : Number(e.target.value), custom: null })}
            >
              <option value="primary">{t('overlay.primaryDisplay')}</option>
              {displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.primary ? ` (${t('overlay.primary')})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="overlay-scale">
            {t('overlay.scale')} <span className="context-menu-value">{overlay.scale}%</span>
          </label>
          <input id="overlay-scale" className="range" type="range" min={OVERLAY_SCALE_MIN} max={OVERLAY_SCALE_MAX} step={5} value={overlay.scale} disabled={off} onChange={(e) => set({ scale: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="overlay-opacity">
            {t('overlay.opacity')} <span className="context-menu-value">{overlay.opacity}%</span>
          </label>
          <input id="overlay-opacity" className="range" type="range" min={OVERLAY_OPACITY_MIN} max={OVERLAY_OPACITY_MAX} step={5} value={overlay.opacity} disabled={off} onChange={(e) => set({ opacity: Number(e.target.value) })} />
          <span className="field-hint">{t('overlay.opacityHint')}</span>
        </div>
        <div className="settings-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={off} onClick={() => desktop?.overlay.preview()}>
            <Move size={14} aria-hidden="true" />
            {t('overlay.place')}
          </button>
          {overlay.chatCustom && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={off} onClick={() => set({ chatCustom: null })}>
              {t('overlay.resetChat')}
            </button>
          )}
        </div>
        <p className="field-hint">{t('overlay.dragHint')}</p>
        <p className="field-hint">
          {t('overlay.hotkeys', {
            toggle: keybinds.toggleOverlay ?? t('desktop.keybinds.notSet'),
            interact: keybinds.overlayInteract ?? t('desktop.keybinds.notSet'),
            recent: keybinds.overlayRecent ?? t('desktop.keybinds.notSet'),
          })}
        </p>
      </div>
    </div>
  );
}
