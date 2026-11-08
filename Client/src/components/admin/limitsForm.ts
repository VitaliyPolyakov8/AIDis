import type { LimitsView } from '../../api/types';

export type LimitDef = LimitsView['catalog'][number];

const MB = 1024 * 1024;

/** Upload limits are bytes on the server and megabytes in the form. */
export const isBytesLimit = (key: string) => key.startsWith('upload.');

const scale = (def: Pick<LimitDef, 'key'>) => (isBytesLimit(def.key) ? MB : 1);

/** Server value -> text field ('' = not set, the default applies). */
export function toInput(def: Pick<LimitDef, 'key'>, value: number | undefined): string {
  if (value === undefined) return '';
  const shown = value / scale(def);
  return Number.isInteger(shown) ? String(shown) : String(Math.round(shown * 100) / 100);
}

/** Text field -> server value (null = back to the default). */
export function fromInput(def: Pick<LimitDef, 'key'>, text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return null;
  return Math.round(Number(trimmed) * scale(def));
}

/** null when fine; otherwise the allowed range in form units (for the error text). */
export function validate(def: LimitDef, text: string): { min: number; max: number } | null {
  const trimmed = text.trim().replace(',', '.');
  if (!trimmed) return null;
  const range = { min: def.min / scale(def), max: def.max / scale(def) };
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return range;
  if (!isBytesLimit(def.key) && !Number.isInteger(number)) return range;
  const value = Math.round(number * scale(def));
  return value < def.min || value > def.max ? range : null;
}
