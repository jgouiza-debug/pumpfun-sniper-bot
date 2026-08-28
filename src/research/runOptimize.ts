/**
 * Runs the selection x exit grid, selects on IN-SAMPLE only, then validates the
 * shortlist ONCE on out-of-sample.
 *
 * Usage: ts-node src/research/runOptimize.ts [--paths DIR]
 */

import {
  loadCandidates, buildGrid, buildPolicies, runGrid, describeFilter,
  expectedBestByLuck, MIN_TRADES, type ConfigResult, type SelectionFilter,
} from './optimize';
import { runPolicy, computeMetrics, DEFAULT_CONFIG } from './backtest';

const LABELLED = [
  'reports/labelled-2026-08-13.jsonl',
  'reports/labelled-2026-08-08.jsonl',
  'reports/labelled-2026-08-05.jsonl',
  'reports/labelled-2026-08-10.jsonl',
];

function row(r: ConfigResult): string {
  const p = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1);
  return [
    String(r.trades).padStart(4),
    (r.winRatePct.toFixed(1) + '%').padStart(7),
    p(r.meanReturnPct).padStart(9),
    p(r.medianReturnPct).padStart(9),
    p(r.totalReturnPct).padStart(9),
    (r.top3SharePct.toFixed(0) + '%').padStart(6),
    p(r.exTop3Pct).padStart(9),
    r.underpowered ? '  UNDERPOWERED' : '',
  ].join(' ');
}
const HEAD = ['   N', 'WINRATE', '     MEAN', '   MEDIAN', '    TOTAL', '  TOP3', '  EX-TOP3'].join(' ');

