/**
 * The agent's exit policy — deterministic, pure, and hold-biased by construction.
 *
 * THE LOAD-BEARING PROPERTY: there is no price-only exit in this file. Not a
 * toggle defaulted off — ABSENT. Every downside action requires structural
 * evidence about the token (authority regained, sell path reverts, liquidity
 * pulled in a step, dev dumped) or elapsed time. You cannot enable a stop-loss
 * here by editing config, because there is no branch to enable. This is enforced
 * by a proof in src/tests/agentExitProofs.ts that drives a monotonically falling
 * price from entry to -95% with no structural signal and asserts NO action is
 * ever returned.
 *
 * The profit rungs are UPSIDE-ONLY: each is gated on `priceUsd >= entry * mult`,
 * so a rung can never fire into a loss, and rungs are latched so a round trip
 * through a multiple cannot sell twice.
 *
 * WHY A LADDER AND NOT A MODEL: polling the model per open position costs 12+
 * calls/hour/position against a 1500 RPD free tier, and — measured in the
 * competing design — a ~2% spurious-EXIT rate over 40 reviews closes a position
 * by noise more than half the time. That is a stop-loss with a random period,
 * invisible and untoggleable. The model instead makes ONE exit-shaped decision,
 * at entry, choosing only how much comes off on the way UP.
 *
 * Pure function of (ledger, now, config). No I/O, no clock of its own, no engine
 * access. Replayable against recorded ledgers.
 */

import { Conviction } from './schema';

export type ExitShape = 'SCALP' | 'BALANCED' | 'RUNNER';

export type ExitTrigger =
  | 'AGENT_RUNG'
  | 'AGENT_HONEYPOT'
  | 'AGENT_AUTHORITY_REGAINED'
  | 'AGENT_POOL_DRAIN'
  | 'AGENT_CURVE_DRAIN'
  | 'AGENT_DEV_SELL'
  | 'AGENT_MAX_HOLD';

export interface ExitAction {
  kind: 'SCALE' | 'CLOSE';
  /** Fraction of the ORIGINAL position to sell, 0..1. CLOSE always sells the remainder. */
  pct: number;
  trigger: ExitTrigger;
  reason: string;
  exitCode: string;
  /** RED triggers pass force=true so a latched sellRetryAfterMs cannot mute them. */
  force: boolean;
}

/**
 * Structural evidence about the token. Every field is tri-state on purpose:
 * `null` means THE SENSOR DID NOT REPORT, and must never be read as a verdict.
 * A dropped Helius subscription and a healthy token look identical otherwise.
 */
export interface Evidence {
  /** honeypotDetector.simulateSellPath: exactly false = reverts. null = could not determine. */
  sellPathReverts: boolean | null;
  /** Mint or freeze authority became non-null having been null at entry. */
  authorityRegained: boolean | null;
  /** Post-migration LP removed as a step inside the pull window. */
  poolDrained: boolean | null;
  /** Pre-migration curve drained from peak. */
  curveDrained: boolean | null;
  /** Dev/creator sold. */
  devSold: boolean | null;
}

export const NO_EVIDENCE: Evidence = {
  sellPathReverts: null,
  authorityRegained: null,
  poolDrained: null,
  curveDrained: null,
  devSold: null,
};

export interface LadderRung {
  /** Fire when priceUsd >= entryPriceUsd * mult. Always > 1: rungs are upside-only. */
  mult: number;
  /** Fraction of the ORIGINAL position to sell at this rung. */
  pct: number;
}

/** Shapes differ ONLY in how much comes off on the way up. None touches the downside. */
export const LADDERS: Record<ExitShape, LadderRung[]> = {
  SCALP: [{ mult: 1.5, pct: 0.5 }, { mult: 2.5, pct: 0.25 }],
  BALANCED: [{ mult: 2.0, pct: 0.34 }, { mult: 4.0, pct: 0.33 }],
  RUNNER: [{ mult: 3.0, pct: 0.25 }, { mult: 8.0, pct: 0.25 }],
};

