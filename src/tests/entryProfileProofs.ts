/**
 * ENTRY PROFILE PROOFS — can the bot actually work out how good traders pick?
 *
 *   npx ts-node src/tests/entryProfileProofs.ts
 *
 * The operator asked for the sniper to use the same strategy the well-known
 * traders use to FIND tokens, not to wait and copy what they bought. Nobody
 * publishes their criteria, so the criteria are recovered from behaviour: what
 * did a token look like at the moment they bought it, and how does that differ
 * from the launches they passed on.
 *
 * That makes this a statistics file that spends money, which is a dangerous
 * combination. Every test below is a way the method could produce a confident
 * rule that means nothing:
 *
 *   - a band learned from three samples
 *   - a "rule" both groups sit inside, which describes tokens in general
 *   - a feature only our own data coverage explains
 *   - a candidate scored as a perfect match on no features at all
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EntryProfileLearner, MIN_ENTERED_SAMPLES, MIN_SKIPPED_SAMPLES, MIN_SEPARATION,
  type TokenSnapshot,
} from '../services/entryProfile';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/**
 * NOW, not a fixed epoch. Snapshots older than the profile's TTL are pruned on
 * insert — correctly, because a strategy learned six weeks ago describes a
 * market that no longer exists. A fixture dated 2023 is therefore discarded
 * the instant it is recorded, and every test built on it fails for a reason
 * that has nothing to do with what it is testing. (Found the hard way.)
 */
const T0 = Date.now() - 60_000;

/** n snapshots whose feature values are drawn evenly across [lo, hi]. */
function band(n: number, key: keyof TokenSnapshot, lo: number, hi: number, extra: Partial<TokenSnapshot> = {}): TokenSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    mint: `M${key}${lo}_${i}`,
    at: T0 + i,
    [key]: lo + ((hi - lo) * i) / Math.max(1, n - 1),
    ...extra,
  })) as TokenSnapshot[];
}

console.log('\n-- It refuses to have an opinion without evidence --');

test('a fresh install has no profile and says why', () => {
  const l = new EntryProfileLearner();
  const p = l.profile();
  assert.strictEqual(p.usable, false);
  assert.ok(/observed entries/.test(p.notReady ?? ''), p.notReady);
  assert.deepStrictEqual(p.rules, []);
});

test('A BAND FROM THREE SAMPLES IS NOT A RULE', () => {
  // The single most likely way this method produces confident nonsense: three
  // tokens happen to share a property and it becomes a criterion.
  const l = new EntryProfileLearner();
  for (const s of band(3, 'ageSeconds', 40, 60)) l.recordEntry(s);
  for (const s of band(500, 'ageSeconds', 0, 3000)) l.recordSkipped(s);
  const p = l.profile();
  assert.strictEqual(p.usable, false, 'three entries must never produce a usable profile');
  assert.ok(/3 observed entries/.test(p.notReady ?? ''), p.notReady);
});

test('entries without a control group prove nothing either', () => {
  // A profile built only from their buys would say "they buy tokens with a
  // creator and a bonding curve" — every rule true, every rule useless.
  const l = new EntryProfileLearner();
  for (const s of band(200, 'ageSeconds', 40, 60)) l.recordEntry(s);
  const p = l.profile();
  assert.strictEqual(p.usable, false);
  assert.ok(/control group/.test(p.notReady ?? ''), p.notReady);
});

console.log('\n-- It finds a real preference, and reports it in plain numbers --');

test('a genuine preference becomes a readable rule', () => {
  // They buy at 30-90s old; the market at large is 0-3000s. That is a real,
  // recoverable criterion.
  const l = new EntryProfileLearner();
  for (const s of band(120, 'ageSeconds', 30, 90)) l.recordEntry(s);
  for (const s of band(600, 'ageSeconds', 0, 3000)) l.recordSkipped(s);
  const p = l.profile();
  assert.strictEqual(p.usable, true, p.notReady);
  const rule = p.rules.find(r => r.feature === 'ageSeconds');
  assert.ok(rule, 'the age preference must be found');
  assert.ok(rule!.low >= 30 && rule!.high <= 90, `band ${rule!.low}-${rule!.high} should sit inside 30-90`);
  assert.ok(rule!.separation > 0.9, `a strong preference should separate strongly, got ${rule!.separation}`);
  assert.ok(rule!.median > 30 && rule!.median < 90);

  const lines = l.describe();
  assert.ok(lines.some(t => /Token age at entry/.test(t)), lines.join(' | '));
  assert.ok(lines.some(t => /separates \d+%/.test(t)), 'the description must state how well it separates');
});

