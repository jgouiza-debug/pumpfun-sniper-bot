/**
 * The book — what the agent knows about its own positions and recent history.
 *
 * THE GAP THIS CLOSES: every decision the agent made before this file was
 * STATELESS. It saw one token, judged it, and forgot. That is not trading, it is
 * scoring. A model with no view of its own book will cheerfully open the same
 * concentrated bet five times in a morning — three mints from one creator
 * cluster, or four launches riding the same narrative — and never notice,
 * because from inside each individual call every one of them looks like a fresh
 * independent opportunity.
 *
 * Concentration is the failure mode that actually ends runs. Position sizing is
 * capped by broker.ts, but nothing caps CORRELATION: five 0.02 SOL positions in
 * five copies of the same meme is one 0.1 SOL position with extra fees, and the
 * broker cannot see that because it only ever looks at one intent at a time.
 *
 * All of this is LOCAL STATE. No RPC, no API, no cost. It is the cheapest
 * context the model can be given and probably the most valuable.
 */

import { PersistedPosition } from '../services/positionStore';
import { ExitShape } from './exitLadder';

export interface ClosedTrade {
  mint: string;
  symbol: string;
  creator: string | null;
  shape: ExitShape;
  entryAtMs: number;
  exitAtMs: number;
  realizedPnlSol: number;
  exitTrigger: string;
  /** Peak multiple reached before exit. Tells you if a shape left money behind. */
  peakMultiple: number | null;
}

export interface OpenPositionView {
  mint: string;
  symbol: string;
  creator: string | null;
  shape: ExitShape;
  ageMinutes: number;
  investedSol: number;
  /** Fraction of the original still held after any scale-outs. */
  remainingFraction: number;
  unrealizedPct: number | null;
  rungsTaken: number;
}

export interface PortfolioView {
  openPositions: OpenPositionView[];
  openCount: number;
  deployedSol: number;
  /** Creators with more than one position open or closed today. The concentration signal. */
  repeatedCreators: Array<{ creator: string; count: number; mints: string[] }>;
  tradesToday: number;
  realizedPnlTodaySol: number;
  budgetRemainingSol: number;
  screeningCallsRemaining: number;
  /** How each ladder shape has actually performed. Feeds shape choice. */
  shapePerformance: Array<{ shape: ExitShape; n: number; avgPnlSol: number; avgPeakMultiple: number | null }>;
}

export class Portfolio {
  private closed: ClosedTrade[] = [];
  private open = new Map<string, OpenPositionView>();
  /** mint -> creator, kept for cluster detection after a position closes. */
  private creatorOf = new Map<string, string>();

  public openPosition(v: OpenPositionView): void {
    this.open.set(v.mint, v);
    if (v.creator) this.creatorOf.set(v.mint, v.creator);
  }

  public updatePosition(mint: string, patch: Partial<OpenPositionView>): void {
    const cur = this.open.get(mint);
    if (cur) this.open.set(mint, { ...cur, ...patch });
  }

  public closePosition(t: ClosedTrade): void {
    this.open.delete(t.mint);
    this.closed.push(t);
    // Bounded: this is prompt context, not an archive. The journal is the archive.
    if (this.closed.length > 200) this.closed.shift();
  }

  /** Rebuild open positions from the persisted store after a restart. */
  public hydrate(persisted: PersistedPosition[], shapeOf: (mint: string) => ExitShape): void {
    for (const p of persisted) {
      this.open.set(p.mint, {
        mint: p.mint,
        symbol: p.tokenSymbol,
        creator: this.creatorOf.get(p.mint) ?? null,
        shape: shapeOf(p.mint),
        ageMinutes: Math.round((Date.now() - p.entryTime) / 60_000),
        investedSol: p.investedSol,
        remainingFraction: 1,
        unrealizedPct: null,
        rungsTaken: p.legCount ?? 0,
      });
    }
  }

