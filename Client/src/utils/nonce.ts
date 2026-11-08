/** Client-generated idempotency key for POST /messages (server accepts [A-Za-z0-9_-]{1,64}). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
