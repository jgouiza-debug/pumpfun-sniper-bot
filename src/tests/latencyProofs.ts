/**
 * LATENCY PROOFS — is the copy trader actually in the same trade as the leader?
 *
 *   npx ts-node src/tests/latencyProofs.ts
 *
 * WHY THIS FILE EXISTS. The copy trader's entire value proposition is speed,
 * and the repo had no test — and no runtime measurement — of how fast it was.
 * Worse, the measurement it appeared to have was inert: `latencyTimeline`
 * defines T1-T7 and `executeRealMainnetTrade` stamps T5, T6 and T7 on every
 * order, but `stamp()` is a no-op unless `begin()` opened a record, and
 * `begin()` was only ever called from the sniper's own screening pipeline. A
 * copy trade enters through `executeExternalTrade`, so every one of those
 * stamps was written into a Map with no entry for the mint and dropped on the
 * floor. The dashboard showed timings for launch snipes and nothing at all for
 * the path that runs all day.
 *
 * These proofs pin the two properties that make the new measurement worth
 * trusting:
 *
 *   1. It refuses to report a number it cannot stand behind. An unreadable slot
 *      is not a same-slot landing.
 *   2. The percentiles are nearest-rank over real observations, so a reported
 *      "p90 delta of 2" is a delta that actually happened.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SlotDeltaTracker } from '../services/slotDelta';
import { LatencyTimelineLogger } from '../services/latencyTimeline';
import { clampPriorityFeeSol } from '../services/pipelineUtils';
import { broadcast, buildRoutes, type BroadcastRoute } from '../services/txBroadcaster';
import { fitSlotsToWallet, splitWalletIntoSlots } from '../services/pipelineUtils';
import {
  CONFIRM_WAIT_ALPHA, CONFIRM_WAIT_FRACTION, CONFIRM_WAIT_PRIORITY_FRACTION,
  CONFIRM_WAIT_MIN_MS, CONFIRM_WAIT_MAX_MS,
} from '../services/copyTraderService';
import { breakevenPct } from '../services/paperSimulator';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const sample = (over: Partial<Parameters<SlotDeltaTracker['record']>[0]> = {}) => ({
  mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump',
  leaderSlot: 1_000_000,
  landedSlot: 1_000_002,
  wireMs: 120,
  landMs: 500,
  lane: 'fast' as const,
  ...over,
});

console.log('\n-- The slot delta is the score, and it refuses to guess --');

test('a fill two blocks after the leader is a delta of 2', () => {
  const t = new SlotDeltaTracker();
  const s = t.record(sample());
  assert.ok(s, 'a well-formed sample must be recorded');
  assert.strictEqual(s!.delta, 2);
  assert.strictEqual(t.stats().samples, 1);
});

test('AN UNREADABLE SLOT IS NOT A SAME-SLOT LANDING', () => {
  // `inspectFill` returns slot 0 when it could not read the transaction, and
  // the balance-derived recovery path has no slot at all. Subtracting either
  // from the leader's slot produces a number, and recording that number would
  // flatter the metric in exactly the case where the measurement FAILED —
  // reporting a perfect same-block fill precisely when we learned nothing.
  const t = new SlotDeltaTracker();
  assert.strictEqual(t.record(sample({ landedSlot: 0 })), null, 'a zero landed slot is unknown, not equal');
  assert.strictEqual(t.record(sample({ leaderSlot: 0 })), null, 'a zero leader slot is unknown, not equal');
  assert.strictEqual(t.record(sample({ landedSlot: NaN })), null);
  assert.strictEqual(t.record(sample({ leaderSlot: Infinity })), null);
  assert.strictEqual(t.stats().samples, 0, 'nothing unmeasurable may enter the window');
});

test('landing BEFORE the leader is refused — it means the two numbers disagree', () => {
  const t = new SlotDeltaTracker();
  assert.strictEqual(t.record(sample({ landedSlot: 999_999 })), null);
  assert.strictEqual(t.stats().samples, 0);
});

test('an empty tracker reports no percentiles rather than zeros', () => {
  // Zero is the best possible score. An empty window reporting p50 = 0 would
  // read as "every fill lands in the leader's block" on a bot that has never
  // traded.
  const s = new SlotDeltaTracker().stats();
  assert.strictEqual(s.samples, 0);
  assert.strictEqual(s.slotDelta, null, 'no samples means no percentile, not a perfect one');
  assert.strictEqual(s.wireMs, null);
  assert.strictEqual(s.landMs, null);
});

test('THE PRODUCER EXISTS — the maths is useless about a structure nothing fills', () => {
  // The nine tests above operate on trackers this file constructs and feeds by
  // hand. Deleting the block in the engine that actually calls record() left
  // every one of them green: the suite proved the percentile arithmetic was
  // correct about a window that would be permanently empty, which is the whole
  // of Part A's headline fix removed with nothing noticing.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const calls = engine.split('slotDelta.record(').length - 1;
  assert.strictEqual(calls, 1, `exactly one producer expected, found ${calls}`);

  const idx = engine.indexOf('slotDelta.record(');
  const block = engine.slice(Math.max(0, idx - 400), idx + 500);
  // It has to be fed the two numbers it cannot compute for itself, from the
  // two places they actually come from.
  assert.ok(/leaderSlot: opts\.leaderSlot/.test(block),
    "the leader's slot must come from the signal that started the trade");
  assert.ok(/landedSlot: fill\.slot/.test(block),
    'our slot must come from the fill, which is the only place it is readable');
  // And it must sit behind the fill check, or it records a delta against slot 0.
  assert.ok(/if \(measuringExternal && fill && opts\.leaderSlot\)/.test(block),
    'the producer must require both a fill and a leader slot before recording');

  const reader = engine.split('slotDelta.stats()').length - 1;
  assert.ok(reader >= 1, 'and something must read the stats back out, or nobody sees them');
});

test('the engine opens a copy timeline, or every stamp it makes is discarded', () => {
  // Same failure shape one level down: the LatencyTimelineLogger tests below
  // build their own logger and never touch the engine, so the begin() that
  // makes the engine's stamps land is pinned by nothing behavioural.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  assert.ok(/latencyTimeline\.begin\(mint, \{\s*\n\s*t1ArrivalMs: t1,/.test(engine),
    'the copy path must open a record seeded with the signal arrival time');
  for (const stamp of ['t5BuiltSignedMs', 't6SubmittedMs', 't7ConfirmedMs']) {
    assert.ok(engine.includes(`latencyTimeline.stamp(mint, '${stamp}')`),
      `${stamp} must still be stamped, or the record it opens carries nothing`);
  }
});

console.log('\n-- Percentiles are nearest-rank over things that happened --');

test('p50 and p90 are observed values, never interpolated', () => {
  const t = new SlotDeltaTracker();
  // Deltas 1..10. An interpolating percentile would answer p90 = 9.1 — a slot
  // count that cannot exist.
  for (let i = 1; i <= 10; i++) t.record(sample({ landedSlot: 1_000_000 + i }));
  const s = t.stats();
  assert.strictEqual(s.samples, 10);
  assert.strictEqual(s.slotDelta!.p50, 5);
  assert.strictEqual(s.slotDelta!.p90, 9);
  assert.strictEqual(s.slotDelta!.worst, 10);
  assert.ok(Number.isInteger(s.slotDelta!.p90), 'a slot count must be a whole number');
});

test('same-slot and within-one-slot shares are reported as the headline', () => {
  const t = new SlotDeltaTracker();
  t.record(sample({ landedSlot: 1_000_000 }));   // delta 0
  t.record(sample({ landedSlot: 1_000_001 }));   // delta 1
  t.record(sample({ landedSlot: 1_000_005 }));   // delta 5
  t.record(sample({ landedSlot: 1_000_009 }));   // delta 9
  const s = t.stats();
  assert.strictEqual(s.sameSlotPct, 25);
  assert.strictEqual(s.withinOneSlotPct, 50);
});

test('the fast and slow lanes are reported apart — mixing them hides which is slow', () => {
  const t = new SlotDeltaTracker();
  for (let i = 0; i < 5; i++) t.record(sample({ landedSlot: 1_000_001, lane: 'fast' }));
  for (let i = 0; i < 5; i++) t.record(sample({ landedSlot: 1_000_012, lane: 'slow' }));
  const s = t.stats();
  assert.strictEqual(s.byLane.fast.samples, 5);
  assert.strictEqual(s.byLane.slow.samples, 5);
  assert.strictEqual(s.byLane.fast.p50Delta, 1);
  assert.strictEqual(s.byLane.slow.p50Delta, 12);
  assert.notStrictEqual(s.byLane.fast.p50Delta, s.byLane.slow.p50Delta,
    'the slow lane is expected to be far worse; a combined number would average that away');
});

test('the window is bounded, so the numbers describe now and not an hour ago', () => {
  const t = new SlotDeltaTracker();
  for (let i = 0; i < 500; i++) t.record(sample({ landedSlot: 1_000_001 }));
  assert.ok(t.stats().samples <= 200, `window grew to ${t.stats().samples}`);
});

test('a missing wire/land time does not sink the slot delta', () => {
  // The slot delta is readable even when the millisecond stamps are not (an
  // unresolved settlement, a balance-derived fill). Dropping the whole sample
  // for a missing millisecond would lose the number that matters most.
  const t = new SlotDeltaTracker();
  t.record(sample({ wireMs: null, landMs: null }));
  const s = t.stats();
  assert.strictEqual(s.samples, 1);
  assert.strictEqual(s.slotDelta!.p50, 2);
  assert.strictEqual(s.wireMs, null, 'no millisecond samples means no millisecond percentile');
});

test('the operator line names the cost in curve movement, not in jargon', () => {
  const t = new SlotDeltaTracker();
  const same = t.record(sample({ landedSlot: 1_000_000 }))!;
  assert.ok(/SAME BLOCK/.test(SlotDeltaTracker.describe(same)));
  const behind = t.record(sample({ landedSlot: 1_000_003 }))!;
  const line = SlotDeltaTracker.describe(behind);
  assert.ok(/3 slots behind/.test(line), line);
  assert.ok(/1050ms/.test(line), 'the delta must be translated into time the operator can feel');
});

console.log('\n-- The stamps are no longer written into nothing --');

test('OLD BUG: stamping a mint with no open record silently discards it', () => {
  // The exact shape of the defect. `stamp` looks the mint up and returns
  // quietly when it is absent — correct behaviour for a helper, catastrophic
  // when the only caller on a whole code path never called `begin`.
  const l = new LatencyTimelineLogger();
  l.stamp('NeverBegunMint', 't6SubmittedMs', 12345);
  assert.strictEqual(l.snapshot('NeverBegunMint'), undefined,
    'this is the old copy-trade path: every timing written, none of them kept');
});

test('fixed: a copy buy opens its own record, and the stamps survive', () => {
  const l = new LatencyTimelineLogger();
  l.begin('CopyMint', { t1ArrivalMs: 1_000, mode: 'real', symbol: 'COPY', txType: 'copy-buy' });
  assert.strictEqual(l.isOpen('CopyMint'), true);
  l.stamp('CopyMint', 't6SubmittedMs', 1_120);
  l.stamp('CopyMint', 't7ConfirmedMs', 1_620);
  const t = l.snapshot('CopyMint')!;
  assert.strictEqual(t.t6SubmittedMs! - t.t1ArrivalMs, 120, 'signal → wire');
  assert.strictEqual(t.t7ConfirmedMs! - t.t6SubmittedMs!, 500, 'wire → confirmed');
});

test('the copy path must not clobber a record the sniper already opened', () => {
  // Both engines can be interested in the same mint. Calling begin() a second
  // time resets t1, which would make the sniper's own screening look
  // instantaneous. isOpen() is what the engine checks before opening one.
  const l = new LatencyTimelineLogger();
  l.begin('Shared', { t1ArrivalMs: 500, mode: 'real', symbol: 'SNIPE' });
  assert.strictEqual(l.isOpen('Shared'), true,
    'the engine guards on this before opening a copy record');
  assert.strictEqual(l.snapshot('Shared')!.t1ArrivalMs, 500);
});

test('THE LEAK: an opened copy record is always completed', () => {
  // begin() without complete() leaves the entry in an unbounded Map, in a
  // process meant to run for days, one entry per copy buy. Asserted against the
  // shipped source because the guarantee is structural — it lives in the
  // `finally`, so it must hold on the throw and early-return paths too, and no
  // unit test of a single happy path could prove that.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const openIdx = engine.indexOf('if (measuringExternal && !latencyTimeline.isOpen(mint))');
  assert.ok(openIdx > 0, 'the copy path must open a timeline');
  const completeIdx = engine.indexOf('if (openedTimeline) latencyTimeline.complete(mint);');
  assert.ok(completeIdx > openIdx, 'and must complete it afterwards');

  // COMPLETED ONLY BY THE CALL THAT OPENED IT. `measuringExternal` says only
  // that this is a copy buy — the record may belong to the sniper's screening
  // pipeline for the same mint, and completing one we did not open writes it
  // out mid-flight and deletes it, so the sniper's own record is gone and its
  // wireMs is measured off the copy path's clock.
  assert.ok(/openedTimeline = true;/.test(engine),
    'the opening call must mark itself, or the completion cannot tell whose record it is');
  assert.ok(!/if \(measuringExternal\) latencyTimeline\.complete\(mint\);/.test(engine),
    'completing on measuringExternal alone truncates a record this call did not open');

  // The completion has to be in the finally, not on the success path.
  const finallyIdx = engine.lastIndexOf('} finally {', completeIdx);
  assert.ok(finallyIdx > openIdx && finallyIdx < completeIdx,
    'the completion must sit inside the finally, or a thrown order leaks its record forever');

  // AND THE OPENING HAS TO BE INSIDE THE TRY THAT FINALLY BELONGS TO. It used
  // to sit above the spend governor, whose refusal returns before the try is
  // entered — so every governor-refused copy buy leaked its record and the next
  // buy for that mint inherited a stale t1. This test greped for a `finally`
  // and passed over that leak for a whole commit.
  const tryIdx = engine.lastIndexOf('    try {', openIdx);
  assert.ok(tryIdx > 0 && tryIdx < openIdx,
    'the timeline must be opened INSIDE the try, or an early return skips the completion');
  const govIdx = engine.indexOf('tradeGovernor.tryReserveBuy(');
  assert.ok(govIdx > 0 && govIdx < tryIdx,
    'the governor gate must sit BEFORE that try, which is exactly why the open cannot precede it');
});

test('the fast lane stamps observedAt, or the staleness guard cannot fire on it', () => {
  // Only the slow lane used to set observedAt, so every fast signal reported an
  // age of 0 — including one that had waited in the per-mint trade queue behind
  // a settling buy, which can hold it for up to 75 seconds. The guard that
  // exists to stop us chasing a trade the leader has already left could never
  // fire on the lane that produces most orders.
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  const fastIdx = copy.indexOf('fast: true,');
  assert.ok(fastIdx > 0, 'the fast lane must mark its signals');
  const block = copy.slice(fastIdx, fastIdx + 900);
  assert.ok(/observedAt: Date\.now\(\)/.test(block),
    'a fast signal must carry when it was observed, or it can never be judged stale');
  assert.ok(/leaderSlot: ev\.slot/.test(block),
    'a fast signal must carry the leader\'s slot, or the fill cannot be scored against it');
});

console.log('\n-- The forced balance read happens only when it is owed --');

/**
 * A stand-in for the two facts refreshWalletBalanceIfOwed decides on, so the
 * RULE can be tested without a wallet, a keypair or a socket. The shipped
 * method is four lines around exactly this comparison; the assertions below
 * pin the comparison, and the source check that follows pins that the shipped
 * code still makes it.
 */
