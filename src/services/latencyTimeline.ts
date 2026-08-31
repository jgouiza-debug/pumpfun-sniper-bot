import fs from 'fs';
import path from 'path';

/**
 * Structured T0-T7 timeline for every candidate the pipeline touches.
 *
 * This exists because the audit found T6->T7 (submit -> landed) completely
 * unmeasurable: nothing recorded when anything happened. Per the audit rules
 * this logging is permanent and unconditional — "we should never again be
 * guessing about latency".
 *
 * Records append to reports/candidates-YYYY-MM-DD.jsonl (already gitignored
 * via reports/). Each line is self-contained: raw payload, enrichment, both
 * gate verdicts and stage timestamps — which makes the file the input format
 * for the offline replay harness (src/replay.ts).
 *
 * Writes are buffered and flushed asynchronously every 2s so no file I/O ever
 * blocks the hot path.
 */

export interface GateVerdictSnapshot {
  gate: 'v1-legacy' | 'v2-realdata';
  isSafe: boolean;
  score?: number;
  reasons: string[];
  unverifiedFields?: string[];
}

export interface CandidateTimeline {
  mint: string;
  symbol: string;
  txType?: string;
  mode: 'paper' | 'real';

  /** T1: event arrived at our process (ws message handler entry). */
  t1ArrivalMs: number;
  /** T2: parsed & identified as candidate (processIncomingToken entry). */
  t2ParsedMs?: number;
  /** T3: enrichment + safety data complete (DexScreener/RugCheck resolved). */
  t3FiltersDoneMs?: number;
  /** T4: gate decision made. */
  t4DecisionMs?: number;
  /** T5: transaction built and signed (real mode only). */
  t5BuiltSignedMs?: number;
  /** T6: transaction submitted to RPC (real mode only). */
  t6SubmittedMs?: number;
  /** T7: transaction confirmed (real mode only). */
  t7ConfirmedMs?: number;

  /** Slot sampled at arrival (flag timelineSlotSampling) and slot the fill landed in. */
  slotAtArrival?: number;
  landedSlot?: number;

  gateV1?: GateVerdictSnapshot;
  gateV2?: GateVerdictSnapshot;
  /** Set when both gates ran and disagreed — the shadow-mode money signal. */
  divergence?: boolean;

  /**
   * True when the liquidity this decision saw was the migration ASSERTION, not
   * a reading. Recorded so an analysis of past decisions can tell which ones
   * were made against a constant — roughly every migration, at decision time.
   */
  liquidityIsAsserted?: boolean;

  decision: 'rejected' | 'passed_no_buy' | 'buy_attempted' | 'buy_confirmed' | 'buy_failed';
  activeGate: 'v1-legacy' | 'v2-realdata';

  /** Raw stream payload + the enriched launch data — replay inputs. */
  payload?: any;
  launchData?: any;
  /** Trimmed RugCheck snapshot sufficient to re-run both gates offline. */
  rug?: any;
}

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');
const FLUSH_INTERVAL_MS = 2000;
const RECENT_CAP = 200;

export class LatencyTimelineLogger {
  private open = new Map<string, CandidateTimeline>();
  private buffer: string[] = [];
  private recent: CandidateTimeline[] = [];
  private flushTimer: NodeJS.Timeout;

  constructor() {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Never keep the process alive just to flush telemetry.
    this.flushTimer.unref?.();
  }

  public begin(mint: string, seed: Partial<CandidateTimeline> & { t1ArrivalMs: number; mode: 'paper' | 'real' }): void {
    this.open.set(mint, {
      mint,
      symbol: seed.symbol || 'UNK',
      decision: 'rejected',
      activeGate: 'v1-legacy',
      ...seed,
    } as CandidateTimeline);
  }

  /**
   * Is a record already open for this mint?
   *
   * The copy path opens its own record (nothing upstream of it does), and this
   * is how it avoids clobbering one the sniper's screening pipeline already
   * started for the same mint — which would reset t1 and make the sniper's
   * timings read as instantaneous.
   */
  public isOpen(mint: string): boolean {
    return this.open.has(mint);
  }

  /**
   * Read the in-progress record. Returns the live object, so callers must treat
   * it as read-only — it is handed out for measurement (`t6 - t1`), not for
   * mutation. Use `annotate` to change anything.
   */
  public snapshot(mint: string): Readonly<CandidateTimeline> | undefined {
    return this.open.get(mint);
  }

  public stamp(mint: string, field: keyof CandidateTimeline, value?: number): void {
    const t = this.open.get(mint);
    if (t) (t as any)[field] = value ?? Date.now();
  }

  public annotate(mint: string, patch: Partial<CandidateTimeline>): void {
    const t = this.open.get(mint);
    if (t) Object.assign(t, patch);
  }

  /** Finalizes and queues the record for the async writer. */
  public complete(mint: string): void {
    const t = this.open.get(mint);
    if (!t) return;
    this.open.delete(mint);

    this.recent.push(t);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
    this.buffer.push(JSON.stringify(t));
  }

  /** Recent completed timelines for the API/UI, newest last. */
  public getRecent(limit = 50): CandidateTimeline[] {
    return this.recent.slice(-limit);
  }

  /** Human-readable stage durations for a completed timeline. */
  public static stageDurations(t: CandidateTimeline): Record<string, number | null> {
    const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : null);
    return {
      parseMs: d(t.t1ArrivalMs, t.t2ParsedMs),
      filtersMs: d(t.t2ParsedMs, t.t3FiltersDoneMs),
      decisionMs: d(t.t3FiltersDoneMs, t.t4DecisionMs),
      buildSignMs: d(t.t4DecisionMs, t.t5BuiltSignedMs),
      submitMs: d(t.t5BuiltSignedMs, t.t6SubmittedMs),
      landMs: d(t.t6SubmittedMs, t.t7ConfirmedMs),
      totalMs: d(t.t1ArrivalMs, t.t7ConfirmedMs ?? t.t4DecisionMs),
    };
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.join('\n') + '\n';
    this.buffer = [];
    const file = path.join(REPORTS_DIR, `candidates-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.mkdir(REPORTS_DIR, { recursive: true }, (mkErr) => {
      if (mkErr) return;
      fs.appendFile(file, lines, (err) => {
        if (err) console.warn(`[Timeline] append failed: ${err.message}`);
      });
    });
  }
}

export const latencyTimeline = new LatencyTimelineLogger();
