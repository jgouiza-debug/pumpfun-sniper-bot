import axios from 'axios';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface DexScreenerData {
  mint: string;
  /** Real quoted price. Previously the engine derived price from marketCap/1e9. */
  priceUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  buys5m: number;
  sells5m: number;
  /** buys / (buys + sells) over 5m, as a percent. 50 = balanced. */
  buyPressurePct: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  /** 5m volume / liquidity. The cleanest single momentum signal on a meme pair. */
  turnover5m: number;
  socialCount: number;
  isBoosted: boolean;
  /** Undefined when DexScreener did not report pairCreatedAt — unknown, not "brand new". */
  pairAgeSeconds?: number;
  hasPair: boolean;
}

interface CacheEntry {
  data: DexScreenerData;
  fetchedAt: number;
}

/**
 * DexScreener market data with a shared TTL cache and a global rate limiter.
 *
 * The position monitor polls every open position on a loop; without a cache and
 * a limiter, ~10 positions on a 2s loop is 300 req/min, which is exactly the
 * documented ceiling. Getting 429'd mid-hold means flying blind through the
 * drawdowns we are explicitly choosing to sit through, so this is load-bearing.
 */
export class DexScreenerService {
  private static cache = new Map<string, CacheEntry>();
  private static inflight = new Map<string, Promise<DexScreenerData>>();

  /** Cache TTL. Meme prices move fast, but not faster than this. */
  private static ttlMs = 2500;

  /** DexScreener accepts up to 30 comma-separated mints on the token endpoint. */
  private static readonly BATCH_SIZE = 30;

  // Simple token bucket: 240 requests/min, refilled continuously.
  private static readonly maxTokens = 240;
  private static tokens = 240;
  private static lastRefill = Date.now();

  private static solPriceUsd = 0;
  private static solPriceFetchedAt = 0;

