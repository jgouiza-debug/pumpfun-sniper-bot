/**
 * COPY REAL-MODE BUY DRILL — the branch that actually spends money.
 *
 *   npx ts-node src/tests/copyRealBuyDrill.ts
 *
 * WHY THIS EXISTS. copySellDrill.ts is the only file that drives
 * copyTraderService end to end, and it sets `tradingMode: 'paper'` — so every
 * buy it injects takes the simulated branch. The real branch, the one that
 * reserves SOL, calls the engine, consults the spend governor and decides
 * whether a position exists, had NO offline coverage at all. Every regression
 * in it was therefore discovered the same way: with real money. That is
 * precisely how a suite reports "436 passed" through the incident this drill is
 * named for.
 *
 * The engine is stubbed at the ONE seam the copy trader uses —
 * `sniperEngine.executeExternalTrade` and the wallet/status reads around it —
 * so nothing here touches a key, a socket or the chain. What is exercised for
 * real is everything the copy trader itself does: sizing, the reserves, the
 * governor gate, the result handling, and what ends up in the book.
 *
 * Runs in a temp working directory so `.copy-trader.json`, `.trade-governor.json`
 * and `bot.log` never touch a live install.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-real-buy-drill-'));
process.chdir(drillDir);

// Loaded only AFTER chdir: state files resolve from process.cwd() at import.
/* eslint-disable @typescript-eslint/no-var-requires */
const { copyTrader } = require('../services/copyTraderService');
const { sniperEngine } = require('../services/sniperEngine');
const { tradeGovernor } = require('../services/tradeGovernor');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const LEADER = 'DrillLeader22222222222222222222222222222222';
const OUR_WALLET = 'DrillOurWallet2222222222222222222222222222';

/** Every call the real buy path makes into the engine, recorded and scriptable. */
interface EngineStub {
  deployableSol: number;
  blockers: string[];
  ownedByMint: Map<string, number | null>;
  /** Queue of results executeExternalTrade returns, one per call. */
  results: Array<any>;
  calls: Array<{ action: string; mint: string; solAmount: number }>;
}

function installEngineStub(): EngineStub {
  const stub: EngineStub = {
    deployableSol: 1,
    blockers: [],
    ownedByMint: new Map(),
    results: [],
    calls: [],
  };
  const e: any = sniperEngine;
  e.getWalletStatus = () => ({
    linked: true, address: OUR_WALLET, shortAddress: 'Drill…', source: 'runtime',
    solBalance: stub.deployableSol, usdBalance: 0, deployableSol: stub.deployableSol,
    lastCheckedAt: Date.now(), rpcHealthy: true, blockers: stub.blockers,
  });
  e.refreshWalletBalance = async () => stub.deployableSol;
  e.getSizingPriorityFeeSol = () => 0.001;
  e.getInFlightEntryReservedSol = () => 0;
  e.getHeldMints = () => new Set<string>();
  e.getSolPriceUsd = () => 200;
  e.readOwnedTokenAmount = async (mint: string) => {
    const v = stub.ownedByMint.get(mint);
    return v === undefined ? 0 : v;
  };
  e.executeExternalTrade = async (action: string, mint: string, solAmount: number) => {
    stub.calls.push({ action, mint, solAmount });
    return stub.results.length ? stub.results.shift() : null;
  };
  return stub;
}

function makeWallet(svc: any, address: string) {
  svc.wallets.set(address, {
    address, shortAddress: `${address.slice(0, 4)}...${address.slice(-4)}`,
    nickname: 'drill-leader', enabled: true, addedAt: Date.now(), lastSeenAt: null,
    buysSeen: 0, sellsSeen: 0, copiedBuys: 0, copiedSells: 0, skippedSignals: 0,
    realizedPnlUsd: 0, lastCopiedBuyAt: null,
  });
  return svc.wallets.get(address);
}

function resetService(svc: any, over: Record<string, any> = {}) {
  svc.positions = [];
  svc.history = [];
  svc.feed = [];
  svc.wallets.clear();
  svc.config = {
    ...svc.config,
    enabled: true,
    tradingMode: 'real',
    copySells: true,
    sellMode: 'mirror',
    buySizeMode: 'fixed',
    fixedBuySol: 0.05,
    maxBuySol: 1,
    minLeaderBuySol: 0,
    minCopyBuySol: 0.001,
    blockRepeatBuys: false,
    maxOpenPositions: 10,
    maxSlippagePct: 10,
    perWalletCooldownSec: 0,
    feedAutoClearMinutes: 0,
    ...over,
  };
  tradeGovernor.resetSession();
  return makeWallet(svc, LEADER);
}

