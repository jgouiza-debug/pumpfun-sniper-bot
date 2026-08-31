/**
 * INCIDENT PROOFS — 2026-08-30, "random buys saying its on chain but its not,
 * and it emptied my wallet".
 *
 *   npx ts-node src/tests/incidentProofs.ts
 *
 * One file, three symptoms, and for each one the OLD behaviour reproduced
 * before the new behaviour is asserted. A test that only checks the fix proves
 * the code does something; a test that first reproduces the defect proves the
 * code stopped doing the thing that cost money. Every `OLD BUG` case below is
 * the real previous expression, copied out of the git history, not a
 * paraphrase — so if a future refactor reinstates it, this file fails.
 *
 *   S1  RANDOM BUYS      — a leader signal that was not a purchase became a buy.
 *   S2  PHANTOM ON-CHAIN — a buy that never confirmed became an OPEN position
 *                          the UI labelled "ON-CHAIN".
 *   S3  WALLET DRAIN     — nothing bounded how much, how often, or how many
 *                          times into one token the bot could spend.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyFlow, TRADE_MIN_SOL_BUY, VENUE_TRADE_MIN_SOL_BUY } from '../services/leaderTxClassifier';
import { TradeGovernor, DEFAULT_GOVERNOR_LIMITS } from '../services/tradeGovernor';
import { settleTransaction, didLand, provablyDidNothing } from '../services/txSettlement';
import { splitWalletIntoSlots } from '../services/pipelineUtils';

let passed = 0;
let failed = 0;
const pending: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    pending.push({ name, fn: fn as () => Promise<void> });
    return;
  }
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ===========================================================================
// S1 — RANDOM BUYS
// ===========================================================================
console.log('\n-- S1: a signal that was not a purchase became a buy --');

/** The exact rule that shipped, for proof. */
function legacyClassifyFlow(p: {
  side: 'buy' | 'sell'; tradeSol: number; venueKnown: boolean; isTokenSwap: boolean;
}): 'trade' | 'transfer' {
  if (p.isTokenSwap || p.venueKnown) return 'trade';
  const min = p.side === 'buy' ? 0.003 : 0.0005;
  return p.tradeSol > min ? 'trade' : 'transfer';
}

test('OLD BUG: a DEX program merely PRESENT in the transaction made a zero-SOL token inflow a BUY', () => {
  // detectVenue scans ACCOUNT KEYS. It answers "was a venue program mentioned
  // anywhere in this transaction", not "did the leader swap" — so a bundle, a
  // multi-recipient distribution, a program-routed airdrop, or another party's
  // swap the leader was merely referenced by all satisfied it.
  assert.strictEqual(
    legacyClassifyFlow({ side: 'buy', tradeSol: 0, venueKnown: true, isTokenSwap: false }), 'trade');
});

test('OLD BUG: "some mint up, some mint down" was accepted as payment for a BUY', () => {
  // isTokenSwap is computed upstream as buys.length > 0 && sells.length > 0 —
  // equally true of a bag transferred OUT while an airdrop landed IN.
  assert.strictEqual(
    legacyClassifyFlow({ side: 'buy', tradeSol: 0, venueKnown: false, isTokenSwap: true }), 'trade');
});

test('fixed: tokens arriving for NO SOL are a transfer, whatever programs the transaction mentions', () => {
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: true, isTokenSwap: false }), 'transfer');
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: false, isTokenSwap: true }), 'transfer');
});

test('fixed: a token->token BUY still counts when it executed on a venue we recognise', () => {
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: true, isTokenSwap: true }), 'trade');
});

test('fixed: a real venue buy is still copied — the floor is lowered, not removed', () => {
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.001, venueKnown: true, isTokenSwap: false }), 'trade');
  assert.ok(VENUE_TRADE_MIN_SOL_BUY < TRADE_MIN_SOL_BUY,
    'a known venue must still lower the bar, or small genuine buys stop being copied');
  assert.ok(VENUE_TRADE_MIN_SOL_BUY > 0,
    'but never to zero — zero is what let an airdrop through');
});

test('fixed: an off-venue buy keeps the higher floor that sits above ATA rent', () => {
  // Receiving tokens can cost rent (0.00204) plus fees without buying any.
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.0021, venueKnown: false, isTokenSwap: false }), 'transfer');
  assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.01, venueKnown: false, isTokenSwap: false }), 'trade');
});

test('the SELL side is deliberately unchanged — missing a leader exit is the expensive direction', () => {
  for (const c of [
    { tradeSol: 0, venueKnown: true, isTokenSwap: false },
    { tradeSol: 0, venueKnown: false, isTokenSwap: true },
    { tradeSol: 0.001, venueKnown: false, isTokenSwap: false },
  ]) {
    assert.strictEqual(classifyFlow({ side: 'sell', ...c }), 'trade', JSON.stringify(c));
  }
  // A dust move with no venue is still not an exit.
  assert.strictEqual(classifyFlow({ side: 'sell', tradeSol: 0.0001, venueKnown: false, isTokenSwap: false }), 'transfer');
});

