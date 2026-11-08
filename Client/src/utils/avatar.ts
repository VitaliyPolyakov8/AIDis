/** Deterministic, readable avatar colours for users without an uploaded avatar. */
const PALETTE = ['#5b6ee1', '#3f9f8a', '#c0698a', '#c98a3c', '#7d62c9', '#3d8fc4', '#a8794f', '#5f9e4f', '#c25f55'];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? '#5b6ee1';
}

export function initials(name: string): string {
  const raw = name.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return '?';
  // 0.7.0: words made of brackets / symbols ("(хозяин)" -> "Х", "[AFK]" -> "A") use their first letter.
  const lead = (word: string) => Array.from(word).find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? Array.from(word)[0] ?? '';
  const words = raw.filter((w) => /[\p{L}\p{N}]/u.test(w));
  const parts = words.length > 0 ? words : raw;
  if (parts.length === 1) return lead(parts[0] ?? '?').toUpperCase() || '?';
  return (lead(parts[0] ?? '') + lead(parts[parts.length - 1] ?? '')).toUpperCase();
}
