import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Outbound HTTP for link previews and the image proxy, hardened against SSRF:
 *
 * - only http/https on the default ports (80/443), no credentials in URLs;
 * - host names that are local/internal by construction are refused (localhost, *.local,
 *   *.internal, single-label names such as Docker service names, metadata hosts);
 * - every DNS answer is checked and the connection is made to that checked address only
 *   (a custom `lookup`), so DNS rebinding between check and connect is impossible;
 * - private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges (IPv4 and
 *   IPv6, including IPv4-mapped / NAT64 forms) are refused; literal IPs are checked the same way;
 * - redirects are followed by hand, at most 3, and each target is checked again;
 * - strict timeout, response size cap and content-type allow list.
 */

export class FetchBlockedError extends Error {}

export interface SafeFetchOptions {
  /** Content types accepted (prefix match, lower case), e.g. ['text/html', 'application/json']. */
  accept: string[];
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Stop reading once this text appears (e.g. '</head>') to avoid downloading whole pages. */
  stopAt?: string;
  /** Test hook: replaces DNS resolution. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test hook: replaces the HTTP request (receives the already checked address). */
  transport?: (url: URL, address: string, opts: SafeFetchOptions) => Promise<RawResponse>;
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedV4(ip: string): boolean {
  const value = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (v4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address into 8 16-bit groups. */
function v6Groups(ip: string): number[] {
  let address = ip.toLowerCase().split('%')[0] ?? '';
  // Embedded IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4?.[1]) {
    const n = v4ToInt(v4[1]);
    address = address.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = '', tail] = address.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  return [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
}

function isBlockedV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, x = 0, y = 0] = g;
  const embeddedV4 = `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
  if (g.every((v) => v === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && x === 0 && y === 1) return true; // ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return isBlockedV4(embeddedV4); // v4-mapped / compatible
  if (a === 0x64 && b === 0xff9b) return isBlockedV4(embeddedV4); // NAT64
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return isBlockedV4(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
  return false;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !isBlockedV4(ip);
  if (family === 6) return !isBlockedV6(ip);
  return false;
}

/** Throws when the URL may not be fetched (before any network activity). */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchBlockedError('protocol');
  if (url.username || url.password) throw new FetchBlockedError('credentials in URL');
  if (url.port && !(url.protocol === 'http:' && url.port === '80') && !(url.protocol === 'https:' && url.port === '443')) {
    throw new FetchBlockedError('port');
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new FetchBlockedError('private address');
    return url;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new FetchBlockedError('internal host name');
  if (!host.includes('.')) throw new FetchBlockedError('single-label host name');
  return url;
}

function defaultResolve(host: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

async function vettedAddress(host: string, resolve: (host: string) => Promise<string[]>): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return bare;
  const addresses = await resolve(bare);
  if (addresses.length === 0) throw new FetchBlockedError('no address');
  // Every answer must be public: a mixed answer is a classic rebinding trick.
  if (!addresses.every(isPublicAddress)) throw new FetchBlockedError('resolves to a private address');
  return addresses[0] as string;
}

function requestOnce(url: URL, address: string, opts: SafeFetchOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    // Connect to the checked address only (no second DNS lookup inside the HTTP client).
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family = net.isIP(address);
      if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; AIDisLinkPreview/1.0)',
          accept: opts.accept.join(', '),
          'accept-language': 'ru,en;q=0.8',
          ...opts.headers,
        },
        timeout: opts.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          const stop = opts.stopAt && chunk.toString('latin1').toLowerCase().includes(opts.stopAt);
          if (size >= opts.maxBytes || stop) {
            truncated = size >= opts.maxBytes;
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, opts.maxBytes), truncated });
          }
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchBlockedError('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const resolve = opts.resolve ?? defaultResolve;
  let current = assertFetchableUrl(raw);
  const deadline = Date.now() + (opts.timeoutMs ?? 5000) * 2;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop += 1) {
    if (Date.now() > deadline) throw new FetchBlockedError('timeout');
    const address = await vettedAddress(current.hostname, resolve);
    const res = await (opts.transport ?? requestOnce)(current, address, opts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = assertFetchableUrl(new URL(res.headers.location, current).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers['content-type'] ?? '').toLowerCase();
    if (!opts.accept.some((type) => contentType.startsWith(type))) throw new FetchBlockedError(`content type ${contentType || 'missing'}`);
    return { url: current.toString(), status: res.status, contentType, body: res.body, truncated: res.truncated };
  }
  throw new FetchBlockedError('too many redirects');
}
