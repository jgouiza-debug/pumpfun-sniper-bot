/**
 * The broker — deterministic authority over every lamport.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the model proposes, the broker disposes.
 * Nothing the model emits can raise a limit, name a mint the system did not
 * offer it, or bypass a breaker. Every cap below is a constant the model never
 * sees and cannot influence through any prompt path.
 *
 * Threat model — all three are live, not hypothetical:
 *  1. A hostile launch. Token name/description are attacker-authored and cost
 *     ~$2 to publish. A mint named to look like an instruction is a real, cheap
 *     attack. Defence: `mint` must equal the dossier's mint exactly. A model
 *     that has been talked into naming a different mint gets rejected here, not
 *     debated with.
 *  2. A confused or degraded model. Free-tier deprioritisation, a silent alias
 *     upgrade, a schema regression. Defence: caps are absolute, and conviction
 *     maps to size through a table the model cannot reach.
 *  3. A runaway loop. Defence: per-mint cooldown, open-position ceiling, daily
 *     spend ceiling and daily loss cap, all enforced before authorisation.
 *
 * This composes with, and does not replace, the existing pre-sign guard in
 * services/txIntentGuard.ts. That one validates transaction BYTES before
 * signing; this one validates the DECISION before a transaction is built. Both
 * fail closed.
 */

import { TradeIntent, Conviction } from './schema';

export interface BrokerLimits {
  /** Conviction -> position size in SOL. The model never sees these numbers. */
  sizeByConviction: Record<Conviction, number>;
  /** Absolute ceiling. No path may produce a size above this, ever. */
  maxPositionSol: number;
  /** Total SOL the agent may deploy in one UTC day. */
  dailySpendCapSol: number;
  /** Realised loss in SOL that halts the agent for the day. */
  dailyLossCapSol: number;
  /** Simultaneous open positions. */
  maxOpenPositions: number;
  /** Minimum ms between two buys of the same mint. */
  perMintCooldownMs: number;
  /** Minimum ms between any two buys. */
  globalCooldownMs: number;
  /** Consecutive broker/execution failures before the agent is halted. */
  maxConsecutiveFailures: number;
}

/**
 * Conservative by construction. These are experiment settings, not tuned
 * parameters — the point of the run is to find out whether the policy works,
 * and a size large enough to matter is a size large enough to end the run early.
 */
export const BROKER_DEFAULTS: BrokerLimits = {
  sizeByConviction: { LOW: 0.01, MEDIUM: 0.02, HIGH: 0.03 },
  maxPositionSol: 0.03,
  dailySpendCapSol: 0.3,
  dailyLossCapSol: 0.15,
  maxOpenPositions: 3,
  perMintCooldownMs: 6 * 60 * 60 * 1000,
  globalCooldownMs: 20_000,
  maxConsecutiveFailures: 5,
};

export interface BrokerState {
  utcDay: string;
  spentTodaySol: number;
  realisedPnlTodaySol: number;
  openPositions: number;
  lastBuyAtMs: number;
  lastBuyPerMint: Map<string, number>;
  consecutiveFailures: number;
  halted: boolean;
  haltReason: string | null;
}

export function newBrokerState(utcDay: string): BrokerState {
  return {
    utcDay,
    spentTodaySol: 0,
    realisedPnlTodaySol: 0,
    openPositions: 0,
    lastBuyAtMs: 0,
    lastBuyPerMint: new Map(),
    consecutiveFailures: 0,
    halted: false,
    haltReason: null,
  };
}

export type BrokerVerdict =
  | { authorized: true; mint: string; sizeSol: number; conviction: Conviction }
  | { authorized: false; reason: string };

function utcDayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The single authorisation point. Returns a size only when every check passes.
 *
 * `offeredMint` is the mint the SYSTEM built a dossier for — not anything the
 * model said. That asymmetry is the whole security model.
 */
export function authorize(
  intent: TradeIntent,
  offeredMint: string,
  state: BrokerState,
  limits: BrokerLimits,
  nowMs: number
): BrokerVerdict {
  // Day rollover resets spend and loss counters, never the halt flag: a halt is
  // a decision to stop, and rolling over midnight is not new information.
  const today = utcDayOf(nowMs);
  if (today !== state.utcDay) {
    state.utcDay = today;
    state.spentTodaySol = 0;
    state.realisedPnlTodaySol = 0;
  }

  if (state.halted) return { authorized: false, reason: `halted:${state.haltReason}` };
  if (intent.action !== 'BUY') return { authorized: false, reason: 'skip' };

  // Defence 1: the model may only act on what it was shown.
  if (intent.mint !== offeredMint) {
    return { authorized: false, reason: 'mint_mismatch' };
  }

  if (state.consecutiveFailures >= limits.maxConsecutiveFailures) {
    state.halted = true;
    state.haltReason = 'consecutive_failures';
    return { authorized: false, reason: 'halted:consecutive_failures' };
  }
  if (state.realisedPnlTodaySol <= -limits.dailyLossCapSol) {
    state.halted = true;
    state.haltReason = 'daily_loss_cap';
    return { authorized: false, reason: 'halted:daily_loss_cap' };
  }
  if (state.openPositions >= limits.maxOpenPositions) {
    return { authorized: false, reason: 'max_open_positions' };
  }
  if (nowMs - state.lastBuyAtMs < limits.globalCooldownMs) {
    return { authorized: false, reason: 'global_cooldown' };
  }
  const lastForMint = state.lastBuyPerMint.get(intent.mint) ?? 0;
  if (nowMs - lastForMint < limits.perMintCooldownMs) {
    return { authorized: false, reason: 'per_mint_cooldown' };
  }

  // Defence 2: size comes from the table, clamped. The model chose a bucket, not
  // a number, and even the bucket cannot exceed the absolute ceiling.
  const sizeSol = Math.min(
    limits.sizeByConviction[intent.conviction],
    limits.maxPositionSol
  );
  if (!(sizeSol > 0)) return { authorized: false, reason: 'bad_size' };

  if (state.spentTodaySol + sizeSol > limits.dailySpendCapSol) {
    return { authorized: false, reason: 'daily_spend_cap' };
  }

  return { authorized: true, mint: intent.mint, sizeSol, conviction: intent.conviction };
}

/** Call after a buy is actually placed (paper or live). */
export function recordBuy(state: BrokerState, mint: string, sizeSol: number, nowMs: number): void {
  state.spentTodaySol += sizeSol;
  state.openPositions += 1;
  state.lastBuyAtMs = nowMs;
  state.lastBuyPerMint.set(mint, nowMs);
  state.consecutiveFailures = 0;
}

/** Call when a position closes. `pnlSol` is realised, net of all fees. */
export function recordClose(state: BrokerState, pnlSol: number): void {
  state.openPositions = Math.max(0, state.openPositions - 1);
  state.realisedPnlTodaySol += pnlSol;
}

export function recordFailure(state: BrokerState): void {
  state.consecutiveFailures += 1;
}
