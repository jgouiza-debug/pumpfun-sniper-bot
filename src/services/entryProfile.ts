import fs from 'fs';
import { installPath } from './installPaths';

/**
 * WHAT DO THE GOOD TRADERS ACTUALLY LOOK FOR? — learned from their behaviour.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE CONFLUENCE DETECTOR.
 *
 * smartMoneySignal waits until several proven wallets buy a token and then buys
 * the same one. That is following. It is useful, and it is structurally behind:
 * by the time the signal exists the price has already moved, and the whole
 * reason those wallets are worth watching is that their buying is what moves it.
 *
 * This file answers the different question the operator actually asked: not
 * "what did they just buy" but "HOW DO THEY PICK". If the bot knows the shape
 * of token they enter — how old, how far up the curve, how concentrated, how
 * much demand already present — it can screen every launch against that shape
 * itself and enter without waiting for anybody.
 *
 * HOW IT LEARNS. Nobody publishes their criteria, so the criteria are
 * recovered from behaviour, the way you would work out a chess player's opening
 * by watching their games:
 *
 *   1. Every time a promoted wallet buys, record what that token LOOKED LIKE at
 *      that instant — the same feature vector the bot already computes when it
 *      screens a candidate of its own.
 *   2. Record the same vector for launches those wallets did NOT buy. The bot
 *      sees every launch anyway, so the control group is free.
 *   3. For each feature, compare the two distributions. A feature where their
 *      buys cluster somewhere the skipped tokens do not is a feature they
 *      SELECT ON. A feature where the two look the same is one they ignore, and
 *      it is discarded rather than dressed up as a rule.
 *
 * WHAT COMES OUT is a set of per-feature ranges with a separation score, in
 * plain numbers an operator can read and argue with — deliberately not a
 * classifier whose weights nobody can inspect. A rule that spends money has to
 * be legible, and a profile that cannot be read cannot be disagreed with.
 *
 * THE HONEST LIMITS, STATED HERE RATHER THAN DISCOVERED LATER:
 *
 *  - IT NEEDS DATA. A fresh install knows nothing and says so. Separation is
 *    meaningless on a handful of samples, which is why every rule carries its
 *    own sample count and the profile refuses to be used below a floor.
 *  - IT LEARNS THE MECHANICAL PART ONLY. What these traders also have is their
 *    own latency, group coordination, and information that never appears in any
 *    feature vector. This recovers the filter, not the edge that comes from
 *    being them.
 *  - IT IS DESCRIPTIVE, NOT CAUSAL. "They buy tokens with these properties" is
 *    not "these properties make a token good". The properties are a proxy for a
 *    judgement, and proxies drift. That is why the profile is recomputed
 *    continuously and every rule ages.
 */

/**
 * The feature vector, chosen for one reason: every field here is knowable in
 * the first seconds of a token's life, from data the bot already fetches. A
 * beautiful feature that arrives ninety seconds late cannot inform an entry.
 */
export interface TokenSnapshot {
  mint: string;
  at: number;
  /** Seconds since the token was created. The single most selective feature in practice. */
  ageSeconds?: number;
  /** 0-100. Where on the bonding curve, from virtual SOL reserves. */
  curveProgressPct?: number;
  marketCapUsd?: number;
  /** SOL the creator put into their own launch. */
  devBuySol?: number;
  devHoldingsPct?: number;
  top10Pct?: number;
  bundledSupplyPct?: number;
  uniqueBuyers5m?: number;
  buyPressurePct?: number;
  /** Curve progress gained over the trailing 5 minutes, percentage points. */
  progressVelocity5m?: number;
  volume5mUsd?: number;
  liquidityUsd?: number;
  socialCount?: number;
  /** How many distinct wallets bought before this one. Their position in the queue. */
  buyerRank?: number;

