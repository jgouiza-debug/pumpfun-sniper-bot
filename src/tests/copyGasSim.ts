/**
 * REAL-MODE GAS SIMULATION — replays the 2026-08-23 "bot did NOT sell"
 * session arithmetic through the OLD sizing math and the NEW math
 * (fresh-balance reclamp inside the queue + per-position exit-gas reserve +
 * sell-fee clamp), and asserts the new math leaves a wallet that can always
 * pay for its own exit.
 *
 * The measured session: two copy buys into one mint (0.0456 + 0.0052 SOL
 * total wallet outflow), wallet left at 0.00162 SOL, then six 100%-sell
 * attempts at the configured 0.001 SOL priority fee — all confirmation
 * timeouts, because the fee would leave the payer below the ~0.00089 SOL
 * rent-exempt minimum and validators never include such a transaction.
 *
 * The sizing read a STALE balance: getDeployableSol() returns whatever was
 * last fetched (link time, minutes earlier), and nothing on the signal path
 * forced a refresh — so both buys were clamped against a richer wallet than
 * the one that actually paid. Back-solving the measured fills gives a true
 * start of ~0.0524 SOL against a ~0.0658 SOL snapshot, which reproduces the
 * recorded outflows to within a fraction of a percent.
 *
 * Run: `ts-node src/tests/copyGasSim.ts`
 */
import {
  affordableStakeSol,
  affordableSellPriorityFeeSol,
} from '../services/pipelineUtils';

const GAS_FLOAT_SOL = 0.005;          // walletService holdback
const EXIT_RESERVE_PER_POS = 0.002;   // COPY_EXIT_GAS_RESERVE_SOL
const PRIORITY_FEE = 0.001;
const SLIPPAGE_PCT = 35;
const BASE_FEE = 0.000005;
const ATA_RENT = 0.00203928;
const PROTOCOL_FEE_FRACTION = 0.015;  // pump.fun 1% + PumpPortal 0.5%
const RENT_EXEMPT_MIN = 0.00089088;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** What one landed buy actually removes from the wallet. */
function buySpend(stake: number, firstBuyOfMint: boolean): number {
  return stake * (1 + PROTOCOL_FEE_FRACTION) + PRIORITY_FEE + BASE_FEE + (firstBuyOfMint ? ATA_RENT : 0);
}

/** A sell lands only if fees leave the payer at or above rent exemption. */
function sellCanLand(balance: number, priorityFee: number): boolean {
  return balance - priorityFee - BASE_FEE >= RENT_EXEMPT_MIN;
}

interface SessionResult {
  stakes: number[];
  balanceAfterBuys: number;
  sellFee: number;
  sellLands: boolean;
}

/**
 * Two leader buys into the same mint (the session's DCA-merge case).
 * OLD math sizes every buy from one stale snapshot; NEW math re-reads the
 * balance inside the queue and holds back exit gas per open position.
 */
function simulate(
  math: 'old' | 'new',
  trueStartBalance: number,
  staleSnapshotBalance: number,
  requestedStakes: number[]
): SessionResult {
  let balance = trueStartBalance;
  const staleDeployable = Math.max(0, staleSnapshotBalance - GAS_FLOAT_SOL);
  let openPositions = 0;
  const stakes: number[] = [];

  for (const requested of requestedStakes) {
    let deployable: number;
    if (math === 'old') {
      deployable = staleDeployable;
    } else {
      const fresh = Math.max(0, balance - GAS_FLOAT_SOL); // refreshWallet() inside the queue
      deployable = Math.max(0, fresh - EXIT_RESERVE_PER_POS * Math.max(1, openPositions));
    }
    const stake = affordableStakeSol(requested, deployable, SLIPPAGE_PCT, PRIORITY_FEE);
    stakes.push(stake);
    if (stake > 0) {
      balance -= buySpend(stake, openPositions === 0);
      openPositions = 1; // same mint — repeat buys fold into the position
    }
  }

  const sellFee = math === 'old' ? PRIORITY_FEE : affordableSellPriorityFeeSol(balance, PRIORITY_FEE);
  return { stakes, balanceAfterBuys: balance, sellFee, sellLands: sellCanLand(balance, sellFee) };
}

function report(label: string, r: SessionResult): void {
  console.log(`  ${label}`);
  console.log(`    buy stakes landed:  ${r.stakes.map(s => s.toFixed(4)).join(' + ')} SOL`);
  console.log(`    wallet after buys:  ${r.balanceAfterBuys.toFixed(5)} SOL`);
  console.log(`    sell priority fee:  ${r.sellFee} SOL`);
  console.log(`    100% exit lands:    ${r.sellLands ? 'YES' : 'NO — position stuck'}`);
}

// Back-solved from the persisted fills (investedSol is the wallet's full
// outflow): stake1 ≈ (0.0456 − rent − fees)/1.015, stake2 ≈ (0.0052 − fees)/1.015.
const TRUE_START = 0.05242;
const STALE_SNAPSHOT = 0.0658;
const REQUESTED = [0.05, 0.0042];

console.log('\n-- Replay: the measured 2026-08-23 session --');
{
  const old = simulate('old', TRUE_START, STALE_SNAPSHOT, REQUESTED);
  const fresh = simulate('new', TRUE_START, STALE_SNAPSHOT, REQUESTED);
  report('OLD math (shipped in v1.0.6):', old);
  report('NEW math (v1.0.7):', fresh);

  check('old math reproduces the measured drain (~0.0016 SOL left)',
    Math.abs(old.balanceAfterBuys - 0.00162) < 0.0005,
    `simulated ${old.balanceAfterBuys.toFixed(5)}, measured 0.00162`);
  check('old math reproduces the failure: the exit cannot land', !old.sellLands);
  check('new math: the exit lands', fresh.sellLands,
    `balance ${fresh.balanceAfterBuys.toFixed(5)}, fee ${fresh.sellFee}`);
  check('new math keeps the fee payer above rent exemption after the sell',
    fresh.balanceAfterBuys - fresh.sellFee - BASE_FEE >= RENT_EXEMPT_MIN);
  check('new math keeps the gas float intact after both buys',
    fresh.balanceAfterBuys >= GAS_FLOAT_SOL - 1e-9,
    `left ${fresh.balanceAfterBuys.toFixed(5)}`);
}

console.log('\n-- Rescue: the stranded wallet (0.00162 SOL) with the sell-fee clamp alone --');
{
  const clamped = affordableSellPriorityFeeSol(0.00162, PRIORITY_FEE);
  console.log(`    configured fee 0.001 → clamped ${clamped} SOL`);
  check('the stranded position becomes sellable', sellCanLand(0.00162, clamped),
    `fee ${clamped} still cannot land from 0.00162`);
  check('at the configured fee it stays stuck (sanity)', !sellCanLand(0.00162, PRIORITY_FEE));
}

console.log('\n-- Forward: a 0.1 SOL wallet DCAing three copy buys into one token, then exiting --');
{
  const r = simulate('new', 0.1, 0.1, [0.03, 0.03, 0.03]);
  report('NEW math:', r);
  check('the position stays exitable', r.sellLands);
  check('the wallet never dips below the gas float after buys',
    r.balanceAfterBuys >= GAS_FLOAT_SOL - 1e-9, `left ${r.balanceAfterBuys.toFixed(5)}`);
}

console.log(`\n==== COPY GAS SIM: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
