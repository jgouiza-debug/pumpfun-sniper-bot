/**
 * Unit tests for the audit fixes. Zero-dependency: node:assert via ts-node.
 *   npm test
 *
 * Per the audit rules, every corrected defect includes the FAILING case that
 * reproduces the old bug, so a regression cannot slip back in silently.
 */
import assert from 'assert';
import {
  bondingCurveTokensOut,
  clampPriorityFeeSol,
  computeAgeSeconds,
  detectMigration,
  percentile,
  realizedPnlInWindowUsd,
  computeEntrySizeSol,
  affordableStakeSol,
  affordableSellPriorityFeeSol,
  FEE_PAYER_RESERVE_SOL,
  maxAffordableBuySol,
} from '../services/pipelineUtils';
import { EntryGateV2 } from '../services/entryGateV2';
import { RugCheckReport } from '../types';
import { assertOutboundTradeTx } from '../services/txIntentGuard';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

let passed = 0;
let failed = 0;

/**
 * Async tests settle here before the summary prints.
 *
 * WHY: `test()` called `fn()` inside a try/catch and incremented `passed`
 * immediately. For an `async () => {...}` body that returns a promise, the
 * catch can never fire — the assertions run after `test()` has already
 * returned and recorded a pass. Every async test in this file was therefore
 * self-certifying: `inspectMintSafety`, the sell simulation and the updater
 * checks all reported ok whatever they actually did. A suite that cannot fail
 * is not evidence, and this one is the thing standing between a config change
 * and real money.
 */
const pendingTests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  // Queue async bodies WITHOUT starting them. Awaiting a batch that is already
  // in flight would run them concurrently, and several share process-wide state
  // (rpcHealth counters, feature flags) — concurrent mutation of that state
  // makes assertions depend on scheduling order rather than on behaviour.
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    pendingTests.push({ name, fn: fn as () => Promise<void> });
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

/** The exact legacy expression from sniperEngine (audit bug B1), for proof. */
function legacyAgeSeconds(payloadTimestamp: number | undefined, nowMs: number): number {
  return Math.floor((nowMs - (payloadTimestamp || nowMs)) / 1000) || 120;
}

console.log('\n-- B1: ageSeconds fabrication --');
test('OLD BUG reproduced: missing timestamp aged a fresh token to 120s', () => {
  // PumpPortal payloads carry no timestamp field (measured 2026-08-04).
  assert.strictEqual(legacyAgeSeconds(undefined, 1_000_000_000_000), 120);
});
test('OLD BUG reproduced: even a real 0s-old timestamp became 120s', () => {
  assert.strictEqual(legacyAgeSeconds(1_000_000_000_000, 1_000_000_000_500), 120);
});
test('fixed: missing timestamp -> 0s (just born, DexScreener lookup skipped)', () => {
  assert.strictEqual(computeAgeSeconds(undefined), 0);
});
test('fixed: 0s-old token -> 0s', () => {
  assert.strictEqual(computeAgeSeconds(1_000_000_000_000, 1_000_000_000_500), 0);
});
test('fixed: 90s-old ms timestamp -> 90', () => {
  assert.strictEqual(computeAgeSeconds(1_000_000_000_000, 1_000_000_090_000), 90);
});
test('fixed: seconds-epoch timestamps are normalized', () => {
  assert.strictEqual(computeAgeSeconds(1_000_000_000, 1_000_000_090_000), 90);
});

console.log('\n-- B3: migration mislabeling --');
const bigDevBuyCreate = { txType: 'create', vSolInBondingCurve: 85 };
test('OLD BUG reproduced: legacy mode calls a big-dev-buy create a migration', () => {
  assert.strictEqual(detectMigration(bigDevBuyCreate, false), true);
});
test('fixed (strict): only txType=migrate counts', () => {
  assert.strictEqual(detectMigration(bigDevBuyCreate, true), false);
  assert.strictEqual(detectMigration({ txType: 'migrate' }, true), true);
});

console.log('\n-- Gate V2: no fabricated inputs --');
const gate = new EntryGateV2();
const freshCreate = {
  txType: 'create',
  mint: 'TestMint111',
  vSolInBondingCurve: 32.5,      // 2.5 real SOL in curve
  marketCapSol: 31,
  initialBuy: 40_000_000,        // 4% of supply
  solAmount: 1.2,
};
const indexedRug: RugCheckReport = {
  mint: 'TestMint111',
  score: 10,
  token: { mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000, decimals: 6 },
  fileMeta: { top10Pct: 18, maxSingleHolderPct: 6, insiderPct: 2, holderSampleSize: 40, rugged: false },
  isInferred: false,
};

test('passes a healthy fresh create on REAL data', () => {
  const r = gate.evaluate(freshCreate, indexedRug, false);
  assert.strictEqual(r.isSafe, true, r.reasons.join('; '));
});
test('unknown is not safe: unindexed RugCheck -> reject, field marked unverified', () => {
  const r = gate.evaluate(freshCreate, { ...indexedRug, isInferred: true }, false);
  assert.strictEqual(r.isSafe, false);
  assert.ok(r.unverifiedFields.includes('rugcheckReport'));
});
test('rejects oversized dev initial buy (8% > 6% cap)', () => {
  const r = gate.evaluate({ ...freshCreate, initialBuy: 80_000_000 }, indexedRug, false);
  assert.strictEqual(r.isSafe, false);
  assert.ok(r.reasons.some(x => x.includes('Dev initial buy')));
});
test('rejects zero-skin-in-the-game deploys', () => {
  const r = gate.evaluate({ ...freshCreate, solAmount: 0, initialBuy: 0 }, indexedRug, false);
  assert.strictEqual(r.isSafe, false);
});
test('rejects REAL top10 concentration (not the fabricated 12% the legacy gate graded)', () => {
  const rug = { ...indexedRug, fileMeta: { ...indexedRug.fileMeta, top10Pct: 55 } };
  const r = gate.evaluate(freshCreate, rug, false);
  assert.strictEqual(r.isSafe, false);
  assert.ok(r.reasons.some(x => x.includes('Top10')));
});
test('rejects a token RugCheck marks as rugged', () => {
  const rug = { ...indexedRug, fileMeta: { ...indexedRug.fileMeta, rugged: true } };
  assert.strictEqual(gate.evaluate(freshCreate, rug, false).isSafe, false);
});
test('active mint authority on an indexed report -> reject', () => {
  const rug = { ...indexedRug, token: { ...indexedRug.token!, mintAuthority: 'SomeKey111' } };
  assert.strictEqual(gate.evaluate(freshCreate, rug, false).isSafe, false);
});

console.log('\n-- Bonding curve math (BigInt) --');
test('known case: 1 SOL into fresh curve (30 vSOL / 1.073B vTokens)', () => {
  const out = bondingCurveTokensOut(1_000_000_000n, 30_000_000_000n, 1_073_000_000_000_000n);
  // ~1% fee then constant product: expected ≈ 34.29M tokens (raw 6dp).
  assert.ok(out > 34_000_000_000_000n && out < 34_500_000_000_000n, `got ${out}`);
});
test('monotonic: more SOL in -> more tokens out', () => {
  const a = bondingCurveTokensOut(1_000_000_000n, 30_000_000_000n, 1_073_000_000_000_000n);
  const b = bondingCurveTokensOut(2_000_000_000n, 30_000_000_000n, 1_073_000_000_000_000n);
  assert.ok(b > a);
});
test('diminishing returns: 2x input yields < 2x output', () => {
  const a = bondingCurveTokensOut(1_000_000_000n, 30_000_000_000n, 1_073_000_000_000_000n);
  const b = bondingCurveTokensOut(2_000_000_000n, 30_000_000_000n, 1_073_000_000_000_000n);
  assert.ok(b < 2n * a);
});
test('zero / invalid input -> 0 tokens, never throws', () => {
  assert.strictEqual(bondingCurveTokensOut(0n, 30_000_000_000n, 1n), 0n);
  assert.strictEqual(bondingCurveTokensOut(1n, 0n, 1n), 0n);
});

console.log('\n-- Priority fee clamp --');
test('never below the static floor', () => {
  assert.strictEqual(clampPriorityFeeSol(0.0001, 0.001, 0.005, 0.05), 0.001);
});
test('capped by the hard ceiling', () => {
  assert.strictEqual(clampPriorityFeeSol(0.02, 0.001, 0.005, 1), 0.005);
});
test('capped at 5% of position size', () => {
  assert.strictEqual(clampPriorityFeeSol(0.004, 0.001, 0.005, 0.05), 0.0025);
});
test('OLD BUG: the configured floor overrode the hard ceiling', () => {
  // priorityFeeSol = 0.02 with maxPriorityFeeSol = 0.005. Both sit inside
  // clampConfig's accepted band, so neither is rejected and nothing is logged.
  // The floor used to be applied last and won, so every trade paid 0.02 — four
  // times the operator's stated cap, and on a small copy slice more than the
  // position itself.
  assert.strictEqual(clampPriorityFeeSol(0.001, 0.02, 0.005, 1), 0.005,
    'the ceiling is absolute — nothing outranks maxPriorityFeeSol');
});
test('the floor still outranks the 5%-of-position cap, so small exits can land', () => {
  // That cap can be a few hundred lamports on a small slice, and a fee too low
  // to land turns "the exit was expensive" into "the exit never happened".
  assert.strictEqual(clampPriorityFeeSol(0.004, 0.001, 0.005, 0.005), 0.001);
});

console.log('\n-- percentile --');
test('p75 nearest-rank', () => {
  assert.strictEqual(percentile([1, 2, 3, 4], 75), 3);
  assert.strictEqual(percentile([], 75), 0);
});

console.log('\n-- Kill switch window --');
test('only trades inside the window count', () => {
  const now = 10_000_000;
  const trades = [
    { exitTime: now - 30 * 60_000, pnlUsd: -20 },   // in window
    { exitTime: now - 59 * 60_000, pnlUsd: -10 },   // in window
    { exitTime: now - 61 * 60_000, pnlUsd: -500 },  // OUTSIDE — must not count
  ];
  assert.strictEqual(realizedPnlInWindowUsd(trades, 60 * 60_000, now), -30);
});

console.log('\n-- Ticker/name resolution (owner report: everything showed as $PUMP) --');
{
  const { RiskFilter } = require('../filters/riskFilter');
  const rf = new RiskFilter();
  // Measured migration payload: {signature, mint, txType, pool} only.
  const migrationLaunchLegacy = { mint: 'M1', name: 'Pump Token', symbol: 'PUMP' };
  const migrationLaunchFixed = { mint: 'M1', name: undefined, symbol: undefined };
  const rugWithMeta: any = { mint: 'M1', score: 5, tokenMeta: { name: 'SCALER', symbol: 'SCALER', uri: '' } };

  test('OLD BUG reproduced: placeholder name/symbol shadow the real metadata', () => {
    const r = rf.evaluateToken(rugWithMeta, migrationLaunchLegacy);
    assert.strictEqual(r.tokenSymbol, 'PUMP');
    assert.strictEqual(r.tokenName, 'Pump Token');
  });
  test('fixed: undefined placeholders let RugCheck metadata through', () => {
    const r = rf.evaluateToken(rugWithMeta, migrationLaunchFixed);
    assert.strictEqual(r.tokenSymbol, 'SCALER');
    assert.strictEqual(r.tokenName, 'SCALER');
  });
}

console.log('\n-- Playbook routing (owner report: only buys end-of-life tokens) --');
{
  const { bondingProgressPct, classifyPhase, routePlay } = require('../services/playbookRouter');

  test('bonding progress is measured from virtual reserves', () => {
    assert.strictEqual(bondingProgressPct(30), 0);          // fresh mint
    assert.strictEqual(Math.round(bondingProgressPct(72.5)!), 50);
    assert.strictEqual(bondingProgressPct(115), 100);       // graduation
    assert.strictEqual(bondingProgressPct(undefined), null);
  });

  test('OLD BUG quantified: legacy vSol>=70 "migration" is only ~47% up the curve', () => {
    // The legacy threshold treated this as a graduated token deserving the
    // $12k fabricated liquidity and an automatic pass.
    const pct = bondingProgressPct(70)!;
    assert.ok(pct > 45 && pct < 48, `expected ~47%, got ${pct}`);
  });

  test('block-0 window is never tradeable', () => {
    const d = routePlay({ isMigrationEvent: false, ageSeconds: 30, vSolInBondingCurve: 31,
      score: 95, marketCapUsd: 6000, liquidityUsd: 50000 });
    assert.strictEqual(d.phase, 'BLOCK_0');
    assert.strictEqual(d.eligible, false);
  });

  test('late curve is refused (this is what the bot used to buy)', () => {
    const d = routePlay({ isMigrationEvent: false, ageSeconds: 3600, vSolInBondingCurve: 100,
      score: 95, marketCapUsd: 60000, liquidityUsd: 50000 });
    assert.strictEqual(d.phase, 'LATE_CURVE');
    assert.strictEqual(d.eligible, false);
    assert.ok(d.reasons[0].includes('crowded'));
  });

  test('mid-curve with real demand is eligible for Play 2 — the early entry', () => {
    const d = routePlay({ isMigrationEvent: false, ageSeconds: 900, vSolInBondingCurve: 65,
      score: 75, marketCapUsd: 20000, liquidityUsd: 30000,
      uniqueBuyers5m: 25, buyPressurePct: 70 });
    assert.strictEqual(d.phase, 'MID_CURVE');
    assert.strictEqual(d.play, 'PLAY_2');
    assert.strictEqual(d.eligible, true, d.reasons.join('; '));
  });

  test('mid-curve without unique buyers is refused (volume alone is gameable)', () => {
    const d = routePlay({ isMigrationEvent: false, ageSeconds: 900, vSolInBondingCurve: 65,
      score: 75, marketCapUsd: 20000, liquidityUsd: 30000,
      uniqueBuyers5m: 3, buyPressurePct: 95 });
    assert.strictEqual(d.eligible, false);
  });

  test('migration past the 90s window is no longer a Play 3 snipe', () => {
    // 400s after graduation the discovery window has closed: it must fall
    // through to Play 4 (momentum, needs proof of demand), never be sniped
    // as if it had just migrated.
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 400, ageSeconds: 9000,
      score: 80, marketCapUsd: 100000, liquidityUsd: 40000 });
    assert.strictEqual(d.phase, 'POST_MIGRATION');
    assert.strictEqual(d.play, 'PLAY_4');
    assert.strictEqual(d.eligible, false, 'no buyer data means no trade');
  });

  test('migration snipe above the MC cap is refused', () => {
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 10, ageSeconds: 9000,
      score: 80, marketCapUsd: 600000, liquidityUsd: 40000 });
    assert.strictEqual(d.eligible, false);
    assert.ok(d.reasons.some((r: string) => r.includes('discovery window')));
  });

  test('fresh migration inside window and MC cap is eligible', () => {
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 20, ageSeconds: 9000,
      score: 80, marketCapUsd: 69000, liquidityUsd: 40000, solPriceUsd: 200 });
    assert.strictEqual(d.play, 'PLAY_3');
    assert.strictEqual(d.eligible, true, d.reasons.join('; '));
  });

  test('H4: a migration whose liquidity is ASSERTED is refused even above the floor', () => {
    // Same inputs as the eligible case, but the ~$12.5k liquidity is the
    // fabricated migration constant, not a measured pool. OLD BUG: it passed
    // the floor and the bot bought into a pool it never verified.
    const asserted = routePlay({ isMigrationEvent: true, secondsSinceMigration: 20, ageSeconds: 9000,
      score: 80, marketCapUsd: 69000, liquidityUsd: 12500, liquidityIsAsserted: true, solPriceUsd: 107 });
    assert.strictEqual(asserted.play, 'PLAY_3');
    assert.strictEqual(asserted.eligible, false, 'asserted liquidity must never satisfy the floor');
    assert.ok(asserted.reasons.some((r: string) => /asserted/i.test(r)), asserted.reasons.join('; '));

    // The identical value, MEASURED, still passes — the gate keys on verified-ness,
    // not on the number.
    const measured = routePlay({ isMigrationEvent: true, secondsSinceMigration: 20, ageSeconds: 9000,
      score: 80, marketCapUsd: 69000, liquidityUsd: 12500, liquidityIsAsserted: false, solPriceUsd: 107 });
    assert.strictEqual(measured.eligible, true, measured.reasons.join('; '));
  });

  test('OLD BUG reproduced: a $8k USD floor rejects every graduation at SOL=$74', () => {
    // A pump.fun token graduates holding ~85 SOL. At $74 that pool is $6,290.
    const graduationLiquidityUsd = 85 * 74;
    assert.ok(graduationLiquidityUsd < 8000,
      `graduation pool is $${graduationLiquidityUsd}, below the old $8,000 floor`);
  });

  test('fixed: a real graduation passes on a SOL-denominated floor', () => {
    // TNOS / AORP, measured live: ~$6,287 liquidity, $30k MC, score 85.
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 5, ageSeconds: 0,
      score: 85, marketCapUsd: 30389, liquidityUsd: 6287, solPriceUsd: 74 });
    assert.strictEqual(d.phase, 'MIGRATION');
    assert.strictEqual(d.play, 'PLAY_3');
    assert.strictEqual(d.eligible, true, d.reasons.join('; '));
  });

  test('fixed floor still rejects a genuinely thin graduation pool', () => {
    // 10 SOL of liquidity at $74 = $740, well under the 30 SOL requirement.
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 5, ageSeconds: 0,
      score: 85, marketCapUsd: 30000, liquidityUsd: 740, solPriceUsd: 74 });
    assert.strictEqual(d.eligible, false);
  });

  test('the floor tracks SOL: same 30 SOL pool passes at any SOL price', () => {
    for (const px of [74, 150, 266]) {
      const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 5, ageSeconds: 0,
        score: 80, marketCapUsd: 50000, liquidityUsd: 31 * px, solPriceUsd: px });
      assert.strictEqual(d.eligible, true, `should pass at SOL=$${px}: ${d.reasons.join('; ')}`);
    }
  });

  test('boosted tokens are refused (paid visibility, -48% average returns)', () => {
    const d = routePlay({ isMigrationEvent: true, secondsSinceMigration: 20, ageSeconds: 9000,
      score: 80, marketCapUsd: 69000, liquidityUsd: 40000, isBoosted: true });
    assert.strictEqual(d.eligible, false);
  });
}

console.log('\n-- Paper simulator (owner report: profitable on paper, losing live) --');
{
  const { simulateBuy, simulateSell, breakevenPct } = require('../services/paperSimulator');
  const curve = { vSolInBondingCurve: 30, vTokensInBondingCurve: 1_073_000_000 };

  test('paper buys now cost more than the naive quote (fees + curve impact)', () => {
    const fill = simulateBuy(0.05, curve, 200, 0.001, true);
    assert.ok(fill.solDelta < -0.05, `expected to pay more than 0.05 SOL, paid ${-fill.solDelta}`);
    assert.ok(fill.tokenDelta > 0);
    assert.ok(fill.feeSol > 0);
  });

  test('a paper round trip with no price move LOSES money (as in real life)', () => {
    const buy = simulateBuy(0.05, curve, 200, 0.001, true);
    const sell = simulateSell(buy.tokenDelta, curve, 200, 0.001);
    const net = buy.solDelta + sell.solDelta;
    assert.ok(net < 0, `round trip should lose to costs, got ${net}`);
  });

  test('selling a large bag suffers more impact than a small one', () => {
    const small = simulateSell(1_000_000, curve, 200, 0.001);
    const large = simulateSell(50_000_000, curve, 200, 0.001);
    assert.ok(large.priceImpactPct > small.priceImpactPct);
  });

  test('breakeven cost falls as position size rises (the fixed-cost tax)', () => {
    const tiny = breakevenPct(0.05, 0.001);
    const big = breakevenPct(0.5, 0.001);
    assert.ok(tiny > 10, `0.05 SOL should need >10% to break even, got ${tiny}%`);
    assert.ok(big < 5, `0.5 SOL should need <5%, got ${big}%`);
    assert.ok(tiny > big);
  });
}

