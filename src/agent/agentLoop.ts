/**
 * The agent loop — the autonomous trader, assembled.
 *
 * One candidate's life through this file:
 *
 *   candidate → triage (free) → budget + RPM gate → metadata fetch (~300ms)
 *     → dossier + book → Gemini decide (~1-3s) → broker.authorize
 *     → port.buy (paper) → sensors armed, ladder armed, journal row
 *   ... then per tick: sensors → evidence → ladder → maybe scale/close
 *   ... at review age: research digest → Gemini review → reshape, or
 *       structural-cause exit, or hold
 *
 * DIVISION OF AUTHORITY, restated because it is the whole design:
 *   the MODEL decides   which of the offered candidates to buy, conviction
 *                       bucket, ladder shape, and (with a named structural
 *                       cause only) whether a held token is no longer what it
 *                       claimed to be;
 *   the SCRIPT decides  everything else — what gets offered, position size,
 *                       every cap and cooldown, all profit-taking, all
 *                       structural exits, and every SOL that moves.
 *
 * The loop never awaits a model call inside the tick path: entries are
 * processed from a queue, reviews run detached. A slow API bursts nothing.
 */

import { PumpTokenLaunch, RugCheckReport } from '../types';
import { buildDossier, renderDossier } from './dossier';
import { decide, reviewPosition, AgentConfig, AGENT_DEFAULTS } from './geminiClient';
import { authorize, newBrokerState, recordBuy, recordClose, recordFailure, BrokerState, BrokerLimits, BROKER_DEFAULTS } from './broker';
import { nextExitAction, applyExit, rungIndexFor, resolveShape, countReds, PositionLedger, ExitConfig, EXIT_DEFAULTS } from './exitLadder';
import { triageScore, ScreeningBudget } from './triage';
import { RpmLimiter } from './rateLimiter';
import { AgentJournal } from './journal';
import { ExecutionPort } from './executionPort';
import { EvidenceSensors } from './evidenceSensors';
import { Portfolio, renderPortfolio, OpenPositionView } from './portfolio';
import { renderPositionReview } from './positionReview';
import { fetchTokenMetadata, withMetadata } from './metadataFetcher';
import { policyHash } from './schema';

export interface AgentLoopConfig {
  agent: AgentConfig;
  broker: BrokerLimits;
  exits: ExitConfig;
  /** Candidates older than this at screen time are dropped, not screened. */
  maxCandidateAgeMs: number;
  /** Minimum triage score to spend a ranked call; random-arm calls ignore it. */
  minTriageScore: number;
  /** Age at which a position gets its (single) model review. */
  reviewAtMinutes: number;
  tickMs: number;
}

export const LOOP_DEFAULTS: Omit<AgentLoopConfig, 'agent'> = {
  broker: BROKER_DEFAULTS,
  exits: EXIT_DEFAULTS,
  maxCandidateAgeMs: 45_000,
  minTriageScore: 2.0,
  reviewAtMinutes: 12,
  tickMs: 5_000,
};

interface QueuedCandidate {
  launch: PumpTokenLaunch;
  rug: RugCheckReport | null;
  isMigration: boolean;
  seenAt: number;
  score: number;
  arm: 'ranked' | 'random';
}

interface LivePosition {
  ledger: PositionLedger;
  view: OpenPositionView;
  entrySolPriceUsd: number;
  entryVSol: number | null;
  reviewed: boolean;
  peakMultiple: number;
  /** Cumulative SOL received from every exit fill. closeOut nets this against invested. */
  proceedsSol: number;
}

export class AgentLoop {
  private queue: QueuedCandidate[] = [];
  private positions = new Map<string, LivePosition>();
  private broker: BrokerState;
  private rpm = new RpmLimiter();
  private budget = new ScreeningBudget();
  private portfolio = new Portfolio();
  private sensors = new EvidenceSensors();
  private journal: AgentJournal;
  private timer: NodeJS.Timeout | null = null;
  private entryInFlight = false;
  private solPriceUsd = 200; // refreshed by the runner; a stale value biases paper P&L, not safety
  public readonly policy: string;

