/**
 * Free-tier pacing — the difference between a bot that runs all day and one
 * that dies at 9am.
 *
 * The Gemini free tier enforces BOTH 10 requests/minute and 1,500/day (the
 * daily half lives in triage.ScreeningBudget). This class owns the per-minute
 * half as a sliding window rather than a fixed 6.5s sleep, because decisions
 * arrive in bursts: a launch wave at :00 should be able to spend the whole
 * minute's allowance immediately, then wait — not trickle one call per 6.5s
 * while candidates go stale behind it.
 *
 * acquire() never throws and never queues unboundedly: it either grants now,
 * or reports the wait. The CALLER decides whether the candidate is still worth
 * screening after that wait — a 40s-stale launch usually is not, and silently
 * sleeping on it would burn the budget on dead candidates.
 */

export class RpmLimiter {
  private stamps: number[] = [];

  constructor(private maxPerMinute = 9 /* one under the cap — clock skew margin */) {}

  /** Milliseconds until a slot is free. 0 = a slot is free right now. */
  public waitMs(now = Date.now()): number {
    this.evict(now);
    if (this.stamps.length < this.maxPerMinute) return 0;
    return Math.max(0, this.stamps[0] + 60_000 - now);
  }

  /** Take a slot if one is free. Returns false (and takes nothing) otherwise. */
  public tryAcquire(now = Date.now()): boolean {
    if (this.waitMs(now) > 0) return false;
    this.stamps.push(now);
    return true;
  }

  private evict(now: number): void {
    while (this.stamps.length && this.stamps[0] <= now - 60_000) this.stamps.shift();
  }

  public inFlightWindow(now = Date.now()): number {
    this.evict(now);
    return this.stamps.length;
  }
}
