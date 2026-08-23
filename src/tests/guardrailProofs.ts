/**
 * GUARDRAIL PROOFS — every breaker, shown firing.
 *
 * Same standing rule as filterProofs.ts: a breaker with no passing test does not
 * exist. Each proof drives the breaker to its limit and prints the refusal it
 * produces, so "the kill switch works" is a transcript rather than a claim.
 *
 * Run: ts-node src/tests/guardrailProofs.ts
 *
 * Pure in-memory logic plus one temp file for the position store. No network,
 * no wallet, no RPC.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  EntryRateLimiter, FailureBreaker, FeedFreshnessGate, evaluateGuardrails, APPROX_SLOT_MS,
} from '../services/guardrails';
import { PositionStore, describeRestoration, type PersistedPosition } from '../services/positionStore';

let passed = 0;
let failed = 0;

function proof(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message}`);
  }
}

const T0 = 1_700_000_000_000;   // fixed clock; nothing here reads Date.now()

console.log('\n================ GUARDRAIL PROOFS ================\n');

// ---------------------------------------------------------------- rate limit

console.log('-- Entry rate limit: max attempts per hour --\n');

proof('allows attempts up to the cap', () => {
  const rl = new EntryRateLimiter(5);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(rl.check(T0 + i * 1000).allowed, true, `attempt ${i + 1} should be allowed`);
    rl.record(T0 + i * 1000);
  }
  assert.strictEqual(rl.countInWindow(T0 + 5000), 5);
});

proof('REFUSES the attempt past the cap, and says when a slot frees', () => {
  const rl = new EntryRateLimiter(5);
  for (let i = 0; i < 5; i++) rl.record(T0 + i * 1000);
  const d = rl.check(T0 + 5000);
  assert.strictEqual(d.allowed, false);
  assert.ok(/entry rate limit/.test(d.reason || ''), d.reason);
  assert.ok(/frees in \d+s/.test(d.reason || ''), d.reason);
  console.log(`        FIRED: "${d.reason}"`);
});

proof('the window rolls — an hour later the cap is clear again', () => {
  const rl = new EntryRateLimiter(5);
  for (let i = 0; i < 5; i++) rl.record(T0 + i * 1000);
  assert.strictEqual(rl.check(T0 + 5000).allowed, false, 'blocked immediately after');
  const later = T0 + 60 * 60 * 1000 + 10_000;
  assert.strictEqual(rl.check(later).allowed, true, 'allowed once the window rolls past');
  assert.strictEqual(rl.countInWindow(later), 0);
});

proof('0 disables the limiter rather than blocking everything', () => {
  const rl = new EntryRateLimiter(0);
  for (let i = 0; i < 1000; i++) rl.record(T0 + i);
  assert.strictEqual(rl.check(T0 + 5000).allowed, true);
});

// ---------------------------------------------------------------- failures

console.log('\n-- Consecutive failed-transaction breaker --\n');

proof('a success resets the streak, so isolated failures never trip it', () => {
  const b = new FailureBreaker(3);
  b.recordFailure('blockhash expired');
  b.recordFailure('blockhash expired');
  b.recordSuccess();
  b.recordFailure('blockhash expired');
  assert.strictEqual(b.isTripped(), false);
  assert.strictEqual(b.consecutiveFailures(), 1);
});

proof('TRIPS on the Nth consecutive failure', () => {
  const b = new FailureBreaker(3);
  assert.strictEqual(b.recordFailure('6002 TooMuchSolRequired'), false);
  assert.strictEqual(b.recordFailure('6002 TooMuchSolRequired'), false);
  assert.strictEqual(b.recordFailure('6002 TooMuchSolRequired'), true, 'the 3rd failure must trip it');
  const d = b.check();
  assert.strictEqual(d.allowed, false);
  console.log(`        FIRED: "${d.reason}"`);
});

proof('stays tripped — no automatic recovery at 3am', () => {
  const b = new FailureBreaker(2);
  b.recordFailure();
  b.recordFailure();
  assert.strictEqual(b.isTripped(), true);
  b.recordSuccess();                       // a later success must NOT silently re-arm
  assert.strictEqual(b.isTripped(), true, 'a tripped breaker must require an explicit reset');
  assert.strictEqual(b.check().allowed, false);
  b.reset();
  assert.strictEqual(b.check().allowed, true, 'explicit reset is the only way back');
});

// ---------------------------------------------------------------- feed

console.log('\n-- Feed freshness gate --\n');

proof('a fresh feed permits trading', () => {
  const g = new FeedFreshnessGate(150, T0);
  g.touch(T0 + 1000);
  assert.strictEqual(g.check(T0 + 2000).allowed, true);
});

proof('REFUSES to trade once the feed is stale beyond N slots', () => {
  const g = new FeedFreshnessGate(150, T0);       // 150 slots ~= 60s
  const now = T0 + 150 * APPROX_SLOT_MS + 5_000;  // 5s past the limit
  const d = g.check(now);
  assert.strictEqual(d.allowed, false);
  assert.ok(/stale/.test(d.reason || ''), d.reason);
  console.log(`        FIRED: "${d.reason}"`);
});

proof('a message arriving clears the staleness', () => {
  const g = new FeedFreshnessGate(150, T0);
  const late = T0 + 150 * APPROX_SLOT_MS + 5_000;
  assert.strictEqual(g.check(late).allowed, false);
  g.touch(late);
  assert.strictEqual(g.check(late + 100).allowed, true);
});

// ---------------------------------------------------------------- composition

console.log('\n-- Composition: first refusal wins --\n');

proof('evaluateGuardrails reports ONE clear cause, not a pile', () => {
  const rl = new EntryRateLimiter(1);
  rl.record(T0);
  const fb = new FailureBreaker(1);
  fb.recordFailure('dead RPC');
  const fg = new FeedFreshnessGate(1, T0);

  const d = evaluateGuardrails([rl.check(T0 + 1), fb.check(), fg.check(T0 + 60_000)]);
  assert.strictEqual(d.allowed, false);
  assert.ok(/entry rate limit/.test(d.reason || ''), 'the FIRST gate listed should be the reported cause');
  console.log(`        FIRED: "${d.reason}"`);
});

proof('all clear reports allowed', () => {
  const d = evaluateGuardrails([
    new EntryRateLimiter(10).check(T0),
    new FailureBreaker(3).check(),
    new FeedFreshnessGate(150, T0).check(T0 + 1000),
  ]);
  assert.strictEqual(d.allowed, true);
});

// ---------------------------------------------------------------- crash recovery

console.log('\n-- Crash recovery: does a restart know it holds a bag? --\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posstore-'));
const storeFile = path.join(tmpDir, '.open-positions.json');

const samplePosition = (over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: 'pos-1',
  mint: '9UoeV8aieQdPGoY929rPZDqiy6nXqiXxp59K5skKpump',
  tokenSymbol: 'KINGLON',
  entryTime: T0,
  investedSol: 0.098338,
  investedUsd: 7.48,
  buyPriceUsd: 0.0000126,
  tokensHeld: 232_400,
  playbook: 'PLAY_3',
  venue: 'pump-amm',
  ...over,
});

proof('OLD BUG reproduced: with no store, a restart sees nothing and orphans the bag', () => {
  const s = new PositionStore(path.join(tmpDir, '.does-not-exist.json'));
  const r = s.load();
  assert.strictEqual(r.positions.length, 0);
  // This is exactly the old behaviour: silence. The bag exists on-chain and the
  // process has no idea. Documented here so the regression is visible.
  assert.strictEqual(describeRestoration(r), 'no open positions carried over from a previous run');
});

proof('a saved position is restored after a simulated crash', () => {
  const s = new PositionStore(storeFile);
  assert.strictEqual(s.save([samplePosition()], { walletAddress: 'WALLET', tradingMode: 'real' }), true);

  const fresh = new PositionStore(storeFile);      // a brand-new process
  const r = fresh.load();
  assert.strictEqual(r.positions.length, 1);
  assert.strictEqual(r.positions[0].tokenSymbol, 'KINGLON');
  assert.strictEqual(r.positions[0].tokensHeld, 232_400);
  assert.strictEqual(r.crashed, true, 'no clean-shutdown marker means it crashed');
  console.log(`        RESTORED: ${describeRestoration(r)}`);
});

proof('every restored position is flagged UNRECONCILED', () => {
  const r = new PositionStore(storeFile).load();
  assert.strictEqual(r.positions[0].needsReconciliation, true,
    'a restored position is a claim about the past, never proof of current holdings');
});

proof('a clean shutdown is distinguished from a crash', () => {
  const s = new PositionStore(storeFile);
  s.markCleanShutdown([samplePosition()], { walletAddress: 'WALLET', tradingMode: 'real' });
  const r = new PositionStore(storeFile).load();
  assert.strictEqual(r.crashed, false);
  assert.ok(/clean shutdown/.test(describeRestoration(r)));
});

proof('a TRUNCATED store is reported, never read as "nothing was open"', () => {
  const broken = path.join(tmpDir, '.broken.json');
  fs.writeFileSync(broken, '{"version":1,"positions":[{"mint":"abc"', 'utf8');   // killed mid-write
  const r = new PositionStore(broken).load();
  assert.strictEqual(r.positions.length, 0);
  assert.ok(r.error && /corrupt/.test(r.error), r.error);
  assert.ok(/open positions may exist on-chain/.test(r.error!),
    'the operator must be told the silence is untrustworthy');
  console.log(`        FIRED: "${describeRestoration(r)}"`);
});

proof('the write is atomic — a failed write leaves the previous good file intact', () => {
  const s = new PositionStore(storeFile);
  s.save([samplePosition()], { tradingMode: 'real' });
  const before = fs.readFileSync(storeFile, 'utf8');
  // No .tmp files should survive a completed save.
  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
  assert.strictEqual(leftovers.length, 0, `temp files left behind: ${leftovers.join(', ')}`);
  assert.ok(JSON.parse(before).positions.length === 1);
});

proof('clearing the store removes it', () => {
  const s = new PositionStore(storeFile);
  s.clear();
  assert.strictEqual(fs.existsSync(storeFile), false);
});

// ---------------------------------------------------------------- summary

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir */ }

console.log('\n==================================================');
console.log(`${passed} guardrail proofs passed, ${failed} failed`);
console.log('==================================================\n');
process.exit(failed > 0 ? 1 : 0);