function owed(lastBalanceReadAt: number, lastTradeSettledAt: number): boolean {
  return !(lastBalanceReadAt > 0 && lastBalanceReadAt >= lastTradeSettledAt);
}

test('nothing has settled since the last read → no RPC on the hot path', () => {
  // The steady state, and the whole point: a copy buy arriving when the book is
  // quiet used to pay an unconditional 40-200ms round trip inside the per-mint
  // queue, with the leader's fill getting further away the whole time.
  assert.strictEqual(owed(10_000, 9_000), false);
  assert.strictEqual(owed(10_000, 10_000), false, 'a read at the same instant already reflects it');
});

test('THE 2026-08-23 DOUBLE-SPEND: a trade settled after the last read → force it', () => {
  // Two leader buys 4s apart were both sized from the same 8s-cached snapshot.
  // The second overdrafted the gas float and the wallet was left too poor to
  // fund its own exit — the "bot did not sell" session. The forced read is what
  // fixed that, so making it conditional must not make THIS case skip it.
  assert.strictEqual(owed(10_000, 10_001), true, 'a settlement after the read owes a fresh one');
  assert.strictEqual(owed(10_000, 14_000), true);
});

test('a wallet that has never been read is always owed a read', () => {
  // lastCheckedAt is 0 before the first successful balance call and is reset to
  // 0 when the wallet is re-linked. Treating "never read" as "up to date" would
  // size the first buy after a re-link against a balance of zero.
  assert.strictEqual(owed(0, 0), true);
  assert.strictEqual(owed(0, 5_000), true);
});

