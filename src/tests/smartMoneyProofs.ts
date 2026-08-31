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

test('a saved ledger restores its evidence and its states', () => {
  const l = new WalletLedger();
  withRecord(l, 'ProvenA', 12, 9);
  l.reevaluate(T0 + 10_000);
  const blob = JSON.parse(JSON.stringify(l.serialize()));

  const l2 = new WalletLedger();
  assert.strictEqual(l2.restore(blob), 1);
  assert.strictEqual(l2.get('ProvenA')!.state, 'promoted');
  assert.strictEqual(l2.get('ProvenA')!.closedTrades, 12);
  assert.strictEqual(l2.score('ProvenA')!.winRate, 0.75);
});

test('a corrupt or hostile ledger file yields no wallets, not a crash', () => {
  const l = new WalletLedger();
  for (const junk of [null, undefined, 42, 'nope', {}, { wallets: 'no' }, { wallets: [null, 7, {}] }]) {
    assert.strictEqual(l.restore(junk as any), 0);
  }
  assert.strictEqual(l.size(), 0);
});

test('a restored record with a bogus state falls back to candidate', () => {
  // The file is on disk beside the wallet key. A hand-edited "promoted" is the
  // one field worth being paranoid about, but any unknown value must degrade
  // to the least-trusted state rather than being kept.
  const l = new WalletLedger();
  l.restore({ wallets: [{ address: 'X', state: 'super-promoted', closedTrades: 999 }] });
  assert.strictEqual(l.get('X')!.state, 'candidate');
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