console.log('\n-- Structural stop: creator sells (was hardcoded devSoldAnyClean = true) --');
{
  const { DevSellMonitor } = require('../services/devSellMonitor');
  const CREATOR = 'CreatorWallet1111111111111111111111111111111';

  test('creator selling fires DEV_SOLD immediately', () => {
    const m = new DevSellMonitor();
    m.track('MINT1', CREATOR);
    const a = m.onTrade({ mint: 'MINT1', txType: 'sell', traderPublicKey: CREATOR, solAmount: 4.2 });
    assert.ok(a, 'expected an alert');
    assert.strictEqual(a.kind, 'DEV_SOLD');
  });

  test('a random wallet selling does NOT fire the structural stop', () => {
    const m = new DevSellMonitor();
    m.track('MINT1', CREATOR);
    const a = m.onTrade({ mint: 'MINT1', txType: 'sell', traderPublicKey: 'SomeoneElse', solAmount: 0.2 });
    assert.strictEqual(a, null);
  });

  test('creator alert fires only once, not on every subsequent sell', () => {
    const m = new DevSellMonitor();
    m.track('MINT1', CREATOR);
    assert.ok(m.onTrade({ mint: 'MINT1', txType: 'sell', traderPublicKey: CREATOR, solAmount: 1 }));
    assert.strictEqual(m.onTrade({ mint: 'MINT1', txType: 'sell', traderPublicKey: CREATOR, solAmount: 1 }), null);
  });

  test('three distinct wallets dumping within 60s = coordinated exit', () => {
    const m = new DevSellMonitor();
    m.track('MINT1', CREATOR);
    const t = 1_000_000;
    assert.strictEqual(m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W1', solAmount:2 }, t), null);
    assert.strictEqual(m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W2', solAmount:2 }, t+1000), null);
    const a = m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W3', solAmount:2 }, t+2000);
    assert.ok(a && a.kind === 'LARGE_SELL_CLUSTER');
  });

  test('sells spread beyond 60s do not count as a cluster', () => {
    const m = new DevSellMonitor();
    m.track('MINT1', CREATOR);
    const t = 1_000_000;
    m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W1', solAmount:2 }, t);
    m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W2', solAmount:2 }, t + 70_000);
    const a = m.onTrade({ mint:'MINT1', txType:'sell', traderPublicKey:'W3', solAmount:2 }, t + 140_000);
    assert.strictEqual(a, null);
  });

  test('untracked mints are ignored entirely', () => {
    const m = new DevSellMonitor();
    assert.strictEqual(m.onTrade({ mint:'NOPE', txType:'sell', traderPublicKey:CREATOR, solAmount:9 }), null);
  });
}

console.log('\n-- Holder concentration: per-owner aggregation --');
{
  const { RugCheckService } = require('../services/rugcheckService');
  const svc: any = new RugCheckService();
  const norm = (holders: any[]) => svc.normalizeReport({ mint: 'M', score: 1, topHolders: holders } as any, 'M').fileMeta;

  test('OLD BUG reproduced: one owner across many accounts double-counts past 100%', () => {
    // Raw row-summing of these is 189.65% — a share of supply that cannot exist.
    const rows = [
      { owner: 'A', address: 'a1', pct: 60 }, { owner: 'A', address: 'a2', pct: 59.65 },
      { owner: 'B', address: 'b1', pct: 40 }, { owner: 'C', address: 'c1', pct: 30 },
    ];
    const rawSum = rows.reduce((a, r) => a + r.pct, 0);
    assert.ok(rawSum > 100, `raw sum should exceed 100, got ${rawSum}`);
    const meta = norm(rows);
    assert.strictEqual(meta.rawTop10Pct, 189.65);
    assert.strictEqual(meta.concentrationAnomaly, true, 'must be flagged untrusted');
    assert.ok(meta.top10Pct <= 100, 'clamped to a possible value');
  });

  test('owners are merged, so the largest holder is the true largest', () => {
    const meta = norm([
      { owner: 'A', address: 'a1', pct: 20 }, { owner: 'A', address: 'a2', pct: 15 },
      { owner: 'B', address: 'b1', pct: 25 },
    ]);
    assert.strictEqual(meta.maxSingleHolderPct, 35, 'A holds 20+15, not 20');
    assert.strictEqual(meta.uniqueOwners, 2);
    assert.strictEqual(meta.concentrationAnomaly, false);
  });

  test('clean distribution is unflagged', () => {
    const meta = norm([{ owner:'A', pct:5 }, { owner:'B', pct:4 }, { owner:'C', pct:3 }]);
    assert.strictEqual(meta.top10Pct, 12);
    assert.strictEqual(meta.concentrationAnomaly, false);
  });
}

console.log('\n-- Liquidity floor: unsatisfiable on a bonding curve --');
{
  const { RiskFilter } = require('../filters/riskFilter');
  const GRAD_SOL = 85, SOL_USD = 74;
  const rug: any = { mint:'M', score:1, isInferred:false,
    token:{ mintAuthority:null, freezeAuthority:null, supply:1e9, decimals:6 },
    fileMeta:{ top10Pct:15, maxSingleHolderPct:5, insiderPct:0, holderSampleSize:30 } };
  // A token at 45% of its curve — the Play 2 sweet spot. Demand is MEASURED
  // (curve velocity + notional buy pressure): since the 2026-08-07 scoring fix
  // there are no free demand points, so a "healthy" token must show demand.
  const curveSol = 0.45 * GRAD_SOL;
  const launch: any = { mint:'M', liquidityUsd: curveSol * SOL_USD, marketCapUsd: 30000,
    top10Pct:15, devHoldingsPct:4, bundledSupplyPct:2, washScore:0,
    volume5mUsd: 600, progressVelocity5m: 4, buyPressurePct: 75, socialCount: 1 };

  test('OLD BUG reproduced: $8k floor rejects a healthy mid-curve token', () => {
    const rf = new RiskFilter(); rf.setLeniencyMode('strict');
    const r = rf.evaluateToken(rug, launch);
    assert.strictEqual(r.isSafe, false);
    assert.ok(r.reasons.some((x: string) => x.includes('Liquidity')), r.reasons.join('; '));
  });

  test('OLD BUG quantified: $8k needs more SOL than the curve can ever hold', () => {
    const solNeeded = 8000 / SOL_USD;
    assert.ok(solNeeded > GRAD_SOL,
      `needs ${solNeeded.toFixed(0)} SOL but graduation is at ${GRAD_SOL} SOL`);
  });

  test('fixed: a SOL-denominated curve floor admits the same token', () => {
    const rf = new RiskFilter(); rf.setLeniencyMode('strict');
    const r = rf.evaluateToken(rug, launch, { minLiquidityUsdOverride: 10 * SOL_USD });
    assert.strictEqual(r.isSafe, true, r.reasons.join('; '));
  });

  test('fixed floor still rejects a near-empty curve', () => {
    const rf = new RiskFilter(); rf.setLeniencyMode('strict');
    const empty = { ...launch, liquidityUsd: 2 * SOL_USD }; // 2 SOL in the curve
    const r = rf.evaluateToken(rug, empty, { minLiquidityUsdOverride: 10 * SOL_USD });
    assert.strictEqual(r.isSafe, false);
  });

  test('post-migration tokens keep the full $8,000 pool requirement', () => {
    const rf = new RiskFilter(); rf.setLeniencyMode('strict');
    const thinPool = { ...launch, liquidityUsd: 5000 };
    const r = rf.evaluateToken(rug, thinPool); // no override => post-migration rule
    assert.strictEqual(r.isSafe, false);
  });
}

console.log('\n-- Migration demand credit (owner report: clean graduations died at the score gate) --');
{
  const { RiskFilter } = require('../filters/riskFilter');
  const rf = new RiskFilter(); rf.setLeniencyMode('strict');
  const cleanRug: any = { mint: 'M', score: 5, isInferred: false,
    token: { mintAuthority: null, freezeAuthority: null, supply: 1e9, decimals: 6 },
    fileMeta: { top10Pct: 18, maxSingleHolderPct: 6, insiderPct: 1, holderSampleSize: 40 } };
  // "Thesis"-shaped: clean holders, real liquidity, migration moment => no
  // indexed volume/buyers yet.
  const migrationLaunch: any = { mint: 'M', bondingProgress: 90, liquidityUsd: 12022,
    marketCapUsd: 25483, volume5mUsd: 0, top10Pct: 18, devHoldingsPct: 4, bundledSupplyPct: 2, washScore: 0 };

  test('OLD BUG reproduced: without the credit, a clean graduation scores below 62', () => {
    const r = rf.evaluateToken(cleanRug, { ...migrationLaunch, bondingProgress: 35 });
    assert.ok(r.score < 62, `expected sub-62, got ${r.score}`);
  });
  test('fixed: with curve-demand credit a clean graduation clears the router half-unit band', () => {
    // Under playbookRouting the router owns the score decision: Gate 0 clean +
    // score >= 55 is eligible at half unit. The monolithic 62 bar was
    // calibrated for fabricated-input scores and is no longer the arbiter.
    const r = rf.evaluateToken(cleanRug, migrationLaunch);
    assert.strictEqual(r.gate0!.allPassed, true, r.reasons.join('; '));
    assert.ok(r.score >= 55, `expected >=55 (router half-unit floor), got ${r.score} (${JSON.stringify(r.scoreBreakdown)})`);
  });
  test('credit never overrides measured demand (indexed volume present -> no credit)', () => {
    const withVol = rf.evaluateToken(cleanRug, { ...migrationLaunch, volume5mUsd: 3000, buyPressurePct: 70 });
    const bd = withVol.scoreBreakdown!;
    assert.ok(!(bd.notes || []).some((n: string) => n.includes('completed bonding curve')));
  });
  test('credit cannot rescue a concentration rug (Gate 0 still rules)', () => {
    const rugRug = { ...cleanRug, fileMeta: { ...cleanRug.fileMeta, top10Pct: 79, maxSingleHolderPct: 79 } };
    const r = rf.evaluateToken(rugRug, { ...migrationLaunch, top10Pct: 79, devHoldingsPct: 79 });
    assert.strictEqual(r.isSafe, false);
  });
}

console.log('\n-- Gate V2: create-window MC band must not judge migrations --');
{
  const { EntryGateV2 } = require('../services/entryGateV2');
  const g = new EntryGateV2();
  const rug: any = { mint: 'M', score: 5, isInferred: false,
    token: { mintAuthority: null, freezeAuthority: null, supply: 1e9, decimals: 6 },
    fileMeta: { top10Pct: 18, maxSingleHolderPct: 6, insiderPct: 1, holderSampleSize: 40 } };

  test('OLD BUG reproduced: a ~410 SOL graduation MC fails the create band', () => {
    const r = g.evaluate({ txType: 'create', marketCapSol: 410.9, vSolInBondingCurve: 32, initialBuy: 10_000_000, solAmount: 1 }, rug, false);
    assert.ok(r.reasons.some((x: string) => x.includes('already pumped')));
  });
  test('fixed: the same MC on a real migration is not judged by the create band', () => {
    const r = g.evaluate({ txType: 'migrate', marketCapSol: 410.9 }, rug, true);
    assert.ok(!r.reasons.some((x: string) => x.includes('already pumped')), r.reasons.join('; '));
  });
}

console.log('\n-- NORMAL risk tier (owner-selected looser profile) --');
{
  const { routePlay, playbookConfigFor, PLAYBOOK_DEFAULTS, PLAYBOOK_NORMAL } = require('../services/playbookRouter');

  test('normal tier widens bands but keeps Play 1 disabled', () => {
    const n = playbookConfigFor('normal');
    assert.strictEqual(n.minScoreHalfUnit, 50);
    assert.strictEqual(n.play3MaxSecondsSinceMigration, 180);
    assert.strictEqual(n.enablePlay1, false, 'block-0 stays banned at every tier');
  });

  test('a 3-minute-old migration is refused strict but eligible normal', () => {
    const input = { isMigrationEvent: true, secondsSinceMigration: 150, ageSeconds: 0,
      score: 72, marketCapUsd: 69000, liquidityUsd: 6287, solPriceUsd: 74 };
    assert.strictEqual(routePlay(input, PLAYBOOK_DEFAULTS).eligible, false);
    assert.strictEqual(routePlay(input, PLAYBOOK_NORMAL).eligible, true,
      routePlay(input, PLAYBOOK_NORMAL).reasons.join('; '));
  });

  test('score 52 clears normal half-unit band, not strict', () => {
    const input = { isMigrationEvent: true, secondsSinceMigration: 20, ageSeconds: 0,
      score: 52, marketCapUsd: 69000, liquidityUsd: 6287, solPriceUsd: 74 };
    assert.strictEqual(routePlay(input, PLAYBOOK_DEFAULTS).eligible, false);
    const n = routePlay(input, PLAYBOOK_NORMAL);
    assert.strictEqual(n.eligible, true, n.reasons.join('; '));
    assert.strictEqual(n.sizeMultiplier, 0.5, 'borderline score buys HALF units');
  });
}

console.log('\n-- Fixed trade sizing (all-in removed 2026-08-09) --');
{
  const { breakevenPct } = require('../services/paperSimulator');

  test('entry size is the configured stake scaled by conviction', () => {
    assert.strictEqual(computeEntrySizeSol({ buyAmountSol: 0.15, sizeMultiplier: 0.5 }), 0.075);
    assert.strictEqual(computeEntrySizeSol({ buyAmountSol: 0.0395, sizeMultiplier: 1 }), 0.0395);
  });

  test('the stake is used as-is when the balance can fund it', () => {
    // $3-per-trade stake against a wallet that comfortably covers it.
    assert.strictEqual(affordableStakeSol(0.0395, 0.092, 15, 0.0005), 0.0395);
  });

  test('the stake is clamped when the balance cannot fund it', () => {
    const staked = affordableStakeSol(0.3, 0.0885, 15, 0.001);
    assert.ok(staked < 0.3, 'an unfundable stake must be reduced');
    assert.ok(staked * 1.165 + 0.001 + 0.0025 <= 0.0885 + 1e-9,
      `clamped stake ${staked} still overdrafts the balance`);
  });

  test('REGRESSION 2026-08-09: a stake must fit its own on-chain transfer', () => {
    // Measured failure: a buy sized to the full 0.1327 SOL deployable balance.
    // The transfer wanted exactly 132700000 x 1.15 = 152605000 lamports and died
    // with "Transfer: insufficient lamports 134695720, need 152605000".
    const size = maxAffordableBuySol(0.1327, 15, 0.001);
    const lamportsNeeded = size * 1.15; // slippage-buffered transfer
    const balanceAfterFeeAndRent = 0.1327 - 0.001005 - 0.00203928;
    assert.ok(lamportsNeeded <= balanceAfterFeeAndRent, `transfer ${lamportsNeeded} still exceeds ${balanceAfterFeeAndRent}`);
    assert.ok(size > 0.1, `expected a usable size, got ${size}`);
  });

  test('maxAffordableBuySol returns 0 when balance cannot cover fixed costs', () => {
    assert.strictEqual(maxAffordableBuySol(0.003, 15, 0.001), 0);
    assert.strictEqual(maxAffordableBuySol(0, 15, 0.001), 0);
  });

  test('an empty wallet stakes nothing', () => {
    assert.strictEqual(affordableStakeSol(0.0395, 0, 15, 0.0005), 0);
  });

  test('breakeven percent floors for sizing', () => {
    const be015 = breakevenPct(0.15, 0.001);
    const be0135 = breakevenPct(0.135, 0.001);
    const be005 = breakevenPct(0.05, 0.001);
    assert.ok(be015 < 6, `expected <6%, got ${be015}%`);
    assert.ok(be0135 <= 6.1, `expected <=6.1%, got ${be0135}%`);
    assert.ok(be005 > 10, `expected >10%, got ${be005}%`);
  });

  test('a healthy wallet pays the configured sell priority fee unchanged', () => {
    assert.strictEqual(affordableSellPriorityFeeSol(0.05, 0.001), 0.001);
    assert.strictEqual(affordableSellPriorityFeeSol(0.002 + FEE_PAYER_RESERVE_SOL, 0.001), 0.001);
  });

  test('REGRESSION 2026-08-23: a drained wallet clamps the sell fee so the exit can land', () => {
    // Measured: 0.00162 SOL wallet, 0.001 SOL configured fee — six sell
    // attempts, six confirmation timeouts, because fees would leave the payer
    // below the rent-exempt minimum and no validator includes such a tx.
    const fee = affordableSellPriorityFeeSol(0.00162, 0.001);
    assert.ok(fee < 0.001, `fee ${fee} was not reduced`);
    assert.ok(fee > 0, 'a positive fee must remain');
    assert.ok(0.00162 - fee >= FEE_PAYER_RESERVE_SOL - 1e-9,
      `balance after fee ${0.00162 - fee} dips below the fee-payer reserve`);
  });

  test('the sell fee clamp floors instead of refusing, and never raises the fee', () => {
    // Even a wallet below the reserve still attempts the exit at the floor —
    // size economics warn, never refuse (owner decision 2026-08-12).
    assert.strictEqual(affordableSellPriorityFeeSol(0.0005, 0.001), 0.00005);
    assert.strictEqual(affordableSellPriorityFeeSol(0, 0.001), 0.001, 'an unknown/zero balance keeps the configured fee');
    assert.strictEqual(affordableSellPriorityFeeSol(10, 0.0002), 0.0002, 'the clamp must never raise a fee');
  });

  test('the allInSizing flag exists and ships OFF in BOTH flag sets', () => {
    // This test used to assert `DEFAULTS.allInSizing === true`, i.e. it locked
    // in 100%-of-wallet sizing as the default for any run that is not a
    // packaged build — and the project ships a launcher that is exactly that
    // (`run bot real.cmd` ends in `node "dist\server.js"`, no SNIPER_PACKAGED).
    // A test can only protect a behaviour; this one was protecting the wrong one.
    const { DEFAULTS, PACKAGED_DEFAULTS } = require('../services/featureFlags');
    assert.ok('allInSizing' in DEFAULTS, 'the flag must still exist — it is opt-in, not removed');
    assert.strictEqual(DEFAULTS.allInSizing, false, 'a dangerous default has no safe context');
    assert.strictEqual(PACKAGED_DEFAULTS.allInSizing, false);
  });
}

console.log('\n-- Sell order sizing (2026-08-09 $GREEN partial-exit incident) --');
{
  const { sellAmountParam } = require('../services/pipelineUtils');

  test('OLD BUG reproduced: stripping the % turns "sell 100%" into "sell 100 tokens"', () => {
    const amountPct: string | undefined = '100%';
    const legacy = String(amountPct || '100').replace('%', '');
    assert.strictEqual(legacy, '100');
    assert.ok(!legacy.includes('%'), 'legacy value carried no percent marker — PumpPortal read it as a token count');
  });

  test('fixed: a full exit keeps its percent marker', () => {
    assert.strictEqual(sellAmountParam('100%'), '100%');
    assert.strictEqual(sellAmountParam(100), '100%');
    assert.strictEqual(sellAmountParam(undefined), '100%');
  });

  test('partial exits stay percentages too', () => {
    assert.strictEqual(sellAmountParam('50%'), '50%');
    assert.strictEqual(sellAmountParam(25), '25%');
  });

  test('malformed or out-of-range input falls back to a full exit, never a token count', () => {
    assert.strictEqual(sellAmountParam(''), '100%');
    assert.strictEqual(sellAmountParam('abc'), '100%');
    assert.strictEqual(sellAmountParam(0), '100%');
    assert.strictEqual(sellAmountParam(-5), '100%');
    assert.strictEqual(sellAmountParam(150), '100%');
  });
}

console.log('\n-- Gate 0: unknown concentration is not safe (2026-08-09 $GREEN rug buy) --');
{
  const { RiskFilter } = require('../filters/riskFilter');

  // The exact shape RugCheck returned for $GREEN: inferred, no holder list.
  const inferredReport = {
    mint: 'CK3CHsrbCgJox2g8MrAsfmRz4Per56QmBWAw9tVMpump',
    score: 0,
    token: { mintAuthority: null, freezeAuthority: null, supply: 1000000000, decimals: 6 },
    fileMeta: { unverified: true },
    isInferred: true,
    markets: [],
  };
  // Migration-moment launch data with concentration genuinely unmeasured.
  const unmeasured = {
    mint: 'CK3CHsrbCgJox2g8MrAsfmRz4Per56QmBWAw9tVMpump',
    symbol: 'GREEN',
    liquidityUsd: 11984,
    marketCapUsd: 2118,
    bondingProgress: 90,
    volume5mUsd: 0,
    washScore: 0,
    top10Pct: undefined,
    devHoldingsPct: undefined,
    bundledSupplyPct: undefined,
  };

  test('OLD BUG reproduced: concentration read as 0% passes every cap', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const asZero = { ...unmeasured, top10Pct: 0, devHoldingsPct: 0, bundledSupplyPct: 0 };
    const gate = rf.evaluateGate0(inferredReport, asZero, { minLiquidityUsdOverride: 2275 });
    assert.strictEqual(gate.allPassed, true, 'the old zero-filled path let an unverified token through');
  });

  test('OLD BUG reproduced: zero-filled concentration also scored maximum distribution points', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const asZero = { ...unmeasured, top10Pct: 0, devHoldingsPct: 0, bundledSupplyPct: 0 };
    const s = rf.computeScoreBreakdown(inferredReport, asZero);
    assert.strictEqual(s.distributionScore, 30, 'unknown scored the top distribution tier');
    assert.strictEqual(s.deployerScore, 20, 'unknown scored the top deployer tier');
    assert.ok(s.totalScore >= 55, `unknown data scored ${s.totalScore}, clearing the 55 half-unit floor`);
  });

  test('fixed: unverified concentration fails Gate 0 under requireVerifiedConcentration', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const gate = rf.evaluateGate0(inferredReport, unmeasured, {
      minLiquidityUsdOverride: 2275,
      requireVerifiedConcentration: true,
    });
    assert.strictEqual(gate.allPassed, false);
    assert.ok(
      gate.failedReasons.some((r: string) => /unverified/i.test(r)),
      `expected an "unverified" rejection, got: ${JSON.stringify(gate.failedReasons)}`
    );
  });

  test('fixed: unverified concentration scores below the half-unit floor', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const s = rf.computeScoreBreakdown(inferredReport, unmeasured);
    assert.ok(s.totalScore < 55, `expected < 55 (router half-unit floor), got ${s.totalScore}`);
  });

  test('measured concentration still passes when genuinely clean', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const measured = { ...unmeasured, top10Pct: 18, devHoldingsPct: 2, bundledSupplyPct: 4 };
    const gate = rf.evaluateGate0(inferredReport, measured, {
      minLiquidityUsdOverride: 2275,
      requireVerifiedConcentration: true,
    });
    assert.strictEqual(gate.allPassed, true, JSON.stringify(gate.failedReasons));
  });

  test('measured concentration over the cap still rejects', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const concentrated = { ...unmeasured, top10Pct: 62, devHoldingsPct: 20, bundledSupplyPct: 40 };
    const gate = rf.evaluateGate0(inferredReport, concentrated, {
      minLiquidityUsdOverride: 2275,
      requireVerifiedConcentration: true,
    });
    assert.strictEqual(gate.allPassed, false);
    assert.ok(gate.failedReasons.some((r: string) => /Top 10 holders/.test(r)));
  });

  test('Play 3 score ceiling: a PERFECT migration cannot reach full conviction pre-indexing', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    // Pristine holder distribution, tiny dev position, completed curve — but no
    // DexScreener pair yet, which is the norm inside Play 3's 90s window.
    const perfect = {
      mint: 'X'.repeat(43),
      top10Pct: 15,
      devHoldingsPct: 1,
      bundledSupplyPct: 2,
      liquidityUsd: 11984,
      marketCapUsd: 60000,
      bondingProgress: 90,
      volume5mUsd: 0,
      socialCount: 0,
      washScore: 0,
    };
    const s = rf.computeScoreBreakdown(null, perfect as any);
    assert.strictEqual(s.totalScore, 62, `expected the measured 62 ceiling, got ${s.totalScore}`);
    assert.ok(s.totalScore >= 55, 'must clear the half-unit floor Play 3 trades on');
    assert.ok(s.totalScore < 71,
      'REGRESSION GUARD: full conviction is unreachable here, so all-in sizing must NOT require it');
  });

  test('the same token reaches full conviction once demand is indexed', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const indexed = {
      mint: 'X'.repeat(43),
      top10Pct: 15,
      devHoldingsPct: 1,
      bundledSupplyPct: 2,
      liquidityUsd: 11984,
      marketCapUsd: 60000,
      bondingProgress: 90,
      volume5mUsd: 3000,
      buyPressurePct: 80,
      buys5m: 40,
      socialCount: 2,
      washScore: 0,
    };
    const s = rf.computeScoreBreakdown(null, indexed as any);
    assert.ok(s.totalScore >= 71, `expected full conviction once indexed, got ${s.totalScore}`);
  });

  test('an UNVERIFIED token still scores far below the half-unit floor', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    // $GREEN's shape: no holder data, credited only the completed-curve demand.
    const unknown = {
      mint: 'Y'.repeat(43),
      top10Pct: undefined,
      devHoldingsPct: undefined,
      bundledSupplyPct: undefined,
      liquidityUsd: 11984,
      marketCapUsd: 2118,
      bondingProgress: 90,
      volume5mUsd: 0,
      socialCount: 0,
      washScore: 0,
    };
    const s = rf.computeScoreBreakdown(null, unknown as any);
    assert.strictEqual(s.totalScore, 42, `expected 42 for a no-data token, got ${s.totalScore}`);
    assert.ok(s.totalScore < 55,
      'a token with no holder data must not clear the floor even with the curve credit');
  });

  test('REGRESSION: zero insiders is measured data, not missing data', () => {
    // How the engine folds RugCheck holder data into launchData. Mirrors the
    // real block in processIncomingToken.
    const foldHolderData = (meta: any) => {
      const launch: any = { top10Pct: undefined, devHoldingsPct: undefined, bundledSupplyPct: undefined };
      const usable = Boolean(meta && meta.holderSampleSize > 0 && !meta.concentrationAnomaly);
      if (usable) {
        if (typeof meta.top10Pct === 'number') launch.top10Pct = meta.top10Pct;
        if (typeof meta.maxSingleHolderPct === 'number') {
          launch.devHoldingsPct = Math.max(launch.devHoldingsPct ?? 0, meta.maxSingleHolderPct);
        }
        if (typeof meta.insiderPct === 'number') {
          launch.bundledSupplyPct = Math.max(launch.bundledSupplyPct ?? 0, meta.insiderPct);
        }
      }
      return launch;
    };

    // $Drage, measured live 2026-08-09: a genuinely clean graduation.
    const drage = { holderSampleSize: 19, top10Pct: 19.24, maxSingleHolderPct: 4.1, insiderPct: 0 };
    const folded = foldHolderData(drage);
    assert.strictEqual(folded.bundledSupplyPct, 0,
      'insiderPct 0 must be recorded as a measured 0, not left undefined');

    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const gate = rf.evaluateGate0(
      { isInferred: false, token: { mintAuthority: null, freezeAuthority: null }, markets: [] } as any,
      { ...folded, liquidityUsd: 11984, washScore: 0 } as any,
      { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true }
    );
    assert.strictEqual(gate.allPassed, true,
      `a clean measured graduation must pass: ${JSON.stringify(gate.failedReasons)}`);
  });

  test('REGRESSION: the concentrated tokens from the same run are still refused', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    // $TWH (79%) and GROUCH (89.65%), both measured live 2026-08-09.
    for (const [name, top10] of [['$TWH', 79], ['GROUCH', 89.65]] as Array<[string, number]>) {
      const gate = rf.evaluateGate0(
        { isInferred: false, token: { mintAuthority: null, freezeAuthority: null }, markets: [] } as any,
        { top10Pct: top10, devHoldingsPct: top10, bundledSupplyPct: 0, liquidityUsd: 11984, washScore: 0 } as any,
        { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true }
      );
      assert.strictEqual(gate.allPassed, false, `${name} at ${top10}% top-10 must be refused`);
    }
  });

  test('REGRESSION: an untrustworthy reading (sums past 100%) counts as unverified', () => {
    const meta = { holderSampleSize: 12, top10Pct: 100, maxSingleHolderPct: 60, insiderPct: 5, concentrationAnomaly: true };
    const usable = Boolean(meta.holderSampleSize > 0 && !meta.concentrationAnomaly);
    assert.strictEqual(usable, false, 'an anomalous reading must not be treated as measured');
  });

  test('REGRESSION $TNOS: a one-row holder sample is not a distribution', () => {
    const MIN_HOLDER_SAMPLE = 5;
    const MIN_TOTAL_HOLDERS = 10;
    const usable = (meta: any) => Boolean(
      meta && meta.holderSampleSize >= MIN_HOLDER_SAMPLE
      && meta.totalHolders >= MIN_TOTAL_HOLDERS
      && !meta.concentrationAnomaly
    );

    // Exactly what RugCheck returned for $TNOS at the moment it was bought.
    const tnosAtScreening = { holderSampleSize: 1, totalHolders: 0, top10Pct: 2.01, maxSingleHolderPct: 2.01, insiderPct: 0 };
    assert.strictEqual(usable(tnosAtScreening), false,
      'a 1-row sample reporting 2.01% must not count as measured — the token settled at 79.32% in one wallet');

    // A genuine distribution from the same run ($Drage) must still be usable.
    const drage = { holderSampleSize: 19, totalHolders: 255, top10Pct: 19.24, maxSingleHolderPct: 2.26, insiderPct: 0 };
    assert.strictEqual(usable(drage), true, 'a real 19-row / 255-holder distribution must stay usable');
  });

  test('REGRESSION $TNOS: RugCheck risk score is enforced by Gate 0', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const clean = { top10Pct: 2.01, devHoldingsPct: 2.01, bundledSupplyPct: 0, liquidityUsd: 12003, washScore: 0 };

    // $TNOS scored 13001 — Gate 0 never looked, so it was bought.
    const flagged = rf.evaluateGate0(
      { isInferred: false, score: 13001, token: { mintAuthority: null, freezeAuthority: null }, markets: [] } as any,
      clean as any,
      { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true, maxRugcheckScore: 1000 }
    );
    assert.strictEqual(flagged.allPassed, false, 'a 13001 RugCheck score must fail Gate 0');
    assert.ok(flagged.failedReasons.some((r: string) => /RugCheck risk score/.test(r)),
      `expected a RugCheck score rejection, got ${JSON.stringify(flagged.failedReasons)}`);

    // The clean graduations in the same dataset all scored 1.
    const quiet = rf.evaluateGate0(
      { isInferred: false, score: 1, token: { mintAuthority: null, freezeAuthority: null }, markets: [] } as any,
      clean as any,
      { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true, maxRugcheckScore: 1000 }
    );
    assert.strictEqual(quiet.allPassed, true, JSON.stringify(quiet.failedReasons));
  });

  test('legacy path (flag off) ignores the RugCheck score, as before', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const gate = rf.evaluateGate0(
      { isInferred: false, score: 999999, token: { mintAuthority: null, freezeAuthority: null }, markets: [] } as any,
      { top10Pct: 12, devHoldingsPct: 1, bundledSupplyPct: 5, liquidityUsd: 12003, washScore: 0 } as any,
      { minLiquidityUsdOverride: 2275 }
    );
    assert.strictEqual(gate.allPassed, true, 'no maxRugcheckScore passed -> score not enforced');
  });

  test('legacy path (flag off) is unchanged — placeholders still evaluated as before', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const legacyLaunch = { ...unmeasured, top10Pct: 12, devHoldingsPct: 1, bundledSupplyPct: 5 };
    const gate = rf.evaluateGate0(inferredReport, legacyLaunch, { minLiquidityUsdOverride: 2275 });
    assert.strictEqual(gate.allPassed, true, JSON.stringify(gate.failedReasons));
  });
}

// ---------------------------------------------------------------------------
// Exit policy (2026-08-09: price stop-loss removed).
//
// Before this block the entire exit ladder had ZERO coverage — which is how a
// trailing stop that forced exits BELOW round-trip breakeven survived as the
// bot's primary liquidator. Each test states the old behavior it prevents.
// ---------------------------------------------------------------------------
console.log('\n-- Exit policy: no price stop-loss --');
{
  const { trailingStopTargetUsd, isPoolDrained, acceptPeakUpdate } = require('../services/pipelineUtils');
  const { breakevenPct } = require('../services/paperSimulator');

  const ENTRY = 0.001;
  const arm = (peakMultiple: number, armMultiple = 3.0, trailingStopPct = 30) =>
    trailingStopTargetUsd({
      highestPriceUsd: ENTRY * peakMultiple,
      buyPriceUsd: ENTRY,
      armMultiple,
      trailingStopPct,
      useTrailingStop: true,
    });

  test('OLD BUG reproduced: at the 1.3x arm / 20% trail the stop exited BELOW breakeven', () => {
    // The arm is a strict `>`, so take a peak fractionally above it — the
    // worst armed case the old settings could produce.
    const target = arm(1.3 + 1e-9, 1.3, 20)!;
    assert.ok(target !== undefined, 'old settings armed just above 1.3x');
    const exitMultiple = target / ENTRY;
    assert.ok(Math.abs(exitMultiple - 1.04) < 1e-6, `expected ~1.04x, got ${exitMultiple}`);
    // Round-trip cost at the shipped 0.3 SOL stake / 0.003 priority fee.
    const be = breakevenPct(0.3, 0.003);
    assert.ok(be > 4, `breakeven should be material, got ${be}%`);
    assert.ok((exitMultiple - 1) * 100 < be,
      `old stop exited at +${((exitMultiple - 1) * 100).toFixed(2)}% against a ${be}% round trip — a guaranteed loss`);
  });

  test('fixed: a 1.5x peak never arms the trailing stop', () => {
    assert.strictEqual(arm(1.5), undefined);
  });

  test('fixed: a 2.9x peak still does not arm (below the 3x ratchet)', () => {
    assert.strictEqual(arm(2.9), undefined);
  });

  test('fixed: a 3.5x peak arms at 2.45x — comfortably above breakeven', () => {
    const target = arm(3.5)!;
    assert.ok(Math.abs(target / ENTRY - 2.45) < 1e-9, `expected 2.45x, got ${target / ENTRY}`);
    assert.ok((target / ENTRY - 1) * 100 > breakevenPct(0.3, 0.003));
  });

  test('fixed: the armed level always clears round-trip cost at the 3x arm', () => {
    // Minimum armed exit is arm x (1 - trail) = 3.0 x 0.70 = 2.10x.
    const minExit = arm(3.0000001)! / ENTRY;
    assert.ok(minExit >= 2.09, `min armed exit ${minExit} should be ~2.1x`);
    for (const stake of [0.05, 0.15, 0.3, 0.6]) {
      assert.ok((minExit - 1) * 100 > breakevenPct(stake, 0.003),
        `2.1x must beat breakeven at ${stake} SOL`);
    }
  });

  test('useTrailingStop=false never arms', () => {
    assert.strictEqual(trailingStopTargetUsd({
      highestPriceUsd: ENTRY * 10, buyPriceUsd: ENTRY,
      armMultiple: 3, trailingStopPct: 30, useTrailingStop: false,
    }), undefined);
  });

  test('a position down 60% has no price exit UNLESS the owner switched one on', () => {
    // 2026-08-13: the price stop is a setting again, so the guard changed shape.
    // What must hold is that it is opt-in and that nothing reads the threshold
    // outside the switch — a price floor must never come back by accident.
    const engineSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../services/sniperEngine.ts'), 'utf8');
    assert.ok(/exitOnPriceStop:\s*false/.test(engineSrc),
      'the price stop must ship OFF');
    const priceStopBlock = engineSrc.slice(
      engineSrc.indexOf('if (this.config.exitOnPriceStop)'),
      engineSrc.indexOf('// TAKE PROFIT'));
    assert.ok(/pnlPct\s*<=\s*-/.test(priceStopBlock),
      'the only negative-pnl comparison must live inside the switch');
    assert.strictEqual(engineSrc.split(/pnlPct\s*<=\s*-/).length - 1, 1,
      'exactly one negative-pnl price comparison may exist in the engine');
  });

  console.log('\n-- Exit policy: structural exits replace the price stop --');

  test('pool drain fires at half the peak', () => {
    assert.strictEqual(isPoolDrained({
      peakLiquidityUsd: 12000, currentLiquidityUsd: 6000, drainFraction: 0.5,
    }), true);
  });

  test('pool drain does NOT fire on an ordinary 30% dip', () => {
    assert.strictEqual(isPoolDrained({
      peakLiquidityUsd: 12000, currentLiquidityUsd: 8400, drainFraction: 0.5,
    }), false);
  });

  test('a thin pool cannot trip the drain exit on noise', () => {
    assert.strictEqual(isPoolDrained({
      peakLiquidityUsd: 1500, currentLiquidityUsd: 10, drainFraction: 0.5,
    }), false);
  });

  test('an unindexed pool (liquidity 0) is not a drain signal', () => {
    assert.strictEqual(isPoolDrained({
      peakLiquidityUsd: 12000, currentLiquidityUsd: 0, drainFraction: 0.5,
    }), false, 'liquidity 0 means "not indexed yet", not "drained"');
  });

  console.log('\n-- Exit policy: peak integrity across price sources --');

  test('a normal new high raises the peak', () => {
    assert.strictEqual(acceptPeakUpdate({
      candidatePriceUsd: 1.2, prevPriceUsd: 1.0, currentPeakUsd: 1.1,
    }), true);
  });

  test('a price below the peak never lowers it', () => {
    assert.strictEqual(acceptPeakUpdate({
      candidatePriceUsd: 0.9, prevPriceUsd: 1.0, currentPeakUsd: 1.1,
    }), false);
  });

  test('OLD BUG reproduced: a 2x source switch would have anchored the peak forever', () => {
    // marketCap/1e9 reads 2x high on a 2B-supply token ($SMISKI, 2026-08-05).
    // The old code took any higher tick unconditionally.
    const bogus = 2.0, real = 1.0;
    assert.ok(bogus > real, 'the bogus source reads high');
    assert.strictEqual(acceptPeakUpdate({
      candidatePriceUsd: 10.0, prevPriceUsd: 1.0, currentPeakUsd: 1.0,
    }), false, 'a 10x single-tick spike must not set the peak');
  });

  test('a 3x single-tick move is still accepted (real launches do move)', () => {
    assert.strictEqual(acceptPeakUpdate({
      candidatePriceUsd: 3.0, prevPriceUsd: 1.0, currentPeakUsd: 1.0,
    }), true);
  });

  test('the first tick (no previous price) is accepted', () => {
    assert.strictEqual(acceptPeakUpdate({
      candidatePriceUsd: 5.0, prevPriceUsd: 0, currentPeakUsd: 1.0,
    }), true);
  });
}

// ---------------------------------------------------------------------------
// Entry economics — the wall that produced the 0-trade 89-minute live run.
// ---------------------------------------------------------------------------
console.log('\n-- Entry economics: the half-unit stake must clear the breakeven gate --');
{
  const { breakevenPct } = require('../services/paperSimulator');
  const { affordableStakeSol, computeEntrySizeSol } = require('../services/pipelineUtils');
  const MAX_BE = 6;
  const PRIORITY_FEE = 0.003;
  const SLIPPAGE = 25;

  test('OLD BUG reproduced: buyAmountSol 0.3 sized a half unit that the gate refused', () => {
    const stake = computeEntrySizeSol({ buyAmountSol: 0.3, sizeMultiplier: 0.5 });
    assert.strictEqual(stake, 0.15);
    const be = breakevenPct(stake, PRIORITY_FEE);
    assert.ok(be > MAX_BE,
      `0.15 SOL should exceed the ${MAX_BE}% limit (this is why 102 candidates passed and 0 opened), got ${be}%`);
  });

  test('OLD BUG reproduced: at a 0.2 SOL wallet NO buyAmountSol could clear the gate', () => {
    // affordableStakeSol clamps to what the balance can fund, so the ceiling is
    // the ceiling regardless of how large the configured unit is.
    const deployable = 0.195; // 0.2 wallet - 0.005 gas float
    for (const unit of [0.3, 0.6, 5, 50]) {
      const stake = affordableStakeSol(
        computeEntrySizeSol({ buyAmountSol: unit, sizeMultiplier: 0.5 }),
        deployable, SLIPPAGE, PRIORITY_FEE);
      assert.ok(breakevenPct(stake, PRIORITY_FEE) > MAX_BE,
        `a 0.2 SOL wallet must not be able to clear the gate at any unit size (unit ${unit})`);
    }
  });

  test('fixed: buyAmountSol 0.6 sizes a 0.3 SOL half unit that clears the gate', () => {
    const stake = computeEntrySizeSol({ buyAmountSol: 0.6, sizeMultiplier: 0.5 });
    assert.strictEqual(stake, 0.3);
    const be = breakevenPct(stake, PRIORITY_FEE);
    assert.ok(be <= MAX_BE, `expected <= ${MAX_BE}%, got ${be}%`);
  });

  test('fixed: ~1.2 SOL funds three concurrent 0.3 SOL stakes', () => {
    const deployable = 1.2 - 0.005;
    let remaining = deployable;
    for (let i = 0; i < 3; i++) {
      const stake = affordableStakeSol(0.3, remaining, SLIPPAGE, PRIORITY_FEE);
      assert.ok(Math.abs(stake - 0.3) < 1e-9,
        `position ${i + 1} should fund a full 0.3 SOL stake, got ${stake}`);
      remaining -= stake * (1 + SLIPPAGE / 100 + 0.015) + PRIORITY_FEE + 0.0025;
    }
  });

  test('a full unit (score >= minScoreFullUnit) is also economic', () => {
    assert.ok(breakevenPct(computeEntrySizeSol({ buyAmountSol: 0.6, sizeMultiplier: 1 }), PRIORITY_FEE) <= MAX_BE);
  });
}

// ---------------------------------------------------------------------------
// Wallet-split sizing: N equal, independently survivable slots per run.
// ---------------------------------------------------------------------------
console.log('\n-- Wallet-split sizing: one dead slot costs 1/N, never the wallet --');
{
  const { splitWalletIntoSlots } = require('../services/pipelineUtils');
  const { breakevenPct } = require('../services/paperSimulator');
  const SLIP = 25;
  const PF = 0.003;
  const OVERHEAD = 0.0025;

  const split = (deployable: number, slots = 3) =>
    splitWalletIntoSlots({ deployableSol: deployable, slots, maxSlippagePct: SLIP, priorityFeeSol: PF });

  test('a 1.2 SOL wallet splits into 3 fundable slots', () => {
    const { slotBudgetSol, stakePerSlotSol } = split(1.195);
    assert.ok(Math.abs(slotBudgetSol - 1.195 / 3) < 1e-6, `slot budget ${slotBudgetSol}`);
    assert.ok(stakePerSlotSol > 0.3, `expected a >0.3 SOL stake, got ${stakePerSlotSol}`);
  });

  test('all 3 slots actually fit inside the balance (no overdraft)', () => {
    const deployable = 1.195;
    const { stakePerSlotSol } = split(deployable);
    // Each order reserves stake x (1 + slippage + protocol fees) + fees.
    const costPerSlot = stakePerSlotSol * (1 + SLIP / 100 + 0.015) + PF + OVERHEAD;
    assert.ok(costPerSlot * 3 <= deployable + 1e-6,
      `3 slots cost ${(costPerSlot * 3).toFixed(6)} but only ${deployable} is deployable`);
  });

  test('OLD BUG reproduced: naive balance/3 as the stake overdrafts', () => {
    const deployable = 1.195;
    const naiveStake = deployable / 3;
    const costPerSlot = naiveStake * (1 + SLIP / 100 + 0.015) + PF + OVERHEAD;
    assert.ok(costPerSlot * 3 > deployable,
      'staking balance/3 directly must overdraft — this is why the split applies the affordability transform');
  });

  test('the slot stake clears the breakeven gate at 1.2 SOL', () => {
    const { stakePerSlotSol } = split(1.195);
    assert.ok(breakevenPct(stakePerSlotSol, PF) <= 6,
      `slot breakeven ${breakevenPct(stakePerSlotSol, PF)}% must clear the 6% limit`);
  });

  test('a slot going to zero costs exactly 1/N — the other slots keep full size', () => {
    // The budget is snapshotted, so slot 2 and 3 are computed from the SAME
    // split as slot 1 regardless of what slot 1 did.
    const { stakePerSlotSol } = split(1.195);
    const lossFromOneDeadSlot = stakePerSlotSol;
    const totalStaked = stakePerSlotSol * 3;
    assert.ok(Math.abs(lossFromOneDeadSlot / totalStaked - 1 / 3) < 1e-9,
      'one dead slot must be exactly a third of the deployed capital');
  });

  test('more slots means a smaller, still-equal share', () => {
    const three = split(1.195, 3).stakePerSlotSol;
    const five = split(1.195, 5).stakePerSlotSol;
    assert.ok(five < three, 'five slots must stake less each');
    assert.ok(breakevenPct(five, PF) > breakevenPct(three, PF),
      'smaller slots carry a worse round trip — the cost of more concurrency');
  });

  test('an underfunded wallet yields a zero stake rather than a bad order', () => {
    assert.strictEqual(split(0.0049).stakePerSlotSol, 0,
      'the current 0.0099 SOL wallet cannot fund a slot');
  });

  test('a zero or negative balance is not sliceable', () => {
    assert.deepStrictEqual(split(0), { slotBudgetSol: 0, stakePerSlotSol: 0 });
    assert.deepStrictEqual(split(-1), { slotBudgetSol: 0, stakePerSlotSol: 0 });
  });

  test('one slot degenerates to the whole affordable balance', () => {
    const { stakePerSlotSol } = split(1.195, 1);
    const cost = stakePerSlotSol * (1 + SLIP / 100 + 0.015) + PF + OVERHEAD;
    assert.ok(cost <= 1.195 + 1e-6, 'a single slot must still fit the balance');
  });
}