test('the shipped method still decides on exactly those two facts', () => {
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('public async refreshWalletBalanceIfOwed(');
  assert.ok(idx > 0, 'the conditional refresh must exist');
  const body = engine.slice(idx, idx + 800);
  assert.ok(/this\.wallet\.balanceReadAt\(\)/.test(body), 'it must read when the balance was last fetched');
  assert.ok(/lastRead >= this\.lastTradeSettledAt/.test(body),
    'and compare it against the last settlement — that comparison IS the safety property');
  assert.ok(/return 'cached'/.test(body), 'and skip the RPC when nothing is owed');
  // Bounded, for the same reason the unconditional read was: a hung socket must
  // not pin the mint's trade queue while a flip-sell waits behind the buy.
  assert.ok(/budgetMs/.test(body), 'the forced read must stay bounded');
});

test('every settlement marks the balance stale, whatever the outcome', () => {
  // A landed trade moved SOL; a reverted or slippage-rejected one still burned
  // its fee. Stamping only on success would let a wallet drained by a run of
  // failed buys keep reporting its pre-trade balance.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const lines = engine.split('\n');
  // UNCONDITIONAL. Asserted on the whole line, not on a substring: `if (cond)
  // this.lastTradeSettledAt = ...` contains the same text and would satisfy a
  // substring check while marking the balance stale on only some outcomes.
  const stampLines = lines
    .map((l, i) => ({ i, t: l.trim() }))
    .filter(x => x.t.includes('lastTradeSettledAt = Date.now()'));
  assert.ok(stampLines.length >= 2,
    'the balance must be marked stale on the verdict path AND on the throw path');

  // (a) The verdict path: unconditional, and immediately after the verdict, so
  // it covers a reverted or slippage-rejected trade — both burned their fee.
  const confirmIdx = lines.findIndex(l => l.includes('const confirmed = await this.confirmTransaction('));
  assert.ok(confirmIdx >= 0, 'the settlement verdict must exist');
  const afterVerdict = stampLines.find(x => x.i > confirmIdx);
  assert.ok(afterVerdict, 'a stamp must follow the verdict');
  assert.strictEqual(afterVerdict!.t, 'this.lastTradeSettledAt = Date.now();',
    'the verdict stamp must be unconditional — a guard means some outcomes leave the cached '
    + 'balance looking fresh when the fee has already been burned');
  const between = lines.slice(confirmIdx, afterVerdict!.i).join('\n');
  assert.ok(!/if \(confirmed ===/.test(between),
    'no outcome branch may sit between the verdict and the stamp');

  // (b) THE THROW PATH. A throw between signing and the verdict skips (a)
  // entirely — and the catch above it says the transaction "may be ON CHAIN
  // even though the call that sent it threw", which is why it starts
  // resolveOrphanedSubmission. Leaving the balance looking fresh there is the
  // 2026-08-23 double-spend shape. Guarded on signedTxid, because an order
  // refused before signing spent nothing.
  const guarded = stampLines.find(x => /^if \(signedTxid\) this\.lastTradeSettledAt = Date\.now\(\);$/.test(x.t));
  assert.ok(guarded, 'a signed-but-unresolved order must also mark the balance stale, guarded on signedTxid');
  // It has to be in THIS function's finally — located by walking back from the
  // stamp rather than by taking the file's first `} finally {`, which belongs
  // to an unrelated function hundreds of lines earlier. (That is exactly the
  // mistake the first version of this assertion made.)
  const finallyIdx = lines.slice(0, guarded!.i).map(l => l.trim()).lastIndexOf('} finally {');
  assert.ok(finallyIdx > confirmIdx,
    'the guarded stamp must sit in the finally of the function that sent the transaction');
  const fnEndIdx = lines.slice(0, guarded!.i).map(l => l.trim()).lastIndexOf('private async executeRealMainnetTrade(');
  void fnEndIdx;
  // Nothing may return between the finally opening and the stamp, or a path
  // through the finally still skips it.
  // Comments stripped first. The block between them explains WHY the release
  // runs on "every exit path — return, throw, or fall-through", and matching
  // that prose would fail correct code — which is precisely the "regex matches
  // a comment rather than the code" trap this file is being audited for.
  const gap = lines.slice(finallyIdx, guarded!.i)
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  assert.ok(!/\breturn\b/.test(gap),
    `no early return may sit between the finally and the stamp; found:\n${gap}`);
});

console.log('\n-- The dashboard is not allowed to sit on the trading path --');

test('emitChange defers — it never calls listeners on the caller\'s stack', () => {
  // The call site that matters is the Helius log notification handler, which
  // ran this on every notification that repriced an open position, BEFORE
  // handleFastLog decided whether to buy. Each listener rebuilds the whole copy
  // status (config, every wallet, 60 history rows, 80 feed rows, every open
  // position) and serializes it to JSON, per connected client — real work, on
  // the one path whose entire purpose is to be fast.
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  const idx = copy.indexOf('private emitChange(): void {');
  assert.ok(idx > 0, 'emitChange must exist');
  const body = copy.slice(idx, copy.indexOf('\n  }', idx));
  assert.ok(/setTimeout\(/.test(body),
    'emitChange must schedule, not iterate — a synchronous loop here is a full status '
    + 'serialization per client in front of the buy decision');
  assert.ok(!/for \(const listener of this\.changeListeners\)/.test(body),
    'the listener loop must live in the deferred flush, not in emitChange itself');
  assert.ok(/unref/.test(body),
    'a timer for a browser tab must never keep a trading process alive');
});

test('the coalesce window stays under the server\'s own SSE gap', () => {
  // This exists to keep work off the notification handler, not to make the UI
  // staler. If it ever exceeded the server's SSE_MIN_GAP_MS it would become the
  // binding constraint on dashboard freshness, which is not its job.
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  const copyMs = Number(/COPY_EMIT_COALESCE_MS = (\d+)/.exec(copy)?.[1]);
  const serverMs = Number(/SSE_MIN_GAP_MS = (\d+)/.exec(server)?.[1]);
  assert.ok(Number.isFinite(copyMs) && Number.isFinite(serverMs), 'both windows must be declared as constants');
  assert.ok(copyMs <= serverMs,
    `the copy coalesce (${copyMs}ms) must not exceed the server's SSE gap (${serverMs}ms)`);
});

console.log('\n-- The priority fee is no longer pinned, and small stakes are still safe --');

test('OLD BUG: ceiling == floor made the whole dynamic-fee mechanism inert', () => {
  // priorityFeeSol and maxPriorityFeeSol were both 0.001. priorityFeeService
  // sampled the p75 of real contention on the pump.fun program, computed a
  // number, and clampPriorityFeeSol threw it away because the ceiling it had to
  // fit under WAS the floor. Reproduced with the shipped clamp.
  const pinned = clampPriorityFeeSol(0.004 /* what the sampler said */, 0.001, 0.001, 0.5);
  assert.strictEqual(pinned, 0.001, 'with ceiling == floor no computed fee can ever be paid');
});

test('fixed: with a real ceiling, a contended slot can actually be paid for', () => {
  const paid = clampPriorityFeeSol(0.004, 0.001, 0.01, 0.5);
  assert.strictEqual(paid, 0.004, 'the sampled fee is now what gets paid');
});

test('THE SMALL-WALLET PROTECTION: 5% of position binds before the ceiling does', () => {
  // This is why raising the ceiling is safe. The old comment worried that a
  // variable fee "on a 0.02 SOL slice is a quarter of the position in fees" —
  // but the clamp already caps a fee at 5% of the position, and on that slice
  // 5% IS the floor, so the fee stays pinned however high the ceiling goes.
  for (const ceiling of [0.01, 0.05, 1]) {
    const onTinySlice = clampPriorityFeeSol(0.02, 0.001, ceiling, 0.02);
    assert.strictEqual(onTinySlice, 0.001,
      `a 0.02 SOL slice must still pay the floor with a ${ceiling} ceiling — the position cap is the protection`);
  }
});

test('the ceiling binds on the stakes where paying to land is worth it', () => {
  // Above roughly 0.2 SOL the 5% cap stops being the binding constraint and the
  // operator's stated ceiling takes over, which is the intended shape.
  assert.strictEqual(clampPriorityFeeSol(0.05, 0.001, 0.01, 0.5), 0.01, 'ceiling binds on a large stake');
  assert.strictEqual(clampPriorityFeeSol(0.05, 0.001, 0.01, 0.1), 0.005, '5% binds on a small one');
});

test('sizing budgets exactly what execution can pay, never more', () => {
  // Sizing used to budget the bare ceiling. Now the ceiling is 10x the floor,
  // that would over-reserve on a small slice — where execution can never
  // actually pay it — and refuse trades the wallet could afford: the same
  // "safety limit becomes an outage" shape the pinned ceiling itself had. The
  // fix is that sizing runs the ceiling through the SAME clamp, so the two
  // cannot drift.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('private sizingPriorityFee(');
  assert.ok(idx > 0, 'the sizing fee helper must exist');
  const body = engine.slice(idx, idx + 600);
  assert.ok(/clampPriorityFeeSol\(/.test(body),
    'sizing must use the execution clamp, not re-derive the worst case with its own arithmetic');
  assert.ok(/stakeSol/.test(body), 'and it must be told the stake, or the position cap cannot apply');
});

test('the shipped defaults leave the ceiling above the floor', () => {
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const floor = Number(/^\s*priorityFeeSol: ([\d.]+),/m.exec(engine)?.[1]);
  const ceiling = Number(/^\s*maxPriorityFeeSol: ([\d.]+),/m.exec(engine)?.[1]);
  assert.ok(Number.isFinite(floor) && Number.isFinite(ceiling), 'both defaults must be declared');
  assert.ok(ceiling > floor,
    `ceiling ${ceiling} must exceed floor ${floor} — equal values re-pin the fee and make dynamicPriorityFee inert again`);
  // Inside clampConfig's accepted band, or updateConfig would silently rewrite it.
  assert.ok(ceiling <= 0.05, 'the default must sit inside the config band [0, 0.05]');
});

console.log('\n-- The local builder: cheaper per build, and a blockhash with life left --');

const builderSrc = () => readFileSync(join(__dirname, '..', 'services', 'localTxBuilder.ts'), 'utf8');

test('OLD BUG: a build could carry a blockhash with none of its life left', () => {
  // A blockhash is valid for ~150 slots (~60-90s). The refresher ran every 20s
  // and a build refused only past 60s, so a transaction could be signed against
  // one that had already spent its whole window. That does not fail loudly — it
  // simply never lands, and settlement reports 'expired' some seconds later. A
  // missed fill with no error attached to it.
  const src = builderSrc();
  const refresh = Number(/BLOCKHASH_REFRESH_MS = ([\d_]+)/.exec(src)?.[1].replace(/_/g, ''));
  const maxAge = Number(/BLOCKHASH_MAX_AGE_MS = ([\d_]+)/.exec(src)?.[1].replace(/_/g, ''));
  assert.ok(Number.isFinite(refresh) && Number.isFinite(maxAge), 'both must be named constants');

  // A blockhash's shortest realistic life. The bar has to leave most of it for
  // the send, the paced rebroadcast and the confirmation poll.
  const SHORTEST_BLOCKHASH_LIFE_MS = 60_000;
  assert.ok(maxAge <= SHORTEST_BLOCKHASH_LIFE_MS / 2,
    `a build may not use a blockhash older than half its shortest life; bar is ${maxAge}ms`);
  assert.ok(refresh * 2 <= maxAge,
    `the refresher (${refresh}ms) must cycle well inside the staleness bar (${maxAge}ms), or the bar is reachable in normal operation`);
});

test('the staleness bar is actually consulted on both build paths', () => {
  const src = builderSrc();
  const uses = [...src.matchAll(/blockhashFetchedAt > BLOCKHASH_MAX_AGE_MS/g)];
  assert.strictEqual(uses.length, 2, 'both the buy and the sell build must refuse a stale blockhash');
  assert.ok(!/blockhashFetchedAt > \d/.test(src),
    'no hardcoded staleness bar may survive next to the constant — that is how the two drift apart');
});

test('the token program is memoised, but only when the answer was real', () => {
  // A mint account's owner is fixed at creation, so this was one
  // guaranteed-identical getAccountInfo per build on the buy path. Caching a
  // NULL would be the dangerous version: null can mean "the RPC would not
  // answer", and remembering that strands a tradable mint on the fallback path
  // for the life of the process.
  const src = builderSrc();
  const idx = src.indexOf('private async getTokenProgram(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  }', src.indexOf('catch', idx)));
  assert.ok(/tokenProgramCache\.get\(/.test(body), 'it must consult a cache');
  const setIdx = body.indexOf('tokenProgramCache.set(');
  assert.ok(setIdx > 0, 'it must populate the cache');
  // The set must sit inside the branch that proved the owner is a token program.
  const beforeSet = body.slice(0, setIdx);
  assert.ok(/owner\.equals\(TOKEN_PROGRAM\) \|\| owner\.equals\(TOKEN_2022_PROGRAM\)/.test(beforeSet),
    'only a verified token-program owner may be cached — never a null or an unknown owner');
  assert.ok(/TOKEN_PROGRAM_CACHE_MAX/.test(body),
    'the cache must be bounded: a map keyed by mint, in a process that sees thousands of new tokens a day, is a leak');
});

test('the same bytes are not simulated twice on the buy path', () => {
  // buildBuy/buildSell simulate in order to CHOOSE the fee recipient and the
  // sell form, so the transaction they return has already been proven. The
  // engine re-simulating it was a second full RPC round trip on the hot path —
  // and it is those extra round trips that got local building demoted after it
  // rate-limited a shared Helius key.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('const sim = built.simulated');
  assert.ok(idx > 0, 'the engine must skip a simulation the builder already performed');
  const block = engine.slice(idx, idx + 220);
  assert.ok(/await localTxBuilder\.simulateOk\(built\.tx\)/.test(block),
    'and must still simulate a build that does NOT claim to have been — fail closed');
});

console.log('\n-- One send was a bet on one endpoint being healthy right now --');

const asyncTests: Array<{ name: string; fn: () => Promise<void> }> = [];
function atest(name: string, fn: () => Promise<void>): void { asyncTests.push({ name, fn }); }

const TXID = 'SigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const route = (name: string, behaviour: { ms?: number; fail?: string }): BroadcastRoute => ({
  name,
  send: async () => {
    await new Promise(r => setTimeout(r, behaviour.ms ?? 0));
    if (behaviour.fail) throw new Error(behaviour.fail);
    return TXID;
  },
});

atest('the first route to answer wins, and the signature is the one we signed', async () => {
  const out = await broadcast(new Uint8Array([1]), TXID, [
    route('slow', { ms: 60 }),
    route('fast', { ms: 1 }),
  ]);
  assert.strictEqual(out.winner, 'fast');
  // The signature comes from the SIGNED BYTES, never from a route's reply. A
  // node can accept a transaction and then lose the response; taking the id
  // from the reply is how an order lands with nothing tracking it.
  assert.strictEqual(out.txid, TXID);
  assert.strictEqual(out.attempted, 2);
});

atest('ONE FAILING ROUTE DOES NOT FAIL THE SEND', async () => {
  // The whole point. Previously a single throw from a single endpoint meant the
  // transaction was never submitted at all.
  const out = await broadcast(new Uint8Array([1]), TXID, [
    route('rate-limited', { ms: 1, fail: '429 Too Many Requests' }),
    route('healthy', { ms: 20 }),
  ]);
  assert.strictEqual(out.winner, 'healthy');
});

atest('only when EVERY route fails does the send fail', async () => {
  await assert.rejects(
    () => broadcast(new Uint8Array([1]), TXID, [
      route('a', { ms: 1, fail: 'boom a' }),
      route('b', { ms: 5, fail: 'boom b' }),
    ]),
    /boom/,
  );
});

atest('a slow failure does not delay a fast success', async () => {
  // If the fan-out waited for every route, its latency would be the worst
  // member's rather than the best's — worse than the single send it replaced.
  const startedAt = Date.now();
  const out = await broadcast(new Uint8Array([1]), TXID, [
    route('sluggish', { ms: 200, fail: 'timeout' }),
    route('quick', { ms: 1 }),
  ]);
  assert.strictEqual(out.winner, 'quick');
  assert.ok(Date.now() - startedAt < 150, 'the winner must resolve without waiting on the losers');
});

atest('every route reports its outcome, for the log and the health counters', async () => {
  const seen: string[] = [];
  await broadcast(new Uint8Array([1]), TXID, [
    route('primary', { ms: 1 }),
    route('secondary', { ms: 2, fail: 'nope' }),
  ], { onResult: r => seen.push(`${r.name}:${r.ok}`) });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(seen.includes('primary:true'), 'the winner must be reported');
  assert.ok(seen.includes('secondary:false'),
    'a loser must be reported too — Promise.any would discard exactly the failures worth counting');
});

atest('A HUNG ROUTE CANNOT PIN THE SEND FOREVER', async () => {
  // The defect this replaces: broadcast rejected only at
  // `settled === routes.length`, so a route that never settles left the promise
  // pending indefinitely. That await sits inside the copy trader's per-mint
  // trade queue, between inFlightBuyCount++ and the finally that releases it —
  // so one blackholed TCP connection would pin a mint's queue (a leader's
  // flip-sell never runs), hold a concurrency slot and hold a governor
  // reservation for the life of the process. Nothing else here makes an
  // unbounded RPC call; the one that spends money cannot be the exception.
  const never: BroadcastRoute = { name: 'blackholed', send: () => new Promise(() => {}) };
  const startedAt = Date.now();
  await assert.rejects(
    () => broadcast(new Uint8Array([1]), TXID, [route('primary', { ms: 5, fail: '503' }), never], { deadlineMs: 150 }),
    /within 150ms/,
  );
  assert.ok(Date.now() - startedAt < 1000, 'the caller must be released at the deadline');
});

atest('the deadline does not claim the transaction was never sent', async () => {
  // The bytes went to every route; only the acknowledgement is missing. The
  // caller already holds the signature computed before sending and treats a
  // throwing send as possibly-landed, so the message must not tell it
  // otherwise.
  const never: BroadcastRoute = { name: 'blackholed', send: () => new Promise(() => {}) };
  await assert.rejects(
    () => broadcast(new Uint8Array([1]), TXID, [never], { deadlineMs: 100 }),
    (e: Error) => /may still have been accepted/.test(e.message),
  );
});

atest('a slow LOSER does not delay the all-fail verdict past the deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => broadcast(new Uint8Array([1]), TXID, [
      route('fast-fail', { ms: 5, fail: 'boom' }),
      route('slow-fail', { ms: 5_000, fail: 'timeout' }),
    ], { deadlineMs: 120 }),
  );
  assert.ok(Date.now() - startedAt < 800,
    'the old code waited for the WORST route before surfacing the primary failure');
});