  // ---- chain-derived, from curveHistory.readCurveMoment ------------------
  //
  // Deliberately NOT folded into the market-data fields above, however similar
  // they look. `buyPressurePct` comes from DexScreener; `windowBuyPressurePct`
  // is computed from decoded TradeEvents on the bonding curve. Filing the
  // second under the first's name would produce bands describing the gap
  // between two vendors rather than anyone's judgement — which is exactly the
  // kind of confident nonsense this file exists to refuse.
  /** Curve transactions that landed before this moment. */
  curveTxRank?: number;
  /** SOL bought on the curve in the 5 minutes before this moment. */
  windowBuySol?: number;
  /** SOL sold on the curve in the same window. */
  windowSellSol?: number;
  /** Buys as a share of window flow, 0-100. */
  windowBuyPressurePct?: number;
  /** Distinct wallets that bought in the window. */
  windowBuyers?: number;
  /** Curve transactions in the window, per minute. */
  windowTradesPerMin?: number;

  /**
   * HOW this snapshot was measured. The one field that is not about the token.
   *
   * 'live' is taken in the screening pipeline the instant the bot sees a
   * launch. 'backfill' is rebuilt from chain history at the moment a trade
   * actually happened. Both are honest; they are not COMPARABLE, and mixing
   * them is the subtlest way this whole method can produce a confident lie.
   *
   * The reason is timing, not accuracy. Every live snapshot is taken seconds
   * after launch, because that is when the pipeline runs. Every backfilled
   * entry is taken whenever the trader actually bought — ten minutes in, an
   * hour in. Pool them and `ageSeconds` separates the two groups almost
   * perfectly, and the deriver reports a beautiful rule ("they buy tokens
   * older than 4 minutes") that is a fact about WHEN WE LOOKED and contains no
   * information about anyone's strategy. Every other feature is contaminated
   * the same way, more quietly.
   *
   * So `derive` picks one source and uses only that. Missing means 'live',
   * for profiles saved before this field existed.
   */
  source?: 'live' | 'backfill';
}

/** Which side of the comparison a snapshot belongs to. */
export type SnapshotClass = 'entered' | 'skipped';

export interface FeatureRule {
  feature: keyof TokenSnapshot;
  /** Human label, so the UI does not have to know field names. */
  label: string;
  /** The band their entries fall in — 10th to 90th percentile of the entered set. */
  low: number;
  high: number;
  /** Median of the entered set. The centre of what they like. */
  median: number;
  /** Median of the skipped set, for contrast. */
  skippedMedian: number;
  /**
   * 0-1. How much this feature separates the two groups.
   *
   * The share of skipped tokens that fall OUTSIDE the entered band. A feature
   * both groups sit inside separates nothing and is dropped, however
   * interesting it looks.
   */
  separation: number;
  /** Entered samples this rule was computed from. */
  samples: number;
}

export interface LearnedProfile {
  rules: FeatureRule[];
  enteredSamples: number;
  skippedSamples: number;
  builtAt: number;
  /** Which measurement method the rules were derived from. Never a mixture. */
  source: 'live' | 'backfill';
  /** False until there is enough of both classes for the comparison to mean anything. */
  usable: boolean;
  /** Why it is not usable, when it is not. Shown to the operator verbatim. */
  notReady?: string;
}

/**
 * Minimum evidence before the profile may drive anything.
 *
 * 40 entries is not a statistical luxury, it is the floor below which a
 * percentile band is just the two or three tokens that happened to be seen.
 * The skipped floor is higher because that side is free — the bot sees every
 * launch — so there is no reason to accept a thin control group.
 */
export const MIN_ENTERED_SAMPLES = 40;
export const MIN_SKIPPED_SAMPLES = 200;
/**
 * A feature must separate this well to become a rule.
 *
 * 0.35 means at least a third of the tokens they passed on fall outside the
 * band they buy in. Below that the "rule" describes tokens in general rather
 * than their choices, and acting on it would be superstition with a number
 * attached.
 */
export const MIN_SEPARATION = 0.35;

