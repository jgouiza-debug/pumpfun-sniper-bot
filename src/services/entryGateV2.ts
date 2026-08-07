import { RugCheckReport } from '../types';

/**
 * EntryGateV2 — decision gate built exclusively on data that actually exists
 * at detection time. Flag: entryGateV2 (trade on it) / shadowGateV2 (log only).
 *
 * Why it exists (audit, 2026-08-04, measured):
 *  - DexScreener indexes 0/8 mints under 10s old, so any gate that needs a
 *    DexScreener pair cannot ever pass a fresh launch.
 *  - The legacy path "solves" that by fabricating inputs (liquidity $3,500,
 *    top10 12%, dev 1%...), which auto-rejects every fresh token in strict
 *    mode (3500 < 8000) and auto-passes every migration (12000 >= 8000,
 *    score 95 >= 62). 57/57 rejections in the recorded run were this constant.
 *  - What IS real at T+0: the PumpPortal payload (vSolInBondingCurve,
 *    initialBuy, solAmount, marketCapSol) and RugCheck (8/8 indexed, ~100ms).
 *
 * Design rule: no invented values. A check either runs on real data or is
 * reported in `unverifiedFields` — and unverified concentration is a REJECT by
 * default, not a pass. Exit logic is untouched (owner is hold-biased by
 * choice); this gate only decides entries.
 */

/** pump.fun initial virtual SOL reserves. Real SOL in curve = vSol - this. */
export const PUMP_VIRTUAL_SOL_BASE = 30;
/** pump.fun fixed supply: 1B tokens. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

export interface GateV2Config {
  /** Only bonding-curve creates and real migrations are tradeable events. */
  allowCreates: boolean;
  allowMigrations: boolean;

  /** Dev's initial buy as % of total supply (initialBuy is real, from the create tx). */
  maxDevInitialBuyPct: number;
  /** Dev must have some skin in the game; 0-buy deploys are spray-and-pray. */
  minDevInitialBuySol: number;
  /** Ceiling on dev initial spend — very large first buys are exit liquidity setups. */
  maxDevInitialBuySol: number;

  /** Real SOL deposited in the curve at detection (vSol - 30 virtual). */
  minRealSolInCurve: number;
  /** Market cap sanity band in SOL, straight from the payload. */
  minMarketCapSol: number;
  maxMarketCapSol: number;

  /** RugCheck-derived concentration limits (real holder data, pool owners excluded). */
  maxTop10Pct: number;
  maxSingleHolderPct: number;
  maxInsiderPct: number;
  maxRugcheckScore: number;

  /** If RugCheck has no holder data yet: true = reject (unknown is not safe), false = allow with unverified marker. */
  requireVerifiedConcentration: boolean;
}

export const GATE_V2_DEFAULTS: GateV2Config = {
  allowCreates: true,
  allowMigrations: true,
  maxDevInitialBuyPct: 6,
  minDevInitialBuySol: 0.1,
  maxDevInitialBuySol: 10,
  minRealSolInCurve: 0.5,
  minMarketCapSol: 25,
  maxMarketCapSol: 120,
  maxTop10Pct: 30,
  maxSingleHolderPct: 12,
  maxInsiderPct: 35,
  maxRugcheckScore: 1000,
  requireVerifiedConcentration: true,
};

export interface GateV2Result {
  isSafe: boolean;
  reasons: string[];
  unverifiedFields: string[];
  metrics: {
    txType: string;
    devInitialBuyPct: number | null;
    devInitialBuySol: number | null;
    realSolInCurve: number | null;
    marketCapSol: number | null;
    top10Pct: number | null;
    maxSingleHolderPct: number | null;
    insiderPct: number | null;
    rugcheckScore: number | null;
    rugcheckIndexed: boolean;
  };
}

export class EntryGateV2 {
  private config: GateV2Config;

  constructor(config?: Partial<GateV2Config>) {
    this.config = { ...GATE_V2_DEFAULTS, ...config };
  }

  public getConfig(): GateV2Config {
    return { ...this.config };
  }

  public updateConfig(patch: Partial<GateV2Config>): void {
    this.config = { ...this.config, ...patch };
  }

