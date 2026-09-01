/**
 * THE LAUNCH TAPE — who is actually buying a fresh launch, not just how much.
 *
 * The launch-snipe lane (Play 1) used to fire on one number: real SOL in the
 * bonding curve minus the creator's initial buy. That is what the curve
 * account can say, and it is exactly the number a bundled launch is built to
 * fake. The deployer's side wallets buy 1-2 SOL in the create's own slot,
 * every sniper watching the curve sees "stranger inflow" and fires, and the
 * bundle sells into them. From the receipts panel that reads as "the bot
 * picks bad tokens". It was not picking anything — it was being picked.
 *
 * This module answers the question the curve cannot: how many DISTINCT
 * wallets, across how many DISTINCT slots, put that SOL in, and how much of
 * it is one hand. It is fed by a `logsSubscribe` on the mint at 'processed'
 * (the same decoder the copy trader and the smart-money lane run — zero RPC
 * per trade) and it is deliberately pure: no sockets, no clock, no engine
 * state, so the rule is unit-provable and the thing the suite proves is the
 * thing that ships.
 *
 * WHAT COUNTS. Only buys the tape has SEEN. Inflow that landed before the
 * subscription was acknowledged (the create's own slot, the first few hundred
 * milliseconds of the token's life) never reaches the tape and is therefore
 * never attributed to anyone — which is the right answer, because that is
 * the insider window by definition. A launch with genuine interest keeps
 * accruing buyers after we are watching; a bundle does not.
 *
 * WHAT IS EXCLUDED, by name: failed transactions (nothing moved), sells, the
 * creator's own wallet (their top-ups are not demand), and duplicate
 * deliveries of one signature (a reconnect can replay).
 */

export interface TapeTrade {
  mint: string;
  user: string;
  isBuy: boolean;
  solLamports: bigint;
  slot: number;
  signature: string;
  /** Non-null when the transaction failed on-chain. */
  err: unknown;
}

export interface LaunchTapeRules {
  /** Distinct non-creator wallets that must have bought since the tape went live. */
  minDistinctBuyers: number;
  /** Distinct slots those buys must span. One slot is one bundle, whatever the wallet count. */
  minDistinctSlots: number;
  /** Ceiling on the share (0-100) of attributed inflow that one wallet may account for. */
  maxSingleBuyerPct: number;
}

export interface LaunchTapeVerdict {
  ok: boolean;
  /** Plain-language reason, for the gate0 log line. */
  reason: string;
  /** SOL attributed to distinct non-creator buyers the tape has seen. */
  strangerSol: number;
  buyers: number;
  slots: number;
  topBuyerPct: number;
}

interface ArmedMint {
  creator?: string;
  armedAt: number;
  /** SOL (lamports) per buyer wallet. */
  byBuyer: Map<string, bigint>;
  slots: Set<number>;
  signatures: Set<string>;
}

/**
 * How many armed mints keep a tape at once. Bounds the subscription count on
 * the shared socket. At the observed ~0.6 creates/s and a 60s window, ~36 are
 * inside the window at any moment; 48 leaves headroom without letting a
 * quiet hour pile up hundreds of dead subscriptions. Past the cap the OLDEST
 * armed mint loses its tape (and, since a verdict needs a live tape, its
 * snipe can no longer fire — it falls back to the Play 2 path at window end).
 */
export const LAUNCH_TAPE_MAX_MINTS = 48;

/** Trades remembered per mint. A launch that busy has answered the question already. */
const MAX_TRADES_PER_MINT = 400;

export class LaunchTape {
  private armed = new Map<string, ArmedMint>();

  /**
   * Start attributing this mint's inflow. Returns the mint evicted to stay
   * under the cap, if any, so the caller can drop its subscription too.
   */
  public arm(mint: string, opts: { creator?: string; armedAt: number }): string | null {
    if (this.armed.has(mint)) return null;
    this.armed.set(mint, {
      creator: opts.creator,
      armedAt: opts.armedAt,
      byBuyer: new Map(),
      slots: new Set(),
      signatures: new Set(),
    });
    if (this.armed.size <= LAUNCH_TAPE_MAX_MINTS) return null;
    // Insertion-ordered: the first key is the oldest arm.
    const oldest = this.armed.keys().next().value;
    if (oldest === undefined) return null;
    this.armed.delete(oldest);
    return oldest;
  }

  public disarm(mint: string): void {
    this.armed.delete(mint);
  }

  public clear(): void {
    this.armed.clear();
  }

  public isArmed(mint: string): boolean {
    return this.armed.has(mint);
  }

  public armedMints(): string[] {
    return [...this.armed.keys()];
  }

  /** Feed one decoded trade. Anything not about an armed mint is ignored. */
  public observe(t: TapeTrade): void {
    const a = this.armed.get(t.mint);
    if (!a) return;
    if (t.err) return;                                   // failed on-chain: nothing moved
    if (!t.isBuy) return;                                // sells are not demand
    if (a.creator && t.user === a.creator) return;       // the dev topping up is not a stranger
    if (t.solLamports <= 0n) return;
    if (a.signatures.has(t.signature)) return;           // replayed delivery
    if (a.signatures.size >= MAX_TRADES_PER_MINT) return;
    a.signatures.add(t.signature);
    a.byBuyer.set(t.user, (a.byBuyer.get(t.user) ?? 0n) + t.solLamports);
    if (t.slot > 0) a.slots.add(t.slot);
  }

  /**
   * The rule. `live` is whether the mint's subscription is currently
   * acknowledged by the server — the caller knows, the tape does not. A tape
   * that is not live cannot have seen the inflow, so it cannot vouch for it,
   * and the answer is no: firing on unattributed inflow is the exact failure
   * this module replaces.
   */
  public verdict(mint: string, rules: LaunchTapeRules, live: boolean): LaunchTapeVerdict {
    const a = this.armed.get(mint);
    const empty = { strangerSol: 0, buyers: 0, slots: 0, topBuyerPct: 0 };
    if (!a) return { ok: false, reason: 'no tape armed for this mint', ...empty };
    if (!live) {
      return { ok: false, reason: 'the trade tape is not live for this mint, so the inflow cannot be attributed to anyone', ...empty };
    }

    let total = 0n;
    let top = 0n;
    for (const v of a.byBuyer.values()) {
      total += v;
      if (v > top) top = v;
    }
    const strangerSol = Number(total) / 1e9;
    const buyers = a.byBuyer.size;
    const slots = a.slots.size;
    const topBuyerPct = total > 0n ? Number((top * 10_000n) / total) / 100 : 0;
    const stats = { strangerSol, buyers, slots, topBuyerPct };

    if (buyers < rules.minDistinctBuyers) {
      return { ok: false, reason: `${buyers} distinct buyer(s) on the tape, need ${rules.minDistinctBuyers}`, ...stats };
    }
    if (slots < rules.minDistinctSlots) {
      return { ok: false, reason: `every buy landed in ${slots} slot(s) — that is one bundle, not a crowd`, ...stats };
    }
    if (topBuyerPct > rules.maxSingleBuyerPct) {
      return { ok: false, reason: `${topBuyerPct.toFixed(0)}% of the attributed inflow is one wallet (cap ${rules.maxSingleBuyerPct}%)`, ...stats };
    }
    return { ok: true, reason: `${buyers} buyers over ${slots} slots, largest ${topBuyerPct.toFixed(0)}%`, ...stats };
  }
}
