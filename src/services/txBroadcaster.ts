import type { Connection } from '@solana/web3.js';

/**
 * SUBMIT THE SAME SIGNED TRANSACTION DOWN SEVERAL ROUTES AT ONCE.
 *
 * WHY THIS IS SAFE — and it is the only thing about this file that matters, so
 * it goes first. A Solana transaction's identity is its signature. Every node
 * and every relay dedupes on it. Sending identical signed bytes to five places
 * cannot execute twice, cannot double-spend and cannot produce two positions;
 * the cluster accepts exactly one and discards the rest. This is the same
 * property `rebroadcastUntilSettled` already relies on to resend a percentage
 * SELL without selling twice. Nothing here re-signs, re-builds, or varies a
 * blockhash — if it did, that property would be gone and this would be a
 * double-spend machine.
 *
 * WHY IT HELPS. The engine had exactly one Connection and one
 * `sendRawTransaction`. That single call is a bet that one endpoint is healthy,
 * unthrottled, and well-connected to the current leader at this instant. When
 * that bet loses, the transaction is not slow — it is absent, and the operator
 * sees "expired" with no explanation. Fanning out converts a single point of
 * failure into a race where the first route to reach the leader wins.
 *
 * This does NOT make an individual send faster. The win is in the tail: the
 * cases where one route is rate-limited, one is mid-reconnect, and one is fine.
 *
 * WHAT IT COSTS. Nothing. Every route is an endpoint the process is already
 * configured with, and a duplicate send of ~1.2KB is not a meaningful request
 * against any rate limit worth caring about.
 *
 * WHAT IT IS NOT. It is not Helius Sender, not a staked connection, and not
 * ShredStream. Those need a paid plan and would beat this comfortably. This is
 * what is available for free.
 */

/**
 * How long the whole fan-out may take before the caller is released.
 *
 * 8 seconds, chosen against what the send is actually racing: a blockhash lives
 * ~60-90s and the settlement window is 75s, so a send still unacknowledged
 * after 8s has already lost most of its value — while the cost of waiting is a
 * pinned per-mint queue and a held concurrency slot. web3.js supplies no bound
 * of its own here (undici's default is a 300s headers timeout), and
 * `connectionConfig()` deliberately leaves `disableRetryOnRateLimit: false`, so
 * a rate-limited route sleeps through several internal retries before it even
 * fails. That is the exact shape this ceiling exists to cut short.
 */
export const BROADCAST_DEADLINE_MS = 8_000;

export interface BroadcastRoute {
  /** Shown in logs and in the per-route result. */
  name: string;
  send: (raw: Uint8Array) => Promise<string>;
}

export interface BroadcastOutcome {
  /** The signature, which is identical across every route by construction. */
  txid: string;
  /** The route whose send resolved first. Diagnostic only. */
  winner: string;
  /** Every route's fate, for the log line and the health counters. */
  results: Array<{ name: string; ok: boolean; ms: number; error?: string }>;
  /** How many routes were tried. */
  attempted: number;
}

/**
 * Send to every route concurrently and resolve as soon as ONE succeeds.
 *
 * Deliberately not `Promise.any`: we want the losing routes' outcomes for the
 * log and the RPC health counters, and `Promise.any` discards them. The losers
 * keep running to completion in the background — their sends are still useful,
 * because a route that answers 200ms later may be the one whose node had the
 * leader connection.
 *
 * `expectedTxid` is the signature computed from the signed bytes BEFORE any
 * send. It is what gets returned, so the caller has the right signature even if
 * every route throws after the node accepted the transaction — the lost-response
 * case that used to leave an order on-chain with nothing tracking it.
 */
