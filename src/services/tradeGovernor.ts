/**
 * THE SPEND GOVERNOR — one hard ceiling on money leaving the wallet, shared by
 * every engine.
 *
 * WHY THIS EXISTS (incident 2026-08-30, "it emptied my wallet"):
 *
 * The bot already had unattended-operation breakers in guardrails.ts — an
 * entry-rate limiter, a consecutive-transaction-failure breaker and a
 * feed-freshness gate. Every one of them was wired into exactly ONE place:
 * sniperEngine's own entry gate (`evaluateGuardrails`, sniperEngine.ts). The
 * copy trader does not go through that gate. It calls
 * `sniperEngine.executeExternalTrade()`, which drops straight into
 * `executeRealMainnetTrade` — BELOW every breaker.
 *
 * It was not an oversight that went unnoticed; it was written down. From
 * sniperEngine.noteTradeFailure:
 *
 *     "Copy-trade orders share the signer but not the breaker. […] The copy
 *      trader runs its own bounded retries instead."
 *
 * The copy trader had no bounded retries, no failure counter, no rate limit and
 * no spend cap — grep it: there is not one. So the copy path could:
 *
 *   - buy on EVERY leader signal (perWalletCooldownSec defaults to 0,
 *     minLeaderBuySol defaults to 0), including a leader that trades hundreds
 *     of times a minute;
 *   - re-buy the SAME mint without limit (blockRepeatBuys defaults to false, and
 *     a repeat buy folds into the existing position, so `maxOpenPositions`
 *     never counts it) — each repeat carving a fresh slice off what was left;
 *   - burn a base fee plus a priority fee on every buy that FAILED on-chain,
 *     forever, because a failed buy opens no position and therefore never
 *     consumes a position slot either.
 *
 * Nothing in that list is a bug in one function. It is the absence of a
 * ceiling. This module is that ceiling.
 *
 * DESIGN RULES (deliberate, and the test suite enforces them):
 *
 *  1. PURE. No clock reads, no I/O, no engine imports. Every decision is a
 *     function of explicit inputs plus recorded history. A 3am breaker has to
 *     be provable in a test rather than discovered not to have fired in the
 *     morning.
 *  2. FAIL CLOSED. A limit that cannot be evaluated refuses. A NaN/Infinity
 *     input refuses. Guards that compare against NaN silently pass (NaN >= x
 *     is false), which is how a corrupt config becomes an unlimited spend.
 *  3. STOPS BUYS ONLY. Nothing here ever blocks a SELL. Being unable to exit is
 *     strictly worse than being unable to enter, and a wallet that has tripped
 *     a breaker still has bags that need to get out. Same posture as
 *     guardrails.ts: breakers stop new entries and never force-sell.
 *  4. ONE LATCH, BOTH ENGINES. A trip halts the sniper AND the copy trader.
 *     The failure that emptied the wallet was cross-engine — they share a
 *     signer, so they must share a breaker.
 *  5. EXPLICIT RESET. A tripped governor stays tripped until the operator
 *     clears it. Whatever broke at 3am is still broken at 3:01.
 */

/** A decision. `allowed: false` always carries a reason a human can act on. */
export interface GovernorDecision {
  allowed: boolean;
  reason?: string;
  /** Set when the refusal is the latched halt rather than a per-trade limit. */
  halted?: boolean;
}

const ALLOW: GovernorDecision = { allowed: true };

/**
 * Every ceiling. `0` disables an individual limit — deliberately, so an
 * operator can run a limit off without editing code — EXCEPT
 * `minWalletReserveSol`, where 0 is a legitimate "no floor".
 */
