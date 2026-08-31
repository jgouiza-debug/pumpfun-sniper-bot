import type { Connection } from '@solana/web3.js';
import { noteRpcOutcome } from './rpcHealth';

/**
 * DID IT LAND? — the one place that answers that question, and the only answer
 * anything is allowed to record a position from.
 *
 * WHY THIS EXISTS (incident 2026-08-30, "saying its on chain but its not"):
 *
 * The old `sniperEngine.confirmTransaction` polled `getSignatureStatus` for 30
 * seconds and collapsed everything it could not resolve into one word:
 * `'timeout'`. Its callers then did this, for a BUY:
 *
 *     if (confirmed === 'timeout') {
 *       // "funds may have moved"
 *       return { txid, fill: null };
 *     }
 *
 * A non-null return means success to every caller. So a buy that was never
 * confirmed — possibly never landed at all — came back looking exactly like a
 * buy that filled, and:
 *
 *   - copyTraderService.onLeaderBuy invented the quantities
 *     (`tokensBought = copySol / leaderPriceSol`, `solSpent = copySol`) and
 *     called recordBuy() with `fillVerified: false`;
 *   - sniperEngine.executeBuy fell through with its pre-trade estimates
 *     (`tokensHeld = investedUsd / buyPriceUsd`, or a literal 1_000_000) and
 *     pushed the position into activePositions;
 *   - the UI rendered BOTH states as "ON-CHAIN" (CopyTradingPage.ExecBadge:
 *     `{fillVerified ? 'ON-CHAIN ✓' : 'ON-CHAIN ↗'}`), and the unverified
 *     tooltip actually read "Submitted and confirmed on-chain".
 *
 * That is the reported symptom, verbatim, produced on purpose by the code.
 *
 * Three things made 'timeout' far more common than it looks:
 *
 *  1. `getSignatureStatus` was called with no options, so
 *     `searchTransactionHistory` defaulted to FALSE. A node only keeps recent
 *     signature statuses in memory; once a signature ages out of that cache the
 *     call returns null forever — and null was read as "not confirmed yet".
 *  2. The poll loop swallowed every RPC error in a bare `catch {}` and kept
 *     going. A rate-limited key (the 429 storms this repo has measured more
 *     than once) means EVERY poll throws for the whole 30s, so EVERY trade
 *     "times out" — and under the old rules every buy in that window became a
 *     phantom position.
 *  3. 30s is shorter than a blockhash lifetime (~60-90s). The bot gave up while
 *     the transaction was still perfectly able to land, so "we don't know" was
 *     reported at the one moment it was least knowable.
 *
 * WHAT THIS MODULE DOES DIFFERENTLY:
 *
 *  - It asks `getSignatureStatuses` WITH `searchTransactionHistory: true`.
 *  - It separates "the chain says no" from "the RPC would not talk to us".
 *    Those are different facts and only one of them is a safe basis for
 *    recording anything.
 *  - It proves the NEGATIVE case instead of guessing it: once the transaction's
 *    own blockhash is no longer valid and the signature still has no status,
 *    the transaction can never land. That is `'expired'` — a definitive
 *    "nothing happened", which is exactly what a caller needs in order to
 *    safely NOT open a position.
 *  - Only when the RPC never answered does it return `'unknown'`, and a caller
 *    that receives `'unknown'` is required to treat the position as unproven.
 *
 * Pure w.r.t. the clock only through the injected `now`/`sleep` so the suite can
 * drive it deterministically; all chain access goes through the injected
 * connection.
 */

export type SettlementOutcome =
  /** Landed and succeeded. The only outcome a real position may be opened from. */
  | 'landed'
  /** Landed and was rolled back on-chain. Nothing moved; only the fee burned. */
  | 'reverted'
  /** Landed and was rolled back specifically for slippage (6004). */
  | 'slippage'
  /**
   * Provably never landed: the blockhash is dead and the signature has no
   * status. Definitive — safe to treat as "nothing happened".
   */
  | 'expired'
  /**
   * We could not find out. The RPC never gave a usable answer. NOT a synonym
   * for failure and NOT a synonym for success — the caller must not record a
   * fill, and must reconcile against the chain later.
   */
  | 'unknown';

export interface SettlementResult {
  outcome: SettlementOutcome;
  /** The chain's raw error, when it landed and failed. */
  err?: unknown;
  /** Confirmations reached, when known. */
  confirmationStatus?: string;
  /** How long we polled, ms. */
  elapsedMs: number;
  /** Polls that threw. A high count next to 'unknown' means the RPC, not the chain. */
  rpcErrors: number;
  /** Human-readable, safe to log verbatim. */
  detail: string;
  /**
   * True when polling stopped because `yieldWhen` asked it to, NOT because the
   * window ran out. The distinction matters: a yielded transaction is still
   * perfectly able to land, so the caller owes it a reconciliation, whereas a
   * transaction that exhausted a window longer than its blockhash lifetime is
   * very probably dead. Only ever set alongside `outcome: 'unknown'`.
   */
  yielded?: boolean;
}

