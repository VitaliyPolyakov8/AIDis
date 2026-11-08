import { Notification } from 'electron';
import { ICON_PATH } from './config';
import { logger } from './logger';

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface NotificationRequest {
  title: string;
  body: string;
  channelId: string;
}

/** Pure: validates and trims a renderer request; null when it must be ignored. */
export function sanitizeNotification(value: unknown): NotificationRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || typeof v.body !== 'string' || typeof v.channelId !== 'string') return null;
  if (!CHANNEL_ID.test(v.channelId)) return null;
  const title = v.title.trim().slice(0, 120);
  if (!title) return null;
  return { title, body: v.body.trim().slice(0, 300), channelId: v.channelId };
}

/**
 * Windows toast notifications. The renderer decides *whether* to notify (not our own message,
 * window not focused); clicking one brings AIDis to the front and opens the channel.
 * Live notifications are referenced until closed so their click handler is not garbage-collected.
 */
export class Notifier {
  private readonly live = new Set<Notification>();
  private readonly onOpen: (channelId: string) => void;

  constructor(onOpen: (channelId: string) => void) {
    this.onOpen = onOpen;
  }

  show(value: unknown): void {
    const request = sanitizeNotification(value);
    if (!request || !Notification.isSupported()) return;
    try {
      const notification = new Notification({ title: request.title, body: request.body, icon: ICON_PATH, silent: false });
      const release = () => this.live.delete(notification);
      notification.on('click', () => {
        release();
        this.onOpen(request.channelId);
      });
      notification.on('close', release);
      notification.on('failed', release);
      this.live.add(notification);
      notification.show();
    } catch (error) {
      logger.warn('notifications', 'Could not show a notification', error);
    }
  }

  /** Simple system notice (e.g. "still running in the tray"). */
  notice(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, icon: ICON_PATH, silent: true });
    const release = () => this.live.delete(notification);
    notification.on('click', () => {
      release();
      onClick?.();
    });
    notification.on('close', release);
    this.live.add(notification);
    notification.show();
  }
}
