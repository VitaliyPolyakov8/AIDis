import { requestBlob } from '../api/client';

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
export function emojiImageUrl(id: string): Promise<string> {
  const url = urls.get(id); if (url) return Promise.resolve(url);
  const existing = pending.get(id); if (existing) return existing;
  const task = requestBlob(`/api/v1/emojis/${id}/content`).then(blob => {
    if (pending.get(id) !== task) throw new Error('Emoji request discarded');
    const created = URL.createObjectURL(blob); urls.set(id, created); return created;
  }).finally(() => { if (pending.get(id) === task) pending.delete(id); });
  pending.set(id, task); return task;
}
export function retainEmojiImages(ids: Set<string>): void {
  for (const [id, url] of urls) if (!ids.has(id)) { URL.revokeObjectURL(url); urls.delete(id); }
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
}
export function clearEmojiImages(): void { retainEmojiImages(new Set()); }