export interface SettleOptions {
  /**
   * Hard ceiling on polling. Defaults to 95s — deliberately LONGER than a
   * blockhash lifetime, so the common case resolves definitively (landed or
   * expired) instead of being abandoned mid-flight. Reaching this ceiling
   * without an answer is what 'unknown' means.
   */
  timeoutMs?: number;
  /** Poll cadence. 300ms matches the hot-path cadence the latency work settled on. */
  pollMs?: number;
  /**
   * The transaction's own recent blockhash. With it, expiry can be PROVEN and
   * the negative case returned early and definitively. Without it, an
   * unresolved transaction can only ever be reported as 'unknown' — correct,
   * but far less useful, so callers should always pass it.
   */
  blockhash?: string;
  /** How often to re-check blockhash validity. Cheap, but not free. */
  blockhashCheckMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress logging. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Stop polling early and hand the transaction to background reconciliation.
   *
   * WHY: this poll runs INSIDE the per-mint trade queue, so everything else for
   * that mint waits on it — including a leader's flip-sell. The window is 75s
   * because that is what it takes to resolve a buy definitively, but a bag the
   * leader is dumping cannot wait 75s for an answer that only affects
   * book-keeping. When this predicate returns true the loop returns
   * `{outcome: 'unknown', yielded: true}` immediately, the queue is freed, and
   * the caller reconciles the signature out of band.
   *
   * Never consulted before the first status poll: yielding without having
   * asked the chain even once would give up an answer that was already there.
   */
  yieldWhen?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/**
 * Bound a single RPC call in wall-clock time.
 *
 * `connectionConfig()` sets HTTP timeouts, but a keep-alive socket that dies
 * without a FIN — a flapping route, a sleeping NIC, an upstream proxy that just
 * stops — leaves the promise pending forever rather than rejecting. Every loop
 * in this file checks its deadline at the TOP of the iteration, so one call that
 * never settles means the deadline is never reached again: settleTransaction
 * never returns, executeRealMainnetTrade never returns, and the per-mint trade
 * queue plus the SOL reservation it holds are pinned for the life of the
 * process. A leader sell queued behind it never runs.
 *
 * A rejection here is indistinguishable from any other RPC error and is handled
 * the same way — counted, and the loop tries again.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Per-call ceiling. Generous next to a healthy response, decisive against a dead socket. */
const RPC_CALL_TIMEOUT_MS = 12_000;

/**
 * A transaction younger than this is never declared expired.
 *
 * 20s comfortably exceeds the confirmed-to-finalized lag and any propagation
 * delay, while staying far inside a blockhash's ~60s life — so the definitive
 * negative is still reached long before the transaction could have landed
 * unnoticed.
 */
const MIN_AGE_BEFORE_EXPIRY_MS = 20_000;

/** Anchor error 6004 in its several on-the-wire spellings. */
export function isSlippageError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const s = typeof err === 'string' ? err : JSON.stringify(err);
  return s.includes('6004') || s.includes('ExceededSlippage') || s.includes('SlippageExceeded');
}

/**
 * Poll a signature to a DEFINITIVE outcome wherever the chain permits one.
 *
 * Never throws: every failure mode is expressed in the returned outcome, so a
 * caller cannot accidentally treat a thrown error as a successful trade.
 */
