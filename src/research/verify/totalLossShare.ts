/**
 * Verification script for the "how many of these go to near-zero" claim.
 *
 * Kept as a permanent script rather than a throwaway because the figure it
 * produces was previously ASSERTED at 89% from a win-rate column and turned out
 * to be 46%. Anything quoting that number should be able to re-run this.
 */
import fs from 'fs';
import { runPolicy, DEFAULT_CONFIG, SHIPPED_POLICY, type TradeResult } from '../backtest';

const cands: Array<{ mint: string; decisionAtMs: number }> = [];
for (const day of ['13', '08', '05', '10']) {
  const p = `reports/labelled-2026-08-${day}.jsonl`;
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, 'utf8').trim().split('\n')) {
    const r = JSON.parse(l);
    if (r.txType !== 'migrate' || !(r.decisionAtMs > 0)) continue;
    if (!fs.existsSync(`reports/pricepaths/${r.mint}.json`)) continue;
    cands.push({ mint: r.mint, decisionAtMs: r.decisionAtMs });
  }
}

const t: TradeResult[] = runPolicy('reports/pricepaths', cands, SHIPPED_POLICY, DEFAULT_CONFIG);
const near = t.filter((x) => x.netReturnPct <= -95).length;
console.log('replayed trades   :', t.length);
console.log('net <= -95%       :', near, `(${((100 * near) / t.length).toFixed(1)}%)`);
console.log('no pool at all    :', t.filter((x) => !x.hadPath).length);
console.log('net > 0           :', t.filter((x) => x.netReturnPct > 0).length);
