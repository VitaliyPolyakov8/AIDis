import { t } from '../i18n';
import type { ChatMessage } from '../stores/chatStore';
import { isSameDay } from './time';

/** Consecutive messages from one author within this window share one header. */
export const GROUP_WINDOW_MS = 7 * 60 * 1000;

export function isGroupedWith(prev: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!prev) return false;
  if (prev.author.id !== message.author.id) return false;
  if (!isSameDay(prev.createdAt, message.createdAt)) return false;
  return Date.parse(message.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
}

export function describeTyping(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return t('typing.one', { name: names[0] });
  if (names.length === 2) return t('typing.two', { a: names[0], b: names[1] });
  return t('typing.many');
}
