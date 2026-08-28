/**
 * Grid search over ENTRY SELECTION filters and EXIT policies, with strict
 * train/test separation.
 *
 * WHY SELECTION AND NOT JUST EXITS: the Phase 4 sweep measured the exit
 * parameters as inert — a 96x change in hold time moved the result 5 points,
 * because ~89% of these trades go to -100% regardless of how you exit. You
 * cannot exit your way out of a token that goes to zero. If leverage exists
 * anywhere it is in NOT BUYING those tokens, so this sweeps entry filters as the
 * primary axis and exits as the secondary one.
 *
 * ============================ ANTI-OVERFIT CONTRACT ============================
 *
 * 1. The split is CHRONOLOGICAL. Every configuration is scored on the in-sample
 *    window only. Out-of-sample is touched ONCE, at the end, for the handful of
 *    configurations already selected. It is never used to choose anything.
 *
 * 2. WIN RATE IS REPORTED BUT IS NOT AN OBJECTIVE WORTH MAXIMISING ALONE, and
 *    this module refuses to pretend otherwise. Win rate is trivially inflated by
 *    taking profit early or by filtering down to a handful of trades. Every table
 *    therefore prints win rate NEXT TO expectancy and trade count, so the cost of
 *    a flattering win rate is visible in the same row.
 *
 * 3. EVERY configuration tested is counted. With enough configurations, the best
 *    in-sample cell is expected to look good by chance alone; `expectedBestByLuck`
 *    estimates how good, so a real result can be told from a lucky one.
 *
 * 4. A configuration with fewer than MIN_TRADES trades is reported as
 *    UNDERPOWERED and is never eligible for selection, however good it looks.
 *    This is the guard against "100% win rate on 2 trades".
 * ===============================================================================
 */

import fs from 'fs';
import path from 'path';
import {
  runPolicy, computeMetrics, DEFAULT_CONFIG,
  type ExitPolicy, type TradeResult,
} from './backtest';

/** Below this, a result is noise no matter how attractive. */
export const MIN_TRADES = 12;

export interface SelectionFilter {
  minSocialCount: number;
  maxPriceChange5mPct: number | null;
  minBuyPressurePct: number;
  minVolume5mUsd: number;
  maxMarketCapUsd: number | null;
}

export interface Candidate {
  mint: string;
  symbol: string;
  decisionAtMs: number;
  socialCount: number | null;
  priceChange5mPct: number | null;
  buyPressurePct: number | null;
  volume5mUsd: number | null;
  marketCapUsd: number;
}

/**
 * A missing feature is NOT a pass. If a filter asks a question the data cannot
 * answer, the candidate is excluded — treating unknown as acceptable is how a
 * backtest quietly grants itself information it would not have had live.
 */
export function passesFilter(c: Candidate, f: SelectionFilter): boolean {
  if (f.minSocialCount > 0) {
    if (c.socialCount === null) return false;
    if (c.socialCount < f.minSocialCount) return false;
  }
  if (f.maxPriceChange5mPct !== null) {
    if (c.priceChange5mPct === null) return false;
    if (c.priceChange5mPct > f.maxPriceChange5mPct) return false;
  }
  if (f.minBuyPressurePct > 0) {
    if (c.buyPressurePct === null) return false;
    if (c.buyPressurePct < f.minBuyPressurePct) return false;
  }
  if (f.minVolume5mUsd > 0) {
    if (c.volume5mUsd === null) return false;
    if (c.volume5mUsd < f.minVolume5mUsd) return false;
  }
  if (f.maxMarketCapUsd !== null) {
    if (!(c.marketCapUsd > 0)) return false;
    if (c.marketCapUsd > f.maxMarketCapUsd) return false;
  }
  return true;
}

export function describeFilter(f: SelectionFilter): string {
  const bits: string[] = [];
  if (f.minSocialCount > 0) bits.push(`social>=${f.minSocialCount}`);
  if (f.maxPriceChange5mPct !== null) bits.push(`pump5m<=${f.maxPriceChange5mPct}%`);
  if (f.minBuyPressurePct > 0) bits.push(`buyPress>=${f.minBuyPressurePct}%`);
  if (f.minVolume5mUsd > 0) bits.push(`vol5m>=$${f.minVolume5mUsd}`);
  if (f.maxMarketCapUsd !== null) bits.push(`mcap<=$${f.maxMarketCapUsd}`);
  return bits.length ? bits.join(' ') : '(no filter — buy every migration)';
}

export interface ConfigResult {
  filter: SelectionFilter;
  filterLabel: string;
  policy: string;
  window: 'IS' | 'OOS';
  trades: number;
  winRatePct: number;
  meanReturnPct: number;
  medianReturnPct: number;
  totalReturnPct: number;
  top3SharePct: number;
  exTop3Pct: number;
  underpowered: boolean;
}