const buySignal = (mint: string, over: Record<string, any> = {}) => ({
  signature: `drill_${mint}_${Object.keys(over).length}`,
  mint, side: 'buy' as const, solAmount: 0.5, tokenAmount: 100_000,
  priceSol: 0.000005, pool: 'pump', via: 'helius' as const, kind: 'trade' as const,
  observedAt: Date.now(),
  ...over,
});

const lastFeed = (svc: any): string => (svc.feed[0]?.detail ?? '');

async function main(): Promise<void> {
  const svc: any = copyTrader;
  const stub = installEngineStub();

  // ------------------------------------------------------------------ 1
  console.log('\n-- 1. A buy that LANDS with a readable fill opens a verified position --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintAAAAAAAAAAAAAAAAAAAAAAAAAApump';
    stub.results = [{
      txid: 'sig_landed_1',
      fill: { txid: 'sig_landed_1', solDelta: -0.0512, tokenDelta: 9_900, feeSol: 0.001, slot: 1 },
    }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT));

    const pos = svc.positions.find((p: any) => p.mint === MINT && p.status !== 'CLOSED');
    check('a real copy position opened', Boolean(pos), lastFeed(svc));
    check('the QUANTITY came from the fill, not from arithmetic',
      pos?.tokensHeld === 9_900, `tokensHeld=${pos?.tokensHeld}`);
    check('the COST came from the fill',
      Math.abs((pos?.investedSol ?? 0) - 0.0512) < 1e-6, `investedSol=${pos?.investedSol}`);
    check('fillVerified is true only for a parsed transaction', pos?.fillVerified === true);
    check('the engine was asked for exactly one buy', stub.calls.length === 1);
  }

  // ------------------------------------------------------------------ 2
  console.log('\n-- 2. A buy that NEVER LANDS opens NOTHING (the reported phantom) --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintBBBBBBBBBBBBBBBBBBBBBBBBBBpump';
    // executeRealMainnetTrade returns null for every outcome that did not land:
    // reverted, slippage, expired, and an unresolved buy the wallet disproved.
    stub.results = [null];
    await svc.handleLeaderSignal(wallet, buySignal(MINT));

    check('NO position was opened',
      !svc.positions.some((p: any) => p.mint === MINT), 'a phantom position was created');
    check('no buy receipt was written',
      !svc.history.some((h: any) => h.mint === MINT && h.side === 'buy'));
    check('the failure is reported to the operator',
      svc.feed[0]?.action === 'failed', `feed action was ${svc.feed[0]?.action}: ${lastFeed(svc)}`);
    check('the in-flight SOL reservation was released', svc.getInFlightBuyCount() === 0);
  }

  // ------------------------------------------------------------------ 3
  console.log('\n-- 3. A landed buy whose fill is unreadable uses the WALLET, never an estimate --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintCCCCCCCCCCCCCCCCCCCCCCCCCCpump';
    stub.ownedByMint.set(MINT, 7_777);
    stub.results = [{ txid: 'sig_landed_3', fill: null }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT));

    const pos = svc.positions.find((p: any) => p.mint === MINT && p.status !== 'CLOSED');
    check('a position opened', Boolean(pos), lastFeed(svc));
    check('the quantity is the WALLET balance, not copySol/leaderPrice',
      pos?.tokensHeld === 7_777, `tokensHeld=${pos?.tokensHeld} (the old code would have invented 10000)`);
    check('it is NOT marked as a verified fill — the cost basis was never measured',
      pos?.fillVerified === false);
  }

  // ------------------------------------------------------------------ 4
  console.log('\n-- 4. A landed buy with NO readable size opens nothing rather than inventing one --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintDDDDDDDDDDDDDDDDDDDDDDDDDDpump';
    stub.ownedByMint.set(MINT, null);              // unreadable
    stub.results = [{ txid: 'sig_landed_4', fill: null }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT));

    check('NO position was opened from an unknowable quantity',
      !svc.positions.some((p: any) => p.mint === MINT), 'a position with an invented size was created');
    check('the operator is told to check the transaction',
      /solscan|CHECK/i.test(lastFeed(svc)), lastFeed(svc));
  }

  // ------------------------------------------------------------------ 5
  console.log('\n-- 5. A balance-derived DCA buy does not count the bag twice --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintEEEEEEEEEEEEEEEEEEEEEEEEEEpump';
    // First buy lands cleanly: 10,000 tokens.
    stub.results = [{
      txid: 'sig_dca_1',
      fill: { txid: 'sig_dca_1', solDelta: -0.05, tokenDelta: 10_000, feeSol: 0.001, slot: 1 },
    }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT));
    const first = svc.positions.find((p: any) => p.mint === MINT && p.status !== 'CLOSED');
    check('the first buy recorded 10,000 tokens', first?.tokensHeld === 10_000, `${first?.tokensHeld}`);

    // The leader tops up. The engine could not read the transaction, so it read
    // the WALLET — which reports the TOTAL, 14,000, not this trade's 4,000.
    stub.results = [{
      txid: 'sig_dca_2',
      fill: { txid: 'sig_dca_2', solDelta: -0.05, tokenDelta: 14_000, feeSol: 0.001, slot: 2 },
      balanceDerived: true,
    }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT, { signature: 'drill_dca_2' }));
    const merged = svc.positions.find((p: any) => p.mint === MINT && p.status !== 'CLOSED');
    check('the position holds the wallet TOTAL, not total + prior',
      merged?.tokensHeld === 14_000,
      `tokensHeld=${merged?.tokensHeld} (24000 would be the double count)`);
  }

  // ------------------------------------------------------------------ 6
  console.log('\n-- 6. The spend governor refuses the buy the ceiling forbids --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintFFFFFFFFFFFFFFFFFFFFFFFFFFpump';
    tradeGovernor.halt('drill: a latched halt must stop the copy path too');
    stub.results = [{
      txid: 'sig_should_not_happen',
      fill: { txid: 'x', solDelta: -0.05, tokenDelta: 1, feeSol: 0, slot: 1 },
    }];
    // The engine stub is what the copy trader calls, so the governor is checked
    // one level below it — assert the REAL engine gate here instead.
    const decision = tradeGovernor.checkBuy({
      now: Date.now(), mint: MINT, solAmount: 0.05, walletSol: 1,
      inFlightBuys: 0, engine: 'copy',
    });
    check('a latched halt refuses a copy buy', decision.allowed === false && decision.halted === true,
      JSON.stringify(decision));
    tradeGovernor.clearHalt();
    check('clearing the halt is an explicit operator action that works',
      tradeGovernor.checkBuy({
        now: Date.now(), mint: MINT, solAmount: 0.05, walletSol: 1,
        inFlightBuys: 0, engine: 'copy',
      }).allowed === true);
    await svc.handleLeaderSignal(wallet, buySignal(MINT));
  }

  // ------------------------------------------------------------------ 7
  console.log('\n-- 7. STOP reaches a buy that is already queued --');
  {
    const wallet = resetService(svc);
    const MINT = 'DrillRealMintGGGGGGGGGGGGGGGGGGGGGGGGGGpump';
    stub.calls = [];
    stub.results = [{
      txid: 'sig_should_not_happen',
      fill: { txid: 'x', solDelta: -0.05, tokenDelta: 1, feeSol: 0, slot: 1 },
    }];
    // The operator switches copy trading off while the signal is in flight. The
    // arrival-time check has already passed; only the execution-time re-check
    // can stop this.
    const inFlight = svc.handleLeaderSignal(wallet, buySignal(MINT));
    svc.config.enabled = false;
    await inFlight;

    check('the queued buy was NOT sent', stub.calls.length === 0,
      `the engine was called ${stub.calls.length} time(s) after STOP`);
    check('nothing was recorded', !svc.positions.some((p: any) => p.mint === MINT));
  }

  // ------------------------------------------------------------------ 8
  console.log('\n-- 8. Split sizing never stakes the whole wallet on a top-up --');
  {
    const wallet = resetService(svc, { buySizeMode: 'split', maxOpenPositions: 5 });
    stub.deployableSol = 0.5;
    const MINT = 'DrillRealMintHHHHHHHHHHHHHHHHHHHHHHHHHHpump';

    // Fill the book so a repeat buy arrives with open == slots — the exact state
    // in which the old `Math.max(1, slots - open)` floor made the divisor 1.
    for (let i = 0; i < 5; i++) {
      svc.positions.push({
        id: `p${i}`, mint: `Filler${i}`, tokenSymbol: 'F', tokenName: 'F',
        leaderWallet: LEADER, tokensHeld: 1, investedSol: 0.01, investedUsd: 2,
        entryPriceSol: 1e-8, currentPriceSol: 1e-8, pnlPct: 0, pnlUsd: 0, pnlSol: 0,
        entryTime: Date.now(), buyTxid: `real_${i}`, status: 'OPEN',
        realizedPnlUsd: 0, realizedPnlSol: 0, lastPriceAt: Date.now(),
      });
    }
    svc.positions.push({
      id: 'held', mint: MINT, tokenSymbol: 'H', tokenName: 'H',
      leaderWallet: LEADER, tokensHeld: 1000, investedSol: 0.01, investedUsd: 2,
      entryPriceSol: 1e-8, currentPriceSol: 1e-8, pnlPct: 0, pnlUsd: 0, pnlSol: 0,
      entryTime: Date.now(), buyTxid: 'real_held', status: 'OPEN',
      realizedPnlUsd: 0, realizedPnlSol: 0, lastPriceAt: Date.now(),
    });

    stub.calls = [];
    stub.results = [{
      txid: 'sig_topup',
      fill: { txid: 'sig_topup', solDelta: -0.05, tokenDelta: 1_500, feeSol: 0.001, slot: 9 },
    }];
    await svc.handleLeaderSignal(wallet, buySignal(MINT, { signature: 'drill_topup' }));

    const ordered = stub.calls[0]?.solAmount ?? 0;
    check('a top-up with the book full was sized at a SLICE, not the wallet',
      ordered > 0 && ordered <= 0.5 / 5 + 1e-9,
      `ordered ${ordered} SOL of a 0.5 SOL deployable balance (the old divisor gave the lot)`);
  }

  // ------------------------------------------------------------------ R
  console.log('\n-- R. The automatic on-chain position sync (it can CLOSE positions) --');
  {
    // WHY THIS SECTION EXISTS. This branch put syncPositionsWithOnChainBalances
    // on a 90-second timer. Before that it was reachable only from a button, so
    // an operator chose each run; now it closes positions unattended, on the
    // strength of one balance read. Nothing tested it. A reconciler that closes
    // a position it should have left alone strands a live bag, which is the
    // same loss as a phantom position wearing the opposite sign.
    const OLD = Date.now() - 10 * 60_000;   // comfortably past POSITION_SYNC_MIN_AGE_MS
    const mkPos = (svcRef: any, mint: string, held: number, over: Record<string, any> = {}) => {
      const pos = {
        id: `sync_${mint}`, mint, tokenSymbol: 'SYNC', leaderWallet: LEADER,
        leaderNickname: 'drill-leader', status: 'OPEN', buyTxid: `sig_${mint}`,
        entryTime: OLD, tokensHeld: held, investedSol: 0.05, entryPriceSol: 0.000005,
        currentPriceSol: 0.000005, realizedPnlUsd: 0, realizedPnlSol: 0,
        lastPriceAt: Date.now(), ...over,
      } as any;
      svcRef.positions.push(pos);
      return pos;
    };

    {
      resetService(svc);
      const MINT = 'DrillSyncGoneAAAAAAAAAAAAAAAAAAAAAAAAAApump';
      mkPos(svc, MINT, 10_000);
      stub.ownedByMint.set(MINT, 0);
      const r = await svc.syncPositionsWithOnChainBalances();
      const pos = svc.positions.find((p: any) => p.mint === MINT);
      check('a bag that is genuinely gone is closed as externally exited',
        r.closed === 1 && pos?.status === 'CLOSED', `closed=${r.closed} status=${pos?.status}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncBlindBBBBBBBBBBBBBBBBBBBBBBBBBpump';
      mkPos(svc, MINT, 10_000);
      // null = "could not ask", which is what a 429 storm produces — the exact
      // weather the incident happened in. Reading it as zero would close every
      // open position in the book at once.
      stub.ownedByMint.set(MINT, null);
      const r = await svc.syncPositionsWithOnChainBalances();
      const pos = svc.positions.find((p: any) => p.mint === MINT);
      check('an UNREADABLE balance closes nothing and is reported as unreadable',
        r.closed === 0 && r.unreadable === 1 && pos?.status === 'OPEN',
        `closed=${r.closed} unreadable=${r.unreadable} status=${pos?.status}`);
      check('the position keeps its recorded quantity when the chain could not be asked',
        pos?.tokensHeld === 10_000, `tokensHeld=${pos?.tokensHeld}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncDriftCCCCCCCCCCCCCCCCCCCCCCCCCpump';
      const pos = mkPos(svc, MINT, 10_000);
      stub.ownedByMint.set(MINT, 8_000);   // 20% drift — the chain is the truth
      const r = await svc.syncPositionsWithOnChainBalances();
      check('a drifted quantity is corrected to the chain, not closed',
        r.corrected === 1 && r.closed === 0 && pos.tokensHeld === 8_000,
        `corrected=${r.corrected} closed=${r.closed} tokensHeld=${pos.tokensHeld}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncExitingDDDDDDDDDDDDDDDDDDDDDDDpump';
      mkPos(svc, MINT, 10_000, { exitInFlight: true });
      // A sell mid-settlement has already moved part of the bag. Correcting to
      // the interim balance mis-sizes the rest of the exit; reading it as empty
      // closes a position that is still selling.
      stub.ownedByMint.set(MINT, 0);
      const r = await svc.syncPositionsWithOnChainBalances();
      const pos = svc.positions.find((p: any) => p.mint === MINT);
      check('a position with an exit IN FLIGHT is not touched',
        r.checked === 0 && pos?.status === 'OPEN' && pos?.tokensHeld === 10_000,
        `checked=${r.checked} status=${pos?.status}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncYoungEEEEEEEEEEEEEEEEEEEEEEEEEpump';
      // Five seconds old, not zero seconds old. `entryTime: Date.now()` would
      // be excluded by `age > 0` even with the minimum age set to nothing, so
      // the test would pass against a build that had no age rule at all —
      // which is exactly what mutation-testing this file caught it doing.
      mkPos(svc, MINT, 10_000, { entryTime: Date.now() - 5_000 });
      // A token account can lag a landed buy by seconds. Zero on a brand-new
      // position is propagation, not absence — and treating it as absence
      // deletes a real position moments after opening it.
      stub.ownedByMint.set(MINT, 0);
      const r = await svc.syncPositionsWithOnChainBalances();
      const pos = svc.positions.find((p: any) => p.mint === MINT);
      check('a position younger than the minimum age is not touched',
        r.checked === 0 && pos?.status === 'OPEN', `checked=${r.checked} status=${pos?.status}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncPaperFFFFFFFFFFFFFFFFFFFFFFFFFpump';
      mkPos(svc, MINT, 10_000, { buyTxid: 'sim_paper_1' });
      stub.ownedByMint.set(MINT, 0);
      const r = await svc.syncPositionsWithOnChainBalances();
      const pos = svc.positions.find((p: any) => p.mint === MINT);
      check('a PAPER position is skipped — it has no on-chain balance to read',
        r.checked === 0 && pos?.status === 'OPEN', `checked=${r.checked}`);
    }

    {
      resetService(svc);
      const MINT = 'DrillSyncRaceGGGGGGGGGGGGGGGGGGGGGGGGGpump';
      const pos = mkPos(svc, MINT, 10_000);
      // THE RACE THE RE-CHECK EXISTS FOR. The exclusions are a snapshot, and
      // the loop awaits a balance read per position. A leader sell arriving
      // mid-read sets exitInFlight on a position this loop is about to act on.
      // Without the re-check AFTER the await, the interim balance is written
      // back as truth or read as empty and the position closed mid-exit.
      stub.ownedByMint.set(MINT, 0);
      const engineAny: any = sniperEngine;
      const realReader = engineAny.readOwnedTokenAmount;
      engineAny.readOwnedTokenAmount = async (m: string) => {
        pos.exitInFlight = true;             // the sell starts while we are asking
        return realReader.call(engineAny, m);
      };
      const r = await svc.syncPositionsWithOnChainBalances();
      engineAny.readOwnedTokenAmount = realReader;
      check('an exit that starts DURING the balance read still protects the position',
        r.closed === 0 && pos.status === 'OPEN' && pos.tokensHeld === 10_000,
        `closed=${r.closed} status=${pos.status} tokensHeld=${pos.tokensHeld}`);
    }
  }

  console.log(`\n==== COPY REAL-BUY DRILL: ${passed} passed, ${failed} failed ====`);
  console.log(`(state written under ${drillDir})`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch(err => {
  console.error('drill crashed:', err);
  process.exit(1);
});
