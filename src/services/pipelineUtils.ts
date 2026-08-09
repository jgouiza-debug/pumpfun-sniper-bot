/**
 * Pure, engine-free helpers for the hot path. Extracted from SniperEngine so
 * unit tests can exercise them (including the failing cases that prove the old
 * bugs) without booting the singleton engine, its intervals, or the wallet.
 */

/**
 * Age of a launch in seconds at processing time.
 *
 * Replaces the legacy expression
 *   Math.floor((Date.now() - (payload.timestamp || Date.now())) / 1000) || 120
 * which had two defects, both measured live on 2026-08-04:
 *  - PumpPortal `subscribeNewToken` payloads carry NO `timestamp` field at all,
 *    so the inner expression was always ~0 and the trailing `|| 120` promoted
 *    every fresh token to "120 seconds old". That made the caller's
 *    skip-DexScreener-under-45s branch dead code: ~52 wasted lookups/min.
 *  - Even with a timestamp, a genuinely 0-second-old token hit `0 || 120`.
 *
 * Accepts seconds or milliseconds since epoch; absent/invalid means "just
 * born" (0s), never a fabricated 120s.
 */
export function computeAgeSeconds(payloadTimestamp: unknown, nowMs: number = Date.now()): number {
  const raw = Number(payloadTimestamp);
  if (!isFinite(raw) || raw <= 0) return 0;
  const tsMs = raw < 1e12 ? raw * 1000 : raw; // heuristic: seconds vs ms epoch
  return Math.max(0, Math.floor((nowMs - tsMs) / 1000));
}

/**
 * Migration detection.
 *
 * strict=true: only a real PumpPortal migration event counts.
 * strict=false preserves legacy behavior: `bondingProgress >= 70` (a field
 * PumpPortal never sends — measured) and `vSolInBondingCurve >= 70`, which
 * mislabels a fresh create with a large dev buy as a migration. Under the
 * legacy gate a "migration" is assigned fabricated $12k liquidity and
 * auto-passes strict mode, so the mislabel converts straight into a buy.
 */
export function detectMigration(
  payload: { txType?: string; bondingProgress?: number; vSolInBondingCurve?: number },
  strict: boolean
): boolean {
  if (payload.txType === 'migrate') return true;
  if (strict) return false;
  return (payload.bondingProgress ?? 0) >= 70 || (payload.vSolInBondingCurve ?? 0) >= 70;
}

/**
 * Realized PnL over a trailing window. Positive = net profit. Used by the
 * kill switch: trades outside the window are ignored.
 */
export function realizedPnlInWindowUsd(
  trades: Array<{ exitTime: number; pnlUsd: number }>,
  windowMs: number,
  nowMs: number = Date.now()
): number {
  const cutoff = nowMs - windowMs;
  let sum = 0;
  for (const t of trades) {
    if (t.exitTime >= cutoff) sum += t.pnlUsd;
  }
  return sum;
}

/** Percentile over a numeric array (nearest-rank). Returns 0 for empty input. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * pump.fun bonding-curve buy estimate: tokens out for `solInLamports` spent,
 * given current virtual reserves, with the program's 1% fee taken on the SOL
 * side. Constant-product on virtual reserves:
 *   out = vTokens - (vSol * vTokens) / (vSol + in_after_fee)
 * All BigInt — token amounts are 6dp raw units, SOL is lamports; floats lose
 * integer precision above 2^53 which vTokens raw units exceed.
 */
export function bondingCurveTokensOut(
  solInLamports: bigint,
  vSolLamports: bigint,
  vTokensRaw: bigint,
  feeBps: bigint = 100n
): bigint {
  if (solInLamports <= 0n || vSolLamports <= 0n || vTokensRaw <= 0n) return 0n;
  const inAfterFee = (solInLamports * (10_000n - feeBps)) / 10_000n;
  const newVSol = vSolLamports + inAfterFee;
  const newVTokens = (vSolLamports * vTokensRaw) / newVSol; // floor division favors the curve
  return vTokensRaw - newVTokens;
}

/**
 * Clamp a computed priority fee: never below the configured static floor,
 * never above the hard ceiling nor `positionPct` percent of the position.
 */
