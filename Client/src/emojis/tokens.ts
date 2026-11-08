export type EmojiTokenPart = { type: 'text'; text: string } | { type: 'emoji'; id: string; name: string };
export function emojiShortcodes(text: string, catalog: readonly { id: string; name: string }[] = []): string {
  return splitEmojiTokens(text).map(part => part.type === 'text' ? part.text : `:${catalog.find(e => e.id === part.id)?.name ?? part.name}:`).join('');
}
/** Keep IDs from the moment the editor opened, even if the catalog changes before Save. */
export function createEmojiDraft(original: string, catalog: readonly { id: string; name: string }[]): { text: string; restore: (edited: string) => string } {
  const references = new Map<string, string[]>();
  for (const part of splitEmojiTokens(original)) if (part.type === 'emoji') {
    const label = (catalog.find(e => e.id === part.id)?.name ?? part.name).normalize('NFC').toLowerCase();
    const entries = references.get(label) ?? [];
    entries.push(`<:${part.name}:${part.id}>`); references.set(label, entries);
  }
  return {
    text: emojiShortcodes(original, catalog),
    restore: edited => {
      const indices = new Map<string, number>();
      return edited.replace(/https?:\/\/\S+|<:[^>]*>|:([\p{L}\p{N}_]{2,32}):/giu, (literal: string, name: string | undefined) => {
        if (!name) return literal;
        const key = name.normalize('NFC').toLowerCase(); const entries = references.get(key);
        if (!entries) return literal;
        const index = indices.get(key) ?? 0; indices.set(key, index + 1);
        return entries[index] ?? entries.at(-1) ?? literal;
      });
    },
  };
}
export function splitEmojiTokens(text: string): EmojiTokenPart[] {
  const parts: EmojiTokenPart[] = [];
  const pattern = /<:([\p{L}\p{N}_]{2,32}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/giu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) });
    const name = match[1]; const id = match[2];
    if (name && id) parts.push({ type: 'emoji', name, id: id.toLowerCase() });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
