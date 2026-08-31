/**
 * SMART-MONEY PROOFS — the rules that decide whose trades our money follows.
 *
 *   npx ts-node src/tests/smartMoneyProofs.ts
 *
 * The ask was to snipe what proven traders buy, naming a couple of well-known
 * ones. The implementation deliberately holds NO addresses: a pasted list
 * cannot be verified, decays silently as traders rotate wallets, and says
 * nothing about whether a famous wallet is profitable this week. Instead the
 * bot gathers evidence from chain history and promotes a wallet only when its
 * own record clears a bar.
 *
 * That makes the promotion rules the thing standing between a stranger's
 * transaction and our wallet, so they get the adversarial tests. Every case
 * below is a way a wallet could look good without being good.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WalletLedger, DEFAULT_PROMOTION_THRESHOLDS } from '../services/walletLedger';
import { WalletHarvester, HARVESTER_LIMITS, bondingCurveFor } from '../services/walletHarvester';
import { SmartMoneyDetector, DEFAULT_CONFLUENCE } from '../services/smartMoneySignal';
import { pessimisticRate } from '../services/walletLedger';
import { routePlay, playbookConfigFor } from '../services/playbookRouter';

let passed = 0;
let failed = 0;
const pending: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    pending.push({ name, fn: fn as () => Promise<void> });
    return;
  }
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** Read once, near the top: a `const` arrow used above its declaration is a TDZ error, not a miss. */
const engineSrc = () => readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');

const W = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const T0 = 1_700_000_000_000;

/** A wallet with `n` closed round trips, `wins` of them profitable. */
function withRecord(l: WalletLedger, addr: string, n: number, wins: number, pnlPerWin = 0.5, lossPerLoss = 0.2): void {
  for (let i = 0; i < n; i++) {
    const mint = `Mint${i}`;
    l.recordBuy(addr, mint, 1, T0 + i * 1000);
    const profitable = i < wins;
    l.recordSell(addr, mint, profitable ? 1 + pnlPerWin : 1 - lossPerLoss, T0 + i * 1000 + 60_000);
  }
}

console.log('\n-- Nothing is followed without evidence --');

test('a brand-new wallet is a candidate, never promoted', () => {
  const l = new WalletLedger();
  l.recordBuy(W, 'MintX', 1, T0);
  l.reevaluate(T0 + 1000);
  assert.strictEqual(l.get(W)!.state, 'candidate');
  assert.deepStrictEqual(l.promotedAddresses(), []);
});

test('A LUCKY STREAK IS NOT A RECORD', () => {
  // Three wins out of three is a 100% win rate and means nothing — it is the
  // single most common way a screening rule promotes noise. The bar needs a
  // sample before a rate is allowed to say anything.
  const l = new WalletLedger();
  withRecord(l, W, 3, 3, 2);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get(W)!.state, 'observed',
    'a perfect record over three trades must not be enough to spend money on');
  const s = l.score(W)!;
  assert.strictEqual(s.winRate, 1);
  // Discounted well below the raw rate: with almost no evidence the score is
  // pulled toward "no opinion" rather than reported as certainty.
  assert.ok(s.conviction! < 0.7,
    `conviction must be discounted by sample size, got ${s.conviction}`);
  assert.ok(s.conviction! < s.winRate!, 'and it must never exceed the rate it is derived from');
});

test('a real record promotes', () => {
  const l = new WalletLedger();
  withRecord(l, W, 12, 9, 0.5, 0.2);   // 75% win rate, +4.5 -0.6 = +3.9 SOL
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get(W)!.state, 'promoted');
  assert.deepStrictEqual(l.promotedAddresses(), [W]);
});

test('WINNING OFTEN IS NOT THE SAME AS MAKING MONEY', () => {
  // Nine small wins and three large losses is a 75% win rate and a losing
  // wallet. A rule that looked only at the rate would follow it.
  const l = new WalletLedger();
  withRecord(l, W, 12, 9, 0.05, 1.0);   // +0.45 SOL of wins, -3.0 SOL of losses
  l.reevaluate(T0 + 10_000);
  const s = l.score(W)!;
  assert.ok(s.winRate! >= 0.7, 'the win rate looks excellent');
  assert.ok(s.realizedPnlSol < 0, 'and the wallet is down');
  assert.strictEqual(l.get(W)!.state, 'demoted',
    'realized PnL must be able to veto a flattering win rate');
});

test('A GOOD WIN RATE THAT BARELY MAKES MONEY IS NOT PROMOTED', () => {
  // Distinct from the demotion case above. This wallet is not LOSING — it is
  // up 0.15 SOL over twelve trades at a 75% win rate, so nothing about it is
  // alarming and the demote floor never fires. It is simply not worth
  // following: scalping a few hundredths of a SOL nine times out of twelve is
  // a record a copier cannot profit from once the price impact of copying is
  // taken out. Promotion needs a realized figure, not just a rate.
  const l = new WalletLedger();
  withRecord(l, W, 12, 9, 0.05, 0.10);   // +0.45 of wins, -0.30 of losses = +0.15
  l.reevaluate(T0 + 10_000);
  const s = l.score(W)!;
  assert.ok(s.winRate! >= 0.7, `win rate should look good, got ${s.winRate}`);
  assert.ok(s.realizedPnlSol > 0, `and the wallet is up, got ${s.realizedPnlSol}`);
  assert.ok(s.realizedPnlSol < DEFAULT_PROMOTION_THRESHOLDS.minRealizedPnlSol,
    'but below the promotion floor');
  assert.strictEqual(l.get(W)!.state, 'observed',
    'a flattering rate with no money behind it must not clear the bar');
});

console.log('\n-- Being early to winners is a separate, weaker-but-real route in --');

test('a wallet with no closed trades can still earn promotion by finding winners', () => {
  // A trader can be excellent at finding tokens and mediocre at selling them,
  // and only the first half is what a sniper copies — we bring our own exits.
  // This route exists so such a wallet is not invisible.
  const l = new WalletLedger();
  for (let i = 0; i < 5; i++) l.recordEarlyCall(W, `Mint${i}`, true, T0);
  for (let i = 0; i < 3; i++) l.recordEarlyCall(W, `Dud${i}`, false, T0);
  l.reevaluate(T0 + 1000);
  assert.strictEqual(l.get(W)!.state, 'promoted');
  assert.strictEqual(l.score(W)!.earlyHitRate, 5 / 8);
});

test('APPEARING EARLY OFTEN IS NOT SKILL — the ratio is what counts', () => {
  // A high-frequency bot buys the first block of everything. It will rack up
  // early-on-winner credits purely by volume. Crediting only winners would
  // promote it; the losers are what expose it.
  const l = new WalletLedger();
  for (let i = 0; i < 8; i++) l.recordEarlyCall(W, `Win${i}`, true, T0);
  for (let i = 0; i < 200; i++) l.recordEarlyCall(W, `Dud${i}`, false, T0);
  l.reevaluate(T0 + 1000);
  assert.ok(l.get(W)!.earlyOnWinners >= DEFAULT_PROMOTION_THRESHOLDS.minEarlyOnWinners,
    'it cleared the raw winner count');
  assert.strictEqual(l.get(W)!.state, 'observed',
    'but a 4% hit rate must not be promoted — this is the buy-everything bot');
});

console.log('\n-- Demotion, and the ways a wallet stops deserving to be followed --');

test('SILENCE IS A DEMOTION', () => {
  // A wallet we have not heard from in days has stopped, rotated, or been
  // abandoned, and we cannot tell which. Its next signal is not one to spend on.
  const l = new WalletLedger();
  withRecord(l, W, 12, 9);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get(W)!.state, 'promoted');

  // Measured from the record's OWN last activity, not from T0 — withRecord
  // advances lastSeenAt as it closes trades, and an offset from T0 left the
  // wallet a few seconds short of stale.
  const later = l.get(W)!.lastSeenAt + DEFAULT_PROMOTION_THRESHOLDS.staleAfterMs + 1000;
  const changes = l.reevaluate(later);
  assert.strictEqual(l.get(W)!.state, 'demoted');
  assert.ok(/no activity/.test(changes.find(c => c.address === W)!.reason));
});

