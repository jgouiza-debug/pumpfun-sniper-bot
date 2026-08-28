/**
 * Execution port — the seam between the agent's decisions and anything that
 * moves money.
 *
 * The agent loop never talks to a wallet, an RPC, or the sniper engine. It
 * talks to THIS interface. Two implementations exist or are planned:
 *
 *   - PaperPort (below): fills against the same bonding-curve arithmetic the
 *     engine's honest-paper mode uses — pump.fun's 1% fee, PumpPortal's 0.5%,
 *     network fee, ATA rent, real constant-product price impact. No network,
 *     no keys. This is the measurement vehicle.
 *
 *   - LiveEnginePort (deliberately NOT built yet): wraps the sniper engine's
 *     agent port once live mode is armed. Building it requires surgery on
 *     sniperEngine.ts's private sell path, and per the settled plan that
 *     surgery waits until the paper lane has produced 30 days of evidence.
 *     The interface is the contract that makes the swap a one-line change.
 *
 * Keeping the port pure also keeps the loop TESTABLE: proofs drive the whole
 * entry→ladder→exit cycle against PaperPort with a scripted price path.
 */

import {
  simulateBuy, simulateSell, poolFromLaunch, PoolSnapshot, SimulatedFill,
} from '../services/paperSimulator';

export interface FillResult {
  ok: boolean;
  reason?: string;
  /** SOL delta for the wallet (negative on buy). All costs inside. */
  solDelta?: number;
  tokenDelta?: number;
  feeSol?: number;
  priceImpactPct?: number;
  effectivePriceUsd?: number;
  txid?: string;
}

export interface ExecutionPort {
  readonly mode: 'paper' | 'live';
  buy(mint: string, solAmount: number, pool: PoolSnapshot, solPriceUsd: number): Promise<FillResult>;
  /** pct is the fraction of CURRENTLY HELD tokens to sell, 0..1. */
  sell(mint: string, pct: number, pool: PoolSnapshot, solPriceUsd: number): Promise<FillResult>;
  bankrollSol(): number;
}

/** Priority fee assumption for paper fills — matches the engine's small-wallet pin. */
const PAPER_PRIORITY_FEE_SOL = 0.001;

export class PaperPort implements ExecutionPort {
  public readonly mode = 'paper' as const;
  private bankroll: number;
  private held = new Map<string, number>(); // mint -> tokens

  constructor(startingSol = 1.0) {
    this.bankroll = startingSol;
  }

  public bankrollSol(): number { return this.bankroll; }
  public tokensHeld(mint: string): number { return this.held.get(mint) ?? 0; }

  public async buy(mint: string, solAmount: number, pool: PoolSnapshot, solPriceUsd: number): Promise<FillResult> {
    if (solAmount <= 0) return { ok: false, reason: 'bad_size' };
    if (solAmount > this.bankroll) return { ok: false, reason: 'insufficient_bankroll' };
    let fill: SimulatedFill;
    try {
      fill = simulateBuy(solAmount, pool, solPriceUsd, PAPER_PRIORITY_FEE_SOL, !this.held.has(mint));
    } catch (e: any) {
      return { ok: false, reason: `sim_error:${e?.message ?? 'unknown'}` };
    }
    this.bankroll += fill.solDelta;
    this.held.set(mint, (this.held.get(mint) ?? 0) + fill.tokenDelta);
    return { ok: true, ...fill, txid: `paper-${mint.slice(0, 6)}-${this.held.size}` };
  }

  public async sell(mint: string, pct: number, pool: PoolSnapshot, solPriceUsd: number): Promise<FillResult> {
    const tokens = this.held.get(mint) ?? 0;
    if (tokens <= 0) return { ok: false, reason: 'nothing_held' };
    const selling = tokens * Math.min(1, Math.max(0, pct));
    if (selling <= 0) return { ok: false, reason: 'bad_pct' };
    let fill: SimulatedFill;
    try {
      fill = simulateSell(selling, pool, solPriceUsd, PAPER_PRIORITY_FEE_SOL);
    } catch (e: any) {
      return { ok: false, reason: `sim_error:${e?.message ?? 'unknown'}` };
    }
    this.bankroll += fill.solDelta;
    const remaining = tokens + fill.tokenDelta; // tokenDelta negative on sell
    if (remaining <= 1e-9) this.held.delete(mint); else this.held.set(mint, remaining);
    return { ok: true, ...fill, txid: `paper-sell-${mint.slice(0, 6)}` };
  }
}

export { poolFromLaunch };
export type { PoolSnapshot };
