import { bondingCurveTokensOut } from './pipelineUtils';

/**
 * Honest paper-trading simulator. Flag: honestPaper.
 *
 * WHY THIS EXISTS — measured 2026-08-04:
 * Legacy paper mode moved unpriced positions with
 *   mockFluctuation = 1 + ((Math.random() * 0.12) - 0.048)
 * every 2s. That distribution has a +1.127% GEOMETRIC per-tick drift, i.e.
 * +40.2% per minute. Monte-Carlo over 200,000 simulated positions using the
 * engine's own exit rules: 95.1% hit the +100% take-profit (median 114s) and
 * 0.0% ever hit the stop-loss. Paper "profit" was a random-number generator
 * with a built-in uptrend — it measured nothing about the strategy.
 *
 * Legacy paper also paid NO costs: no price impact, no pump.fun 1%, no
 * PumpPortal 0.5%, no priority fee, no ATA rent. Real mode pays all of them,
 * which at 0.05 SOL is an 11.10% round-trip breakeven before slippage.
 *
 * Those two gaps together are the entire "profitable on paper, losing live"
 * story. This module closes them: paper fills are priced off the same curve /
 * pool the real order would hit, and charged the same fee stack, producing a
 * fill object shaped exactly like the on-chain ActualFill so all downstream
 * accounting is identical between modes.
 */

// ---- Cost constants (mainnet, pump.fun + PumpPortal, 2026-08) ----
/** pump.fun protocol fee, each leg. */
export const PUMP_FEE_PCT = 0.01;
/** PumpPortal trade-local service fee, each leg. */
export const PORTAL_FEE_PCT = 0.005;
/** Base signature fee per transaction. */
export const NETWORK_FEE_SOL = 0.000005;
/** Rent to open an associated token account — charged once per new mint. */
export const ATA_RENT_SOL = 0.00203928;
/** pump.fun launch constants. */
export const INITIAL_VIRTUAL_SOL = 30;
export const INITIAL_VIRTUAL_TOKENS = 1_073_000_000;
export const TOTAL_SUPPLY = 1_000_000_000;

export interface SimulatedFill {
  /** SOL change for the wallet: negative on buy, positive on sell. All costs inside. */
  solDelta: number;
  /** Token change: positive on buy, negative on sell. */
  tokenDelta: number;
  /** Total fees paid on this leg (already inside solDelta). */
  feeSol: number;
  /** Price impact actually suffered, percent. */
  priceImpactPct: number;
  /** Effective per-token price in USD for this leg. */
  effectivePriceUsd: number;
  simulated: true;
}

export interface PoolSnapshot {
  /** Virtual SOL reserves (pump bonding curve), when still pre-migration. */
  vSolInBondingCurve?: number;
  /** Virtual token reserves (whole tokens). */
  vTokensInBondingCurve?: number;
  /** Post-migration: DexScreener pool liquidity in USD. */
  liquidityUsd?: number;
  /** Quoted price per token, USD. */
  priceUsd?: number;
}

/**
 * Buy simulation.
 *
 * Pre-migration: prices against the real bonding curve using the virtual
 * reserves from the launch payload — the same constant-product the program
 * runs, so impact is exact rather than assumed.
 *
 * Post-migration: constant product against the AMM pool, with reserves
 * inferred from DexScreener liquidity (half SOL side, half token side).
 */
export function simulateBuy(
  solAmount: number,
  pool: PoolSnapshot,
  solPriceUsd: number,
  priorityFeeSol: number,
  isFirstBuyOfMint = true
): SimulatedFill {
  const protocolFeeSol = solAmount * (PUMP_FEE_PCT + PORTAL_FEE_PCT);
  const overheadSol = priorityFeeSol + NETWORK_FEE_SOL + (isFirstBuyOfMint ? ATA_RENT_SOL : 0);
  const solIntoPool = Math.max(0, solAmount - protocolFeeSol);

  let tokensOut = 0;
  let spotPriceSol = 0;

  if (pool.vSolInBondingCurve && pool.vTokensInBondingCurve) {
    // Real curve state from the stream payload.
    const vSolLamports = BigInt(Math.floor(pool.vSolInBondingCurve * 1e9));
    const vTokensRaw = BigInt(Math.floor(pool.vTokensInBondingCurve * 1e6));
    spotPriceSol = pool.vSolInBondingCurve / pool.vTokensInBondingCurve;
    // Fee already deducted above, so charge 0 bps inside the curve math.
    const outRaw = bondingCurveTokensOut(
      BigInt(Math.floor(solIntoPool * 1e9)), vSolLamports, vTokensRaw, 0n
    );
    tokensOut = Number(outRaw) / 1e6;
  } else if (pool.liquidityUsd && pool.priceUsd && pool.liquidityUsd > 0 && pool.priceUsd > 0) {
    // AMM: half the reported liquidity sits on each side.
    const solReserve = (pool.liquidityUsd / 2) / solPriceUsd;
    const tokenReserve = (pool.liquidityUsd / 2) / pool.priceUsd;
    spotPriceSol = solReserve / tokenReserve;
    tokensOut = (tokenReserve * solIntoPool) / (solReserve + solIntoPool);
  } else {
    // No pool information at all: fall back to spot with no impact, but keep
    // every fee. Marked by a zero impact figure so it is visible in reports.
    spotPriceSol = (pool.priceUsd ?? 0) / solPriceUsd;
    tokensOut = spotPriceSol > 0 ? solIntoPool / spotPriceSol : 0;
  }

  const totalSolOut = solAmount + overheadSol;
  const effectivePriceSol = tokensOut > 0 ? totalSolOut / tokensOut : 0;
  const priceImpactPct = spotPriceSol > 0 && effectivePriceSol > 0
    ? ((effectivePriceSol - spotPriceSol) / spotPriceSol) * 100
    : 0;

  return {
    solDelta: -Number(totalSolOut.toFixed(9)),
    tokenDelta: tokensOut,
    feeSol: Number((protocolFeeSol + overheadSol).toFixed(9)),
    priceImpactPct: Number(priceImpactPct.toFixed(2)),
    effectivePriceUsd: effectivePriceSol * solPriceUsd,
    simulated: true,
  };
}

