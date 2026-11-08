export type TextPart = { type: 'text'; value: string } | { type: 'link'; value: string; href: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Splits plain text into text and http(s) link parts. Rendered as React text nodes and
 * <a> elements, never as HTML, so message content cannot inject markup.
 */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    const start = match.index;
    const trailing = TRAILING_PUNCTUATION.exec(url)?.[0] ?? '';
    if (trailing && !(trailing.startsWith(')') && url.includes('('))) url = url.slice(0, url.length - trailing.length);
    if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
    parts.push({ type: 'link', value: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}