test('a wallet that goes cold is demoted on its record, not on a human noticing', () => {
  const l = new WalletLedger();
  withRecord(l, W, 12, 9);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get(W)!.state, 'promoted');

  // Ten straight losses after promotion.
  for (let i = 0; i < 10; i++) {
    l.recordBuy(W, `Cold${i}`, 1, T0 + 20_000 + i);
    l.recordSell(W, `Cold${i}`, 0.4, T0 + 30_000 + i);
  }
  l.reevaluate(T0 + 40_000);
  assert.strictEqual(l.get(W)!.state, 'demoted');
});

test('a demoted wallet is kept, not deleted — its history is why it was demoted', () => {
  const l = new WalletLedger();
  withRecord(l, W, 12, 2);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get(W)!.state, 'demoted');
  assert.ok(l.get(W)!.closedTrades === 12,
    'deleting it would let the same wallet come back as a stranger with a clean slate');
});

console.log('\n-- The accounting refuses to invent numbers --');

test('AN UNMATCHED SELL IS DROPPED, NEVER GUESSED', () => {
  // A sell of a bag we never saw bought has no cost basis. Assuming one
  // manufactures a win rate out of nothing — and every wallet the harvester
  // finds mid-life will have exactly this shape.
  const l = new WalletLedger();
  assert.strictEqual(l.recordSell(W, 'NeverBought', 5, T0), false);
  assert.strictEqual(l.get(W), undefined, 'a stray sell must not even create a record');

  l.recordBuy(W, 'Real', 1, T0);
  assert.strictEqual(l.recordSell(W, 'Other', 9, T0 + 1), false, 'the mint must match');
  assert.strictEqual(l.get(W)!.closedTrades, 0);
  assert.strictEqual(l.get(W)!.realizedPnlSol, 0);
});

test('a second sell of the same bag does not double-count', () => {
  const l = new WalletLedger();
  l.recordBuy(W, 'M', 1, T0);
  assert.strictEqual(l.recordSell(W, 'M', 2, T0 + 1), true);
  assert.strictEqual(l.recordSell(W, 'M', 2, T0 + 2), false, 'the trade is already closed');
  assert.strictEqual(l.get(W)!.closedTrades, 1);
});

test('nonsense inputs are refused rather than stored', () => {
  const l = new WalletLedger();
  l.recordBuy(W, 'M', NaN, T0);
  l.recordBuy(W, 'M', -1, T0);
  l.recordBuy('', 'M', 1, T0);
  assert.strictEqual(l.size(), 0);
});

test('conviction weighs the two kinds of evidence by how much of each there is', () => {
  const many = new WalletLedger();
  withRecord(many, W, 40, 25);                       // 62.5% over 40
  const few = new WalletLedger();
  withRecord(few, W, 3, 3);                          // 100% over 3
  assert.ok(many.score(W)!.conviction! > few.score(W)!.conviction!,
    'forty trades at 62% must outrank three at 100%');
});

console.log('\n-- The ladder, the cap, and the operator override --');

test('the promoted set is capped, and keeps the BEST rather than the first seen', () => {
  const l = new WalletLedger();
  l.setThresholds({ maxPromoted: 2 });
  // Three qualifying wallets of clearly different quality.
  withRecord(l, 'GoodAAA', 20, 18);
  withRecord(l, 'MidAAAA', 20, 12);
  withRecord(l, 'BestAAA', 40, 38);
  l.reevaluate(T0 + 50_000);
  const promoted = l.promotedAddresses().sort();
  assert.strictEqual(promoted.length, 2, `cap not honoured: ${promoted.join(',')}`);
  assert.ok(promoted.includes('BestAAA'), 'the strongest wallet must survive the cap');
  assert.ok(!promoted.includes('MidAAAA'), 'the weakest qualifier is the one dropped');
});

test('the operator can pin a wallet on or off, and the ladder respects it', () => {
  const l = new WalletLedger();
  l.recordBuy(W, 'M', 1, T0);
  l.pin(W, 'always', T0 + 1);
  assert.strictEqual(l.get(W)!.state, 'promoted', 'an explicit decision outranks the evidence');

  withRecord(l, 'ProvenA', 12, 9);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get('ProvenA')!.state, 'promoted');
  l.pin('ProvenA', 'never', T0 + 11_000);
  assert.strictEqual(l.get('ProvenA')!.state, 'demoted', 'and it outranks it in both directions');
});

test('ONLY promoted wallets are ever handed out as followable', () => {
  const l = new WalletLedger();
  withRecord(l, 'ProvenA', 12, 9);
  withRecord(l, 'WeakAAA', 12, 2);
  l.recordBuy('NewAAAA', 'M', 1, T0);
  l.reevaluate(T0 + 10_000);
  assert.deepStrictEqual(l.promotedAddresses(), ['ProvenA'],
    'the followable set is the one thing that must never leak an unproven wallet');
});

test('a promoted wallet is never evicted by the size cap', () => {
  const l = new WalletLedger();
  withRecord(l, 'ProvenA', 12, 9);
  l.reevaluate(T0);
  assert.strictEqual(l.get('ProvenA')!.state, 'promoted');
  // Flood past the cap with worthless records.
  for (let i = 0; i < 6000; i++) l.recordBuy(`Noise${i}`, 'M', 1, T0 + i);
  assert.ok(l.get('ProvenA'), 'evicting it would silently stop following a wallet that earned its place');
  assert.ok(l.size() <= 5000 + 1, `map must stay bounded, got ${l.size()}`);
});

console.log('\n-- Persistence round-trips, and a corrupt file starts from nothing --');

test('a saved ledger restores its EVIDENCE exactly, and re-derives the state from it', () => {
  // Evidence is data and comes back as written. State is a CONCLUSION and is
  // recomputed, because this file is plain JSON in the install directory next
  // to the wallet key — see the hostile-file proof below.
  const l = new WalletLedger();
  withRecord(l, 'ProvenA', 12, 9);
  l.reevaluate(T0 + 10_000);
  assert.strictEqual(l.get('ProvenA')!.state, 'promoted');
  const blob = JSON.parse(JSON.stringify(l.serialize()));

  const l2 = new WalletLedger();
  assert.strictEqual(l2.restore(blob), 1);
  assert.strictEqual(l2.get('ProvenA')!.closedTrades, 12, 'the evidence is restored verbatim');
  assert.strictEqual(l2.score('ProvenA')!.winRate, 0.75);
  // The fixture's activity is far in the past, so the staleness rule demotes it
  // on the re-derivation — which is the right answer for a wallet that has not
  // traded in days, and is only visible because the state is recomputed.
  assert.strictEqual(l2.get('ProvenA')!.state, 'demoted');
  assert.ok(/no activity/.test(l2.get('ProvenA')!.stateReason));

  // Re-derived as promoted again once the same evidence is current.
  const l3 = new WalletLedger();
  l3.restore(blob);
  const w = l3.get('ProvenA')!;
  w.lastSeenAt = Date.now();
  l3.reevaluate();
  assert.strictEqual(l3.get('ProvenA')!.state, 'promoted',
    'the same evidence, current, still earns promotion');
});

test('a corrupt or hostile ledger file yields no wallets, not a crash', () => {
  const l = new WalletLedger();
  for (const junk of [null, undefined, 42, 'nope', {}, { wallets: 'no' }, { wallets: [null, 7, {}] }]) {
    assert.strictEqual(l.restore(junk as any), 0);
  }
  assert.strictEqual(l.size(), 0);
});