atest('no routes at all is an error, never a silent no-op', async () => {
  await assert.rejects(() => broadcast(new Uint8Array([1]), TXID, []), /no routes/);
});

test('two routes to the same endpoint is one bet placed twice, not a fan-out', () => {
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('private rebuildSecondaryConnection(');
  assert.ok(idx > 0, 'the secondary connection must be built somewhere');
  // Sliced to the END of the method, not a fixed byte count — a window that
  // clipped the guard would fail correct code, and worse, a window that
  // happened to contain it would keep passing after the guard moved.
  const end = engine.indexOf('private rebindConnection(', idx);
  assert.ok(end > idx, 'the method must be followed by rebindConnection');
  const body = engine.slice(idx, end);
  assert.ok(/host === primaryHost/.test(body),
    'the secondary must refuse to duplicate the primary endpoint, compared by HOST — a string '
    + 'compare passes the same endpoint differing only by a trailing slash or a query string');
});

test('the secondary is rebuilt every time the primary changes', () => {
  // A failover that swaps the primary to the fallback URL, leaving the
  // secondary pointed at that same fallback, silently collapses the fan-out.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const rebuilds = engine.split('this.rebuildSecondaryConnection(').length - 1;
  const primaryAssignments = engine.split('this.solanaConnection = new Connection(').length - 1;
  assert.ok(rebuilds >= primaryAssignments,
    `every place that sets the primary connection (${primaryAssignments}) must also rebuild the secondary (${rebuilds} found)`);
});

