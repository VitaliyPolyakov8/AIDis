/**
 * 0.5.5 name styles: the fonts a name can use. Only these ids are stored; the client maps each one
 * to a bundled font (all with Cyrillic), so no font file or CSS ever comes from a user.
 */
export const NICKNAME_FONTS = ['unbounded', 'comfortaa', 'lobster', 'caveat', 'press-start', 'russo-one'] as const;
export type NicknameFont = (typeof NICKNAME_FONTS)[number];

/** Days per month; February allows the 29th (the confetti then shows on Feb 28 in other years). */
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidBirthday(month: number, day: number): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= (DAYS[month - 1] ?? 0);
}