/** Snapshots kept per class. Bounded: this runs for days on a desktop. */
const MAX_SNAPSHOTS = 4_000;
/**
 * How long a snapshot stays relevant.
 *
 * Strategies drift and the market regime changes; a band learned six weeks ago
 * describes a market that no longer exists. Two weeks is long enough to gather
 * a sample and short enough to follow a change in how they trade.
 */
const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The features considered, with the labels the operator sees. */
const FEATURES: Array<{ key: keyof TokenSnapshot; label: string; unit: string }> = [
  { key: 'ageSeconds', label: 'Token age at entry', unit: 's' },
  { key: 'curveProgressPct', label: 'Bonding curve progress', unit: '%' },
  { key: 'marketCapUsd', label: 'Market cap', unit: '$' },
  { key: 'devBuySol', label: "Creator's own buy", unit: ' SOL' },
  { key: 'devHoldingsPct', label: 'Creator still holds', unit: '%' },
  { key: 'top10Pct', label: 'Top 10 holders own', unit: '%' },
  { key: 'bundledSupplyPct', label: 'Bundled supply', unit: '%' },
  { key: 'uniqueBuyers5m', label: 'Unique buyers (5m)', unit: '' },
  { key: 'buyPressurePct', label: 'Buy pressure', unit: '%' },
  { key: 'progressVelocity5m', label: 'Curve velocity (5m)', unit: 'pp' },
  { key: 'volume5mUsd', label: 'Volume (5m)', unit: '$' },
  { key: 'liquidityUsd', label: 'Liquidity', unit: '$' },
  { key: 'socialCount', label: 'Socials present', unit: '' },
  { key: 'buyerRank', label: 'Position in the buy queue', unit: 'th' },
  { key: 'curveTxRank', label: 'Trades ahead of them', unit: '' },
  { key: 'windowBuySol', label: 'SOL bought (5m, on-chain)', unit: ' SOL' },
  { key: 'windowSellSol', label: 'SOL sold (5m, on-chain)', unit: ' SOL' },
  { key: 'windowBuyPressurePct', label: 'Buy pressure (5m, on-chain)', unit: '%' },
  { key: 'windowBuyers', label: 'Distinct buyers (5m, on-chain)', unit: '' },
  { key: 'windowTradesPerMin', label: 'Trades per minute (5m, on-chain)', unit: '' },
];

export class EntryProfileLearner {
  private entered: TokenSnapshot[] = [];
  private skipped: TokenSnapshot[] = [];
  private cached: LearnedProfile | null = null;
  private listeners = new Set<() => void>();

  /**
   * A proven wallet bought this token, and it looked like this.
   *
   * Deliberately takes a snapshot rather than a mint: the features are only
   * true AT THAT MOMENT, and re-reading them later would learn what the token
   * became rather than what it was when the decision was made. That distinction
   * is the whole method.
   */
  public recordEntry(snap: TokenSnapshot): void {
    if (!snap.mint) return;
    this.push(this.entered, snap);
    this.cached = null;
    this.changed();
  }

  /**
   * A launch the proven wallets did NOT buy.
   *
   * The control group, and the half that makes the comparison mean anything. A
   * profile built only from entries would describe pump.fun tokens in general —
   * "they buy tokens with a creator and a bonding curve" — and every rule would
   * be true and useless.
   */
  public recordSkipped(snap: TokenSnapshot): void {
    if (!snap.mint) return;
    this.push(this.skipped, snap);
    this.cached = null;
    this.changed();
  }

  private push(into: TokenSnapshot[], snap: TokenSnapshot): void {
    into.push(snap);
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    let write = 0;
    for (let i = 0; i < into.length; i++) {
      if (into[i].at >= cutoff) into[write++] = into[i];
    }
    into.length = write;
    if (into.length > MAX_SNAPSHOTS) into.splice(0, into.length - MAX_SNAPSHOTS);
  }

  /** The learned profile. Recomputed when the evidence changes, cached otherwise. */
  public profile(): LearnedProfile {
    if (this.cached) return this.cached;
    this.cached = EntryProfileLearner.derive(this.entered, this.skipped);
    return this.cached;
  }

