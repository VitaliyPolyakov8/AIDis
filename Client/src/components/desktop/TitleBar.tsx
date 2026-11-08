import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, RotateCw } from 'lucide-react';
import { desktop } from '../../desktop/bridge';
import { useDesktopStore } from '../../desktop/desktopStore';
import { downloadUpdate, restartAndUpdate } from '../../desktop/updates';
import { useSettingsStore } from '../../stores/settingsStore';
import type { UpdateState } from '../../desktop/contract';
import { LogoMark } from '../Logo';

/** True when the shell draws a themed title bar (0.4.2+ on Windows). */
export const hasThemedTitleBar = typeof desktop?.app.setTitleBar === 'function' && /Windows/i.test(navigator.userAgent);

/** "#rrggbb" from a computed CSS color value, or null. */
function toHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/** Sends the current theme's title bar colors to the shell (native window controls). */
function syncWindowControls(): void {
  const css = getComputedStyle(document.documentElement);
  const color = toHex(css.getPropertyValue('--titlebar-bg'));
  const symbolColor = toHex(css.getPropertyValue('--titlebar-fg'));
  if (color && symbolColor) desktop?.app.setTitleBar?.({ color, symbolColor });
}

/** What the green update button shows for an updater state (null = hidden). Pure (unit-tested). */
export function updateButtonView(state: UpdateState): { kind: 'available' | 'downloading' | 'ready'; percent: number; version: string } | null {
  if (state.status === 'available') return { kind: 'available', percent: 0, version: state.version };
  if (state.status === 'downloading') return { kind: 'downloading', percent: state.percent, version: state.version };
  if (state.status === 'downloaded') return { kind: 'ready', percent: 100, version: state.version };
  return null;
}

/**
 * 0.4.2 Discord-like update button, just left of the window controls. Available: click downloads.
 * Downloading: progress ring. Ready: click restarts and installs (leaving voice first). It never
 * restarts on its own.
 */
export function UpdateButton() {
  const { t } = useTranslation();
  const state = useDesktopStore((s) => s.updateState);
  const view = updateButtonView(state);
  if (!view) return null;
  const label =
    view.kind === 'available'
      ? t('updates.button.available', { version: view.version })
      : view.kind === 'downloading'
        ? t('updates.button.downloading', { percent: view.percent })
        : t('updates.button.ready');
  const r = 9;
  const circumference = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`titlebar-update is-${view.kind}`}
      title={label}
      aria-label={label}
      disabled={view.kind === 'downloading'}
      onClick={() => {
        if (view.kind === 'available') downloadUpdate();
        else if (view.kind === 'ready') void restartAndUpdate();
      }}
    >
      {view.kind === 'downloading' ? (
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="titlebar-update-ring">
          <circle cx="11" cy="11" r={r} className="ring-track" />
          <circle cx="11" cy="11" r={r} className="ring-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - view.percent / 100)} />
        </svg>
      ) : view.kind === 'ready' ? (
        <RotateCw size={15} aria-hidden="true" />
      ) : (
        <ArrowDownToLine size={16} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * 0.4.2 themed title bar (desktop, Windows): the page draws the caption (drag area, name, update
 * button) in the theme's colors; Windows keeps drawing the real minimize / maximize / close
 * buttons on top (Electron titleBarOverlay), recolored on every theme change.
 */
export function TitleBar() {
  const theme = useSettingsStore((s) => s.uiTheme);
  useEffect(() => {
    document.documentElement.classList.add('has-titlebar');
    return () => document.documentElement.classList.remove('has-titlebar');
  }, []);
  // The theme attribute is applied synchronously by the settings store; read the colors after it.
  useEffect(() => {
    syncWindowControls();
  }, [theme]);
  return (
    <div className="titlebar" role="presentation">
      <span className="titlebar-brand">
        <LogoMark size={16} />
        <span className="titlebar-name">AIDis</span>
      </span>
      <span className="titlebar-actions">
        <UpdateButton />
      </span>
    </div>
  );
}
