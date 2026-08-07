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
} from '../services/pipelineUtils';
import { EntryGateV2 } from '../services/entryGateV2';
import { RugCheckReport } from '../types';

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
  // A token at 45% of its curve — the Play 2 sweet spot.
  const curveSol = 0.45 * GRAD_SOL;
  const launch: any = { mint:'M', liquidityUsd: curveSol * SOL_USD, marketCapUsd: 30000,
    top10Pct:15, devHoldingsPct:4, bundledSupplyPct:2, washScore:0 };

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