  /**
   * The comparison itself.
   *
   * Static and pure so it can be tested against hand-built distributions with
   * no engine, no clock and no files — which is what makes the rules that spend
   * money checkable.
   */
  public static derive(allEntered: TokenSnapshot[], allSkipped: TokenSnapshot[]): LearnedProfile {
    // ---- ONE MEASUREMENT METHOD AT A TIME --------------------------------
    //
    // See TokenSnapshot.source. Pooling live and backfilled snapshots makes
    // every feature separate on WHEN THE SNAPSHOT WAS TAKEN rather than on
    // what the token was, and the deriver cannot tell the difference — it
    // would report the artifact as the strongest rule it had ever found.
    //
    // So the two populations are derived from separately and the better-
    // evidenced one wins. "Better" is judged on the ENTERED side because that
    // is the scarce half; skipped tokens are free on either method.
    const bySource = (list: TokenSnapshot[], src: 'live' | 'backfill') =>
      list.filter(s => (s.source ?? 'live') === src);
    // 'live' first so a tie — including a fresh install with nothing at all —
    // resolves to the method the bot uses by default, rather than naming a
    // backfill the operator may never have run.
    const candidates = (['live', 'backfill'] as const)
      .map(src => ({ src, entered: bySource(allEntered, src), skipped: bySource(allSkipped, src) }))
      .sort((a, b) => b.entered.length - a.entered.length);
    const chosen = candidates[0];
    const entered = chosen.entered;
    const skipped = chosen.skipped;

    const base: LearnedProfile = {
      rules: [],
      enteredSamples: entered.length,
      skippedSamples: skipped.length,
      source: chosen.src,
      builtAt: Date.now(),
      usable: false,
    };

    if (entered.length < MIN_ENTERED_SAMPLES) {
      return { ...base, notReady: `only ${entered.length} observed entries (${chosen.src}); ${MIN_ENTERED_SAMPLES} needed before a band means anything` };
    }
    if (skipped.length < MIN_SKIPPED_SAMPLES) {
      return { ...base, notReady: `only ${skipped.length} observed skips (${chosen.src}); ${MIN_SKIPPED_SAMPLES} needed for the comparison to have a control group` };
    }

    const rules: FeatureRule[] = [];
    for (const f of FEATURES) {
      const inVals = numbers(entered, f.key);
      const outVals = numbers(skipped, f.key);
      // A feature most of their entries do not carry cannot be a criterion of
      // theirs — it is a gap in our data, and inventing a band from the few
      // that happen to have it would be learning our own coverage.
      if (inVals.length < MIN_ENTERED_SAMPLES * 0.6) continue;
      if (outVals.length < MIN_SKIPPED_SAMPLES * 0.3) continue;

      const sorted = [...inVals].sort((a, b) => a - b);
      const low = percentile(sorted, 10);
      const high = percentile(sorted, 90);
      const median = percentile(sorted, 50);
      // Degenerate band: every entry has the same value, so the "rule" is a
      // single point and matching it is luck rather than selection.
      if (!(high > low)) continue;

      const outside = outVals.filter(v => v < low || v > high).length;
      const separation = outVals.length ? outside / outVals.length : 0;
      if (separation < MIN_SEPARATION) continue;

      rules.push({
        feature: f.key,
        label: f.label,
        low: round4(low),
        high: round4(high),
        median: round4(median),
        skippedMedian: round4(percentile([...outVals].sort((a, b) => a - b), 50)),
        separation: Math.round(separation * 1000) / 1000,
        samples: inVals.length,
      });
    }

    rules.sort((a, b) => b.separation - a.separation);

    if (!rules.length) {
      return { ...base, notReady: 'no feature separates their entries from what they passed on — on this evidence they are not selecting on anything measurable here' };
    }
    return { ...base, rules, usable: true };
  }