test('A HOSTILE LEDGER FILE CANNOT PROMOTE A WALLET', () => {
  // This file is plain JSON in the install directory. Trusting `state` from it
  // would mean anything able to write there — a hand edit, a script, malware —
  // puts an arbitrary wallet straight into the followable set, defeating the
  // entire "earned from chain evidence, never pasted in" property that is the
  // reason this subsystem exists rather than a config list.
  const l = new WalletLedger();
  l.restore({ wallets: [
    { address: 'Attacker1', state: 'promoted', closedTrades: 0, wins: 0 },
    { address: 'Attacker2', state: 'promoted', pinned: 'always', closedTrades: 0 },
    { address: 'Bogus', state: 'super-promoted', closedTrades: 999 },
  ] });
  assert.deepStrictEqual(l.promotedAddresses(), [],
    'no wallet may arrive promoted from disk, however the file says so');
  assert.strictEqual(l.get('Attacker2')!.pinned, undefined,
    "pinned:'always' forces promotion with no evidence — the one pin an attacker wants, and it is not honoured");
});

test("a pin of 'never' IS honoured from disk — it is the safe direction", () => {
  // Asymmetric on purpose: refusing to follow a wallet can only cost missed
  // signals, while forcing one to be followed spends money.
  const l = new WalletLedger();
  withRecord(l, 'ProvenA', 12, 9);
  l.reevaluate();
  const blob = JSON.parse(JSON.stringify(l.serialize()));
  blob.wallets[0].pinned = 'never';
  const l2 = new WalletLedger();
  l2.restore(blob);
  assert.strictEqual(l2.get('ProvenA')!.pinned, 'never');
  assert.deepStrictEqual(l2.promotedAddresses(), []);
});

console.log('\n-- The harvester is bounded, and yields to live trading --');

test('the bonding curve PDA is derived, never guessed', () => {
  const pda = bondingCurveFor('So11111111111111111111111111111111111111112');
  assert.ok(pda, 'a valid mint must derive');
  assert.strictEqual(bondingCurveFor('not-a-mint'), null, 'a bad mint must return null, not throw');
});

test('every harvester limit is a ceiling, and a tight one', () => {
  // The repo has already been bitten by a research-ish job burning a shared
  // key: local tx building was demoted from the default because its extra
  // per-trade RPC calls burst-limited Helius and slowed the trades AND the
  // leader watcher using that key. These caps are why that cannot happen here.
  const L = HARVESTER_LIMITS;
  assert.ok(L.MAX_PAGES <= 10, 'signature paging must be capped');
  assert.ok(L.MAX_TX_READS <= 100, 'parsed reads are the expensive call and need the tightest cap');
  assert.ok(L.HOURLY_READ_BUDGET <= 1000, 'there must be a global hourly ceiling, not just a per-mint one');
  assert.ok(L.READ_SPACING_MS >= 50, 'reads must be spaced — this is research, not a race');
  assert.ok(L.MIN_EARLY_BUY_SOL > 0, 'dust buys are not calls worth crediting');
});

test('the hourly budget is spent, refills on a rolling window, and refuses when empty', async () => {
  let clock = T0;
  const h = new WalletHarvester({
    getConnection: () => ({}) as any,
    isBusy: () => false,
    now: () => clock,
    sleep: async () => {},
  });
  assert.strictEqual(h.budgetRemaining(), HARVESTER_LIMITS.HOURLY_READ_BUDGET);
  // Spend it all.
  for (let i = 0; i < HARVESTER_LIMITS.HOURLY_READ_BUDGET; i++) (h as any).spend();
  assert.strictEqual(h.budgetRemaining(), 0);
  // A harvest attempted with no budget must refuse rather than queue.
  assert.strictEqual(await h.harvest('So11111111111111111111111111111111111111112', true), null);
  // An hour later it is available again.
  clock += 3_600_001;
  assert.strictEqual(h.budgetRemaining(), HARVESTER_LIMITS.HOURLY_READ_BUDGET);
});

test('THE BUDGET STOPS A WALK MID-FLIGHT, and the result says so', async () => {
  // The entry check alone is not enough: a harvest that starts with budget and
  // runs out three pages in must stop there, not keep reading. That is the case
  // where an unbounded job quietly becomes the 429 storm this is capped to
  // avoid — the walk is the part that makes many calls, not the entry.
  let pages = 0;
  const h = new WalletHarvester({
    getConnection: () => ({
      // Always a full page, so the walk would run to MAX_PAGES unless stopped.
      getSignaturesForAddress: async () => {
        pages++;
        return Array.from({ length: 1000 }, (_, i) => ({ signature: `sig${pages}_${i}`, blockTime: 1 }));
      },
      getTransaction: async () => null,
    }) as any,
    isBusy: () => false,
    now: () => T0,
    sleep: async () => {},
  });
  // Leave exactly two reads in the hour.
  for (let i = 0; i < HARVESTER_LIMITS.HOURLY_READ_BUDGET - 2; i++) (h as any).spend();
  assert.strictEqual(h.budgetRemaining(), 2);

  const r = await h.harvest('So11111111111111111111111111111111111111112', true);
  assert.ok(r, 'the harvest should run, not refuse — it had budget when it started');
  assert.ok(pages <= 2, `the walk must stop when the budget runs out, took ${pages} pages`);
  assert.strictEqual(h.budgetRemaining(), 0);
  assert.ok(/budget/.test(r!.stoppedEarly ?? ''),
    `a budget-truncated walk must say so, got "${r!.stoppedEarly}"`);
});

test('a walk cut short is retried later; one that finished is not', async () => {
  // The two cases look identical in the result if `done` is set on both, and
  // marking a truncated walk as done silently abandons research the caller
  // asked for — the mint is never revisited once the budget refills.
  let calls = 0;
  let busy = true;
  const h = new WalletHarvester({
    getConnection: () => ({
      getSignaturesForAddress: async () => { calls++; return []; },
      getTransaction: async () => null,
    }) as any,
    isBusy: () => busy,
    now: () => T0,
    sleep: async () => {},
  });
  const MINT = 'So11111111111111111111111111111111111111112';
  await h.harvest(MINT, true);
  assert.strictEqual(h.hasHarvested(MINT), false, 'a walk stopped by a busy path is not finished');

  busy = false;
  const before = calls;
  await h.harvest(MINT, true);
  assert.ok(calls > before, 'and it must be retried once the path is free');
  assert.strictEqual(h.hasHarvested(MINT), true, 'now it is finished');
});

test('a busy trading path stops the walk before the first read', async () => {
  let reads = 0;
  const h = new WalletHarvester({
    getConnection: () => ({
      getSignaturesForAddress: async () => { reads++; return []; },
    }) as any,
    isBusy: () => true,
    now: () => T0,
    sleep: async () => {},
  });
  const r = await h.harvest('So11111111111111111111111111111111111111112', true);
  assert.strictEqual(reads, 0, 'research must never take a read while the trading path is working');
  assert.ok(r && /busy/.test(r.stoppedEarly ?? ''), 'and it must say why it stopped');
});

test('A TRUNCATED WALK SAYS SO — it never reports partial coverage as complete', () => {
  // Silent truncation is how "we checked the first buyers" becomes "we checked
  // whoever we happened to reach", and a promotion built on that is unearned.
  const src = readFileSync(join(__dirname, '..', 'services', 'walletHarvester.ts'), 'utf8');
  assert.ok(/stoppedEarly/.test(src), 'the result must carry a truncation reason');
  const returns = [...src.matchAll(/return \{ mint,[\s\S]{0,200}?\}/g)];
  assert.ok(returns.length > 0);
  for (const m of returns) {
    assert.ok(/stoppedEarly/.test(m[0]),
      'every success return must carry the truncation field, or a partial walk reads as a complete one');
  }
});

