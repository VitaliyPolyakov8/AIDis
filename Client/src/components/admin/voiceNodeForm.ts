/** Voice servers are subdomains of the server's voice domain (GET /client/config: voiceNodeDomain). */
export function validNodeUrl(raw: string, domain: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'wss:' || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return false;
  const base = domain.toLowerCase();
  if (!base || !host.endsWith(`.${base}`)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host.slice(0, -base.length - 1));
}

/** The three lines the VPS script prints ("URL: …", "API key: …", "API secret: …"), in any order. */
export function parseNodeBlock(text: string): { url: string; apiKey: string; apiSecret: string } | null {
  const pick = (label: string) => new RegExp(`^\\s*${label}\\s*:\\s*(\\S+)\\s*$`, 'im').exec(text)?.[1];
  const url = pick('URL');
  const apiKey = pick('API key');
  const apiSecret = pick('API secret');
  return url && apiKey && apiSecret ? { url, apiKey, apiSecret } : null;
}
