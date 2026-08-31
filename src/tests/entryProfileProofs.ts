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
import {
  routePlay, playbookConfigFor, PROFILE_MIN_SCORE, PROFILE_MIN_RULES, bondingProgressPct,
} from '../services/playbookRouter';

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


// ---------------------------------------------------------------------------
// THE PROFILE AS AN ENTRY REASON
//
// Everything above proves the profile is honest about what it knows. This
// section proves the sniper acts on it — which is the whole point of the ask.
// The confluence lane buys what a proven wallet just bought, always second.
// This buys what the profile says they WOULD buy, found by us, with nobody
// having to move first.
// ---------------------------------------------------------------------------
console.log('\n-- The learned profile can trigger an entry on its own --');

/** A mid-curve token the generic proxies refuse: real, unremarkable, no demand yet. */
function midCurve(extra: Record<string, unknown> = {}): any {
  return {
    ageSeconds: 3600, isMigrationEvent: false, vSolInBondingCurve: 70, hasDexPair: false,
    score: 60, marketCapUsd: 40000, liquidityUsd: 20000, volume5mUsd: 8000,
    uniqueBuyers5m: 0, buyPressurePct: 0, solPriceUsd: 200,
    ...extra,
  };
}

test('a strong profile match is an entry reason with nobody buying first', () => {
  // The ask, restated as a test: the sniper finds the token itself.
  const cfg = playbookConfigFor('strict');
  assert.strictEqual(routePlay(midCurve(), cfg).eligible, false,
    'a score-60 token with no demand evidence is refused, as it should be');
  const matched = routePlay(midCurve({ profileMatch: { score: 0.92, scoredOn: 6 } }), cfg);
  assert.strictEqual(matched.eligible, true,
    'a token matching what the proven wallets select on is an entry, with no wallet buying it');
  assert.strictEqual(matched.play, 'PLAY_2');
});

test('A MATCH ON TWO RULES IS NOT A MATCH', () => {
  // The failure this guards is subtle and would look like success: a fresh
  // token has values for very few features, so it can score a perfect 1.0 on
  // the two rules it happens to be scoreable on. That is not agreement with
  // the strategy, it is a small sample dressed as certainty.
  const cfg = playbookConfigFor('strict');
  assert.ok(PROFILE_MIN_RULES >= 3, 'fewer than three rules cannot describe a selection');
  const thin = routePlay(midCurve({ profileMatch: { score: 1, scoredOn: PROFILE_MIN_RULES - 1 } }), cfg);
  assert.strictEqual(thin.eligible, false, '100% of two rules is not the profile agreeing');
});

test('a near miss is refused, and the refusal says how near', () => {
  const cfg = playbookConfigFor('strict');
  const near = routePlay(midCurve({ profileMatch: { score: PROFILE_MIN_SCORE - 0.05, scoredOn: 6 } }), cfg);
  assert.strictEqual(near.eligible, false);
  const why = near.reasons.join(' ');
  assert.ok(/[Ll]earned-profile match/.test(why), 'the operator must see that the profile was consulted');
  assert.ok(/on 6 rules/.test(why), 'and how much evidence the token actually offered');
});

test('THE PROFILE SUBSTITUTES FOR DEMAND EVIDENCE ONLY — never for a phase rule', () => {
  // Same line the quorum is held to. A profile match says "this looks like the
  // tokens they buy". It says nothing about the insider exit window or the
  // rug density of the early curve, which are facts about the token, so it may
  // not pass either of them. A learned rule that could unlock block-0 would be
  // a second door into the wallet.
  const cfg = playbookConfigFor('strict');
  const perfect = { score: 1, scoredOn: 9 };
  const blockZero = routePlay(midCurve({ ageSeconds: 10, profileMatch: perfect }), cfg);
  assert.strictEqual(blockZero.phase, 'BLOCK_0');
  assert.strictEqual(blockZero.eligible, false, 'the insider window is not negotiable by statistics');
  const early = routePlay(midCurve({ vSolInBondingCurve: 33, profileMatch: perfect }), cfg);
  assert.strictEqual(early.phase, 'EARLY_CURVE');
  assert.strictEqual(early.eligible, false, '~70% of these die on day one, however well they match');
});