export function clampPriorityFeeSol(
  computedSol: number,
  floorSol: number,
  ceilingSol: number,
  positionSol: number,
  positionPct: number = 5
): number {
  const positionCap = positionSol * (positionPct / 100);
  const clamped = Math.max(floorSol, Math.min(computedSol, ceilingSol, positionCap));
  // Round to lamport-representable precision so float artifacts (0.05*0.05 =
  // 0.0025000000000000005) never leak into fee fields.
  return Number(clamped.toFixed(9));
}

/**
 * Largest buy that can actually land on-chain out of `availableSol`.
 *
 * A PumpPortal buy transaction reserves amount × (1 + slippage) lamports up
 * front (measured from a failed all-in buy: the System transfer wanted exactly
 * 1.15× the amount at 15% slippage), plus ~1.5% protocol fees (pump.fun 1% +
 * PumpPortal 0.5%), the priority fee, base signature fees and token-account
 * rent. Sizing a buy to the raw balance therefore guarantees an on-chain
 * "Transfer: insufficient lamports" failure that still burns the fee.
 */
export function maxAffordableBuySol(
  availableSol: number,
  maxSlippagePct: number,
  priorityFeeSol: number
): number {
  // Base fees (~0.00001) + ATA rent (~0.00204) + safety pad.
  const FIXED_OVERHEAD_SOL = 0.0025;
  const PROTOCOL_FEE_FRACTION = 0.015;
  const spendable = availableSol - priorityFeeSol - FIXED_OVERHEAD_SOL;
  if (spendable <= 0) return 0;
  const size = spendable / (1 + maxSlippagePct / 100 + PROTOCOL_FEE_FRACTION);
  // Round down to a microlamport-safe 6 decimals — never up, toward overdraft.
  return Math.max(0, Math.floor(size * 1e6) / 1e6);
}

/**
 * Computes entry size in SOL based on allInSizing flag, tradingMode, and wallet/bankroll state.
 */
export function computeEntrySizeSol(params: {
  allIn: boolean;
  tradingMode: 'paper' | 'real';
  buyAmountSol: number;
  sizeMultiplier: number;
  availableTradeSol: number;
  bankrollUsd: number;
  solPriceUsd: number;
  openExposureSol: number;
  maxSlippagePct: number;
  priorityFeeSol: number;
}): number {
  const {
    allIn,
    tradingMode,
    buyAmountSol,
    sizeMultiplier,
    availableTradeSol,
    bankrollUsd,
    solPriceUsd,
    openExposureSol,
    maxSlippagePct,
    priorityFeeSol,
  } = params;

  if (!allIn) {
    return buyAmountSol * sizeMultiplier;
  }

  if (tradingMode === 'real') {
    return maxAffordableBuySol(availableTradeSol, maxSlippagePct, priorityFeeSol);
  }

  // Paper mode all-in: full bankroll converted to SOL minus active open position SOL exposure
  const solPrice = solPriceUsd > 0 ? solPriceUsd : 200;
  const totalBankrollSol = bankrollUsd / solPrice;
  return Math.max(0, totalBankrollSol - openExposureSol);
}

/**
 * PumpPortal `amount` for a SELL, as a percentage-of-holdings string.
 *
 * PumpPortal reads a trailing '%' as "this share of the wallet balance"; a bare
 * number is a literal token count. Stripping the '%' therefore turned
 * "sell 100%" into "sell 100 tokens" — measured 2026-08-09 on $GREEN: the
 * wallet held 2206.04 tokens, the exit order moved exactly 100.00, and the
 * engine still booked the position as fully closed at -96.8%.
 */
export function sellAmountParam(amountPct?: string | number): string {
  const raw = String(amountPct ?? '100').trim();
  const numeric = Number(raw.replace('%', ''));
  if (!isFinite(numeric) || numeric <= 0) return '100%';
  return `${Math.min(100, numeric)}%`;
}

/**
 * Returns true if an all-in entry should be blocked because a position is open or in-flight.
 */
export function blockAllInEntry(openCount: number, buysInFlight: number): boolean {
  return openCount > 0 || buysInFlight > 0;
}

/**
 * Returns true if a signal is full conviction (sizeMultiplier >= 1).
 * Borderline / half-unit signals (sizeMultiplier < 1) return false.
 */
export function isFullConviction(sizeMultiplier: number): boolean {
  return sizeMultiplier >= 1;
}