export interface GovernorLimits {
  /** Buy ATTEMPTS per rolling hour, across both engines. */
  maxBuysPerHour: number;
  /** SOL committed to buys per rolling hour, across both engines. */
  maxSolPerHour: number;
  /** SOL committed to buys since the governor was last reset (the session). */
  maxSolPerSession: number;
  /** Total SOL committed to any ONE mint. Bounds unlimited DCA into a loser. */
  maxSolPerMint: number;
  /** Buy attempts against any ONE mint. Bounds a repeat-buy loop. */
  maxBuysPerMint: number;
  /** Consecutive buys that failed to land before the governor latches. */
  maxConsecutiveFailures: number;
  /**
   * Wallet SOL that must remain AFTER a buy. This is not the exit-gas reserve
   * (that is per-position and lives in the copy trader); this is the floor
   * below which the bot stops trading at all, so a wallet can never be taken to
   * zero by trading.
   */
  minWalletReserveSol: number;
  /** Buys allowed in flight at once, across both engines. */
  maxConcurrentBuys: number;
  /**
   * How old the wallet-balance reading may be when a buy is sized against it.
   *
   * walletService keeps the LAST KNOWN balance when a read fails and does not
   * advance its timestamp, so under a 429 storm every subsequent read fails and
   * the figure simply freezes — at a value from before the buys that have
   * landed since. Sizing against a frozen balance is how several orders each
   * "afford" money that is already spent. A stale reading is not a small error;
   * it is the wrong number, so it refuses.
   */
  maxBalanceAgeMs: number;
  /**
   * Realized LOSS, in SOL, allowed in a session before trading latches.
   *
   * The existing kill switch (sniperEngine.checkKillSwitch) reads only the
   * SNIPER's tradeHistory and is gated on `config.isBotActive` — the sniper's
   * own run flag. Someone who runs copy trading with the sniper stopped, which
   * is the natural configuration for "I just want to mirror this wallet" and
   * the one described in the incident, had NO hourly cap, NO daily cap and no
   * consecutive-loss cap of any kind. A leader trading into rugs could close
   * copy position after copy position at -90% and nothing would ever stop it.
   *
   * Counted across both engines, for the same reason every other ceiling here
   * is: one wallet.
   */
  maxSessionLossSol: number;
}

/**
 * Shipped ceilings.
 *
 * These are chosen to be INVISIBLE to ordinary use and decisive against a
 * runaway. A human following a leader does not make 60 buys in an hour, does
 * not put 12 slices into one mint, and does not eat 6 failed transactions in a
 * row without wanting to know about it.
 *
 * They are ceilings, not strategy. Sizing still belongs to the copy trader's
 * split/fixed/proportional logic; this only says "and never past here".
 */
export const DEFAULT_GOVERNOR_LIMITS: GovernorLimits = {
  maxBuysPerHour: 60,
  maxSolPerHour: 1.0,
  maxSolPerSession: 2.0,
  maxSolPerMint: 0.25,
  maxBuysPerMint: 6,
  maxConsecutiveFailures: 5,
  minWalletReserveSol: 0.01,
  maxConcurrentBuys: 3,
  // 30s: comfortably longer than the 8s balance TTL and any normal refresh, so
  // it never fires in healthy operation, and decisively shorter than the window
  // in which a frozen balance can fund several phantom-affordable orders.
  maxBalanceAgeMs: 30_000,
  // Sits below maxSolPerSession: losing the whole session budget should stop
  // trading well before the budget itself runs out.
  maxSessionLossSol: 0.5,
};

/** What the governor needs to know about a proposed buy. */
export interface BuyRequest {
  now: number;
  mint: string;
  /**
   * SOL this buy will commit — the WORST CASE outflow (stake plus slippage
   * headroom, protocol fees, priority fee and rent), not the nominal stake.
   * Budgeting the nominal figure is how a "0.02 SOL" order takes 0.03 out.
   */
  solAmount: number;
  /** Wallet balance in SOL, as freshly read as the caller can make it. */
  walletSol: number;
  /** Buys already submitted and not yet resolved, across both engines. */
  inFlightBuys: number;
  /**
   * Age of `walletSol` in ms — how long ago the balance was last READ FROM THE
   * CHAIN successfully, not how long ago it was asked for. Omit only where no
   * timestamp is available; a missing value is treated as fresh, so callers
   * that can supply it must.
   */
  walletSolAgeMs?: number;
  /** Which engine is asking — for the refusal message and the audit trail. */
  engine: 'sniper' | 'copy';
}