test('only the primary route drives RPC failover', () => {
  // A public fallback being rate-limited says nothing about the endpoint the
  // session depends on. Counting its failures would fail the session over on
  // the health of a route it only uses as a spare.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('onResult: (r) => {');
  assert.ok(idx > 0, 'the broadcast must report per-route outcomes');
  const end = engine.indexOf('const txid = sent.txid;', idx);
  assert.ok(end > idx, 'the callback must be followed by the send result being read');
  const body = engine.slice(idx, end);
  assert.ok(/r\.name !== 'primary'\) return;/.test(body),
    'only the primary route may feed noteRpcOutcome');
  // AND a single send may not declare the credential dead. rpcHealth latches
  // credentialRejected on a 401/403-shaped message and maybeFailoverRpc acts on
  // that latch with no streak requirement, so one proxy hiccup on one
  // submission would demote the whole session to the public endpoint.
  assert.ok(/isCredentialError\(/.test(body),
    'a credential-shaped send failure must be recognised and downgraded');
  assert.ok(/noteRpcOutcome\(false, new Error\('send route rejected the request'\)\)/.test(body),
    'and reported as an ordinary transient failure, not as a dead key');
});

console.log('\n-- The fee ceiling cannot be paid against a position that is not there --');

test('A COPY EXIT IS CAPPED AGAINST ITS OWN BAG, not the sniper\'s configured unit', () => {
  // The copy trader sells with the amount in `pctParam`, so the SOL argument is
  // only a sizing hint — and it was passing 0, which fell back to
  // config.buyAmountSol (0.6 by default). clampPriorityFeeSol then computed its
  // 5%-of-position cap as 0.03 SOL and never bound, so a 0.02 SOL copy bag
  // could bid the full ceiling on each of its six exit attempts. The 5% cap is
  // the ENTIRE safety argument for raising the ceiling, and this was the one
  // path where it did not apply.
  const BAG = 0.02;
  assert.strictEqual(clampPriorityFeeSol(0.01, 0.001, 0.01, 0.6), 0.01, 'the old fallback bid the ceiling');
  assert.strictEqual(clampPriorityFeeSol(0.01, 0.001, 0.01, BAG), 0.001, 'the real bag is capped to the floor');

  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  assert.ok(/executeExternalTrade\(\s*'sell', pos\.mint, pos\.investedSol \|\| 0,/.test(copy),
    'the copy exit must pass its real position size, as the sniper\'s own exits always have');
});

test('an UNKNOWN position size falls to the floor, never to a borrowed one', () => {
  // Belt and braces: even if a caller passes 0 again, a sell must not borrow
  // the sniper's unit. Bidding a ceiling sized for a position we cannot see is
  // exactly the mistake above.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('const sizingPosition = solAmount > 0');
  assert.ok(idx > 0, 'the sizing position must be resolved explicitly');
  const body = engine.slice(idx, idx + 200);
  assert.ok(/action === 'buy' \? this\.config\.buyAmountSol : 0/.test(body),
    'only a BUY may fall back to the configured unit; a sell with no size gets the floor');
  assert.strictEqual(clampPriorityFeeSol(0.01, 0.001, 0.01, 0), 0.001);
});

test('COPY SIZING BUDGETS WHAT IT CAN PAY, not the bare ceiling', () => {
  // getSizingPriorityFeeSol() with no stake returns the unclamped worst case —
  // right for a RESERVE (under-reserving exit gas is what stranded positions on
  // 2026-08-23) and wrong for SIZING. Budgeting 0.01 per slot on a 0.2 SOL
  // wallet with 5 slots sets aside a quarter of the wallet for fees the clamp
  // would cap at the floor, shrinking or killing every copy buy on exactly the
  // wallets the position cap already protects.
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  // Multiline-aware: one of these calls spans two lines, and a line-based
  // pattern silently skipped it — which would have let a sizing site go back to
  // the bare ceiling with this test still green.
  const calls = [...copy.matchAll(/getSizingPriorityFeeSol\(([\s\S]*?)\)/g)]
    .map(m => ({ arg: m[1].trim(), at: m.index ?? 0 }));
  assert.ok(calls.length >= 3, `expected three sizing-fee calls, found ${calls.length}`);

  for (const c of calls) {
    // The exit-gas RESERVE is deliberately unclamped and must stay that way:
    // under-reserving exit gas is what stranded positions on 2026-08-23, so
    // the conservative worst case is the right answer there.
    const context = copy.slice(Math.max(0, c.at - 40), c.at);
    if (/copyExitGasReserveSol\($/.test(context.trim() + '(')  || /copyExitGasReserveSol\(/.test(context)) {
      assert.strictEqual(c.arg, '', 'the exit-gas reserve must keep the unclamped worst case');
      continue;
    }
    assert.ok(c.arg.length > 0,
      'a sizing call site must pass a stake basis, or the 5%-of-position cap cannot apply');
  }
  // And whatever basis they pass must be derived from the slot count rather
  // than being some other number that happens to be in scope.
  assert.ok(/const slotBasisSol = deployableSol \/ Math\.max\(1, Math\.floor\(this\.config\.maxOpenPositions\)\)/.test(copy),
    'the pre-queue basis must be one slot of the deployable balance');
  assert.ok(/getSizingPriorityFeeSol\(\s*\n?\s*deployableSol \/ Math\.max\(1, Math\.floor\(this\.config\.maxOpenPositions\)\)\)/.test(copy),
    'and so must the in-queue one');

  // And the engine must honour a stake when given one.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('public getSizingPriorityFeeSol(');
  assert.ok(idx > 0);
  assert.ok(/getSizingPriorityFeeSol\(stakeSol\?: number\)/.test(engine.slice(idx, idx + 120)),
    'the public helper must accept a stake');
  assert.ok(/return this\.sizingPriorityFee\(stakeSol\)/.test(engine.slice(idx, idx + 200)),
    'and pass it through to the clamp');
});

console.log('\n-- The funded slot count binds, or the deployment ceiling is decoration --');

test('THE RAISED CEILING MUST NOT COLLAPSE THE SLOT COUNT', () => {
  // fitSlotsToWallet asks "is this economic?", and charging every hypothetical
  // trade the worst-case fee made a 2 SOL wallet fail at 3 slots and collapse
  // to 1. The fee a run typically pays is the floor; the ceiling is a
  // reservation, not a forecast.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('const economicsFeeSol =');
  assert.ok(idx > 0, 'the two questions must use two different fees');
  const body = engine.slice(idx, idx + 300);
  assert.ok(/economicsFeeSol = this\.config\.priorityFeeSol/.test(body),
    'the economics question uses the floor');
  assert.ok(/affordabilityFeeSol = this\.sizingPriorityFee\(\)/.test(body),
    'the affordability question uses the worst case');

  const budget = engine.slice(engine.indexOf('private computeRunBudget('), engine.indexOf('Links a Photon wallet'));
  assert.ok(/priorityFeeSol: economicsFeeSol,/.test(budget), 'the fit must use the economics fee');
  assert.ok(/priorityFeeSol: affordabilityFeeSol,/.test(budget), 'the split must use the affordability fee');
});

test('a REDUCED slot count is binding, not cosmetic', () => {
  // When the budget reduces the slots, the stake per slot grows to match — so
  // admitting the originally configured number of entries stakes the budget
  // several times over. Measured on a 2 SOL wallet with the raised ceiling:
  // 42% of the wallet deployed became 133%, defeating maxDeployedFractionPct
  // and leaving nothing to fund the exits.
  const engine = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
  const idx = engine.indexOf('private async withEntrySlot(');
  assert.ok(idx > 0);
  const body = engine.slice(idx, engine.indexOf('\n  private ', idx + 10));
  assert.ok(/Math\.min\(this\.config\.maxActivePositions, this\.runSlots\)/.test(body),
    'the entry gate must honour the funded slot count as well as the configured one');
  assert.ok(/committed >= cap/.test(body), 'and gate on the smaller of the two');
  // Cleared on disarm, or a later run inherits a stale cap.
  assert.ok((engine.match(/this\.runSlots = 0;/g) || []).length >= 2,
    'runSlots must be cleared when the run ends');
});

test('deployment stays under the configured fraction at every wallet size', () => {
  // The end-to-end property the two fixes above exist for, computed with the
  // shipped functions rather than asserted about the source.
  for (const wallet of [0.2, 2, 3, 5, 10]) {
    const deployed = wallet * 0.5;                       // maxDeployedFractionPct default
    const fit = fitSlotsToWallet({
      deployableSol: deployed, maxSlots: 3, maxSlippagePct: 10,
      priorityFeeSol: 0.001, maxBreakevenPct: 6, breakevenOf: breakevenPct,
    });
    const slots = fit.slots || 1;
    const { stakePerSlotSol } = splitWalletIntoSlots({
      deployableSol: deployed, slots, maxSlippagePct: 10, priorityFeeSol: 0.01,
    });
    const staked = stakePerSlotSol * slots;
    assert.ok(staked <= deployed + 1e-9,
      `wallet ${wallet}: ${slots} slots x ${stakePerSlotSol} = ${staked} exceeds the ${deployed} budget`);
    assert.ok(staked / wallet <= 0.5 + 1e-9,
      `wallet ${wallet}: deployed ${(staked / wallet * 100).toFixed(0)}% of the wallet, ceiling is 50%`);
  }
});

console.log('\n-- The slow lane learns its wait instead of assuming it --');

/**
 * The shipped estimator's arithmetic, extracted so the RULE can be tested. The
 * service methods are four lines around exactly this; the source assertions
 * below pin that they still are.
 */
// IMPORTED, NEVER RE-DECLARED. These were local copies of the shipped numbers,
// so every test below was checking the test file's own arithmetic: setting
// CONFIRM_WAIT_PRIORITY_FRACTION to 1.6, MIN to 0 and MAX to 8000 in production
// inverted every property these tests are named after and the suite stayed
// green. A constant a test asserts about has to be the constant that ships.
const ALPHA = CONFIRM_WAIT_ALPHA;
const FRACTION = CONFIRM_WAIT_FRACTION;
const PRIORITY_FRACTION = CONFIRM_WAIT_PRIORITY_FRACTION;
const MIN_MS = CONFIRM_WAIT_MIN_MS;
const MAX_MS = CONFIRM_WAIT_MAX_MS;
function ewma(seed: number, samples: number[]): number {
  let v = seed;
  for (const raw of samples) v = v * (1 - ALPHA) + Math.min(raw, MAX_MS) * ALPHA;
  return v;
}
const sleepFor = (est: number, priority = false) =>
  Math.max(MIN_MS, Math.min(MAX_MS, Math.round(est * (priority ? PRIORITY_FRACTION : FRACTION))));

test('a fast chain shortens the wait the hardcoded guess would have paid in full', () => {
  // The old code slept 350ms before the first read on every leader trade this
  // lane handles — every pump-AMM, Raydium and Jupiter buy the leader makes.
  const learned = ewma(350, Array(20).fill(150));
  assert.ok(learned < 250, `estimate should fall toward the observed 150ms, got ${learned.toFixed(0)}`);
  assert.ok(sleepFor(learned) < 300, 'and the sleep should follow it down');
});

test('a slow chain lengthens it, so we stop burning the key on reads that cannot succeed', () => {
  const learned = ewma(350, Array(20).fill(700));
  assert.ok(learned > 500, `estimate should rise toward 700ms, got ${learned.toFixed(0)}`);
  assert.ok(sleepFor(learned) > 400);
});

test('A RATE-LIMITED READ DESCRIBES THE KEY, NOT THE CHAIN', () => {
  // An 8s read happened because the key was throttled. Letting that into the
  // average would make every later trade wait for a problem that has gone away.
  const poisoned = ewma(350, [8000, 8000, 8000]);
  assert.ok(poisoned <= MAX_MS, `one anomalous sample must not pin the estimate high, got ${poisoned.toFixed(0)}`);
});

test('the sleep never collapses to a busy-poll, however fast the chain looks', () => {
  const learned = ewma(350, Array(50).fill(1));
  assert.strictEqual(sleepFor(learned), MIN_MS,
    'a floor is what stops this becoming a tight loop against a shared key');
});

test('waking EARLY is the deliberate choice — the fraction is below 1', () => {
  // Sleeping the full estimate means the first read lands exactly when the
  // transaction becomes available on average, which is a coin flip. Early costs
  // one wasted call; late costs latency on every trade.
  assert.ok(FRACTION < 1 && PRIORITY_FRACTION < FRACTION,
    'entries wake early, and a live exit earlier still');
});

test('the shipped estimator still uses those constants and clamps the sample', () => {
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  const recIdx = copy.indexOf('private recordConfirmWait(');
  assert.ok(recIdx > 0, 'the observed wait must be recorded somewhere');
  const rec = copy.slice(recIdx, recIdx + 600);
  assert.ok(/Math\.min\(observedMs, CONFIRM_WAIT_MAX_MS\)/.test(rec),
    'the sample must be clamped BEFORE it enters the average, or one throttled read poisons it');
  assert.ok(/CONFIRM_WAIT_ALPHA/.test(rec), 'it must be an EWMA, not a last-value assignment');

  const estIdx = copy.indexOf('private estimatedConfirmWaitMs(');
  assert.ok(estIdx > 0);
  const est = copy.slice(estIdx, estIdx + 400);
  assert.ok(/CONFIRM_WAIT_MIN_MS/.test(est) && /CONFIRM_WAIT_MAX_MS/.test(est),
    'the sleep must be clamped at both ends');

  // And the hardcoded guess must be gone from the fetch path.
  const fetchIdx = copy.indexOf('private async fetchParsedTx(');
  const fetchBody = copy.slice(fetchIdx, fetchIdx + 2500);
  assert.ok(!/await sleep\(priority \? 300 : 350\)/.test(fetchBody),
    'the fixed 300/350ms pre-sleep must not survive next to the estimator');
  assert.ok(/await sleep\(this\.estimatedConfirmWaitMs\(priority\)\)/.test(fetchBody),
    'the fetch must sleep the learned wait');
});

test('the processed→confirmed floor is documented as an API limit, not a defect', () => {
  // Worth pinning: a future reader will wonder why this lane cannot simply read
  // at 'processed' like the fast one does. It cannot — getParsedTransaction
  // takes a Finality, and 'processed' is not one.
  const copy = readFileSync(join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
  const fetchIdx = copy.indexOf('private async fetchParsedTx(');
  const body = copy.slice(fetchIdx, fetchIdx + 2500);
  assert.ok(/Finality/.test(body),
    'the reason the wait cannot be removed must be recorded where the wait is');
});

void (async () => {
  if (asyncTests.length) console.log(`\n-- Async broadcast proofs (${asyncTests.length}) --`);
  for (const t of asyncTests) {
    try { await t.fn(); passed++; console.log(`  ok    ${t.name}`); }
    catch (err: any) { failed++; console.error(`  FAIL  ${t.name}\n        ${err?.message ?? err}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