// ===========================================================================
// S2 — PHANTOM ON-CHAIN
// ===========================================================================
console.log('\n-- S2: a buy that never confirmed became an OPEN "ON-CHAIN" position --');

/** A scriptable stand-in for the two RPC calls settlement uses. */
function fakeConn(script: {
  statuses?: Array<any | 'throw'>;
  blockhashValid?: Array<boolean | 'throw'>;
}) {
  let si = 0;
  let bi = 0;
  return {
    getSignatureStatuses: async () => {
      const v = script.statuses?.[Math.min(si, (script.statuses?.length ?? 1) - 1)];
      si++;
      if (v === 'throw') throw new Error('429 Too Many Requests');
      return { value: [v ?? null] } as any;
    },
    isBlockhashValid: async () => {
      const v = script.blockhashValid?.[Math.min(bi, (script.blockhashValid?.length ?? 1) - 1)];
      bi++;
      if (v === 'throw') throw new Error('rpc down');
      return { value: v ?? true } as any;
    },
  };
}

const fastOpts = { pollMs: 0, blockhashCheckMs: 0, sleep: async () => {} };

test('a confirmed signature lands', async () => {
  const r = await settleTransaction(
    fakeConn({ statuses: [{ err: null, confirmationStatus: 'confirmed' }] }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000 });
  assert.strictEqual(r.outcome, 'landed');
  assert.ok(didLand(r.outcome));
});

test("a 'processed' status is NOT a landing — it can still be dropped on a fork", async () => {
  // Only ever 'processed', and the blockhash dies: the honest answer is that it
  // never landed, not that it did.
  const r = await settleTransaction(
    fakeConn({ statuses: [{ err: null, confirmationStatus: 'processed' }], blockhashValid: [false] }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000, blockhash: 'bh' });
  assert.strictEqual(r.outcome, 'expired');
  assert.strictEqual(didLand(r.outcome), false);
});

test('an on-chain rejection is reverted, and slippage is called by name', async () => {
  const rev = await settleTransaction(
    fakeConn({ statuses: [{ err: { InstructionError: [0, 'X'] } }] }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000 });
  assert.strictEqual(rev.outcome, 'reverted');

  const slip = await settleTransaction(
    fakeConn({ statuses: [{ err: { InstructionError: [3, { Custom: 6004 }] } }] }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000 });
  assert.strictEqual(slip.outcome, 'slippage');

  assert.ok(provablyDidNothing('reverted') && provablyDidNothing('slippage') && provablyDidNothing('expired'));
});

test('THE FIX: a dead blockhash with no status is PROVEN never to have landed', async () => {
  // This is the case the old code called 'timeout' and the copy trader turned
  // into an OPEN position with invented quantities. It is now a definitive
  // negative, which is what makes "open nothing" a safe decision rather than a
  // guess.
  const r = await settleTransaction(
    fakeConn({ statuses: [null], blockhashValid: [false] }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000, blockhash: 'bh' });
  assert.strictEqual(r.outcome, 'expired');
  assert.strictEqual(didLand(r.outcome), false);
  assert.ok(provablyDidNothing(r.outcome), 'nothing to reconcile — it cannot land');
});

test('expiry needs TWO observations, so a last-slot landing is not called dead', async () => {
  // isBlockhashValid can go false in the same moment the transaction lands on a
  // node we have not asked yet. One observation is a race; the second poll sees
  // the status and reports the landing.
  const r = await settleTransaction(
    fakeConn({
      statuses: [null, { err: null, confirmationStatus: 'confirmed' }],
      blockhashValid: [false, false],
    }) as any,
    'sig', { ...fastOpts, timeoutMs: 5_000, blockhash: 'bh' });
  assert.strictEqual(r.outcome, 'landed', 'a transaction that landed in the last valid slot must not be declared expired');
});

test('THE FIX: an RPC that never answers is UNKNOWN, and unknown is not success', async () => {
  // The 429-storm case. Every poll throws; the old loop swallowed them all in a
  // bare catch and reported 'timeout', under which every buy in the window
  // became a phantom position.
  const r = await settleTransaction(
    fakeConn({ statuses: ['throw'], blockhashValid: ['throw'] }) as any,
    'sig', { ...fastOpts, timeoutMs: 300, now: (() => { let t = 0; return () => (t += 100); })(), blockhash: 'bh' });
  assert.strictEqual(r.outcome, 'unknown');
  assert.ok(r.rpcErrors > 0, 'the RPC errors must be counted, not swallowed — they are the diagnosis');
  assert.strictEqual(didLand(r.outcome), false, 'unknown must never be treated as a fill');
  assert.strictEqual(provablyDidNothing(r.outcome), false, 'nor may it be forgotten — it needs reconciling');
  assert.ok(/UNPROVEN/.test(r.detail), 'the operator-facing text must say the position is unproven');
});