test('the profile does not lower the safety reasons a token still has to clear', () => {
  // A match must not paper over a stated problem. Anything already in
  // `reasons` for a non-demand cause survives it.
  const cfg = playbookConfigFor('strict');
  const late = routePlay(midCurve({ vSolInBondingCurve: 105, profileMatch: { score: 1, scoredOn: 9 } }), cfg);
  assert.strictEqual(late.eligible, false, 'the late-curve refusal is about the curve, not about demand');
  assert.ok(late.reasons.length > 0, 'and it still explains itself');
});

console.log('\n-- The engine feeds it, screens against it, and cannot be told to lie --');

function engineSrc(): string {
  return readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');
}
/** Source with comments stripped: prose about a rule is not the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

test('EVERY screened token is recorded, on one side or the other', () => {
  // Entries alone would teach the bot that good traders buy tokens with a
  // creator and a bonding curve. The launches they passed on are what make the
  // comparison say anything, and they are free — the bot sees every one.
  const src = code(engineSrc());
  const idx = src.indexOf('const snapshot = this.snapshotFor(mint, launchData);');
  assert.ok(idx > 0, 'the learner must be fed from the screening path');
  const body = src.slice(idx, idx + 300);
  assert.ok(/entryProfile\.recordEntry\(snapshot\)/.test(body), 'tokens a proven wallet is buying are the entries');
  assert.ok(/entryProfile\.recordSkipped\(snapshot\)/.test(body), 'and everything else is the control group');
  assert.ok(/this\.pendingSmartMoney\.has\(mint\)/.test(body),
    'the label must come from a quorum the detector formed, not from the payload');
});

test('THE SNAPSHOT IS TAKEN AFTER ENRICHMENT, NOT BEFORE', () => {
  // A feature vector read before the enrichment calls return is mostly
  // undefined, and undefined values are skipped rather than scored — so the
  // profile would silently be learned from two or three fields and look fine.
  const src = code(engineSrc());
  const enriched = src.indexOf("latencyTimeline.stamp(mint, 't3FiltersDoneMs')");
  const recorded = src.indexOf('const snapshot = this.snapshotFor(mint, launchData);');
  assert.ok(enriched > 0 && recorded > 0);
  assert.ok(recorded > enriched, 'the vector is only true once enrichment has completed');
});

test('OLD BUG: the learner recorded curve progress on its own scale', () => {
  // Shipped in the previous commit. snapshotFor inlined `(vSol - 30) / 55`
  // while the whole rest of the repo divides by GRADUATION_SOL = 85. A token
  // the router placed at 50% up the curve was filed by the learner at 77%.
  // The band was therefore unreadable against the router's own phase
  // boundaries, and — the reason it matters now — a snapshot rebuilt from
  // chain history sits on the canonical axis, so mixing the two populations
  // would have widened every curve-progress band with pure unit error.
  const src = engineSrc();
  const idx = src.indexOf('private snapshotFor(');
  const body = src.slice(idx, idx + 1800);
  assert.ok(/curveProgressPct: bondingProgressPct\(/.test(body),
    'the shared function is the only definition of where a token sits on the curve');
  assert.ok(!/\/ 55\)/.test(body), 'the local formula must be gone, not merely shadowed');
  // And the shared function is the one the router routes on.
  assert.strictEqual(bondingProgressPct(30 + 85 / 2), 50, 'half the graduation raise is 50%');
  assert.strictEqual(bondingProgressPct(30), 0);
});

test('an asserted liquidity figure is never learned from', () => {
  // The migration constant is identical on every migration, so a band built on
  // it would look like a razor-sharp criterion and be a property of our own
  // code. This is the one place a fabricated number could become a "rule".
  const src = engineSrc();
  const idx = src.indexOf('private snapshotFor(');
  const body = src.slice(idx, idx + 1800);
  assert.ok(/liquidityUsd: asserted \? undefined :/.test(body),
    'an asserted figure must be withheld from the learner, not passed through');
  assert.ok(/hasLiveMarketData \? measured\(launchData\.volume5mUsd\)/.test(body),
    'and volume without a live market is not a measurement either');
});

test('the profile score is computed from engine state and gated on the lane flag', () => {
  const src = code(engineSrc());
  const idx = src.indexOf('const profileMatch = ');
  assert.ok(idx > 0, 'the router must be given a profile score');
  const body = src.slice(idx, idx + 300);
  assert.ok(/featureFlags\.get\('smartMoneySniper'\)/.test(body),
    'the profile lane is the same strategy and ships behind the same flag');
  assert.ok(/entryProfile\.score\(this\.snapshotFor\(/.test(body),
    'scored from the engine’s own snapshot, never from a field on the payload');
});

test('A SCORE ON ZERO RULES IS NOT SENT TO THE ROUTER AS A ZERO', () => {
  // scoredOn 0 means "nothing could be evaluated", which is not the same as
  // "matched nothing". Passing it through as { score: 0 } would be indistinct
  // from a token that failed every rule, and the router's refusal message would
  // report a criterion it never applied.
  const src = code(engineSrc());
  const idx = src.indexOf('profileMatch: { score: profileMatch.score');
  assert.ok(idx > 0, 'the router input must carry both the score and its basis');
  const body = src.slice(Math.max(0, idx - 200), idx + 200);
  assert.ok(/profileMatch && profileMatch\.scoredOn > 0/.test(body),
    'an unevaluable score must be omitted rather than sent as 0');
});

console.log('\n-- The operator can read what the bot decided the strategy is --');

function serverSrc(): string {
  return readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
}

test('the evidence survives a restart', () => {
  // 40 entries at a handful of smart entries a day is weeks of observation.
  // Dropping it on every restart would mean the profile never becomes usable
  // at all, and a restart is a routine thing an operator does.
  const src = serverSrc();
  assert.ok(/loadEntryProfile\(\)/.test(src), 'the profile must be restored at boot');
  assert.ok(/flushEntryProfile\(\)/.test(src), 'and flushed on the way out');
  const shutdown = src.slice(src.indexOf('flushWalletLedger(); } catch'));
  assert.ok(/flushEntryProfile\(\); } catch/.test(shutdown),
    'flushed in the shutdown path beside the ledger, not only on a debounce timer');
});

test('the endpoint reports the derived rules and the evidence behind them', () => {
  const src = serverSrc();
  const idx = src.indexOf("app.get('/api/entry-profile'");
  assert.ok(idx > 0, 'the derived strategy must be readable');
  const body = src.slice(idx, src.indexOf('});', idx) + 3);
  for (const field of ['rules', 'separation', 'enteredSamples', 'skippedSamples', 'notReady', 'skippedMedian']) {
    assert.ok(body.includes(field), `${field} is part of judging whether a rule means anything`);
  }
});

test('THE PANEL QUOTES THE REAL THRESHOLDS, IT DOES NOT RESTATE THEM', () => {
  // A UI that hardcodes "needs 75%" beside a router that has moved to 0.8 is
  // worse than no UI: it reports a rule the bot is not following. The endpoint
  // must import the router's own constants.
  const src = serverSrc();
  assert.ok(/import \{ PROFILE_MIN_RULES, PROFILE_MIN_SCORE \} from '\.\/services\/playbookRouter'/.test(src),
    'the thresholds must come from the module that enforces them');
  assert.ok(/minScore: PROFILE_MIN_SCORE/.test(src) && /minRules: PROFILE_MIN_RULES/.test(src),
    'and be surfaced as those values, not as literals that drift');
});

test('the panel shows the not-ready state instead of fabricating rules', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('function EntryProfileSection()');
  assert.ok(idx > 0, 'the learned profile needs a panel of its own');
  const body = app.slice(idx);
  assert.ok(/!ep\.usable/.test(body), 'an unusable profile must render as unusable');
  assert.ok(/notReady/.test(body), 'and say exactly why, verbatim from the deriver');
  assert.ok(/needEntered/.test(body) && /needSkipped/.test(body),
    'with the distance to usable, so waiting reads as progress rather than as a broken feature');
  assert.ok(/separation/.test(body), 'and the discrimination behind each rule, not just the band');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