export interface ExitConfig {
  /** Per-trigger toggles. Aggressive ones default false. */
  honeypotExit: boolean;
  authorityExit: boolean;
  poolDrainExit: boolean;
  curveDrainScale: boolean;
  devSellExit: boolean;
  profitRungs: boolean;
  maxHoldExit: boolean;
  /** Never let a rung take the remainder below this fraction of the original. */
  moonbagFloor: number;
  /** Time backstop. Long by default — this is a backstop, not a strategy. */
  maxHoldMs: number;
  /** Fraction taken on the FIRST curve-drain trip. 0 disables the trigger entirely. */
  curveDrainFraction: number;
  /** Pin the shape, ignoring whatever the model chose. 'AUTO' honours the model. */
  shapeOverride: ExitShape | 'AUTO';
}

export const EXIT_DEFAULTS: ExitConfig = {
  honeypotExit: true,
  authorityExit: true,
  poolDrainExit: true,
  curveDrainScale: true,
  devSellExit: false,
  profitRungs: true,
  maxHoldExit: true,
  moonbagFloor: 0.2,
  maxHoldMs: 6 * 60 * 60 * 1000,
  curveDrainFraction: 0.5,
  // Pinned for the first measurement window: the model's exit influence is inert
  // until the entry dossier is rich enough for the shape choice to mean anything.
  shapeOverride: 'BALANCED',
};

export interface PositionLedger {
  positionId: string;
  mint: string;
  shape: ExitShape;
  conviction: Conviction;
  /** Immutable. Set once at fill. Every rung is measured against this. */
  entryPriceUsd: number;
  entryAtMs: number;
  /** Fraction of the original still held, 0..1. */
  remainingFraction: number;
  /** Indices of rungs already taken. Latched: a round trip cannot re-fire one. */
  rungsTaken: number[];
  /** Latch so curve drain scales once, then only escalates on a distinct RED. */
  curveDrainScaleTaken: boolean;
  /** Count of structurally distinct RED signals seen. */
  redCount: number;
}

export function resolveShape(modelShape: ExitShape, cfg: ExitConfig): ExitShape {
  return cfg.shapeOverride === 'AUTO' ? modelShape : cfg.shapeOverride;
}

/**
 * The single exit decision point.
 *
 * Order matters and is deliberate: RED evidence outranks profit taking, because
 * a token that cannot be sold is worth more gone at any price than held for a
 * rung it will never reach. Within RED, the unrecoverable conditions come first.
 *
 * Returns null for "do nothing", which is the correct answer to a falling price.
 */