  constructor(
    private port: ExecutionPort,
    private cfg: AgentLoopConfig,
    private getSolPrice: () => Promise<number>,
    /** Called after a buy so the runner can subscribe the mint's trade stream. */
    private onHold?: (mint: string, hold: boolean) => void
  ) {
    this.journal = new AgentJournal();
    this.broker = newBrokerState(new Date().toISOString().slice(0, 10));
    this.policy = policyHash(cfg.agent.model, cfg.agent.thinkingLevel);
    this.journal.write('boot', {
      policy: this.policy, mode: port.mode, model: cfg.agent.model,
      thinking: cfg.agent.thinkingLevel, broker: cfg.broker, exits: cfg.exits,
    });
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.tickMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.journal.write('shutdown', { openPositions: this.positions.size, bankroll: this.port.bankrollSol() });
    this.journal.close();
  }

  /** Sensor intake — the runner forwards every trade event for held mints here. */
  public onTradeEvent(payload: any): void { this.sensors.onTrade(payload); }
  public onDexSample(mint: string, d: { priceUsd?: number; liquidityUsd?: number }): void {
    this.sensors.onDexSample(mint, d);
  }

  /** Full book for the UI: open positions, concentration, shape performance. */
  public book() {
    return this.portfolio.view({
      budgetRemainingSol: Math.max(0, this.cfg.broker.dailySpendCapSol - this.broker.spentTodaySol),
      screeningCallsRemaining: this.budget.remaining(),
    });
  }

  public journalFile(): string { return this.journal.file; }

  public status() {
    return {
      policy: this.policy, mode: this.port.mode, open: this.positions.size,
      bankroll: this.port.bankrollSol(), queue: this.queue.length,
      budget: this.budget.stats(), halted: this.broker.halted, haltReason: this.broker.haltReason,
    };
  }

  /** Candidate intake. Free and synchronous — model spend happens in the tick. */
  public onCandidate(launch: PumpTokenLaunch, rug: RugCheckReport | null, isMigration: boolean): void {
    if (this.broker.halted) return;
    const t = triageScore({
      launch,
      tradeCount: (launch as any).tradeCount ?? null,
      vSolInCurve: launch.vSolInBondingCurve ?? null,
    });
    // Random arm first: it must be independent of the score, or it is not a
    // control group. One in ~40 candidates rolls into it (~26k/day * 1/40 ≈ 650,
    // gated to the reserved slice by ScreeningBudget at spend time).
    const arm: 'ranked' | 'random' | null =
      Math.random() < 0.025 ? 'random'
      : t.score >= this.cfg.minTriageScore ? 'ranked'
      : null;
    this.journal.write(arm ? 'triage_ranked' : 'triage_dropped', {
      mint: launch.mint, score: t.score, parts: t.parts, arm,
    });
    if (!arm) return;
    this.queue.push({ launch, rug, isMigration, seenAt: Date.now(), score: t.score, arm });
    // Bounded queue, best-first. Starving the tail is the point.
    this.queue.sort((a, b) => b.score - a.score);
    if (this.queue.length > 12) this.queue.length = 12;
  }

  private async tick(): Promise<void> {
    try {
      await this.manageExits();
      await this.maybeReview();
      await this.maybeEnter();
    } catch (err: any) {
      // The engine's exit tick swallows errors silently and that cost weeks of
      // diagnosis. This one writes the row.
      this.journal.write('halt', { where: 'tick', error: String(err?.message ?? err) });
    }
  }

