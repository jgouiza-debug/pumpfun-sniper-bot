/**
 * Proofs for the launch tape — the rule that decides whether a fresh
 * launch's inflow came from a crowd or from one hand.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LaunchTape, LAUNCH_TAPE_MAX_MINTS, type LaunchTapeRules, type TapeTrade } from '../services/launchTape';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err?.message ?? err}`);
  }
}

const RULES: LaunchTapeRules = { minDistinctBuyers: 3, minDistinctSlots: 2, maxSingleBuyerPct: 60 };
const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DEV = 'DevWalletXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const SOL = 1_000_000_000n;

let sigN = 0;
function buy(user: string, sol: number, slot: number, extra: Partial<TapeTrade> = {}): TapeTrade {
  return {
    mint: MINT, user, isBuy: true, solLamports: BigInt(Math.round(sol * 1e9)), slot,
    signature: `sig${++sigN}`, err: null, ...extra,
  };
}

function armed(): LaunchTape {
  const t = new LaunchTape();
  t.arm(MINT, { creator: DEV, armedAt: 0 });
  return t;
}

console.log('\n-- The bundle: one hand, one slot --');

test('THE FARM: 1.5 SOL from three wallets in the create slot is refused as one bundle', () => {
  const t = armed();
  t.observe(buy('w1', 0.5, 100));
  t.observe(buy('w2', 0.5, 100));
  t.observe(buy('w3', 0.5, 100));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.ok, false);
  assert.ok(/one bundle/.test(v.reason), v.reason);
  assert.strictEqual(v.buyers, 3);
  assert.strictEqual(v.slots, 1);
});

test('one whale is one hand, however many slots', () => {
  const t = armed();
  t.observe(buy('whale', 2, 100));
  t.observe(buy('w2', 0.1, 101));
  t.observe(buy('w3', 0.1, 102));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.ok, false);
  assert.ok(/one wallet/.test(v.reason), v.reason);
  assert.ok(v.topBuyerPct > 90, `top ${v.topBuyerPct}`);
});

test('two buyers are not a crowd', () => {
  const t = armed();
  t.observe(buy('w1', 0.6, 100));
  t.observe(buy('w2', 0.6, 101));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.ok, false);
  assert.ok(/need 3/.test(v.reason), v.reason);
});

console.log('\n-- The crowd --');

test('three strangers over two slots with no one dominant passes', () => {
  const t = armed();
  t.observe(buy('w1', 0.4, 100));
  t.observe(buy('w2', 0.4, 101));
  t.observe(buy('w3', 0.4, 101));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.buyers, 3);
  assert.strictEqual(v.slots, 2);
  assert.ok(Math.abs(v.strangerSol - 1.2) < 1e-9, `strangerSol ${v.strangerSol}`);
});

test('a wallet buying twice is still one buyer, and its total is what the share uses', () => {
  const t = armed();
  t.observe(buy('w1', 0.5, 100));
  t.observe(buy('w1', 0.5, 101));
  t.observe(buy('w2', 0.2, 102));
  t.observe(buy('w3', 0.2, 103));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.buyers, 3);
  assert.strictEqual(v.ok, false);
  assert.ok(/one wallet/.test(v.reason), v.reason);
});

console.log('\n-- What never counts --');

test('THE CREATOR is not a stranger, whatever they top up', () => {
  const t = armed();
  t.observe(buy(DEV, 5, 100));
  t.observe(buy(DEV, 5, 101));
  t.observe(buy(DEV, 5, 102));
  const v = t.verdict(MINT, RULES, true);
  assert.strictEqual(v.buyers, 0);
  assert.strictEqual(v.strangerSol, 0);
  assert.strictEqual(v.ok, false);
});

test('a FAILED transaction moved nothing', () => {
  const t = armed();
  t.observe(buy('w1', 1, 100, { err: { InstructionError: [0, 'Custom'] } }));
  assert.strictEqual(t.verdict(MINT, RULES, true).buyers, 0);
});

test('a SELL is not demand', () => {
  const t = armed();
  t.observe(buy('w1', 1, 100, { isBuy: false }));
  assert.strictEqual(t.verdict(MINT, RULES, true).buyers, 0);
});

test('a replayed signature counts once', () => {
  const t = armed();
  const b = buy('w1', 0.5, 100);
  t.observe(b);
  t.observe({ ...b });
  const v = t.verdict(MINT, RULES, true);
  assert.ok(Math.abs(v.strangerSol - 0.5) < 1e-9, `strangerSol ${v.strangerSol}`);
});

test('a trade about some OTHER mint is ignored', () => {
  const t = armed();
  t.observe(buy('w1', 1, 100, { mint: 'SomeOtherMint' }));
  assert.strictEqual(t.verdict(MINT, RULES, true).buyers, 0);
});

console.log('\n-- A tape that cannot vouch says no --');

test('NOT LIVE: inflow the tape did not see is not attributed, so the snipe does not fire', () => {
  const t = armed();
  t.observe(buy('w1', 0.4, 100));
  t.observe(buy('w2', 0.4, 101));
  t.observe(buy('w3', 0.4, 102));
  const v = t.verdict(MINT, RULES, false);
  assert.strictEqual(v.ok, false);
  assert.ok(/not live/.test(v.reason), v.reason);
});

test('an unarmed mint has no verdict but ok:false', () => {
  const t = new LaunchTape();
  assert.strictEqual(t.verdict('nope', RULES, true).ok, false);
});

test('disarm forgets the mint; clear forgets all', () => {
  const t = armed();
  t.arm('M2', { armedAt: 0 });
  t.disarm(MINT);
  assert.deepStrictEqual(t.armedMints(), ['M2']);
  t.clear();
  assert.deepStrictEqual(t.armedMints(), []);
});

console.log('\n-- The cap --');

test(`past ${LAUNCH_TAPE_MAX_MINTS} armed mints the OLDEST is evicted and named`, () => {
  const t = new LaunchTape();
  for (let i = 0; i < LAUNCH_TAPE_MAX_MINTS; i++) assert.strictEqual(t.arm(`m${i}`, { armedAt: i }), null);
  const evicted = t.arm('overflow', { armedAt: 999 });
  assert.strictEqual(evicted, 'm0');
  assert.strictEqual(t.isArmed('m0'), false);
  assert.strictEqual(t.armedMints().length, LAUNCH_TAPE_MAX_MINTS);
});

test('re-arming an armed mint is a no-op, not a reset', () => {
  const t = armed();
  t.observe(buy('w1', 0.5, 100));
  assert.strictEqual(t.arm(MINT, { creator: DEV, armedAt: 5 }), null);
  assert.strictEqual(t.verdict(MINT, RULES, true).buyers, 1);
});

console.log('\n-- The engine consults it on the real path --');

const engineSrc = readFileSync(join(__dirname, '..', 'services', 'sniperEngine.ts'), 'utf8');

test('the momentum trigger asks the tape before firing, and the curve inflow alone is no longer enough', () => {
  const trigger = engineSrc.slice(
    engineSrc.indexOf('// --- Launch-snipe momentum trigger (Play 1) ---'),
    engineSrc.indexOf('await this.fireLaunchSnipe({', engineSrc.indexOf('// --- Launch-snipe momentum trigger (Play 1) ---')),
  );
  assert.ok(/this\.launchTape\.verdict\(/.test(trigger), 'the verdict must gate the fire');
  assert.ok(/isAddressLive\(/.test(trigger), 'liveness must come from the subscription, not be assumed');
  assert.ok(/if \(!tape\.ok\)/.test(trigger), 'a refused verdict must not fire');
});

test('the pure block-0 mode (inflow 0) is untouched — the owner opted into no confirmation there', () => {
  const create = engineSrc.slice(
    engineSrc.indexOf('private async handleLaunchCreate('),
    engineSrc.indexOf('private async fireLaunchSnipe('),
  );
  const instant = create.slice(create.indexOf('if (minInflow <= 0) {'), create.indexOf('// Arm the momentum trigger'));
  assert.ok(!/launchTape/.test(instant), 'the instant path must not consult the tape');
  assert.ok(/this\.armLaunchTape\(/.test(create), 'the armed path must start a tape');
});

test('disarming a snipe drops its tape; pausing the bot drops every tape', () => {
  const release = engineSrc.slice(
    engineSrc.indexOf('private releasePendingSnipe('),
    engineSrc.indexOf('private releasePendingSnipe(') + 600,
  );
  assert.ok(/this\.disarmLaunchTape\(mint\)/.test(release));
  const pause = engineSrc.slice(engineSrc.indexOf('this.pendingSnipes.clear();'), engineSrc.indexOf('this.pendingSnipes.clear();') + 200);
  assert.ok(/this\.clearLaunchTape\(\)/.test(pause));
});

test('the three tape rules are clamped like every other risk-bearing field', () => {
  for (const k of ['launchSnipeMinDistinctBuyers', 'launchSnipeMinDistinctSlots', 'launchSnipeMaxSingleBuyerPct']) {
    assert.ok(new RegExp(`\\['${k}', \\d`).test(engineSrc), `${k} must be in the clamp table`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
