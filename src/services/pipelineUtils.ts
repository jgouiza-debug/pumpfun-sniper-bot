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