export async function settleTransaction(
  connection: Pick<Connection, 'getSignatureStatuses' | 'isBlockhashValid'>,
  txid: string,
  opts: SettleOptions = {}
): Promise<SettlementResult> {
  const timeoutMs = opts.timeoutMs ?? 95_000;
  const pollMs = opts.pollMs ?? 300;
  const blockhashCheckMs = opts.blockhashCheckMs ?? 3_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const started = now();
  let rpcErrors = 0;
  let lastBlockhashCheck = 0;
  /**
   * Expiry is only trusted on the SECOND consecutive observation. A single
   * `isBlockhashValid:false` can race a transaction that landed in the very
   * last slot the blockhash was good for — the status simply has not propagated
   * to the node we are asking yet. Requiring two observations, with a status
   * poll in between, closes that window; the cost is one extra poll on a
   * transaction that was dead anyway.
   */
  let sawExpiredOnce = false;

  const done = (outcome: SettlementOutcome, detail: string, extra: Partial<SettlementResult> = {}): SettlementResult => ({
    outcome,
    elapsedMs: now() - started,
    rpcErrors,
    detail,
    ...extra,
  });

  while (now() - started < timeoutMs) {
    // ---- 1. Does the signature have a status? -----------------------------
    try {
      // searchTransactionHistory:true is the whole point. Without it a
      // signature that has aged out of the node's recent-status cache reads as
      // null — indistinguishable from "not landed" — which is how a landed
      // trade got reported as a timeout.
      const res = await withTimeout(
        connection.getSignatureStatuses([txid], { searchTransactionHistory: true }),
        RPC_CALL_TIMEOUT_MS, 'getSignatureStatuses');
      // The confirmation loop is the busiest RPC consumer on the trading path
      // and fed the health counters nothing, so a 429 storm here left the UI
      // reporting a healthy RPC during exactly the outage that was turning
      // every trade into a timeout.
      noteRpcOutcome(true);
      const value = res?.value?.[0];
      if (value) {
        if (value.err) {
          const slip = isSlippageError(value.err);
          return done(
            slip ? 'slippage' : 'reverted',
            slip
              ? `landed and was rejected for slippage (6004)`
              : `landed and was rejected on-chain: ${JSON.stringify(value.err)}`,
            { err: value.err, confirmationStatus: value.confirmationStatus ?? undefined }
          );
        }
        if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
          return done('landed', `confirmed on-chain (${value.confirmationStatus})`, {
            confirmationStatus: value.confirmationStatus,
          });
        }
        // 'processed' only: executed by one node but not yet voted on, and it
        // can still be dropped on a fork. Keep polling — never record from it.
      }
    } catch (err: any) {
      rpcErrors++;
      noteRpcOutcome(false, err);
      // Deliberately does NOT return. An RPC that will not answer says nothing
      // about the chain; the loop keeps trying and, if it never recovers, the
      // caller gets 'unknown' rather than a fabricated verdict.
      if (rpcErrors === 1 || rpcErrors % 25 === 0) {
        opts.log?.('warn', `RPC error while settling ${txid.slice(0, 8)}… (${rpcErrors} so far): ${err?.message ?? err}`);
      }
    }

    // ---- 2. Can it still land? -------------------------------------------
    // Proving the negative is what makes "no position" a safe decision instead
    // of a guess. Only consulted when we were given the blockhash.
    // MINIMUM AGE. Expiry is a claim about a transaction that has had time to
    // land and did not; nothing that young can be declared dead, whatever a
    // lagging bank says. Belt and braces alongside the commitment fix above.
    const oldEnoughToExpire = now() - started >= MIN_AGE_BEFORE_EXPIRY_MS;
    if (opts.blockhash && oldEnoughToExpire && now() - lastBlockhashCheck >= blockhashCheckMs) {
      lastBlockhashCheck = now();
      try {
        // 'confirmed', NOT 'finalized'.
        //
        // The blockhash was fetched at 'confirmed'; the FINALIZED bank lags the
        // confirmed tip by roughly 32 slots (~13s), so a blockhash that is
        // perfectly alive is simply not in the finalized bank yet and
        // isBlockhashValid answers FALSE for the first ~13 seconds of every
        // transaction's life. Two such observations, a poll apart, then
        // declared a live transaction 'expired' about three seconds after
        // submitting it — reporting "nothing happened" about a buy that was on
        // its way to landing, which is the very failure this module exists to
        // stop, produced by the check meant to prevent it.
        const valid = await withTimeout(
          connection.isBlockhashValid(opts.blockhash, { commitment: 'confirmed' }),
          RPC_CALL_TIMEOUT_MS, 'isBlockhashValid');
        const stillValid = typeof valid === 'boolean' ? valid : valid?.value;
        if (stillValid === false) {
          if (sawExpiredOnce) {
            return done('expired',
              `blockhash expired with no signature status — the transaction can no longer land, so nothing happened`);
          }
          sawExpiredOnce = true;
        } else if (stillValid === true) {
          sawExpiredOnce = false;
        }
      } catch (err: any) {
        rpcErrors++;
        // Unreadable blockhash validity is not evidence of anything.
      }
    }

    // ---- 3. Is someone waiting on this queue? ----------------------------
    // Checked LAST, so a poll and an expiry check always precede it: whatever
    // the chain was ready to tell us, we have already heard.
    if (opts.yieldWhen?.()) {
      return done('unknown',
        `still unresolved after ${Math.round((now() - started) / 1000)}s and something is waiting on `
        + `this mint — releasing the queue and reconciling this signature in the background`,
        { yielded: true });
    }

    await sleep(pollMs);
  }

  return done('unknown',
    rpcErrors > 0
      ? `no answer after ${Math.round((now() - started) / 1000)}s and ${rpcErrors} RPC errors — `
        + `the node would not tell us whether this landed. Treat the position as UNPROVEN.`
      : `no answer after ${Math.round((now() - started) / 1000)}s — the signature never reached a `
        + `confirmed status and expiry could not be proven. Treat the position as UNPROVEN.`);
}

/**
 * Did this outcome move money into a position?
 *
 * The single predicate every caller should use instead of re-deriving the rule.
 * 'unknown' answers false: an unproven trade must never be booked as a fill.
 */
export function didLand(outcome: SettlementOutcome): boolean {
  return outcome === 'landed';
}

/**
 * Is this outcome a PROVEN non-event — nothing to track, nothing to reconcile?
 *
 * 'unknown' answers false, which is the important half: it is the only outcome
 * that must be neither booked nor forgotten.
 */
export function provablyDidNothing(outcome: SettlementOutcome): boolean {
  return outcome === 'reverted' || outcome === 'slippage' || outcome === 'expired';
}
