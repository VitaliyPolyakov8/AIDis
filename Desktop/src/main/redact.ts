/**
 * Removes anything that looks like a credential before a line is logged:
 * JWTs (access tokens, LiveKit tokens), "token"/"password" style key-value pairs and long opaque
 * strings such as refresh tokens. Pure and unit-tested.
 */
const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const KEY_VALUE = /((?:access|refresh|livekit|api)?[_-]?(?:token|password|secret|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;}]+/gi;
const BEARER = /Bearer\s+[\w.~+/=-]+/gi;
const OPAQUE = /[A-Za-z0-9_\-+/=]{40,}/g;

export function redact(text: string): string {
  return text.replace(JWT, '[redacted-jwt]').replace(BEARER, 'Bearer [redacted]').replace(KEY_VALUE, '$1[redacted]').replace(OPAQUE, '[redacted]');
}
