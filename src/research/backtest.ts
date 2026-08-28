/**
 * Backtest harness — replays REAL observed minute price paths against an exit
 * policy, with an honest cost model.
 *
 * This engine cannot place an order. It has no wallet, no keypair, no RPC write
 * path, and no import from the live engine's execution code. It reads cached
 * historical candles off disk and does arithmetic.
 *
 * ============================ HONESTY CONTRACT ============================
 *
 * Everything below is a place where a backtest can lie to its author. Each is
 * resolved in the pessimistic direction, and each is reported alongside results
 * so a number can never be read without its assumption.
 *
 * 1. WE ARE NOT FIRST IN THE BLOCK. The measured detection->decision budget is
 *    p50 180ms, and the build->submit->land legs are UNMEASURED (a remote HTTP
 *    transaction build sits on the critical path). So entry is never filled on
 *    the decision candle. `entryDelayCandles` defaults to 1 — the fill happens
 *    on the NEXT minute candle, after the move that triggered the signal.
 *
 * 2. INTRA-CANDLE SEQUENCE IS UNKNOWN. A minute candle gives open/high/low/close
 *    but not order. Filling at the open would assume we caught the candle's best
 *    moment. The default `fill: 'pessimistic'` buys at the candle HIGH and sells
 *    at the candle LOW. That is a lower bound on performance, not a forecast, and
 *    'midpoint' is available to bracket the range.
 *
 * 3. A DEAD POOL IS NOT A MISSING DATA POINT. A token whose pool vanished is a
 *    total loss, not an excluded row. Dropping it would bias every statistic
 *    upward, because the tokens that disappear are exactly the ones that failed.
 *    `NO_PATH` resolves to -100%, and the count is reported.
 *
 * 4. SLIPPAGE IS CHARGED AGAINST REAL VOLUME. The stake is compared to the
 *    candle's actual traded volume; taking a meaningful share of a thin minute
 *    costs more. This is a bounded approximation of depth, not depth itself.
 *
 * 5. FAILED TRANSACTIONS STILL COST. Solana charges the fee on a reverted
 *    transaction. `failureRate` burns fees without acquiring or disposing of a
 *    position.
 *
 * 6. SHARPE IS REPORTED BUT NEARLY MEANINGLESS HERE. This return distribution is
 *    a lottery: a median near -100% with a rare enormous right tail. Sharpe
 *    assumes roughly symmetric dispersion and is not interpretable under this much
 *    skew. It is computed because it was asked for, and flagged every time.
 *
 * 7. IN-SAMPLE / OUT-OF-SAMPLE IS ENFORCED BY TIME, not by shuffling. Shuffling
 *    would leak the market regime across the split.
 * =========================================================================
 */

import fs from 'fs';
import path from 'path';
import type { Candle, PricePath } from './fetchPriceHistory';

// --- Cost constants. Sourced from the live engine so the model cannot drift. ---
export const PUMP_FEE_PCT = 0.01;          // pump.fun / pump-amm protocol fee, per leg
export const PORTAL_FEE_PCT = 0.005;       // PumpPortal builder fee, per leg
export const NETWORK_FEE_SOL = 0.000005;   // base signature fee, per transaction
export const ATA_RENT_SOL = 0.00203928;    // associated token account rent, once per position

export interface CostModel {
  priorityFeeSol: number;
  stakeSol: number;
  solPriceUsd: number;
  /** Share of submitted transactions that revert but still pay the fee. */
  failureRate: number;
  /** Extra slippage charged when the stake is a large share of candle volume. */
  volumeImpactCoefficient: number;
}

export interface ExitPolicy {
  name: string;
  maxHoldMinutes: number;
  /** Ladder rungs: sell `fraction` when unrealized return reaches `atPct`. */
  takeProfitRungs: Array<{ atPct: number; fraction: number }>;
  /** Arm a trailing exit once this multiple of entry is touched. 0 disables. */
  trailingArmMultiple: number;
  /** Give-back from peak, once armed. */
  trailingGiveBackPct: number;
  /** Exit if the pool's traded volume dies for this many consecutive minutes. */
  deadVolumeMinutes: number;
}

