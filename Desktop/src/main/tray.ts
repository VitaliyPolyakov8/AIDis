import { join } from 'node:path';
import { Menu, Tray } from 'electron';
import type { ShellCommand, ShellVoiceState } from '../../../Client/src/desktop/contract';
import { ASSETS_DIR, ICON_PATH } from './config';
import { tr } from './i18n';

export interface TrayHandlers {
  show: () => void;
  command: (command: ShellCommand) => void;
  quit: () => void;
}

/**
 * 0.4.2 tray icon states, highest priority first:
 *   deafened > muted > speaking > voice (connected, mic on, silent) > normal (not in a call).
 * Deafened comes first because deafening also mutes the microphone.
 */
export type TrayIconState = 'normal' | 'voice' | 'speaking' | 'muted' | 'deafened';

export function trayIconState(state: ShellVoiceState): TrayIconState {
  if (!state.inCall) return 'normal';
  if (state.deafened) return 'deafened';
  if (!state.micEnabled) return 'muted';
  if (state.speaking === true) return 'speaking';
  return 'voice';
}

/** Tooltip text: "AIDis — General — Microphone muted" (localized). Pure (unit-tested). */
export function trayTooltip(state: ShellVoiceState, t: (key: TrayTextKey) => string): string {
  const icon = trayIconState(state);
  if (icon === 'normal') return t('trayTooltip');
  const parts = [t('trayTooltip'), state.channelName?.trim() || t('trayInVoice')];
  if (icon === 'deafened') parts.push(t('trayDeafened'));
  else if (icon === 'muted') parts.push(t('trayMuted'));
  else if (icon === 'speaking') parts.push(t('traySpeaking'));
  return parts.join(' — ');
}

export type TrayTextKey = 'trayTooltip' | 'trayInVoice' | 'trayDeafened' | 'trayMuted' | 'traySpeaking';

function iconPath(state: TrayIconState): string {
  // Multi-size .ico files (16-48 px, drawn per size): Windows picks the right frame for the tray.
  return state === 'normal' ? ICON_PATH : join(ASSETS_DIR, 'tray', `tray-${state}.ico`);
}

/** Tray icon: click opens AIDis; the icon, tooltip and menu mirror the voice state reported by the renderer. */
export class AppTray {
  private readonly tray: Tray;
  private state: ShellVoiceState = { inCall: false, micEnabled: true, deafened: false, screenSharing: false };
  private icon: TrayIconState = 'normal';
  private tooltip = '';
  private menuKey = '';
  private readonly handlers: TrayHandlers;

  constructor(handlers: TrayHandlers) {
    this.handlers = handlers;
    // A path (not a NativeImage) lets Windows pick the 16/32 px frame of the .ico for the tray.
    this.tray = new Tray(ICON_PATH);
    this.tray.on('click', () => handlers.show());
    this.rebuild();
  }

  /** Called on every logical voice state change (the renderer already filters duplicates). */
  setVoiceState(state: ShellVoiceState): void {
    this.state = state;
    this.apply(false);
  }

  /** After a language change. */
  rebuild(): void {
    this.apply(true);
  }

  /** Only touches the OS tray for what really changed (icon, tooltip, menu). */
  private apply(force: boolean): void {
    const icon = trayIconState(this.state);
    if (force || icon !== this.icon) {
      this.icon = icon;
      if (!this.tray.isDestroyed()) this.tray.setImage(iconPath(icon));
    }
    const tooltip = trayTooltip(this.state, (key) => tr(key));
    if (force || tooltip !== this.tooltip) {
      this.tooltip = tooltip;
      if (!this.tray.isDestroyed()) this.tray.setToolTip(tooltip);
    }
    const { inCall, micEnabled, deafened } = this.state;
    // Speaking changes often; the menu only depends on these.
    const menuKey = `${String(inCall)}${String(micEnabled)}${String(deafened)}`;
    if (!force && menuKey === this.menuKey) return;
    this.menuKey = menuKey;
    if (this.tray.isDestroyed()) return;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tr('open'), click: () => this.handlers.show() },
        { type: 'separator' },
        { label: tr('muteMic'), type: 'checkbox', checked: !micEnabled, click: () => this.handlers.command('toggleMute') },
        { label: tr('deafen'), type: 'checkbox', checked: deafened, click: () => this.handlers.command('toggleDeafen') },
        { label: tr('disconnect'), enabled: inCall, click: () => this.handlers.command('disconnectVoice') },
        { type: 'separator' },
        { label: tr('quit'), click: () => this.handlers.quit() },
      ]),
    );
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
