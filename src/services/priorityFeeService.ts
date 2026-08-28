import { Connection, PublicKey } from '@solana/web3.js';
import { clampPriorityFeeSol, percentile } from './pipelineUtils';

/**
 * Dynamic priority fee. Flag: dynamicPriorityFee, default OFF.
 *
 * The legacy path pays a static 0.001 SOL regardless of congestion, which
 * loses races when fees spike and overpays when the chain is quiet. This
 * samples getRecentPrioritizationFees SCOPED to the contended accounts (the
 * pump.fun program), takes the p75 of non-zero entries, and clamps the result:
 * never below the configured static fee (floor), never above maxPriorityFeeSol
 * nor 5% of the position size.
 *
 * Why account-scoped: the global fee distribution is dominated by quiet accounts
 * and systematically UNDERBIDS the exact pump.fun races this exists to win. The
 * pump.fun program is written by every pump trade, so scoping to it reflects
 * real contention on the venue — and because that account is the same for every
 * token, the 10s cache stays warm across tokens (no per-mint RPC on the hot
 * first buy). If the scoped sample is empty, it falls back to a global sample.
 *
 * The estimate assumes ~200k compute units per swap — PumpPortal's builder
 * does not expose its CU limit, so this is deliberately conservative
 * (overestimating CU overestimates the fee, which only makes us bid harder in
 * races, bounded by the caps). Refine from timeline data once localTxBuild
 * shadow logs reveal the real CU usage.
 *
 * Results cache for 10s so the RPC call almost never sits on the buy path.
 */
const ASSUMED_COMPUTE_UNITS = 200_000;
const CACHE_TTL_MS = 10_000;
/** The pump.fun bonding-curve program — written by every pump trade. */
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export class PriorityFeeService {
  private cachedP75MicroLamports = 0;
  private fetchedAt = 0;
  private inflight: Promise<number> | null = null;

  constructor(private getConnection: () => Connection) {}

  /**
   * p75 of recent prioritization fees for the contended accounts, microLamports
   * per CU. Cached 10s. Scoped to the pump.fun program; if that scoped query
   * yields no non-zero samples, falls back to the global distribution so a quiet
   * moment on the venue still produces a sane number rather than the bare floor.
   */
  private async getRecentP75(): Promise<number> {
    const now = Date.now();
    if (now - this.fetchedAt < CACHE_TTL_MS) return this.cachedP75MicroLamports;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const conn = this.getConnection();
        const scoped = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: [PUMP_PROGRAM] });
        let nonZero = scoped.map(f => f.prioritizationFee).filter(f => f > 0);
        if (nonZero.length === 0) {
          const global = await conn.getRecentPrioritizationFees();
          nonZero = global.map(f => f.prioritizationFee).filter(f => f > 0);
        }
        this.cachedP75MicroLamports = percentile(nonZero, 75);
        this.fetchedAt = Date.now();
      } catch {
        // Keep the last value; a stale estimate beats blocking a buy.
      } finally {
        this.inflight = null;
      }
      return this.cachedP75MicroLamports;
    })();

    return this.inflight;
  }

  /**
   * Priority fee in SOL for one transaction.
   * @param floorSol  the static configured fee — dynamic never goes below it
   * @param ceilingSol hard cap from config (maxPriorityFeeSol)
   * @param positionSol position size; fee additionally capped at 5% of it
   */
  public async getPriorityFeeSol(floorSol: number, ceilingSol: number, positionSol: number): Promise<{ feeSol: number; source: 'dynamic' | 'floor-fallback' }> {
    const p75 = await this.getRecentP75();
    if (p75 <= 0) return { feeSol: floorSol, source: 'floor-fallback' };

    // microLamports/CU * CU -> lamports (1e6 micro per lamport) -> SOL (1e9 lamports)
    const computedSol = (p75 * ASSUMED_COMPUTE_UNITS) / 1e6 / 1e9;
    const feeSol = clampPriorityFeeSol(computedSol, floorSol, ceilingSol, positionSol);
    return { feeSol: Number(feeSol.toFixed(6)), source: 'dynamic' };
  }
}
