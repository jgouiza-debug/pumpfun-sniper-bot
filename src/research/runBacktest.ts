/**
 * Backtest runner: splits the candidate set by time, evaluates policies, and runs
 * a parameter sensitivity sweep.
 *
 * DISCIPLINE ENFORCED HERE:
 *   - The split is CHRONOLOGICAL, never shuffled. Shuffling leaks the market
 *     regime across the boundary and makes out-of-sample meaningless.
 *   - Out-of-sample is evaluated but never tuned on. The sweep runs IN-SAMPLE
 *     only; the winner is then carried to out-of-sample once, and if it degrades
 *     that is reported as overfitting rather than quietly re-tuned.
 *   - Every table prints the assumption set that produced it.
 *
 * Usage:
 *   ts-node src/research/runBacktest.ts [--paths DIR] [--labelled FILE] [--sweep]
 */

import fs from 'fs';
import path from 'path';
import {
  runPolicy, computeMetrics, SHIPPED_POLICY, DEFAULT_CONFIG, DEFAULT_COSTS,
  type ExitPolicy, type BacktestConfig, type BacktestMetrics, type TradeResult,
} from './backtest';

interface Candidate { mint: string; symbol: string; decisionAtMs: number }

function loadCandidates(labelledFiles: string): Candidate[] {
  // Comma-separated so one run can span every corpus day. First sighting wins,
  // the same rule the labeller uses, so a mint seen on two days is not counted
  // twice — that would double-weight whichever tokens the feed repeated.
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const file of labelledFiles.split(',').map((f) => f.trim()).filter(Boolean)) {
    if (!fs.existsSync(file)) continue;
    for (const l of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      let r: any;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.txType !== 'migrate' || !(r.decisionAtMs > 0)) continue;
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      out.push({ mint: r.mint, symbol: r.symbol, decisionAtMs: r.decisionAtMs });
    }
  }
  return out.sort((a, b) => a.decisionAtMs - b.decisionAtMs);
}

function splitChronological(cands: Candidate[], inSampleFraction = 0.7) {
  const cut = Math.floor(cands.length * inSampleFraction);
  return { inSample: cands.slice(0, cut), outOfSample: cands.slice(cut) };
}

function fmtRow(m: BacktestMetrics): string {
  const p = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1);
  return [
    m.policy.padEnd(42).slice(0, 42),
    m.window.padEnd(5),
    String(m.trades).padStart(4),
    p(m.totalReturnPct).padStart(9),
    p(m.medianReturnPct).padStart(9),
    (m.winRatePct.toFixed(1) + '%').padStart(7),
    p(m.avgWinPct).padStart(10),
    p(m.avgLossPct).padStart(9),
    m.maxDrawdownPct.toFixed(1).padStart(7),
    m.sharpe.toFixed(2).padStart(7),
    (m.top3ShareOfGrossPct.toFixed(0) + '%').padStart(6),
    p(m.returnExTop3Pct).padStart(10),
  ].join(' ');
}

const HEADER = [
  'POLICY'.padEnd(42), 'WIN'.padEnd(5), '   N',
  '   TOTAL%', '  MEDIAN%', ' WINRATE', '    AVGWIN', '  AVGLOSS',
  ' MAXDD%', ' SHARPE', ' TOP3', '  EX-TOP3%',
].join(' ');

function policyVariants(): ExitPolicy[] {
  return [
    SHIPPED_POLICY,
    {
      name: 'no take-profit cap, 30m stop',
      maxHoldMinutes: 30,
      takeProfitRungs: [],
      trailingArmMultiple: 0,
      trailingGiveBackPct: 0,
      deadVolumeMinutes: 0,
    },
    {
      name: 'hold 6h, trail from 3x',
      maxHoldMinutes: 360,
      takeProfitRungs: [],
      trailingArmMultiple: 3.0,
      trailingGiveBackPct: 30,
      deadVolumeMinutes: 0,
    },
    {
      name: 'hold 24h, trail from 3x, dead-volume 20m',
      maxHoldMinutes: 1440,
      takeProfitRungs: [],
      trailingArmMultiple: 3.0,
      trailingGiveBackPct: 30,
      deadVolumeMinutes: 20,
    },
    {
      name: 'runner: TP 100 half, let rest ride 24h',
      maxHoldMinutes: 1440,
      takeProfitRungs: [{ atPct: 100, fraction: 0.5 }],
      trailingArmMultiple: 5.0,
      trailingGiveBackPct: 40,
      deadVolumeMinutes: 20,
    },
    {
      name: 'dead-volume only, 24h ceiling',
      maxHoldMinutes: 1440,
      takeProfitRungs: [],
      trailingArmMultiple: 0,
      trailingGiveBackPct: 0,
      deadVolumeMinutes: 15,
    },
  ];
}

