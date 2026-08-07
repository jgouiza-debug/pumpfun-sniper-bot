import axios, { AxiosError, AxiosInstance } from "axios";
import { RugCheckReport, RugCheckTopHolder } from "../types";

export interface RugCheckServiceOptions {
  baseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  rateLimitMs?: number;
}

/**
 * Addresses that hold supply on behalf of a pool rather than a person.
 * Without excluding these, the bonding curve itself shows up as a ~90% holder
 * and every single pump.fun token fails the concentration gate.
 */
const POOL_OWNERS = new Set<string>([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun bonding curve program
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // pump.fun AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j',  // Raydium authority
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',  // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpools
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  // Orca
]);

export class RugCheckService {
  private axiosInstance: AxiosInstance;
  private maxRetries: number;
  private retryDelayMs: number;
  private rateLimitMs: number;
  private lastRequestTime = 0;
  /**
   * Serializes limiter decisions. The previous read-then-set implementation
   * let concurrent callers both observe a stale lastRequestTime and stampede
   * the API together during launch bursts.
   */
  private rateLimitChain: Promise<void> = Promise.resolve();

  constructor(options: RugCheckServiceOptions = {}) {
    const baseUrl = options.baseUrl || "https://api.rugcheck.xyz/v1";
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.rateLimitMs = options.rateLimitMs ?? 500;

    this.axiosInstance = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
      headers: {
        "Accept": "application/json",
        "User-Agent": "PumpFunTokenScreeningPipeline/1.0",
      },
    });
  }

  private enforceRateLimit(): Promise<void> {
    const turn = this.rateLimitChain.then(async () => {
      const wait = this.rateLimitMs - (Date.now() - this.lastRequestTime);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestTime = Date.now();
    });
    // The chain itself must never reject, or one failure poisons every later caller.
    this.rateLimitChain = turn.catch(() => {});
    return turn;
  }

  public async getReport(mint: string): Promise<RugCheckReport> {
    // Single attempt first
    try {
      await this.enforceRateLimit();
      const response = await this.axiosInstance.get<RugCheckReport>(`/tokens/${mint}/report`);
      return this.normalizeReport(response.data, mint);
    } catch (error: any) {
      const status = (error as AxiosError).response?.status;
      // On 429 or 5xx: one retry with a short fixed delay, then fall back
      if (status === 429 || (status && status >= 500) || error.code === 'ECONNABORTED') {
        await new Promise((res) => setTimeout(res, Math.min(this.retryDelayMs, 500)));
        try {
          await this.enforceRateLimit();
          const retry = await this.axiosInstance.get<RugCheckReport>(`/tokens/${mint}/report`);
          return this.normalizeReport(retry.data, mint);
        } catch {
          // Silent fallback — never throw, never crash the server
          return this.buildInferredReport(mint);
        }
      }
      return this.buildInferredReport(mint);
    }
  }

  /**
   * Derives concentration metrics from the real holder list and folds them into
   * fileMeta so the risk filter reads measured values instead of defaults.
   */
  private normalizeReport(report: RugCheckReport, mint: string): RugCheckReport {
    const holders: RugCheckTopHolder[] = Array.isArray(report.topHolders) ? report.topHolders : [];

    // Strip pool-owned balances; they are liquidity, not holder concentration.
    const realHolders = holders.filter((h) => {
      const owner = h.owner || h.address || '';
      return !POOL_OWNERS.has(owner) && !POOL_OWNERS.has(h.address || '');
    });

    // Aggregate by OWNER before ranking. RugCheck lists token ACCOUNTS, and one
    // owner can hold several, so summing rows double-counts them. Observed
    // 2026-08-05: a top10Pct of 189.65% — impossible as a share of supply, and
    // proof the raw sum cannot be trusted as-is.
    const byOwner = new Map<string, { pct: number; insider: boolean }>();
    for (const h of realHolders) {
      const key = h.owner || h.address || '';
      if (!key) continue;
      const prev = byOwner.get(key);
      const pct = Number(h.pct) || 0;
      if (prev) {
        prev.pct += pct;
        prev.insider = prev.insider || Boolean(h.insider);
      } else {
        byOwner.set(key, { pct, insider: Boolean(h.insider) });
      }
    }

    const owners = [...byOwner.values()].sort((a, b) => b.pct - a.pct);
    const rawTop10 = owners.slice(0, 10).reduce((acc, o) => acc + o.pct, 0);
    const rawInsider = owners.filter(o => o.insider).reduce((acc, o) => acc + o.pct, 0);

    // A share of supply cannot exceed 100%. If it does, the upstream numbers are
    // not what we think they are — clamp for safety but mark the reading
    // untrusted so the gate treats it as unverified rather than as fact.
    const concentrationAnomaly = rawTop10 > 100.5;
    const clamp = (n: number) => Math.max(0, Math.min(100, Number(n.toFixed(2))));
    const top10Pct = clamp(rawTop10);
    const maxSingleHolderPct = clamp(owners.length > 0 ? owners[0].pct : 0);
    const insiderPct = clamp(rawInsider);

    const anyReport = report as any;
    const insiderNetworkCount = Array.isArray(anyReport.insiderNetworks) ? anyReport.insiderNetworks.length : 0;

    return {
      ...report,
      mint: report.mint || mint,
      isInferred: false,
      fileMeta: {
        ...(report.fileMeta || {}),
        top10Pct,
        maxSingleHolderPct,
        insiderPct,
        /** True when the holder percentages summed past 100 — reading untrusted. */
        concentrationAnomaly,
        rawTop10Pct: Number(rawTop10.toFixed(2)),
        uniqueOwners: byOwner.size,
        insiderNetworkCount,
        graphInsidersDetected: Number(anyReport.graphInsidersDetected || 0),
        totalHolders: Number(anyReport.totalHolders || 0),
        rugged: Boolean(anyReport.rugged),
        holderSampleSize: realHolders.length,
      },
    };
  }

  /**
   * Used when RugCheck has no data yet, which is the norm for a mint that is
   * seconds old.
   *
   * The previous implementation hashed the mint string to invent mintAuthority,
   * freezeAuthority and lpLockedPct. That rejected roughly a third of tokens at
   * random and passed the rest on fabricated safety data.
   *
   * Instead we state the pump.fun program invariants that genuinely hold for
   * every bonding-curve launch (full supply minted upfront, both authorities
   * revoked at creation), leave everything we cannot observe unset, and flag the
   * whole report as inferred so scoring can demand market confirmation before
   * committing size.
   */
  private buildInferredReport(mint: string): RugCheckReport {
    return {
      mint,
      score: 0,
      isInferred: true,
      token: {
        // Guaranteed by the pump.fun program for bonding-curve mints.
        mintAuthority: null,
        freezeAuthority: null,
        supply: 1000000000,
        decimals: 6,
      },
      tokenMeta: undefined,
      risks: [],
      markets: [],
      topHolders: [],
      totalMarketLiquidity: undefined,
      totalLPPercent: undefined,
      fileMeta: {
        // Deliberately empty: unknown is not the same as safe. The risk filter
        // treats missing concentration data as unverified, not as a pass.
        unverified: true,
      },
    };
  }
}
