/**
 * Per-username failed-login limiter (in memory; one backend process is all this
 * project runs). Complements the per-IP rate limit on the login route so a single
 * account cannot be brute-forced from many addresses.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (now - entry.windowStart > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.failures.set(key, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
    if (this.failures.size > 10_000) {
      this.prune(now);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.failures) {
      if (now - entry.windowStart > this.windowMs) this.failures.delete(key);
    }
  }
}