interface BuyRecord {
  at: number;
  mint: string;
  sol: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A number that is safe to compare against a limit.
 *
 * NaN and Infinity are the two values that turn every guard in this file into a
 * no-op: `NaN >= limit` is false, so a NaN spend passes every ceiling, and an
 * Infinity limit passes every ceiling too. Both are reachable from a corrupt
 * `.copy-trader.json`, a hand-edited flags file, or a UI field that posted an
 * empty string. Anything that is not a finite number is treated as unusable and
 * refuses.
 */
function usable(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export class TradeGovernor {
  private buys: BuyRecord[] = [];
  private sessionSol = 0;
  private sessionRealizedSol = 0;
  private consecutiveFailures = 0;
  private haltedReason: string | null = null;
  private limits: GovernorLimits;

  constructor(limits: Partial<GovernorLimits> = {}) {
    this.limits = { ...DEFAULT_GOVERNOR_LIMITS, ...limits };
  }

  /**
   * Re-read the operator's ceilings. Held as state rather than rebuilt per call
   * because the rolling history has to survive a settings change — otherwise
   * moving a slider resets the very window that was about to trip.
   *
   * A non-finite value is REJECTED and the previous ceiling kept: a slider that
   * posts "" must not silently become "unlimited".
   */
  public setLimits(partial: Partial<GovernorLimits>): void {
    for (const [k, v] of Object.entries(partial)) {
      if (usable(v) && v >= 0) (this.limits as any)[k] = v;
    }
  }

  public getLimits(): GovernorLimits {
    return { ...this.limits };
  }

  private prune(now: number): void {
    const cutoff = now - HOUR_MS;
    // Append-only in time order, so one scan from the front is enough.
    let i = 0;
    while (i < this.buys.length && this.buys[i].at <= cutoff) i++;
    if (i > 0) this.buys.splice(0, i);
  }

  /**
   * THE GATE. Called immediately before money moves, by every engine.
   *
   * Order matters only for the message the operator sees; every limit is
   * checked, and the first refusal wins. The latch is checked first so a halted
   * bot always says it is halted rather than naming whichever ceiling happened
   * to be nearest.
   */
  public checkBuy(req: BuyRequest): GovernorDecision {
    if (this.haltedReason) {
      return { allowed: false, halted: true, reason: `trading HALTED: ${this.haltedReason}` };
    }

    // Fail closed on unusable inputs. A buy whose size we cannot read is a buy
    // whose cost we cannot bound.
    if (!usable(req.solAmount) || req.solAmount <= 0) {
      return { allowed: false, reason: `refusing a buy with an unusable size (${String(req.solAmount)})` };
    }
    if (!usable(req.walletSol)) {
      return { allowed: false, reason: `refusing a buy against an unreadable wallet balance (${String(req.walletSol)})` };
    }
    if (!usable(req.now)) {
      return { allowed: false, reason: 'refusing a buy with an unusable timestamp' };
    }

    const L = this.limits;
    this.prune(req.now);

    // 0. Is the number we are about to size against still true? Checked before
    //    every ceiling that consults it, because a stale balance makes all of
    //    them wrong in the same direction — permissive.
    if (L.maxBalanceAgeMs > 0 && usable(req.walletSolAgeMs) && req.walletSolAgeMs > L.maxBalanceAgeMs) {
      return {
        allowed: false,
        reason: `the wallet balance was last read ${Math.round(req.walletSolAgeMs / 1000)}s ago `
          + `(max ${Math.round(L.maxBalanceAgeMs / 1000)}s) — refusing to size a buy against a stale balance. `
          + `This usually means the RPC is rate-limited or down.`,
      };
    }

    // 1. Wallet floor. Checked FIRST of the real limits because it is the one
    //    that describes the reported harm directly: the wallet must not be
    //    tradable to zero.
    if (L.minWalletReserveSol > 0 && req.walletSol - req.solAmount < L.minWalletReserveSol) {
      return {
        allowed: false,
        reason: `wallet floor: a ${req.solAmount.toFixed(4)} SOL buy would leave `
          + `${(req.walletSol - req.solAmount).toFixed(4)} SOL, below the ${L.minWalletReserveSol} SOL reserve `
          + `that must stay behind to fund exits`,
      };
    }

    // 2. Concurrency. Bounds how much can be committed before any of it has
    //    resolved — the window in which per-trade sizing is blind.
    if (L.maxConcurrentBuys > 0 && usable(req.inFlightBuys) && req.inFlightBuys >= L.maxConcurrentBuys) {
      return {
        allowed: false,
        reason: `${req.inFlightBuys} buys already in flight (max ${L.maxConcurrentBuys}) — waiting for them to settle`,
      };
    }

    // 3. Per-mint ceilings. THE repeat-buy bound: with blockRepeatBuys off, a
    //    leader who scales into one token had us scale in with them without
    //    limit, and because a repeat buy merges into the existing position it
    //    never consumed a position slot, so maxOpenPositions never saw it.
    const mintBuys = this.buys.filter(b => b.mint === req.mint);
    if (L.maxBuysPerMint > 0 && mintBuys.length >= L.maxBuysPerMint) {
      return {
        allowed: false,
        reason: `${mintBuys.length} buys of ${req.mint.slice(0, 8)}… in the last hour (max ${L.maxBuysPerMint}) — `
          + `refusing to keep scaling into one token`,
      };
    }
    const mintSol = mintBuys.reduce((a, b) => a + b.sol, 0);
    if (L.maxSolPerMint > 0 && mintSol + req.solAmount > L.maxSolPerMint) {
      return {
        allowed: false,
        reason: `${(mintSol + req.solAmount).toFixed(4)} SOL would be committed to ${req.mint.slice(0, 8)}… `
          + `(max ${L.maxSolPerMint} SOL per mint)`,
      };
    }

    // 4. Rolling-hour ceilings, across both engines.
    if (L.maxBuysPerHour > 0 && this.buys.length >= L.maxBuysPerHour) {
      const freesInSec = Math.max(0, Math.ceil((this.buys[0].at + HOUR_MS - req.now) / 1000));
      return {
        allowed: false,
        reason: `${this.buys.length} buys in the last hour (max ${L.maxBuysPerHour}) — `
          + `next slot frees in ${freesInSec}s`,
      };
    }
    const hourSol = this.buys.reduce((a, b) => a + b.sol, 0);
    if (L.maxSolPerHour > 0 && hourSol + req.solAmount > L.maxSolPerHour) {
      return {
        allowed: false,
        reason: `${(hourSol + req.solAmount).toFixed(4)} SOL would be committed this hour `
          + `(max ${L.maxSolPerHour} SOL/h)`,
      };
    }

    // 5. Session ceiling. The backstop that does not roll off: a bot left
    //    running for a week cannot spend an hourly cap 168 times over.
    if (L.maxSolPerSession > 0 && this.sessionSol + req.solAmount > L.maxSolPerSession) {
      return {
        allowed: false,
        reason: `${(this.sessionSol + req.solAmount).toFixed(4)} SOL would be committed this session `
          + `(max ${L.maxSolPerSession} SOL) — reset the governor to continue`,
      };
    }

    return ALLOW;
  }

  /**
   * Record a buy against every rolling total.
   *
   * Counted at RESERVATION, not at fill: the fee is spent whatever the chain
   * decides, and a limiter that counted only fills would let an unbounded
   * number of failures through — the exact runaway that burned a wallet down
   * with an empty trade ledger to show for it.
   */
  public recordBuy(now: number, mint: string, solAmount: number): void {
    if (!usable(now) || !usable(solAmount) || solAmount <= 0) return;
    this.prune(now);
    this.buys.push({ at: now, mint, sol: solAmount });
    this.sessionSol += solAmount;
  }

  /**
   * CHECK AND CLAIM, IN ONE SYNCHRONOUS STEP. This is the method engines call;
   * `checkBuy` alone is not sufficient and is kept only for tests and for the
   * UI's "would this be allowed" preview.
   *
   * WHY (found by the drain-guards audit lane against the first version of this
   * file): `checkBuy` reads counters that `recordBuy` writes. Between the two
   * sits the whole build-and-sign path — an HTTP call to trade-local, lookup
   * table resolution, the intent guard, signing — which is hundreds of
   * milliseconds of `await`. The per-mint trade queue serialises same-mint work
   * only, so a leader transaction touching six mints starts six `onLeaderBuy`
   * bodies concurrently. All six would call checkBuy against counters still
   * reading zero, all six would pass every SOL ceiling, and all six would then
   * record — putting six times the intended amount through a cap that was
   * supposed to stop the second one. A ceiling with a race is not a ceiling.
   *
   * Node runs this synchronously to completion with no `await` inside, so the
   * check and the claim cannot interleave with another order. The returned
   * `release` undoes the claim for an order that never reaches the chain (a
   * build failure, a refusal by the intent guard) — anything that actually got
   * submitted keeps its claim, because it spent a fee.
   */
  public tryReserveBuy(req: BuyRequest): GovernorDecision & { release?: () => void } {
    const decision = this.checkBuy(req);
    if (!decision.allowed) return decision;

    this.recordBuy(req.now, req.mint, req.solAmount);
    const record = this.buys[this.buys.length - 1];
    let released = false;
    return {
      ...decision,
      release: () => {
        // Idempotent, and it removes THIS claim by identity rather than by
        // position — the array is pruned and appended to concurrently, so an
        // index would release somebody else's.
        if (released) return;
        released = true;
        const i = this.buys.indexOf(record);
        if (i >= 0) this.buys.splice(i, 1);
        this.sessionSol = Math.max(0, this.sessionSol - record.sol);
      },
    };
  }

  /**
   * Report what the chain did with a buy.
   *
   * `landed` means the transaction confirmed successfully. Anything else — a
   * definitive on-chain rejection, an expired blockhash, an outcome we could
   * not determine — counts as a failure, because all of them burned a fee and
   * none of them produced a position. Returns true when this outcome latched
   * the governor.
   */
  public recordBuyOutcome(landed: boolean, detail: string): boolean {
    if (landed) {
      this.consecutiveFailures = 0;
      return false;
    }
    this.consecutiveFailures++;
    const max = this.limits.maxConsecutiveFailures;
    if (max > 0 && this.consecutiveFailures >= max) {
      this.halt(`${this.consecutiveFailures} buys in a row failed to land (last: ${detail}). `
        + `Every one of them burned a fee. Fix the cause, then reset the governor.`);
      return true;
    }
    return false;
  }

  /**
   * Book a CLOSED trade's realized P&L, in SOL, from either engine. Positive is
   * a gain. Latches the governor when cumulative session losses cross the
   * ceiling, and returns true when it did.
   *
   * Realized only. An open position that is down is not a loss yet, and
   * force-selling on unrealized drawdown is a risk decision this module does
   * not make — the same posture guardrails.ts takes.
   */
  public recordRealizedPnlSol(pnlSol: number): boolean {
    if (!usable(pnlSol)) return false;
    this.sessionRealizedSol += pnlSol;
    const limit = this.limits.maxSessionLossSol;
    if (limit > 0 && this.sessionRealizedSol <= -limit) {
      this.halt(`realized losses this session are ${this.sessionRealizedSol.toFixed(4)} SOL `
        + `(limit ${limit} SOL). New entries are stopped; exits still work. `
        + `Review what the leaders are doing before resetting the governor.`);
      return true;
    }
    return false;
  }

  public sessionRealizedPnlSol(): number {
    return Number(this.sessionRealizedSol.toFixed(4));
  }

  /**
   * Latch the governor. Idempotent — the FIRST reason is kept, because it is
   * the one that describes what actually went wrong; later trips are
   * consequences.
   */
  public halt(reason: string): void {
    if (!this.haltedReason) this.haltedReason = reason;
  }

  public isHalted(): boolean {
    return this.haltedReason !== null;
  }

  public haltReason(): string | null {
    return this.haltedReason;
  }

  /** Operator action only. Clears the latch and the failure streak. */
  public clearHalt(): void {
    this.haltedReason = null;
    this.consecutiveFailures = 0;
  }

  /** Operator action only. Clears the latch, the streak AND the session total. */
  public resetSession(): void {
    this.clearHalt();
    this.buys = [];
    this.sessionSol = 0;
    this.sessionRealizedSol = 0;
  }

  public consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Everything the UI needs to show the operator where they stand BEFORE a
   * ceiling bites. A limit the operator only learns about when it refuses a
   * trade reads as the bot breaking again, which is the trust problem this
   * whole change exists to fix.
   */
  public snapshot(now: number): {
    halted: boolean;
    haltReason: string | null;
    consecutiveFailures: number;
    buysThisHour: number;
    solThisHour: number;
    solThisSession: number;
    realizedPnlSol: number;
    limits: GovernorLimits;
  } {
    if (usable(now)) this.prune(now);
    return {
      halted: this.isHalted(),
      haltReason: this.haltedReason,
      consecutiveFailures: this.consecutiveFailures,
      buysThisHour: this.buys.length,
      solThisHour: Number(this.buys.reduce((a, b) => a + b.sol, 0).toFixed(4)),
      solThisSession: Number(this.sessionSol.toFixed(4)),
      realizedPnlSol: this.sessionRealizedPnlSol(),
      limits: this.getLimits(),
    };
  }
}

/**
 * The process-wide governor.
 *
 * A singleton on purpose: the sniper and the copy trader sign with the SAME
 * wallet, so a per-engine governor would let each spend the full ceiling and
 * the wallet would see twice what either was allowed. One wallet, one ceiling.
 */
export const tradeGovernor = new TradeGovernor();