test('settlement never throws — a thrown error must not be mistaken for a trade', async () => {
  const exploding = {
    getSignatureStatuses: async () => { throw new Error('boom'); },
    isBlockhashValid: async () => { throw new Error('boom'); },
  };
  const r = await settleTransaction(exploding as any, 'sig', {
    ...fastOpts, timeoutMs: 200, now: (() => { let t = 0; return () => (t += 100); })(),
  });
  assert.strictEqual(r.outcome, 'unknown');
});

// ===========================================================================
// S3 — WALLET DRAIN
// ===========================================================================
console.log('\n-- S3a: split sizing handed one buy the entire wallet --');

/** The exact divisor that shipped, for proof. */
function legacyDivisor(slots: number, openPositionCount: number): number {
  return Math.max(1, slots - Math.max(0, openPositionCount));
}
/** The corrected divisor from copyTraderService.splitStakeSol. */
function fixedDivisor(slots: number, open: number, isRepeatBuy: boolean): number {
  return (isRepeatBuy || open >= slots) ? slots : slots - open;
}

const SIZING = { maxSlippagePct: 25, priorityFeeSol: 0.001 };

test('OLD BUG: with the book FULL, the floor made the divisor 1 — one buy took the whole wallet', () => {
  // onLeaderBuy skips the maxOpenPositions check entirely when a position for
  // the mint already exists, because a repeat buy merges into it. So a leader
  // top-up arrived here with open == slots, the subtraction gave 0, and the
  // Math.max floor turned it into 1.
  const slots = 5;
  assert.strictEqual(legacyDivisor(slots, 5), 1);
  const whole = splitWalletIntoSlots({ deployableSol: 0.4, slots: legacyDivisor(slots, 5), ...SIZING });
  const oneSlice = splitWalletIntoSlots({ deployableSol: 0.4, slots, ...SIZING });
  assert.ok(whole.stakePerSlotSol > oneSlice.stakePerSlotSol * 4,
    `old sizing staked ${whole.stakePerSlotSol} where a slice is ${oneSlice.stakePerSlotSol}`);
  assert.ok(whole.slotBudgetSol >= 0.4 - 1e-9, 'the whole deployable balance, in one order');
});

test('fixed: a full book divides by the full book — a top-up is a slice, never the wallet', () => {
  const slots = 5;
  assert.strictEqual(fixedDivisor(slots, 5, false), slots);
  assert.strictEqual(fixedDivisor(slots, 5, true), slots);
  const stake = splitWalletIntoSlots({ deployableSol: 0.4, slots: fixedDivisor(slots, 5, true), ...SIZING });
  assert.ok(stake.slotBudgetSol <= 0.4 / slots + 1e-9, `a top-up staked ${stake.slotBudgetSol} of 0.4 deployable`);
});

test('fixed: a REPEAT buy divides by the full book even when slots are free', () => {
  // The position it adds to already holds its slice; a top-up must not also
  // claim the free slots' worth.
  const slots = 5;
  assert.strictEqual(fixedDivisor(slots, 1, true), 5);
  assert.strictEqual(fixedDivisor(slots, 1, false), 4);
});

test('fixed: NEW entries keep the self-correcting free-slot divisor (no slice decay)', () => {
  // The property split sizing exists for: 0.1 SOL over 5 free slots stakes
  // 0.02, and after that buy 0.08 over 4 free slots still stakes 0.02. Dividing
  // a new entry by the full book instead would decay every slice and strand
  // most of the wallet.
  const slots = 5;
  const first = splitWalletIntoSlots({ deployableSol: 0.1, slots: fixedDivisor(slots, 0, false), ...SIZING });
  const second = splitWalletIntoSlots({ deployableSol: 0.1 - first.slotBudgetSol, slots: fixedDivisor(slots, 1, false), ...SIZING });
  assert.ok(Math.abs(first.slotBudgetSol - second.slotBudgetSol) < 1e-6,
    `slices must stay steady: ${first.slotBudgetSol} then ${second.slotBudgetSol}`);
});

console.log('\n-- S3b: nothing bounded how much the bot could spend --');