function main() {
  const args = process.argv.slice(2);
  const pathsDir = args.includes('--paths') ? args[args.indexOf('--paths') + 1] : 'reports/pricepaths';

  const all = loadCandidates(LABELLED, pathsDir);
  const cut = Math.floor(all.length * 0.7);
  const inSample = all.slice(0, cut);
  const outOfSample = all.slice(cut);

  const grid = buildGrid();
  const policies = buildPolicies();

  console.log('');
  console.log('=========================== SELECTION OPTIMISER ===========================');
  console.log(`replayable candidates : ${all.length}  (in-sample ${inSample.length} / out-of-sample ${outOfSample.length})`);
  console.log(`grid                  : ${grid.length} filters x ${policies.length} exit policies = ${grid.length * policies.length} configurations`);
  console.log(`minimum trades        : ${MIN_TRADES} (anything below is UNDERPOWERED and ineligible)`);
  console.log('');
  console.log('DISCIPLINE: every configuration below is scored IN-SAMPLE ONLY.');
  console.log('Out-of-sample is touched once, at the end, for the shortlist. It selects nothing.');
  console.log('');

  const isResults = runGrid(inSample, pathsDir, 'IS', grid, policies);
  const eligible = isResults.filter((r) => !r.underpowered);

  console.log(`configurations evaluated : ${isResults.length}`);
  console.log(`eligible (n >= ${MIN_TRADES})        : ${eligible.length}`);
  console.log('');

  if (!eligible.length) {
    console.log('NO ELIGIBLE CONFIGURATION. Every filter combination cut the sample below the');
    console.log('minimum trade count. That is the honest result: at this data volume the grid');
    console.log('cannot distinguish anything. Collect more candidates before tuning.');
    return;
  }

  // --- The win-rate trap, demonstrated rather than asserted ---
  const byWin = eligible.slice().sort((a, b) => b.winRatePct - a.winRatePct);
  console.log('--- TOP 8 BY WIN RATE (in-sample) — the metric that was asked for ---');
  console.log('CONFIG'.padEnd(56) + HEAD);
  for (const r of byWin.slice(0, 8)) {
    console.log((r.filterLabel + ' | ' + r.policy).slice(0, 54).padEnd(56) + row(r));
  }
  console.log('');

  const byTotal = eligible.slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  console.log('--- TOP 8 BY ACTUAL RETURN (in-sample) ---');
  console.log('CONFIG'.padEnd(56) + HEAD);
  for (const r of byTotal.slice(0, 8)) {
    console.log((r.filterLabel + ' | ' + r.policy).slice(0, 54).padEnd(56) + row(r));
  }
  console.log('');

  // --- Multiple-testing sanity ---
  const sd = Math.sqrt(
    eligible.reduce((a, r) => a + (r.meanReturnPct - eligible.reduce((x, y) => x + y.meanReturnPct, 0) / eligible.length) ** 2, 0)
    / Math.max(1, eligible.length - 1)
  );
  const medianTrades = eligible.map((r) => r.trades).sort((a, b) => a - b)[Math.floor(eligible.length / 2)];
  const luck = expectedBestByLuck(eligible.length, sd, medianTrades);
  console.log('--- MULTIPLE-TESTING CHECK ---');
  console.log(`  ${eligible.length} eligible configurations were compared.`);
  console.log(`  Spread of mean return across them: sd = ${sd.toFixed(1)} points.`);
  console.log(`  Expected inflation of the BEST cell from luck alone: ~${luck.toFixed(1)} points.`);
  console.log(`  Best in-sample total return: ${byTotal[0].totalReturnPct.toFixed(1)}%`);
  console.log(`  => a winner must beat the field by MORE than ${luck.toFixed(1)} points to mean anything.`);
  console.log('');

  // --- Shortlist carried to out-of-sample, ONCE ---
  const shortlist: Array<{ label: string; filter: SelectionFilter; policy: string }> = [];
  const seen = new Set<string>();
  for (const r of [byTotal[0], byTotal[1], byWin[0], byWin[1]]) {
    if (!r) continue;
    const key = r.filterLabel + '|' + r.policy;
    if (seen.has(key)) continue;
    seen.add(key);
    shortlist.push({ label: key, filter: r.filter, policy: r.policy });
  }

  console.log('--- OUT-OF-SAMPLE VALIDATION (first and only look) ---');
  console.log('CONFIG'.padEnd(56) + HEAD);
  const verdicts: string[] = [];
  for (const s of shortlist) {
    const policy = policies.find((p) => p.name === s.policy)!;
    const selected = outOfSample.filter((c) => {
      const f = s.filter;
      if (f.minSocialCount > 0 && (c.socialCount === null || c.socialCount < f.minSocialCount)) return false;
      if (f.maxPriceChange5mPct !== null && (c.priceChange5mPct === null || c.priceChange5mPct > f.maxPriceChange5mPct)) return false;
      if (f.minBuyPressurePct > 0 && (c.buyPressurePct === null || c.buyPressurePct < f.minBuyPressurePct)) return false;
      if (f.minVolume5mUsd > 0 && (c.volume5mUsd === null || c.volume5mUsd < f.minVolume5mUsd)) return false;
      if (f.maxMarketCapUsd !== null && (!(c.marketCapUsd > 0) || c.marketCapUsd > f.maxMarketCapUsd)) return false;
      return true;
    });
    const trades = runPolicy(pathsDir, selected.map((c) => ({ mint: c.mint, decisionAtMs: c.decisionAtMs })), policy, DEFAULT_CONFIG);
    const m = computeMetrics(trades, s.policy, 'OOS');
    const isR = isResults.find((r) => r.filterLabel + '|' + r.policy === s.label && r.window === 'IS')!;
    console.log(s.label.slice(0, 54).padEnd(56) + [
      String(m.trades).padStart(4),
      (m.winRatePct.toFixed(1) + '%').padStart(7),
      (m.meanReturnPct >= 0 ? '+' : '') + m.meanReturnPct.toFixed(1).padStart(8),
      (m.medianReturnPct >= 0 ? '+' : '') + m.medianReturnPct.toFixed(1).padStart(8),
      (m.totalReturnPct >= 0 ? '+' : '') + m.totalReturnPct.toFixed(1).padStart(8),
      (m.top3ShareOfGrossPct.toFixed(0) + '%').padStart(6),
      (m.returnExTop3Pct >= 0 ? '+' : '') + m.returnExTop3Pct.toFixed(1).padStart(8),
      m.trades < MIN_TRADES ? '  UNDERPOWERED' : '',
    ].join(' '));

    if (m.trades < MIN_TRADES) {
      verdicts.push(`${s.label}: OOS sample is ${m.trades} trades — cannot validate. NOT a result.`);
    } else if (isR.totalReturnPct > 0 && m.totalReturnPct < 0) {
      verdicts.push(`${s.label}: OVERFIT — profitable in-sample (${isR.totalReturnPct.toFixed(1)}%), loses out-of-sample (${m.totalReturnPct.toFixed(1)}%). REVERTED.`);
    } else if (m.totalReturnPct < 0) {
      verdicts.push(`${s.label}: loses in BOTH windows (IS ${isR.totalReturnPct.toFixed(1)}%, OOS ${m.totalReturnPct.toFixed(1)}%). No edge.`);
    } else {
      verdicts.push(`${s.label}: survives out-of-sample (IS ${isR.totalReturnPct.toFixed(1)}%, OOS ${m.totalReturnPct.toFixed(1)}%) — inspect trade count and top-3 share before believing it.`);
    }
  }

  console.log('');
  console.log('--- VERDICTS ---');
  for (const v of verdicts) console.log('  ' + v);
  console.log('');
  console.log('READ THE WIN-RATE COLUMN AGAINST THE TOTAL COLUMN. A high win rate beside a');
  console.log('negative total is the scalp trap: many small wins funded by rare total losses.');
  console.log('===========================================================================');
  console.log('');
}

if (require.main === module) main();
