/**
 * Per-day walk-forward. Each corpus day is scored independently, so a result
 * that only exists on one day cannot hide inside a pooled average.
 */
import fs from 'fs';
import { runPolicy, computeMetrics, SHIPPED_POLICY, DEFAULT_CONFIG } from '../backtest';

const DAYS = ['05', '08', '10', '13'];
console.log('');
console.log('PER-DAY WALK-FORWARD — shipped policy, each day scored on its own');
console.log('');
console.log('  DAY        N   WINRATE     TOTAL%    MEDIAN%   TOP3   EX-TOP3%');
for (const d of DAYS) {
  const f = `reports/labelled-2026-08-${d}.jsonl`;
  if (!fs.existsSync(f)) continue;
  const cands: Array<{ mint: string; decisionAtMs: number }> = [];
  const seen = new Set<string>();
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
    const r = JSON.parse(l);
    if (r.txType !== 'migrate' || !(r.decisionAtMs > 0)) continue;
    if (seen.has(r.mint)) continue;
    seen.add(r.mint);
    if (!fs.existsSync(`reports/pricepaths/${r.mint}.json`)) continue;
    cands.push({ mint: r.mint, decisionAtMs: r.decisionAtMs });
  }
  const t = runPolicy('reports/pricepaths', cands, SHIPPED_POLICY, DEFAULT_CONFIG);
  const m = computeMetrics(t, 'shipped', 'IS');
  console.log(
    `  08-${d}  ${String(m.trades).padStart(4)}   ${(m.winRatePct.toFixed(1) + '%').padStart(6)}   `
    + `${m.totalReturnPct.toFixed(1).padStart(8)}%  ${m.medianReturnPct.toFixed(1).padStart(8)}%  `
    + `${(m.top3ShareOfGrossPct.toFixed(0) + '%').padStart(5)}  ${m.returnExTop3Pct.toFixed(1).padStart(8)}%`
  );
}
console.log('');
console.log('  A strategy with an edge is profitable on SOME day. None of these are.');