test('only one harvest runs at a time', async () => {
  let inFlight = 0;
  let maxSeen = 0;
  const h = new WalletHarvester({
    getConnection: () => ({
      getSignaturesForAddress: async () => {
        inFlight++; maxSeen = Math.max(maxSeen, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        return [];
      },
    }) as any,
    isBusy: () => false,
    now: () => T0,
    sleep: async () => {},
  });
  await Promise.all([
    h.harvest('So11111111111111111111111111111111111111112', true),
    h.harvest('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', true),
  ]);
  assert.strictEqual(maxSeen, 1, 'two concurrent harvests would double the RPC pressure this is capped to avoid');
});

test('the same mint is never harvested twice', async () => {
  let calls = 0;
  const h = new WalletHarvester({
    getConnection: () => ({ getSignaturesForAddress: async () => { calls++; return []; } }) as any,
    isBusy: () => false,
    now: () => T0,
    sleep: async () => {},
  });
  const MINT = 'So11111111111111111111111111111111111111112';
  await h.harvest(MINT, true);
  const before = calls;
  await h.harvest(MINT, true);
  assert.strictEqual(calls, before, 're-reading a harvested mint buys nothing and costs the budget');
});

console.log('\n-- Confluence: several proven wallets agreeing, not one wallet mirrored --');

const MINT = 'MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZpump';

/** A ledger with `n` promoted wallets, named P0..Pn-1. */
function promotedLedger(n: number): WalletLedger {
  const l = new WalletLedger();
  for (let i = 0; i < n; i++) withRecord(l, `P${i}`, 12, 9);
  l.reevaluate(T0 + 10_000);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(l.get(`P${i}`)!.state, 'promoted', `P${i} should be promoted`);
  }
  return l;
}

const buy = (wallet: string, at: number, solIn = 1, mint = MINT) => ({ wallet, mint, solIn, at });

test('one promoted wallet buying is not a signal', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe(buy('P0', T0)), null);
});

test('two promoted wallets inside the window fire once', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe(buy('P0', T0)), null);
  const sig = d.observe(buy('P1', T0 + 5_000));
  assert.ok(sig, 'quorum should fire');
  assert.deepStrictEqual(sig!.wallets.sort(), ['P0', 'P1']);
  assert.strictEqual(sig!.totalSolIn, 2);
});

test('ONE WALLET CANNOT BE ITS OWN QUORUM', () => {
  // A DCA ladder, or a bot splitting one order across five transactions to hide
  // its size, is ONE opinion. Counting it as five is how a "confluence"
  // detector fires on a single participant — the defect that would make this
  // whole idea worthless, and the easiest one to write by accident.
  const d = new SmartMoneyDetector(promotedLedger(2));
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(d.observe(buy('P0', T0 + i * 1000, 1)), null,
      `buy ${i + 1} from the same wallet must not build a quorum`);
  }
});

test('A BUNDLED FLEET IS ONE OPINION, NOT A QUORUM', () => {
  // The attack the review named: "distinct wallet address" is not
  // independence. A bundler buys from up to sixteen wallets in ONE
  // transaction, and an operator running a fleet does the same thing on
  // purpose. Counting those as several observers agreeing is a confluence
  // detector agreeing with itself — and independence is the entire reason this
  // is preferred over mirroring one wallet faster.
  const d = new SmartMoneyDetector(promotedLedger(4));
  const SAME_TX = 'BundledSignature1111111111111111111111111111';
  for (let i = 0; i < 4; i++) {
    const sig = d.observe({ wallet: `P${i}`, mint: MINT, solIn: 1, at: T0 + i, signature: SAME_TX });
    assert.strictEqual(sig, null, `wallet ${i} from the same transaction must not build a quorum`);
  }
});

test('the same wallets in DIFFERENT transactions are a real quorum', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe({ wallet: 'P0', mint: MINT, solIn: 1, at: T0, signature: 'txA' }), null);
  const sig = d.observe({ wallet: 'P1', mint: MINT, solIn: 1, at: T0 + 1000, signature: 'txB' });
  assert.ok(sig, 'two wallets acting separately is what the detector is for');
  assert.strictEqual(sig!.wallets.length, 2);
});

test('a mixed batch counts each transaction once', () => {
  // Three wallets, two of them bundled together: two opinions, not three.
  const d = new SmartMoneyDetector(promotedLedger(3));
  d.setConfig({ minWallets: 3 });
  d.observe({ wallet: 'P0', mint: MINT, solIn: 1, at: T0, signature: 'bundle' });
  d.observe({ wallet: 'P1', mint: MINT, solIn: 1, at: T0 + 1, signature: 'bundle' });
  assert.strictEqual(
    d.observe({ wallet: 'P2', mint: MINT, solIn: 1, at: T0 + 2, signature: 'solo' }), null,
    'the bundle contributes one vote, so three are not yet present');
});

test('the engine supplies the signature, or the independence test is inert', () => {
  const src = engineSrc();
  const idx = src.indexOf('smartMoneyDetector.observe({');
  assert.ok(idx > 0, 'the feed must call the detector');
  const body = src.slice(idx, idx + 700);
  assert.ok(/signature: ev\.signature/.test(body),
    'without a signature every bundled buy reads as an independent one');
});

test('an UNPROMOTED wallet contributes nothing, however much it buys', () => {
  const l = promotedLedger(1);
  l.recordBuy('Stranger', MINT, 50, T0);   // exists in the ledger, not promoted
  const d = new SmartMoneyDetector(l);
  assert.strictEqual(d.observe(buy('Stranger', T0, 50)), null);
  assert.strictEqual(d.observe(buy('P0', T0 + 1_000)), null,
    'the stranger must not have counted toward the quorum');
});

test('an unpromoted wallet is not even TRACKED — the front door is a real guard', () => {
  // The quorum is guarded twice: once when a buy arrives and again when the
  // signal fires. The second alone keeps the RULE correct, which is why
  // removing the first passed every behavioural test — so this pins the first
  // on its own observable effect. Without it the detector accumulates a buy
  // from every wallet on the chain, and its bounded map fills with noise that
  // evicts the mints actually being watched.
  const l = promotedLedger(1);
  l.recordBuy('Stranger', MINT, 50, T0);
  const d = new SmartMoneyDetector(l);
  d.observe(buy('Stranger', T0, 50));
  assert.deepStrictEqual(d.pending(T0 + 1), [],
    'an unproven wallet must not occupy a slot in the tracker at all');
});

test('a wallet DEMOTED between its buy and the quorum does not count', () => {
  // A signal is only as good as the wallets standing behind it at the moment it
  // fires, not at the moment each of them bought.
  const l = promotedLedger(2);
  const d = new SmartMoneyDetector(l);
  assert.strictEqual(d.observe(buy('P0', T0)), null);
  l.pin('P0', 'never', T0 + 1_000);
  assert.strictEqual(l.get('P0')!.state, 'demoted');
  assert.strictEqual(d.observe(buy('P1', T0 + 2_000)), null,
    'quorum must be re-checked against current standing');
});

test('agreement outside the window is not agreement', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe(buy('P0', T0)), null);
  const late = T0 + DEFAULT_CONFLUENCE.windowMs + 5_000;
  assert.strictEqual(d.observe(buy('P1', late), late), null,
    'two wallets minutes apart are two opinions, not a convergence');
});

test('a dust buy does not count toward the quorum', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe(buy('P0', T0, 0.001)), null);
  assert.strictEqual(d.observe(buy('P1', T0 + 1000, 1)), null,
    'a wallet that risked nothing has not expressed a view');
});

test('THE SIGNAL FIRES ONCE — the third and fourth wallet do not re-fire it', () => {
  // Without a cooldown, wallets 3, 4 and 5 arriving a second later each produce
  // another signal and the engine sees several entries for one event.
  const d = new SmartMoneyDetector(promotedLedger(5));
  d.observe(buy('P0', T0));
  assert.ok(d.observe(buy('P1', T0 + 1_000)), 'first quorum fires');
  assert.strictEqual(d.observe(buy('P2', T0 + 2_000)), null, 'a third wallet must not re-fire');
  assert.strictEqual(d.observe(buy('P3', T0 + 3_000)), null);
  assert.strictEqual(d.observe(buy('P4', T0 + 4_000)), null);
});

