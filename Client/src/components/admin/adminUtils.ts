/** 0.5.8 admin panel helpers (pure, unit-tested). */

const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random 14-character password without look-alike characters (l/1, O/0). */
export function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const value of bytes) out += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length] ?? 'x';
  return out;
}

/** -1 / 0 / 1 for dotted versions ("0.5.6" < "0.5.10"); anything after "-" or "+" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-+]/)[0] ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function platformLabelKey(platform: string): string {
  return platform === 'desktop' || platform === 'android' || platform === 'ios' ? `adminPanel.platform.${platform}` : 'adminPanel.platform.web';
}