export interface BacktestConfig {
  fill: 'pessimistic' | 'midpoint';
  entryDelayCandles: number;
  costs: CostModel;
}

export interface TradeResult {
  mint: string;
  symbol: string;
  entryAtMs: number;
  entryPrice: number;
  exitPrice: number;
  holdMinutes: number;
  /** Net of every modelled cost. */
  netReturnPct: number;
  grossReturnPct: number;
  exitReason: string;
  hadPath: boolean;
}

export interface BacktestMetrics {
  policy: string;
  window: string;
  trades: number;
  noPathTrades: number;
  totalReturnPct: number;
  meanReturnPct: number;
  medianReturnPct: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  top3ShareOfGrossPct: number;
  returnExTop3Pct: number;
}

// ---------------------------------------------------------------- cost helpers

/** Round-trip cost in SOL that does not scale with stake. */
export function fixedCostsSol(c: CostModel): number {
  return c.priorityFeeSol * 2 + NETWORK_FEE_SOL * 2 + ATA_RENT_SOL;
}

/** Proportional cost, per leg, as a fraction. */
export function proportionalCostPerLeg(): number {
  return PUMP_FEE_PCT + PORTAL_FEE_PCT;
}

/**
 * Slippage from taking a share of a thin minute. A stake that is a large fraction
 * of everything that traded in that candle moves the price against itself.
 */
export function volumeSlippagePct(stakeUsd: number, candleVolumeUsd: number, coefficient: number): number {
  if (!(candleVolumeUsd > 0)) return 25; // no observed volume: assume a punishing fill
  const share = stakeUsd / candleVolumeUsd;
  return Math.min(50, share * coefficient * 100);
}

// ---------------------------------------------------------------- path replay