test('after the cooldown the same mint may fire again', () => {
  const d = new SmartMoneyDetector(promotedLedger(4));
  d.observe(buy('P0', T0));
  assert.ok(d.observe(buy('P1', T0 + 1_000)));
  const later = T0 + DEFAULT_CONFLUENCE.cooldownMs + 60_000;
  d.observe(buy('P2', later));
  assert.ok(d.observe(buy('P3', later + 1_000), later + 1_000),
    'a genuinely new convergence later is a new signal');
});

test('strength is bounded, and measured against the configured bar', () => {
  const l = promotedLedger(4);

  const fireAt = (minWallets: number, mint: string) => {
    const d = new SmartMoneyDetector(l);
    d.setConfig({ minWallets });
    let sig = null;
    for (let i = 0; i < minWallets; i++) sig = d.observe(buy(`P${i}`, T0 + i * 1000, 1, mint));
    return sig!;
  };

  const two = fireAt(2, 'MintTwo');
  const four = fireAt(4, 'MintFour');
  for (const s of [two, four]) {
    assert.ok(s && s.strength > 0 && s.strength <= 1, `strength out of range: ${s?.strength}`);
  }
  // Both fired at exactly their configured minimum, so neither earns an excess
  // bonus and the two strengths match. That is the intended property: strength
  // measures how far past the BAR the agreement went, not the raw wallet count.
  // Rewarding the raw count would rate a lax config higher than a strict one on
  // identical evidence.
  assert.strictEqual(two.strength, four.strength,
    'agreement is measured against the configured minimum, not in absolute wallets');
});

test('agreement beyond the minimum raises strength, with diminishing weight', () => {
  // The signal fires on the TRANSITION into quorum, so a fire with more wallets
  // than the minimum cannot be produced by feeding buys one at a time — the
  // quorum completes at the minimum every time. The decay rule is therefore
  // asserted against the shipped source; its bounds are covered behaviourally
  // by the test above.
  const src = readFileSync(join(__dirname, '..', 'services', 'smartMoneySignal.ts'), 'utf8');
  const idx = src.indexOf('const excess =');
  assert.ok(idx > 0, 'strength must account for agreement beyond the minimum');
  const body = src.slice(idx, idx + 400);
  assert.ok(/Math\.pow\(0\.6, excess\)/.test(body),
    'the bonus must decay — four wallets is better than two, not twice as good');
  assert.ok(/clamp01\(/.test(body), 'and the result must be bounded to 0-1');
});

test('nonsense observations are refused rather than tracked', () => {
  const d = new SmartMoneyDetector(promotedLedger(2));
  assert.strictEqual(d.observe({ wallet: '', mint: MINT, solIn: 1, at: T0 }), null);
  assert.strictEqual(d.observe({ wallet: 'P0', mint: '', solIn: 1, at: T0 }), null);
  assert.strictEqual(d.observe({ wallet: 'P0', mint: MINT, solIn: NaN, at: T0 }), null);
});

test('the pending view shows what is accumulating without firing anything', () => {
  const d = new SmartMoneyDetector(promotedLedger(3));
  d.observe(buy('P0', T0));
  const p = d.pending(T0 + 1000);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].wallets, 1);
  assert.strictEqual(p[0].needed, DEFAULT_CONFLUENCE.minWallets);
});

console.log('\n-- The entry path: no shortcut, no second door --');


