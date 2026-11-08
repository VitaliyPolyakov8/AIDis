import { desktopCapturer, type BrowserWindow, type DesktopCapturerSource, type NativeImage, type Session } from 'electron';
import type { CaptureSelection, CaptureSource } from '../../../Client/src/desktop/contract';
import { isRendererUrl } from './permissions';
import { logger } from './logger';
import { screen, type Rectangle } from 'electron';
import { foregroundWindowBounds } from './streamHints';

/**
 * Screen capture for the custom source picker.
 *
 * getSources() lists screens and capturable windows (our own window excluded) with thumbnails.
 * select() arms a single pending choice; the renderer then calls getDisplayMedia() and
 * Electron's display-media handler answers it with exactly that source. With "system audio"
 * the handler adds Windows loopback audio; the renderer requests it with restrictOwnAudio, so
 * Chromium excludes AIDis' own output (the call, UI sounds) from what viewers hear.
 * A getDisplayMedia() call without an armed choice is denied.
 */
const SOURCE_ID = /^(screen|window):[0-9]+:[0-9]+$/;
const PENDING_TTL_MS = 15_000;

interface Pending extends CaptureSelection {
  expiresAt: number;
}

export class CaptureService {
  private pending: Pending | null = null;
  private activeSource: string | null = null;
  private readonly getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  private ownSourceIds(): Set<string> {
    const win = this.getWindow();
    const ids = new Set<string>();
    if (win && !win.isDestroyed()) ids.add(win.getMediaSourceId());
    return ids;
  }

  private async rawSources(thumbnail: boolean): Promise<DesktopCapturerSource[]> {
    const own = this.ownSourceIds();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: thumbnail ? { width: 384, height: 216 } : { width: 0, height: 0 },
      fetchWindowIcons: thumbnail,
    });
    return sources.filter((s) => !own.has(s.id) && (s.id.startsWith('screen:') || s.name.trim() !== ''));
  }

  async getSources(): Promise<CaptureSource[]> {
    const sources = await this.rawSources(true);
    return sources.map((s) => {
      // Typed as always present, but Electron returns null for screens.
      const icon = s.appIcon as NativeImage | null;
      return {
        id: s.id,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        name: s.id.startsWith('screen:') ? '' : s.name.slice(0, 200),
        thumbnail: s.thumbnail.isEmpty() ? '' : `data:image/jpeg;base64,${s.thumbnail.toJPEG(72).toString('base64')}`,
        appIcon: icon && !icon.isEmpty() ? icon.resize({ width: 16, height: 16 }).toDataURL() : null,
      };
    });
  }

  /** Ids and window titles only (no thumbnails): "Stream <game>" window matching. */
  async listIds(): Promise<{ id: string; name: string }[]> {
    return (await this.rawSources(false)).map((s) => ({ id: s.id, name: s.name }));
  }

  async select(value: unknown): Promise<boolean> {
    if (typeof value !== 'object' || value === null) return false;
    const { sourceId, audio } = value as Record<string, unknown>;
    if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || typeof audio !== 'boolean') return false;
    const exists = (await this.rawSources(false)).some((s) => s.id === sourceId);
    if (!exists) {
      logger.warn('capture', 'Selected source no longer exists');
      return false;
    }
    this.pending = { sourceId, audio, expiresAt: Date.now() + PENDING_TTL_MS };
    return true;
  }

  install(session: Session): void {
    session.setDisplayMediaRequestHandler(
      (request, callback) => {
        const pending = this.pending;
        this.pending = null;
        if (!pending || pending.expiresAt < Date.now() || !isRendererUrl(request.securityOrigin)) {
          logger.warn('capture', 'getDisplayMedia without a picked source was denied');
          callback({});
          return;
        }
        this.rawSources(false).then(
          (sources) => {
            const source = sources.find((s) => s.id === pending.sourceId);
            if (!source) {
              logger.warn('capture', 'Picked source disappeared before capture started');
              callback({});
              return;
            }
            const withAudio = pending.audio && request.audioRequested && process.platform === 'win32';
            this.activeSource = source.id;
            logger.info('capture', `Capture started: ${source.id.split(':')[0] ?? 'source'}${withAudio ? ' + system audio' : ''}`);
            callback(withAudio ? { video: source, audio: 'loopback' } : { video: source });
          },
          (error: unknown) => {
            logger.error('capture', 'Could not enumerate capture sources', error);
            callback({});
          },
        );
      },
      { useSystemPicker: false },
    );
  }

  /** A hint can only refer to the source actually handed to the trusted renderer. */
  async hintBounds(sourceId: string): Promise<Rectangle | null> {
    if (sourceId !== this.activeSource) return null;
    if (sourceId.startsWith('window:')) {
      const bounds = await foregroundWindowBounds(sourceId);
      return sourceId === this.activeSource ? bounds : null;
    }
    const source = (await this.rawSources(false)).find((s) => s.id === sourceId);
    if (sourceId !== this.activeSource) return null;
    const display = source?.display_id ? screen.getAllDisplays().find((d) => String(d.id) === source.display_id) : null;
    return display?.bounds ?? null;
  }
}