export async function broadcast(
  raw: Uint8Array,
  expectedTxid: string,
  routes: readonly BroadcastRoute[],
  opts: {
    onResult?: (r: { name: string; ok: boolean; ms: number; error?: string }) => void;
    /** Hard ceiling on the whole fan-out. See BROADCAST_DEADLINE_MS. */
    deadlineMs?: number;
  } = {}
): Promise<BroadcastOutcome> {
  if (routes.length === 0) throw new Error('broadcast called with no routes');

  const deadlineMs = opts.deadlineMs ?? BROADCAST_DEADLINE_MS;
  const results: BroadcastOutcome['results'] = [];
  let winner: string | null = null;
  let firstError: unknown = null;
  let settled = 0;

  return await new Promise<BroadcastOutcome>((resolve, reject) => {
    let done = false;

    const finishOk = (name: string) => {
      if (done) return;
      done = true;
      winner = name;
      clearTimeout(timer);
      resolve({ txid: expectedTxid, winner: name, results: [...results], attempted: routes.length });
    };

    const finishFail = (err: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err ?? 'every send route failed')));
    };

    // THE DEADLINE. Without it a route that never settles leaves this promise
    // pending forever — and this await sits inside the copy trader's per-mint
    // trade queue, between `inFlightBuyCount++` and the finally that releases
    // it. One blackholed TCP connection to a public endpoint would therefore
    // pin a mint's queue (so a leader's flip-sell never runs), hold a
    // concurrency slot, and hold a governor reservation, for the life of the
    // process. Nothing else in this codebase makes an unbounded RPC call: the
    // settlement loop wraps every one at 12s, and refreshWalletBalanceIfOwed
    // bounds a mere BALANCE READ at 1500ms for exactly this reason. The call
    // that actually spends money cannot be the one exception.
    //
    // Reaching the deadline is NOT "nothing was sent". The bytes went to every
    // route; we simply have no acknowledgement. The caller already treats a
    // throwing send as possibly-landed (it holds the signature computed before
    // sending and hands it to resolveOrphanedSubmission), so the timeout is
    // reported as an error with that same meaning rather than as a success.
    const timer = setTimeout(() => {
      const names = routes.map(r => r.name).join(', ');
      finishFail(new Error(
        `no send route acknowledged within ${deadlineMs}ms (${names}). The transaction may still have been `
        + `accepted — its signature is known and it is treated as unresolved, not as never-sent.`));
    }, deadlineMs);
    // NOT unref'd, deliberately. An unref'd timer does not keep the event loop
    // alive, so if this send were the only pending work the process would exit
    // before the deadline fired and the promise would never settle at all —
    // which is the exact failure this timer exists to prevent, reintroduced by
    // the timer itself. (Found by mutation-testing: with unref, the proof for
    // this deadline exited 0 without running, and every mutation "passed".)
    // Telemetry timers are unref'd because nobody should wait on them; this one
    // guards money in flight and is worth 8 seconds of process lifetime.

    for (const route of routes) {
      const startedAt = Date.now();
      // Each route is isolated: one throwing must not reject the others'
      // promises or the whole fan-out collapses to the reliability of its
      // worst member.
      void (async () => {
        try {
          await route.send(raw);
          const r = { name: route.name, ok: true, ms: Date.now() - startedAt };
          results.push(r);
          opts.onResult?.(r);
          finishOk(route.name);
        } catch (err: any) {
          const r = { name: route.name, ok: false, ms: Date.now() - startedAt, error: String(err?.message ?? err) };
          results.push(r);
          opts.onResult?.(r);
          if (firstError === null) firstError = err;
        } finally {
          settled++;
          // Only reject once EVERY route has failed. A single failure means
          // nothing when four others are still in flight.
          if (settled === routes.length) finishFail(firstError);
        }
      })();
    }
  });
}

/**
 * NO JITO ROUTE HERE, DELIBERATELY.
 *
 * Jito-Solana runs under the large majority of Solana's stake, so its block
 * engine is the obvious next route to add — but a transaction submitted to it
 * WITHOUT a tip instruction is not prioritised. Shipping a "jito" route that
 * cannot be tipped would be a name that does not do what it says, which this
 * codebase already has a tombstone for:
 *
 *     // jitoTipSol is GONE (2026-08-13). It was a number in the config, a field
 *     // in the type and an input in the UI, connected to nothing — there is no
 *     // Jito path in this codebase. It comes back when a bundle path does.
 *
 * A real Jito route means adding a tip transfer to the transaction, which the
 * pre-sign intent guard must then be taught to allow — a SystemProgram transfer
 * to a non-venue account is exactly what that guard exists to refuse, and
 * loosening it is a security decision, not a latency one. That work belongs in
 * its own change with its own proofs. Until then this file fans out across the
 * RPC endpoints the process already has, which is free and real.
 */

/**
 * Build the route list from the endpoints this process already has.
 *
 * The primary connection is always first in the array — not because order
 * decides the winner (they all start in the same tick) but because it is the
 * one whose failures should drive the RPC health counters, and the caller
 * distinguishes it by name.
 */
export function buildRoutes(params: {
  primary: Connection;
  primaryName: string;
  fallback?: Connection | null;
  fallbackName?: string;
}): BroadcastRoute[] {
  const routes: BroadcastRoute[] = [{
    name: params.primaryName,
    send: (raw) => params.primary.sendRawTransaction(raw, { skipPreflight: true }),
  }];

  if (params.fallback) {
    routes.push({
      name: params.fallbackName || 'fallback',
      // maxRetries 0 on the secondary: the primary's own retry already covers
      // the "keep pushing" job, and a second endpoint retrying in parallel is
      // wasted request budget on a shared key.
      send: (raw) => params.fallback!.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
    });
  }

  return routes;
}