export function nextExitAction(
  ledger: PositionLedger,
  priceUsd: number | null,
  ev: Evidence,
  cfg: ExitConfig,
  nowMs: number
): ExitAction | null {
  if (ledger.remainingFraction <= 0) return null;

  const closeAll = (trigger: ExitTrigger, reason: string, exitCode: string): ExitAction => ({
    kind: 'CLOSE',
    pct: ledger.remainingFraction,
    trigger,
    reason,
    exitCode,
    force: true,
  });

  // ---- RED: structural evidence. Note every check is `=== true`. A null sensor
  // is silence, and silence is never a verdict. ----

  if (cfg.honeypotExit && ev.sellPathReverts === true) {
    return closeAll('AGENT_HONEYPOT', 'sell simulation reverts — position cannot be exited normally', 'AGENT_HONEYPOT');
  }

  if (cfg.authorityExit && ev.authorityRegained === true) {
    return closeAll('AGENT_AUTHORITY_REGAINED', 'mint or freeze authority regained after entry', 'AGENT_STRUCTURAL');
  }

  if (cfg.poolDrainExit && ev.poolDrained === true) {
    return closeAll('AGENT_POOL_DRAIN', 'liquidity removed in a single step', 'AGENT_STRUCTURAL');
  }

  if (cfg.devSellExit && ev.devSold === true) {
    return closeAll('AGENT_DEV_SELL', 'creator sold', 'AGENT_STRUCTURAL');
  }

  // Curve drain is deliberately WEAKER than the others: realSolInCurve is a
  // monotone transform of price, so treating it as a full-exit signal would
  // smuggle a price stop in through the back door. First trip scales, and only a
  // structurally DISTINCT second red escalates to a close.
  if (cfg.curveDrainScale && cfg.curveDrainFraction > 0 && ev.curveDrained === true) {
    if (!ledger.curveDrainScaleTaken) {
      const pct = Math.min(cfg.curveDrainFraction, ledger.remainingFraction);
      return {
        kind: 'SCALE',
        pct,
        trigger: 'AGENT_CURVE_DRAIN',
        reason: `curve drained from peak — scaling ${Math.round(pct * 100)}%`,
        exitCode: 'AGENT_STRUCTURAL',
        force: true,
      };
    }
    if (ledger.redCount >= 2) {
      return closeAll('AGENT_CURVE_DRAIN', 'curve drained and a second structural signal confirmed', 'AGENT_STRUCTURAL');
    }
  }

  // ---- Time backstop. Not a stop-loss: it fires regardless of P&L, and only
  // after a window long enough that it is an inventory rule, not a risk rule. ----
  if (cfg.maxHoldExit && nowMs - ledger.entryAtMs >= cfg.maxHoldMs) {
    return closeAll('AGENT_MAX_HOLD', `max hold ${Math.round(cfg.maxHoldMs / 3_600_000)}h reached`, 'AGENT_TIME');
  }

  // ---- Profit rungs. Upside-only and latched. ----
  if (!cfg.profitRungs || priceUsd === null || !(ledger.entryPriceUsd > 0)) return null;

  const rungs = LADDERS[ledger.shape];
  const mult = priceUsd / ledger.entryPriceUsd;

  for (let i = 0; i < rungs.length; i++) {
    if (ledger.rungsTaken.includes(i)) continue;
    const r = rungs[i];
    // Upside-only: this is the guard that makes a price-driven SELL impossible
    // below entry. Nothing in this file sells because price fell.
    if (mult < r.mult) continue;

    const floorRemaining = cfg.moonbagFloor;
    const maxSellable = Math.max(0, ledger.remainingFraction - floorRemaining);
    const pct = Math.min(r.pct, maxSellable);
    if (pct <= 0) continue; // moonbag floor reached — hold the rest, forever if need be

    return {
      kind: 'SCALE',
      pct,
      trigger: 'AGENT_RUNG',
      reason: `rung ${i + 1} at ${r.mult}x (now ${mult.toFixed(2)}x) — taking ${Math.round(pct * 100)}%`,
      exitCode: 'AGENT_RUNG',
      force: false,
    };
  }

  return null;
}

/** Apply an executed action to the ledger. Call ONLY after the sell actually happened. */
export function applyExit(ledger: PositionLedger, action: ExitAction, rungIndex?: number): void {
  ledger.remainingFraction = Math.max(0, ledger.remainingFraction - action.pct);
  if (action.trigger === 'AGENT_RUNG' && rungIndex !== undefined) ledger.rungsTaken.push(rungIndex);
  if (action.trigger === 'AGENT_CURVE_DRAIN' && action.kind === 'SCALE') ledger.curveDrainScaleTaken = true;
}

/** Which rung a RUNG action corresponds to, for latching. */
export function rungIndexFor(ledger: PositionLedger, priceUsd: number): number | undefined {
  const rungs = LADDERS[ledger.shape];
  const mult = priceUsd / ledger.entryPriceUsd;
  for (let i = 0; i < rungs.length; i++) {
    if (!ledger.rungsTaken.includes(i) && mult >= rungs[i].mult) return i;
  }
  return undefined;
}

/** Count structurally distinct RED signals currently live. */
export function countReds(ev: Evidence): number {
  return [ev.sellPathReverts, ev.authorityRegained, ev.poolDrained, ev.devSold]
    .filter((v) => v === true).length;
}
