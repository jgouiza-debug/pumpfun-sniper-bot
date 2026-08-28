/**
 * Evidence sensors — what feeds the exit ladder's tri-state Evidence.
 *
 * DATA PATH: on every buy, the runner subscribes the mint's trade stream on the
 * PumpPortal WS (the same source the engine uses). Each trade event carries the
 * curve's virtual reserves and the trader's public key, so ONE subscription
 * yields three sensors at once:
 *   - a live price/pool mark for paper fills and profit rungs
 *   - curve-drain detection (peak vs current real SOL)
 *   - dev-sell detection (trader == creator)
 * Post-migration, DexScreener samples add liquidity-step (pool drain) detection.
 * Authority-regained is an on-demand RPC read (honeypotDetector.inspectMintSafety)
 * on the slow lane, when a Connection is available.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a sensor that has not reported says
 * NULL, never false. A dropped WS subscription and a healthy token are
 * indistinguishable from silence, and the week's audit showed exactly what
 * happens when silence gets read as a verdict. Every getter here degrades to
 * null, and the ladder (by proof) treats null as "do nothing".
 */

import { Evidence, NO_EVIDENCE } from './exitLadder';
import { isPoolDrained, acceptPeakUpdate } from '../services/pipelineUtils';
import type { PoolSnapshot } from './executionPort';

/** Matches the engine's CURVE_DRAINED defaults. */
const CURVE_DRAIN_MIN_PEAK_SOL = 5;
const CURVE_DRAIN_FRACTION = 0.6;
const POOL_DRAIN_FRACTION = 0.5;
const POOL_DRAIN_MIN_PEAK_USD = 2000;
/** A sensor silent longer than this is DARK, and its channel reports null. */
const TRADE_STALE_MS = 90_000;

interface MintState {
  creator: string | null;
  entryMintRevoked: boolean | null;
  entryFreezeRevoked: boolean | null;
  // curve lane
  lastVSol: number | null;
  lastVTokens: number | null;
  peakRealSol: number;
  lastTradeAt: number;
  migrated: boolean;
  devSold: boolean;
  // dex lane
  lastPriceUsd: number | null;
  peakLiquidityUsd: number;
  lastLiquidityUsd: number | null;
  lastDexAt: number;
  // authority lane
  authorityRegained: boolean | null;
  sellPathReverts: boolean | null;
}

export class EvidenceSensors {
  private mints = new Map<string, MintState>();

  public arm(mint: string, opts: {
    creator: string | null;
    entryMintRevoked: boolean | null;
    entryFreezeRevoked: boolean | null;
    vSol: number | null;
    vTokens: number | null;
  }): void {
    this.mints.set(mint, {
      creator: opts.creator,
      entryMintRevoked: opts.entryMintRevoked,
      entryFreezeRevoked: opts.entryFreezeRevoked,
      lastVSol: opts.vSol, lastVTokens: opts.vTokens,
      peakRealSol: Math.max(0, (opts.vSol ?? 30) - 30),
      lastTradeAt: Date.now(), migrated: false, devSold: false,
      lastPriceUsd: null, peakLiquidityUsd: 0, lastLiquidityUsd: null, lastDexAt: 0,
      authorityRegained: null, sellPathReverts: null,
    });
  }

  public disarm(mint: string): void { this.mints.delete(mint); }
  public tracked(): string[] { return [...this.mints.keys()]; }

  /** Feed a PumpPortal trade event for a tracked mint. */
  public onTrade(payload: any, nowMs = Date.now()): void {
    const s = this.mints.get(payload?.mint);
    if (!s) return;
    s.lastTradeAt = nowMs;
    const vSol = Number(payload?.vSolInBondingCurve);
    const vTokens = Number(payload?.vTokensInBondingCurve);
    if (isFinite(vSol) && vSol > 0) {
      s.lastVSol = vSol;
      s.peakRealSol = Math.max(s.peakRealSol, vSol - 30);
    }
    if (isFinite(vTokens) && vTokens > 0) s.lastVTokens = vTokens;
    if (payload?.txType === 'migrate') s.migrated = true;
    if (s.creator && payload?.txType === 'sell' && payload?.traderPublicKey === s.creator) {
      s.devSold = true;
    }
  }