function main() {
  const args = process.argv.slice(2);
  const pathsDir = args.includes('--paths') ? args[args.indexOf('--paths') + 1] : 'reports/pricepaths';
  const labelled = args.includes('--labelled')
    ? args[args.indexOf('--labelled') + 1]
    : 'reports/labelled-2026-08-13.jsonl,reports/labelled-2026-08-08.jsonl,reports/labelled-2026-08-05.jsonl,reports/labelled-2026-08-10.jsonl';
  const doSweep = args.includes('--sweep');

  const cands = loadCandidates(labelled);
  const withPaths = cands.filter((c) => fs.existsSync(path.join(pathsDir, `${c.mint}.json`)));
  const { inSample, outOfSample } = splitChronological(withPaths);

  const first = withPaths[0]?.decisionAtMs, last = withPaths[withPaths.length - 1]?.decisionAtMs;

  console.log('');
  console.log('================================ BACKTEST ================================');
  console.log(`candidates with a collected price path : ${withPaths.length} / ${cands.length}`);
  if (first && last) {
    console.log(`corpus window                          : ${new Date(first).toISOString()}`);
    console.log(`                                    -> ${new Date(last).toISOString()}`);
    console.log(`                                       (${((last - first) / 3600000).toFixed(1)} hours — ONE regime, see caveat below)`);
  }
  console.log(`chronological split                    : in-sample ${inSample.length} / out-of-sample ${outOfSample.length}`);
  console.log('');
  console.log('ASSUMPTIONS (all pessimistic, all stated):');
  console.log(`  fill model            : ${DEFAULT_CONFIG.fill} (buy the candle HIGH, sell the candle LOW)`);
  console.log(`  entry delay           : ${DEFAULT_CONFIG.entryDelayCandles} candle(s) after signal — we are NOT first in the block`);
  console.log(`  stake                 : ${DEFAULT_COSTS.stakeSol} SOL @ $${DEFAULT_COSTS.solPriceUsd}`);
  console.log(`  priority fee          : ${DEFAULT_COSTS.priorityFeeSol} SOL per leg`);
  console.log(`  protocol fees         : 1.5% per leg (1.0% pump + 0.5% portal)`);
  console.log(`  fixed round trip      : ${(DEFAULT_COSTS.priorityFeeSol * 2 + 0.00001 + 0.00203928).toFixed(6)} SOL`);
  console.log(`  failed-tx rate        : ${(DEFAULT_COSTS.failureRate * 100).toFixed(0)}% (fee burned, no position)`);
  console.log(`  dead pool             : counted as -100%, never dropped`);
  console.log('');

  const results: BacktestMetrics[] = [];
  const tradesByPolicy = new Map<string, TradeResult[]>();

  console.log(HEADER);
  console.log('-'.repeat(HEADER.length));
  for (const policy of policyVariants()) {
    for (const [label, set] of [['IS', inSample], ['OOS', outOfSample]] as const) {
      const trades = runPolicy(pathsDir, set, policy, DEFAULT_CONFIG);
      const m = computeMetrics(trades, policy.name, label);
      results.push(m);
      tradesByPolicy.set(`${policy.name}|${label}`, trades);
      console.log(fmtRow(m));
    }
    console.log('-'.repeat(HEADER.length));
  }

  console.log('');
  console.log('OVERFITTING CHECK — in-sample vs out-of-sample, per policy:');
  const byName = new Map<string, { is?: BacktestMetrics; oos?: BacktestMetrics }>();
  for (const m of results) {
    const e = byName.get(m.policy) || {};
    if (m.window === 'IS') e.is = m; else e.oos = m;
    byName.set(m.policy, e);
  }
  for (const [name, e] of byName) {
    if (!e.is || !e.oos) continue;
    const delta = e.oos.totalReturnPct - e.is.totalReturnPct;
    const flag = e.is.totalReturnPct > 0 && e.oos.totalReturnPct < 0
      ? '  <-- OVERFIT: profitable in-sample, loses out-of-sample'
      : '';
    console.log(`  ${name.padEnd(44)} IS ${e.is.totalReturnPct.toFixed(1).padStart(9)}%  OOS ${e.oos.totalReturnPct.toFixed(1).padStart(9)}%  delta ${delta.toFixed(1).padStart(9)}${flag}`);
  }

  if (doSweep) {
    console.log('');
    console.log('PARAMETER SENSITIVITY SWEEP (in-sample only — never tuned on OOS)');
    console.log('A parameter whose result collapses on a 10% move is fragile and is flagged.');
    console.log('');
    sweep(pathsDir, inSample);
  }

  console.log('');
  console.log('CAVEATS THAT LIMIT EVERY NUMBER ABOVE:');
  console.log('  * The corpus is a SINGLE ~10-hour window on 2026-08-13. The in/out-of-sample');
  console.log('    split therefore separates two slices of ONE market regime. This is NOT the');
  console.log('    3-regime walk-forward that was asked for, and cannot be, from this data.');
  console.log('  * Sharpe is printed because it was requested. Under a distribution with a');
  console.log('    median near -100% and a rare enormous right tail it is not interpretable.');
  console.log('  * TOP3 is the share of gross terminal value from the three best trades. When');
  console.log('    that is most of the total, the strategy is a lottery ticket and the mean is');
  console.log('    an artefact of one or two observations, not an expectancy.');
  console.log('==========================================================================');
  console.log('');
}

