import { app } from 'electron';
import { fetchMinimumVersion, shouldForceUpdate } from './forceUpdate';
import type { DesktopServer } from '../../../Client/src/desktop/contract';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateState } from '../../../Client/src/desktop/contract';
import { logger } from './logger';

/**
 * Automatic updates with electron-updater (electron-builder's native format: latest.yml +
 * NSIS installer + .blockmap) from GitHub Releases, or from the mirror the current server names
 * (client-version.json updateMirrorUrl). The renderer can only ask to check,
 * read the state and confirm "Restart and update"; it can never change where updates come from.
 *
 * - Runs only in the installed (packaged) app. Development builds report "unsupported"; for local
 *   testing a dev build may point at AIDIS_DEV_UPDATE_URL (ignored when packaged).
 * - 0.4.2: checks 20 s after start and every 45 minutes (plus manual checks); latest.yml is the
 *   only source of truth for "is there a newer Desktop". The download starts when the user clicks
 *   the green update button (or "Download" in Settings → About); it never restarts by itself:
 *   installing happens when the user clicks "Restart and update" (or silently when they quit
 *   AIDis normally after a download finished).
 * - Integrity: electron-updater verifies the installer's SHA-512 from latest.yml. The installer is
 *   not code-signed yet, so there is no publisher check (see README).
 */
declare const __AIDIS_GITHUB__: { owner: string; repo: string };

/** Where releases are published (desktop.config.json, compiled in). Placeholders = updates off. */
export const GITHUB_RELEASES = typeof __AIDIS_GITHUB__ === 'undefined' ? { owner: '', repo: '' } : __AIDIS_GITHUB__;

export type FeedOptions = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string };

/** Pure: the owner's mirror (https) when the current server names one, else GitHub Releases; null = nowhere to look. */
export function updateFeed(github: { owner: string; repo: string }, mirror: string | null | undefined): FeedOptions | null {
  if (mirror && /^https:\/\/\S+$/.test(mirror)) return { provider: 'generic', url: mirror };
  const valid = (v: string) => /^[A-Za-z0-9_.-]+$/.test(v) && v !== 'OWNER' && v !== 'REPO';
  return valid(github.owner) && valid(github.repo) ? { provider: 'github', owner: github.owner, repo: github.repo } : null;
}

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 45 * 60 * 1000;

type Updater = typeof import('electron-updater').autoUpdater;
type ProgressInfo = import('electron-updater').ProgressInfo;
type UpdateInfo = import('electron-updater').UpdateInfo;

/** Pure: a short, log-safe message for the UI. */
export function updateErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n')[0] ?? raw;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(raw)) return 'network';
  if (/\b404\b/.test(raw)) return 'not-published';
  if (/sha512|checksum/i.test(raw)) return 'integrity';
  return firstLine.slice(0, 160);
}

/** Pure: progress event -> state (values straight from electron-updater, rounded for display). */
export function progressState(version: string, progress: Pick<ProgressInfo, 'percent' | 'transferred' | 'total' | 'bytesPerSecond'>): UpdateState {
  return {
    status: 'downloading',
    version,
    percent: Math.max(0, Math.min(100, Math.floor(progress.percent))),
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  };
}

export class UpdateService extends EventEmitter<{ state: [UpdateState]; downloaded: [string] }> {
  private state: UpdateState = { status: 'unsupported' };
  private updater: Updater | null = null;
  private pendingVersion = '';
  private timers: NodeJS.Timeout[] = [];
  /** 0.7.0: this build is below the server's minimum: download at once, without the user's click. */
  private forced = false;

  get current(): UpdateState {
    return this.state;
  }