  /**
   * @param payload raw PumpPortal event (create or migrate)
   * @param rug normalized RugCheck report, or null/inferred when not available
   * @param isMigration resolved by the caller (txType under strictMigrationDetect)
   */
  public evaluate(payload: any, rug: RugCheckReport | null, isMigration: boolean): GateV2Result {
    const reasons: string[] = [];
    const unverified: string[] = [];
    const c = this.config;

    // ---- Event type ----
    const txType = isMigration ? 'migrate' : (payload?.txType || 'create');
    if (isMigration && !c.allowMigrations) reasons.push('Migrations disabled in gate config');
    if (!isMigration && !c.allowCreates) reasons.push('Fresh creates disabled in gate config');

    // ---- Real payload metrics (never fabricated; absent -> unverified) ----
    const vSol = Number(payload?.vSolInBondingCurve);
    const realSolInCurve = isFinite(vSol) && vSol > 0 ? Math.max(0, vSol - PUMP_VIRTUAL_SOL_BASE) : null;
    if (realSolInCurve === null) {
      if (!isMigration) unverified.push('realSolInCurve');
    } else if (!isMigration && realSolInCurve < c.minRealSolInCurve) {
      reasons.push(`Real SOL in curve ${realSolInCurve.toFixed(3)} < min ${c.minRealSolInCurve}`);
    }

    const marketCapSol = isFinite(Number(payload?.marketCapSol)) ? Number(payload.marketCapSol) : null;
    if (marketCapSol === null) {
      unverified.push('marketCapSol');
    } else {
      if (marketCapSol < c.minMarketCapSol) reasons.push(`Market cap ${marketCapSol.toFixed(1)} SOL < min ${c.minMarketCapSol}`);
      if (marketCapSol > c.maxMarketCapSol) reasons.push(`Market cap ${marketCapSol.toFixed(1)} SOL > max ${c.maxMarketCapSol} (already pumped at detection)`);
    }

    // Dev's initial position — only meaningful on the create event itself.
    let devInitialBuyPct: number | null = null;
    let devInitialBuySol: number | null = null;
    if (!isMigration) {
      const initialBuyTokens = Number(payload?.initialBuy);
      const devSol = Number(payload?.solAmount);
      if (isFinite(initialBuyTokens) && initialBuyTokens >= 0) {
        devInitialBuyPct = (initialBuyTokens / PUMP_TOTAL_SUPPLY) * 100;
        if (devInitialBuyPct > c.maxDevInitialBuyPct) {
          reasons.push(`Dev initial buy ${devInitialBuyPct.toFixed(1)}% of supply > max ${c.maxDevInitialBuyPct}%`);
        }
      } else {
        unverified.push('devInitialBuyPct');
      }
      if (isFinite(devSol) && devSol >= 0) {
        devInitialBuySol = devSol;
        if (devSol < c.minDevInitialBuySol) reasons.push(`Dev initial buy ${devSol.toFixed(3)} SOL < min ${c.minDevInitialBuySol} (no skin in the game)`);
        if (devSol > c.maxDevInitialBuySol) reasons.push(`Dev initial buy ${devSol.toFixed(2)} SOL > max ${c.maxDevInitialBuySol} (exit-liquidity setup risk)`);
      } else {
        unverified.push('devInitialBuySol');
      }
    }

    // ---- RugCheck (real holder/authority data; 8/8 fresh mints indexed, measured) ----
    const rugIndexed = Boolean(rug && !rug.isInferred);
    let top10Pct: number | null = null;
    let maxSingleHolderPct: number | null = null;
    let insiderPct: number | null = null;
    let rugcheckScore: number | null = null;

    if (rugIndexed && rug) {
      rugcheckScore = Number(rug.score ?? 0);
      if (rugcheckScore > c.maxRugcheckScore) reasons.push(`RugCheck score ${rugcheckScore} > max ${c.maxRugcheckScore}`);

      // Authorities: pump.fun program revokes both at creation; on a real
      // report a non-null authority means this is NOT a standard launch.
      if (rug.token) {
        if (rug.token.mintAuthority !== null) reasons.push('Mint authority active');
        if (rug.token.freezeAuthority !== null) reasons.push('Freeze authority active');
      }

      const meta = rug.fileMeta || {};
      if (typeof meta.top10Pct === 'number' && meta.holderSampleSize > 0) {
        const measuredTop10: number = meta.top10Pct;
        top10Pct = measuredTop10;
        maxSingleHolderPct = typeof meta.maxSingleHolderPct === 'number' ? meta.maxSingleHolderPct : null;
        insiderPct = typeof meta.insiderPct === 'number' ? meta.insiderPct : null;

        if (measuredTop10 > c.maxTop10Pct) reasons.push(`Top10 holders ${measuredTop10.toFixed(1)}% > max ${c.maxTop10Pct}% (measured, pools excluded)`);
        if (maxSingleHolderPct !== null && maxSingleHolderPct > c.maxSingleHolderPct) {
          reasons.push(`Largest holder ${maxSingleHolderPct.toFixed(1)}% > max ${c.maxSingleHolderPct}%`);
        }
        if (insiderPct !== null && insiderPct > c.maxInsiderPct) {
          reasons.push(`Insider holdings ${insiderPct.toFixed(1)}% > max ${c.maxInsiderPct}%`);
        }
        if (meta.rugged === true) reasons.push('RugCheck marks token as rugged');
      } else {
        unverified.push('holderConcentration');
        if (c.requireVerifiedConcentration) {
          reasons.push('Holder concentration unverified (RugCheck holder list empty) — unknown is not safe');
        }
      }
    } else {
      unverified.push('rugcheckReport');
      if (c.requireVerifiedConcentration) {
        reasons.push('RugCheck not indexed yet — concentration unverified, unknown is not safe');
      }
    }

    return {
      isSafe: reasons.length === 0,
      reasons,
      unverifiedFields: unverified,
      metrics: {
        txType,
        devInitialBuyPct,
        devInitialBuySol,
        realSolInCurve,
        marketCapSol,
        top10Pct,
        maxSingleHolderPct,
        insiderPct,
        rugcheckScore,
        rugcheckIndexed: rugIndexed,
      },
    };
  }
}

export const entryGateV2 = new EntryGateV2();
