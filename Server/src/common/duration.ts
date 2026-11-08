const UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/** Parses "900", "15m", "12h", "30d" into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] === undefined || match[2] === '' ? 's' : match[2];
  const seconds = amount * (UNITS[unit] ?? 1);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid duration: ${value}`);
  }
  return seconds;
}