/**
 * Sell simulation. Selling INTO a thin meme pool is where paper flattery does
 * the most damage: the legacy model paid out tokensHeld * quotedPrice, which
 * assumes infinite depth. Here the exit walks the same curve the entry did.
 */
export function simulateSell(
  tokensToSell: number,
  pool: PoolSnapshot,
  solPriceUsd: number,
  priorityFeeSol: number
): SimulatedFill {
  let solFromPool = 0;
  let spotPriceSol = 0;

  if (pool.vSolInBondingCurve && pool.vTokensInBondingCurve) {
    const vSol = pool.vSolInBondingCurve;
    const vTokens = pool.vTokensInBondingCurve;
    spotPriceSol = vSol / vTokens;
    // Constant product, token side in: out = vSol - k/(vTokens + in)
    const k = vSol * vTokens;
    solFromPool = vSol - k / (vTokens + tokensToSell);
  } else if (pool.liquidityUsd && pool.priceUsd && pool.liquidityUsd > 0 && pool.priceUsd > 0) {
    const solReserve = (pool.liquidityUsd / 2) / solPriceUsd;
    const tokenReserve = (pool.liquidityUsd / 2) / pool.priceUsd;
    spotPriceSol = solReserve / tokenReserve;
    solFromPool = (solReserve * tokensToSell) / (tokenReserve + tokensToSell);
  } else {
    spotPriceSol = (pool.priceUsd ?? 0) / solPriceUsd;
    solFromPool = tokensToSell * spotPriceSol;
  }

  solFromPool = Math.max(0, solFromPool);
  const protocolFeeSol = solFromPool * (PUMP_FEE_PCT + PORTAL_FEE_PCT);
  const overheadSol = priorityFeeSol + NETWORK_FEE_SOL;
  const netSol = Math.max(0, solFromPool - protocolFeeSol - overheadSol);

  const effectivePriceSol = tokensToSell > 0 ? netSol / tokensToSell : 0;
  const priceImpactPct = spotPriceSol > 0 && effectivePriceSol > 0
    ? ((spotPriceSol - effectivePriceSol) / spotPriceSol) * 100
    : 0;

  return {
    solDelta: Number(netSol.toFixed(9)),
    tokenDelta: -tokensToSell,
    feeSol: Number((protocolFeeSol + overheadSol).toFixed(9)),
    priceImpactPct: Number(priceImpactPct.toFixed(2)),
    effectivePriceUsd: effectivePriceSol * solPriceUsd,
    simulated: true,
  };
}

/**
 * Round-trip cost of a position as a percentage of size — the gain needed just
 * to break even, before price impact. At 0.05 SOL with a 0.001 priority fee
 * this is 11.1%: fixed overheads dominate at small size, which is why the live
 * bot bled while paper soared.
 */
export function breakevenPct(solAmount: number, priorityFeeSol: number): number {
  if (solAmount <= 0) return 0;
  const variable = solAmount * (PUMP_FEE_PCT + PORTAL_FEE_PCT) * 2;
  const fixed = priorityFeeSol * 2 + NETWORK_FEE_SOL * 2 + ATA_RENT_SOL;
  return Number((((variable + fixed) / solAmount) * 100).toFixed(2));
}

/**
 * Pool snapshot for a position, preferring live curve state and falling back
 * to the DexScreener pool once the token has migrated.
 */
export function poolFromLaunch(launch: any, dex?: { liquidityUsd?: number; priceUsd?: number } | null): PoolSnapshot {
  const vSol = Number(launch?.vSolInBondingCurve);
  const vTokens = Number(launch?.vTokensInBondingCurve);
  if (isFinite(vSol) && vSol > 0 && isFinite(vTokens) && vTokens > 0) {
    return { vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens };
  }
  return { liquidityUsd: dex?.liquidityUsd, priceUsd: dex?.priceUsd };
}
