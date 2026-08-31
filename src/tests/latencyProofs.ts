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
  const completeIdx = engine.indexOf('if (measuringExternal) latencyTimeline.complete(mint);');
  assert.ok(completeIdx > openIdx, 'and must complete it afterwards');
  // The completion has to be in the finally, not on the success path.
  const finallyIdx = engine.lastIndexOf('} finally {', completeIdx);
  assert.ok(finallyIdx > openIdx && finallyIdx < completeIdx,
    'the completion must sit inside the finally, or a thrown order leaks its record forever');
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
  assert.strictEqual(stampLines.length, 1, 'exactly one place may mark the balance stale');
  assert.strictEqual(stampLines[0].t, 'this.lastTradeSettledAt = Date.now();',
    'the stamp must be an unconditional statement — a guard in front of it means some settlement '
    + 'outcomes leave the cached balance looking fresh when the fee has already been burned');

  const confirmIdx = lines.findIndex(l => l.includes('const confirmed = await this.confirmTransaction('));
  assert.ok(confirmIdx >= 0 && stampLines[0].i > confirmIdx,
    'the stamp must come after the verdict, so it covers every outcome rather than only the happy path');
  const between = lines.slice(confirmIdx, stampLines[0].i).join('\n');
  assert.ok(!/if \(confirmed ===/.test(between),
    'no outcome branch may sit between the verdict and the stamp, or some outcomes would not mark it');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