function sweep(pathsDir: string, set: Candidate[]) {
  const base = { ...SHIPPED_POLICY };

  const dims: Array<{ label: string; values: number[]; build: (v: number) => ExitPolicy }> = [
    {
      label: 'maxHoldMinutes',
      values: [15, 27, 30, 33, 60, 120, 360, 1440],
      build: (v) => ({ ...base, name: `hold=${v}m`, maxHoldMinutes: v }),
    },
    {
      label: 'trailingArmMultiple',
      values: [1.5, 2.0, 2.7, 3.0, 3.3, 5.0, 10.0],
      build: (v) => ({ ...base, name: `arm=${v}x`, trailingArmMultiple: v }),
    },
    {
      label: 'trailingGiveBackPct',
      values: [10, 20, 27, 30, 33, 50],
      build: (v) => ({ ...base, name: `giveback=${v}%`, trailingGiveBackPct: v }),
    },
    {
      label: 'entryDelayCandles (latency disadvantage)',
      values: [0, 1, 2, 5],
      build: () => base,
    },
  ];

  for (const d of dims) {
    console.log(`  --- ${d.label} ---`);
    const outs: Array<{ v: number; total: number }> = [];
    for (const v of d.values) {
      const cfg: BacktestConfig = d.label.startsWith('entryDelay')
        ? { ...DEFAULT_CONFIG, entryDelayCandles: v }
        : DEFAULT_CONFIG;
      const trades = runPolicy(pathsDir, set, d.build(v), cfg);
      const m = computeMetrics(trades, `${d.label}=${v}`, 'IS');
      outs.push({ v, total: m.totalReturnPct });
      console.log(`    ${String(v).padStart(7)} -> total ${m.totalReturnPct.toFixed(1).padStart(9)}%   median ${m.medianReturnPct.toFixed(1).padStart(7)}%   win ${m.winRatePct.toFixed(1).padStart(5)}%   n=${m.trades}`);
    }
    // Fragility: does a ~10% move in the parameter swing the result wildly?
    for (let i = 1; i < outs.length - 1; i++) {
      const prev = outs[i - 1], cur = outs[i], next = outs[i + 1];
      const swing = Math.max(Math.abs(cur.total - prev.total), Math.abs(next.total - cur.total));
      const scale = Math.max(1, Math.abs(cur.total));
      if (swing / scale > 1.0) {
        console.log(`    ^ FRAGILE near ${cur.v}: neighbouring values swing the result by ${swing.toFixed(0)} points`);
        break;
      }
    }
    console.log('');
  }
}

if (require.main === module) main();
