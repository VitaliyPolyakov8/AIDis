/**
 * Minimal, safe metadata extraction from the <head> of an HTML page (no DOM, no scripts):
 * Open Graph / Twitter / standard meta tags, <title> and <link rel="canonical">. Everything
 * returned is plain text (entities decoded, tags and control characters removed, length-limited).
 */
export interface PageMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string | null;
}

// Control characters (C0 except tab/newline, DEL, C1), built from code points to keep the regex readable.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`, 'g');

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

/** Plain, single-line-ish text: no tags, no control characters, collapsed whitespace, max length. */
export function cleanText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Absolute http(s) URL or null. */
export function absoluteUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = (m[1] ?? '').toLowerCase();
    attrs[key] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

export function parseMetadata(html: string, pageUrl: string): PageMetadata {
  const head = html.slice(0, 400_000);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  let canonical: string | null = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      canonical = a.href;
      break;
    }
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;
  return {
    title: cleanText(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 200),
    description: cleanText(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 350),
    image: absoluteUrl(meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src'), pageUrl),
    siteName: cleanText(meta.get('og:site_name') ?? meta.get('application-name'), 80),
    url: absoluteUrl(meta.get('og:url') ?? canonical, pageUrl),
  };
}

/** Charset from a content-type header or an early <meta charset>, defaulting to UTF-8. */
export function detectCharset(contentType: string, head: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = head.subarray(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

export function decodeHtml(body: Buffer, contentType: string): string {
  const charset = detectCharset(contentType, body);
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ---- URL detection ----------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** URLs in a message, in order, trailing punctuation trimmed. Text inside `code` is ignored. */
export function extractUrls(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```|`[^`]*`/g, ' ');
  const urls: string[] = [];
  for (const m of withoutCode.matchAll(URL_RE)) {
    let url = m[0];
    while (/[.,;:!?)\]}>»"']$/.test(url)) {
      if (url.endsWith(')') && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break;
      url = url.slice(0, -1);
    }
    // <https://...> suppresses the embed, like Discord.
    const before = withoutCode.slice(Math.max(0, m.index - 1), m.index);
    if (before === '<') continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// ---- known sites ------------------------------------------------------------------------

export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function steamAppId(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== 'store.steampowered.com') return null;
    return /^\/(?:app|agecheck\/app)\/(\d{1,10})/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
