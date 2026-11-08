import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { applySettingsPatch, sanitizeDesktopSettings, type DesktopSettings, type SettingsUpdateResult } from '../../../Client/src/desktop/contract';
import { readJson, writeJsonAtomic } from './jsonFile';
import { logger } from './logger';

/**
 * Desktop settings (keybinds, streaming, PTT, tray/startup, language), persisted as JSON in
 * %APPDATA%\AIDis\settings.json. Everything read from disk or received over IPC goes through the
 * shared validators in Client/src/desktop/contract.ts.
 */
export class SettingsStore extends EventEmitter<{ change: [DesktopSettings, DesktopSettings] }> {
  private readonly file: string;
  private current: DesktopSettings;

  constructor(userDataDir: string, initialLanguage: 'ru' | 'en') {
    super();
    this.file = join(userDataDir, 'settings.json');
    const raw = readJson(this.file);
    this.current = sanitizeDesktopSettings(raw);
    // First start: follow the Windows display language until the user picks one in the app.
    if (raw === null) this.current = { ...this.current, language: initialLanguage };
  }

  get(): DesktopSettings {
    return this.current;
  }

  update(patch: unknown): SettingsUpdateResult {
    const result = applySettingsPatch(this.current, patch);
    if (!result.ok) return result;
    const previous = this.current;
    this.current = result.settings;
    try {
      writeJsonAtomic(this.file, this.current);
    } catch (error) {
      logger.error('settings', 'Could not save settings', error);
    }
    this.emit('change', this.current, previous);
    return result;
  }
}