  start(server: DesktopServer | null = null): void {
    const devUrl = !app.isPackaged ? process.env.AIDIS_DEV_UPDATE_URL : undefined;
    if (!app.isPackaged && !devUrl) {
      logger.info('updates', 'Automatic updates are off in development builds');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
      this.updater = autoUpdater;
    } catch (error) {
      logger.error('updates', 'electron-updater could not be loaded', error);
      return;
    }
    const updater = this.updater;
    updater.logger = {
      info: (m: unknown) => logger.info('updates', String(m)),
      warn: (m: unknown) => logger.warn('updates', String(m)),
      error: (m: unknown) => logger.error('updates', String(m)),
      debug: () => undefined,
    };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    if (devUrl) {
      // Development test only: separate cache folder so a test never touches an installed AIDis.
      const devConfig = join(app.getPath('userData'), 'dev-app-update.yml');
      writeFileSync(
        devConfig,
        `provider: generic
url: ${devUrl}
updaterCacheDirName: aidis-desktop-updater-dev
`,
      );
      updater.forceDevUpdateConfig = true;
      updater.updateConfigPath = devConfig;
      // A development build must never run an installer: it would replace the installed AIDis.
      updater.autoInstallOnAppQuit = false;
    }
    const feed: FeedOptions | null = devUrl ? { provider: 'generic', url: devUrl } : updateFeed(GITHUB_RELEASES, server?.config.updateMirrorUrl);
    if (!feed) {
      logger.info('updates', 'No update source configured (desktop.config.json github owner/repo); automatic updates are off');
      this.updater = null;
      return;
    }
    updater.setFeedURL(feed);

    updater.on('checking-for-update', () => this.set({ status: 'checking' }));
    updater.on('update-available', (info: UpdateInfo) => {
      this.pendingVersion = info.version;
      logger.info('updates', `Update ${info.version} available (running ${app.getVersion()})${this.forced ? '; required by the server, downloading now' : '; waiting for the user to download it'}`);
      this.set({ status: 'available', version: info.version });
      if (this.forced) this.download();
    });
    updater.on('update-not-available', () => this.set({ status: 'not-available', checkedAt: Date.now() }));
    updater.on('download-progress', (progress: ProgressInfo) => this.set(progressState(this.pendingVersion, progress)));
    updater.on('update-downloaded', (info: UpdateInfo) => {
      logger.info('updates', `Update ${info.version} downloaded and ready to install`);
      this.set({ status: 'downloaded', version: info.version });
      this.emit('downloaded', info.version);
    });
    updater.on('error', (error: Error) => {
      logger.warn('updates', 'Update failed', error);
      // A failed check after a finished download must not hide "ready to install".
      if (this.state.status !== 'downloaded') this.set({ status: 'error', message: updateErrorMessage(error) });
    });

    this.set({ status: 'idle' });
    logger.info('updates', `Automatic updates on (${feed.provider === 'generic' ? feed.url : `github.com/${feed.owner}/${feed.repo}`})`);
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    // 0.7.0: ask the server for its minimum version right away.
    if (server)
      void fetchMinimumVersion(server.origin).then((minimum) => {
        if (!shouldForceUpdate(app.getVersion(), minimum)) return;
        logger.info('updates', `This version ${app.getVersion()} is below the server minimum ${minimum ?? '?'}: checking and downloading now`);
        this.force();
      });
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
    for (const timer of this.timers) timer.unref();
  }

  check(): void {
    const updater = this.updater;
    if (!updater) return;
    const busy = this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'available';
    if (busy || this.state.status === 'downloaded') return;
    updater.checkForUpdates().catch((error: unknown) => {
      // Also reported through the 'error' event; this only prevents an unhandled rejection.
      logger.warn('updates', 'Update check failed', error);
    });
  }

  /** 0.7.0: the update is mandatory (server minimum, or the renderer got CLIENT_OUTDATED). */
  force(): void {
    this.forced = true;
    if (this.state.status === 'available') this.download();
    else this.check();
  }

  /** 0.4.2: the user clicked the update button: download the version latest.yml announced. */
  download(): void {
    const updater = this.updater;
    if (!updater || this.state.status !== 'available') return;
    const version = this.state.version;
    logger.info('updates', `Downloading ${version} (user request)`);
    this.set(progressState(version, { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }));
    updater.downloadUpdate().catch((error: unknown) => {
      logger.warn('updates', 'Update download failed', error);
      this.set({ status: 'error', message: updateErrorMessage(error) });
    });
  }

  /** Called only after the user clicked "Restart and update" (the renderer has left voice first). */
  install(beforeQuit: () => void): boolean {
    if (!this.updater || this.state.status !== 'downloaded') return false;
    if (!app.isPackaged) {
      logger.warn('updates', 'Not installing from a development build');
      return false;
    }
    logger.info('updates', `Installing ${this.state.version} and restarting`);
    beforeQuit();
    // isSilent: no installer UI; isForceRunAfter: start AIDis again when done.
    this.updater.quitAndInstall(true, true);
    return true;
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.emit('state', state);
  }
}
