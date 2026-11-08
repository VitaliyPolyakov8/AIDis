/**
 * 0.5.5 seasonal decorations and birthdays (dates in the viewer's local time).
 *
 * - New Year: December 20 - January 10, falling snow.
 * - Halloween: October 25 - November 1, pumpkins and bats along the bottom and an orange accent.
 * - A user's birthday: confetti and a cake on their profile (Feb 29 birthdays on Feb 28 in other years).
 */
export type Season = 'newyear' | 'halloween';
export type SeasonSetting = 'auto' | 'off' | Season;

/** The season of a date, or null. Pure (unit-tested). */
export function seasonOf(date: Date): Season | null {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if ((month === 12 && day >= 20) || (month === 1 && day <= 10)) return 'newyear';
  if ((month === 10 && day >= 25) || (month === 11 && day === 1)) return 'halloween';
  return null;
}

/** What is shown for a setting: auto follows the calendar, off shows nothing, a season forces it. */
export function activeSeason(setting: SeasonSetting, date: Date): Season | null {
  if (setting === 'off') return null;
  if (setting === 'auto') return seasonOf(date);
  return setting;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True on the user's birthday. Pure (unit-tested). */
export function isBirthdayToday(birthday: { month: number; day: number } | null | undefined, date: Date): boolean {
  if (!birthday) return false;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (birthday.month === 2 && birthday.day === 29 && !isLeapYear(date.getFullYear())) return month === 2 && day === 28;
  return birthday.month === month && birthday.day === day;
}