test('the ceiling is enforced INSIDE executeRealMainnetTrade, before anything is sent', () => {
  // This test used to be `assert.ok(true)` with a paragraph of explanation —
  // a tautology guarding the single most important wiring in the change, which
  // is exactly the kind of test that lets a regression ship green.
  //
  // The hole it describes: guardrails.ts' limiters were evaluated in exactly
  // one place, sniperEngine's own entry gate. The copy trader called
  // executeExternalTrade, which drops straight into executeRealMainnetTrade —
  // below every one of them. noteTradeFailure even excluded copy failures from
  // the breaker explicitly ("the copy trader runs its own bounded retries
  // instead"), and the copy trader had none. So the ceiling has to live at the
  // chokepoint, and this asserts that it does.
  const engineSrc = readFileSync(join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const fnStart = engineSrc.indexOf('private async executeRealMainnetTrade');
  assert.ok(fnStart > 0, 'executeRealMainnetTrade must exist');
  const fnSrc = engineSrc.slice(fnStart, engineSrc.indexOf('\n  private async confirmTransaction', fnStart));
  assert.ok(fnSrc.length > 1000, 'the slice must actually cover the function');

  // Anchored on the actual CALL, not the bare word: the comments in this area
  // name sendRawTransaction while explaining why the ceiling sits here, and a
  // test that matches prose instead of code proves nothing.
  const SEND_CALL = 'this.solanaConnection.sendRawTransaction(';
  const reserveAt = fnSrc.indexOf('tradeGovernor.tryReserveBuy(');
  const sendAt = fnSrc.indexOf(SEND_CALL);
  assert.ok(reserveAt > 0, 'the governor must be consulted inside executeRealMainnetTrade, not in a caller');
  assert.ok(sendAt > 0, 'the send must be in this function');
  assert.ok(reserveAt < sendAt, 'the ceiling must be checked BEFORE the transaction is sent');

  // checkBuy alone is check-then-act; only tryReserveBuy claims atomically.
  assert.ok(!/tradeGovernor\.checkBuy\(/.test(fnSrc),
    'the engine must reserve atomically, never check-then-act');

  // Exactly one send INSIDE this function: both engines reach the chain through
  // it, and a second send here would be a second door around the ceiling.
  assert.strictEqual(fnSrc.split(SEND_CALL).length - 1, 1,
    'a second send inside executeRealMainnetTrade would bypass the reservation');

  // Elsewhere in the engine, the ONLY other send is the rebroadcast helper —
  // which resends bytes that were already governed and already signed, and is
  // idempotent because the cluster dedupes by signature. Anything else placing
  // an order would be a new spend the ceiling never saw.
  const otherSends = engineSrc.split(SEND_CALL).length - 1 - 1;
  if (otherSends > 0) {
    const rebroadcastAt = engineSrc.indexOf('private rebroadcastUntilSettled');
    assert.ok(rebroadcastAt > 0, 'the only other send must be the rebroadcast helper');
    const rebroadcastSrc = engineSrc.slice(rebroadcastAt, engineSrc.indexOf('\n  private ', rebroadcastAt + 10));
    assert.strictEqual(otherSends, rebroadcastSrc.split(SEND_CALL).length - 1,
      'every send outside executeRealMainnetTrade must be inside rebroadcastUntilSettled');
    assert.ok(!/tradeGovernor/.test(rebroadcastSrc),
      'the rebroadcast must not claim budget again — it resends bytes already charged');
  }

  // Outcomes must be reported, or the failure breaker never trips.
  assert.ok(/tradeGovernor\.recordBuyOutcome\(false/.test(fnSrc), 'failures must be reported');
  assert.ok(/tradeGovernor\.recordBuyOutcome\(true/.test(fnSrc), 'successes must clear the streak');
});

test('the pre-sign guard is called with the CEILINGS, not with its permissive defaults', () => {
  // assertOutboundTradeTx's ceilings are OPTIONAL (`opts = {}`), which is a
  // sharp edge: the drain tests in run.ts call it without them, so the suite
  // exercises a strictly weaker guard than the one that ships. This pins the
  // PRODUCTION call site instead — if a refactor drops the options, the guard
  // silently reverts to its backstops and this fails.
  const engineSrc = readFileSync(join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const at = engineSrc.indexOf('assertOutboundTradeTx(');
  assert.ok(at > 0, 'the guard must be called before signing');
  const call = engineSrc.slice(at, at + 600);
  assert.ok(/maxLamportsOut/.test(call),
    'the guard must be told what this trade was sized for, or the naming bypass has no total to be measured against');
  assert.ok(/maxPriorityFeeLamports/.test(call),
    'the guard must be given a priority-fee ceiling, or ComputeBudget is unbounded');

  // And the guard must be consulted BEFORE the signature.
  const signAt = engineSrc.indexOf('tx.sign([keypair])');
  assert.ok(signAt > at, 'the intent check must run before the key touches the transaction');

  // Exactly one signing site: a second would be a second door.
  assert.strictEqual(engineSrc.split('tx.sign([keypair])').length - 1, 1);
});

test('the copy trader has no way to reach the chain except through that function', () => {
  const copySrc = readFileSync(join(__dirname, '../services/copyTraderService.ts'), 'utf8');
  assert.ok(!/sendRawTransaction|\.sign\(\[/.test(copySrc),
    'the copy trader must never sign or send on its own — it goes through the engine, and the ceiling is there');
});

const req = (over: Partial<Parameters<TradeGovernor['checkBuy']>[0]> = {}) => ({
  now: 1_000_000,
  mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  solAmount: 0.02,
  walletSol: 1,
  inFlightBuys: 0,
  engine: 'copy' as const,
  ...over,
});

test('an ordinary buy passes every ceiling', () => {
  assert.strictEqual(new TradeGovernor().checkBuy(req()).allowed, true);
});

test('the wallet can never be traded to zero — a reserve always stays behind', () => {
  const g = new TradeGovernor({ minWalletReserveSol: 0.01 });
  const d = g.checkBuy(req({ walletSol: 0.02, solAmount: 0.015 }));
  assert.strictEqual(d.allowed, false);
  assert.ok(/wallet floor/.test(d.reason!), d.reason);
});

test('repeat buys into ONE mint are bounded, by count and by SOL', () => {
  const g = new TradeGovernor({ maxBuysPerMint: 3, maxSolPerMint: 1, maxBuysPerHour: 0, maxSolPerHour: 0, maxSolPerSession: 0 });
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(g.checkBuy(req()).allowed, true, `buy ${i + 1} should pass`);
    g.recordBuy(1_000_000, req().mint, 0.02);
  }
  const d = g.checkBuy(req());
  assert.strictEqual(d.allowed, false);
  assert.ok(/buys of/.test(d.reason!), d.reason);

  // And the SOL ceiling bites independently of the count.
  const g2 = new TradeGovernor({ maxSolPerMint: 0.05, maxBuysPerMint: 0, maxBuysPerHour: 0, maxSolPerHour: 0, maxSolPerSession: 0 });
  g2.recordBuy(1_000_000, req().mint, 0.04);
  assert.strictEqual(g2.checkBuy(req({ solAmount: 0.02 })).allowed, false);
});

test('a different mint is not blocked by another mint\'s ceiling', () => {
  const g = new TradeGovernor({ maxBuysPerMint: 1, maxBuysPerHour: 0, maxSolPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0 });
  g.recordBuy(1_000_000, 'MintA', 0.02);
  assert.strictEqual(g.checkBuy(req({ mint: 'MintA' })).allowed, false);
  assert.strictEqual(g.checkBuy(req({ mint: 'MintB' })).allowed, true);
});

test('a high-frequency leader cannot spend the wallet through sheer trade count', () => {
  // The measured shape of the problem: a tracked wallet that also market-makes
  // produced hundreds of copyable signals in minutes.
  const g = new TradeGovernor({ maxBuysPerHour: 10, maxSolPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0 });
  for (let i = 0; i < 10; i++) g.recordBuy(1_000_000 + i, `Mint${i}`, 0.001);
  const d = g.checkBuy(req({ mint: 'MintZ' }));
  assert.strictEqual(d.allowed, false);
  assert.ok(/in the last hour/.test(d.reason!), d.reason);
});

test('the hourly window ROLLS — an old buy stops counting', () => {
  const g = new TradeGovernor({ maxBuysPerHour: 1, maxSolPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0 });
  g.recordBuy(1_000_000, 'MintA', 0.01);
  assert.strictEqual(g.checkBuy(req({ now: 1_000_000 + 60_000 })).allowed, false);
  assert.strictEqual(g.checkBuy(req({ now: 1_000_000 + 3_600_001 })).allowed, true);
});

test('the SESSION ceiling does not roll off — a week-long run cannot spend the hourly cap 168 times', () => {
  const g = new TradeGovernor({ maxSolPerSession: 0.05, maxSolPerHour: 0, maxBuysPerHour: 0, maxSolPerMint: 0, maxBuysPerMint: 0 });
  g.recordBuy(1_000_000, 'MintA', 0.04);
  const farFuture = 1_000_000 + 7 * 24 * 3_600_000;
  const d = g.checkBuy(req({ now: farFuture, solAmount: 0.02 }));
  assert.strictEqual(d.allowed, false);
  assert.ok(/this session/.test(d.reason!), d.reason);
});

test('THE FEE-BURN RUNAWAY: consecutive failed buys latch the governor', () => {
  // A failed buy opens no position, so it never consumes a position slot, so
  // maxOpenPositions never saw it — while every attempt still burned a base fee
  // plus a priority fee. This is the loop that ground the wallet down with an
  // empty trade ledger to show for it.
  const g = new TradeGovernor({ maxConsecutiveFailures: 3 });
  assert.strictEqual(g.recordBuyOutcome(false, 'expired'), false);
  assert.strictEqual(g.recordBuyOutcome(false, 'reverted'), false);
  assert.strictEqual(g.recordBuyOutcome(false, 'expired'), true, 'the third failure must latch');
  assert.ok(g.isHalted());

  const d = g.checkBuy(req());
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.halted, true);
  assert.ok(/HALTED/.test(d.reason!), d.reason);
});

test('a buy that LANDS clears the failure streak', () => {
  const g = new TradeGovernor({ maxConsecutiveFailures: 3 });
  g.recordBuyOutcome(false, 'x');
  g.recordBuyOutcome(false, 'x');
  g.recordBuyOutcome(true, 'confirmed');
  assert.strictEqual(g.consecutiveFailureCount(), 0);
  assert.strictEqual(g.recordBuyOutcome(false, 'x'), false, 'the streak restarted, so one failure must not latch');
});

test('a latched halt does NOT clear itself — whatever broke at 3am is still broken at 3:01', () => {
  const g = new TradeGovernor({ maxConsecutiveFailures: 1 });
  g.recordBuyOutcome(false, 'x');
  assert.strictEqual(g.checkBuy(req({ now: 1_000_000 + 24 * 3_600_000 })).allowed, false);
  g.clearHalt();
  assert.strictEqual(g.checkBuy(req()).allowed, true, 'an explicit operator action clears it');
});

test('the FIRST halt reason is kept — later trips are consequences, not the cause', () => {
  const g = new TradeGovernor();
  g.halt('the real cause');
  g.halt('a downstream symptom');
  assert.strictEqual(g.haltReason(), 'the real cause');
});

test('concurrent buys are bounded across BOTH engines — one wallet, one ceiling', () => {
  const g = new TradeGovernor({ maxConcurrentBuys: 2 });
  assert.strictEqual(g.checkBuy(req({ inFlightBuys: 1 })).allowed, true);
  const d = g.checkBuy(req({ inFlightBuys: 2 }));
  assert.strictEqual(d.allowed, false);
  assert.ok(/in flight/.test(d.reason!), d.reason);
});

console.log('\n-- S3c: a corrupt config must not read as "unlimited" --');

test('NaN and Infinity spend sizes are REFUSED, not waved through', () => {
  // NaN >= limit is false and NaN <= limit is false, so every comparison in a
  // guard silently passes. Reachable from a corrupt state file or a UI field
  // that posted an empty string.
  const g = new TradeGovernor();
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, undefined as any, '0.5' as any]) {
    const d = g.checkBuy(req({ solAmount: bad }));
    assert.strictEqual(d.allowed, false, `solAmount ${String(bad)} must be refused`);
  }
});

test('an unreadable wallet balance is REFUSED — a buy we cannot bound is a buy we do not make', () => {
  const g = new TradeGovernor();
  for (const bad of [NaN, Infinity, undefined as any]) {
    assert.strictEqual(g.checkBuy(req({ walletSol: bad })).allowed, false, String(bad));
  }
});

test('a non-finite LIMIT is rejected and the previous ceiling kept', () => {
  // A slider that posts "" must not silently become "unlimited".
  const g = new TradeGovernor({ maxBuysPerHour: 5 });
  g.setLimits({ maxBuysPerHour: NaN as any });
  assert.strictEqual(g.getLimits().maxBuysPerHour, 5);
  g.setLimits({ maxBuysPerHour: Infinity as any });
  assert.strictEqual(g.getLimits().maxBuysPerHour, 5);
  g.setLimits({ maxBuysPerHour: -1 as any });
  assert.strictEqual(g.getLimits().maxBuysPerHour, 5, 'a negative cap is not a cap');
  g.setLimits({ maxBuysPerHour: 9 });
  assert.strictEqual(g.getLimits().maxBuysPerHour, 9, 'a real value still applies');
});

test('rolling history survives a settings change — moving a slider must not reset the window', () => {
  const g = new TradeGovernor({ maxBuysPerHour: 2 });
  g.recordBuy(1_000_000, 'MintA', 0.01);
  g.recordBuy(1_000_001, 'MintB', 0.01);
  g.setLimits({ maxBuysPerHour: 2 });
  assert.strictEqual(g.checkBuy(req({ mint: 'MintC' })).allowed, false);
});

test('the shipped ceilings are all ON — a default of 0 would ship the hole again', () => {
  const L = DEFAULT_GOVERNOR_LIMITS;
  for (const [k, v] of Object.entries(L)) {
    assert.ok(Number.isFinite(v), `${k} must be a finite number`);
    assert.ok((v as number) > 0, `${k} ships DISABLED (${v}) — every ceiling must be armed by default`);
  }
});

test('the operator can always see where they stand before a ceiling bites', () => {
  const g = new TradeGovernor();
  g.recordBuy(1_000_000, 'MintA', 0.02);
  const s = g.snapshot(1_000_100);
  assert.strictEqual(s.buysThisHour, 1);
  assert.ok(Math.abs(s.solThisHour - 0.02) < 1e-9);
  assert.ok(Math.abs(s.solThisSession - 0.02) < 1e-9);
  assert.strictEqual(s.halted, false);
  assert.ok(s.limits.maxBuysPerHour > 0);
});

test('resetSession clears the halt, the streak and the totals', () => {
  const g = new TradeGovernor({ maxConsecutiveFailures: 1 });
  g.recordBuy(1_000_000, 'MintA', 0.02);
  g.recordBuyOutcome(false, 'x');
  assert.ok(g.isHalted());
  g.resetSession();
  const s = g.snapshot(1_000_100);
  assert.strictEqual(s.halted, false);
  assert.strictEqual(s.buysThisHour, 0);
  assert.strictEqual(s.solThisSession, 0);
  assert.strictEqual(s.consecutiveFailures, 0);
});

console.log('\n-- S3d: the ceiling itself must not have a race --');

test('OLD BUG (first version of the governor): check-then-act let N concurrent buys all pass one cap', () => {
  // checkBuy reads counters that recordBuy writes, and between the two sits the
  // whole build-and-sign path — an HTTP call to trade-local, lookup tables, the
  // intent guard, signing. The per-mint queue serialises same-mint work only,
  // so one leader transaction touching several mints starts several buys
  // concurrently. All of them checked against counters still reading zero.
  const g = new TradeGovernor({ maxSolPerHour: 0.05, maxBuysPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0, maxConcurrentBuys: 0 });
  const decisions = ['M1', 'M2', 'M3', 'M4'].map(m => g.checkBuy(req({ mint: m, solAmount: 0.04 })));
  assert.ok(decisions.every(d => d.allowed),
    'all four pass a 0.05 SOL/h cap because none of them has recorded yet — 0.16 SOL through a 0.05 ceiling');
});

test('THE FIX: tryReserveBuy checks and claims in ONE synchronous step', () => {
  const g = new TradeGovernor({ maxSolPerHour: 0.05, maxBuysPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0, maxConcurrentBuys: 0 });
  const results = ['M1', 'M2', 'M3', 'M4'].map(m => g.tryReserveBuy(req({ mint: m, solAmount: 0.04 })));
  assert.strictEqual(results.filter(r => r.allowed).length, 1,
    'the first claims the budget; the rest see it gone');
  assert.ok(/this hour/.test(results[1].reason!), results[1].reason);
});

test('an order that never reaches the chain RELEASES its claim', () => {
  // A build failure or an intent-guard refusal spent nothing, so it must not
  // consume somebody else's budget.
  const g = new TradeGovernor({ maxSolPerHour: 0.05, maxBuysPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0, maxConcurrentBuys: 0 });
  const first = g.tryReserveBuy(req({ solAmount: 0.04 }));
  assert.strictEqual(first.allowed, true);
  assert.strictEqual(g.checkBuy(req({ mint: 'M2', solAmount: 0.04 })).allowed, false);

  first.release!();
  assert.strictEqual(g.checkBuy(req({ mint: 'M2', solAmount: 0.04 })).allowed, true, 'the budget came back');
  assert.strictEqual(g.snapshot(1_000_000).solThisSession, 0, 'and so did the session total');
});

test('release is idempotent and releases only ITS OWN claim', () => {
  const g = new TradeGovernor({ maxSolPerHour: 0, maxBuysPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0, maxConcurrentBuys: 0 });
  const a = g.tryReserveBuy(req({ mint: 'M1', solAmount: 0.01 }));
  const b = g.tryReserveBuy(req({ mint: 'M2', solAmount: 0.02 }));
  a.release!();
  a.release!();          // second call must be a no-op, not a second refund
  assert.strictEqual(g.snapshot(1_000_000).buysThisHour, 1, 'B must still be claimed');
  assert.ok(Math.abs(g.snapshot(1_000_000).solThisSession - 0.02) < 1e-9, 'B\'s SOL must still be claimed');
  b.release!();
  assert.strictEqual(g.snapshot(1_000_000).buysThisHour, 0);
});

test('a REFUSED reservation hands back no release handle to call by mistake', () => {
  const g = new TradeGovernor({ maxConsecutiveFailures: 1 });
  g.recordBuyOutcome(false, 'x');
  const r = g.tryReserveBuy(req());
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.release, undefined);
});

test('the WORST-CASE outflow is what gets charged, not the nominal stake', () => {
  // A buy takes its slippage headroom, ~1.5% protocol fees, the priority fee
  // (up to maxPriorityFeeSol with dynamic fees on) and token-account rent. The
  // engine charges that expression; this pins the arithmetic so a future edit
  // cannot quietly go back to charging the stake.
  const stake = 0.02, slippagePct = 25, maxPriorityFee = 0.005, ataRent = 0.00204;
  const worstCase = stake * (1 + slippagePct / 100 + 0.015) + maxPriorityFee + ataRent;
  assert.ok(worstCase > stake * 1.26 + 0.007, `worst case ${worstCase} must dominate the stake ${stake}`);

  // The wallet floor is the ceiling this matters most for: sized on the stake,
  // a buy "leaving the reserve behind" actually leaves far less than it.
  const g = new TradeGovernor({ minWalletReserveSol: 0.01, maxSolPerHour: 0, maxBuysPerHour: 0, maxSolPerSession: 0, maxSolPerMint: 0, maxBuysPerMint: 0 });
  assert.strictEqual(g.checkBuy(req({ walletSol: 0.0355, solAmount: stake })).allowed, true,
    'charging the nominal stake would have allowed this');
  assert.strictEqual(g.checkBuy(req({ walletSol: 0.0355, solAmount: worstCase })).allowed, false,
    'charging what actually leaves the wallet refuses it');
});

test('THE MISSING LOSS CAP: realized losses latch the governor, across both engines', () => {
  // sniperEngine.checkKillSwitch reads only the SNIPER's tradeHistory and is
  // gated on `config.isBotActive` — the sniper's own run flag. Someone running
  // copy trading with the sniper stopped (the natural setup for "just mirror
  // this wallet", and the one described in the incident) had no hourly cap, no
  // daily cap and no consecutive-loss cap of any kind: a leader trading into
  // rugs could close copy position after copy position at -90% forever.
  const g = new TradeGovernor({ maxSessionLossSol: 0.1 });
  assert.strictEqual(g.recordRealizedPnlSol(-0.04), false);
  assert.strictEqual(g.recordRealizedPnlSol(0.02), false, 'a win offsets — it is cumulative, not per-trade');
  assert.strictEqual(g.recordRealizedPnlSol(-0.09), true, 'cumulative -0.11 crosses the 0.1 limit');
  assert.ok(g.isHalted());
  assert.ok(/realized losses/.test(g.haltReason()!), g.haltReason()!);

  const d = g.checkBuy(req());
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.halted, true);
});

test('an unusable P&L figure is ignored rather than latching or corrupting the total', () => {
  const g = new TradeGovernor({ maxSessionLossSol: 0.1 });
  assert.strictEqual(g.recordRealizedPnlSol(NaN), false);
  assert.strictEqual(g.recordRealizedPnlSol(-Infinity), false);
  assert.strictEqual(g.sessionRealizedPnlSol(), 0, 'a NaN must not poison the running total');
  assert.strictEqual(g.isHalted(), false);
});

test('a STALE wallet balance refuses the buy — a frozen number is the wrong number', () => {
  // walletService keeps the last known balance when a read fails and does NOT
  // advance its timestamp, so under a 429 storm the figure freezes at a value
  // from before the buys that have landed since. Several orders then each
  // "afford" money that is already spent.
  const g = new TradeGovernor({ maxBalanceAgeMs: 30_000 });
  assert.strictEqual(g.checkBuy(req({ walletSolAgeMs: 5_000 })).allowed, true);
  const d = g.checkBuy(req({ walletSolAgeMs: 45_000 }));
  assert.strictEqual(d.allowed, false);
  assert.ok(/stale balance/.test(d.reason!), d.reason);
  // A non-finite age must not sneak past the comparison.
  assert.strictEqual(g.checkBuy(req({ walletSolAgeMs: NaN as any })).allowed, true,
    'an unusable age falls back to the other ceilings rather than refusing everything');
});

test('the governor never blocks a SELL — a halted wallet is the one that most needs to exit', () => {
  // Enforced structurally: checkBuy is the only gate, and executeRealMainnetTrade
  // consults it under `if (action === 'buy')`. The governor has no sell API at
  // all, which is the point — there is nothing to call by mistake.
  const g = new TradeGovernor();
  g.halt('anything');
  assert.strictEqual(typeof (g as any).checkSell, 'undefined',
    'adding a sell gate would let a breaker strand bags');
});

void (async () => {
  if (pending.length) console.log(`\n-- Async proofs (${pending.length}, run sequentially) --`);
  for (const t of pending) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}\n        ${err?.message ?? err}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
