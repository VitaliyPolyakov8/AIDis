export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'GB'}`;
}

/** Images the server serves inline (attachments/storage.ts INLINE_TYPES); others are downloads. */
const PREVIEWABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function isPreviewableImage(mimeType: string): boolean {
  return PREVIEWABLE_IMAGES.has(mimeType);
}
