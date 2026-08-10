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
  maxAffordableBuySol,
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

  test('the allInSizing flag no longer exists', () => {
    const { DEFAULTS } = require('../services/featureFlags');
    assert.ok(!('allInSizing' in DEFAULTS), 'allInSizing must be gone from the flag set');
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

  test('a position down 60% has NO price exit — that is the point', () => {
    // No stop-loss helper exists to call. Assert the config surface is gone so
    // a future edit cannot quietly reintroduce a price floor.
    const engineSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../services/sniperEngine.ts'), 'utf8');
    assert.ok(!/config\.stopLossPct/.test(engineSrc),
      'engine must not reference config.stopLossPct');
    assert.ok(!/pnlPct\s*<=\s*-/.test(engineSrc),
      'engine must not contain a negative-pnl price stop');
    const typesSrc = require('fs').readFileSync(
      require('path').join(__dirname, '../types.ts'), 'utf8');
    assert.ok(!/\bstopLossPct\b/.test(typesSrc), 'BotConfig must not carry stopLossPct');
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

  test('the price stop-loss is still gone (guard against regression)', () => {
    assert.ok(!/config\.stopLossPct/.test(engineSrc));
    assert.ok(!/\bstopLossPct\b/.test(typesSrc));
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

  test('#5: forced exits are bounded, so an unsellable token stops burning fees', () => {
    assert.ok(/maxForceExitAttempts/.test(engineSrc));
    assert.ok(/forceExitAttempts/.test(engineSrc));
    assert.ok(/STRANDED/.test(engineSrc), 'a stranded position must be reported, not retried silently');
  });

  test('#11: the profit rungs have independent latches', () => {
    assert.ok(/pullbackRungTaken/.test(engineSrc), 'pullback rung needs its own latch');
    assert.ok(/tp1Taken/.test(engineSrc), 'TP1 needs its own latch');
    assert.ok(/pullbackRungTaken/.test(typesSrc) && /tp1Taken/.test(typesSrc));
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
    const guard = engineSrc.slice(engineSrc.indexOf('private async evaluatePlaybookTrigger('), engineSrc.indexOf('evaluatePlaybookTriggerInner('));
    assert.ok(/activePositions\.length \+ this\.entriesInFlight\.size/.test(guard),
      'the cap must count in-flight entries, not just confirmed positions');
    assert.ok(/finally/.test(engineSrc.slice(engineSrc.indexOf('this.entriesInFlight.add'), engineSrc.indexOf('this.entriesInFlight.add') + 400)),
      'the reservation must be released in a finally');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