test('A FEATURE BOTH GROUPS SHARE IS NOT A CRITERION', () => {
  // This is the trap that makes naive versions of this idea worthless. Every
  // pump.fun token has a market cap around the same place at launch; "they buy
  // tokens with a market cap" is true of everything and selects nothing.
  const l = new EntryProfileLearner();
  for (const s of band(120, 'marketCapUsd', 5000, 7000)) l.recordEntry(s);
  for (const s of band(600, 'marketCapUsd', 5000, 7000)) l.recordSkipped(s);
  const p = l.profile();
  assert.ok(!p.rules.some(r => r.feature === 'marketCapUsd'),
    'a feature that does not distinguish the two groups must be discarded, not dressed up as a rule');
});

test('a weak preference is discarded rather than reported at low confidence', () => {
  // Half-overlapping distributions. Below the separation floor this is noise,
  // and a "rule" here would be superstition with a number attached.
  const l = new EntryProfileLearner();
  for (const s of band(120, 'top10Pct', 10, 40)) l.recordEntry(s);
  for (const s of band(600, 'top10Pct', 5, 45)) l.recordSkipped(s);
  const rule = l.profile().rules.find(r => r.feature === 'top10Pct');
  if (rule) {
    assert.ok(rule.separation >= MIN_SEPARATION,
      `a reported rule must clear the separation floor, got ${rule.separation}`);
  }
});

test('rules are ordered by how much they actually discriminate', () => {
  const l = new EntryProfileLearner();
  const entries: TokenSnapshot[] = [];
  for (let i = 0; i < 150; i++) {
    entries.push({
      mint: `E${i}`, at: T0 + i,
      ageSeconds: 40 + (i % 20),            // very tight — strong signal
      buyPressurePct: 50 + (i % 40),        // broad — weak signal
    });
  }
  for (const e of entries) l.recordEntry(e);
  for (let i = 0; i < 600; i++) {
    l.recordSkipped({ mint: `S${i}`, at: T0 + i, ageSeconds: (i * 7) % 3000, buyPressurePct: 30 + (i % 60) });
  }
  const p = l.profile();
  assert.ok(p.usable, p.notReady);
  for (let i = 1; i < p.rules.length; i++) {
    assert.ok(p.rules[i - 1].separation >= p.rules[i].separation,
      'the strongest discriminator must come first — it is what the operator reads');
  }
});

test('A FEATURE WE RARELY CAPTURE IS OUR GAP, NOT THEIR CRITERION', () => {
  // Holder data is unavailable for a token seconds old. If only four entries
  // carry devHoldingsPct, a band built from those four describes our data
  // coverage and nothing about how they choose.
  const l = new EntryProfileLearner();
  const entries = band(120, 'ageSeconds', 30, 90);
  for (let i = 0; i < 4; i++) entries[i].devHoldingsPct = 2 + i;
  for (const s of entries) l.recordEntry(s);
  for (const s of band(600, 'ageSeconds', 0, 3000, { devHoldingsPct: 20 })) l.recordSkipped(s);
  assert.ok(!l.profile().rules.some(r => r.feature === 'devHoldingsPct'),
    'a feature present on a handful of entries must not become a rule');
});

test('a degenerate band — every entry identical — is not a rule', () => {
  const l = new EntryProfileLearner();
  for (const s of band(120, 'socialCount', 1, 1)) l.recordEntry(s);
  for (const s of band(600, 'socialCount', 0, 4)) l.recordSkipped(s);
  assert.ok(!l.profile().rules.some(r => r.feature === 'socialCount'),
    'a single-point band is matched by luck, not by selection');
});

console.log('\n-- Scoring a candidate against the profile --');

function trained(): EntryProfileLearner {
  const l = new EntryProfileLearner();
  for (let i = 0; i < 150; i++) {
    l.recordEntry({ mint: `E${i}`, at: T0 + i, ageSeconds: 40 + (i % 20), curveProgressPct: 8 + (i % 10) });
  }
  for (let i = 0; i < 600; i++) {
    l.recordSkipped({ mint: `S${i}`, at: T0 + i, ageSeconds: (i * 7) % 3000, curveProgressPct: (i * 3) % 95 });
  }
  return l;
}

test('a token inside every band scores 1 and says which rules it matched', () => {
  const l = trained();
  const r = l.score({ mint: 'X', at: T0, ageSeconds: 50, curveProgressPct: 12 });
  assert.strictEqual(r.score, 1);
  assert.ok(r.matched.length >= 2, r.matched.join(' | '));
  assert.strictEqual(r.missed.length, 0);
});

test('a token outside every band scores 0 and says why', () => {
  const l = trained();
  const r = l.score({ mint: 'X', at: T0, ageSeconds: 2500, curveProgressPct: 80 });
  assert.strictEqual(r.score, 0);
  assert.ok(r.missed.length >= 2, r.missed.join(' | '));
  assert.ok(/outside/.test(r.missed[0]), r.missed[0]);
});