  /** Feed a DexScreener sample (post-migration lane). */
  public onDexSample(mint: string, d: { priceUsd?: number; liquidityUsd?: number }, nowMs = Date.now()): void {
    const s = this.mints.get(mint);
    if (!s) return;
    s.lastDexAt = nowMs;
    if (typeof d.priceUsd === 'number' && d.priceUsd > 0) {
      // Peak gating mirrors the engine: a 10x single-tick print is a glitch, not a peak.
      if (typeof d.liquidityUsd === 'number' && acceptPeakUpdate({
        candidatePriceUsd: d.priceUsd, prevPriceUsd: s.lastPriceUsd ?? d.priceUsd,
        currentPeakUsd: s.peakLiquidityUsd,
      })) {
        s.peakLiquidityUsd = Math.max(s.peakLiquidityUsd, d.liquidityUsd);
      }
      s.lastPriceUsd = d.priceUsd;
    }
    if (typeof d.liquidityUsd === 'number') s.lastLiquidityUsd = d.liquidityUsd;
  }

  /** Record an authority probe result (slow lane, needs RPC). */
  public onAuthorityProbe(mint: string, mintRevoked: boolean | null, freezeRevoked: boolean | null): void {
    const s = this.mints.get(mint);
    if (!s) return;
    if (mintRevoked === null || freezeRevoked === null) return; // probe failed = silence
    // Regained = was revoked at entry, now is not. A delta, never an absolute.
    if (s.entryMintRevoked === true && !mintRevoked) s.authorityRegained = true;
    else if (s.entryFreezeRevoked === true && !freezeRevoked) s.authorityRegained = true;
    else s.authorityRegained = false;
  }

  public onSellSim(mint: string, reverts: boolean | null): void {
    const s = this.mints.get(mint);
    if (s) s.sellPathReverts = reverts;
  }

  /** Current price mark and pool snapshot for fills. Null when nothing fresh. */
  public mark(mint: string): { pool: PoolSnapshot; priceUsd: number | null } | null {
    const s = this.mints.get(mint);
    if (!s) return null;
    if (!s.migrated && s.lastVSol && s.lastVTokens) {
      return { pool: { vSolInBondingCurve: s.lastVSol, vTokensInBondingCurve: s.lastVTokens }, priceUsd: null };
    }
    if (s.lastLiquidityUsd !== null && s.lastPriceUsd !== null) {
      return { pool: { liquidityUsd: s.lastLiquidityUsd, priceUsd: s.lastPriceUsd }, priceUsd: s.lastPriceUsd };
    }
    return null;
  }

  public evidence(mint: string, nowMs = Date.now()): Evidence {
    const s = this.mints.get(mint);
    if (!s) return { ...NO_EVIDENCE };
    const tradeFresh = nowMs - s.lastTradeAt < TRADE_STALE_MS;
    const dexFresh = nowMs - s.lastDexAt < TRADE_STALE_MS * 2;
    return {
      sellPathReverts: s.sellPathReverts,
      authorityRegained: s.authorityRegained,
      devSold: tradeFresh ? s.devSold : (s.devSold ? true : null), // a latched TRUE survives staleness; an unlatched no is silence
      curveDrained: !s.migrated && tradeFresh && s.lastVSol !== null
        ? (s.peakRealSol >= CURVE_DRAIN_MIN_PEAK_SOL && (s.lastVSol - 30) <= s.peakRealSol * CURVE_DRAIN_FRACTION)
        : null,
      poolDrained: s.migrated && dexFresh && s.lastLiquidityUsd !== null
        ? isPoolDrained({
            peakLiquidityUsd: s.peakLiquidityUsd, currentLiquidityUsd: s.lastLiquidityUsd,
            drainFraction: POOL_DRAIN_FRACTION, minPeakUsd: POOL_DRAIN_MIN_PEAK_USD,
          })
        : null,
    };
  }
}
