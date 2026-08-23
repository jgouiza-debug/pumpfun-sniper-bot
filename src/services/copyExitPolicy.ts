/**
 * Exit policy for copy positions — the pure, engine-free part, so the
 * behaviours that went wrong have tests that can actually fail.
 *
 * WHY (2026-08-22, reported by the owner as "copy trade is not selling at the
 * same time as the person being copied, and sometimes not at all"):
 *
 *  1. closePosition() began with `if (pos.exitInFlight) return;`. A leader who
 *     sells in two chunks inside the 3–30s our first sell takes to confirm had
 *     the second chunk written to the feed as "mirroring X% exit" — and then
 *     nothing happened. No queue, no retry, no failure line. ExitQueue runs
 *     exits for one position strictly in arrival order instead of dropping
 *     them; each queued fraction applies to whatever is LEFT when its turn
 *     comes, which is exactly how the leader's own sequence composes.
 *
 *  2. The sell was routed to the venue recorded at BUY time. A token bought on
 *     the bonding curve ('pump') and sold after graduation went to a completed
 *     curve and failed on-chain every time. sellVenueCandidates() routes by the
 *     venue the leader's SELL carries and falls back to 'auto'; the buy-time
 *     pool never enters.
 *
 *  3. One failed attempt ended the exit for good — "position kept, see engine
 *     log". The sniper's own exits had a bounded backoff loop; copy exits had
 *     none. sellRetryDelayMs() paces one.
 *
 *  4. The copy trader's BUY slippage was passed as the sell override, which
 *     bypassed the engine's looser sell band exactly when the leader's dump
 *     was moving the price. copySellSlippagePct() takes the wider of the two.
 */

/** Attempts per exit before it is left to the SELL button. */
export const COPY_SELL_MAX_ATTEMPTS = 6;

/**
 * Fraction of the leader's bag that this sell disposed of, from their
 * post-trade balance. Both feeds supply it: PumpPortal as newTokenBalance,
 * Helius from post balances. Unknown balance → treat as a full exit (the
 * conservative reading when the leader may be gone). A zero-size "sell" is
 * nothing to mirror.
 */
export function leaderSellFraction(sold: number, remaining?: number): number {
  if (!(sold > 0)) return 0;
  if (remaining === undefined || !isFinite(remaining) || remaining < 0) return 1;
  const fraction = sold / (sold + remaining);
  return Math.max(0, Math.min(1, fraction));
}

/**
 * Venues to try for a copy sell, in order: the venue the leader's sell
 * carried (live by definition), then 'auto' (PumpPortal resolves it). The
 * buy-time pool is deliberately not a parameter — it is stale the moment the
 * token graduates.
 */
export function sellVenueCandidates(leaderSellPool?: string): string[] {
  const out: string[] = [];
  const leader = (leaderSellPool || '').trim();
  if (leader) out.push(leader);
  if (!out.includes('auto')) out.push('auto');
  return out;
}

/**
 * Backoff before retry N (N = failed attempts so far): 1.5s, 3s, 6s, then
 * capped at 10s. Capped low on purpose — a queued leader sell behind this one
 * is waiting, and the leader is already out.
 */
export function sellRetryDelayMs(failedAttempts: number): number {
  const n = Math.max(1, Math.floor(failedAttempts));
  return Math.min(10_000, 1_500 * Math.pow(2, n - 1));
}

/** The wider of the copy setting and the engine's own sell tolerance, clamped to [1, 100]. */
export function copySellSlippagePct(copyMaxSlippagePct: number, engineSellSlippagePct?: number): number {
  const copy = isFinite(copyMaxSlippagePct) ? copyMaxSlippagePct : 0;
  const engine = engineSellSlippagePct !== undefined && isFinite(engineSellSlippagePct) ? engineSellSlippagePct : 0;
  return Math.max(1, Math.min(100, Math.max(copy, engine)));
}

/**
 * Serial task queue keyed by position id. Tasks for one key run one after
 * another in the order they were enqueued; a task that throws does not block
 * the next. Different keys never wait on each other.
 */
export class ExitQueue {
  private tails = new Map<string, Promise<unknown>>();
  private depths = new Map<string, number>();

  public run<T>(key: string, task: () => Promise<T>): Promise<T> {
    // Tails never reject (see below), so `prev` is safe to chain on directly.
    const prev = this.tails.get(key) ?? Promise.resolve();
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);

    const result = prev.then(async () => {
      try {
        return await task();
      } finally {
        // Book-keeping settles BEFORE `result` does, so a caller that awaits
        // the exit and then asks isBusy() gets the answer for the world it is
        // actually in — not one microtask behind it.
        const left = (this.depths.get(key) ?? 1) - 1;
        if (left > 0) {
          this.depths.set(key, left);
        } else {
          this.depths.delete(key);
          this.tails.delete(key);
        }
      }
    });
    // A task that throws must not poison the chain for the exit queued behind it.
    this.tails.set(key, result.catch(() => undefined));
    return result;
  }

  /** True while an exit for this key is running or waiting its turn. */
  public isBusy(key: string): boolean {
    return (this.depths.get(key) ?? 0) > 0;
  }

  /** Running + queued exits for this key. */
  public depth(key: string): number {
    return this.depths.get(key) ?? 0;
  }
}
