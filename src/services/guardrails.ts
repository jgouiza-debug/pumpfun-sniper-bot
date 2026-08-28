/**
 * Unattended-operation guardrails.
 *
 * The existing kill switch covers realized losses (hourly, daily, consecutive).
 * These cover the failure modes it does not: a bot that is losing money without
 * *closing* anything, a bot burning fees on transactions that never land, and a
 * bot still "active" while its data feed has gone silent.
 *
 * Everything here is a pure decision over explicit inputs — no clock reads
 * except the one passed in, no I/O, no engine coupling. That is deliberate: the
 * whole point is that a 3am breaker can be proven to fire in a test rather than
 * discovered not to have fired in the morning.
 *
 * Design rule shared by all three: they STOP NEW ENTRIES and never force-sell.
 * The owner's exit policy is hold-biased and is not this module's business —
 * a breaker that liquidated positions would be making a risk decision the owner
 * explicitly reserved for themselves.
 */

/** A breaker's answer. `allowed: false` always carries a human-readable reason. */
export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

const ALLOW: GateDecision = { allowed: true };

// ---------------------------------------------------------------------------
// Entry rate limit
// ---------------------------------------------------------------------------

/**
 * Caps how many entry ATTEMPTS may be made in a rolling window.
 *
 * Why attempts and not fills: a bot stuck in a retry loop against a token it can
 * never buy still pays a fee per attempt. Counting fills would let an unbounded
 * number of failures through, which is precisely the runaway this is meant to
 * stop.
 */
export class EntryRateLimiter {
  private stamps: number[] = [];

  constructor(
    private maxPerWindow: number,
    private windowMs: number = 60 * 60 * 1000
  ) {}

  /**
   * Re-reads the cap from config. The limiter holds rolling state, so it cannot
   * simply be reconstructed on each check — but a cap the operator can move in
   * Settings that the limiter never picks up is a decorative knob, which the
   * suite explicitly fails on.
   */
  public setMaxPerWindow(max: number): void {
    this.maxPerWindow = max;
  }

  /** Drops stamps that have aged out. Called by both check and record. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // The array is append-only in time order, so a single scan from the front
    // is enough; no need to filter the whole thing on every tick.
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }

  public check(now: number): GateDecision {
    if (this.maxPerWindow <= 0) return ALLOW;   // 0 disables the limiter
    this.prune(now);
    if (this.stamps.length >= this.maxPerWindow) {
      const oldest = this.stamps[0];
      const freesInSec = Math.ceil((oldest + this.windowMs - now) / 1000);
      return {
        allowed: false,
        reason: `entry rate limit: ${this.stamps.length} attempts in the last `
          + `${Math.round(this.windowMs / 60000)} min (max ${this.maxPerWindow}); `
          + `next slot frees in ${freesInSec}s`,
      };
    }
    return ALLOW;
  }

  public record(now: number): void {
    this.prune(now);
    this.stamps.push(now);
  }

  public countInWindow(now: number): number {
    this.prune(now);
    return this.stamps.length;
  }

  public reset(): void {
    this.stamps = [];
  }
}

// ---------------------------------------------------------------------------
// Consecutive failed-transaction breaker
// ---------------------------------------------------------------------------

/**
 * Trips after N consecutive transactions that failed to land.
 *
 * Distinct from the consecutive-LOSS breaker, which counts trades that closed
 * badly. This counts trades that never happened: every failed submission still
 * burns the base fee plus the priority fee, so a wallet can be ground down
 * without a single position ever opening — and the loss-based kill switch would
 * never see it, because nothing closed.
 *
 * Requires an explicit `reset()` once tripped. An automatic un-trip would defeat
 * the purpose: whatever broke at 3am is still broken at 3:01.
 */
export class FailureBreaker {
  private consecutive = 0;
  private tripped = false;
  private trippedReason?: string;

  constructor(private maxConsecutive: number) {}

  /**
   * Re-point the breaker at the operator's configured limit. Called before each
   * entry so a Settings change takes effect on the next trade — without this the
   * breaker was frozen on the constructor default and maxConsecutiveTxFailures
   * was a decorative config field. Never lowers below 1 while already counting
   * in a way that would retroactively trip; the check runs on the next failure.
   */
  public setMax(max: number): void {
    if (Number.isFinite(max) && max > 0) this.maxConsecutive = Math.floor(max);
  }

  public recordSuccess(): void {
    this.consecutive = 0;
  }

  /** Returns true when this failure is the one that trips the breaker. */
  public recordFailure(detail?: string): boolean {
    this.consecutive++;
    if (this.maxConsecutive > 0 && this.consecutive >= this.maxConsecutive && !this.tripped) {
      this.tripped = true;
      this.trippedReason = `${this.consecutive} consecutive transactions failed to land`
        + (detail ? ` (last: ${detail})` : '')
        + ` — every failed submission still pays its fee`;
      return true;
    }
    return false;
  }

  public check(): GateDecision {
    if (this.tripped) return { allowed: false, reason: this.trippedReason };
    return ALLOW;
  }

  public isTripped(): boolean { return this.tripped; }
  public consecutiveFailures(): number { return this.consecutive; }

  /** Manual only — see the class note on why there is no auto-recovery. */
  public reset(): void {
    this.consecutive = 0;
    this.tripped = false;
    this.trippedReason = undefined;
  }
}

// ---------------------------------------------------------------------------
// Feed freshness
// ---------------------------------------------------------------------------

/**
 * Refuses entries while the launch feed is stale.
 *
 * The keepalive already forces a reconnect on silence, but reconnecting is not
 * the same as being safe to trade: between the socket dying and the resubscribe
 * completing, the engine still holds cached state and remains nominally active.
 * Acting on state of unknown age is worse than not acting.
 *
 * Solana produces a slot roughly every 400 ms. `maxStaleSlots` is expressed in
 * slots because that is the unit the chain moves in, and converted here once.
 */
export const APPROX_SLOT_MS = 400;

export class FeedFreshnessGate {
  private lastMessageAt: number;

  constructor(
    private maxStaleSlots: number,
    startedAt: number
  ) {
    this.lastMessageAt = startedAt;
  }

  public touch(now: number): void {
    this.lastMessageAt = now;
  }

  public staleMs(now: number): number {
    return now - this.lastMessageAt;
  }

  public check(now: number): GateDecision {
    if (this.maxStaleSlots <= 0) return ALLOW;
    const limitMs = this.maxStaleSlots * APPROX_SLOT_MS;
    const silent = this.staleMs(now);
    if (silent > limitMs) {
      return {
        allowed: false,
        reason: `launch feed stale: silent for ${(silent / 1000).toFixed(1)}s `
          + `(~${Math.round(silent / APPROX_SLOT_MS)} slots, limit ${this.maxStaleSlots}). `
          + `Refusing to trade on state of unknown age.`,
      };
    }
    return ALLOW;
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Evaluates every gate and returns the FIRST refusal, so the operator sees one
 * clear cause rather than a pile of simultaneous complaints.
 */
export function evaluateGuardrails(gates: GateDecision[]): GateDecision {
  for (const g of gates) if (!g.allowed) return g;
  return ALLOW;
}