  private static refill(): void {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60000;
    if (elapsedMin > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsedMin * this.maxTokens);
      this.lastRefill = now;
    }
  }

  /**
   * @param reserveFloor tokens that must remain AFTER consuming. The entry
   * path passes a floor so candidate screening can never drain the bucket the
   * position monitor needs — going blind mid-hold is worse than skipping one
   * candidate lookup.
   */
  private static tryConsume(reserveFloor = 0): boolean {
    this.refill();
    if (this.tokens >= 1 + reserveFloor) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  public static setCacheTtl(ms: number): void {
    this.ttlMs = Math.max(500, ms);
  }

  private static empty(mint: string): DexScreenerData {
    return {
      mint,
      priceUsd: 0,
      volume5mUsd: 0,
      volume1hUsd: 0,
      marketCapUsd: 0,
      fdvUsd: 0,
      liquidityUsd: 0,
      buys5m: 0,
      sells5m: 0,
      buyPressurePct: 0,
      priceChange5mPct: 0,
      priceChange1hPct: 0,
      turnover5m: 0,
      socialCount: 0,
      isBoosted: false,
      pairAgeSeconds: undefined,
      hasPair: false,
    };
  }

  public static async getTokenMarketData(mint: string, reserveFloor = 0): Promise<DexScreenerData> {
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.data;
    }

    // Collapse concurrent requests for the same mint into one network call.
    const existing = this.inflight.get(mint);
    if (existing) return existing;

    // Rate limited: serve stale data rather than going blind or hammering the API.
    if (!this.tryConsume(reserveFloor)) {
      return cached ? cached.data : this.empty(mint);
    }

    const promise = this.fetch(mint)
      .then((data) => {
        this.cache.set(mint, { data, fetchedAt: Date.now() });
        return data;
      })
      .catch(() => (cached ? cached.data : this.empty(mint)))
      .finally(() => {
        this.inflight.delete(mint);
      });

    this.inflight.set(mint, promise);
    return promise;
  }

  /**
   * Batch lookup. The DexScreener token endpoint accepts up to 30 comma-separated
   * mints per request, so monitoring N positions costs ceil(N/30) requests per
   * tick instead of N.
   *
   * With 40 open positions on a 2s loop that is the difference between 1,200
   * req/min (instantly rate-limited and flying blind) and 60.
   */
  public static async getManyTokenMarketData(mints: string[]): Promise<Map<string, DexScreenerData>> {
    const out = new Map<string, DexScreenerData>();
    const now = Date.now();
    const misses: string[] = [];

    for (const mint of new Set(mints)) {
      const cached = this.cache.get(mint);
      if (cached && now - cached.fetchedAt < this.ttlMs) {
        out.set(mint, cached.data);
      } else {
        misses.push(mint);
      }
    }

    for (let i = 0; i < misses.length; i += this.BATCH_SIZE) {
      const chunk = misses.slice(i, i + this.BATCH_SIZE);

      // One token from the bucket per HTTP request, not per mint.
      if (!this.tryConsume()) {
        for (const mint of chunk) {
          const cached = this.cache.get(mint);
          out.set(mint, cached ? cached.data : this.empty(mint));
        }
        continue;
      }

      const grouped = await this.fetchBatch(chunk);
      if (!grouped) {
        // Transport failure — the API said nothing about these mints. Serve
        // stale cache instead of overwriting good data with zeros: a single
        // transient error here used to feed price 0 / hasPair false into the
        // exit logic of EVERY open position at once.
        for (const mint of chunk) {
          const cached = this.cache.get(mint);
          out.set(mint, cached ? cached.data : this.empty(mint));
        }
        continue;
      }
      for (const mint of chunk) {
        const data = grouped.get(mint) ?? this.empty(mint);
        this.cache.set(mint, { data, fetchedAt: Date.now() });
        out.set(mint, data);
      }
    }

    return out;
  }

  /** @returns null on transport failure (callers keep stale data); a map on success. */
  private static async fetchBatch(mints: string[]): Promise<Map<string, DexScreenerData> | null> {
    const grouped = new Map<string, DexScreenerData>();

    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`,
        {
          timeout: 8000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PumpFunTokenScreener/1.0'
          }
        }
      );

      const pairs = response.data?.pairs;
      if (!Array.isArray(pairs)) return grouped;

      // The batch response is a flat pair list across every requested token,
      // so bucket by base mint before picking each token's deepest pool.
      const byMint = new Map<string, any[]>();
      for (const pair of pairs) {
        const base = pair?.baseToken?.address;
        if (!base) continue;
        const bucket = byMint.get(base);
        if (bucket) bucket.push(pair);
        else byMint.set(base, [pair]);
      }

      for (const [mint, tokenPairs] of byMint) {
        tokenPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        grouped.set(mint, this.mapPair(mint, tokenPairs[0]));
      }
    } catch (error: any) {
      // Quiet by design — this runs on a loop; callers fall back to cache.
      return null;
    }

    return grouped;
  }

  private static async fetch(mint: string): Promise<DexScreenerData> {
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PumpFunTokenScreener/1.0'
        }
      });

      const pairs = response.data?.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return this.empty(mint);
      }

      // Deepest liquidity wins: that is the pool we would actually route through.
      pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      return this.mapPair(mint, pairs[0]);
    } catch (error: any) {
      // Quiet by design: this runs on a tight loop and a warn per position per
      // tick would drown the console during any transient outage.
      return this.empty(mint);
    }
  }

  /** Shared pair -> DexScreenerData mapping for both the single and batch paths. */
  private static mapPair(mint: string, bestPair: any): DexScreenerData {
      const buys5m = Number(bestPair.txns?.m5?.buys || 0);
      const sells5m = Number(bestPair.txns?.m5?.sells || 0);
      const totalTxns5m = buys5m + sells5m;
      const buyPressurePct = totalTxns5m > 0 ? (buys5m / totalTxns5m) * 100 : 0;

      const volume5mUsd = Number(bestPair.volume?.m5 || 0);
      const liquidityUsd = Number(bestPair.liquidity?.usd || 0);
      const turnover5m = liquidityUsd > 0 ? volume5mUsd / liquidityUsd : 0;

      const info = bestPair.info || {};
      const socialCount =
        (Array.isArray(info.socials) ? info.socials.length : 0) +
        (Array.isArray(info.websites) && info.websites.length > 0 ? 1 : 0);

      // Missing pairCreatedAt means age UNKNOWN. Defaulting it to 0 told the
      // playbook router this was a seconds-old pool and routed tokens of
      // unknown age straight into Play 3's "buy within 90s" window.
      const pairCreatedAt = Number(bestPair.pairCreatedAt || 0);
      const pairAgeSeconds = pairCreatedAt > 0 ? Math.floor((Date.now() - pairCreatedAt) / 1000) : undefined;

      return {
        mint,
        priceUsd: Number(bestPair.priceUsd || 0),
        volume5mUsd,
        volume1hUsd: Number(bestPair.volume?.h1 || 0),
        marketCapUsd: Number(bestPair.marketCap || bestPair.fdv || 0),
        fdvUsd: Number(bestPair.fdv || bestPair.marketCap || 0),
        liquidityUsd,
        buys5m,
        sells5m,
        buyPressurePct: Number(buyPressurePct.toFixed(1)),
        priceChange5mPct: Number(bestPair.priceChange?.m5 || 0),
        priceChange1hPct: Number(bestPair.priceChange?.h1 || 0),
        turnover5m: Number(turnover5m.toFixed(3)),
        socialCount,
        isBoosted: Number(bestPair.boosts?.active || 0) > 0,
        pairAgeSeconds,
        hasPair: true,
      };
  }

  /**
   * Live SOL price. The engine previously hardcoded $195, which silently skews
   * every USD-denominated size, PnL and bankroll figure as SOL moves.
   */
  public static async getSolPriceUsd(): Promise<number> {
    if (this.solPriceUsd > 0 && Date.now() - this.solPriceFetchedAt < 60000) {
      return this.solPriceUsd;
    }

    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`, {
        timeout: 5000,
        headers: { 'Accept': 'application/json' }
      });

      const pairs = response.data?.pairs;
      if (Array.isArray(pairs) && pairs.length > 0) {
        const stablePairs = pairs.filter((p: any) =>
          ['USDC', 'USDT'].includes(p.quoteToken?.symbol) && Number(p.liquidity?.usd || 0) > 100000
        );
        const pool = stablePairs.length > 0 ? stablePairs : pairs;
        pool.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

        const price = Number(pool[0].priceUsd || 0);
        if (price > 0) {
          this.solPriceUsd = price;
          this.solPriceFetchedAt = Date.now();
          return price;
        }
      }
    } catch (error: any) {
      // Fall through to the last known value.
    }

    return this.solPriceUsd;
  }
}