  private async maybeEnter(): Promise<void> {
    if (this.entryInFlight || this.broker.halted || !this.queue.length) return;
    const now = Date.now();
    // Drop stale candidates BEFORE spending quota on them.
    this.queue = this.queue.filter((c) => {
      const fresh = now - c.seenAt <= this.cfg.maxCandidateAgeMs;
      if (!fresh) this.journal.write('screen_rate_limited', { mint: c.launch.mint, reason: 'stale', ageMs: now - c.seenAt });
      return fresh;
    });
    const cand = this.queue.shift();
    if (!cand) return;
    if (!this.rpm.tryAcquire()) { this.queue.unshift(cand); return; }
    if (!this.budget.spend(cand.arm)) {
      this.journal.write('screen_rate_limited', { mint: cand.launch.mint, reason: 'daily_budget', arm: cand.arm });
      return;
    }

    this.entryInFlight = true;
    try {
      const meta = await fetchTokenMetadata(cand.launch.metadataUri ?? (cand.launch as any).uri);
      const enriched = withMetadata(cand.launch, meta);
      const dossier = buildDossier(enriched, cand.rug, cand.isMigration);
      const book = renderPortfolio(this.portfolio.view({
        budgetRemainingSol: Math.max(0, this.cfg.broker.dailySpendCapSol - this.broker.spentTodaySol),
        screeningCallsRemaining: this.budget.remaining(),
      }));
      const decision = await decide(dossier, this.cfg.agent, book);
      this.journal.write('decision', {
        mint: dossier.mint, arm: cand.arm, intent: decision.intent, failure: decision.failure,
        latencyMs: decision.latencyMs, promptTokens: decision.promptTokens,
        outputTokens: decision.outputTokens, policy: this.policy, metaFetched: meta.fetched,
      });
      if (!decision.intent) { recordFailure(this.broker); return; }
      if (decision.intent.action !== 'BUY') return;

      const verdict = authorize(decision.intent, dossier.mint, this.broker, this.cfg.broker, Date.now());
      if (!verdict.authorized) {
        this.journal.write('broker_refusal', { mint: dossier.mint, reason: verdict.reason });
        return;
      }

      const mark = { vSolInBondingCurve: enriched.vSolInBondingCurve, vTokensInBondingCurve: enriched.vTokensInBondingCurve };
      this.solPriceUsd = await this.getSolPrice().catch(() => this.solPriceUsd);
      const fill = await this.port.buy(verdict.mint, verdict.sizeSol, mark, this.solPriceUsd);
      if (!fill.ok) {
        this.journal.write('buy_failed', { mint: verdict.mint, reason: fill.reason });
        recordFailure(this.broker);
        return;
      }
      recordBuy(this.broker, verdict.mint, verdict.sizeSol, Date.now());

      const shape = resolveShape(decision.intent.exitShape ?? 'BALANCED', this.cfg.exits);
      const entryPriceUsd = fill.effectivePriceUsd ?? 0;
      const ledger: PositionLedger = {
        positionId: `agent-${verdict.mint.slice(0, 8)}-${Date.now()}`,
        mint: verdict.mint, shape, conviction: verdict.conviction,
        entryPriceUsd, entryAtMs: Date.now(),
        remainingFraction: 1, rungsTaken: [], curveDrainScaleTaken: false, redCount: 0,
      };
      const view: OpenPositionView = {
        mint: verdict.mint, symbol: enriched.symbol, creator: enriched.creator ?? null,
        shape, ageMinutes: 0, investedSol: verdict.sizeSol,
        remainingFraction: 1, unrealizedPct: null, rungsTaken: 0,
      };
      this.positions.set(verdict.mint, {
        ledger, view, entrySolPriceUsd: this.solPriceUsd,
        entryVSol: enriched.vSolInBondingCurve ?? null, reviewed: false, peakMultiple: 1,
        proceedsSol: 0,
      });
      this.portfolio.openPosition(view);
      this.sensors.arm(verdict.mint, {
        creator: enriched.creator ?? null,
        entryMintRevoked: dossier.facts.mintRevoked,
        entryFreezeRevoked: dossier.facts.freezeRevoked,
        vSol: enriched.vSolInBondingCurve ?? null,
        vTokens: enriched.vTokensInBondingCurve ?? null,
      });
      this.onHold?.(verdict.mint, true);
      this.journal.write('buy_filled', {
        mint: verdict.mint, sizeSol: verdict.sizeSol, conviction: verdict.conviction,
        shape, entryPriceUsd, feeSol: fill.feeSol, impactPct: fill.priceImpactPct, txid: fill.txid,
      });
    } finally {
      this.entryInFlight = false;
    }
  }

  private async manageExits(): Promise<void> {
    for (const [mint, live] of this.positions) {
      const mark = this.sensors.mark(mint);
      const priceUsd = this.currentPriceUsd(mint, live, mark);
      if (priceUsd !== null && live.ledger.entryPriceUsd > 0) {
        const mult = priceUsd / live.ledger.entryPriceUsd;
        live.peakMultiple = Math.max(live.peakMultiple, mult);
        live.view.unrealizedPct = (mult - 1) * 100;
      }
      live.view.ageMinutes = Math.round((Date.now() - live.ledger.entryAtMs) / 60_000);
      this.portfolio.updatePosition(mint, {
        ageMinutes: live.view.ageMinutes,
        unrealizedPct: live.view.unrealizedPct,
        remainingFraction: live.ledger.remainingFraction,
      });

      const ev = this.sensors.evidence(mint);
      live.ledger.redCount = countReds(ev);
      const action = nextExitAction(live.ledger, priceUsd, ev, this.cfg.exits, Date.now());
      if (!action) continue;

      this.journal.write('exit_action', { mint, ...action, evidence: ev, peakMultiple: live.peakMultiple });
      await this.executeExit(mint, live, action.pct / live.ledger.remainingFraction, action.trigger, () => {
        const rung = action.trigger === 'AGENT_RUNG' && priceUsd !== null
          ? rungIndexFor(live.ledger, priceUsd) : undefined;
        applyExit(live.ledger, action, rung);
      });
    }
  }

