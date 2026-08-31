/**
 * HOW FAR BEHIND THE LEADER DID WE LAND?
 *
 * WHY THIS EXISTS. The copy trader's whole purpose is to be in the same trade
 * as the leader, and until now nothing in the process measured whether it was.
 * Two separate gaps produced that blindness:
 *
 *  1. `latencyTimeline.stamp()` is a no-op unless `begin()` opened a record for
 *     that mint, and `begin()` was called only from the sniper's own screening
 *     pipeline (processIncomingToken and the two launch-snipe triggers). A copy
 *     trade enters through `executeExternalTrade`, which never called it — so
 *     t5BuiltSigned, t6Submitted and t7Confirmed were computed and then thrown
 *     away for every copy trade the bot has ever made.
 *
 *  2. Even with those stamps, milliseconds are the wrong unit for this
 *     question. What decides the fill price is how many SLOTS separate the
 *     leader's buy from ours: the curve only moves when a block is produced, so
 *     landing 300ms later in the SAME slot costs nothing, and landing 60ms
 *     later across a slot boundary costs a whole candle.
 *
 * So the metric is the slot delta, and the milliseconds are kept alongside it
 * as the thing an engineer can actually act on:
 *
 *     slotDelta   leader's slot (from the logsNotification context) vs the slot
 *                 our fill landed in. 0 = same block. This is the score.
 *     wireMs      notification received -> our transaction bytes submitted.
 *                 This is the part the code controls.
 *     landMs      submitted -> confirmed. This is the part the network controls.
 *
 * WHAT A GOOD NUMBER LOOKS LIKE. Solana's slot time is 350ms (SIMD-0525, 21 Aug
 * 2026) and the practical window inside a slot is far shorter than that,
 * because the leader stops accepting well before the slot ends. Same-slot
 * landing is real but belongs to operators co-located beside the leader
 * schedule; from a residential connection the round trip alone spends most of
 * the slot. A delta of 1-2 is the honest target here, and the difference
 * between a delta of 2 and a delta of 6 is most of the edge.
 *
 * This module deliberately holds no opinion and takes no action. It records
 * what happened and reports percentiles. Every later change to the hot path is
 * accepted or rejected on what this says, before and after — which is the only
 * way a latency claim is worth anything.
 */

/** One landed copy trade. Every field is measured; nothing here is estimated. */
export interface SlotDeltaSample {
  mint: string;
  /** The slot the leader's transaction was observed in (logsNotification context.slot). */
  leaderSlot: number;
  /** The slot our fill landed in, read back from the transaction. */
  landedSlot: number;
  /** landedSlot - leaderSlot. Can be 0 (same block); never negative in practice. */
  delta: number;
  /** Notification received -> bytes submitted. The part the code owns. */
  wireMs: number | null;
  /** Submitted -> confirmed. The part the network owns. */
  landMs: number | null;
  /** Which lane produced the signal. The slow lane is expected to be far worse. */
  lane: 'fast' | 'slow';
  at: number;
}

export interface SlotDeltaStats {
  samples: number;
  /** Share of samples that landed in the leader's own block. */
  sameSlotPct: number;
  /** Share within one slot of the leader. */
  withinOneSlotPct: number;
  slotDelta: { p50: number; p90: number; worst: number } | null;
  wireMs: { p50: number; p90: number } | null;
  landMs: { p50: number; p90: number } | null;
  /** Broken out by lane, because mixing them hides which one is slow. */
  byLane: Record<'fast' | 'slow', { samples: number; p50Delta: number | null }>;
}

/**
 * 200 samples. Large enough that a p90 means something, small enough that the
 * window still reflects the CURRENT network and the CURRENT code rather than
 * an average over a config change made an hour ago.
 */
const WINDOW = 200;

/**
 * Nearest-rank percentile on a sorted array.
 *
 * Deliberately not interpolated: these are slot counts, and "the p90 delta is
 * 2.4 slots" is a number that cannot happen. Nearest-rank answers with a value
 * that was actually observed.
 */
function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export class SlotDeltaTracker {
  private window: SlotDeltaSample[] = [];

  /**
   * Record a landed copy trade.
   *
   * Refuses anything it cannot stand behind. A missing or zero slot on either
   * side is not a delta of zero — it is an unknown, and recording it as a
   * same-slot landing would flatter the number in exactly the case where the
   * measurement failed. `inspectFill` returns slot 0 when it could not read the
   * transaction, and the balance-derived recovery path has no slot at all.
   */
  public record(s: Omit<SlotDeltaSample, 'delta' | 'at'> & { at?: number }): SlotDeltaSample | null {
    if (!Number.isFinite(s.leaderSlot) || !Number.isFinite(s.landedSlot)) return null;
    if (s.leaderSlot <= 0 || s.landedSlot <= 0) return null;
    const delta = s.landedSlot - s.leaderSlot;
    // A landing BEFORE the leader is not possible; it means one of the two
    // numbers came from a different measurement than we think.
    if (delta < 0) return null;

    const sample: SlotDeltaSample = { ...s, delta, at: s.at ?? Date.now() };
    this.window.push(sample);
    if (this.window.length > WINDOW) this.window.splice(0, this.window.length - WINDOW);
    return sample;
  }

  public stats(): SlotDeltaStats {
    const n = this.window.length;
    const byLane: SlotDeltaStats['byLane'] = {
      fast: { samples: 0, p50Delta: null },
      slow: { samples: 0, p50Delta: null },
    };
    for (const lane of ['fast', 'slow'] as const) {
      const deltas = this.window.filter(s => s.lane === lane).map(s => s.delta).sort((a, b) => a - b);
      byLane[lane] = { samples: deltas.length, p50Delta: deltas.length ? pct(deltas, 50) : null };
    }

    if (n === 0) {
      return { samples: 0, sameSlotPct: 0, withinOneSlotPct: 0, slotDelta: null, wireMs: null, landMs: null, byLane };
    }

    const deltas = this.window.map(s => s.delta).sort((a, b) => a - b);
    const wires = this.window.map(s => s.wireMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const lands = this.window.map(s => s.landMs).filter((v): v is number => v !== null).sort((a, b) => a - b);

    return {
      samples: n,
      sameSlotPct: Math.round((this.window.filter(s => s.delta === 0).length / n) * 1000) / 10,
      withinOneSlotPct: Math.round((this.window.filter(s => s.delta <= 1).length / n) * 1000) / 10,
      slotDelta: { p50: pct(deltas, 50), p90: pct(deltas, 90), worst: deltas[deltas.length - 1] },
      wireMs: wires.length ? { p50: pct(wires, 50), p90: pct(wires, 90) } : null,
      landMs: lands.length ? { p50: pct(lands, 50), p90: pct(lands, 90) } : null,
      byLane,
    };
  }

  public recent(limit = 25): SlotDeltaSample[] {
    return this.window.slice(-limit);
  }

  public reset(): void {
    this.window = [];
  }

  /**
   * The one-line summary for the log, written so an operator can read the
   * verdict without knowing what a slot is.
   */
  public static describe(s: SlotDeltaSample): string {
    const verdict = s.delta === 0
      ? 'SAME BLOCK as the leader'
      : `${s.delta} slot${s.delta === 1 ? '' : 's'} behind the leader (~${s.delta * 350}ms of curve movement)`;
    const wire = s.wireMs === null ? '' : ` | ${s.wireMs}ms signal→wire`;
    const land = s.landMs === null ? '' : ` | ${s.landMs}ms wire→confirmed`;
    return `⏱️ ${verdict}${wire}${land} [${s.lane} lane]`;
  }
}

export const slotDelta = new SlotDeltaTracker();