test('THE SMART-MONEY LANE DOES NOT FABRICATE A PASSING GATE RESULT', () => {
  // fireLaunchSnipe, a few lines away in the same file, constructs a
  // `FilterResult { isSafe: true, score: 0 }` and goes straight to commitEntry.
  // That is defensible for a block-0 launch snipe, where no data about the
  // token exists yet. It is NOT defensible here: a confluence signal arrives on
  // a token several wallets have already bought, so RugCheck, DexScreener, the
  // honeypot inspection and the entry gate all have real data. Skipping them
  // would let this lane buy a honeypot every other lane refuses — and "someone
  // good bought it" is not evidence that the sell path works.
  const src = engineSrc();
  const start = src.indexOf('private async onSmartMoneySignal(');
  assert.ok(start > 0, 'the signal handler must exist');
  const body = src.slice(start, src.indexOf('\n  private ', start + 10));
  assert.ok(/await this\.processIncomingToken\(/.test(body),
    'the lane must enter through the full screening pipeline');
  assert.ok(!/isSafe:\s*true/.test(body),
    'it must never construct its own passing verdict');
  assert.ok(!/commitEntry\(/.test(body),
    'and it must not call commitEntry directly, which would skip the gate entirely');
});

test('everything the lane hands the gate is MEASURED, never a literal', () => {
  // The first version passed no curve state and no age at all, which made
  // computeAgeSeconds return 0 and the router refuse every signal as BLOCK_0 —
  // the lane could not buy anything, ever. The fix is not to invent numbers
  // (the audit already found what an asserted liquidity figure does to a gate)
  // but to pass real ones: the curve reserves come off the trade events the
  // wallets themselves produced, and the age from a real block time.
  const src = engineSrc();
  const start = src.indexOf('private async onSmartMoneySignal(');
  const body = src.slice(start, src.indexOf('\n  /**', start + 10));
  assert.ok(/vSolInBondingCurve: sig\.vSolInBondingCurve/.test(body),
    'the curve position must come from the signal, which read it off the chain');
  assert.ok(/timestamp: Date\.now\(\) - ageSeconds \* 1000/.test(body),
    'the age must be derived from a measured block time');
  // Still no fabricated liquidity or holder data — those remain
  // processIncomingToken's job, which fetches them.
  for (const field of ['liquidityUsd', 'marketCapSol', 'volume5mUsd', 'uniqueBuyers5m']) {
    assert.ok(!new RegExp(`${field}\\s*:`).test(body), `${field} must not be fabricated here`);
  }
});

test('AN UNKNOWABLE AGE DOES NOT TRADE', () => {
  // Passing 0 would recreate the BLOCK_0 bug; passing a guess would let a token
  // inside the insider window through a gate written to keep it out.
  const src = engineSrc();
  const start = src.indexOf('private async onSmartMoneySignal(');
  const body = src.slice(start, src.indexOf('\n  /**', start + 10));
  assert.ok(/if \(ageSeconds === null\)/.test(body), 'an unknown age must be handled explicitly');
  const branch = body.slice(body.indexOf('if (ageSeconds === null)'));
  assert.ok(branch.indexOf('return;') < branch.indexOf('processIncomingToken'),
    'and must return before any screening happens');
});

test('conviction sizing can only shrink a slot, never grow one', () => {
  // The run budget already decided what a safe position is. A signal being
  // strong is not a reason to exceed it, and a rule that could would let a run
  // of confident-looking signals talk the engine into a bet the wallet was
  // never sized for.
  const src = engineSrc();
  const idx = src.indexOf('const smartSignal = entryMint');
  assert.ok(idx > 0, 'the sizing hook must exist');
  const body = src.slice(idx, idx + 900);
  assert.ok(/if \(scaled < unitSizeSol\)/.test(body),
    'the scaled size must only be applied when it is SMALLER than the slot');
  assert.ok(/SMART_MONEY_MIN_SIZE_FRACTION/.test(body),
    'and there must be a floor, or a weak signal produces an order too small to clear its fees');

  // The scale must be bounded to (0, 1]: derive it the way the engine does and
  // check the endpoints.
  const FLOOR = Number(/SMART_MONEY_MIN_SIZE_FRACTION = ([\d.]+)/.exec(src)?.[1]);
  assert.ok(Number.isFinite(FLOOR) && FLOOR > 0 && FLOOR < 1, `bad floor: ${FLOOR}`);
  const scaleFor = (strength: number) => FLOOR + (1 - FLOOR) * Math.max(0, Math.min(1, strength));
  assert.strictEqual(scaleFor(1), 1, 'a maximal signal takes exactly one slot, never more');
  assert.strictEqual(scaleFor(0), FLOOR, 'a zero-strength signal is floored, not zeroed');
  assert.ok(scaleFor(2) <= 1, 'an out-of-range strength cannot exceed a full slot');
});

test('the watch feed is watch-only — it places no orders of its own', () => {
  const src = engineSrc();
  const start = src.indexOf('private startSmartMoneyWatcher()');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('private syncSmartMoneyRoster', start));
  for (const forbidden of ['executeRealMainnetTrade', 'executeExternalTrade', 'commitEntry', 'sendRawTransaction']) {
    assert.ok(!body.includes(forbidden),
      `the wallet feed must not reach ${forbidden} — it observes, the engine decides`);
  }
  assert.ok(/tradeEventsFromLogs\(/.test(body),
    'and it must decode from the log lines it already has, with no RPC per event');
});

test('the roster feed subscribes ONLY to promoted wallets', () => {
  const src = engineSrc();
  const idx = src.indexOf('private syncSmartMoneyRoster()');
  assert.ok(idx > 0);
  const body = src.slice(idx, idx + 400);
  assert.ok(/walletLedger\.promotedAddresses\(\)/.test(body),
    'the subscription set must come from the promoted list, not from every wallet seen');
});

test('the lane is tied to the RUN, not to the process', () => {
  // A paused bot holding open wallet subscriptions is a bot that looks off and
  // is not, and an armed one waiting on a two-minute timer to notice its roster
  // misses the first signals of the session.
  const src = engineSrc();
  assert.ok(/this\.startSmartMoneyWatcher\(\);/.test(src), 'arming must start the feed');
  assert.ok(/this\.stopSmartMoneyWatcher\(\);/.test(src), 'disarming must stop it');
});

test('an empty roster is announced, not left silent', () => {
  // A fresh install has no promoted wallets by construction — the roster is
  // earned, not shipped. An operator who turns the flag on and hears nothing
  // will assume it is broken, or worse assume it is working.
  const src = engineSrc();
  const idx = src.indexOf('private announceSmartMoneyRoster()');
  assert.ok(idx > 0, 'the lane must say what it will actually do at arm time');
  const body = src.slice(idx, src.indexOf('\n  private ', idx + 10));
  assert.ok(/roster\.length === 0/.test(body), 'the empty case must be handled explicitly');
  assert.ok(/'warn'/.test(body), 'and said at a level the operator will notice');
});

test('the flag ships OFF and is declared, or the flag suite fails', () => {
  const flags = readFileSync(join(__dirname, '..', 'services', 'featureFlags.ts'), 'utf8');
  assert.ok(/smartMoneySniper: boolean;/.test(flags), 'the flag must be declared on the type');
  assert.ok(/smartMoneySniper: false,/.test(flags), 'and default to off');
  // If it were ever added to PACKAGED_DEFAULTS it must also be declared in
  // INTENDED_PACKAGED_DIVERGENCE — run.ts enforces that, and this records why.
  const packagedIdx = flags.indexOf('PACKAGED_DEFAULTS');
  const packagedBlock = flags.slice(packagedIdx, flags.indexOf('INTENDED_PACKAGED_DIVERGENCE'));
  if (/smartMoneySniper: true/.test(packagedBlock)) {
    assert.ok(/'smartMoneySniper'/.test(flags.slice(flags.indexOf('INTENDED_PACKAGED_DIVERGENCE'))),
      'a flag turned on in the packaged set must be declared as intended divergence');
  }
});

console.log('\n-- The research scheduler: without it the whole lane is inert --');

test('WINNERS AND DUDS BOTH FEED THE LEDGER, or the ratio is meaningless', () => {
  // A roster built only from winners promotes whichever bot buys the first
  // block of everything. The duds are what separate a good eye from volume —
  // so both must reach the queue, from events the engine already receives.
  const src = engineSrc();
  assert.ok(/this\.enqueueResearch\(payload\.mint, true\)/.test(src),
    'a graduation must be recorded as a winner — it is the free, definitive signal');
  assert.ok(/this\.considerDudSample\(payload\.mint, arrivalMs\)/.test(src),
    'fresh creates must be sampled as possible duds');
});

test('a dud verdict is DEFERRED, never made on a token minutes old', () => {
  // A token that has not run yet has not failed yet. Judging it immediately
  // would credit everyone who was right about a slow winner with a loss.
  const src = engineSrc();
  const idx = src.indexOf('private sweepDudCandidates(');
  assert.ok(idx > 0, 'dud candidates must be swept on a delay, not judged on arrival');
  const body = src.slice(idx, src.indexOf('\n  private ', idx + 10));
  assert.ok(/now - at < DUD_VERDICT_DELAY_MS/.test(body), 'the delay must be enforced');
  assert.ok(/this\.migrationSeenAt\.has\(mint\)/.test(body),
    'and a token that graduated while waiting must NOT be recorded as a dud');
  // Written as `45 * 60_000` in the source, so evaluate the expression rather
  // than matching the first integer — which would read 45 and pass on a delay
  // of 45 milliseconds.
  const expr = /DUD_VERDICT_DELAY_MS = ([^;]+);/.exec(src)?.[1] ?? '';
  const delay = Number(expr.replace(/_/g, '').split('*').map(Number).reduce((a, b) => a * b, 1));
  assert.ok(Number.isFinite(delay) && delay >= 20 * 60_000,
    `the delay must be generous, parsed ${delay}ms from "${expr}"`);
});

test('A REFUSED HARVEST IS RE-QUEUED, NOT DROPPED', () => {
  // The harvester returns null when it is busy, out of budget, or already
  // running — all temporary. Discarding the job on any of those is how the
  // roster quietly stops growing while everything still looks healthy.
  const src = engineSrc();
  const idx = src.indexOf('private async drainResearchQueue(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  /** Research state', idx));
  assert.ok(/if \(result === null\)/.test(body), 'a refusal must be handled explicitly');
  assert.ok(/this\.enqueueResearch\(job\.mint, job\.wasWinner, RESEARCH_RETRY_DELAY_MS\)/.test(body),
    'and the job must go back on the queue with a delay');
});

test('winners are preferred, but DUDS GET A GUARANTEED SHARE', () => {
  // Unconditional winner priority starved the dud queue completely:
  // graduations arrive steadily, so a winner was almost always ready and the
  // whole read budget went to them. The early-hit RATE then has no denominator
  // — every credited wallet shows 100%, which is exactly the signal the ratio
  // exists to disprove, and promotion degenerates to "was early to 4 winners".
  const src = engineSrc();
  const idx = src.indexOf('private async drainResearchQueue(');
  const body = src.slice(idx, src.indexOf('\n  /** Research state', idx));
  assert.ok(/DUD_RESEARCH_EVERY_N/.test(body), 'the drain must reserve turns for duds');
  assert.ok(/preferDud/.test(body), 'and act on that reservation');
  const everyN = Number(/DUD_RESEARCH_EVERY_N = (\d+)/.exec(src)?.[1]);
  assert.ok(Number.isFinite(everyN) && everyN >= 2 && everyN <= 5,
    `duds must get a meaningful share of the budget, got 1 in ${everyN}`);
});

test('the research queue is bounded, and a winner displaces a dud rather than being dropped', () => {
  const src = engineSrc();
  const idx = src.indexOf('private enqueueResearch(');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  /**', idx + 10));
  assert.ok(/RESEARCH_QUEUE_MAX/.test(body), 'the queue must be bounded');
  assert.ok(/findIndex\(r => !r\.wasWinner\)/.test(body),
    'a full queue must make room for a winner by dropping a dud, not by dropping the winner');
});

test('research yields to anything the trading path is doing', () => {
  // The predicate now lives in ONE method rather than inline in the harvester's
  // deps, because a second research job (the trader scout) runs on the same
  // Helius key and would otherwise have arrived with its own approximation of
  // "busy". The test follows it there, and additionally pins that every
  // research job actually uses the shared one.
  const src = engineSrc();
  const idx = src.indexOf('public tradingPathBusy()');
  assert.ok(idx > 0, 'the shared busy predicate must exist');
  const body = src.slice(idx, src.indexOf('\n  }', idx));
  assert.ok(/entriesInFlight\.size > 0/.test(body), 'an entry in flight must stop research');
  assert.ok(/exitInFlight/.test(body), 'and so must a position being exited');

  const research = src.slice(src.indexOf('private startResearch()'), src.indexOf('\n  private stopResearch'));
  assert.ok(/isBusy: \(\) => this\.tradingPathBusy\(\)/.test(research),
    'the harvester must use the shared predicate, not a copy of it');
  const deps = src.slice(src.indexOf('public researchDeps()'), src.indexOf('private startResearch()'));
  assert.ok(/isBusy: \(\) => this\.tradingPathBusy\(\)/.test(deps),
    'and so must every research job wired from outside this class');
});

test('every research entry point is gated on the flag', () => {
  // With the flag off this must cost nothing at all — no queue growth, no
  // timer, no reads. A research job that runs regardless is a research job the
  // operator did not consent to.
  const src = engineSrc();
  for (const fn of ['private enqueueResearch(', 'private considerDudSample(', 'private startResearch()']) {
    const idx = src.indexOf(fn);
    assert.ok(idx > 0, `${fn} must exist`);
    const head = src.slice(idx, idx + 320);
    assert.ok(/featureFlags\.get\('smartMoneySniper'\)/.test(head),
      `${fn} must return early when the flag is off`);
  }
});

test('the ledger is loaded at startup and flushed on the way out', () => {
  // Days of gathered evidence, in a process an operator restarts routinely.
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  assert.ok(/loadWalletLedger\(\)/.test(server), 'the roster must survive a restart');
  assert.ok(/flushWalletLedger\(\)/.test(server), 'and be written on shutdown');
});

test('the pin endpoint is token-gated — it decides whose trades we follow', () => {
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  const idx = server.indexOf("app.post('/api/smart-money/pin'");
  assert.ok(idx > 0, 'the pin endpoint must exist');
  assert.ok(/requireApiToken/.test(server.slice(idx, idx + 120)),
    'an open browser tab must not be able to change whose transactions our money follows');
  const cfgIdx = server.indexOf("app.post('/api/smart-money/config'");
  assert.ok(/requireApiToken/.test(server.slice(cfgIdx, cfgIdx + 120)),
    'nor to lower the promotion bar');
});

console.log('\n-- The panel says what the lane is actually doing --');

test('the panel is HIDDEN when the lane is off, not shown empty', () => {
  // An empty table on a feature nobody turned on reads as a broken feature.
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('function SmartMoneyPanel()');
  assert.ok(idx > 0, 'the roster panel must exist');
  const body = app.slice(idx, app.indexOf('function DiagnosticsPanel()', idx));
  assert.ok(/if \(!sm \|\| !sm\.enabled\) return null;/.test(body),
    'the panel must render nothing at all when the lane is disabled');
});

test('AN EMPTY ROSTER IS EXPLAINED, not left looking broken', () => {
  // A fresh install has no promoted wallets by construction. Without a
  // sentence saying so, the operator concludes the feature does not work — and
  // the natural next step is to go looking for a list to paste in, which is
  // the exact thing this design exists to avoid.
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('function SmartMoneyPanel()');
  const body = app.slice(idx, app.indexOf('function DiagnosticsPanel()', idx));
  assert.ok(/sm\.roster\.length === 0/.test(body), 'the empty case must be handled');
  assert.ok(/is not a fault/.test(body) || /expected on a new install/.test(body),
    'and it must say plainly that an empty roster is expected, not broken');
});

test('the panel shows the EVIDENCE behind a promotion, not just the address', () => {
  // "Trust me, this wallet is good" is what a pasted list says. The point of
  // earning the roster is that the reasoning can be audited.
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('function SmartMoneyPanel()');
  const body = app.slice(idx, app.indexOf('function DiagnosticsPanel()', idx));
  for (const field of ['winRate', 'realizedPnlSol', 'closedTrades', 'stateReason', 'conviction']) {
    assert.ok(body.includes(field), `the panel must surface ${field} so a promotion can be audited`);
  }
});

test('the operator can drop a wallet from the panel', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  const idx = app.indexOf('function SmartMoneyPanel()');
  const body = app.slice(idx, app.indexOf('function DiagnosticsPanel()', idx));
  assert.ok(/api\/smart-money\/pin/.test(body), 'the panel must be able to overrule the ladder');
  assert.ok(/'never'/.test(body), 'specifically to stop following a wallet');
});

console.log('\n-- The lane can actually fire, and is still refused where it should be --');

test('OLD BUG: with no age and no curve state the router refuses everything', () => {
  // Reproduced against the shipped router. This is what the lane sent in its
  // first version: computeAgeSeconds(undefined) is 0, so classifyPhase returned
  // BLOCK_0 ("inside the insider exit window — never enter") for every signal,
  // on a token that was in fact hours old. The lane logged that it was
  // screening and could not buy anything, ever.
  const cfg = playbookConfigFor('strict');
  const asShipped: any = { ageSeconds: 0, isMigrationEvent: false, score: 100, marketCapUsd: 40000,
    liquidityUsd: 200000, volume5mUsd: 50000, solPriceUsd: 200 };
  const r = routePlay(asShipped, cfg);
  assert.strictEqual(r.phase, 'BLOCK_0');
  assert.strictEqual(r.eligible, false);
});

test('fixed: a real quorum on a mid-curve token is eligible', () => {
  const cfg = playbookConfigFor('strict');
  const base: any = { ageSeconds: 3600, isMigrationEvent: false, vSolInBondingCurve: 70, hasDexPair: false,
    score: 60, marketCapUsd: 40000, liquidityUsd: 20000, volume5mUsd: 8000,
    uniqueBuyers5m: 0, buyPressurePct: 0, solPriceUsd: 200 };
  assert.strictEqual(routePlay(base, cfg).eligible, false, 'the anonymous proxies alone refuse it');
  assert.strictEqual(routePlay({ ...base, smartMoney: { wallets: 2, strength: 0.62 } }, cfg).eligible, true,
    'a proven-wallet quorum is the demand evidence those proxies approximate');
});

test('the quorum substitutes for DEMAND EVIDENCE ONLY — never for a phase rule', () => {
  // This is the line between "different evidence" and "a second door". The
  // block-0 window and the early-curve rug-density rule are about the TOKEN,
  // not about who is buying it, and no amount of conviction may pass them.
  const cfg = playbookConfigFor('strict');
  const strong = { wallets: 5, strength: 1 };
  const base: any = { isMigrationEvent: false, hasDexPair: false, score: 100, marketCapUsd: 40000,
    liquidityUsd: 200000, volume5mUsd: 50000, solPriceUsd: 200 };
  const blockZero = routePlay({ ...base, ageSeconds: 10, vSolInBondingCurve: 70, smartMoney: strong }, cfg);
  assert.strictEqual(blockZero.phase, 'BLOCK_0');
  assert.strictEqual(blockZero.eligible, false, 'the insider window is not negotiable');
  const early = routePlay({ ...base, ageSeconds: 3600, vSolInBondingCurve: 33, smartMoney: strong }, cfg);
  assert.strictEqual(early.phase, 'EARLY_CURVE');
  assert.strictEqual(early.eligible, false, '~70% of these die on day one, whoever bought');
});

test('a quorum of ONE, or a weak one, does not qualify', () => {
  const cfg = playbookConfigFor('strict');
  const base: any = { ageSeconds: 3600, isMigrationEvent: false, vSolInBondingCurve: 70, hasDexPair: false,
    score: 60, marketCapUsd: 40000, liquidityUsd: 20000, volume5mUsd: 8000, solPriceUsd: 200 };
  assert.strictEqual(routePlay({ ...base, smartMoney: { wallets: 1, strength: 1 } }, cfg).eligible, false,
    'one wallet is not a confluence, whatever the router is told');
  assert.strictEqual(routePlay({ ...base, smartMoney: { wallets: 4, strength: 0.3 } }, cfg).eligible, false,
    'a barely-passing signal does not carry a full unit');
});

test('the router reads the quorum from engine state, not from the payload', () => {
  // The payload crosses a JSON-shaped boundary and originates in a websocket
  // frame. A caller that could set `__smartMoney` on it would be setting the
  // one field that substitutes for the score gate.
  const src = engineSrc();
  const idx = src.indexOf('const smartForRouter =');
  assert.ok(idx > 0, 'the router input must be resolved from engine state');
  const body = src.slice(idx, idx + 200);
  assert.ok(/this\.pendingSmartMoney\.get\(/.test(body),
    'it must come from pendingSmartMoney, which only onSmartMoneySignal writes');
});

console.log('\n-- Evidence cannot be manufactured cheaply --');

test('A PARTIAL WALK CREDITS NOBODY', () => {
  // The attack the review found: on a token someone else graduated, an attacker
  // sprays dust buys during the busy period. Those land inside the last 4000
  // signatures, so a walk that stops at its page cap and credits "the oldest
  // addresses it reached" turns them into early-buyer credits on a winner. Four
  // such tokens produce a fleet of perfect-record wallets for well under a SOL,
  // and the roster is capped, so they displace the honest ones.
  const src = readFileSync(join(__dirname, '..', 'services', 'walletHarvester.ts'), 'utf8');
  assert.ok(/let reachedBeginning = false;/.test(src),
    'the walk must know whether it actually reached the first transactions');
  assert.ok(/if \(reachedBeginning\) \{\s*\n\s*for \(const b of buyers\) walletLedger\.recordEarlyCall/.test(src),
    'early calls may only be credited when the beginning was genuinely reached');
  assert.ok(/never reached the token's first buyers/.test(src),
    'and a truncated walk must say so rather than reporting partial coverage as complete');
});

test('perfection stops being free: a 4-for-4 record cannot outrank a long honest one', () => {
  // Conviction blended raw rates shrunk toward 0.5, so four early calls with
  // four winners scored 0.70 while an honest wallet with thirty calls at a
  // realistic 60% scored 0.60 — the manufactured record outranked the real one
  // and, because the promoted set is capped and ranked by conviction, took its
  // slot.
  assert.ok(pessimisticRate(4, 4) < pessimisticRate(18, 30),
    `4-for-4 (${pessimisticRate(4, 4).toFixed(3)}) must rank below 30 calls at 60% (${pessimisticRate(18, 30).toFixed(3)})`);
  assert.ok(pessimisticRate(8, 8) < pessimisticRate(60, 100),
    'and a longer honest record must beat a shorter perfect one');
  assert.ok(pessimisticRate(1, 1) < 0.5, 'a single lucky call is worth less than no opinion');
  assert.strictEqual(pessimisticRate(0, 0), 0, 'no evidence is not a rate');

  const l = new WalletLedger();
  for (let i = 0; i < 4; i++) l.recordEarlyCall('Attacker', `W${i}`, true, T0);
  for (let i = 0; i < 18; i++) l.recordEarlyCall('Honest', `H${i}`, true, T0);
  for (let i = 0; i < 12; i++) l.recordEarlyCall('Honest', `L${i}`, false, T0);
  assert.ok(l.score('Honest')!.conviction! > l.score('Attacker')!.conviction!,
    'and the ranking the cap uses must agree');
});

test('SELLS ARE RECORDED, or the closed-trade ladder is dead code', () => {
  // recordSell had no caller: the entire trade-based promotion route and every
  // loss-based demotion were unreachable, so a promoted wallet could never be
  // un-promoted by its own results.
  const src = engineSrc();
  const idx = src.indexOf('for (const t of tradeEventsFromLogs(ev.logs))');
  assert.ok(idx > 0, 'the watch feed must decode trades');
  const body = src.slice(idx, idx + 1600);
  // Asserted on the BRANCH, not on the call: `if (false) { recordSell(...) }`
  // contains the same text and would satisfy a substring check while recording
  // nothing — which is how the mutation run caught the first version of this
  // test passing over a dead sell path.
  assert.ok(/if \(!t\.isBuy\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*walletLedger\.recordSell\(/.test(body),
    'a sell must reach the ledger, from a branch that is actually taken');
  assert.ok(/walletLedger\.recordBuy\(/.test(body), 'and so must a buy');
  assert.ok(!/if \(false\)/.test(body), 'no branch on this path may be disabled');
});

test('the runtime flag actually stops the lane', () => {
  // Turning it off used to stop nothing: the socket stayed open, the detector
  // kept accumulating and the entry injection kept firing, while
  // /api/smart-money reported enabled:false.
  const src = engineSrc();
  const feedStart = src.indexOf('onLog: (ev) => {');
  assert.ok(feedStart > 0, 'the watch feed must exist');
  const feed = src.slice(feedStart, src.indexOf('[SmartMoney]', feedStart));
  assert.ok(/if \(!featureFlags\.get\('smartMoneySniper'\)\) return;/.test(feed),
    'the feed must check the flag at the point of action, not only where it was started');
  const entry = src.slice(src.indexOf('private async onSmartMoneySignal('), src.indexOf('private async onSmartMoneySignal(') + 600);
  assert.ok(/featureFlags\.get\('smartMoneySniper'\)/.test(entry),
    'and so must the entry point, for a signal already in flight');
});

test('research yields to the COPY trader too, not just the sniper', () => {
  // Both engines share one Helius key. Yielding only for the sniper's entries
  // meant a research walk could burn the shared budget in the middle of a copy
  // buy — the shape of the incident that got local tx building demoted.
  const src = engineSrc();
  const idx = src.indexOf('public tradingPathBusy()');
  assert.ok(idx > 0);
  const body = src.slice(idx, src.indexOf('\n  }', idx));
  assert.ok(/this\.copyBusyProvider\(\)/.test(body), 'the copy trader must be consulted');
  assert.ok(/inFlightBuyCount > 0/.test(body), 'and any in-flight buy from either engine');
  const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  assert.ok(/setCopyBusyProvider\(\(\) => copyTrader\.isBusyTrading\(\)\)/.test(server),
    'and the provider must actually be wired');
});

console.log('\n-- The design promise: no addresses are shipped --');

test('NO WALLET ADDRESS IS HARDCODED ANYWHERE IN THE SMART-MONEY PATH', () => {
  // The whole argument for building this the hard way is that a pasted address
  // cannot be verified, decays as traders rotate, and says nothing about
  // current profitability. A seeded list would quietly undo that.
  const files = ['walletLedger.ts', 'walletHarvester.ts'];
  // base58, 32-44 chars — a Solana address. The pump program id is expected and
  // named; nothing else may appear.
  const ALLOWED = new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
  for (const f of files) {
    const src = readFileSync(join(__dirname, '..', 'services', f), 'utf8');
    // Only string literals count — prose in comments is not a shipped address.
    for (const m of src.matchAll(/['"`]([1-9A-HJ-NP-Za-km-z]{32,44})['"`]/g)) {
      assert.ok(ALLOWED.has(m[1]),
        `${f} ships a hardcoded address (${m[1]}). The roster must be earned from chain evidence, never seeded.`);
    }
  }
});

void (async () => {
  if (pending.length) console.log(`\n-- Async proofs (${pending.length}, run sequentially) --`);
  for (const t of pending) {
    try { await t.fn(); passed++; console.log(`  ok    ${t.name}`); }
    catch (err: any) { failed++; console.error(`  FAIL  ${t.name}\n        ${err?.message ?? err}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