  /** pctOfHeld is the fraction of the CURRENTLY HELD tokens (the port's unit). */
  private async executeExit(
    mint: string, live: LivePosition, pctOfHeld: number, trigger: string, applyLedger: () => void
  ): Promise<void> {
    const mark = this.sensors.mark(mint);
    if (!mark) { this.journal.write('sensor_dark', { mint, at: 'exit', trigger }); return; }
    const fill = await this.port.sell(mint, Math.min(1, pctOfHeld), mark.pool, this.solPriceUsd);
    if (!fill.ok) {
      this.journal.write('exit_failed', { mint, trigger, reason: fill.reason });
      return; // ladder latch NOT set — it retries next tick. Failure never silences an exit.
    }
    applyLedger();
    live.proceedsSol += fill.solDelta ?? 0;
    this.journal.write('exit_filled', {
      mint, trigger, proceedsSol: fill.solDelta, feeSol: fill.feeSol,
      remainingFraction: live.ledger.remainingFraction,
    });
    if (live.ledger.remainingFraction <= 1e-9) this.closeOut(mint, live, trigger);
  }

  private closeOut(mint: string, live: LivePosition, trigger: string): void {
    this.positions.delete(mint);
    this.sensors.disarm(mint);
    this.onHold?.(mint, false);
    // Realized P&L, net of every fee both ways: everything the exits returned
    // minus everything the entry cost. This is what arms the daily loss cap —
    // with a zero here the cap would never fire, which is the difference
    // between a bounded bad day and an unbounded one.
    const pnlSol = live.proceedsSol - live.view.investedSol;
    recordClose(this.broker, pnlSol);
    this.journal.write('exit_filled', { mint, trigger: `CLOSED_${trigger}`, realizedPnlSol: pnlSol });
    this.portfolio.closePosition({
      mint, symbol: live.view.symbol, creator: live.view.creator, shape: live.ledger.shape,
      entryAtMs: live.ledger.entryAtMs, exitAtMs: Date.now(),
      realizedPnlSol: pnlSol, exitTrigger: trigger, peakMultiple: live.peakMultiple,
    });
  }

  private currentPriceUsd(
    mint: string, live: LivePosition,
    mark: { pool: any; priceUsd: number | null } | null
  ): number | null {
    if (!mark) return null;
    if (mark.priceUsd !== null) return mark.priceUsd;
    // Pre-migration: derive from curve reserves, same arithmetic as the fill.
    const vSol = mark.pool.vSolInBondingCurve, vTok = mark.pool.vTokensInBondingCurve;
    if (vSol && vTok) return (vSol / vTok) * this.solPriceUsd;
    return null;
  }

  private async maybeReview(): Promise<void> {
    for (const [mint, live] of this.positions) {
      if (live.reviewed) continue;
      if (live.view.ageMinutes < this.cfg.reviewAtMinutes) continue;
      if (!this.rpm.tryAcquire()) return; // entries and reviews share the RPM pool
      live.reviewed = true; // one review per position, even if the call fails

      const changes: string[] = [];
      const ev = this.sensors.evidence(mint);
      if (ev.devSold === true) changes.push('creator has sold');
      if (ev.curveDrained === true) changes.push('curve has drained from its peak');
      if (live.ledger.rungsTaken.length) changes.push(`${live.ledger.rungsTaken.length} profit rung(s) already taken`);

      const rendered = renderPositionReview({ position: live.view, changes, research: null });
      void reviewPosition(rendered, this.cfg.agent).then((r) => {
        this.journal.write('review', { mint, intent: r.intent, failure: r.failure, latencyMs: r.latencyMs });
        if (!r.intent) return;
        if (r.intent.assessment === 'RESHAPE') {
          live.ledger.shape = r.intent.newShape;
          live.view.shape = r.intent.newShape;
          this.journal.write('reshape', { mint, to: r.intent.newShape, interest: r.intent.interest });
        } else if (r.intent.assessment === 'EXIT') {
          // Structural cause verified by the client; execute as a forced close.
          void this.executeExit(mint, live, 1, `REVIEW_${r.intent.structuralCause}`, () => {
            live.ledger.remainingFraction = 0;
          });
        }
      });
    }
  }
}