  private startOfUtcDay(nowMs: number): number {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  public view(opts: {
    nowMs?: number;
    budgetRemainingSol: number;
    screeningCallsRemaining: number;
  }): PortfolioView {
    const now = opts.nowMs ?? Date.now();
    const dayStart = this.startOfUtcDay(now);
    const todays = this.closed.filter((t) => t.exitAtMs >= dayStart);

    // Concentration across BOTH open and closed-today. A cluster you already
    // exited still tells you what you have been repeatedly drawn to.
    const byCreator = new Map<string, string[]>();
    const note = (creator: string | null, mint: string) => {
      if (!creator) return;
      const arr = byCreator.get(creator) ?? [];
      if (!arr.includes(mint)) arr.push(mint);
      byCreator.set(creator, arr);
    };
    for (const p of this.open.values()) note(p.creator, p.mint);
    for (const t of todays) note(t.creator, t.mint);

    const repeatedCreators = [...byCreator.entries()]
      .filter(([, mints]) => mints.length > 1)
      .map(([creator, mints]) => ({ creator, count: mints.length, mints }))
      .sort((a, b) => b.count - a.count);

    const shapes: ExitShape[] = ['SCALP', 'BALANCED', 'RUNNER'];
    const shapePerformance = shapes.map((shape) => {
      const rows = this.closed.filter((t) => t.shape === shape);
      const peaks = rows.map((r) => r.peakMultiple).filter((p): p is number => p !== null);
      return {
        shape,
        n: rows.length,
        avgPnlSol: rows.length ? rows.reduce((a, r) => a + r.realizedPnlSol, 0) / rows.length : 0,
        avgPeakMultiple: peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null,
      };
    });

    const openPositions = [...this.open.values()];
    return {
      openPositions,
      openCount: openPositions.length,
      deployedSol: openPositions.reduce((a, p) => a + p.investedSol * p.remainingFraction, 0),
      repeatedCreators,
      tradesToday: todays.length,
      realizedPnlTodaySol: todays.reduce((a, t) => a + t.realizedPnlSol, 0),
      budgetRemainingSol: opts.budgetRemainingSol,
      screeningCallsRemaining: opts.screeningCallsRemaining,
      shapePerformance,
    };
  }
}

/**
 * Render the book for the model. Kept tight — this rides along on EVERY entry
 * decision, so every line is paid for thousands of times a day.
 *
 * Concentration is stated first and in plain language, because it is the thing
 * the model is structurally blind to and the thing most likely to hurt.
 */
export function renderPortfolio(v: PortfolioView): string {
  const lines: string[] = ['YOUR BOOK RIGHT NOW'];

  if (v.openCount === 0) {
    lines.push('open positions: none');
  } else {
    lines.push(`open positions: ${v.openCount} | ${v.deployedSol.toFixed(3)} SOL deployed`);
    for (const p of v.openPositions.slice(0, 6)) {
      const pnl = p.unrealizedPct === null ? 'unknown' : `${p.unrealizedPct >= 0 ? '+' : ''}${p.unrealizedPct.toFixed(0)}%`;
      lines.push(
        `  - $${p.symbol} ${p.ageMinutes}m old, ${p.shape}, ${(p.remainingFraction * 100).toFixed(0)}% held, ${pnl}`
      );
    }
  }

  if (v.repeatedCreators.length) {
    lines.push('');
    lines.push('CONCENTRATION WARNING — you have taken more than one position from these creators:');
    for (const c of v.repeatedCreators.slice(0, 4)) {
      lines.push(`  - ${c.creator.slice(0, 8)}… ${c.count} positions`);
    }
    lines.push('Correlated positions are one large bet wearing several small hats. The size cap does not catch this.');
  }

  lines.push('');
  lines.push(`today: ${v.tradesToday} closed, ${v.realizedPnlTodaySol >= 0 ? '+' : ''}${v.realizedPnlTodaySol.toFixed(4)} SOL realized`);
  lines.push(`budget: ${v.budgetRemainingSol.toFixed(3)} SOL deployable, ${v.screeningCallsRemaining} screening calls left today`);

  const seen = v.shapePerformance.filter((s) => s.n > 0);
  if (seen.length) {
    lines.push('');
    lines.push('how your ladder shapes have actually done:');
    for (const s of seen) {
      const peak = s.avgPeakMultiple === null ? '' : `, avg peak ${s.avgPeakMultiple.toFixed(1)}x`;
      lines.push(`  ${s.shape}: n=${s.n}, avg ${s.avgPnlSol >= 0 ? '+' : ''}${s.avgPnlSol.toFixed(4)} SOL${peak}`);
    }
  }

  return lines.join('\n');
}
