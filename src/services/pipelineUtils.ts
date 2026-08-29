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
 * SOL out of a pump.fun bonding-curve SELL, the exact inverse of
 * bondingCurveTokensOut with the same 1% fee and the same floor-division
 * direction (which favours the curve, never us). Used to compute the
 * min_sol_output floor a local sell instruction carries.
 */
export function bondingCurveSolOut(
  tokensInRaw: bigint,
  vSolLamports: bigint,
  vTokensRaw: bigint,
  feeBps: bigint = 100n
): bigint {
  if (tokensInRaw <= 0n || vSolLamports <= 0n || vTokensRaw <= 0n) return 0n;
  const newVTokens = vTokensRaw + tokensInRaw;
  const newVSol = (vSolLamports * vTokensRaw) / newVTokens;
  const grossOut = vSolLamports - newVSol;
  return (grossOut * (10_000n - feeBps)) / 10_000n;
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
 * Entry size in SOL: the configured stake, scaled by the router's conviction
 * multiplier (1 unit or a half unit).
 *
 * All-in sizing was removed 2026-08-09. It staked the entire deployable balance
 * on every entry, which forced a one-position-at-a-time cap, made a single bad
 * fill a total loss, and repeatedly overdrafted its own transaction because the
 * order reserves stake x (1+slippage) plus fees. Position size is now the
 * operator's number and nothing else scales it.
 */
export function computeEntrySizeSol(params: {
  buyAmountSol: number;
  sizeMultiplier: number;
}): number {
  const { buyAmountSol, sizeMultiplier } = params;
  return buyAmountSol * sizeMultiplier;
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
 * Largest stake that still leaves room for the fees and slippage buffer, given
 * what the wallet can actually deploy. Kept as the affordability clamp on a
 * fixed stake — the operator's configured size is used unless the balance
 * cannot fund it.
 */
export function affordableStakeSol(
  requestedSol: number,
  availableSol: number,
  maxSlippagePct: number,
  priorityFeeSol: number
): number {
  const ceiling = maxAffordableBuySol(availableSol, maxSlippagePct, priorityFeeSol);
  return Math.min(requestedSol, ceiling);
}

/**
 * What the fee payer must keep AFTER a sell's fees: the ~0.00089 SOL
 * rent-exempt minimum for a system account, base signature fees, and a pad.
 * A transaction whose fees would leave the payer below rent exemption is not
 * rejected loudly — validators simply never include it, and the submitter
 * sees an endless confirmation timeout.
 */
export const FEE_PAYER_RESERVE_SOL = 0.001;

/**
 * Largest sell priority fee this wallet can actually pay and still land.
 *
 * Measured 2026-08-23: a wallet drained to 0.00162 SOL retried a 100% exit six
 * times at the configured 0.001 SOL priority fee, and every attempt timed out
 * — 0.00162 − 0.001005 in fees leaves 0.000615, below the rent-exempt
 * minimum, so no validator would include the transaction. The position was
 * stuck purely because the fee was too big for the wallet, and a smaller fee
 * would have landed. Never returns more than the configured fee; floors at
 * 0.00005 so a desperate exit is still attempted rather than refused (size
 * economics warn, never refuse — owner decision 2026-08-12).
 */
export function affordableSellPriorityFeeSol(balanceSol: number, configuredFeeSol: number): number {
  if (!isFinite(balanceSol) || balanceSol <= 0) return configuredFeeSol;
  const affordable = balanceSol - FEE_PAYER_RESERVE_SOL;
  if (affordable >= configuredFeeSol) return configuredFeeSol;
  return Math.max(0.00005, Math.floor(affordable * 1e6) / 1e6);
}

/**
 * Splits a run's deployable balance into N equal, independently survivable
 * slots — the owner's risk model: "if a trade goes to 0 it's fine", because a
 * dead slot costs 1/N of the run, never the wallet.
 *
 * `slotBudgetSol` is the ALL-IN allowance for one slot: the stake plus its own
 * slippage buffer, protocol fees, priority fee and rent. `stakePerSlotSol` is
 * what the order may actually ask for. Dividing the balance by N and staking
 * that directly would overdraft, because a buy reserves stake x (1 + slippage)
 * plus fees on top — the exact failure that made every all-in order fail
 * on-chain with "Transfer: insufficient lamports".
 *
 * The budget is snapshotted at arm time and NOT recomputed as the balance moves.
 * That is the point: a slot that goes to zero must not shrink the two beside it.
 */
export function splitWalletIntoSlots(params: {
  deployableSol: number;
  slots: number;
  maxSlippagePct: number;
  priorityFeeSol: number;
}): { slotBudgetSol: number; stakePerSlotSol: number } {
  const { deployableSol, slots, maxSlippagePct, priorityFeeSol } = params;
  if (!(deployableSol > 0) || !(slots >= 1)) return { slotBudgetSol: 0, stakePerSlotSol: 0 };
  const slotBudgetSol = deployableSol / slots;
  const stakePerSlotSol = maxAffordableBuySol(slotBudgetSol, maxSlippagePct, priorityFeeSol);
  return {
    slotBudgetSol: Number(slotBudgetSol.toFixed(6)),
    stakePerSlotSol,
  };
}

/**
 * Largest number of slots the wallet can actually fund ECONOMICALLY.
 *
 * Splitting into N slots divides the stake by N, and round-trip cost is
 * dominated by FIXED fees at small size — so past a point, adding a slot makes
 * every slot uneconomic and the bot refuses all of them. Measured on a 0.2 SOL
 * wallet: 1 slot is 5.67% round-trip, 2 slots is 8.45%, 3 slots is 11.33%,
 * against a 6% limit. Blindly using maxActivePositions there produces a bot
 * that screens forever and never trades.
 *
 * Returns 0 when even a single slot cannot clear the limit — the caller must
 * then refuse to arm rather than place a structurally losing trade.
 */
export function fitSlotsToWallet(params: {
  deployableSol: number;
  maxSlots: number;
  maxSlippagePct: number;
  priorityFeeSol: number;
  maxBreakevenPct: number;
  breakevenOf: (stakeSol: number, priorityFeeSol: number) => number;
}): { slots: number; stakePerSlotSol: number; breakevenPct: number } {
  const { deployableSol, maxSlots, maxSlippagePct, priorityFeeSol, maxBreakevenPct, breakevenOf } = params;
  // Prefer MORE slots (better diversification); step down only as economics force it.
  for (let n = Math.max(1, Math.floor(maxSlots)); n >= 1; n--) {
    const { stakePerSlotSol } = splitWalletIntoSlots({
      deployableSol, slots: n, maxSlippagePct, priorityFeeSol,
    });
    if (stakePerSlotSol <= 0) continue;
    const be = breakevenOf(stakePerSlotSol, priorityFeeSol);
    if (be <= maxBreakevenPct) return { slots: n, stakePerSlotSol, breakevenPct: be };
  }
  return { slots: 0, stakePerSlotSol: 0, breakevenPct: 0 };
}

/**
 * Smallest wallet balance that can fund `slots` economic positions.
 *
 * Inverts the breakeven identity. Round-trip cost is
 *   (stake * 0.03 + fixed) / stake, fixed = 2*priorityFee + 2*networkFee + ataRent
 * so the smallest viable stake is fixed / (limit - 0.03); below that no stake
 * can clear the limit at any balance. Each slot then needs its stake plus the
 * slippage/fee buffer, and the wallet needs the gas float on top.
 *
 * Returns Infinity when the limit is at or below the 3% variable cost — no
 * wallet size can help, because the variable component alone exceeds it.
 */
export function minWalletForSlots(params: {
  slots: number;
  maxSlippagePct: number;
  priorityFeeSol: number;
  maxBreakevenPct: number;
  gasFloatSol?: number;
}): number {
  const { slots, maxSlippagePct, priorityFeeSol, maxBreakevenPct, gasFloatSol = 0.005 } = params;
  const VARIABLE = 0.03;          // 1.5% protocol fee on each of two legs
  const NETWORK = 0.000005 * 2;
  const ATA_RENT = 0.00203928;
  const limit = maxBreakevenPct / 100;
  if (limit <= VARIABLE) return Infinity;

  const fixed = priorityFeeSol * 2 + NETWORK + ATA_RENT;
  const minStake = fixed / (limit - VARIABLE);
  const perSlot = minStake * (1 + maxSlippagePct / 100 + 0.015) + priorityFeeSol + 0.0025;
  return Number((perSlot * Math.max(1, slots) + gasFloatSol).toFixed(4));
}

/**
 * Maps a full-exit reason string to a structured ExitCode.
 *
 * Only used for the paths that close a whole position; the partial rungs pass
 * their code explicitly. Bucketing on the raw string is what produced 498
 * buckets for 10 real reasons, because the string interpolates dollar amounts.
 */
export function classifyExitReason(reason: string): import('../types').ExitCode {
  const r = (reason || '').toLowerCase();
  if (r.includes('honeypot')) return 'HONEYPOT';
  // Before every other bucket: a bad fill is an ENTRY failure, and filing it as
  // a structural or price exit would hide the fact that the loss was locked in
  // before the position ever traded.
  if (r.includes('bad fill')) return 'BAD_FILL';
  if (r.includes('structural stop')) return 'STRUCTURAL';
  if (r.includes('manual')) return 'MANUAL';
  if (r.includes('no market data')) return 'NO_DATA_STOP';
  if (r.includes('time stop') || r.includes('max hold time')) return 'TIME_STOP';
  // Before the trailing check: the trailing reason also mentions price, and a
  // price stop misfiled as a profit exit would corrupt every exit-mix report.
  if (r.includes('price stop')) return 'PRICE_STOP';
  // 'trailing', not 'trailing stop': the engine writes "trailing profit stop",
  // which this never matched — so every full trailing exit was filed UNKNOWN
  // and the exit-mix in run reports understated the profit ladder entirely.
  if (r.includes('trailing')) return 'TRAILING_FULL';
  if (r.includes('partial fill')) return 'PARTIAL_FILL';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Exit-policy predicates.
//
// The price stop-loss is OFF by default (config.exitOnPriceStop, added
// 2026-08-13 after being deleted outright on 2026-08-09). The loss side is
// carried by the structural predicates below plus the time stop. They live out
// here so the exit ladder is testable at all — before this it had zero
// coverage, which is how a trailing stop that forced exits BELOW round-trip
// breakeven survived as the bot's primary liquidator.
// ---------------------------------------------------------------------------

/**
 * Trailing-stop level, or undefined while the stop is not armed.
 *
 * The stop is a MOONBAG RATCHET, not a loss stop: it arms only once the peak
 * clears `armMultiple` x entry. The old 1.3x arm with a 20% give-back forced
 * exits at 1.04x entry — inside the 5.68% round-trip cost of a 0.3 SOL trade,
 * so it booked losses while claiming to protect profit. At 3.0x / 30% the
 * earliest possible exit is 2.1x.
 */
export function trailingStopTargetUsd(params: {
  highestPriceUsd: number;
  buyPriceUsd: number;
  armMultiple: number;
  trailingStopPct: number;
  useTrailingStop: boolean;
}): number | undefined {
  const { highestPriceUsd, buyPriceUsd, armMultiple, trailingStopPct, useTrailingStop } = params;
  if (!useTrailingStop) return undefined;
  if (!(buyPriceUsd > 0) || !(highestPriceUsd > 0)) return undefined;
  if (highestPriceUsd <= buyPriceUsd * armMultiple) return undefined;
  return highestPriceUsd * (1 - trailingStopPct / 100);
}

/**
 * Pool-drain structural exit: liquidity leaving is what actually makes a bag
 * unsellable, and unlike a price stop it cannot be tripped by volatility.
 * `minPeakUsd` keeps a thin or unindexed pool from tripping it on noise.
 */
export function isPoolDrained(params: {
  peakLiquidityUsd: number;
  currentLiquidityUsd: number;
  drainFraction: number;
  minPeakUsd?: number;
}): boolean {
  const { peakLiquidityUsd, currentLiquidityUsd, drainFraction, minPeakUsd = 2000 } = params;
  if (!(peakLiquidityUsd >= minPeakUsd)) return false;
  if (!(currentLiquidityUsd > 0)) return false;
  return currentLiquidityUsd <= peakLiquidityUsd * drainFraction;
}

/**
 * Whether a new price may raise the recorded peak.
 *
 * `highestPriceUsd` is monotonic and permanent once set, and the price feed
 * switches between the bonding curve, a DexScreener quote and marketCap/1e9
 * (which assumes a 1B supply and is 2x wrong for a 2B-supply token). One bad
 * high tick would otherwise anchor the trailing stop forever with no recovery
 * path, so an implausible single-tick spike is refused for peak purposes.
 */
export function acceptPeakUpdate(params: {
  candidatePriceUsd: number;
  prevPriceUsd: number;
  currentPeakUsd: number;
  maxTickRatio?: number;
}): boolean {
  const { candidatePriceUsd, prevPriceUsd, currentPeakUsd, maxTickRatio = 4 } = params;
  if (!(candidatePriceUsd > currentPeakUsd)) return false;
  if (prevPriceUsd > 0 && candidatePriceUsd / prevPriceUsd > maxTickRatio) return false;
  return true;
}