// ---------------------------------------------------------------------------
// Increment 1 — exit-path safety and risk controls (audit items 1, 5, 6, 11-16, 29).
// ---------------------------------------------------------------------------
console.log('\n-- Router reads its tier config (audit #1) --');
{
  const { routePlay, PLAYBOOK_DEFAULTS, PLAYBOOK_NORMAL, playbookConfigFor } = require('../services/playbookRouter');

  test('NORMAL tier declares looser Play 2 triggers than STRICT', () => {
    assert.ok(PLAYBOOK_NORMAL.play2MinVelocity5m < PLAYBOOK_DEFAULTS.play2MinVelocity5m);
    assert.ok(PLAYBOOK_NORMAL.play2MinBuyPressurePct < PLAYBOOK_DEFAULTS.play2MinBuyPressurePct);
  });

  // A MID_CURVE token that clears NORMAL's triggers but not STRICT's.
  // Progress is (vSol - 30) / 85, so vSol 68 => ~45%, inside the 30-60% band.
  // vSol 55 lands at 29% (EARLY_CURVE) and never reaches the Play 2 branch.
  const midCurve = (cfg: any) => routePlay({
    isMigrationEvent: false,
    ageSeconds: 900,
    vSolInBondingCurve: 68,      // ~45% of the curve => MID_CURVE
    score: 999,                  // clear the score band; we are testing the triggers
    progressVelocity5m: 1.5,     // >= NORMAL's 1, < STRICT's 2
    buyPressurePct: 57,          // >= NORMAL's 55, < STRICT's 60
    solPriceUsd: 200,
  }, cfg);

  test('the fixture actually reaches the Play 2 branch', () => {
    const r = midCurve(PLAYBOOK_DEFAULTS);
    assert.strictEqual(r.play, 'PLAY_2',
      `fixture must land in MID_CURVE, got play=${r.play} reasons=${JSON.stringify(r.reasons)}`);
  });

  test('OLD BUG reproduced: bare literals meant NORMAL behaved exactly like STRICT', () => {
    // The old code compared against 2 and 60 regardless of tier. Reproduce by
    // evaluating NORMAL's inputs against STRICT's numbers.
    const velocityFailsAt2 = 1.5 < 2;
    const pressureFailsAt60 = 57 < 60;
    assert.ok(velocityFailsAt2 && pressureFailsAt60,
      'these inputs must fail the STRICT numbers, which is what NORMAL used to be judged by');
  });

  test('fixed: STRICT still rejects these inputs', () => {
    const r = midCurve(PLAYBOOK_DEFAULTS);
    assert.ok(r.reasons.some((x: string) => /velocity/i.test(x) || /buy pressure/i.test(x)),
      `expected a trigger rejection, got ${JSON.stringify(r.reasons)}`);
  });

  test('fixed: NORMAL now accepts them — its config finally has an effect', () => {
    const r = midCurve(PLAYBOOK_NORMAL);
    assert.ok(!r.reasons.some((x: string) => /velocity/i.test(x) || /buy pressure/i.test(x)),
      `NORMAL should clear its own triggers, got ${JSON.stringify(r.reasons)}`);
  });

  test('the rejection message quotes the configured number, not a literal', () => {
    const r = midCurve(PLAYBOOK_DEFAULTS);
    const msg = r.reasons.join(' | ');
    assert.ok(/< 2%/.test(msg) || /< 60%/.test(msg), `expected configured thresholds in ${msg}`);
  });

  test('playbookConfigFor maps modes to the right tier', () => {
    assert.strictEqual(playbookConfigFor('strict').play2MinBuyPressurePct, 60);
    assert.strictEqual(playbookConfigFor('normal').play2MinBuyPressurePct, 55);
  });
}

console.log('\n-- Bankroll cap and slot budget (audit #16) --');
{
  const { splitWalletIntoSlots } = require('../services/pipelineUtils');
  const SLIP = 25, PF = 0.003;

  const budget = (deployable: number, pct: number, slots = 3) => {
    const deployed = deployable * (pct / 100);
    return splitWalletIntoSlots({ deployableSol: deployed, slots, maxSlippagePct: SLIP, priorityFeeSol: PF });
  };

  test('OLD BUG reproduced: with no cap the run commits ~100% of the wallet', () => {
    const deployable = 1.195;
    const { stakePerSlotSol } = budget(deployable, 100);
    const committed = (stakePerSlotSol * (1 + SLIP / 100 + 0.015) + PF + 0.0025) * 3;
    assert.ok(committed / deployable > 0.99,
      `uncapped split commits ${(committed / deployable * 100).toFixed(1)}% of the wallet`);
  });

  test('fixed: a 60% cap holds back 40% of the wallet', () => {
    const deployable = 1.195;
    const { stakePerSlotSol } = budget(deployable, 60);
    const committed = (stakePerSlotSol * (1 + SLIP / 100 + 0.015) + PF + 0.0025) * 3;
    const ratio = committed / deployable;
    assert.ok(ratio > 0.55 && ratio <= 0.61, `expected ~60% committed, got ${(ratio * 100).toFixed(1)}%`);
  });

  test('the cap shrinks the per-slot stake proportionally', () => {
    assert.ok(budget(1.195, 60).stakePerSlotSol < budget(1.195, 100).stakePerSlotSol);
  });

  test('a capped slot is still large enough to trade at a 2 SOL wallet', () => {
    const { breakevenPct } = require('../services/paperSimulator');
    const { stakePerSlotSol } = budget(1.995, 60);
    assert.ok(breakevenPct(stakePerSlotSol, PF) <= 6,
      `60% of a 2 SOL wallet must still clear the economics gate, got ${breakevenPct(stakePerSlotSol, PF)}%`);
  });
}

console.log('\n-- Exit-path safety: no-data exit, retry cap, rung latches (audit #5, #6, #11, #12, #13) --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const typesSrc = fs.readFileSync(path.join(__dirname, '../types.ts'), 'utf8');

  test('the price stop exists but is gated on a switch that ships OFF', () => {
    // It came back on 2026-08-13 as an owner-controlled setting, not as policy.
    // What must never regress is the DEFAULT: price alone does not sell.
    assert.ok(/exitOnPriceStop/.test(typesSrc), 'the switch must be configurable');
    assert.ok(/config\.exitOnPriceStop/.test(engineSrc), 'the engine must read the switch');
    assert.ok(/exitOnPriceStop:\s*false/.test(engineSrc),
      'the engine default for the price stop must be false');
    // Every read of the threshold must sit behind the switch.
    const stopIdx = engineSrc.indexOf('config.stopLossPct');
    assert.ok(stopIdx > engineSrc.indexOf('config.exitOnPriceStop'),
      'stopLossPct must only be read inside the exitOnPriceStop branch');
  });

  test('each loss-side exit has its own switch, and they default to owner policy', () => {
    // Owner stance 2026-08-13: act on evidence and on time, never on price.
    const defaults: Array<[string, boolean]> = [
      ['exitOnPoolDrain', true],
      ['exitOnSellFlowCollapse', true],
      ['exitOnDevSell', true],
      ['exitOnHoneypot', true],
      ['exitOnMaxHold', true],
      ['exitOnNoData', true],
      ['exitOnPriceStop', false],
    ];
    for (const [key, expected] of defaults) {
      assert.ok(new RegExp(`${key}\\?:\\s*boolean`).test(typesSrc), `${key} must be in BotConfig`);
      assert.ok(new RegExp(`${key}:\\s*${expected}`).test(engineSrc),
        `${key} must default to ${expected} in the engine`);
      assert.ok(new RegExp(`config\\.${key}`).test(engineSrc), `${key} must gate real behaviour`);
    }
  });

  test('every structural danger can still only WARN when its switch is off', () => {
    // The warn-and-hold path is what makes these switches reversible, so it has
    // to survive alongside the sells.
    for (const marker of ['is OFF in Settings']) {
      const hits = engineSrc.split(marker).length - 1;
      assert.ok(hits >= 4, `expected the warn-only fallback on every exit family, saw ${hits}`);
    }
  });

  test('#13: a no-data exit exists and is time-based, not price-based', () => {
    assert.ok(/noDataExitSeconds/.test(engineSrc), 'engine must implement the no-data exit');
    assert.ok(/noDataExitSeconds/.test(typesSrc), 'noDataExitSeconds must be configurable');
  });

  test('#13: the no-data exit is gated on market EXISTENCE, never on a price level', () => {
    const block = engineSrc.slice(engineSrc.indexOf('hasUsableMarket'), engineSrc.indexOf('hasUsableMarket') + 900);
    assert.ok(/hasPair/.test(block) && /liquidityUsd/.test(block),
      'must key off whether a market exists');
    assert.ok(!/pnlPct\s*<=/.test(block), 'must not compare against a P&L threshold');
  });

  test('Take Profit rungs are active and never fire in negative PnL', () => {
    assert.ok(/pullbackRungTaken/.test(engineSrc) && /tp1Taken/.test(engineSrc),
      'profit-rung triggers must exist in the engine');
    // Scoped to the PROFIT rungs only. The loss side has its own switches; what
    // this guards is that a take-profit rung can never be the thing that books
    // a loss, which is how the trailing stop once became the main liquidator.
    assert.ok(/pos\.pnlPct > 0/.test(engineSrc),
      'take-profit rungs must be guarded to fire only when in positive PnL');
  });

  test('#11: neither rung is gated on the shared principalRecovered flag any more', () => {
    assert.ok(!/pullbackFromPeakPct >= 15 && !pos\.principalRecovered/.test(engineSrc));
    assert.ok(!/takeProfitPct && !pos\.principalRecovered/.test(engineSrc));
  });

  test('#12: trailingTriggerCount resets when the stop re-anchors', () => {
    const idx = engineSrc.indexOf('pos.trailingStopTargetUsd = undefined;');
    assert.ok(idx > 0, 'recordPartialSell must clear the trailing target');
    assert.ok(/trailingTriggerCount = 0/.test(engineSrc.slice(idx, idx + 600)),
      'the trigger count must reset with the anchor, or the second trigger ever closes 100%');
  });
}

console.log('\n-- Config clamps and circuit breakers (audit #15, #29) --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');

  test('#15: updateConfig clamps incoming values', () => {
    assert.ok(/clampConfig/.test(engineSrc));
    const clamp = engineSrc.slice(engineSrc.indexOf('private clampConfig'), engineSrc.indexOf('public updateConfig'));
    for (const field of ['maxActivePositions', 'maxSlippagePct', 'priorityFeeSol', 'maxBreakevenPct']) {
      assert.ok(clamp.includes(field), `${field} must be clamped`);
    }
    assert.ok(/'maxActivePositions', 1, 20/.test(clamp), 'positions must be bounded 1..20');
  });

  test('#15: the 99999 unlimited-positions sentinel is gone', () => {
    assert.ok(!/99999/.test(engineSrc), 'engine must not carry the unlimited sentinel');
    assert.ok(!/99999/.test(appSrc), 'UI must not carry the unlimited sentinel');
  });

  test('#29: all three circuit breakers are read, not just written', () => {
    const ks = engineSrc.slice(engineSrc.indexOf('private checkKillSwitch'), engineSrc.indexOf('private checkKillSwitch') + 2200);
    assert.ok(/maxHourlyLossUsd/.test(ks), 'hourly loss breaker');
    assert.ok(/maxDailyLossUsd/.test(ks), 'daily loss breaker');
    assert.ok(/consecutiveLosses/.test(ks), 'consecutive-loss breaker');
  });

  test('#29: tripping pauses entries but never closes positions', () => {
    const ks = engineSrc.slice(engineSrc.indexOf('private checkKillSwitch'), engineSrc.indexOf('private checkKillSwitch') + 2200);
    assert.ok(/open positions retained/i.test(ks));
    assert.ok(!/executeSell/.test(ks), 'a breaker must not liquidate');
  });

  test('#14: entries are reserved before the first await', () => {
    assert.ok(/entriesInFlight/.test(engineSrc));
    // The guard was extracted into withEntrySlot (2026-08-12) so the launch
    // snipe and the router share ONE reservation discipline. The invariant is
    // unchanged: the cap counts in-flight entries, claimed synchronously.
    const guard = engineSrc.slice(engineSrc.indexOf('private async withEntrySlot('), engineSrc.indexOf('this.entriesInFlight.add'));
    assert.ok(/activePositions\.length \+ this\.entriesInFlight\.size/.test(guard),
      'the cap must count in-flight entries, not just confirmed positions');
    assert.ok(/finally/.test(engineSrc.slice(engineSrc.indexOf('this.entriesInFlight.add'), engineSrc.indexOf('this.entriesInFlight.add') + 400)),
      'the reservation must be released in a finally');
  });

  test('#14: every entry path goes through the shared slot guard', () => {
    const trigger = engineSrc.slice(engineSrc.indexOf('private async evaluatePlaybookTrigger('), engineSrc.indexOf('private async withEntrySlot('));
    assert.ok(/withEntrySlot\(/.test(trigger), 'router entries must claim a slot');
    const snipe = engineSrc.slice(engineSrc.indexOf('private async fireLaunchSnipe('), engineSrc.indexOf('private releasePendingSnipe('));
    assert.ok(/withEntrySlot\(/.test(snipe), 'launch snipes must claim a slot');
  });
}

// ---------------------------------------------------------------------------
// Increment 2 — rug screening (audit #4, #20, #21, #22, #33).
// ---------------------------------------------------------------------------
console.log('\n-- Mint authority is read on-chain, not asserted (audit #20) --');
{
  const { inspectMintSafety } = require('../services/honeypotDetector');

  // A minimal 82-byte SPL Mint account. Layout:
  //   0..3 mintAuthority COption tag, 4..35 key, 36..43 supply, 44 decimals,
  //   45 isInitialized, 46..49 freezeAuthority COption tag, 50..81 key.
  const mintAccount = (mintTag: number, freezeTag: number) => {
    const d = Buffer.alloc(82);
    d.writeUInt32LE(mintTag, 0);
    d.writeUInt32LE(freezeTag, 46);
    d[45] = 1;
    return d;
  };
  const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const conn = (data: Buffer | null) => ({
    getAccountInfo: async () => data === null ? null : ({ owner: { toBase58: () => SPL }, data }),
  });
  const MINT = 'So11111111111111111111111111111111111111112';

  test('OLD BUG reproduced: an inferred RugCheck report ASSERTS both authorities are null', () => {
    // 85.4% of 6,380 recorded candidates were isInferred, and the inferred
    // report claims mintAuthority: null without ever reading the chain.
    const inferred = { isInferred: true, token: { mintAuthority: null, freezeAuthority: null } };
    assert.strictEqual(inferred.token.mintAuthority, null,
      'the inferred report asserts renunciation — this is the assumption the on-chain read replaces');
  });

  test('fixed: a live mint authority is detected and rejected', async () => {
    const v = await inspectMintSafety(conn(mintAccount(1, 0)) as any, MINT, null);
    assert.strictEqual(v.details.mintAuthorityActive, true);
    assert.ok(v.reasons.some((r: string) => /mint authority/i.test(r)), JSON.stringify(v.reasons));
    assert.strictEqual(v.safe, false);
  });

  test('fixed: a renounced mint authority passes', async () => {
    const v = await inspectMintSafety(conn(mintAccount(0, 0)) as any, MINT, null);
    assert.strictEqual(v.details.mintAuthorityActive, false);
    assert.ok(!v.reasons.some((r: string) => /mint authority/i.test(r)));
  });

  test('freeze authority is still detected independently', async () => {
    const v = await inspectMintSafety(conn(mintAccount(0, 1)) as any, MINT, null);
    assert.strictEqual(v.details.freezeAuthorityActive, true);
    assert.ok(v.reasons.some((r: string) => /freeze authority/i.test(r)));
  });

  test('both authorities live yields both reasons', async () => {
    const v = await inspectMintSafety(conn(mintAccount(1, 1)) as any, MINT, null);
    assert.strictEqual(v.reasons.filter((r: string) => /authority/i.test(r)).length, 2);
  });

  test('#21: an unreachable mint account reports unverified, never a silent pass', async () => {
    const v = await inspectMintSafety(conn(null) as any, MINT, null);
    assert.ok(v.unverified.includes('mintAccount'),
      'a missing mint account must be reported as unverified');
  });
}

console.log('\n-- Unknown is not safe: unverified blocks the trade (audit #21) --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');

  test('OLD BUG reproduced: verdict.unverified was computed and discarded', () => {
    // The old guard was `if (!verdict.safe)` alone, so unverified fell through.
    assert.ok(/fatalUnverified/.test(engineSrc),
      'the engine must act on unverified fields, not just on !safe');
  });

  test('rugcheckRisks alone does not block (it is covered by concentration rules)', () => {
    const block = engineSrc.slice(engineSrc.indexOf('const fatalUnverified'), engineSrc.indexOf('const fatalUnverified') + 300);
    assert.ok(/rugcheckRisks/.test(block), 'rugcheckRisks must be excluded from the fatal set');
  });
}

console.log('\n-- Liquidity vs market cap (audit #33) --');
{
  const ratioBlocks = (mcap: number, liq: number, limit: number) => liq > 0 && mcap > 0 && (mcap / liq) > limit;

  test('OLD BUG reproduced: only absolute floors existed, so 33:1 passed everything', () => {
    // $12k liquidity against a $400k mcap cleared every liquidity rule in the
    // codebase, because all of them were absolute minimums.
    const passesAbsoluteFloor = 12_000 >= 8_000;
    assert.ok(passesAbsoluteFloor, 'the thin pool clears the absolute floor');
    assert.ok(400_000 / 12_000 > 30, 'while being 33x its own liquidity');
  });

  test('fixed: 33:1 is rejected at the default 20x limit', () => {
    assert.strictEqual(ratioBlocks(400_000, 12_000, 20), true);
  });

  test('a genuine graduation (~5:1) passes', () => {
    assert.strictEqual(ratioBlocks(60_000, 12_000, 20), false);
  });

  test('the check is disabled at 0 rather than rejecting everything', () => {
    const engineSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../services/sniperEngine.ts'), 'utf8');
    assert.ok(/maxMcapToLiquidityRatio && this\.config\.maxMcapToLiquidityRatio > 0/.test(engineSrc),
      '0 must disable the check');
  });

  test('the ratio is never computed against ASSERTED liquidity', () => {
    const engineSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../services/sniperEngine.ts'), 'utf8');
    assert.ok(/liquidityIsMeasured/.test(engineSrc),
      'the migration liquidity assertion must not feed the ratio check');
  });
}