  /**
   * How well a candidate matches the learned profile, 0-1, and why.
   *
   * Weighted by separation, so a feature that genuinely discriminates counts for
   * more than one that barely clears the bar. A feature the candidate has no
   * value for is SKIPPED rather than scored zero: absent data is not evidence
   * against, and scoring it as such would refuse every fresh token, which is
   * every token this is meant to catch.
   */
  public score(snap: TokenSnapshot): { score: number; matched: string[]; missed: string[]; scoredOn: number } {
    const p = this.profile();
    const matched: string[] = [];
    const missed: string[] = [];
    if (!p.usable) return { score: 0, matched, missed, scoredOn: 0 };

    let weight = 0;
    let hit = 0;
    for (const r of p.rules) {
      const v = snap[r.feature];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      weight += r.separation;
      if (v >= r.low && v <= r.high) {
        hit += r.separation;
        matched.push(`${r.label} ${fmt(v)} in ${fmt(r.low)}-${fmt(r.high)}`);
      } else {
        missed.push(`${r.label} ${fmt(v)} outside ${fmt(r.low)}-${fmt(r.high)}`);
      }
    }
    if (weight <= 0) return { score: 0, matched, missed, scoredOn: 0 };
    return {
      score: Math.round((hit / weight) * 1000) / 1000,
      matched,
      missed,
      scoredOn: matched.length + missed.length,
    };
  }

  /** The profile as sentences, for the log and the UI. */
  public describe(): string[] {
    const p = this.profile();
    if (!p.usable) return [p.notReady ?? 'not ready'];
    return p.rules.map(r =>
      `${r.label}: ${fmt(r.low)}–${fmt(r.high)} (their median ${fmt(r.median)}, `
      + `everything else ${fmt(r.skippedMedian)}) — separates ${Math.round(r.separation * 100)}%`);
  }

  public counts(): { entered: number; skipped: number } {
    return { entered: this.entered.length, skipped: this.skipped.length };
  }

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* persistence must not break learning */ }
    }
  }

  public serialize(): { version: 1; entered: TokenSnapshot[]; skipped: TokenSnapshot[] } {
    return { version: 1, entered: this.entered, skipped: this.skipped };
  }

  public restore(raw: any): number {
    if (!raw || typeof raw !== 'object') return 0;
    const clean = (arr: any): TokenSnapshot[] =>
      Array.isArray(arr)
        ? arr.filter(s => s && typeof s.mint === 'string' && Number.isFinite(s.at)).slice(-MAX_SNAPSHOTS)
        : [];
    this.entered = clean(raw.entered);
    this.skipped = clean(raw.skipped);
    this.cached = null;
    return this.entered.length + this.skipped.length;
  }

  public reset(): void {
    this.entered = [];
    this.skipped = [];
    this.cached = null;
  }
}

function numbers(rows: TokenSnapshot[], key: keyof TokenSnapshot): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Nearest-rank on a sorted array — reports a value that was actually observed. */
function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  if (Math.abs(n) >= 100) return String(Math.round(n));
  if (Math.abs(n) >= 1) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 1000) / 1000);
}

export const entryProfile = new EntryProfileLearner();

// ---------------- persistence, wired outside the class ----------------

const PROFILE_FILE = installPath('.entry-profile.json');
let pendingSave: NodeJS.Timeout | null = null;

export function saveEntryProfile(): void {
  if (pendingSave) return;
  // Debounced hard: this is research data, and losing the last half-minute of
  // it to a crash costs nothing, while writing on every observed launch would
  // put a synchronous file write behind a high-volume feed.
  pendingSave = setTimeout(() => { pendingSave = null; writeNow(); }, 30_000);
  if (typeof pendingSave.unref === 'function') pendingSave.unref();
}

export function flushEntryProfile(): void {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
  writeNow();
}

function writeNow(): void {
  try {
    const tmp = `${PROFILE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entryProfile.serialize()), 'utf8');
    fs.renameSync(tmp, PROFILE_FILE);
  } catch { /* best effort — unwritable research data must not stop trading */ }
}

export function loadEntryProfile(): number {
  try {
    return entryProfile.restore(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')));
  } catch {
    return 0;
  }
}

entryProfile.onChange(saveEntryProfile);
