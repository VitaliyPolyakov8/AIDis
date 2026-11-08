/** One entry of an RTCStatsReport (or a plain object in tests). */
export type StatsLike = Record<string, unknown> & { type: string; id: string };

function isStat(value: unknown): value is StatsLike {
  return typeof value === 'object' && value !== null && typeof (value as StatsLike).type === 'string' && typeof (value as StatsLike).id === 'string';
}

/**
 * The stat objects of a report.
 *
 * A real RTCStatsReport is map-like but NOT a Map instance: `report instanceof Map` is false and
 * iterating it directly yields `[id, stat]` pairs, not stats. Earlier code iterated it directly, so in
 * Chromium/Electron every entry was a pair, nothing matched and RTT, loss and transport stayed empty.
 * Use `.values()` when present; accept plain iterables of stats (tests) and of pairs as well.
 */
export function statsValues(report: unknown): StatsLike[] {
  if (!report || typeof report !== 'object') return [];
  const source = typeof (report as { values?: unknown }).values === 'function'
    ? (report as { values(): Iterable<unknown> }).values()
    : Symbol.iterator in report
      ? (report as Iterable<unknown>)
      : [];
  const out: StatsLike[] = [];
  for (const item of source) {
    const stat = Array.isArray(item) && item.length === 2 ? (item[1] as unknown) : item;
    if (isStat(stat)) out.push(stat);
  }
  return out;
}