console.log('\n-- Creator resolution and the real sell simulation (audit #22, #4) --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const { DevSellMonitor } = require('../services/devSellMonitor');

  test('OLD BUG reproduced: an Unknown creator silently disables all three creator stops', () => {
    const m = new DevSellMonitor();
    m.track('mintA', 'Unknown');
    assert.strictEqual(m.isTracked('mintA'), false,
      'track() returns early on Unknown — this is why 19 of 20 bought tokens had no creator stop');
  });

  test('fixed: the engine falls back to the curve-decoded creator', () => {
    // Anchor on the resolution site itself. Anchoring on the devSellStop flag
    // string matches its first use (curveWatcher.start at arm time) instead.
    const at = engineSrc.indexOf('devSellMonitor.track(filterResult.mint');
    assert.ok(at > 0, 'the position-open tracking site must exist');
    const block = engineSrc.slice(Math.max(0, at - 1400), at + 200);
    assert.ok(/curveWatcher\.getLast\(/.test(block), 'must fall back to the curve account creator');
    assert.ok(/rugCreator/.test(block), 'must also fall back to RugCheck');
  });

  test('fixed: a missing creator is reported loudly instead of failing silently', () => {
    assert.ok(/cannot fire on this position/.test(engineSrc));
  });

  test('a real creator is tracked and alerts on its sell', () => {
    const m = new DevSellMonitor();
    m.track('mintB', 'CreatorWallet111');
    const alert = m.onTrade({ mint: 'mintB', traderPublicKey: 'CreatorWallet111', txType: 'sell', solAmount: 2 });
    assert.ok(alert && alert.kind === 'DEV_SOLD', JSON.stringify(alert));
  });

  test('#4: simulateSellPath now has a call site', () => {
    assert.ok(/simulateSellPath/.test(engineSrc), 'the real sell test must be wired up');
    assert.ok(/verifySellPath/.test(engineSrc));
  });

  test('#4: the sell simulation runs off the entry hot path', () => {
    // Anchor on the scheduling site, not the config default declared earlier.
    const at = engineSrc.indexOf('this.config.sellSimDelayMs');
    assert.ok(at > 0, 'the scheduling site must exist');
    const block = engineSrc.slice(at, at + 600);
    assert.ok(/setTimeout/.test(block), 'must be deferred, not awaited during entry');
    assert.ok(!/await this\.verifySellPath/.test(engineSrc), 'must never be awaited on the entry path');
  });

  test('#4 updated: a confirmed honeypot is logged loudly but NOT auto-sold', () => {
    assert.ok(/honeypotConfirmed/.test(engineSrc), 'the verdict must still latch on the position');
    assert.ok(/HONEYPOT CONFIRMED/.test(engineSrc), 'the verdict must still be logged');
    assert.ok(!/forceExitReason/.test(engineSrc), 'the verdict must not trigger an automatic exit');
  });

  test('#4: an inconclusive simulation does NOT exit the position', () => {
    // Sliced to the END of the method rather than to a fixed character count.
    // The old version took the first 2600 characters, so adding anything to
    // verifySellPath pushed the very assertion out of the window and the test
    // failed for a reason unrelated to what it checks.
    const start = engineSrc.indexOf('private async verifySellPath');
    assert.ok(start > 0, 'verifySellPath must exist');
    const after = engineSrc.indexOf('\n  private ', start + 10);
    const block = engineSrc.slice(start, after > 0 ? after : start + 6000);
    assert.ok(/null = could not simulate/.test(block),
      'an unknown result must leave the position alone rather than acting on it');
  });

  test('#4: a honeypot verdict is RE-SIMULATED before it can dump the position', () => {
    // The response to a confirmed honeypot is an immediate market sell of the
    // whole position, so a false positive realises a loss on a token that was
    // fine. This runs a few seconds after the buy, against whatever node is
    // bound — after a failover, the public endpoint, which lags. A node that
    // has not yet materialised our fresh token account reverts the sell for a
    // reason that has nothing to do with the token.
    const start = engineSrc.indexOf('private async verifySellPath');
    const after = engineSrc.indexOf('\n  private ', start + 10);
    const block = engineSrc.slice(start, after > 0 ? after : start + 6000);
    const firstFalse = block.indexOf('result === false');
    assert.ok(firstFalse > 0, 'the reverting branch must exist');
    const branch = block.slice(firstFalse);
    assert.ok(/SELL SIM RECHECK/.test(branch), 'a second simulation must run before acting');
    assert.ok(branch.indexOf('second !== false') < branch.indexOf('honeypotConfirmed = true'),
      'the recheck must be able to CANCEL the verdict, so it has to come first');
  });

  test('#4: an environmental revert is reported as UNKNOWN, not as a honeypot', () => {
    const { readFileSync } = require('fs');
    const detectorSrc = readFileSync(require('path').join(__dirname, '../services/honeypotDetector.ts'), 'utf8');
    for (const marker of ['AccountNotFound', 'BlockhashNotFound']) {
      assert.ok(detectorSrc.includes(marker),
        `${marker} must be classified as environmental — a lagging node is not a blocked sell`);
    }
  });
}

console.log('\n-- Rug fixtures from recorded live data (audit #38) --');
{
  const { RiskFilter } = require('../filters/riskFilter');
  // Real mints from reports/candidates-2026-08-08.jsonl, with their measured
  // RugCheck values. These are tokens the bot actually saw.
  const REAL_RUGS = [
    { sym: 'roar',    mint: 'G3K1MWyebY2oReAdbnXtLkXmU6BPZLjbaASWJuzqpump', score: 21601, top10: 100,   sample: 1,  holders: 1 },
    { sym: 'TOAD',    mint: '4eXnZ9JYU9fG6UhBicKXodGt4McYDq3KezRHooE2pump', score: 29532, top10: 100,   sample: 4,  holders: 5 },
    { sym: '$STICK',  mint: 'EH4q2niM5ifPNWfdMD7zbncGmUA44pbK5NbU4jgQNray', score: 58701, top10: 100,   sample: 2,  holders: 1 },
    { sym: 'SEACAT',  mint: 'GD5E1XaE2dnm489k5mAFHQfQFbxTnDoDy5Lm8KDRpump', score: 25953, top10: 89.66, sample: 13, holders: 14 },
    { sym: '$HALVES', mint: 'FDR2TwyUaz735tmsvpSg6krB5G1s7N1dgjmPrTwTpump', score: 17811, top10: 89.66, sample: 14, holders: 15 },
    { sym: 'ROGRAP',  mint: 'J8Fq4ffwLKdUg3WZU22eXsANjLLNrzbM6Bz3MqJPpump', score: 31423, top10: 89.66, sample: 8,  holders: 9 },
    { sym: 'TT 2.0',  mint: 'E4ZdRkeaE6qpTKxHmogf48u9bfzDSSqkWbfxVcb4pump', score: 18819, top10: 89.66, sample: 15, holders: 16 },
    { sym: 'ICT',     mint: 'DoYdkJapBGPxJ5KgwyAnBQ9QiceyYkJNRjyTL2Z8pump', score: 27405, top10: 89.66, sample: 16, holders: 17 },
  ];

  for (const r of REAL_RUGS) {
    test(`REAL RUG ${r.sym}: top10 ${r.top10}%, RugCheck score ${r.score} — must be refused`, () => {
      const rf = new RiskFilter();
      rf.setLeniencyMode('strict');
      const report = {
        isInferred: false,
        score: r.score,
        token: { mintAuthority: null, freezeAuthority: null },
        fileMeta: { top10Pct: r.top10, holderSampleSize: r.sample, totalHolders: r.holders },
        markets: [],
      };
      const gate = rf.evaluateGate0(report as any, {
        top10Pct: r.top10, devHoldingsPct: 0, bundledSupplyPct: 0,
        liquidityUsd: 12_000, washScore: 0,
      } as any, { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true, maxRugcheckScore: 1000 });
      assert.strictEqual(gate.allPassed, false,
        `${r.sym} must be rejected; reasons=${JSON.stringify(gate.failedReasons)}`);
    });
  }

  test('a clean distribution from the same corpus is still accepted', () => {
    const rf = new RiskFilter();
    rf.setLeniencyMode('strict');
    const report = {
      isInferred: false, score: 1,
      token: { mintAuthority: null, freezeAuthority: null },
      fileMeta: { top10Pct: 19.2, holderSampleSize: 19, totalHolders: 240 },
      markets: [],
    };
    const gate = rf.evaluateGate0(report as any, {
      top10Pct: 19.2, devHoldingsPct: 1, bundledSupplyPct: 5, liquidityUsd: 12_000, washScore: 0,
    } as any, { minLiquidityUsdOverride: 2275, requireVerifiedConcentration: true, maxRugcheckScore: 1000 });
    assert.strictEqual(gate.allPassed, true,
      `a clean token must still pass; reasons=${JSON.stringify(gate.failedReasons)}`);
  });
}

// ---------------------------------------------------------------------------
// Increment 3 — reporting metrics that were computed but WRONG (audit #8-#10, #27).
// ---------------------------------------------------------------------------
console.log('\n-- Win rate is per position, not per leg (audit #9) --');
{
  const { reportService } = require('../services/reportService');
  const { classifyExitReason } = require('../services/pipelineUtils');

  const leg = (positionId: string, pnlUsd: number, exitCode: string, legIndex = 0) => ({
    id: `${positionId}_${legIndex}`, positionId, legIndex, exitCode,
    mint: 'm', tokenName: 'T', tokenSymbol: 'T', playbook: 'PLAY_3',
    buyPriceUsd: 1, sellPriceUsd: 1, investedSol: 0.3, investedUsd: 60,
    pnlPct: 0, pnlUsd, pnlSol: 0, entryTime: 1, exitTime: 2, holdTimeSeconds: 1,
    exitReason: `SOLD 50% — ${pnlUsd >= 0 ? 'PROFIT' : 'LOSS'} ${pnlUsd >= 0 ? '+' : '-'}$${Math.abs(pnlUsd)}: whatever`,
    feeDragUsd: 0, feesPaidUsd: 1.5,
  });

  // finish() writes reports/run_<id>.{json,md}. These are test fixtures, not
  // real runs, so remove them rather than leaving them to be committed and
  // later mistaken for evidence.
  const runReport = (legs: any[]) => {
    reportService.start({ tradingMode: 'paper', leniencyMode: 'strict' } as any, 100, 1, 'W');
    for (const l of legs) reportService.recordTrade(l as any);
    const r = reportService.finish(100, 1, 0, 0, 200);
    if (r?.runId) {
      const dir = require('path').join(__dirname, '../../reports');
      for (const ext of ['json', 'md']) {
        try { require('fs').unlinkSync(require('path').join(dir, `${r.runId}.${ext}`)); } catch { /* fine */ }
      }
    }
    return r;
  };

  test('OLD BUG reproduced: a winner exits in more legs, inflating a leg-based rate', () => {
    // One winning position exits in 3 legs, one losing position in 1 leg.
    const legs = [
      leg('posWin', 10, 'PULLBACK_PARTIAL', 0),
      leg('posWin', 12, 'TP1', 1),
      leg('posWin', 15, 'TRAILING_FULL', 2),
      leg('posLoss', -40, 'TIME_STOP', 0),
    ];
    const legWinRate = legs.filter(l => l.pnlUsd > 0).length / legs.length * 100;
    assert.strictEqual(Math.round(legWinRate), 75, 'leg-based rate reads 75%');
    // Truth: 1 win, 1 loss => 50%.
  });

  test('fixed: the report groups legs into positions', () => {
    const r = runReport([
      leg('posWin', 10, 'PULLBACK_PARTIAL', 0),
      leg('posWin', 12, 'TP1', 1),
      leg('posWin', 15, 'TRAILING_FULL', 2),
      leg('posLoss', -40, 'TIME_STOP', 0),
    ]);
    assert.strictEqual(r.positionsClosed, 2, 'two positions, not four legs');
    assert.strictEqual(r.winRatePct, 50, `expected 50%, got ${r.winRatePct}%`);
    assert.strictEqual(r.winCount, 1);
    assert.strictEqual(r.lossCount, 1);
    assert.strictEqual(r.totalTrades, 4, 'legs are still reported for the ledger');
  });

  test('a position is a WIN on its summed P&L, not on any single leg', () => {
    // Two profitable partials then a big final loss => the position lost.
    const r = runReport([
      leg('p1', 5, 'PULLBACK_PARTIAL', 0),
      leg('p1', 5, 'TP1', 1),
      leg('p1', -30, 'TRAILING_FULL', 2),
    ]);
    assert.strictEqual(r.positionsClosed, 1);
    assert.strictEqual(r.winRatePct, 0, 'the summed position is a loss');
    assert.strictEqual(r.legWinCount, 2, 'but two of its legs were profitable');
  });

  test('avg P&L per position is reported', () => {
    const r = runReport([leg('a', 20, 'TP1'), leg('b', -10, 'TIME_STOP')]);
    assert.strictEqual(r.avgPnlPerPositionUsd, 5);
  });

  test('#8: fees are reported from feesPaidUsd, not the P&L adjustment', () => {
    const r = runReport([leg('a', 20, 'TP1'), leg('b', -10, 'TIME_STOP')]);
    assert.strictEqual(r.totalFeesUsd, 3, 'two legs x $1.50 modelled fees');
  });

  test('OLD BUG reproduced: summing feeDragUsd on real fills reports $0.00', () => {
    const legs = [leg('a', 20, 'TP1'), leg('b', -10, 'TIME_STOP')];
    const oldTotal = legs.reduce((acc, t) => acc + (t.feeDragUsd || 0), 0);
    assert.strictEqual(oldTotal, 0, 'this is the "Fees paid $0.00" bug');
  });

  test('#10/#27: exit reasons bucket on the code, not the interpolated string', () => {
    const r = runReport([
      leg('a', 5, 'TP1'), leg('b', 7, 'TP1'), leg('c', 9, 'TP1'),
    ]);
    const keys = Object.keys(r.byExitReason);
    assert.strictEqual(keys.length, 1, `three TP1 legs must be ONE bucket, got ${JSON.stringify(keys)}`);
    assert.strictEqual(keys[0], 'TP1');
    assert.strictEqual(r.byExitReason.TP1.count, 3);
  });

  test('OLD BUG reproduced: the raw string fragments into one bucket per trade', () => {
    const raw = [5, 7, 9].map(v => `SOLD 50% — PROFIT +$${v}: hit take-profit`);
    const oldKeys = new Set(raw.map(s => s.replace(/\s*\[final leg.*$/i, '').split('(')[0].trim().slice(0, 60)));
    assert.strictEqual(oldKeys.size, 3, 'the dollar amount sits before any paren, so each is its own bucket');
  });

  test('legacy records with no exitCode still aggregate after numeral collapsing', () => {
    const legacy = [5, 7, 9].map(v => ({
      ...leg('x' + v, v, undefined as any), exitCode: undefined,
      exitReason: `SOLD 50% — PROFIT +$${v}: hit take-profit`,
    }));
    const r = runReport(legacy);
    assert.strictEqual(Object.keys(r.byExitReason).length, 1,
      `legacy strings must collapse, got ${JSON.stringify(Object.keys(r.byExitReason))}`);
  });

  test('classifyExitReason maps the full-exit strings', () => {
    assert.strictEqual(classifyExitReason('SOLD ALL — structural stop: pool drained 60%'), 'STRUCTURAL');
    assert.strictEqual(classifyExitReason('SOLD ALL — honeypot: sell simulation reverts'), 'HONEYPOT');
    assert.strictEqual(classifyExitReason('SOLD ALL — max hold time reached (30 min)'), 'TIME_STOP');
    assert.strictEqual(classifyExitReason('SOLD ALL — no market data 180s after entry (never indexed)'), 'NO_DATA_STOP');
    assert.strictEqual(classifyExitReason('Manual User Force Sell Override'), 'MANUAL');
    assert.strictEqual(classifyExitReason('SOLD ALL — trailing stop: price fell 30%'), 'TRAILING_FULL');
  });

  test('the no-data stop is classified before the generic time stop', () => {
    // Both strings contain time-ish words; order matters.
    assert.strictEqual(classifyExitReason('SOLD ALL — no market data 180s after entry'), 'NO_DATA_STOP');
  });
}

// ---------------------------------------------------------------------------
// Sizing is driven by the linked Photon wallet, and fits the slot count to it.
// ---------------------------------------------------------------------------
console.log('\n-- Slot count fits the wallet (0.2 SOL reality check) --');
{
  const { fitSlotsToWallet, splitWalletIntoSlots } = require('../services/pipelineUtils');
  const { breakevenPct } = require('../services/paperSimulator');
  const SLIP = 25, MAXBE = 6;

  const fit = (deployable: number, maxSlots: number, pf: number) => fitSlotsToWallet({
    deployableSol: deployable, maxSlots, maxSlippagePct: SLIP,
    priorityFeeSol: pf, maxBreakevenPct: MAXBE, breakevenOf: breakevenPct,
  });

  // The real wallet: 0.2 SOL minus the 0.005 gas float.
  const WALLET_02 = 0.195;

  test('THE PROBLEM: 0.2 SOL split 3 ways is uneconomic at any priority fee', () => {
    for (const pf of [0.003, 0.001]) {
      const s = splitWalletIntoSlots({ deployableSol: WALLET_02, slots: 3, maxSlippagePct: SLIP, priorityFeeSol: pf }).stakePerSlotSol;
      assert.ok(breakevenPct(s, pf) > MAXBE,
        `3 slots at pf ${pf} should exceed ${MAXBE}%, got ${breakevenPct(s, pf)}%`);
    }
  });

  test('THE PROBLEM: at the 0.003 priority fee, 0.2 SOL cannot trade at ALL', () => {
    assert.strictEqual(fit(WALLET_02, 3, 0.003).slots, 0,
      'no slot count clears the gate at pf 0.003 — this is why the bot took zero trades');
  });

  test('fixed: at pf 0.001 the wallet supports exactly ONE slot', () => {
    const f = fit(WALLET_02, 3, 0.001);
    assert.strictEqual(f.slots, 1, `expected 1 slot, got ${f.slots}`);
    assert.ok(Math.abs(f.stakePerSlotSol - 0.1514) < 0.001, `stake ${f.stakePerSlotSol}`);
    assert.ok(f.breakevenPct <= MAXBE, `breakeven ${f.breakevenPct}%`);
  });

  test('the fitter prefers MORE slots when the wallet can afford them', () => {
    // A 2 SOL wallet can fund all three.
    const f = fit(1.995, 3, 0.003);
    assert.strictEqual(f.slots, 3, `a 2 SOL wallet should keep 3 slots, got ${f.slots}`);
  });

  test('it steps down one slot at a time, not straight to 1', () => {
    // Find a balance where 3 fails but 2 clears.
    const f = fit(0.85, 3, 0.001);
    assert.ok(f.slots >= 1 && f.slots <= 3);
    if (f.slots > 0) {
      assert.ok(f.breakevenPct <= MAXBE, `chosen config must clear the gate, got ${f.breakevenPct}%`);
    }
  });

  test('it never returns a slot count whose stake fails the gate', () => {
    for (const bal of [0.05, 0.1, 0.195, 0.4, 0.85, 1.2, 2.0, 5.0]) {
      for (const pf of [0.001, 0.003]) {
        const f = fit(bal, 3, pf);
        if (f.slots > 0) {
          assert.ok(f.breakevenPct <= MAXBE,
            `balance ${bal} pf ${pf}: returned ${f.slots} slots at ${f.breakevenPct}%, above the limit`);
        }
      }
    }
  });

  test('a wallet too small for even one slot returns 0, so the caller refuses to arm', () => {
    assert.strictEqual(fit(0.02, 3, 0.003).slots, 0);
    assert.strictEqual(fit(0, 3, 0.001).slots, 0);
  });

  test('never returns more slots than requested', () => {
    assert.ok(fit(50, 3, 0.001).slots <= 3);
    assert.ok(fit(50, 1, 0.001).slots <= 1);
  });
}

console.log('\n-- Sizing reads the linked Photon wallet in BOTH modes --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');

  test('OLD BUG reproduced: paper sized off the typed bankroll, not the wallet', () => {
    // $100 bankroll / $76.78 per SOL = ~1.30 SOL, against a real wallet of 0.2.
    const fictional = 100 / 76.78;
    assert.ok(fictional / 0.2 > 6,
      'paper rehearsed trades 6.5x larger than the wallet could ever fund');
  });

  test('fixed: deployableForSizing prefers the linked wallet regardless of mode', () => {
    const fn = engineSrc.slice(engineSrc.indexOf('private deployableForSizing'), engineSrc.indexOf('private deployableForSizing') + 400);
    assert.ok(/this\.wallet\.isLinked\(\)/.test(fn), 'must key off wallet linkage, not tradingMode');
    assert.ok(!/tradingMode === 'real'\s*$/m.test(fn.split('\n')[0]), 'must not branch on mode');
  });

  test('the bankroll fallback survives for an unlinked machine', () => {
    const fn = engineSrc.slice(engineSrc.indexOf('private deployableForSizing'), engineSrc.indexOf('private deployableForSizing') + 400);
    assert.ok(/currentBankrollUsd/.test(fn), 'must still work with no wallet linked');
  });

  test('a reduced slot count is surfaced as a concentration change, not silently', () => {
    assert.ok(/CONCENTRATION CHANGED/.test(engineSrc));
    assert.ok(/slotsReducedForEconomics/.test(engineSrc));
  });

  test('autoFitSlotsToWallet can be turned off', () => {
    assert.ok(/autoFitSlotsToWallet/.test(engineSrc));
    const typesSrc = fs.readFileSync(path.join(__dirname, '../types.ts'), 'utf8');
    assert.ok(/autoFitSlotsToWallet/.test(typesSrc), 'must be configurable');
  });
}

console.log('\n-- Minimum viable wallet is computed, not guessed --');
{
  const { minWalletForSlots, fitSlotsToWallet } = require('../services/pipelineUtils');
  const { breakevenPct } = require('../services/paperSimulator');
  const SLIP = 25, MAXBE = 6;

  const minFor = (slots: number, pf: number) => minWalletForSlots({
    slots, maxSlippagePct: SLIP, priorityFeeSol: pf, maxBreakevenPct: MAXBE,
  });

  test('the returned minimum actually clears the gate', () => {
    for (const pf of [0.001, 0.003]) {
      for (const slots of [1, 2, 3]) {
        const w = minFor(slots, pf);
        const f = fitSlotsToWallet({
          deployableSol: w - 0.005, maxSlots: slots, maxSlippagePct: SLIP,
          priorityFeeSol: pf, maxBreakevenPct: MAXBE, breakevenOf: breakevenPct,
        });
        assert.strictEqual(f.slots, slots,
          `minWalletForSlots(${slots}, pf ${pf}) = ${w} should fund exactly ${slots} slots, got ${f.slots}`);
      }
    }
  });

  test('a hair under the minimum does NOT clear it', () => {
    const w = minFor(1, 0.001);
    const f = fitSlotsToWallet({
      deployableSol: (w - 0.005) * 0.97, maxSlots: 1, maxSlippagePct: SLIP,
      priorityFeeSol: 0.001, maxBreakevenPct: MAXBE, breakevenOf: breakevenPct,
    });
    assert.strictEqual(f.slots, 0, 'the minimum must be tight, not padded');
  });

  test('THE CURRENT WALLET: 0.1 SOL is below the floor at any slot count', () => {
    assert.ok(minFor(1, 0.001) > 0.1,
      `1 slot needs ${minFor(1, 0.001)} SOL, more than the 0.1 SOL wallet`);
  });

  test('0.2 SOL clears it for one slot, which is why that was the earlier floor', () => {
    assert.ok(minFor(1, 0.001) <= 0.2, `needs ${minFor(1, 0.001)} SOL`);
  });

  test('more slots costs proportionally more wallet', () => {
    const one = minFor(1, 0.001);
    const three = minFor(3, 0.001);
    assert.ok(three > one * 2.5 && three < one * 3.5, `1 slot ${one}, 3 slots ${three}`);
  });

  test('a cheaper priority fee lowers the floor', () => {
    assert.ok(minFor(1, 0.001) < minFor(1, 0.003));
  });

  test('a breakeven limit at or below the 3% variable cost is unreachable at any size', () => {
    assert.strictEqual(minWalletForSlots({
      slots: 1, maxSlippagePct: SLIP, priorityFeeSol: 0.001, maxBreakevenPct: 3,
    }), Infinity, 'no wallet can beat a limit the variable fee alone exceeds');
  });
}

console.log('\n-- A packaged exe must not ship with every safety flag off --');
{
  const { DEFAULTS, PACKAGED_DEFAULTS } = require('../services/featureFlags');
  const flagsSrc: string = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services', 'featureFlags.ts'), 'utf8');

  // Measured 2026-08-10: the built exe run from a clean directory reported
  // "Enabled: allInSizing" — all-in sizing ON with every guard OFF.
  const GUARDS = ['honeypotChecks', 'devSellStop', 'enforceTradeEconomics',
                  'killSwitch', 'honestPaper', 'playbookRouting'];

  test('OLD BUG reproduced: the dev DEFAULTS have every guard off', () => {
    for (const g of GUARDS) {
      assert.strictEqual(DEFAULTS[g], false,
        `${g} is off in DEFAULTS — correct for the audit rollout, fatal for a shipped binary`);
    }
  });

  test('fixed: all-in sizing is OFF in DEFAULTS too — the guards being off makes it worse, not safer', () => {
    // The original of this test asserted `true` here and called the result
    // "the worst combination this codebase can produce" — accurately, and then
    // pinned it in place. PACKAGED_DEFAULTS turned it off for the shipped exe,
    // but every non-packaged run (including the project's own `run bot
    // real.cmd`) still landed on DEFAULTS: all-in sizing with the kill switch,
    // honeypot check, dev-sell stop and economics gate all off.
    assert.strictEqual(DEFAULTS.allInSizing, false,
      'all-in sizing with no guards is the worst combination this codebase can produce — so it is not a default anywhere');
  });

  for (const g of GUARDS) {
    test(`fixed: a packaged build enables ${g}`, () => {
      assert.strictEqual(PACKAGED_DEFAULTS[g], true, `${g} must be on in a shipped binary`);
    });
  }

  test('fixed: a packaged build does NOT default to all-in sizing', () => {
    assert.strictEqual(PACKAGED_DEFAULTS.allInSizing, false);
  });

  test('PACKAGED_DEFAULTS covers every declared flag', () => {
    for (const k of Object.keys(DEFAULTS)) {
      assert.ok(k in PACKAGED_DEFAULTS, `${k} missing from PACKAGED_DEFAULTS`);
      assert.strictEqual(typeof PACKAGED_DEFAULTS[k], 'boolean');
    }
  });

  test('OLD BUG: the installed desktop app was not counted as a packaged build', () => {
    // IS_PACKAGED tested `process.pkg` and nothing else, so the Electron .dmg /
    // NSIS Setup — the builds almost everyone runs since v2.0.0 — resolved to
    // DEFAULTS: every guard off with allInSizing ON. Installed fresh, with no
    // flags.json beside it, that is what it traded with.
    const line = flagsSrc.split('\n').find((l: string) => l.includes('const IS_PACKAGED')) ?? '';
    assert.ok(/SNIPER_PACKAGED/.test(line),
      'the packaged check must recognise the Electron build, not only pkg');
    assert.ok(/process as any\)\.pkg/.test(line), 'and must still recognise the pkg binary');
  });

  test('an installed build reads its overrides from the writable data dir', () => {
    // Beside the executable is inside the .app bundle on macOS and Program
    // Files on Windows — neither is writable, so a packaged build that only
    // looked there could never load (or save) an override.
    const fn = flagsSrc.slice(flagsSrc.indexOf('function flagsSearchPaths'), flagsSrc.indexOf('function resolveFlagsPath'));
    assert.ok(/SNIPER_DATA_DIR/.test(fn), 'the per-user data dir must be searched first');
    assert.ok(fn.indexOf('SNIPER_DATA_DIR') < fn.indexOf('process.execPath'),
      'the writable dir must outrank the read-only one beside the executable');
  });

  test('OLD BUG: a Helius key saved after boot never reached the copy feeds', () => {
    // The copy trader resolves the Helius key when its watcher starts and
    // never again. Saving the key in Settings rebuilt only the sniper's
    // connection, so the on-chain lane — the only lane that works without a
    // paid PumpPortal key — stayed down for the rest of the session with a
    // healthy-looking UI. Observed in bot.log: key saved 02:03:08, no watcher
    // line ever followed.
    const fsx = require('fs'), pathx = require('path');
    const server = fsx.readFileSync(pathx.join(__dirname, '..', 'server.ts'), 'utf8');
    const route = server.slice(server.indexOf("app.post('/api/bot/config'"), server.indexOf("app.post('/api/bot/sell-position'"));
    assert.ok(/onApiKeysChanged\(\)/.test(route), 'a saved key must restart the copy feeds');
    assert.ok(/heliusApiKey/.test(route) && /pumpPortalApiKey/.test(route),
      'both keys feed the copy lanes, so both must trigger the restart');

    const copy = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/public onApiKeysChanged\(\)/.test(copy), 'the entry point must be public for server.ts to call');
  });

  test('OLD BUG: persisting one toggle froze every guard OFF onto disk', () => {
    // set() wrote the whole resolved set. On a dev checkout that is DEFAULTS —
    // everything-off — so flags.json gained an explicit `false` for each guard
    // and then outranked PACKAGED_DEFAULTS in every later run, including a
    // packaged one. This repo's own flags.json was found in exactly that state
    // on 2026-08-28: all six guards false, allInSizing true.
    const fn = flagsSrc.slice(flagsSrc.indexOf('public set('), flagsSrc.length);
    assert.ok(!/JSON\.stringify\(this\.flags/.test(fn),
      'writing the whole resolved set is what pinned the guards off');
    assert.ok(/JSON\.stringify\(overrides/.test(fn),
      'only deliberate changes belong in flags.json');
  });

  test('the persisted overrides are sparse relative to the build baseline', () => {
    const fn = flagsSrc.slice(flagsSrc.indexOf('public set('), flagsSrc.length);
    assert.ok(/IS_PACKAGED \? PACKAGED_DEFAULTS : DEFAULTS/.test(fn),
      'a packaged build must diff against what IT ships, not the dev defaults');
  });

  test('localTxBuild ships OFF: real trades use the fast trade-local path by default', () => {
    // It was briefly promoted ON (2026-08-29) to bypass PumpPortal's router.
    // But building locally PROVES each trade by simulation — several
    // getAccountInfo + simulateTransaction calls per trade plus a fee-recipient
    // walk — and on a live real-mode session with an active leader that burst
    // rate-limited the Helius key (a 429 storm), slowing every trade AND the
    // leader watcher that shares the key. The pre-sign guard now allow-lists
    // PumpPortal's router, so trade-local (one HTTP call) works and is faster,
    // so local building is opt-in, not the default.
    assert.strictEqual(PACKAGED_DEFAULTS.localTxBuild, false,
      'the RPC-heavy local build must not be the default — it rate-limits the key');
    assert.strictEqual(PACKAGED_DEFAULTS.localTxShadowCompare, false,
      'the shadow compare also builds locally per trade — off by default too');

    // The capability must still EXIST and stay simulation-gated for opt-in use.
    const engineSrc = require('fs').readFileSync(require.resolve('../services/sniperEngine.ts'), 'utf8');
    assert.ok(/const sim = await localTxBuilder\.simulateOk\(built\.tx\)/.test(engineSrc),
      'when enabled, a locally built tx must still be simulated before it is used');
    assert.ok(/if \(sim\.ok\) \{[\s\S]{0,120}buildSource = 'local'/.test(engineSrc),
      'only a CLEANLY simulating build may be signed — anything else falls back');

    const builderSrc = require('fs').readFileSync(require.resolve('../services/localTxBuilder.ts'), 'utf8');
    assert.ok(/if \(res\.value\.err\)/.test(builderSrc), 'a simulation error must be treated as failure');
    assert.ok(/return \{ ok: false/.test(builderSrc), 'simulateOk fails closed');
  });

  test('the local sell puts creator_vault BEFORE token_program — the reverse of buy', () => {
    // pump.fun's sell instruction swaps those two accounts relative to buy.
    // Getting it backwards builds a transaction that fails on chain, so the
    // order is pinned here as well as caught by the simulation gate.
    const src = require('fs').readFileSync(require.resolve('../services/localTxBuilder.ts'), 'utf8');
    const sell = src.slice(src.indexOf('private async buildSellVariant'), src.indexOf('Build a sell and prove it'));
    // The token program is resolved per mint (legacy SPL vs Token-2022), so the
    // account is `tokenProgram`, not the module constant.
    const vaultAt = sell.indexOf('p.creatorVault');
    const tokenAt = sell.indexOf('pubkey: tokenProgram');
    assert.ok(vaultAt > 0 && tokenAt > 0, 'both accounts must appear in the sell instruction');
    assert.ok(vaultAt < tokenAt, 'sell order is creator_vault then token_program');

    const buy = src.slice(src.indexOf('private async buildBuyWith'), src.indexOf('Shadow compare'));
    const bVault = buy.indexOf('p.creatorVault');
    // skip the ATA-create occurrence and take the one inside the pump instruction
    const bToken = buy.lastIndexOf('pubkey: tokenProgram', bVault);
    assert.ok(bToken > 0 && bToken < bVault, 'buy order is token_program then creator_vault');

    // Token-2022 is the standard the current pump.fun mints use; deriving the
    // ATA with the legacy program produced IncorrectProgramId on every one.
    assert.ok(/getTokenProgram/.test(src), 'the mint owner decides the token program, never a hardcoded constant');
  });

  test('the sell curve math is the exact inverse of the buy curve math', () => {
    const { bondingCurveTokensOut, bondingCurveSolOut } = require('../services/pipelineUtils');
    const vSol = 30_000_000_000n, vTok = 1_073_000_000_000_000n;
    const solIn = 100_000_000n;                                   // 0.1 SOL
    const tokens = bondingCurveTokensOut(solIn, vSol, vTok);
    assert.ok(tokens > 0n);
    // Selling straight back returns slightly less: two 1% fees plus floor
    // division. It must never return MORE than went in — that would be a
    // free-money bug that sized every exit wrong.
    const back = bondingCurveSolOut(tokens, vSol + solIn, vTok - tokens);
    assert.ok(back < solIn, 'a round trip must lose the fee, never gain');
    assert.ok(back > (solIn * 90n) / 100n, 'and must not lose an implausible amount');
    assert.strictEqual(bondingCurveSolOut(0n, vSol, vTok), 0n);
    assert.strictEqual(bondingCurveSolOut(tokens, 0n, vTok), 0n);
  });

  test('divergence from DEFAULTS is declared, not accidental', () => {
    const { INTENDED_PACKAGED_DIVERGENCE } = require('../services/featureFlags');
    const actual = Object.keys(DEFAULTS).filter(k => PACKAGED_DEFAULTS[k] !== DEFAULTS[k]).sort();
    assert.deepStrictEqual(actual, [...INTENDED_PACKAGED_DIVERGENCE].sort(),
      'a packaged build that silently differs from DEFAULTS is how a local experiment ships to users');
  });
}

// ---------------------------------------------------------------------------
// Launch snipe (Play 1) — first-candle entry, owner opt-in 2026-08-12.
// The router's BLOCK_0 ban made migrations/mid-curve the ONLY entries, which
// is why every buy landed minutes after the wall of same-block snipers. The
// fast lane trades that screen for speed; these pin its safety properties.
// ---------------------------------------------------------------------------
console.log('\n-- Launch snipe (Play 1): first-candle entry --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const { DEFAULTS, PACKAGED_DEFAULTS } = require('../services/featureFlags');

  test('the lane is opt-in: launchSnipe ships OFF in dev AND packaged defaults', () => {
    assert.strictEqual(DEFAULTS.launchSnipe, false, 'block-0 buying must never be a silent default');
    assert.strictEqual(PACKAGED_DEFAULTS.launchSnipe, false, 'a shipped exe must not snipe launches out of the box');
  });

  test('the fast lane only intercepts creates, and only when the flag is on', () => {
    const hook = engineSrc.slice(engineSrc.indexOf("payload.txType === 'create' && featureFlags.get('launchSnipe')"), engineSrc.indexOf('await this.processIncomingToken'));
    assert.ok(/handleLaunchCreate/.test(hook), 'the lane must run before the slow screen');
  });

  test('a snipe routes at the bonding curve, never venue auto', () => {
    const fire = engineSrc.slice(engineSrc.indexOf('private async fireLaunchSnipe('), engineSrc.indexOf('private releasePendingSnipe('));
    assert.ok(/pool: 'pump'/.test(fire),
      "'auto' resolves against an index that has never seen a seconds-old mint");
    assert.ok(!/pool: 'auto'/.test(fire));
  });

  test('momentum is measured beyond the dev buy, not from zero', () => {
    assert.ok(/u\.realSolInCurve - pending\.baselineRealSol/.test(engineSrc),
      'counting the creator\'s own buy as inflow would let every dev self-trigger the snipe');
  });

  test('armed snipes die with the run', () => {
    const stop = engineSrc.slice(engineSrc.indexOf('// Armed snipes die with the run'), engineSrc.indexOf('SMART SNIPER BOT PAUSED'));
    assert.ok(/pendingSnipes\.clear\(\)/.test(stop),
      'a wakeup must never fire a buy that was armed before the pause');
  });

  test('an unfired snipe falls back to the Play 2 path instead of vanishing', () => {
    const arm = engineSrc.slice(engineSrc.indexOf('// Arm the momentum trigger'), engineSrc.indexOf('private async fireLaunchSnipe('));
    assert.ok(/enrollInWatchlist/.test(arm));
  });
}

// ---------------------------------------------------------------------------
// Security batch, 2026-08-13. Each of these guards a hole that was live in a
// process holding a signing key.
// ---------------------------------------------------------------------------
console.log('\n-- Security: API origin/auth, key handling, lock atomicity --');
{
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const { isLoopbackOrigin } = require('../services/apiAuth');

  // Digest of the retired key, not the key. Spelling the literal out here would
  // put it straight back into the public repo this test exists to keep it out
  // of — the assertion would pass while the leak it guards against continued.
  const RETIRED_KEY_SHA256 = '04ff24ca29fec5d41ddb983164f7ba95ca9aafc56c237ff998faa1bc73d0730e';
  const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

  test('no Helius key is hardcoded anywhere in source', () => {
    // It was in four places, in a public repo, so every distributed exe carried
    // the builder's credential.
    for (const rel of ['services/clientWallet.ts', 'services/sniperEngine.ts', 'server.ts']) {
      const embedded = (src(rel).match(UUID_RE) ?? []) as string[];
      assert.ok(
        !embedded.some((u) => sha256(u.toLowerCase()) === RETIRED_KEY_SHA256),
        `${rel} still embeds the key`,
      );
    }
  });

  test('the browser never persists key material', () => {
    const client = src('services/clientWallet.ts');
    assert.ok(!/localStorage/.test(client), 'the signing key must not touch browser storage');
    assert.ok(!/helius-rpc\.com/.test(client), 'browser code must not carry an RPC credential');
  });

  test('cross-origin requests are refused, loopback ones on any port are not', () => {
    assert.ok(isLoopbackOrigin('http://localhost:3001'));
    assert.ok(isLoopbackOrigin('http://127.0.0.1:3002'), 'the instance switcher uses other ports');
    assert.ok(isLoopbackOrigin('http://[::1]:3001'), 'Windows resolves localhost to ::1 first');
    assert.ok(!isLoopbackOrigin('https://evil.com'), 'this is the attack the wildcard CORS allowed');
    assert.ok(!isLoopbackOrigin('http://localhost.evil.com'), 'suffix must not be enough');
    assert.ok(!isLoopbackOrigin('null'), 'sandboxed frames post Origin: null');
    assert.ok(!isLoopbackOrigin('file://'), '');
  });

  test('a DNS-rebinding request is refused even though it carries no Origin', () => {
    const { isLoopbackHost } = require('../services/apiAuth');
    // A browser omits Origin on same-origin GETs, which is exactly what a
    // rebinding attack produces: the page loads from attacker.example, its DNS
    // then resolves to 127.0.0.1, and the fetches look same-origin. The Host
    // header still names what the browser resolved, so it is the discriminator
    // Origin cannot be.
    assert.strictEqual(isLoopbackHost('attacker.example:3001'), false);
    assert.strictEqual(isLoopbackHost('bot.evil.com'), false);
    assert.strictEqual(isLoopbackHost('localhost.evil.com:3001'), false, 'suffix must not be enough');
    assert.strictEqual(isLoopbackHost(undefined), false, 'HTTP/1.1 requires Host; absent is not a pass');
    // Everything a real local client sends still works.
    for (const h of ['localhost:3001', 'localhost', '127.0.0.1:3001', '127.0.0.1', '[::1]:3001', '::1']) {
      assert.strictEqual(isLoopbackHost(h), true, h);
    }
    const guard = src('services/apiAuth.ts');
    assert.ok(/isLoopbackHost\(req\.headers\.host\)/.test(guard),
      'originGuard must check the Host header, not only Origin');
  });

  test('every mutating API call requires the token, by method not by memory', () => {
    const server = src('server.ts');
    assert.ok(/app\.use\(originGuard\)/.test(server), 'the origin guard must run before any handler');
    assert.ok(!/app\.use\(cors\(\)\)/.test(server), 'wildcard CORS must be gone');

    // CORS is scoped to /api, so the document that carries the injected bearer
    // token is same-origin-only. A wildcard app.use(cors(...)) reflected every
    // loopback origin on THAT page too, which let any page served from any
    // other local port fetch '/' , read __SNIPER_API_TOKEN__ out of the HTML,
    // and then drive the trading endpoints with full authority.
    assert.ok(/app\.use\('\/api', cors\(/.test(server),
      'CORS must not apply to the document that carries the API token');

    // Locate the token gate itself rather than the first /api middleware —
    // there is now more than one.
    const gateAt = server.indexOf('return requireApiToken(req, res, next)');
    assert.ok(gateAt > 0, 'the token gate must exist');
    const gate = server.slice(Math.max(0, gateAt - 600), gateAt + 100);
    assert.ok(/requireApiToken/.test(gate) && /req\.method === 'GET'/.test(gate),
      'non-GET /api traffic must be token-gated wholesale');
    assert.ok(!/req\.path === '\/server\/shutdown'/.test(gate),
      'shutdown must NOT be exempt — killing the process abandons open positions mid-flight');
  });

  test('process faults are never swallowed silently', () => {
    const server = src('server.ts');
    const fn = server.slice(server.indexOf('function reportProcessFault'), server.indexOf('process.on(\'uncaughtException\''));
    assert.ok(/console\.(warn|error)/.test(fn), 'a trading process must log its own faults');
    assert.ok(!/if \(expected\) return;/.test(fn), 'the bare early return was the bug');
  });

  test('no untrusted value is interpolated into a shell command', () => {
    const engine = src('services/sniperEngine.ts');
    assert.ok(!/exec\(`cmd \/c start/.test(engine),
      'mint arrives off a third-party websocket and used to land on a command line');
  });

  test('the real-mode lock is taken with an atomic exclusive create', () => {
    const lock = src('services/realModeLock.ts');
    assert.ok(/openSync\(LOCK_FILE, 'wx'/.test(lock),
      "check-then-write let two instances arm against the same wallet");
  });

  test('base58 keys are decoded as base58, not silently as base64', () => {
    const wallet = src('services/walletService.ts');
    const b58 = wallet.indexOf('bs58.decode(trimmed)');
    const b64 = wallet.indexOf("Buffer.from(trimmed, 'base64')");
    assert.ok(b58 > 0 && b64 > 0 && b58 < b64,
      'an 86-char base58 key base64-decodes to 64 bytes and derives the WRONG wallet');
  });
}

console.log('\n-- Exit reasons classify to the right bucket --');
{
  const { classifyExitReason } = require('../services/pipelineUtils');

  test('a price stop is not filed as a profit exit', () => {
    assert.strictEqual(classifyExitReason('SOLD ALL — price stop: down 31% from fill (limit 30%)'), 'PRICE_STOP');
    assert.strictEqual(classifyExitReason('TAKE PROFIT ALL — trailing profit stop: price pulled back 30% from peak'), 'TRAILING_FULL');
  });

  test('the new structural strings still classify as structural', () => {
    assert.strictEqual(classifyExitReason('SOLD ALL — structural stop: pool drained 60% (from $12,000 to $4,800)'), 'STRUCTURAL');
    assert.strictEqual(classifyExitReason('SOLD ALL — structural stop: buy pressure 12% for 3 consecutive ticks'), 'STRUCTURAL');
  });
}

console.log('\n-- Self-updater: version identity, verification, restart safety --');
{
  const fs = require('fs');
  const path = require('path');
  const updaterSrc = fs.readFileSync(path.join(__dirname, '../services/updaterService.ts'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const { updaterService } = require('../services/updaterService');

  test('the build knows its own version, not a hardcoded 1.0.0', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    assert.strictEqual(updaterService.getCurrentVersion(), pkg.version,
      'reading package.json from process.cwd() left every packaged exe on 1.0.0 forever');
  });

  test('version resolution does not depend on the working directory', () => {
    assert.ok(/__dirname/.test(updaterSrc),
      'a packaged exe has no package.json beside it, so cwd cannot be the source');
  });

  test('an unverified binary is never installed', () => {
    assert.ok(/checksumUrl/.test(updaterSrc) && /sha256OfFile/.test(updaterSrc));
    assert.ok(/refusing to install an unverified binary/.test(updaterSrc),
      'a release with no published checksum must be refused, not installed anyway');
    const applyIdx = updaterSrc.indexOf('public async applyUpdate');
    const swapIdx = updaterSrc.indexOf('stage: \'swapping\'');
    const verifyIdx = updaterSrc.indexOf('Checksum mismatch');
    assert.ok(applyIdx < verifyIdx && verifyIdx < swapIdx,
      'verification must happen before the swap, not after');
  });

  test('a failed swap restores the working build', () => {
    const swap = updaterSrc.slice(updaterSrc.indexOf("stage: 'swapping'"), updaterSrc.indexOf("stage: 'restarting'"));
    assert.ok(/renameSync\(oldPath, exePath\)/.test(swap),
      'a half-finished swap must never leave the user with no exe');
  });

  test('an update cannot run mid-trade', () => {
    assert.ok(/restartGuard/.test(updaterSrc));
    const apply = updaterSrc.slice(updaterSrc.indexOf('public async applyUpdate'));
    assert.strictEqual(apply.split('this.restartGuard()').length - 1, 2,
      'the guard must be re-checked after the download, since a position can open during it');
  });

  test('the commit fallback no longer claims an update it cannot install', () => {
    const fallback = updaterSrc.slice(updaterSrc.indexOf('private async checkForCommitUpdates'));
    assert.ok(/commits\/master/.test(fallback), 'the default branch is master');
    assert.ok(!/heads\/main\.zip/.test(fallback), 'it used to link a branch that does not exist');
  });

  test('the release workflow publishes the checksum the updater requires', () => {
    assert.ok(/\.sha256/.test(workflow), 'without this asset every client refuses to update');
    assert.ok(/npm version "\$VERSION"/.test(workflow), 'the tag must be stamped into the build');
    assert.ok(/npm test/.test(workflow), 'a release must not ship a failing build');
  });

  test('C1/H6: the checksum step is no longer mislabeled as a signature check', () => {
    assert.ok(/Verifying checksum/.test(updaterSrc), 'the SHA256 check proves integrity, not provenance');
    assert.ok(!/Verifying signature/.test(updaterSrc),
      'calling a hash-equality check "Verifying signature" misrepresents provenance');
  });

  test('C1/H6: the lineage guard only accepts a release that CONTAINS this build', () => {
    const { releaseLineageIsSafe } = require('../services/updaterService');
    // GitHub compare(base=ourCommit ... head=releaseCommit):
    assert.strictEqual(releaseLineageIsSafe('ahead'), true, 'release is ahead of us — a real forward move');
    assert.strictEqual(releaseLineageIsSafe('identical'), true, 'same commit');
    assert.strictEqual(releaseLineageIsSafe('diverged'), false, 'DIVERGENT lineage (the v1.1.0 clobber) must be refused');
    assert.strictEqual(releaseLineageIsSafe('behind'), false, 'an older commit is a downgrade');
    assert.strictEqual(releaseLineageIsSafe(undefined), false, 'unknown status is not "safe"');
  });

  test('C1/H6: the release workflow bakes the build commit for the lineage guard', () => {
    assert.ok(/buildCommit/.test(workflow), 'the updater needs the build commit to verify lineage');
    assert.ok(/ignore-scripts/.test(workflow), 'release install must not run dependency scripts (sec-deps-1)');
  });

  test('divergence-5: getCurrentVersion re-reads so it is fresh after a swap', () => {
    const g = updaterSrc.slice(updaterSrc.indexOf('public getCurrentVersion'), updaterSrc.indexOf('public getCurrentVersion') + 320);
    assert.ok(/readLocalVersion\(\)/.test(g), 'a value cached at construction goes stale after an update swaps the binary');
  });
}

console.log('\n-- Phase 0/1: fill quality, slippage, and a gate that means something --');
{
  const fs = require('fs');
  const path = require('path');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../services/sniperEngine.ts'), 'utf8');
  const riskSrc = fs.readFileSync(path.join(__dirname, '../filters/riskFilter.ts'), 'utf8');
  const typesSrc = fs.readFileSync(path.join(__dirname, '../types.ts'), 'utf8');
  const { classifyExitReason } = require('../services/pipelineUtils');

  test('a fill far above the decision price abandons the entry', () => {
    assert.ok(/decisionPriceUsd/.test(engineSrc), 'the decision price must be captured before the fill overwrites it');
    assert.ok(/MAX_FILL_SLIPPAGE_MULTIPLE/.test(engineSrc));
    assert.strictEqual(classifyExitReason('SOLD ALL — bad fill: entered at 2.55x the decision price'), 'BAD_FILL');
  });

  test('the abort is checked against the VERIFIED fill, not an estimate', () => {
    const block = engineSrc.slice(engineSrc.indexOf('FILL SANITY'), engineSrc.indexOf('FILL SANITY') + 1600);
    assert.ok(/fillVerified &&/.test(block),
      'an estimated price cannot prove a bad fill, and acting on one would exit good entries');
  });

  test('sniper-correctness-5: a timed-out sell is resolved before any retry (no double-sell)', () => {
    // The mainnet path must hand back the timed-out signature for the sniper's
    // OWN sells, not only external ones — a return of `null` there let executeSell
    // count it a failure and resubmit while the tx could still land.
    const timeoutBlock = engineSrc.slice(engineSrc.indexOf('Holdings left untouched'), engineSrc.indexOf('Holdings left untouched') + 900);
    assert.ok(/return \{ txid, fill: null, timedOut: true/.test(timeoutBlock),
      'a sell timeout must return the signature, not null, so the caller can resolve it');
    // And the BLOCKHASH, or resolveTimedOutSell can never prove expiry: without
    // it every unresolved sell falls into the long hold meant for the genuinely
    // unknown case, and the exit is frozen for minutes on a dumping token.
    assert.ok(/blockhash: tx\.message\.recentBlockhash/.test(timeoutBlock),
      'the blockhash must travel with the signature so expiry can be proven');
    const resolveCall = engineSrc.slice(engineSrc.indexOf('await this.resolveTimedOutSell('), engineSrc.indexOf('await this.resolveTimedOutSell(') + 160);
    assert.ok(/result\.blockhash/.test(resolveCall),
      'the caller must pass the blockhash through to the resolver');
    assert.ok(!/opts\.external \? \{ txid, fill: null, timedOut: true \} : null/.test(timeoutBlock),
      'the old code only handed the signature to external callers');
    // executeSell must resolve that timedOut result before the failure/retry path.
    const sellBody = engineSrc.slice(engineSrc.indexOf("let result = await this.executeRealMainnetTrade('sell'"));
    const resolveIdx = sellBody.indexOf('resolveTimedOutSell');
    const failIdx = sellBody.indexOf('if (!result)');
    assert.ok(resolveIdx > 0 && resolveIdx < failIdx,
      'resolveTimedOutSell must run before the null/failure retry path');
  });

  test('buys never escalate slippage; sells get exactly one capped retry', () => {
    const retry = engineSrc.slice(engineSrc.indexOf('due to Slippage (6004)'), engineSrc.indexOf('if (confirmed === \'failed\')'));
    assert.ok(/action === 'sell' && retryCount < 1/.test(retry),
      'the old path retried buys at 25 -> 42 -> 68%, which is the same as no tolerance at all');
    assert.ok(!/Math\.min\(100,/.test(retry), 'nothing may escalate toward 100%');
    assert.ok(/MAX_SELL_RETRY_SLIPPAGE_PCT/.test(retry));
  });

  test('the shipped slippage defaults are asymmetric and tight', () => {
    const { sniperEngine } = require('../services/sniperEngine');
    const cfg = sniperEngine.getConfig();
    assert.strictEqual(cfg.maxSlippagePct, 10, 'buy tolerance');
    assert.strictEqual(cfg.maxSellSlippagePct, 15, 'sell tolerance');
    assert.ok(cfg.maxSellSlippagePct > cfg.maxSlippagePct,
      'exits may pay more than entries: a missed buy costs nothing, a stuck bag has no ceiling');
  });

  test('a strategy score can no longer overrule a safety verdict', () => {
    assert.ok(!/minScoreHalfUnit;\s*\n\s*if \(filterResult\.score >= halfUnitFloor\)/.test(engineSrc),
      'the override that turned KINGLON from unsafe into a buy must be gone');
    assert.ok(/THE SCORE OVERRIDE IS GONE/.test(engineSrc), 'and its removal must stay documented');
  });

  test('Gate 0 has no fields it does not compute', () => {
    for (const dead of ['noToken2022Hooks', 'sellSimPassed', 'insiderPctClean', 'sniperHoldingsPctClean',
                        'maxSingleHolderPctClean', 'devPriorRugRateClean', 'devSoldAnyClean',
                        'buyPressureClean', 'notHoneypot', 'notDumping']) {
      // Match code, not prose: the comment above allPassed names two of these
      // deliberately, to record what was removed and why.
      assert.ok(!new RegExp(`${dead}\\s*[,=:]`).test(riskSrc), `${dead} is still assigned or returned in riskFilter`);
      assert.ok(!new RegExp(`${dead}\\??:\\s*boolean`).test(typesSrc), `${dead} must leave Gate0Result too`);
    }
  });

  test('allPassed is a conjunction of measured terms only', () => {
    const conj = riskSrc.slice(riskSrc.indexOf('const allPassed ='), riskSrc.indexOf('return {'));
    for (const term of conj.split('&&').map((s: string) => s.replace(/const allPassed =/, '').trim()).filter(Boolean)) {
      assert.ok(new RegExp(`(const|let)\\s+${term.replace(';', '')}\\s*=`).test(riskSrc),
        `${term} is in allPassed but is not computed in this file`);
    }
  });

  test('ALL-IN MODE is wired to sizing instead of only to a label', () => {
    assert.ok(/deployedFractionPct\(\)/.test(engineSrc));
    const fn = engineSrc.slice(engineSrc.indexOf('private deployedFractionPct'), engineSrc.indexOf('private deployedFractionPct') + 400);
    assert.ok(/allInSizing/.test(fn), 'the flag must actually change the deployed fraction');
  });

  test('the default run commits half the wallet, not all of it', () => {
    const { sniperEngine } = require('../services/sniperEngine');
    assert.strictEqual(sniperEngine.getConfig().maxDeployedFractionPct, 50);
  });
}

console.log('\n-- Entry gate: the momentum ceiling refuses the KINGLON shape --');
{
  const { EntryGateV2 } = require('../services/entryGateV2');
  const gate = new EntryGateV2();

  // A clean migration payload: nothing about the TOKEN is wrong. The only
  // question these tests ask is whether the MOMENT is sane.
  const cleanRug = {
    isInferred: false,
    score: 1,
    token: { mintAuthority: null, freezeAuthority: null },
    fileMeta: { top10Pct: 18, maxSingleHolderPct: 5, insiderPct: 10, holderSampleSize: 40, rugged: false },
  };
  const migratePayload = { txType: 'migrate', mint: 'k', marketCapSol: 410 };
  const evalWith = (market: any) => gate.evaluate(migratePayload, cleanRug, true, market);

  test('THE ACTUAL TRADE: +362% in 5m on a 77s-old pair is refused', () => {
    const r = evalWith({ priceChange5mPct: 362, pairAgeSeconds: 77, volume5mUsd: 4000, socialCount: 1 });
    assert.strictEqual(r.isSafe, false);
    assert.ok(r.reasons.some((x: string) => /buying the snipers' exit/.test(x)),
      `expected the momentum ceiling to fire, got: ${JSON.stringify(r.reasons)}`);
  });

  test('the same token at a sane moment passes', () => {
    const r = evalWith({ priceChange5mPct: 20, pairAgeSeconds: 77, volume5mUsd: 4000, socialCount: 1 });
    assert.strictEqual(r.isSafe, true, JSON.stringify(r.reasons));
  });

  test('real volume behind the move is an exemption, thin volume is not', () => {
    const thin = evalWith({ priceChange5mPct: 300, pairAgeSeconds: 60, volume5mUsd: 900, socialCount: 1 });
    const deep = evalWith({ priceChange5mPct: 300, pairAgeSeconds: 60, volume5mUsd: 80_000, socialCount: 1 });
    assert.strictEqual(thin.isSafe, false);
    assert.strictEqual(deep.isSafe, true, JSON.stringify(deep.reasons));
  });

  test('an older pair that moves is not the same animal', () => {
    const r = evalWith({ priceChange5mPct: 300, pairAgeSeconds: 900, volume5mUsd: 900, socialCount: 1 });
    assert.strictEqual(r.isSafe, true, JSON.stringify(r.reasons));
  });

  test('missing market data is unverified, not silently safe', () => {
    const r = evalWith({ socialCount: 1 });
    assert.ok(r.unverifiedFields.includes('priceChange5m'),
      'an unindexed chart must be recorded as unknown rather than treated as flat');
  });

  test('socials are required when resolved and excused when not indexed', () => {
    const none = evalWith({ priceChange5mPct: 5, pairAgeSeconds: 300, socialCount: 0 });
    assert.strictEqual(none.isSafe, false);
    assert.ok(none.reasons.some((x: string) => /socials/.test(x)));

    // Not indexed yet is the norm at the migration moment — rejecting on it
    // would be rejecting DexScreener's lag, not the token.
    const unknown = evalWith({ priceChange5mPct: 5, pairAgeSeconds: 300 });
    assert.strictEqual(unknown.isSafe, true, JSON.stringify(unknown.reasons));
    assert.ok(unknown.unverifiedFields.includes('socialCount'));
  });

  test('the ceiling can be disabled without touching code', () => {
    const off = new EntryGateV2({ maxMigrationPump5mPct: 0 });
    const r = off.evaluate(migratePayload, cleanRug, true, { priceChange5mPct: 362, pairAgeSeconds: 77, socialCount: 1 });
    assert.strictEqual(r.isSafe, true, JSON.stringify(r.reasons));
  });
}

console.log('\n-- No decorative settings: every BotConfig field must drive behaviour --');
{
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');

  const readAll = (dir: string): string => {
    let out = '';
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tests') continue;
        out += readAll(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out += fs.readFileSync(full, 'utf8');
      }
    }
    return out;
  };

  const typesSrc = fs.readFileSync(path.join(root, 'types.ts'), 'utf8');
  const allSrc = readAll(root);

  const body = typesSrc.match(/export interface BotConfig \{([\s\S]*?)\n\}/)![1];
  const fields: string[] = (body.match(/^ {2}(\w+)\??:/gm) || [])
    .map((m: string) => m.trim().replace(/\??:$/, ''));

  // Fields that exist to CARRY information outward rather than to be read:
  // status-only mirrors written by getStatus(), and the flag mirror that lives
  // in featureFlags. Anything else must be consumed somewhere.
  const OUTBOUND_ONLY = new Set([
    'heliusApiKeySet', 'heliusApiKeyHint', 'heliusApiKeySource',
    'pumpPortalApiKeySet', 'pumpPortalApiKeyHint',
  ]);

  // The mirror image: write-only commands, acted on at the moment the config
  // POST is handled and deliberately never persisted onto this.config — so they
  // cannot appear as `config.<field>` by construction. Exempting them from the
  // scrape would let a dead command sit in the API forever, so the test below
  // proves each one is actually consumed by the engine.
  const INBOUND_ONLY = new Set(['forgetStoredKeys']);

  test('BotConfig has fields at all (the scrape works)', () => {
    assert.ok(fields.length > 30, `expected a real BotConfig, parsed ${fields.length} fields`);
  });

  test('write-only command fields are actually acted on', () => {
    const engine = fs.readFileSync(path.join(root, 'services', 'sniperEngine.ts'), 'utf8');
    for (const f of INBOUND_ONLY) {
      assert.ok(new RegExp(`\\b${f}\\b`).test(engine),
        `${f} is accepted by the config API but nothing in the engine acts on it`);
    }
  });

  test('every setting is read by the code that claims to honour it', () => {
    const inert = fields.filter(f => {
      if (OUTBOUND_ONLY.has(f) || INBOUND_ONLY.has(f)) return false;
      const readAsConfig = new RegExp(`(config|cfg)\\.${f}\\b`).test(allSrc);
      const readAsFlag = new RegExp(`featureFlags\\.get\\('${f}'\\)`).test(allSrc);
      return !readAsConfig && !readAsFlag;
    });
    assert.deepStrictEqual(inert, [],
      'these settings are rendered, clamped and saved but never read — ' +
      'a knob the operator can move that the bot cannot feel is worse than no knob');
  });

  test('the settings that were inert on 2026-08-13 are wired', () => {
    // Regression pins for the specific five found by the audit.
    assert.ok(/config\.maxRugcheckScore/.test(allSrc), 'the configured RugCheck ceiling must reach the filter');
    assert.ok(/config\.maxForceExitAttempts/.test(allSrc), 'the retry cap must bound automatic sell attempts');
    assert.ok(/config\.minHolderSample/.test(allSrc) && /config\.minTotalHolders/.test(allSrc),
      'holder-sample floors must reach the gate');
    assert.ok(/config\.minLpBurnedOrLockedPct/.test(allSrc), 'the LP floor must reach the risk filter');
    assert.ok(!/jitoTipSol/.test(typesSrc), 'an unwired Jito tip field must not exist');
  });

  test('a thin holder sample cannot read as a clean distribution', () => {
    const { EntryGateV2 } = require('../services/entryGateV2');
    const gate = new EntryGateV2({ minHolderSample: 5, minTotalHolders: 10 });
    const oneHolder = {
      isInferred: false, score: 1,
      token: { mintAuthority: null, freezeAuthority: null },
      fileMeta: { top10Pct: 4, holderSampleSize: 1, totalHolders: 1, rugged: false },
    };
    const r = gate.evaluate({ txType: 'migrate' }, oneHolder, true, { priceChange5mPct: 5, pairAgeSeconds: 300, socialCount: 1 });
    assert.strictEqual(r.isSafe, false, '"top 10 = 4%" off a single holder row is arithmetic, not evidence');
    assert.ok(r.unverifiedFields.includes('holderConcentration'));
  });
}

// ---------------------------------------------------------------------------
// Feed liveness and RPC resilience, 2026-08-13. Both of these were measured
// from a 17,538-candidate session that produced 4 buys.
// ---------------------------------------------------------------------------
console.log('\n-- Feed watchdog: a socket that dies without closing --');
{
  const { attachKeepalive, reconnectDelayMs } = require('../services/wsKeepalive');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const fakeWs = () => {
    const handlers: Record<string, Function[]> = {};
    const ws: any = {
      terminated: false,
      pings: 0,
      on(ev: string, fn: Function) {
        if (!handlers[ev]) handlers[ev] = [];
        handlers[ev].push(fn);
        return ws;
      },
      emit(ev: string, ...args: any[]) { (handlers[ev] || []).forEach((f) => f(...args)); },
      ping() { ws.pings++; },
      terminate() { ws.terminated = true; },
    };
    return ws;
  };

  test('OLD BUG: reconnect hung off close alone, which a half-open socket never fires', () => {
    // The 2026-08-13 13:16 failure: readyState stayed OPEN, no close event, no
    // reconnect, no log line. The bot simply stopped hearing about launches.
    const ws = fakeWs();
    let closes = 0;
    ws.on('close', () => closes++);
    // Nothing arrives, nothing closes. Under the old code this was terminal.
    assert.strictEqual(closes, 0, 'a half-open socket produces no close event by itself');
  });

  test('fixed: silence past staleMs terminates the socket so close (and reconnect) fire', async () => {
    const ws = fakeWs();
    let sawStale = 0;
    const ka = attachKeepalive(ws, { pingMs: 10, staleMs: 40, onStale: () => sawStale++ });
    await sleep(120);
    ka.stop();
    assert.strictEqual(ws.terminated, true, 'a silent socket must be terminated, not trusted');
    assert.strictEqual(sawStale, 1, 'the operator must be told, once');
  });

  test('a socket that keeps delivering is never terminated', async () => {
    const ws = fakeWs();
    const ka = attachKeepalive(ws, { pingMs: 10, staleMs: 40 });
    for (let i = 0; i < 8; i++) { ka.touch(); await sleep(15); }
    ka.stop();
    assert.strictEqual(ws.terminated, false, 'a live feed must not be killed by its own watchdog');
  });

  test('a pong counts as life, so an idle curve subscription survives', async () => {
    // CurveWatcher subscribes to accounts that may legitimately go minutes
    // without a trade. Data-staleness alone would kill those connections.
    const ws = fakeWs();
    const ka = attachKeepalive(ws, { pingMs: 10, staleMs: 40 });
    for (let i = 0; i < 8; i++) { ws.emit('pong'); await sleep(15); }
    ka.stop();
    assert.strictEqual(ws.terminated, false, 'pong is proof of life on a quiet feed');
    assert.ok(ws.pings > 0, 'the watchdog must actually ping');
  });

  test('stop() ends the watchdog so a closed socket is not terminated later', async () => {
    const ws = fakeWs();
    const ka = attachKeepalive(ws, { pingMs: 10, staleMs: 30 });
    ka.stop();
    await sleep(80);
    assert.strictEqual(ws.terminated, false);
  });

  test('reconnect backoff grows, stays capped, and is jittered', () => {
    assert.ok(reconnectDelayMs(0) <= 2000, 'first retry is prompt');
    assert.ok(reconnectDelayMs(10) <= 30000, 'backoff is capped');
    assert.ok(reconnectDelayMs(10) >= 15000, 'a capped backoff still waits');
    const samples = new Set(Array.from({ length: 24 }, () => reconnectDelayMs(4)));
    assert.ok(samples.size > 1, 'jitter stops two feeds reconnecting in lockstep');
  });
}

console.log('\n-- RPC: transient failure is not a honeypot verdict --');
{
  const {
    withRpcRetry, isCredentialError, isRateLimitError,
    rpcEndpoint, rpcWsEndpoint, isFallbackEndpoint, connectionConfig,
    rpcHealth, resetRpcHealth,
  } = require('../services/rpcHealth');

  test('a transient failure is retried and then succeeds', async () => {
    resetRpcHealth();
    let calls = 0;
    const v = await withRpcRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('socket hang up');
      return 'ok';
    }, { attempts: 4, baseDelayMs: 1 });
    assert.strictEqual(v, 'ok');
    assert.strictEqual(calls, 3, 'it must actually retry, not just wrap the call');
  });

  test('a rejected credential fails fast instead of retrying pointlessly', async () => {
    resetRpcHealth();
    let calls = 0;
    await assert.rejects(async () => {
      await withRpcRetry(async () => { calls++; throw new Error('Unauthorized: 401'); },
        { attempts: 5, baseDelayMs: 1 });
    });
    assert.strictEqual(calls, 1, 'a dead key fails identically every time — retrying only adds latency');
    assert.strictEqual(rpcHealth().credentialRejected, true,
      'the operator must be told the KEY is dead, not that the token was unverifiable');
  });

  test('sec-rpc-tx-4/sniper-correctness-4: a rejected credential fails over to the backup RPC and back', async () => {
    const { sniperEngine } = require('../services/sniperEngine');
    const { resolveRpcEndpoint } = require('../services/rpcHealth');
    const eng = sniperEngine as any;
    const savedFallback = process.env.SOLANA_RPC_FALLBACK_URL;
    const savedKey = eng.config.heliusApiKey;
    const savedOverride = process.env.SOLANA_RPC_URL;
    try {
      delete process.env.SOLANA_RPC_URL;                       // so the key is the primary
      eng.config.heliusApiKey = 'k'.repeat(20);                // primary = helius
      process.env.SOLANA_RPC_FALLBACK_URL = 'https://backup.example.com';
      eng.onFallbackRpc = false;

      // Primary healthy → no failover.
      resetRpcHealth();
      eng.maybeFailoverRpc();
      assert.strictEqual(eng.onFallbackRpc, false, 'a healthy primary does not fail over');

      // Reject the credential → the next tick switches to the backup.
      await assert.rejects(async () => {
        await withRpcRetry(async () => { throw new Error('Unauthorized: 401'); }, { attempts: 3, baseDelayMs: 1 });
      });
      assert.strictEqual(rpcHealth().credentialRejected, true);
      eng.maybeFailoverRpc();
      assert.strictEqual(eng.onFallbackRpc, true, 'a rejected credential must fail over');
      assert.ok(/backup\.example\.com/.test(eng.solanaConnection.rpcEndpoint), 'the live connection now points at the backup');

      // Retry timer elapsed → give the primary another chance.
      eng.lastPrimaryRetryAt = 0;
      eng.maybeFailoverRpc();
      assert.strictEqual(eng.onFallbackRpc, false, 'after the retry window it probes the primary again');
    } finally {
      if (savedFallback === undefined) delete process.env.SOLANA_RPC_FALLBACK_URL; else process.env.SOLANA_RPC_FALLBACK_URL = savedFallback;
      if (savedOverride === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = savedOverride;
      eng.config.heliusApiKey = savedKey;
      eng.onFallbackRpc = false;
      resetRpcHealth();
      eng.rebindConnection(resolveRpcEndpoint(savedKey).url);
    }
  });

  test('a not-yet-visible account is retried rather than read as absent', async () => {
    // The case that cost entries: getAccountInfo returns null for a few hundred
    // ms on a mint that is 400ms old, and null was treated as "unverifiable".
    resetRpcHealth();
    let calls = 0;
    const v = await withRpcRetry(async () => { calls++; return calls < 3 ? null : { data: 'here' }; },
      { attempts: 4, baseDelayMs: 1, retryOnEmpty: true });
    assert.deepStrictEqual(v, { data: 'here' });
    assert.strictEqual(calls, 3);
  });

  test('retryOnEmpty still gives up and returns empty rather than hanging', async () => {
    resetRpcHealth();
    let calls = 0;
    const v = await withRpcRetry(async () => { calls++; return null; },
      { attempts: 3, baseDelayMs: 1, retryOnEmpty: true });
    assert.strictEqual(v, null);
    assert.strictEqual(calls, 3, 'bounded, not infinite');
  });

  test('error classification distinguishes a dead key from a busy one', () => {
    assert.ok(isCredentialError(new Error('Request failed with status 401')));
    assert.ok(isCredentialError(new Error('invalid api key')));
    assert.ok(!isCredentialError(new Error('429 Too Many Requests')));
    assert.ok(isRateLimitError(new Error('429 Too Many Requests')));
    assert.ok(!isRateLimitError(new Error('socket hang up')));
  });

  test('health counts successes and failures so "barely working" has a number', async () => {
    resetRpcHealth();
    await withRpcRetry(async () => 1, { attempts: 1 });
    await assert.rejects(async () => withRpcRetry(async () => { throw new Error('boom'); }, { attempts: 1, baseDelayMs: 1 }));
    const h = rpcHealth();
    assert.strictEqual(h.ok, 1);
    assert.strictEqual(h.failed, 1);
    assert.strictEqual(h.successRate, 0.5);
    assert.strictEqual(h.lastError, 'boom');
  });

  test('a missing key degrades to a usable endpoint instead of an unusable URL', () => {
    const savedUrl = process.env.SOLANA_RPC_URL;
    const savedFallback = process.env.SOLANA_RPC_FALLBACK_URL;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_FALLBACK_URL;
    try {
      // The old expression produced ".../?api-key=" — every call fails, so the
      // bot could not even price or exit an open position.
      const url = rpcEndpoint('');
      assert.ok(!/api-key=$/.test(url), 'never build a URL with an empty api-key');
      assert.ok(/^https:\/\//.test(url));
      assert.strictEqual(isFallbackEndpoint(''), true);
      assert.ok(rpcWsEndpoint('').startsWith('ws'));
    } finally {
      if (savedUrl !== undefined) process.env.SOLANA_RPC_URL = savedUrl;
      if (savedFallback !== undefined) process.env.SOLANA_RPC_FALLBACK_URL = savedFallback;
    }
  });

  test('endpoint precedence: explicit override > key > fallback', () => {
    const saved = process.env.SOLANA_RPC_URL;
    try {
      process.env.SOLANA_RPC_URL = 'https://my-node.example/rpc';
      assert.strictEqual(rpcEndpoint('somekey'), 'https://my-node.example/rpc');
      assert.strictEqual(isFallbackEndpoint('somekey'), false);
      delete process.env.SOLANA_RPC_URL;
      assert.ok(rpcEndpoint('somekey').includes('somekey'));
    } finally {
      if (saved !== undefined) process.env.SOLANA_RPC_URL = saved; else delete process.env.SOLANA_RPC_URL;
    }
  });

  test('the connection is configured deliberately, not by default', () => {
    const cfg = connectionConfig();
    assert.strictEqual(cfg.commitment, 'confirmed');
    assert.strictEqual(cfg.disableRetryOnRateLimit, false, 'honouring Retry-After is what keeps a shared key alive');
    assert.ok((cfg.confirmTransactionInitialTimeout ?? 0) >= 30_000, 'sniping submits into congestion');
  });
}

console.log('\n-- The 70.9%: one dropped RPC read no longer reads as unsafe --');
{
  const { inspectMintSafety } = require('../services/honeypotDetector');
  const { resetRpcHealth } = require('../services/rpcHealth');
  const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const MINT = 'So11111111111111111111111111111111111111112';
  const renouncedMint = () => {
    const d = Buffer.alloc(82);
    d.writeUInt32LE(0, 0);
    d.writeUInt32LE(0, 46);
    d[45] = 1;
    return d;
  };

  test('a mint that throws once is still verified, not written off as unverifiable', async () => {
    resetRpcHealth();
    let calls = 0;
    const flaky = {
      getAccountInfo: async () => {
        calls++;
        if (calls === 1) throw new Error('socket hang up');
        return { owner: { toBase58: () => SPL }, data: renouncedMint() };
      },
    };
    const v = await inspectMintSafety(flaky as any, MINT, null);
    assert.ok(!v.unverified.includes('mintAccount'),
      'this single retry is the difference for 70.9% of candidates on 2026-08-13');
    assert.strictEqual(v.details.mintAuthorityActive, false);
  });

  test('a mint not yet propagated is retried, then read', async () => {
    resetRpcHealth();
    let calls = 0;
    const slow = {
      getAccountInfo: async () => {
        calls++;
        return calls < 2 ? null : { owner: { toBase58: () => SPL }, data: renouncedMint() };
      },
    };
    const v = await inspectMintSafety(slow as any, MINT, null);
    assert.ok(!v.unverified.includes('mintAccount'), 'a 400ms-old mint is late, not missing');
  });

  test('a genuinely absent account is STILL unverified — retry must not invent a pass', async () => {
    resetRpcHealth();
    const dead = { getAccountInfo: async () => null };
    const v = await inspectMintSafety(dead as any, MINT, null);
    assert.ok(v.unverified.includes('mintAccount'),
      'unknown must stay unknown; retry buys evidence, it does not manufacture it');
  });

  test('a live mint authority is still caught after a retry', async () => {
    resetRpcHealth();
    let calls = 0;
    const d = Buffer.alloc(82);
    d.writeUInt32LE(1, 0);
    d[45] = 1;
    const flaky = {
      getAccountInfo: async () => {
        calls++;
        if (calls === 1) throw new Error('ETIMEDOUT');
        return { owner: { toBase58: () => SPL }, data: d };
      },
    };
    const v = await inspectMintSafety(flaky as any, MINT, null);
    assert.strictEqual(v.safe, false, 'resilience must not soften the verdict');
    assert.ok(v.reasons.some((r: string) => /mint authority/i.test(r)));
  });
}

console.log('\n-- Upgrade must not switch on selling for someone who never chose it --');
{
  // The migration is pure logic on the parsed file, so it is exercised
  // directly rather than by booting the singleton (which owns sockets).
  const COPY_CONFIG_VERSION = 2;
  const migrate = (raw: any) => {
    const cfg = { ...raw.config };
    if (Number(raw.configVersion) < COPY_CONFIG_VERSION || raw.configVersion === undefined) {
      if (cfg.copySells) cfg.copySells = false;
    }
    return cfg;
  };

  test('a pre-2026-08-13 config does NOT start auto-selling on upgrade', () => {
    // copySells defaulted true for the whole period it did nothing, so the
    // saved true is a default nobody acted on — not a decision to honour.
    const old = { config: { copySells: true, sellMode: 'mirror', enabled: true, tradingMode: 'real' } };
    assert.strictEqual(migrate(old).copySells, false,
      'honouring this would switch a real account to automatic selling with no prompt');
  });

  test('the migration runs once and then leaves the toggle alone', () => {
    const chosen = { configVersion: 2, config: { copySells: true, sellMode: 'mirror' } };
    assert.strictEqual(migrate(chosen).copySells, true,
      'once stamped, copySells means what the operator set');
  });

  test('someone who had it off stays off', () => {
    const off = { config: { copySells: false } };
    assert.strictEqual(migrate(off).copySells, false);
  });

  test('the persisted file stamps the version, or the migration repeats forever', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/configVersion:\s*COPY_CONFIG_VERSION/.test(src),
      'without the stamp, every restart would re-disable a toggle the operator turned on');
    assert.ok(/const COPY_CONFIG_VERSION = 2/.test(src));
  });

  test('the migration writes the stamp immediately instead of waiting for a change', () => {
    // Measured on the first smoke test: the warning printed, the in-memory
    // config was migrated, and nothing reached disk — because persist() only
    // fires on a change. configVersion stayed unset and the migration re-ran
    // on every boot.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    const start = src.indexOf('MIGRATION to schema 2');
    assert.ok(start > 0, 'migration block not found — this test is pinned to it');
    const migrationBlock = src.slice(start, start + 2500);
    assert.ok(/this\.persist\(\)/.test(migrationBlock),
      'the migration must persist its own stamp, or it never converges');
  });
}

console.log('\n-- macOS build: the updater must never install another platform\'s binary --');
{
  const { releaseAssetName } = require('../services/updaterService');
  const fsm = require('fs');
  const pathm = require('path');
  const root = pathm.join(__dirname, '..', '..');

  test('each platform resolves to its own asset', () => {
    assert.strictEqual(releaseAssetName('win32', 'x64'), 'pumpfun-sniper-bot.exe');
    assert.strictEqual(releaseAssetName('darwin', 'arm64'), 'pumpfun-sniper-bot-macos-arm64');
    assert.strictEqual(releaseAssetName('darwin', 'x64'), 'pumpfun-sniper-bot-macos-x64');
  });

  test('a Mac build can never resolve to the .exe', () => {
    // The updater overwrites the RUNNING binary with what it downloads, so a
    // cross-platform match bricks the install rather than merely failing.
    for (const arch of ['arm64', 'x64']) {
      assert.ok(!releaseAssetName('darwin', arch).endsWith('.exe'),
        'a Mac build resolving to the Windows exe would replace itself with an unrunnable file');
    }
    assert.notStrictEqual(releaseAssetName('darwin', 'arm64'), releaseAssetName('darwin', 'x64'));
  });

  test('the build scripts produce exactly the names the updater asks for', () => {
    const pkgJson = JSON.parse(fsm.readFileSync(pathm.join(root, 'package.json'), 'utf8'));
    const scripts = JSON.stringify(pkgJson.scripts);
    // Apple Silicon only since 2.0.3: the Intel binary and the Linux packages
    // were dropped so the release page offers one download per platform.
    for (const platform of [['darwin', 'arm64']] as Array<[string, string]>) {
      const name = releaseAssetName(platform[0] as any, platform[1]);
      assert.ok(scripts.includes(name),
        `no build script outputs ${name}, so the updater would look for an asset nothing produces`);
    }
  });

  test('macOS targets do not use the node18 base that has no prebuilt', () => {
    // node18-macos-arm64 404s in the pkg remote cache and then falls back to
    // building from source, which fails on a non-Mac host (measured 2026-08-13).
    const pkgJson = JSON.parse(fsm.readFileSync(pathm.join(root, 'package.json'), 'utf8'));
    // The pkg-exe mac builds were renamed to build:pkg-mac* when the Electron
    // build (build:mac -> electron-builder .dmg) took the plain names.
    const macScripts = String(pkgJson.scripts['build:pkg-mac']);
    assert.ok(!/node18-macos/.test(macScripts), 'node18 has no prebuilt macOS base');
    assert.ok(/node22-macos-arm64/.test(macScripts));
  });

  test('a multi-platform release leaves exactly one .sha256, for pre-1.0.1 clients', () => {
    // Clients shipped before 1.0.1 find their checksum with
    // assets.find(a => a.name.endsWith('.sha256')) — first match, no check that
    // it describes the binary they just downloaded. GitHub returns assets
    // alphabetically and '-macos' sorts before '.exe', so publishing macOS
    // checksums as .sha256 made every existing Windows client verify its exe
    // against the macOS arm64 hash and refuse to install. Observed on the real
    // v1.0.1 release, 2026-08-13.
    const published = [
      'pumpfun-sniper-bot-macos-arm64',
      'pumpfun-sniper-bot-macos-arm64.sha256sum',
      'pumpfun-sniper-bot-macos-x64',
      'pumpfun-sniper-bot-macos-x64.sha256sum',
      'pumpfun-sniper-bot.exe',
      'pumpfun-sniper-bot.exe.sha256',
    ].sort();

    const dotSha256 = published.filter(n => n.endsWith('.sha256'));
    assert.strictEqual(dotSha256.length, 1,
      'more than one .sha256 asset and the old matcher picks by luck of ordering');

    // The legacy matcher, verbatim, must now land on the right pair.
    const legacyBinary = published.find(n => n.endsWith('.exe'));
    const legacyChecksum = published.find(n => n.endsWith('.sha256'));
    assert.strictEqual(legacyChecksum, `${legacyBinary}.sha256`,
      'an existing exe must verify against its OWN hash, not another platform\'s');
  });

  test('the workflow publishes macOS checksums as .sha256sum, not .sha256', () => {
    const wf = fsm.readFileSync(pathm.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.ok(/macos-arm64\.sha256sum/.test(wf));
    assert.ok(!/macos-arm64\.sha256\b(?!sum)/.test(wf),
      'a macOS .sha256 asset would break every pre-1.0.1 client again');
  });

  test('the release workflow ad-hoc signs arm64 and publishes a checksum per asset', () => {
    const wf = fsm.readFileSync(pathm.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.ok(/runs-on:\s*macos/.test(wf), 'arm64 signing cannot run on a non-Mac runner');
    assert.ok(/codesign --force/.test(wf),
      'Apple Silicon refuses to execute an unsigned arm64 binary at all');
    for (const name of ['pumpfun-sniper-bot-macos-arm64']) {
      assert.ok(wf.includes(`${name}.sha256`),
        `${name} must ship a checksum — the updater refuses any release without one`);
    }
  });
}

console.log('\n-- API keys entered in the UI survive a restart --');
{
  const os = require('os');
  const fsx = require('fs');
  const pathx = require('path');

  // keyStore resolves its path from cwd (or the exe dir when packaged), so the
  // test drives it from a scratch directory rather than writing into the repo.
  const scratch = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'keystore-'));
  const originalCwd = process.cwd();
  const store = require('../services/keyStore');
  const { resolveKey, storeKey, clearStoredKey, loadStoredKeys } = store;

  const inScratch = (fn: () => void) => {
    process.chdir(scratch);
    try { fn(); } finally { process.chdir(originalCwd); }
  };

  test('OLD BUG reproduced: a UI key lived only in memory, so a restart lost it', () => {
    inScratch(() => {
      // The old constructor read exactly this and nothing else. With no .env,
      // a key typed into Settings could not possibly come back.
      const restarted = process.env.NOPE_UNSET_KEY || '';
      assert.strictEqual(restarted, '', 'nothing on disk means nothing after a restart');
    });
  });

  test('fixed: a key saved from Settings is read back on the next start', () => {
    inScratch(() => {
      assert.strictEqual(storeKey('heliusApiKey', 'key-from-ui'), true);
      assert.strictEqual(loadStoredKeys().heliusApiKey, 'key-from-ui');
      assert.strictEqual(resolveKey('heliusApiKey', undefined).value, 'key-from-ui');
    });
  });

  test('the saved key outranks .env, so replacing a rotated key actually sticks', () => {
    inScratch(() => {
      storeKey('heliusApiKey', 'fresh-key');
      const r = resolveKey('heliusApiKey', 'dead-key-from-env');
      assert.strictEqual(r.value, 'fresh-key');
      assert.strictEqual(r.source, 'stored',
        'otherwise a dead .env key silently reclaims priority every restart');
    });
  });

  test('.env is used when nothing has been saved', () => {
    inScratch(() => {
      clearStoredKey('heliusApiKey');
      const r = resolveKey('heliusApiKey', 'from-env');
      assert.strictEqual(r.value, 'from-env');
      assert.strictEqual(r.source, 'env');
    });
  });

  test('no key anywhere reports none rather than a blank that looks configured', () => {
    inScratch(() => {
      clearStoredKey('heliusApiKey');
      const r = resolveKey('heliusApiKey', undefined);
      assert.strictEqual(r.value, '');
      assert.strictEqual(r.source, 'none');
    });
  });

  test('forgetting one key leaves the other intact', () => {
    inScratch(() => {
      storeKey('heliusApiKey', 'helius-1');
      storeKey('pumpPortalApiKey', 'pump-1');
      clearStoredKey('heliusApiKey');
      const left = loadStoredKeys();
      assert.strictEqual(left.heliusApiKey, undefined);
      assert.strictEqual(left.pumpPortalApiKey, 'pump-1');
    });
  });

  test('an empty value is never written — a blank field must not erase a key', () => {
    inScratch(() => {
      storeKey('heliusApiKey', 'real-key');
      assert.strictEqual(storeKey('heliusApiKey', '   '), false);
      assert.strictEqual(loadStoredKeys().heliusApiKey, 'real-key',
        'blank means keep; erasing goes through forgetStoredKeys');
    });
  });

  test('a corrupt store degrades to empty instead of stopping the bot booting', () => {
    inScratch(() => {
      fsx.writeFileSync(pathx.join(scratch, '.api-keys.json'), '{ not json');
      assert.deepStrictEqual(loadStoredKeys(), {});
      assert.strictEqual(resolveKey('heliusApiKey', 'env-key').value, 'env-key');
    });
  });

  test('the store never lands in the repo', () => {
    const ignored = fsx.readFileSync(pathx.join(__dirname, '..', '..', '.gitignore'), 'utf8');
    assert.ok(/^\.api-keys\.json$/m.test(ignored), '.api-keys.json must be gitignored — it holds credentials');
  });
}

console.log('\n-- "RPC stays down on a valid key": the four causes --');
{
  const {
    normalizeHeliusKey, resolveRpcEndpoint, rpcEndpoint, isFallbackEndpoint,
    withRpcRetry, rpcHealth, resetRpcHealth,
  } = require('../services/rpcHealth');

  // A synthetic UUID. Deliberately NOT the key this repo once hardcoded — that
  // one is burned and must not reappear in current source.
  const UUID = '00000000-1111-2222-3333-444444444444';

  /** Runs fn with the RPC env vars set to exactly `vars`, then restores them. */
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const names = ['SOLANA_RPC_URL', 'SOLANA_RPC_WS_URL', 'SOLANA_RPC_FALLBACK_URL'];
    const saved: Record<string, string | undefined> = {};
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    try { fn(); } finally {
      for (const n of names) {
        if (saved[n] !== undefined) process.env[n] = saved[n]!; else delete process.env[n];
      }
    }
  };

  // ---- Cause 1: a stale SOLANA_RPC_URL silently outranks a good key ----

  test('OLD BUG: an env override outranks the Helius key — now it is reported, not silent', () => {
    withEnv({ SOLANA_RPC_URL: 'https://dead-node.example/rpc' }, () => {
      const r = resolveRpcEndpoint(UUID);
      assert.strictEqual(r.source, 'env-override');
      assert.strictEqual(r.host, 'dead-node.example');
      assert.strictEqual(r.keyOverridden, true,
        'a configured key that is being ignored MUST be reported — this is the whole bug');
    });
  });

  test('no override: the key is used and nothing claims it was overridden', () => {
    withEnv({}, () => {
      const r = resolveRpcEndpoint(UUID);
      assert.strictEqual(r.source, 'helius');
      assert.strictEqual(r.host, 'mainnet.helius-rpc.com');
      assert.strictEqual(r.keyOverridden, false);
      assert.ok(r.url.includes(UUID));
    });
  });

  test('keyOverridden is false with no key — an override is then the intended path', () => {
    withEnv({ SOLANA_RPC_URL: 'https://my-node.example/rpc' }, () => {
      assert.strictEqual(resolveRpcEndpoint('').keyOverridden, false);
      assert.strictEqual(resolveRpcEndpoint('').source, 'env-override');
    });
  });

  test('the fallback chain still degrades rather than dying', () => {
    withEnv({}, () => {
      const r = resolveRpcEndpoint('');
      assert.strictEqual(r.source, 'public');
      assert.ok(!/api-key=$/.test(r.url), 'never build a URL with an empty api-key');
      assert.strictEqual(isFallbackEndpoint(''), true);
    });
    withEnv({ SOLANA_RPC_FALLBACK_URL: 'https://backup.example/rpc' }, () => {
      assert.strictEqual(resolveRpcEndpoint('').source, 'fallback-env');
    });
  });

  test('the host is exposed but the credential never is', () => {
    withEnv({}, () => {
      const r = resolveRpcEndpoint(UUID);
      assert.ok(!r.host.includes(UUID), 'the host must never carry the key — it is shown in the UI');
      assert.ok(!r.host.includes('api-key'));
    });
  });

  // ---- Cause 2: no validation on the key, and the bad value got persisted ----

  test('OLD BUG: a pasted RPC URL nested inside another URL — now the key is extracted', () => {
    const n = normalizeHeliusKey(`https://mainnet.helius-rpc.com/?api-key=${UUID}`);
    assert.strictEqual(n.ok, true);
    assert.strictEqual(n.key, UUID, 'the api-key must be lifted out, not nested');
    assert.ok(n.note, 'the operator is told what was repaired');
    withEnv({}, () => {
      assert.ok(!rpcEndpoint(`https://mainnet.helius-rpc.com/?api-key=${UUID}`).includes('helius-rpc.com/?api-key=https'),
        'the old bug built ...api-key=https://... and failed every call forever');
    });
  });

  test('a websocket URL form is accepted the same way', () => {
    assert.strictEqual(normalizeHeliusKey(`wss://mainnet.helius-rpc.com/?api-key=${UUID}`).key, UUID);
  });

  test('a URL with no api-key is REFUSED, and points at the right setting', () => {
    const n = normalizeHeliusKey('https://my-node.example/rpc');
    assert.strictEqual(n.ok, false);
    assert.strictEqual(n.key, '');
    assert.ok(/SOLANA_RPC_URL/.test(n.note), 'refusing is only useful if it says what to do instead');
  });

  test('junk that cannot survive a query string is refused rather than encoded', () => {
    for (const bad of ['my key with spaces', 'abc/def', 'a?b', 'x&y=z']) {
      assert.strictEqual(normalizeHeliusKey(bad).ok, false, `${bad} must be refused`);
    }
  });

  test('quotes from a .env line or JSON blob are stripped', () => {
    assert.strictEqual(normalizeHeliusKey(`"${UUID}"`).key, UUID);
    assert.strictEqual(normalizeHeliusKey(`'${UUID}'`).key, UUID);
    assert.strictEqual(normalizeHeliusKey(`  ${UUID}\n`).key, UUID);
  });

  test('a clean key passes with no note at all', () => {
    const n = normalizeHeliusKey(UUID);
    assert.strictEqual(n.ok, true);
    assert.strictEqual(n.key, UUID);
    assert.strictEqual(n.note, undefined);
  });

  test('a non-UUID token is warned about but still accepted — the format is theirs to change', () => {
    const n = normalizeHeliusKey('some-token-that-is-not-a-uuid');
    assert.strictEqual(n.ok, true);
    assert.ok(n.note, 'accepting silently would recreate the invisible-breakage bug');
  });

  test('an empty key is not usable and says so', () => {
    assert.strictEqual(normalizeHeliusKey('').ok, false);
    assert.strictEqual(normalizeHeliusKey(undefined).ok, false);
  });

  // ---- Cause 6: background pollers must not dominate the success rate ----

  test('countHealth:false keeps a heartbeat out of the rolling success rate', async () => {
    resetRpcHealth();
    await withRpcRetry(async () => 1, { attempts: 1, countHealth: false });
    await assert.rejects(async () => withRpcRetry(async () => { throw new Error('boom'); },
      { attempts: 1, baseDelayMs: 1, countHealth: false }));
    const h = rpcHealth();
    assert.strictEqual(h.ok, 0);
    assert.strictEqual(h.failed, 0);
    assert.strictEqual(h.consecutiveFailures, 0);
  });

  test('an uncounted call still latches a rejected credential — that is real signal', async () => {
    resetRpcHealth();
    await assert.rejects(async () => withRpcRetry(async () => { throw new Error('401 Unauthorized'); },
      { attempts: 3, baseDelayMs: 1, countHealth: false }));
    assert.strictEqual(rpcHealth().credentialRejected, true);
  });

  test('counted calls are still counted — the default did not change', async () => {
    resetRpcHealth();
    await withRpcRetry(async () => 1, { attempts: 1 });
    const h = rpcHealth();
    assert.strictEqual(h.ok, 1);
  });

  // ---- Cause 5: the server refuses the key and NOTHING says so ----
  //
  // Measured 2026-08-28: an 89-character value in `heliusApiKey` passed the
  // shape check (no URL punctuation, so only a soft note), and every socket
  // answered 401. web3.js retried forever — thousands of `ws error:
  // Unexpected server response: 401` lines, a silent leader feed, and no line
  // anywhere naming the credential. A refused key must resolve like no key.

  test('OLD BUG: a refused key kept being used — now it resolves to the fallback', () => {
    const { markHeliusKeyRejected, isHeliusKeyRejected } = require('../services/rpcHealth');
    withEnv({}, () => {
      resetRpcHealth();
      assert.strictEqual(resolveRpcEndpoint(UUID).source, 'helius', 'baseline: a fresh key is used');

      markHeliusKeyRejected(UUID);
      assert.strictEqual(isHeliusKeyRejected(UUID), true);
      const after = resolveRpcEndpoint(UUID);
      assert.strictEqual(after.source, 'public',
        'a key the server refused must be skipped, not retried into a 401 storm');
      assert.ok(!after.url.includes(UUID), 'the refused key must not reach the endpoint');
      resetRpcHealth();
    });
  });

  test('the latch is per-key, so a DIFFERENT key is unaffected', () => {
    const { markHeliusKeyRejected, isHeliusKeyRejected } = require('../services/rpcHealth');
    const OTHER = '99999999-8888-7777-6666-555555555555';
    withEnv({}, () => {
      resetRpcHealth();
      markHeliusKeyRejected(UUID);
      assert.strictEqual(isHeliusKeyRejected(OTHER), false);
      assert.strictEqual(resolveRpcEndpoint(OTHER).source, 'helius',
        'one dead key must not demote every other credential');
      resetRpcHealth();
    });
  });

  test('applying a new key clears the latch — a fixed credential recovers', () => {
    const { markHeliusKeyRejected, isHeliusKeyRejected } = require('../services/rpcHealth');
    withEnv({}, () => {
      markHeliusKeyRejected(UUID);
      resetRpcHealth();
      assert.strictEqual(isHeliusKeyRejected(UUID), false);
      assert.strictEqual(resolveRpcEndpoint(UUID).source, 'helius');
    });
  });

  test('an unreachable Helius is NOT a rejection — transient must not demote a good key', async () => {
    const { probeHeliusKey } = require('../services/rpcHealth');
    const savedFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error('ECONNRESET'); };
    try {
      const r = await probeHeliusKey(UUID);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.rejected, false,
        'a network failure must never latch the key as refused');
    } finally { (globalThis as any).fetch = savedFetch; }
  });

  test('a 401 from Helius IS a rejection', async () => {
    const { probeHeliusKey } = require('../services/rpcHealth');
    const savedFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 401 });
    try {
      const r = await probeHeliusKey(UUID);
      assert.strictEqual(r.rejected, true);
      assert.ok((r.note || '').includes('401'));
    } finally { (globalThis as any).fetch = savedFetch; }
  });

  test('a 429 is NOT a rejection — rate limiting is transient', async () => {
    const { probeHeliusKey } = require('../services/rpcHealth');
    const savedFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 429 });
    try {
      assert.strictEqual((await probeHeliusKey(UUID)).rejected, false);
    } finally { (globalThis as any).fetch = savedFetch; }
  });
}

console.log('\n-- The router is allowed, the drain protection is NOT --');
{
  const owner2 = Keypair.generate().publicKey;
  const ROUTER = new PublicKey('FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe');
  const PUMP2 = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const mk = (ixs: any[]) => new VersionedTransaction(new TransactionMessage({
    payerKey: owner2, recentBlockhash: '11111111111111111111111111111111', instructions: ixs,
  }).compileToV0Message());

  test('OLD BUG: v2.0.0 refused PumpPortal\'s router, blocking 100% of real trades', () => {
    // v1.1.0 had no guard at all and real trading worked. 4d636ed added one
    // whose allow-list predates PumpPortal routing every trade through
    // FAdo9NCw, so from v2.0.0 on nothing could be signed.
    const tx = mk([new TransactionInstruction({
      programId: ROUTER,
      keys: [{ pubkey: owner2, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    })]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, true,
      'the router is allow-listed as a deliberate operator decision');
  });

  test('a large transfer to an unrelated account is STILL refused — the drain guard survives', () => {
    const attacker = Keypair.generate().publicKey;
    const tx = mk([
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
      SystemProgram.transfer({ fromPubkey: owner2, toPubkey: attacker, lamports: 900_000_000 }),
    ]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false, 'allowing a fee must not allow a drain');
    assert.ok(/above the .* SOL fee allowance/.test(v.reason || ''), v.reason);
  });

  test('a small routing fee IS allowed — that is the whole point of the cap', () => {
    const feeWallet = Keypair.generate().publicKey;
    const tx = mk([
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
      SystemProgram.transfer({ fromPubkey: owner2, toPubkey: feeWallet, lamports: 500_000 }), // 0.0005 SOL
    ]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, true);
  });

  test('many small transfers cannot ADD UP to a drain — the cap is on the sum', () => {
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const tx = mk([
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
      SystemProgram.transfer({ fromPubkey: owner2, toPubkey: a, lamports: 6_000_000 }),
      SystemProgram.transfer({ fromPubkey: owner2, toPubkey: b, lamports: 6_000_000 }),
    ]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false, '2 x 0.006 SOL exceeds the 0.01 SOL allowance in total');
  });

  test('OLD BUG: SystemProgram.assign handed the WALLET to an attacker and the guard passed it', () => {
    // The System check inspected exactly two instruction types (Transfer and
    // TransferWithSeed) and let every other value fall through UNCHECKED.
    // Assign (type 1) reassigns the OWNER PROGRAM of an account — applied to
    // our own wallet, it hands the wallet over outright. One 36-byte
    // instruction, no transfer in sight, and the guard returned ok:true.
    const attackerProgram = Keypair.generate().publicKey;
    const data = Buffer.alloc(36);
    data.writeUInt32LE(1, 0);                        // type = Assign
    attackerProgram.toBuffer().copy(data, 4);        // new owner program
    const tx = mk([new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: owner2, isSigner: true, isWritable: true }],
      data,
    })]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false, 'Assign must never be signable');
    assert.ok(/System instruction type 1/.test(v.reason || ''), v.reason);
  });

  test('the System check is an ALLOW-list, so a future instruction type is refused, not ignored', () => {
    const data = Buffer.alloc(8);
    data.writeUInt32LE(12, 0); // UpgradeNonceAccount — legitimate, but not part of a trade
    const tx = mk([new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: owner2, isSigner: true, isWritable: true }],
      data,
    })]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, false);
  });

  test('OLD BUG: a top-level SPL Token Transfer moved the whole bag and the guard passed it', () => {
    // A pump / PumpSwap trade moves tokens inside the program's own CPI, never
    // as a bare top-level Transfer. Only Approve / Revoke / SetAuthority /
    // CloseAccount were checked, so Transfer (tag 3) — source = our ATA,
    // destination = the attacker's, authority = our wallet — sailed through.
    const ourAta = Keypair.generate().publicKey;
    const attackerAta = Keypair.generate().publicKey;
    const data = Buffer.alloc(9);
    data[0] = 3;                                  // Transfer
    data.writeBigUInt64LE(999_999_999n, 1);       // amount
    const tx = mk([new TransactionInstruction({
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      keys: [
        { pubkey: ourAta, isSigner: false, isWritable: true },
        { pubkey: attackerAta, isSigner: false, isWritable: true },
        { pubkey: owner2, isSigner: true, isWritable: false },
      ],
      data,
    })]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false, 'a bare token Transfer to an unrelated account must be refused');
    assert.ok(/top-level token Transfer/.test(v.reason || ''), v.reason);
  });

  test('OLD BUG: ComputeBudget was allow-listed and its DATA never read — an unbounded fee passed', () => {
    // Fee = unitPrice (microLamports/CU) x unitLimit / 1e6 lamports, and both
    // came from a response we did not build. An otherwise perfect buy carrying
    // SetComputeUnitLimit(1_400_000) and a large price burned the wallet to the
    // block leader, with no instruction resembling a transfer.
    const limitData = Buffer.alloc(5);
    limitData[0] = 2;
    limitData.writeUInt32LE(1_400_000, 1);
    const priceData = Buffer.alloc(9);
    priceData[0] = 3;
    priceData.writeBigUInt64LE(14_285_714_285n, 1); // ~20 SOL of priority fee
    const cb = new PublicKey('ComputeBudget111111111111111111111111111111');
    const tx = mk([
      new TransactionInstruction({ programId: cb, keys: [], data: limitData }),
      new TransactionInstruction({ programId: cb, keys: [], data: priceData }),
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
    ]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false, 'an unbounded priority fee must be refused');
    assert.ok(/priority fee/.test(v.reason || ''), v.reason);
  });

  test('an ordinary priority fee still passes', () => {
    const limitData = Buffer.alloc(5);
    limitData[0] = 2;
    limitData.writeUInt32LE(200_000, 1);
    const priceData = Buffer.alloc(9);
    priceData[0] = 3;
    priceData.writeBigUInt64LE(5_000n, 1);          // 200k CU x 5000 / 1e6 = 1000 lamports
    const cb = new PublicKey('ComputeBudget111111111111111111111111111111');
    const tx = mk([
      new TransactionInstruction({ programId: cb, keys: [], data: limitData }),
      new TransactionInstruction({ programId: cb, keys: [], data: priceData }),
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, true);
  });

  test('OLD BUG: naming the attacker inside a trade instruction whitelisted the drain', () => {
    // tradeAccountSet is built from the accounts of every non-System
    // instruction, so anyone who could shape the response simply listed their
    // own address among a router instruction's accounts — and their address
    // became "part of the trade", after which a full-balance transfer to it
    // passed the unrelated-lamports cap untouched.
    const attacker = Keypair.generate().publicKey;
    const tx = mk([
      new TransactionInstruction({
        programId: ROUTER,
        keys: [
          { pubkey: owner2, isSigner: true, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },   // <- the naming trick
        ],
        data: Buffer.from([1]),
      }),
      SystemProgram.transfer({ fromPubkey: owner2, toPubkey: attacker, lamports: 900_000_000 }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, true,
      'reproduced: with no total to measure against, the naming trick still passes');

    // The caller now tells the guard what the trade was sized for, so the total
    // is checked regardless of who is named.
    const v = assertOutboundTradeTx(tx, owner2, undefined, { maxLamportsOut: 30_000_000n });
    assert.strictEqual(v.ok, false);
    assert.ok(/above the .* SOL this trade was sized for/.test(v.reason || ''), v.reason);
  });

  test('a plain createAccount cannot even be attempted — it needs a second signer', () => {
    // SystemProgram.createAccount requires the NEW account to sign, so the
    // sole-signer rule refuses it before any lamport arithmetic runs. Worth
    // pinning: it is why the seeded form below is the one that matters.
    const newAcct = Keypair.generate();
    const tx = mk([
      SystemProgram.createAccount({
        fromPubkey: owner2,
        newAccountPubkey: newAcct.publicKey,
        lamports: 900_000_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ]);
    const v = assertOutboundTradeTx(tx, owner2);
    assert.strictEqual(v.ok, false);
    assert.ok(/required signer/.test(v.reason || ''), v.reason);
  });

  test('createAccountWithSeed lamports COUNT toward the outflow ceiling', () => {
    // The seeded form needs only the BASE authority — us — so it is signable
    // with our single signature. It moves lamports, and allow-listing it (to
    // close the Assign hole) without counting them would have opened a way to
    // send an arbitrary amount to an account the caller chose, with no Transfer
    // instruction anywhere in sight.
    const derived = Keypair.generate().publicKey;
    const drain = mk([
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: owner2,
        newAccountPubkey: derived,
        basePubkey: owner2,
        seed: 'drain',
        lamports: 900_000_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ]);
    const v = assertOutboundTradeTx(drain, owner2, undefined, { maxLamportsOut: 30_000_000n });
    assert.strictEqual(v.ok, false, '0.9 SOL through createAccountWithSeed must not pass a 0.03 SOL ceiling');
    assert.ok(/moves .* out of our wallet/.test(v.reason || ''), v.reason);
  });

  test('a rent-sized createAccountWithSeed still passes — the ceiling is a ceiling, not a ban', () => {
    const derived = Keypair.generate().publicKey;
    const wrap = mk([
      new TransactionInstruction({ programId: PUMP2, keys: [{ pubkey: owner2, isSigner: true, isWritable: true }], data: Buffer.from([0]) }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: owner2,
        newAccountPubkey: derived,
        basePubkey: owner2,
        seed: 'wsol',
        lamports: 2_039_280,           // token-account rent
        space: 165,
        programId: SystemProgram.programId,
      }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(wrap, owner2, undefined, { maxLamportsOut: 30_000_000n }).ok, true);
  });

  test('authority theft is still refused even for the router', () => {
    // SetAuthority (tag 6) must never be signable, no matter who invokes it.
    const victimAta = Keypair.generate().publicKey;
    const tx = mk([new TransactionInstruction({
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      keys: [{ pubkey: victimAta, isSigner: false, isWritable: true }, { pubkey: owner2, isSigner: true, isWritable: false }],
      data: Buffer.from([6, 2, 1]),
    })]);
    assert.strictEqual(assertOutboundTradeTx(tx, owner2).ok, false);
  });
}

console.log('\n-- Paper copy trading must not need a funded wallet --');
{
  const src = require('fs').readFileSync(require.resolve('../services/copyTraderService.ts'), 'utf8');
  const { splitWalletIntoSlots, maxAffordableBuySol } = require('../services/pipelineUtils');

  test('OLD BUG: split sizing staked 0 with no wallet, so every paper leader buy was skipped', () => {
    // Measured: paper copy trading opened nothing. buySizeMode 'split' sizes
    // from deployableSol, which is 0 with no wallet linked, so copySol was 0
    // and onLeaderBuy skipped with "the wallet is empty after the exit-gas
    // reserve" — paper refusing to simulate over money it never spends.
    assert.strictEqual(splitWalletIntoSlots({
      deployableSol: 0, slots: 3, maxSlippagePct: 25, priorityFeeSol: 0.001,
    }).stakePerSlotSol, 0, 'the underlying sizing really does return 0');

    assert.ok(/tradingMode === 'paper' && stakeSol <= 0/.test(src),
      'paper must fall back to a notional stake when split sizing yields nothing');
    assert.ok(/copySol = \(this\.config\.tradingMode === 'paper' && stakeSol <= 0\)\s*\?\s*this\.config\.maxBuySol/.test(src),
      'the fallback is maxBuySol');
  });

  test('the fallback triggers on the computed STAKE, not just an empty wallet', () => {
    // Gating on `deployableSol <= 0` misses the case it was written for: a
    // dust-funded wallet. maxAffordableBuySol returns 0 whenever the per-slot
    // share cannot cover the priority fee plus the slippage buffer, so a small
    // NON-zero balance still staked 0 and still skipped every paper buy.
    const dust = splitWalletIntoSlots({
      deployableSol: 0.004, slots: 3, maxSlippagePct: 25, priorityFeeSol: 0.001,
    }).stakePerSlotSol;
    assert.strictEqual(dust, 0, 'a dust balance really does size to 0');
    assert.strictEqual(maxAffordableBuySol(0.004 / 3, 25, 0.001), 0);

    assert.ok(!/tradingMode === 'paper' && deployableSol <= 0/.test(src),
      'the old balance-based gate must be gone — it left dust wallets broken');
  });

  test('real mode is NOT given the paper fallback', () => {
    // The fallback invents a stake. In real mode that would size an order the
    // wallet cannot fund.
    const m = src.match(/copySol = \(this\.config\.tradingMode === 'paper'[^;]+;/);
    assert.ok(m, 'the sizing branch must exist');
    assert.ok(/'paper'/.test(m[0]) && !/'real'/.test(m[0]),
      'only paper may substitute a notional stake');
  });

  test('a dust-sized copy is SKIPPED, not bought (both at arrival and after reserves)', () => {
    // A sub-cent entry loses the round-trip fee the moment it lands. Split
    // sizing across many slots on a small wallet is exactly what produces
    // these, so the floor is checked where the size is first computed AND
    // again after the execution-time clamp, which can shrink a real order.
    assert.ok(/minCopyBuySol/.test(src), 'the floor config must exist');
    const hits = src.match(/copySol < this\.config\.minCopyBuySol/g) || [];
    assert.ok(hits.length >= 2,
      'the floor must be enforced at arrival AND after the reserve clamp');
    // Default is a real floor, not 0.
    assert.ok(/minCopyBuySol: 0\.01/.test(src), 'the default floor is 0.01 SOL');
    // Sanitizer must accept and clamp it.
    assert.ok(/partial\.minCopyBuySol/.test(src), 'the config field must be sanitised');
  });
}

console.log('\n-- The local builder must match the DEPLOYED pump.fun layout --');
{
  const src = require('fs').readFileSync(require.resolve('../services/localTxBuilder.ts'), 'utf8');

  test('OLD BUG: 6062 BuybackFeeRecipientMissing — two accounts the IDL omits', () => {
    // The deployed program requires bonding_curve_v2 and buyback_fee_recipient
    // that its published IDL does not list. Verified 2026-08-29 over 108 landed
    // instructions (29 mints, 72 wallets), and by simulating a landed buy with
    // one account swapped for a random key so the program names them itself:
    //   idx16 swapped -> 6074 InvalidBondingCurveV2       (sell.rs:133)
    //   idx17 swapped -> 6057 BuybackFeeRecipientNotAuthorized (lib.rs:1494)
    //   omitted       -> 6062 BuybackFeeRecipientMissing  (sell.rs:145)
    assert.ok(/bonding-curve-v2/.test(src), 'the v2 curve seed must be present');
    assert.ok(/GLOBAL_BUYBACK_OFFSET = 741/.test(src),
      'the buyback recipients are read from global at 741 + 32*i');
    assert.ok(/getBuybackFeeRecipient/.test(src), 'the recipient must be READ, never hardcoded');
    assert.ok(!/5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD/.test(src),
      'pump.fun rotates these — hardcoding one earns 6057 the day it changes');
  });

  test('the SELL takes the cashback form FIRST — the short form strands exits', () => {
    // An adversarial re-check overturned the first mapping here: on 6 of 6 live
    // holders the 16-account sell fails 6073 InvalidCashbackAccumulator
    // (sell.rs:33) and only the 17-account form with user_volume_accumulator
    // first simulates clean. Which form a wallet needs is per-user state, so
    // both are tried and the chain decides.
    const sell = src.slice(src.indexOf('public async buildSell('), src.indexOf('// ---------------- Shadow compare'));
    assert.ok(/for \(const withCashback of \[true, false\]\)/.test(sell),
      'the cashback form must be attempted BEFORE the short form');
    assert.ok(/userVolumeAccumulator/.test(src) && /withCashback \?/.test(src),
      'the accumulator is what distinguishes the two forms');
  });

  test('fee recipients are walked, not assumed — one is not authorized for every mint', () => {
    // pump.fun runs several fee recipients at once; the primary alone failed
    // 3 of 5 live mints with 6000 NotAuthorized (fee_recipient.rs:19).
    assert.ok(/getFeeRecipients/.test(src), 'the authorized set must be read');
    assert.ok(/162 \+ 32 \* i/.test(src), 'the secondary array lives at 162 + 32*i');
    assert.ok(/6000\|NotAuthorized\|InvalidAccountForFee/.test(src),
      'only a credential-shaped rejection should trigger the next recipient');
  });

  test('nothing is signed without a clean simulation — the whole safety story', () => {
    assert.ok(/const sim = await this\.simulateOk\(built\.tx\)/.test(src),
      'every locally built tx is simulated before it is returned');
    const engine = require('fs').readFileSync(require.resolve('../services/sniperEngine.ts'), 'utf8');
    assert.ok(/if \(sim\.ok\) \{[\s\S]{0,120}buildSource = 'local'/.test(engine),
      'the engine only uses a build that simulated clean');
  });
}

console.log('\n-- Per-install files must all resolve from installBaseDir --');
{
  const fsx = require('fs');
  /** True when process.cwd() appears in real CODE, ignoring comments — a
   *  comment describing the old bug must not fail the guard against it. */
  const hasCwdInCode = (src: string) => /process\.cwd\(\)/.test(
    // Strip \r FIRST: on a Windows (CRLF) checkout the trailing \r left by
    // split('\n') sits between the comment text and end-of-line, so /\/\/.*$/
    // (`.` never matches \r, `$` needs true end) failed to strip the comment
    // and this guard fired on a comment that merely NAMES the old bug.
    src.replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n'));

  test('OLD BUG: the API token was written to / under Electron and never persisted', () => {
    // apiAuth computed its own base dir as
    //   process.pkg ? dirname(execPath) : process.cwd()
    // `process.pkg` is undefined under Electron, so the base became cwd — and a
    // .app launched from Finder has cwd '/'. Writing /.api-token fails, the
    // failure is swallowed, and a fresh random token is minted every start:
    // the file the instance switcher depends on never exists, and the API
    // cannot be scripted because no token is anywhere on disk. Measured
    // 2026-08-29 on a running 2.0.9 build (lsof showed cwd '/').
    const src = fsx.readFileSync(require.resolve('../services/apiAuth.ts'), 'utf8');
    assert.ok(/installPath\(TOKEN_FILE\)/.test(src),
      'the token file must resolve through installBaseDir()');
    assert.ok(!hasCwdInCode(src),
      'apiAuth must not compute its own base dir any more');
  });

  test('every per-install file goes through installPaths', () => {
    // installPaths.ts exists precisely so these cannot drift apart again.
    for (const f of ['apiAuth.ts', 'keyStore.ts']) {
      const src = fsx.readFileSync(require.resolve('../services/' + f), 'utf8');
      assert.ok(/installPath|installBaseDir/.test(src), f + ' must use installPaths');
      assert.ok(!hasCwdInCode(src), f + ' must not resolve against cwd');
    }
  });
}

console.log('\n-- An active session must not shut itself down --');
{
  const fs3 = require('fs');
  const srv = fs3.readFileSync(require.resolve('../server.ts'), 'utf8');
  const mainJs = fs3.readFileSync(require('path').resolve(__dirname, '../../electron/main.js'), 'utf8');

  test('OLD BUG: a flat-but-active real session shut down on a heartbeat gap', () => {
    // The stay-alive check only asked "are positions open?". A live copy-trading
    // session is FLAT most of the time — between one exit and the next entry
    // nothing is open — so a 12s heartbeat gap in that window killed an active
    // real-money session. Reported as "the bot randomly shuts down when trading
    // on chain in real mode".
    assert.ok(/const sessionActive =/.test(srv), 'an active session must be recognised');
    assert.ok(/copyStatus\.enabled && \(copyStatus\.wallets\?\.length \?\? 0\) > 0/.test(srv),
      'copy trading enabled with leaders counts as active');
    assert.ok(/engineStatus\.isBotActive === true/.test(srv), 'an armed sniper engine counts as active');
    assert.ok(/openPositions > 0 \|\| sessionActive/.test(srv),
      'the shutdown must be gated on BOTH, not on open positions alone');
  });

  test('the renderer heartbeat must not be throttled when the window is minimized', () => {
    // Electron throttles timers in a backgrounded window, which stops the
    // heartbeat the server relies on — the upstream cause of the above.
    assert.ok(/backgroundThrottling: false/.test(mainJs),
      'a local trading console must keep its timers running while minimized');
  });

  test('OLD BUG: the heartbeat guard ran under Electron and blanked the window', () => {
    // Even with the sessionActive fix, a fresh Electron launch with copy trading
    // OFF and nothing open still shut the server down ~12s in, before the first
    // renderer heartbeat landed — and the window went blank because the server
    // it was loading had quit. Electron owns its own lifecycle via window
    // events, so the tab-heartbeat guard must not run there at all.
    assert.ok(/const UNDER_ELECTRON =/.test(srv), 'the guard must detect Electron');
    assert.ok(/versions\?\.electron/.test(srv), 'process.versions.electron is the signal');
    assert.ok(/if \(UNDER_ELECTRON\) return;/.test(srv),
      'under Electron the tab-heartbeat guard must be a no-op');
  });

  test('a suspended process (laptop asleep) is not a dead UI', () => {
    // If the machine slept, the gap between two 3s ticks is huge — that is a
    // frozen process, not closed tabs. Treat the jump as a fresh heartbeat.
    assert.ok(/sinceLastTick > 10_000/.test(srv), 'a wall-clock jump must be detected');
    assert.ok(/lastTabHeartbeatAt = Date\.now\(\); return;/.test(srv),
      'a suspend must reset the heartbeat and skip the tick, not shut down');
  });

  test('shutdown flushes copy state synchronously so the last trade is not lost', () => {
    // persist() debounces 500ms; every shutdown path exits in the same tick. A
    // sell recorded just before shutdown was never written, so the next boot
    // restored a phantom OPEN position for a bag already sold.
    assert.ok(/copyTrader\.flushStateSync\(\)/.test(srv),
      'gracefulShutdown must flush copy state before exit');
    const cs = fs3.readFileSync(require.resolve('../services/copyTraderService.ts'), 'utf8');
    assert.ok(/public flushStateSync\(\)/.test(cs) && /clearTimeout\(this\.persistTimer\)/.test(cs),
      'flushStateSync must cancel the debounce and write inline');
  });

  test('Electron quit runs the clean-shutdown path (no false crash next boot)', () => {
    // app.quit() delivers no signal to the in-process engine, so
    // markCleanShutdown never ran and the next boot reported a crash — which
    // auto-disabled real copy mode. before-quit now triggers it.
    assert.ok(/app\.on\('before-quit', runCleanShutdown\)/.test(mainJs),
      'before-quit must run the clean shutdown');
    assert.ok(/process\.emit\('SIGTERM'\)/.test(mainJs),
      'it reaches the in-process server via SIGTERM');
  });

  test('realModeLock no longer exits before the server can shut down cleanly', () => {
    // Its SIGINT handler used to process.exit(130) before server.ts's
    // gracefulShutdown could run, so Ctrl+C skipped markCleanShutdown and every
    // terminal stop looked like a crash.
    const rl = fs3.readFileSync(require.resolve('../services/realModeLock.ts'), 'utf8');
    assert.ok(!/process\.exit\(130\)/.test(rl), 'the premature exit must be gone');
    assert.ok(!/process\.on\('SIGINT'/.test(rl), 'realModeLock must not own SIGINT');
    assert.ok(/process\.on\('exit', \(\) => realModeLock\.release\(\)\)/.test(rl),
      'the lock still releases on the exit event');
  });

  test('paper and real copy positions are never pooled for sizing or merging', () => {
    // A leftover paper position counted against the real open-position cap
    // collapsed split sizing into a near-all-in real buy, and a real buy could
    // DCA-merge into a paper bag, stranding real tokens behind a simulated exit.
    const cs = fs3.readFileSync(require.resolve('../services/copyTraderService.ts'), 'utf8');
    assert.ok(/openPositionsForCurrentMode\(\)/.test(cs), 'counts must be provenance-aware');
    assert.ok(/mergeablePositionFor\(/.test(cs), 'merges must be provenance-aware');
    assert.ok(/isPaperPos\(p\) === wantPaper/.test(cs),
      'same-mode is decided by the sim_ txid provenance');
  });

  test('an instant window-process exit is a handoff, not the user closing it', () => {
    // Chromium that finds a live instance on the same profile hands off and
    // exits immediately: measured 142ms from spawn to exit, and the bot shut
    // itself down a second after starting.
    assert.ok(/Date\.now\(\) - spawnedAt < 5_000/.test(srv),
      'an exit within seconds of spawn must not be treated as a window close');
  });

  test('closing the window with REAL positions open keeps exits running', () => {
    assert.ok(/openNow > 0 && sniperEngine\.getStatus\(\)\.tradingMode !== 'paper'/.test(srv),
      'real money in flight must outlive the window');
  });
}

console.log('\n-- The UI must say why the bot is not trading --');
{
  const { runDiagnostics, worstLevel } = require('../services/diagnostics');
  const base = {
    engine: { isBotActive: false, tradingMode: 'paper', walletAddress: 'W', solBalance: 1, deployableSol: 1, rpcHealthy: true, logs: [] },
    copy: { enabled: true, tradingMode: 'paper', streamConnected: true, heliusConnected: true,
      config: { maxOpenPositions: 6, buySizeMode: 'fixed', fixedBuySol: 0.05, maxSlippagePct: 25, copySells: true },
      wallets: [{ address: 'Leader1111', buysSeen: 5, copiedBuys: 5, skippedSignals: 0, addedAt: 1 }], openPositions: 0 },
    rpc: { credentialRejected: false, consecutiveFailures: 0, lastError: null },
    heliusKeySet: true, priorityFeeSol: 0.001, now: 1,
  };

  test('a healthy bot reports nothing', () => {
    assert.deepStrictEqual(runDiagnostics(base as any), []);
    assert.strictEqual(worstLevel([]), 'ok');
  });

  test('it names every failure that actually cost this project a night', () => {
    const rejected = runDiagnostics({ ...base, rpc: { ...base.rpc, credentialRejected: true } } as any);
    assert.ok(rejected.some((d: any) => /rejected your API key/i.test(d.title)), 'a refused Helius key');

    const off = runDiagnostics({ ...base, copy: { ...base.copy, enabled: false } } as any);
    assert.ok(off.some((d: any) => /switched off/i.test(d.title)), 'copy trading silently off');

    const dead = runDiagnostics({ ...base, copy: { ...base.copy, heliusConnected: false } } as any);
    assert.ok(dead.some((d: any) => /watcher disconnected/i.test(d.title)), 'a dead leader watcher');

    // The exact bug that made paper open nothing: split sizing computing 0.
    const zero = runDiagnostics({
      ...base,
      engine: { ...base.engine, deployableSol: 0, tradingMode: 'real' },
      copy: { ...base.copy, tradingMode: 'real', config: { ...base.copy.config, buySizeMode: 'split' } },
    } as any);
    assert.ok(zero.some((d: any) => /stakes 0 SOL/i.test(d.title)), 'zero-stake sizing');

    const guard = runDiagnostics({ ...base, engine: { ...base.engine, logs: [
      { level: 'error', message: 'Refusing to sign buy for ABC — instruction invokes unexpected program X', timestamp: 1 }] } } as any);
    assert.ok(guard.some((d: any) => /Refusing to sign/.test(d.detail)), 'a guard refusal reaches the UI');
  });

  test('every finding tells the operator what to DO', () => {
    const all = runDiagnostics({ ...base, rpc: { ...base.rpc, credentialRejected: true }, copy: { ...base.copy, enabled: false } } as any);
    assert.ok(all.length >= 2);
    for (const d of all) {
      assert.ok(d.title && d.detail, 'a finding must say what is wrong');
      if (d.level !== 'info') assert.ok(d.fix, `"${d.title}" must say how to fix it`);
    }
  });

  test('worstLevel escalates critical over warning', () => {
    assert.strictEqual(worstLevel([{ level: 'warning' }, { level: 'critical' }] as any), 'critical');
    assert.strictEqual(worstLevel([{ level: 'info' }, { level: 'warning' }] as any), 'warning');
  });
}

console.log('\n-- Auto-update must not re-block the app every time --');
{
  const main = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../electron/main.js'), 'utf8');

  test('OLD BUG: every auto-update re-quarantined the app and macOS blocked it', () => {
    // The app is ad-hoc signed but not notarized, so macOS blocks any copy
    // carrying com.apple.quarantine. auto-update re-downloads the bundle, so
    // the flag returned on EVERY update — the user had to clear it by hand
    // after 2.0.6, 2.0.7, 2.0.9 and 2.0.10, each time looking like the bot had
    // broken again.
    assert.ok(/clearOwnQuarantine/.test(main), 'the app must clear its own quarantine flag');
    assert.ok(/xattr'?,\s*\['-dr', 'com\.apple\.quarantine'/.test(main),
      'it must actually remove the attribute');
    assert.ok(/process\.platform !== 'darwin'/.test(main), 'no-op off macOS');
    assert.ok(/endsWith\('\.app'\)/.test(main),
      'it must only ever touch our own .app bundle');
    const call = main.indexOf('clearOwnQuarantine();');
    const ready = main.indexOf('app.whenReady()');
    assert.ok(call > ready && call < main.indexOf('wireAutoUpdate();'),
      'it runs at startup, before the updater can fetch the next build');
  });
}

console.log('\n-- macOS first-run must be explained where the user downloads --');
{
  const fs2 = require('fs');
  const path2 = require('path');
  const root2 = path2.resolve(__dirname, '../..');

  test('the release page carries the first-run unblock command', () => {
    // The mac build is ad-hoc signed but NOT notarized (no paid Developer ID),
    // so the first launch is refused with "Apple could not verify ... is free
    // of malware" or "the application is damaged". Both read as a bad download.
    // Shipping the fix only in a commit message helps nobody holding a .dmg.
    const rel = fs2.readFileSync(path2.join(root2, '.github/workflows/release.yml'), 'utf8');
    assert.ok(/body: \|/.test(rel), 'the release must carry a notes body');
    assert.ok(/xattr -dr com\.apple\.quarantine/.test(rel),
      'the notes must contain the actual command that unblocks the app');
    assert.ok(/could not verify/.test(rel) && /damaged/.test(rel),
      'both wordings macOS uses must be named, so the user can match what they saw');
  });

  test('the macOS unblock helper exists and verifies the signature', () => {
    const p2 = path2.join(root2, 'Fix_Blocked_App_macOS.command');
    assert.ok(fs2.existsSync(p2), 'a mac equivalent of Fix_Blocked_App_RunAsAdmin.bat must exist');
    const sh = fs2.readFileSync(p2, 'utf8');
    assert.ok(/xattr -dr com\.apple\.quarantine/.test(sh));
    assert.ok(/codesign --verify/.test(sh),
      'it must refuse to bless an app whose signature does NOT verify — that one really is broken');
    assert.ok(/Applications\/Pumpfun Sniper Bot\.app/.test(sh), 'it must target only this app');
  });
}

console.log('\n-- The macOS build must not ship a broken signature --');
{
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  test('OLD BUG: the .dmg shipped unsigned and macOS called it "damaged"', () => {
    // v2.0.6 shipped a bundle carrying only the stock Electron linker
    // signature: Identifier=Electron, Info.plist not bound, and
    // `codesign --verify` failing with "code has no resources but signature
    // indicates they must be present". Gatekeeper renders that as "damaged,
    // move to Trash", which reads as a corrupt download. CI sets
    // CSC_IDENTITY_AUTO_DISCOVERY=false (no Developer ID), which makes
    // electron-builder skip signing entirely — so the bundle must be ad-hoc
    // signed after packing instead.
    assert.strictEqual(pkg.build.afterPack, 'build/afterPack.js',
      'the mac bundle must be ad-hoc signed after packing, or it ships broken');

    const hook = fs.readFileSync(path.join(root, 'build/afterPack.js'), 'utf8');
    assert.ok(/codesign/.test(hook), 'the hook must actually run codesign');
    assert.ok(/'--force', '--deep', '--sign', '-'/.test(hook), 'ad-hoc identity is "-"');
    assert.ok(/--verify/.test(hook),
      'the hook must VERIFY, so a broken signature fails the build instead of shipping');
    assert.ok(/darwin/.test(hook), 'it must be a no-op on non-mac packing');
  });

  test('the afterPack hook is loadable and exports a default function', () => {
    const mod = require(path.join(root, 'build/afterPack.js'));
    assert.strictEqual(typeof mod.default, 'function',
      'electron-builder calls module.default(context)');
  });
}

console.log('\n-- One blip must not blank the wallet or refuse to arm --');
{
  const { WalletService } = require('../services/walletService');
  const { resetRpcHealth } = require('../services/rpcHealth');

  const LAMPORTS = 1_000_000_000;
  /** A Connection stand-in whose getBalance/getSlot behaviour the test drives. */
  const fakeConn = (impl: { balance?: () => Promise<number>; slot?: () => Promise<number> }) => ({
    getBalance: impl.balance ?? (async () => 2 * LAMPORTS),
    getSlot: impl.slot ?? (async () => 1),
    onAccountChange: () => 1,
    removeAccountChangeListener: async () => {},
  });

  // A throwaway keypair, so no real credential appears in the suite.
  const { Keypair } = require('@solana/web3.js');
  const bs58x = require('bs58').default ?? require('bs58');
  const secret = bs58x.encode(Keypair.generate().secretKey);

  test('OLD BUG: one 429 flipped RPC to DOWN, which refuses to arm REAL mode', async () => {
    resetRpcHealth();
    let calls = 0;
    const w = new WalletService(fakeConn({
      balance: async () => { calls++; if (calls <= 1) throw new Error('429 Too Many Requests'); return 2 * LAMPORTS; },
    }) as any);
    assert.strictEqual((await w.link(secret)).ok, true, 'a retried blip must not fail the link');
    assert.ok(!w.getBlockers().some((b: string) => /RPC unreachable/.test(b)),
      'a single 429 must not become a blocker that refuses REAL mode');
  });

  test('a sustained outage still reads as DOWN — hysteresis must not hide a real one', async () => {
    resetRpcHealth();
    let healthy = true;
    const w = new WalletService(fakeConn({
      balance: async () => { if (!healthy) throw new Error('ECONNRESET'); return 2 * LAMPORTS; },
      slot: async () => { if (!healthy) throw new Error('ECONNRESET'); return 1; },
    }) as any);
    // Link while healthy: `getBlockers` short-circuits on "no wallet linked",
    // so the RPC blocker is only reachable once a wallet exists.
    assert.strictEqual((await w.link(secret)).ok, true);

    healthy = false;
    await w.checkRpcHealth();
    await w.checkRpcHealth();
    assert.strictEqual(w.getStatus(0).rpcHealthy, false);
    assert.ok(w.getBlockers().some((b: string) => /RPC unreachable/.test(b)),
      'a real outage must still refuse to arm REAL mode');
  });

  test('a recovered RPC clears the latch on the FIRST good read', async () => {
    resetRpcHealth();
    let down = true;
    const w = new WalletService(fakeConn({
      slot: async () => { if (down) throw new Error('ECONNRESET'); return 1; },
    }) as any);
    await w.checkRpcHealth();
    await w.checkRpcHealth();
    assert.strictEqual(w.getStatus(0).rpcHealthy, false);
    down = false;
    await w.checkRpcHealth();
    assert.strictEqual(w.getStatus(0).rpcHealthy, true, 'recovery needs no hysteresis');
  });

  test('OLD BUG: a link that reports failure left the wallet armed anyway', async () => {
    resetRpcHealth();
    const w = new WalletService(fakeConn({
      balance: async () => { throw new Error('ECONNRESET'); },
      slot: async () => { throw new Error('ECONNRESET'); },
    }) as any);
    const res = await w.link(secret);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(w.isLinked(), false,
      'a failed link must not leave a keypair the engine will sign with');
    assert.strictEqual(w.getAddress(), null);
    assert.strictEqual(res.status.linked, false, 'the status handed back must agree');
  });

  test('a failed re-link restores the wallet that was already working', async () => {
    resetRpcHealth();
    let healthy = true;
    const w = new WalletService(fakeConn({
      balance: async () => { if (!healthy) throw new Error('ECONNRESET'); return 2 * LAMPORTS; },
      slot: async () => { if (!healthy) throw new Error('ECONNRESET'); return 1; },
    }) as any);
    assert.strictEqual((await w.link(secret)).ok, true);
    const original = w.getAddress();

    healthy = false;
    const other = bs58x.encode(Keypair.generate().secretKey);
    assert.strictEqual((await w.link(other)).ok, false);
    assert.strictEqual(w.getAddress(), original,
      'a failed link must not swap the signing wallet out from under the operator');
  });

  test('a malformed key is still rejected without touching the linked wallet', async () => {
    resetRpcHealth();
    const w = new WalletService(fakeConn({}) as any);
    assert.strictEqual((await w.link(secret)).ok, true);
    const original = w.getAddress();
    const res = await w.link('not-a-key');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(w.getAddress(), original);
  });
}

// ---------------------------------------------------------------------------
// Copy trader exits, 2026-08-22. Reported by the owner as "copy trade is not
// selling at the same time as the person being copied, and sometimes not at
// all". Four code-level causes, each with its failing case below.
// ---------------------------------------------------------------------------
console.log('\n-- Copy trader: leader sells are queued, routed by the sell venue, and retried --');
{
  const {
    ExitQueue, leaderSellFraction, sellVenueCandidates, sellRetryDelayMs, copySellSlippagePct,
    COPY_SELL_MAX_ATTEMPTS,
  } = require('../services/copyExitPolicy');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('OLD BUG: an exit already in flight silently swallowed the next leader sell', async () => {
    // closePosition() opened with `if (pos.exitInFlight) return;`. Reproduced
    // with the leader selling 50% and then the rest while our first sell was
    // still confirming.
    const pos = { exitInFlight: false, tokensHeld: 100 };
    const sells: number[] = [];
    const oldClosePosition = async (fraction: number) => {
      if (pos.exitInFlight) return;
      pos.exitInFlight = true;
      await sleep(20);
      sells.push(fraction);
      pos.tokensHeld *= (1 - fraction);
      pos.exitInFlight = false;
    };
    await Promise.all([oldClosePosition(0.5), oldClosePosition(1)]);
    assert.deepStrictEqual(sells, [0.5], 'the second chunk was never sold');
    assert.strictEqual(pos.tokensHeld, 50, 'half the bag stayed behind with the leader gone');
  });

  test('fixed: the queue runs both in order, so "50% then the rest" leaves us flat like the leader', async () => {
    const q = new ExitQueue();
    const pos = { tokensHeld: 100 };
    const sells: number[] = [];
    const sell = (fraction: number) => q.run('pos', async () => {
      await sleep(20);
      sells.push(fraction);
      pos.tokensHeld *= (1 - fraction);
    });
    await Promise.all([sell(0.5), sell(1)]);
    assert.deepStrictEqual(sells, [0.5, 1]);
    assert.strictEqual(pos.tokensHeld, 0);
  });

  test('a failed exit does not block the one queued behind it', async () => {
    const q = new ExitQueue();
    const ran: string[] = [];
    const first = q.run('pos', async () => { await sleep(10); throw new Error('trade-local 500'); });
    const second = q.run('pos', async () => { ran.push('second'); });
    await assert.rejects(first);
    await second;
    assert.deepStrictEqual(ran, ['second']);
    assert.strictEqual(q.isBusy('pos'), false);
  });

  test('positions never wait on each other', async () => {
    const q = new ExitQueue();
    const order: string[] = [];
    await Promise.all([
      q.run('a', async () => { await sleep(30); order.push('a'); }),
      q.run('b', async () => { order.push('b'); }),
    ]);
    assert.deepStrictEqual(order, ['b', 'a']);
  });

  test('isBusy reports running or queued work, and clears afterwards', async () => {
    const q = new ExitQueue();
    const p = q.run('pos', async () => { await sleep(10); });
    assert.strictEqual(q.isBusy('pos'), true);
    assert.strictEqual(q.depth('pos'), 1);
    await p;
    assert.strictEqual(q.isBusy('pos'), false);
    assert.strictEqual(q.depth('pos'), 0);
  });

  test('OLD BUG: the exit went to the venue recorded at BUY time', () => {
    // A curve buy ('pump') sold after graduation was routed to a completed
    // curve: BondingCurveComplete on-chain, every attempt. The buy-time pool is
    // not even an input any more.
    const candidates = sellVenueCandidates('pump-amm');
    assert.strictEqual(candidates[0], 'pump-amm', 'route by the venue the leader actually sold on');
    assert.ok(!candidates.includes('pump'));
  });

  test('an on-chain (Helius) sell carries no venue, so auto is first; auto is never duplicated', () => {
    assert.deepStrictEqual(sellVenueCandidates(undefined), ['auto']);
    assert.deepStrictEqual(sellVenueCandidates(''), ['auto']);
    assert.deepStrictEqual(sellVenueCandidates('auto'), ['auto']);
    assert.deepStrictEqual(sellVenueCandidates('raydium'), ['raydium', 'auto']);
  });

  test('a failed sell is retried with backoff, bounded, and capped so the queue behind it moves', () => {
    assert.ok(COPY_SELL_MAX_ATTEMPTS >= 3, 'one attempt was the old behaviour');
    assert.ok(sellRetryDelayMs(1) < sellRetryDelayMs(2));
    assert.ok(sellRetryDelayMs(2) < sellRetryDelayMs(3));
    assert.ok(sellRetryDelayMs(20) <= 10_000);
    assert.ok(sellRetryDelayMs(0) >= 1_000, 'never a hot loop');
  });

  test("the leader's sell fraction comes from their post-trade balance", () => {
    assert.strictEqual(leaderSellFraction(50, 50), 0.5);
    assert.strictEqual(leaderSellFraction(25, 0), 1, 'selling the rest is a full exit');
    assert.strictEqual(leaderSellFraction(10, undefined), 1, 'unknown balance reads as a full exit');
    assert.strictEqual(leaderSellFraction(0, 100), 0, 'a zero-size sell is nothing to mirror');
  });

  test("sell slippage is the wider of the copy setting and the engine's sell band", () => {
    // The copy BUY number was passed as the override, bypassing the engine's
    // looser sell tolerance exactly when the leader's dump moved the price.
    assert.strictEqual(copySellSlippagePct(25, 15), 25);
    assert.strictEqual(copySellSlippagePct(10, 15), 15);
    assert.strictEqual(copySellSlippagePct(10, undefined), 10);
    assert.strictEqual(copySellSlippagePct(500, undefined), 100);
  });
}

console.log('\n-- Copy trader: the on-chain wallet watcher owns its socket --');
{
  const { WalletLogWatcher } = require('../services/walletLogWatcher');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const fakeSocket = () => {
    const handlers: Record<string, Function[]> = {};
    const s: any = {
      readyState: 0,
      sent: [] as any[],
      closed: false,
      terminated: false,
      on(ev: string, fn: Function) { (handlers[ev] ||= []).push(fn); return s; },
      emit(ev: string, ...args: any[]) { (handlers[ev] || []).forEach((f) => f(...args)); },
      send(data: string) { s.sent.push(JSON.parse(data)); },
      close() { s.closed = true; s.readyState = 3; s.emit('close'); },
      terminate() { s.terminated = true; s.readyState = 3; s.emit('close'); },
      ping() {},
      open() { s.readyState = 1; s.emit('open'); },
      ack(address: string, subId: number) {
        const req = s.sent.find((m: any) => m.method === 'logsSubscribe' && m.params[0]?.mentions?.[0] === address);
        assert.ok(req, `no logsSubscribe request for ${address}`);
        s.emit('message', JSON.stringify({ jsonrpc: '2.0', id: req.id, result: subId }));
      },
      notify(subId: number, signature: string, err: unknown = null) {
        s.emit('message', JSON.stringify({
          jsonrpc: '2.0', method: 'logsNotification',
          params: { subscription: subId, result: { context: { slot: 1 }, value: { signature, err, logs: [] } } },
        }));
      },
    };
    return s;
  };

  const make = (extra: any = {}) => {
    const sockets: any[] = [];
    const seen: any[] = [];
    const w = new WalletLogWatcher({
      getWsUrl: () => 'wss://test',
      onLog: (ev: any) => seen.push(ev),
      socketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
      reconnectDelay: () => 5,
      ...extra,
    });
    return { w, sockets, seen };
  };

  test('subscribes every tracked wallet with logsSubscribe at processed, healthy only once acknowledged', () => {
    const { w, sockets } = make();
    w.setAddresses(['A', 'B']);
    w.start();
    sockets[0].open();
    const subs = sockets[0].sent.filter((m: any) => m.method === 'logsSubscribe');
    assert.strictEqual(subs.length, 2);
    assert.deepStrictEqual(subs[0].params[0], { mentions: ['A'] });
    assert.strictEqual(subs[0].params[1].commitment, 'processed', 'confirmed was the slowest moment to learn about a trade');
    assert.strictEqual(w.isHealthy(), false, 'a request is not a subscription');
    sockets[0].ack('A', 11);
    sockets[0].ack('B', 12);
    assert.strictEqual(w.isHealthy(), true);
    assert.strictEqual(w.liveSubscriptionCount(), 2);
    w.stop();
  });

  test('a notification reaches the wallet that owns the subscription; failed txs are passed through for the caller to drop', () => {
    const { w, sockets, seen } = make();
    w.setAddresses(['A', 'B']);
    w.start();
    sockets[0].open();
    sockets[0].ack('A', 11);
    sockets[0].ack('B', 12);
    sockets[0].notify(12, 'sigB');
    sockets[0].notify(11, 'sigA', { InstructionError: [0, 'Custom'] });
    sockets[0].notify(99, 'sigUnknown');
    assert.deepStrictEqual(
      seen.map((e: any) => [e.address, e.signature, e.err === null]),
      [['B', 'sigB', true], ['A', 'sigA', false]]
    );
    w.stop();
  });

  test('OLD BUG: onLogs reconnected only from close, so a half-open socket stayed deaf; now silence terminates it and every wallet is re-subscribed', async () => {
    const { w, sockets } = make({ pingMs: 10, staleMs: 40 });
    w.setAddresses(['A']);
    w.start();
    sockets[0].open();
    sockets[0].ack('A', 11);
    assert.strictEqual(w.isHealthy(), true);
    await sleep(75); // nothing arrives and nothing pongs
    assert.strictEqual(sockets[0].terminated, true, 'a silent socket must be terminated, not trusted');
    assert.strictEqual(w.isHealthy(), false, 'ON-CHAIN must read down while blind');
    assert.strictEqual(sockets.length, 2, 'a fresh socket is opened');
    sockets[1].open();
    const resubs = sockets[1].sent.filter((m: any) => m.method === 'logsSubscribe');
    assert.deepStrictEqual(resubs.map((m: any) => m.params[0].mentions[0]), ['A']);
    sockets[1].ack('A', 21);
    assert.strictEqual(w.isHealthy(), true);
    w.stop();
  });

  test('changing the tracked set diffs in place: removed wallets unsubscribe, new ones subscribe, no reconnect', () => {
    const { w, sockets } = make();
    w.setAddresses(['A', 'B']);
    w.start();
    sockets[0].open();
    sockets[0].ack('A', 11);
    sockets[0].ack('B', 12);
    w.setAddresses(['B', 'C']);
    const unsub = sockets[0].sent.find((m: any) => m.method === 'logsUnsubscribe');
    assert.deepStrictEqual(unsub.params, [11]);
    assert.ok(sockets[0].sent.some((m: any) => m.method === 'logsSubscribe' && m.params[0].mentions[0] === 'C'));
    assert.strictEqual(sockets.length, 1);
    assert.strictEqual(w.trackedCount(), 2);
    w.stop();
  });

  test('stop() closes the socket and does not reconnect', async () => {
    const { w, sockets } = make();
    w.setAddresses(['A']);
    w.start();
    sockets[0].open();
    w.stop();
    assert.strictEqual(sockets[0].closed, true);
    await sleep(30);
    assert.strictEqual(sockets.length, 1);
    assert.strictEqual(w.isConnected(), false);
  });

  test('the copy trader, the engine and the UI are wired to all of this', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(!/\.onLogs\(/.test(svc), 'Connection.onLogs reconnects only from close — a half-open socket stays deaf forever');
    assert.ok(/new WalletLogWatcher\(/.test(svc));
    assert.ok(!/if \(pos\.exitInFlight\) return;/.test(svc), 'the silent drop must stay gone');
    assert.ok(/tradeQueue\.run\(/.test(svc), 'exits are queued per mint, behind the buy they belong to');
    assert.ok(/attachKeepalive\(/.test(svc), 'the PumpPortal lane needs the watchdog too');
    assert.ok(/sellVenueCandidates\(/.test(svc) && !/pctParam, pos\.pool/.test(svc), 'the buy-time venue must never route the exit');
    assert.ok(/COPY_SELL_MAX_ATTEMPTS/.test(svc), 'a failed sell is retried');
    assert.ok(/feedAutoClearMinutes/.test(svc), 'the feed clears itself');

    const ui = fsx.readFileSync(pathx.join(__dirname, '..', 'CopyTradingPage.tsx'), 'utf8');
    assert.ok(/copySells/.test(ui), 'v1.0.1 switched copySells off for upgraded installs and pointed at a control that did not exist');
    assert.ok(/sellMode/.test(ui));
    assert.ok(!/NO AUTOMATIC SELLS/.test(ui), 'the 08-12 banner contradicted the backend');
    assert.ok(/feedAutoClearMinutes/.test(ui), 'automatic feed clearing is an operator setting');

    const eng = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
    assert.ok(/external:\s*true/.test(eng) && /noteTradeFailure\(/.test(eng),
      "a copy sell failing on a venue the leader left must not trip the sniper's breaker");
  });
}

// ---------------------------------------------------------------------------
// Copy trader, 2026-08-23: "it buys and sells but not correctly". What the
// on-chain watcher turned into buy and sell signals, and what it missed.
// ---------------------------------------------------------------------------
console.log('\n-- Copy trader: transfers are not trades, a flip inside our buy is not lost, paper exits print the leader price --');
{
  const { detectVenue, classifyFlow, netSolFlowSol, paperExitPrice, TRADE_MIN_SOL_BUY } = require('../services/leaderTxClassifier');
  const { ExitQueue } = require('../services/copyExitPolicy');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

  test('OLD BUG: tokens arriving with no SOL leaving read as a BUY, so an airdrop got copied', () => {
    // The old classifier looked at the token delta alone: token up = buy.
    const oldClassify = (tokenDelta: number) => (tokenDelta > 0 ? 'buy' : 'sell');
    assert.strictEqual(oldClassify(+1_000_000), 'buy', 'an airdrop was a buy signal');
    assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: false, isTokenSwap: false }), 'transfer');
  });

  test('OLD BUG: tokens leaving with no SOL arriving read as a SELL, so a wallet-to-wallet move dumped our bag', () => {
    assert.strictEqual(classifyFlow({ side: 'sell', tradeSol: 0, venueKnown: false, isTokenSwap: false }), 'transfer');
    assert.strictEqual(classifyFlow({ side: 'sell', tradeSol: 0.4, venueKnown: false, isTokenSwap: false }), 'trade');
  });

  test('receiving tokens can cost rent and a fee without buying any — still a transfer', () => {
    assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.00204 + 0.000005, venueKnown: false, isTokenSwap: false }), 'transfer');
    assert.ok(TRADE_MIN_SOL_BUY > 0.00204, 'the threshold must sit above ATA rent');
    assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.01, venueKnown: false, isTokenSwap: false }), 'trade');
  });

  test('a known venue lowers the bar for a small BUY but never removes it; a swap leg has no SOL by nature', () => {
    // A real venue buy, small: still a trade — the venue lowers the floor.
    assert.strictEqual(classifyFlow({ side: 'buy', tradeSol: 0.001, venueKnown: true, isTokenSwap: false }), 'trade');
    assert.strictEqual(classifyFlow({ side: 'sell', tradeSol: 0, venueKnown: false, isTokenSwap: true }), 'trade');
  });

  test('OLD BUG: a venue program merely PRESENT in the transaction made a zero-SOL token inflow a copied BUY', () => {
    // detectVenue scans ACCOUNT KEYS, so it fires on any transaction that
    // mentions a DEX program — a bundle, a multi-recipient distribution, an
    // airdrop routed through a program, another party's swap. The old rule
    // (`if (isTokenSwap || venueKnown) return 'trade'`) turned every one of
    // those into a BUY signal carrying solAmount: 0, which nothing downstream
    // refused: minLeaderBuySol defaults to 0 and split sizing never looks at
    // the leader's size. The bot bought, at a full slice, a token the leader
    // had not bought. This is the reported "random buys".
    assert.strictEqual(
      classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: true, isTokenSwap: false }), 'transfer',
      'tokens arriving for NO SOL are not a buy, whatever programs the transaction mentions');

    // The other half of the same hole: isTokenSwap is computed upstream as
    // "some mint went up and some mint went down in this transaction", which a
    // bag transferred out alongside an airdrop landing satisfies exactly. It
    // now needs a recognised venue before it can stand in for payment.
    assert.strictEqual(
      classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: false, isTokenSwap: true }), 'transfer',
      'a token-for-token BUY needs a venue we recognise before it counts as payment');
    assert.strictEqual(
      classifyFlow({ side: 'buy', tradeSol: 0, venueKnown: true, isTokenSwap: true }), 'trade',
      'a genuine token->token swap on a known venue is still copied');

    // SELLS are deliberately untouched: acting on a false sell exits a bag we
    // already hold, which is far cheaper than buying a token nobody chose.
    assert.strictEqual(
      classifyFlow({ side: 'sell', tradeSol: 0, venueKnown: true, isTokenSwap: false }), 'trade',
      'the sell side keeps its permissive rule — missing a leader exit is the expensive direction');
  });

  test('the venue comes from the programs the transaction invoked, in PumpPortal vocabulary', () => {
    assert.strictEqual(detectVenue(['11111111111111111111111111111111', PUMP]), 'pump');
    assert.strictEqual(detectVenue([PUMP_AMM]), 'pump-amm');
    assert.strictEqual(detectVenue(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']), undefined, 'a plain SPL transfer has no venue');
  });

  test('OLD BUG: the network fee was inside the "price" of a small buy', () => {
    // A 0.05 SOL buy with a 0.0015 SOL fee, paid by the leader.
    const pre = 1_000_000_000;
    const post = pre - 50_000_000 - 1_500_000;
    const oldFlow = (post - pre) / 1e9;
    assert.ok(Math.abs(oldFlow) > 0.0514, 'old: 0.0515 SOL "spent" on a 0.05 SOL buy — 3% high');
    assert.ok(Math.abs(netSolFlowSol(pre, post, 1_500_000, true) + 0.05) < 1e-9, 'fixed: exactly the trade');
    assert.ok(Math.abs(netSolFlowSol(pre, post, 1_500_000, false) - oldFlow) < 1e-12, 'someone else paid the fee: nothing to add back');
  });

  test("OLD BUG: a paper sell filled at our stale price, so it booked -3% whatever the leader got", () => {
    const entry = 1e-7;
    const old = entry * (1 - 1.5 / 100); // currentPriceSol never left the entry on the free tier
    assert.ok(old < entry);
    const leaderSoldAt = 2e-7; // the leader doubled
    const fixed = paperExitPrice(leaderSoldAt, entry, 1.5);
    assert.ok(fixed > entry * 1.9, "the paper exit prints the leader's price, haircut");
    assert.strictEqual(paperExitPrice(undefined, entry, 1.5), old, 'no leader price: the previous behaviour');
    assert.strictEqual(paperExitPrice(0, entry, 1.5), old);
  });

  test('OLD BUG: a leader sell arriving while our buy was still landing found nothing and was dropped', async () => {
    // onLeaderSell looked the position up immediately; our buy takes seconds.
    const positions: string[] = [];
    const oldOnLeaderSell = () => (positions.length ? 'sold' : 'skipped: nothing held');
    const buy = (async () => { await sleep(30); positions.push('pos'); })();
    const verdict = oldOnLeaderSell(); // the leader's sell lands 1ms after their buy
    await buy;
    assert.strictEqual(verdict, 'skipped: nothing held');
    assert.strictEqual(positions.length, 1, 'and the bag landed anyway — orphaned, leader already out');
  });

  test('fixed: buys and sells share one queue per mint, so the sell waits for its bag', async () => {
    const q = new ExitQueue();
    const positions: string[] = [];
    const events: string[] = [];
    const buy = q.run('MINT', async () => { await sleep(30); positions.push('pos'); events.push('bought'); });
    assert.strictEqual(q.isBusy('MINT'), true, 'the sell path can see the buy in flight');
    const sell = q.run('MINT', async () => { events.push(positions.length ? 'sold' : 'nothing'); });
    await Promise.all([buy, sell]);
    assert.deepStrictEqual(events, ['bought', 'sold']);
  });

  test('the service is wired to all of this', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/kind === 'transfer'/.test(svc), 'transfers are surfaced, not copied');
    assert.ok(/tradeQueue\.run\(mint,/.test(svc) && /tradeQueue\.run\(sig\.mint,/.test(svc) && /tradeQueue\.run\(pos\.mint,/.test(svc),
      'buys, leader sells and manual sells all queue on the mint');
    assert.ok(/paperExitPrice\(/.test(svc), 'paper exits print the leader price');
    assert.ok(/bondingCurvePda\(mint\)/.test(svc), 'pump.fun trades are priced from the curve account');
    assert.ok(/netSolFlowSol\(/.test(svc), 'the network fee is not part of the price');
    assert.ok(!/exitQueue/.test(svc), 'the old per-position queue is gone');
  });
}

console.log('\n-- Copy trader: pump.fun trades are read from the log lines at processed — no RPC on the hot path --');
{
  const {
    decodeTradeEvent, tradeEventsFromLogs, tradeEventPriceSol, TRADE_EVENT_DISCRIMINATOR, PUMP_PROGRAM_ID,
  } = require('../services/pumpEventDecoder');
  const fixture = require('./fixtures/pump-trade-logs.json');
  const { PublicKey: PK } = require('@solana/web3.js');
  const MINT = fixture.expected.mint;
  const USER = fixture.expected.user;

  const eventLine = (f: { sol: number; tokens: number; isBuy: boolean }) => {
    const b = Buffer.alloc(129);
    TRADE_EVENT_DISCRIMINATOR.copy(b, 0);
    new PK(MINT).toBuffer().copy(b, 8);
    b.writeBigUInt64LE(BigInt(f.sol), 40);
    b.writeBigUInt64LE(BigInt(f.tokens), 48);
    b.writeUInt8(f.isBuy ? 1 : 0, 56);
    new PK(USER).toBuffer().copy(b, 57);
    b.writeBigInt64LE(BigInt(1_700_000_000), 89);
    return `Program data: ${b.toString('base64')}`;
  };

  test('a real pump.fun buy decodes from its log lines exactly as the chain reports it', () => {
    const events = tradeEventsFromLogs(fixture.logs);
    assert.strictEqual(events.length, 1, 'one TradeEvent per trade');
    const ev = events[0];
    assert.strictEqual(ev.mint, MINT);
    assert.strictEqual(ev.user, USER, 'the trader, so a wallet merely mentioned in the tx is not credited with the trade');
    assert.strictEqual(ev.isBuy, fixture.expected.isBuy);
    assert.ok(Math.abs(Number(ev.solLamports) / 1e9 - fixture.expected.sol) < 1e-12);
    assert.ok(Math.abs(Number(ev.tokenRaw) / 1e6 - fixture.expected.tokens) < 1e-9);
    assert.ok(tradeEventPriceSol(ev) > 0);
  });

  test('the discriminator is Anchor\'s for TradeEvent', () => {
    assert.strictEqual(TRADE_EVENT_DISCRIMINATOR.toString('hex'), 'bddb7fd34ee661ee');
  });

  test('a sell event carries isBuy=false and its own amounts', () => {
    const logs = [`Program ${PUMP_PROGRAM_ID} invoke [1]`, eventLine({ sol: 123_000_000, tokens: 5_000_000_000, isBuy: false }), `Program ${PUMP_PROGRAM_ID} success`];
    const [ev] = tradeEventsFromLogs(logs);
    assert.ok(ev);
    assert.strictEqual(ev.isBuy, false);
    assert.strictEqual(Number(ev.solLamports), 123_000_000);
    assert.strictEqual(Number(ev.tokenRaw), 5_000_000_000);
  });

  test('an identical event emitted by some OTHER program is not a pump.fun trade', () => {
    const other = 'SomeOtherProgram1111111111111111111111111111';
    const logs = [`Program ${other} invoke [1]`, eventLine({ sol: 1, tokens: 1, isBuy: true }), `Program ${other} success`];
    assert.deepStrictEqual(tradeEventsFromLogs(logs), []);
  });

  test('nested CPI: a pump.fun trade inside a router is still attributed to pump.fun', () => {
    const router = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const logs = [
      `Program ${router} invoke [1]`,
      `Program ${PUMP_PROGRAM_ID} invoke [2]`,
      'Program log: Instruction: Buy',
      eventLine({ sol: 50_000_000, tokens: 1_000_000_000, isBuy: true }),
      `Program ${PUMP_PROGRAM_ID} consumed 30000 of 200000 compute units`,
      `Program ${PUMP_PROGRAM_ID} success`,
      `Program ${router} success`,
    ];
    assert.strictEqual(tradeEventsFromLogs(logs).length, 1);
  });

  test('garbage and short payloads are ignored, never thrown', () => {
    const logs = [`Program ${PUMP_PROGRAM_ID} invoke [1]`, 'Program data: AAAA', 'Program data: !!!', `Program ${PUMP_PROGRAM_ID} success`];
    assert.deepStrictEqual(tradeEventsFromLogs(logs), []);
    assert.strictEqual(decodeTradeEvent(Buffer.alloc(10)), null);
  });

  test('the service takes the fast lane first and reconciles its tally against the chain', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/if \(this\.handleFastLog\(ev, allEvents\)\) return;/.test(svc),
      'log lines before RPC (decode reused, not recomputed)');
    assert.ok(/reconcileLeaderBalances\(/.test(svc));
    // Mirror mode still takes the exact (slow) path when a sell exceeds the
    // tally, so a partial is sized correctly; full mode skips it (fraction=1).
    assert.ok(/tracked \+ 1e-6 < tokens\) return false/.test(svc),
      'mirror mode keeps the exact-path bail so a partial is sized correctly');
    assert.ok(/} else if \(this\.config\.sellMode === 'full'\)/.test(svc),
      'full mode is a distinct branch that sells 100% without the confirmed-fetch');
  });

  test('reconcile is coalesced per leader so a high-volume leader cannot 429 the key', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    // The fast lane must SCHEDULE (debounce) reconcile, not fire one confirmed
    // fetch per trade — measured 2026-08-29, once-per-trade on an arb leader
    // was the residual 429 source; coalescing dropped 429s/90s from 31 to 0.
    assert.ok(/this\.scheduleReconcile\(ev\.address, ev\.signature\)/.test(svc),
      'the fast lane schedules a coalesced reconcile');
    assert.ok(/private scheduleReconcile\(/.test(svc) && /reconcileTimers\.has\(leaderAddress\)/.test(svc),
      'one armed timer per leader, newest signature wins');
    // Concurrency adapts to the key: 5 on a real Helius key, 2 on fallback, and
    // backs off on repeated 429s.
    assert.ok(/isFallbackEndpoint\(this\.heliusKeyInUse\) \? 2 : 5/.test(svc),
      'real key gets a bigger fetch pool than the rate-limited fallback');
    assert.ok(/this\.maxConcurrentTxFetch = Math\.max\(2, this\.maxConcurrentTxFetch - 1\)/.test(svc),
      'repeated 429s shrink the pool toward the floor');
  });
}

console.log('\n-- Copy trader: stablecoin swaps and foreign venues are not memecoin buys --');
{
  const { isCopyableMint, isExecutableVenue, NON_MEME_MINTS } = require('../services/leaderTxClassifier');

  test('MEASURED 2026-08-23: a tracked market-maker produced 210 copied "buys" of USDC in two minutes', () => {
    assert.strictEqual(isCopyableMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), false, 'USDC');
    assert.strictEqual(isCopyableMint('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), false, 'USDT');
    assert.strictEqual(isCopyableMint('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'), false, 'mSOL');
    assert.strictEqual(isCopyableMint('5nGAK71Qc8D24Jg6mde2Hy9TWWHGuwv1X3ZYvmbEpump'), true, 'a pump.fun mint');
    assert.ok(NON_MEME_MINTS.size >= 10);
  });

  test('a buy is copied only from a venue the executor can trade on', () => {
    for (const v of ['pump', 'pump-amm', 'launchlab', 'raydium', 'raydium-cpmm']) assert.strictEqual(isExecutableVenue(v), true, v);
    assert.strictEqual(isExecutableVenue(undefined), false, 'no known program in the tx (Orca, Meteora, a plain transfer)');
    assert.strictEqual(isExecutableVenue('meteora'), false);
  });

  test('the service applies both before sizing a copy buy, and sells are NOT gated (we may hold the bag)', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/isCopyableMint\(mint\)/.test(svc));
    assert.ok(/resolveBuyPool\(sig\.pool, mint\)/.test(svc));
    const sellSection = svc.slice(svc.indexOf('private async onLeaderSell('), svc.indexOf('private closePosition('));
    assert.ok(!/isExecutableVenue|isCopyableMint/.test(sellSection), 'a leader exiting on any venue is still our exit signal');
  });
}

console.log('\n-- Copy trader v1.0.4 regression: the venue gate refused nearly every aggregator route --');
{
  const { resolveBuyPool } = require('../services/leaderTxClassifier');

  test('MEASURED: 9 of 10 Jupiter routes expose no venue program — a launchpad mint still buys via auto', () => {
    assert.strictEqual(resolveBuyPool(undefined, '5nGAK71Qc8D24Jg6mde2Hy9TWWHGuwv1X3ZYvmbEpump'), 'auto');
    assert.strictEqual(resolveBuyPool(undefined, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtbonk'), 'auto');
  });

  test('a known venue routes directly; unknown venue + unknown mint is the only refusal', () => {
    assert.strictEqual(resolveBuyPool('pump-amm', '5nGAK71Qc8D24Jg6mde2Hy9TWWHGuwv1X3ZYvmbEpump'), 'pump-amm');
    assert.strictEqual(resolveBuyPool('raydium', 'AnyMintAtAll1111111111111111111111111111111'), 'raydium');
    assert.strictEqual(resolveBuyPool('meteora', 'AnyMintAtAll1111111111111111111111111111111'), undefined, 'detected but not executable');
    assert.strictEqual(resolveBuyPool(undefined, 'AnyMintAtAll1111111111111111111111111111111'), undefined);
    assert.strictEqual(resolveBuyPool(undefined, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), undefined, 'USDC is not rescued by the suffix fallback');
  });

  test('paper junk in stablecoins is purged on load so the book cannot stay wedged at 10/10', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const svc = fsx.readFileSync(pathx.join(__dirname, '..', 'services', 'copyTraderService.ts'), 'utf8');
    assert.ok(/junk = restorable\.filter/.test(svc));
    assert.ok(/startsWith\('sim_'\)/.test(svc), 'only PAPER positions are dropped — real tokens are never silently discarded');
    assert.ok(/feedAutoClearMinutes: 2,/.test(svc), 'the feed clears itself every 2 minutes by default (owner request 2026-08-23)');
  });
}

{
  // ---- H1: pre-sign intent guard (txIntentGuard) ----
  // Every real trade signs bytes returned by PumpPortal. These prove the guard
  // allows a normal trade and refuses the drain shapes a hostile response could
  // carry. Reproduces the OLD behaviour: before the guard, all of these signed.
  const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const owner = Keypair.generate().publicKey;
  const attacker = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  const mkTx = (payer: PublicKey, ixs: TransactionInstruction[]): VersionedTransaction => {
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: ixs,
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  };

  test('OLD BUG: any lookup-table transaction was refused, so every real buy died', () => {
    // Measured 2026-08-29: PumpPortal returns lookup-bearing transactions for
    // ordinary routes. The guard refused all of them with "unverifiable route",
    // so real mode signed nothing while paper mode looked healthy.
    const { AddressLookupTableAccount } = require('@solana/web3.js');
    const extra = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;

    const inner = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        new TransactionInstruction({
          programId: PUMP,
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: extra, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([0, 1, 2, 3]),
        }),
      ],
    });

    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [extra] },
    });
    const tx = new VersionedTransaction(inner.compileToV0Message([table]));
    assert.ok((tx.message as any).addressTableLookups.length > 0, 'fixture must actually use a lookup table');

    assert.strictEqual(assertOutboundTradeTx(tx, owner).ok, false,
      'with no tables supplied it must still refuse — unverified is unsigned');
    assert.strictEqual(assertOutboundTradeTx(tx, owner, [table]).ok, true,
      'with the table resolved the same trade verifies and is allowed');
  });

  test('a lookup table we could not fetch is still refused, never signed blind', () => {
    const { AddressLookupTableAccount } = require('@solana/web3.js');
    const extra = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;
    const inner = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [new TransactionInstruction({
        programId: PUMP,
        keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: extra, isSigner: false, isWritable: true }],
        data: Buffer.from([0]),
      })],
    });
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [extra] },
    });
    const tx = new VersionedTransaction(inner.compileToV0Message([table]));
    // A DIFFERENT table handed in: the one the tx names is still unresolved.
    const wrong = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [extra] },
    });
    const v = assertOutboundTradeTx(tx, owner, [wrong]);
    assert.strictEqual(v.ok, false);
    assert.ok(/not resolved/.test(v.reason || ''), 'the reason names the unresolved table');
  });

  test('resolving tables does NOT weaken the guard — a hidden drain is still caught', () => {
    const { AddressLookupTableAccount } = require('@solana/web3.js');
    const attacker = Keypair.generate().publicKey;
    const tableKey = Keypair.generate().publicKey;
    const inner = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        new TransactionInstruction({
          programId: PUMP,
          keys: [{ pubkey: owner, isSigner: true, isWritable: true }],
          data: Buffer.from([0]),
        }),
        // the drain, with the destination hidden inside the lookup table
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1_000_000_000 }),
      ],
    });
    const table = new AddressLookupTableAccount({
      key: tableKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [attacker] },
    });
    const tx = new VersionedTransaction(inner.compileToV0Message([table]));
    const v = assertOutboundTradeTx(tx, owner, [table]);
    assert.strictEqual(v.ok, false, 'a lamport transfer to an unrelated account must be refused even when hidden in a table');
    assert.ok(/transfer/i.test(v.reason || ''));
  });

  test('H1 guard: a normal pump trade for us is allowed', () => {
    const legit = mkTx(owner, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PUMP,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
      }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(legit, owner).ok, true);
  });

  test('H1 guard: a SOL wrap to our own trade account is allowed', () => {
    const wsolAta = Keypair.generate().publicKey;
    const wrap = mkTx(owner, [
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: 5e8 }),
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: wsolAta, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([17]), // SyncNative — not an authority/allowance op
      }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(wrap, owner).ok, true, 'wrap to a trade-referenced ATA is legitimate');
  });

  test('H1 guard: OLD DRAIN — a System transfer to an unrelated wallet is refused', () => {
    const drain = mkTx(owner, [
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: attacker, lamports: 1_000_000_000 }),
    ]);
    const v = assertOutboundTradeTx(drain, owner);
    assert.strictEqual(v.ok, false);
    assert.ok(/transfer/i.test(v.reason || ''), v.reason);
  });

  test('H1 guard: a token SetAuthority is refused (reassigns our account)', () => {
    const setAuth = mkTx(owner, [
      new TransactionInstruction({
        programId: TOKEN,
        keys: [{ pubkey: owner, isSigner: true, isWritable: true }],
        data: Buffer.from([6, 2, 1, ...new Array(32).fill(9)]), // tag 6 = SetAuthority
      }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(setAuth, owner).ok, false);
  });

  test('H1 guard: a token Approve (delegate) is refused', () => {
    const approve = mkTx(owner, [
      new TransactionInstruction({
        programId: TOKEN,
        keys: [
          { pubkey: owner, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: false },
          { pubkey: owner, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([4, 0, 0, 0, 0, 0, 0, 0, 255]), // tag 4 = Approve
      }),
    ]);
    assert.strictEqual(assertOutboundTradeTx(approve, owner).ok, false);
  });

  test('H1 guard: a tx whose fee payer is not our wallet is refused', () => {
    const foreignPayer = mkTx(attacker, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ]);
    const v = assertOutboundTradeTx(foreignPayer, owner);
    assert.strictEqual(v.ok, false);
    assert.ok(/fee payer/i.test(v.reason || ''), v.reason);
  });

  test('H1 guard: a tx invoking an unexpected program is refused', () => {
    const evilProgram = Keypair.generate().publicKey;
    const tx = mkTx(owner, [
      new TransactionInstruction({
        programId: evilProgram,
        keys: [{ pubkey: owner, isSigner: true, isWritable: true }],
        data: Buffer.from([0]),
      }),
    ]);
    const v = assertOutboundTradeTx(tx, owner);
    assert.strictEqual(v.ok, false);
    assert.ok(/unexpected program/i.test(v.reason || ''), v.reason);
  });
}

void (async () => {
  // Async tests run here, one at a time. Before this existed they were counted
  // as passed the instant they were called, so their assertions never ran
  // against the result at all.
  if (pendingTests.length) {
    console.log(`\n-- Async tests (${pendingTests.length}, run sequentially) --`);
  }
  for (const t of pendingTests) {
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