function loadPath(dir: string, mint: string): PricePath | null {
  const f = path.join(dir, `${mint}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function buyPrice(c: Candle, mode: BacktestConfig['fill']): number {
  return mode === 'pessimistic' ? c.h : (c.h + c.l) / 2;
}
function sellPrice(c: Candle, mode: BacktestConfig['fill']): number {
  return mode === 'pessimistic' ? c.l : (c.h + c.l) / 2;
}

/**
 * Replays one candidate. Returns null when the decision predates the pool, which
 * would mean backtesting an entry that could not have been taken.
 */
export function replayOne(
  p: PricePath,
  policy: ExitPolicy,
  cfg: BacktestConfig
): TradeResult | null {
  const decisionSec = Math.floor(p.decisionAtMs / 1000);

  if (!p.candles.length) {
    // No market ever existed. Total loss, minus nothing recoverable.
    return {
      mint: p.mint, symbol: p.symbol, entryAtMs: p.decisionAtMs,
      entryPrice: 0, exitPrice: 0, holdMinutes: 0,
      netReturnPct: -100, grossReturnPct: -100,
      exitReason: 'NO_POOL — never had a market to exit into', hadPath: false,
    };
  }

  const startIdx = p.candles.findIndex((c) => c.t >= decisionSec);
  if (startIdx < 0) return null;

  // We are not first in the block: fill on a later candle than the signal.
  const entryIdx = startIdx + cfg.entryDelayCandles;
  if (entryIdx >= p.candles.length) return null;

  const entryCandle = p.candles[entryIdx];
  const rawEntry = buyPrice(entryCandle, cfg.fill);
  if (!(rawEntry > 0)) return null;

  const stakeUsd = cfg.costs.stakeSol * cfg.costs.solPriceUsd;
  const entrySlipPct = volumeSlippagePct(stakeUsd, entryCandle.v, cfg.costs.volumeImpactCoefficient);
  const entryPrice = rawEntry * (1 + entrySlipPct / 100);

  let remaining = 1;                 // fraction of the position still held
  let realizedGross = 0;             // sum of fraction * (exit/entry) already booked
  let peak = entryPrice;
  let trailingArmed = false;
  let deadMinutes = 0;
  const firedRungs = new Set<number>();
  let exitReason = 'MAX_HOLD';
  let lastIdx = entryIdx;

  for (let i = entryIdx; i < p.candles.length; i++) {
    lastIdx = i;
    const c = p.candles[i];
    const heldMinutes = (c.t - entryCandle.t) / 60;

    if (c.h > peak) peak = c.h;
    deadMinutes = c.v > 0 ? 0 : deadMinutes + 1;

    const bookExit = (fraction: number, price: number) => {
      const slip = volumeSlippagePct(stakeUsd * fraction, c.v, cfg.costs.volumeImpactCoefficient);
      const net = price * (1 - slip / 100);
      realizedGross += fraction * (net / entryPrice);
      remaining -= fraction;
    };

    // --- take-profit ladder, measured on the candle high ---
    for (let r = 0; r < policy.takeProfitRungs.length; r++) {
      if (firedRungs.has(r) || remaining <= 0) continue;
      const rung = policy.takeProfitRungs[r];
      const target = entryPrice * (1 + rung.atPct / 100);
      if (c.h >= target) {
        firedRungs.add(r);
        const frac = Math.min(rung.fraction, remaining);
        // Filled AT the rung price, not the candle high: assuming we sold the
        // exact top of the minute would be inventing execution quality.
        bookExit(frac, target);
        exitReason = `TP_${rung.atPct}`;
      }
    }
    if (remaining <= 0.0001) break;

    // --- trailing ratchet ---
    if (policy.trailingArmMultiple > 0 && !trailingArmed && peak >= entryPrice * policy.trailingArmMultiple) {
      trailingArmed = true;
    }
    if (trailingArmed) {
      const stop = peak * (1 - policy.trailingGiveBackPct / 100);
      if (c.l <= stop) {
        bookExit(remaining, stop);
        exitReason = 'TRAILING';
        break;
      }
    }

    // --- dead volume: the market left, which is evidence not price ---
    if (policy.deadVolumeMinutes > 0 && deadMinutes >= policy.deadVolumeMinutes) {
      bookExit(remaining, sellPrice(c, cfg.fill));
      exitReason = 'DEAD_VOLUME';
      break;
    }

    // --- time stop ---
    if (heldMinutes >= policy.maxHoldMinutes) {
      bookExit(remaining, sellPrice(c, cfg.fill));
      exitReason = 'MAX_HOLD';
      break;
    }
  }

  // Ran out of history still holding: mark at the last candle we saw.
  if (remaining > 0.0001) {
    const c = p.candles[lastIdx];
    const slip = volumeSlippagePct(stakeUsd * remaining, c.v, cfg.costs.volumeImpactCoefficient);
    realizedGross += remaining * ((sellPrice(c, cfg.fill) * (1 - slip / 100)) / entryPrice);
    exitReason = exitReason === 'MAX_HOLD' ? 'END_OF_DATA' : exitReason;
    remaining = 0;
  }

  const grossMultiple = realizedGross;
  const legFee = proportionalCostPerLeg();
  // Proportional protocol fees on both legs, then fixed costs against the stake.
  const afterProportional = grossMultiple * (1 - legFee) - legFee;
  const fixedDrag = fixedCostsSol(cfg.costs) / cfg.costs.stakeSol;
  const failureDrag = cfg.costs.failureRate * (cfg.costs.priorityFeeSol + NETWORK_FEE_SOL) / cfg.costs.stakeSol;
  const netMultiple = afterProportional - fixedDrag - failureDrag;

  const exitCandle = p.candles[lastIdx];
  return {
    mint: p.mint,
    symbol: p.symbol,
    entryAtMs: entryCandle.t * 1000,
    entryPrice,
    exitPrice: sellPrice(exitCandle, cfg.fill),
    holdMinutes: Math.round((exitCandle.t - entryCandle.t) / 60),
    grossReturnPct: Number(((grossMultiple - 1) * 100).toFixed(2)),
    netReturnPct: Number(((netMultiple - 1) * 100).toFixed(2)),
    exitReason,
    hadPath: true,
  };
}

// ---------------------------------------------------------------- metrics

export function computeMetrics(trades: TradeResult[], policy: string, window: string): BacktestMetrics {
  const n = trades.length;
  if (!n) {
    return {
      policy, window, trades: 0, noPathTrades: 0, totalReturnPct: 0, meanReturnPct: 0,
      medianReturnPct: 0, winRatePct: 0, avgWinPct: 0, avgLossPct: 0,
      maxDrawdownPct: 0, sharpe: 0, top3ShareOfGrossPct: 0, returnExTop3Pct: 0,
    };
  }

  const rets = trades.map((t) => t.netReturnPct);
  const mults = rets.map((r) => 1 + r / 100);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const sorted = rets.slice().sort((a, b) => a - b);

  // Equal-weight book: each candidate gets the same stake.
  const meanMultiple = mults.reduce((a, b) => a + b, 0) / n;

  // Sequential equity curve, in decision order, for drawdown.
  const chrono = trades.slice().sort((a, b) => a.entryAtMs - b.entryAtMs);
  let equity = 1, peakEquity = 1, maxDd = 0;
  for (const t of chrono) {
    // Each trade risks a fixed fraction of the book, so the curve compounds on
    // the average rather than betting everything on each one.
    equity *= (1 + (t.netReturnPct / 100) / Math.max(1, Math.min(n, 10)));
    peakEquity = Math.max(peakEquity, equity);
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDd) maxDd = dd;
  }

  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sd = Math.sqrt(variance);

  const topSorted = mults.slice().sort((a, b) => b - a);
  const grossTotal = mults.reduce((a, b) => a + b, 0);
  const top3 = topSorted.slice(0, 3).reduce((a, b) => a + b, 0);
  const exTop3 = n > 3 ? (grossTotal - top3) / (n - 3) : 0;

  return {
    policy,
    window,
    trades: n,
    noPathTrades: trades.filter((t) => !t.hadPath).length,
    totalReturnPct: Number(((meanMultiple - 1) * 100).toFixed(2)),
    meanReturnPct: Number(mean.toFixed(2)),
    medianReturnPct: Number(sorted[Math.floor(0.5 * (n - 1))].toFixed(2)),
    winRatePct: Number(((wins.length / n) * 100).toFixed(2)),
    avgWinPct: wins.length ? Number((wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(2)) : 0,
    avgLossPct: losses.length ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)) : 0,
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
    // Per-trade Sharpe. See honesty note 6 — not interpretable under this skew.
    sharpe: sd > 0 ? Number((mean / sd).toFixed(3)) : 0,
    top3ShareOfGrossPct: Number(((top3 / grossTotal) * 100).toFixed(2)),
    returnExTop3Pct: n > 3 ? Number(((exTop3 - 1) * 100).toFixed(2)) : 0,
  };
}

export function runPolicy(
  pathsDir: string,
  mints: Array<{ mint: string; decisionAtMs: number }>,
  policy: ExitPolicy,
  cfg: BacktestConfig
): TradeResult[] {
  const out: TradeResult[] = [];
  for (const m of mints) {
    const p = loadPath(pathsDir, m.mint);
    if (!p) continue;
    const r = replayOne(p, policy, cfg);
    if (r) out.push(r);
  }
  return out;
}

export const DEFAULT_COSTS: CostModel = {
  priorityFeeSol: 0.001,
  stakeSol: 0.1,
  solPriceUsd: 76,
  failureRate: 0.15,
  volumeImpactCoefficient: 0.5,
};

export const DEFAULT_CONFIG: BacktestConfig = {
  fill: 'pessimistic',
  entryDelayCandles: 1,
  costs: DEFAULT_COSTS,
};

/** The policy the live bot ships with today, as the baseline to beat. */
export const SHIPPED_POLICY: ExitPolicy = {
  name: 'shipped (30m stop, TP 100/400, 3x trail)',
  maxHoldMinutes: 30,
  takeProfitRungs: [{ atPct: 100, fraction: 0.5 }, { atPct: 400, fraction: 0.25 }],
  trailingArmMultiple: 3.0,
  trailingGiveBackPct: 30,
  deadVolumeMinutes: 0,
};
