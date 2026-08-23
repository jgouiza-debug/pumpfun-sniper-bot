/**
 * Pure classification of a leader wallet's transaction — the part of the
 * on-chain watcher that decides whether a balance change is a TRADE worth
 * mirroring or a TRANSFER that must be ignored, what it was worth, and on
 * which venue. Extracted from copyTraderService so the cases that were wrong
 * on 2026-08-23 have tests that can fail:
 *
 *  - tokens arriving with no SOL leaving (an airdrop, a dust attack, a bag
 *    moved between the leader's own wallets) read as a BUY, and the copy
 *    trader bought them;
 *  - tokens leaving with no SOL arriving (moving a bag to another wallet)
 *    read as a SELL, and with copy-sells live the copy trader dumped ours;
 *  - the leader's SOL delta included the network fee and ATA rent, so the
 *    "price" of a small buy was inflated by several percent.
 */

/** Program ids that identify the venue a swap executed on, in PumpPortal's pool vocabulary. */
export const VENUE_PROGRAMS: ReadonlyArray<readonly [string, string]> = [
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pump'],         // pump.fun bonding curve
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pump-amm'],     // PumpSwap AMM (post-graduation)
  ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'launchlab'],    // Raydium LaunchLab (bonk.fun)
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'raydium-cpmm'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'raydium'],     // Raydium AMM v4
];

/** First venue program present among a transaction's account keys; undefined for an unknown venue or a plain transfer. */
export function detectVenue(accountKeys: readonly string[]): string | undefined {
  const present = new Set(accountKeys);
  for (const [program, pool] of VENUE_PROGRAMS) {
    if (present.has(program)) return pool;
  }
  return undefined;
}

/**
 * Below this much SOL moving against the tokens, a balance change is a
 * transfer, not a trade. The buy side sits above ATA rent (0.00204) plus
 * fees — what merely RECEIVING tokens can cost without buying any.
 */
export const TRADE_MIN_SOL_BUY = 0.003;
export const TRADE_MIN_SOL_SELL = 0.0005;

export type FlowKind = 'trade' | 'transfer';

export function classifyFlow(p: {
  side: 'buy' | 'sell';
  /** SOL that moved against the tokens, net of network fee. */
  tradeSol: number;
  /** A known DEX program was invoked — a trade however small. */
  venueKnown: boolean;
  /** Leg of a token→token swap — no SOL by nature. */
  isTokenSwap: boolean;
}): FlowKind {
  if (p.isTokenSwap || p.venueKnown) return 'trade';
  const min = p.side === 'buy' ? TRADE_MIN_SOL_BUY : TRADE_MIN_SOL_SELL;
  return p.tradeSol > min ? 'trade' : 'transfer';
}

/**
 * The leader's native SOL flow in SOL, with the network fee added back when
 * they were the fee payer (always account 0 of the message). The fee is the
 * network's cut, not part of the trade — on a 0.05 SOL buy it is a visible
 * slice of the "price".
 */
export function netSolFlowSol(preLamports: number, postLamports: number, feeLamports: number, isFeePayer: boolean): number {
  const delta = postLamports - preLamports;
  return (isFeePayer ? delta + feeLamports : delta) / 1e9;
}

/**
 * Paper exit price: the leader's realized price when the signal carried one
 * (it is the price that actually printed), else the freshest price we hold;
 * haircut for slippage either way.
 */
export function paperExitPrice(leaderPriceSol: number | undefined, currentPriceSol: number, haircutPct: number): number {
  const base = leaderPriceSol !== undefined && isFinite(leaderPriceSol) && leaderPriceSol > 0
    ? leaderPriceSol
    : currentPriceSol;
  return base * (1 - haircutPct / 100);
}

/**
 * Mints that are never a memecoin trade: stablecoins, liquid-staked SOL and
 * wrapped majors. A leader wallet that is also a market maker or an arbitrage
 * bot swaps through these constantly — measured 2026-08-23 on a tracked
 * wallet: 210 copied "buys" of USDC in two minutes, each of which is a real,
 * fee-paying order in real mode. (WSOL is folded into the SOL side upstream
 * and never reaches here.)
 */
export const NON_MEME_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Portal)
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',  // cbBTC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Portal)
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
]);

export function isCopyableMint(mint: string): boolean {
  return !NON_MEME_MINTS.has(mint);
}

/**
 * Venues PumpPortal's trade endpoint can execute on — the only ones worth
 * copying a BUY from. A leader buying on Orca or Meteora (no program we
 * recognise in the transaction) cannot be followed by this executor, and
 * pretending otherwise produced orders routed to 'auto' for tokens it had no
 * pool for.
 */
export const EXECUTABLE_VENUES: ReadonlySet<string> = new Set([
  'pump', 'pump-amm', 'launchlab', 'raydium', 'raydium-cpmm', 'bonk',
]);

export function isExecutableVenue(pool: string | undefined): boolean {
  return pool !== undefined && EXECUTABLE_VENUES.has(pool);
}