function score(trades: TradeResult[], f: SelectionFilter, policy: string, window: 'IS' | 'OOS'): ConfigResult {
  const m = computeMetrics(trades, policy, window);
  return {
    filter: f,
    filterLabel: describeFilter(f),
    policy,
    window,
    trades: m.trades,
    winRatePct: m.winRatePct,
    meanReturnPct: m.meanReturnPct,
    medianReturnPct: m.medianReturnPct,
    totalReturnPct: m.totalReturnPct,
    top3SharePct: m.top3ShareOfGrossPct,
    exTop3Pct: m.returnExTop3Pct,
    underpowered: m.trades < MIN_TRADES,
  };
}

export function buildGrid(): SelectionFilter[] {
  const socials = [0, 1, 2];
  const pumps: Array<number | null> = [null, 100, 300];
  const presses = [0, 55, 65];
  const vols = [0, 5_000, 25_000];
  const mcaps: Array<number | null> = [null, 25_000];

  const out: SelectionFilter[] = [];
  for (const minSocialCount of socials)
    for (const maxPriceChange5mPct of pumps)
      for (const minBuyPressurePct of presses)
        for (const minVolume5mUsd of vols)
          for (const maxMarketCapUsd of mcaps)
            out.push({ minSocialCount, maxPriceChange5mPct, minBuyPressurePct, minVolume5mUsd, maxMarketCapUsd });
  return out;
}

export function buildPolicies(): ExitPolicy[] {
  return [
    {
      name: 'ride (24h, trail 3x/30%)',
      maxHoldMinutes: 1440, takeProfitRungs: [],
      trailingArmMultiple: 3.0, trailingGiveBackPct: 30, deadVolumeMinutes: 20,
    },
    {
      name: 'shipped (30m, TP100/400)',
      maxHoldMinutes: 30,
      takeProfitRungs: [{ atPct: 100, fraction: 0.5 }, { atPct: 400, fraction: 0.25 }],
      trailingArmMultiple: 3.0, trailingGiveBackPct: 30, deadVolumeMinutes: 0,
    },
    {
      // Deliberately included to demonstrate the win-rate trap: a tiny profit
      // target hits often and earns nothing.
      name: 'scalp (TP +15% all, 30m)',
      maxHoldMinutes: 30, takeProfitRungs: [{ atPct: 15, fraction: 1.0 }],
      trailingArmMultiple: 0, trailingGiveBackPct: 0, deadVolumeMinutes: 0,
    },
    {
      name: 'scalp+ (TP +40% all, 60m)',
      maxHoldMinutes: 60, takeProfitRungs: [{ atPct: 40, fraction: 1.0 }],
      trailingArmMultiple: 0, trailingGiveBackPct: 0, deadVolumeMinutes: 0,
    },
  ];
}

/**
 * With `n` configurations tried on `trades` samples, how good would the best cell
 * look from luck alone? Approximates the expected maximum of n draws from the
 * sampling distribution of the mean (Tippett's rule for the expected max of n
 * standard normals), scaled by the observed standard error.
 */
export function expectedBestByLuck(n: number, sd: number, trades: number): number {
  if (n <= 1 || trades <= 1 || !(sd > 0)) return 0;
  const se = sd / Math.sqrt(trades);
  const z = Math.sqrt(2 * Math.log(n));
  return z * se;
}

export function loadCandidates(labelledFiles: string[], pathsDir: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const file of labelledFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.txType !== 'migrate' || !(r.decisionAtMs > 0)) continue;
      if (seen.has(r.mint)) continue;
      // Only candidates with a collected price path can be replayed.
      if (!fs.existsSync(path.join(pathsDir, `${r.mint}.json`))) continue;
      seen.add(r.mint);
      out.push({
        mint: r.mint,
        symbol: r.symbol,
        decisionAtMs: r.decisionAtMs,
        socialCount: r.socialCount,
        priceChange5mPct: r.priceChange5mPct,
        buyPressurePct: r.buyPressurePct,
        volume5mUsd: r.volume5mUsd,
        marketCapUsd: r.decisionMarketCapUsd,
      });
    }
  }
  return out.sort((a, b) => a.decisionAtMs - b.decisionAtMs);
}

export function runGrid(
  cands: Candidate[],
  pathsDir: string,
  window: 'IS' | 'OOS',
  grid: SelectionFilter[],
  policies: ExitPolicy[]
): ConfigResult[] {
  const results: ConfigResult[] = [];
  for (const f of grid) {
    const selected = cands.filter((c) => passesFilter(c, f));
    if (!selected.length) continue;
    for (const p of policies) {
      const trades = runPolicy(pathsDir, selected.map((c) => ({ mint: c.mint, decisionAtMs: c.decisionAtMs })), p, DEFAULT_CONFIG);
      if (!trades.length) continue;
      results.push(score(trades, f, p.name, window));
    }
  }
  return results;
}