test('MISSING DATA IS NOT EVIDENCE AGAINST', () => {
  // A token seconds old has no holder data, no volume and no socials. Scoring
  // an absent feature as a miss would refuse every fresh launch — which is the
  // entire population this exists to catch.
  const l = trained();
  const r = l.score({ mint: 'X', at: T0, ageSeconds: 50 });   // curve unknown
  assert.strictEqual(r.score, 1, 'the one known feature matched, so the score is 1');
  assert.strictEqual(r.scoredOn, 1, 'and it must report that it judged on one feature only');
});

test('A SCORE OF 1 ON ZERO FEATURES IS NOT A MATCH', () => {
  // The dangerous corner of the rule above: a token with none of the profile's
  // features known must not come back as a perfect match. It comes back as
  // nothing known.
  const l = trained();
  const r = l.score({ mint: 'X', at: T0 });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.scoredOn, 0, 'the caller must be able to tell "no match" from "nothing to judge"');
});

test('an unusable profile scores nothing, whatever it is shown', () => {
  const l = new EntryProfileLearner();
  for (const s of band(5, 'ageSeconds', 40, 60)) l.recordEntry(s);
  const r = l.score({ mint: 'X', at: T0, ageSeconds: 50 });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.scoredOn, 0);
});

console.log('\n-- Memory, persistence and drift --');

test('snapshots are bounded — this runs for days on a desktop', () => {
  const l = new EntryProfileLearner();
  for (let i = 0; i < 9000; i++) l.recordSkipped({ mint: `S${i}`, at: T0 + i, ageSeconds: i });
  assert.ok(l.counts().skipped <= 4000, `unbounded growth: ${l.counts().skipped}`);
});

test('STALE EVIDENCE AGES OUT — a strategy learned six weeks ago is fiction', () => {
  const l = new EntryProfileLearner();
  const ancient = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (let i = 0; i < 100; i++) l.recordEntry({ mint: `Old${i}`, at: ancient + i, ageSeconds: 50 });
  assert.strictEqual(l.counts().entered, 0,
    'evidence past the TTL is dropped on insert, including the snapshot that triggered the prune');

  // And fresh evidence alongside it survives, so ageing is not just deletion.
  l.recordEntry({ mint: 'Fresh', at: Date.now(), ageSeconds: 50 });
  assert.strictEqual(l.counts().entered, 1, 'current evidence must be kept');
});

test('a saved profile restores its evidence, and junk restores nothing', () => {
  const l = trained();
  const blob = JSON.parse(JSON.stringify(l.serialize()));
  const l2 = new EntryProfileLearner();
  assert.ok(l2.restore(blob) > 0);
  assert.strictEqual(l2.profile().usable, true);
  for (const junk of [null, 42, 'no', {}, { entered: 'x', skipped: 7 }, { entered: [null, 3] }]) {
    const l3 = new EntryProfileLearner();
    assert.strictEqual(l3.restore(junk as any), 0);
    assert.strictEqual(l3.profile().usable, false);
  }
});

console.log('\n-- The thresholds are stated, not buried --');

test('the evidence floors are real numbers a reviewer can argue with', () => {
  assert.ok(MIN_ENTERED_SAMPLES >= 30, `${MIN_ENTERED_SAMPLES} entries is too few for a percentile band`);
  assert.ok(MIN_SKIPPED_SAMPLES > MIN_ENTERED_SAMPLES,
    'the control group is free — there is no reason to accept a thin one');
  assert.ok(MIN_SEPARATION >= 0.3 && MIN_SEPARATION < 1,
    `${MIN_SEPARATION} must demand real discrimination without demanding perfection`);
});

test('percentiles are nearest-rank, so a band edge is a value that occurred', () => {
  const src = readFileSync(join(__dirname, '..', 'services', 'entryProfile.ts'), 'utf8');
  assert.ok(/Nearest-rank on a sorted array/.test(src),
    'an interpolated percentile invents a band edge no token ever had');
  assert.ok(/Math\.ceil\(\(p \/ 100\) \* sorted\.length\)/.test(src));
});

test('the file admits what it cannot learn', () => {
  // This is a descriptive method sold as a strategy, and the difference matters
  // enough to be written where the next reader will find it.
  const src = readFileSync(join(__dirname, '..', 'services', 'entryProfile.ts'), 'utf8');
  assert.ok(/DESCRIPTIVE, NOT CAUSAL/.test(src), 'the correlation/causation limit must be stated');
  assert.ok(/MECHANICAL PART ONLY/.test(src), 'and that it cannot learn what is not in a feature vector');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
