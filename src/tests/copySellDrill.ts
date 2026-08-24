/**
 * COPY-SELL DRILL — an end-to-end paper session through the REAL signal
 * pipeline: leader buy → partial leader sell → full leader sell, plus the
 * copySells-off and transfer-classification gates. Injects LeaderSignals into
 * handleLeaderSignal exactly as the Helius lane would and asserts that the
 * bot actually sells: counters, position lifecycle, and history records.
 *
 * WHY (2026-08-23, "the bot did NOT sell"): the sell path had no offline
 * proof at all — every regression in it was discovered with real money.
 *
 * Runs in a temp working directory so `.copy-trader.json` and `bot.log`
 * never touch a live install. Run: `ts-node src/tests/copySellDrill.ts`
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-sell-drill-'));
process.chdir(drillDir);

// Loaded only AFTER chdir: state files resolve from process.cwd() at import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { copyTrader } = require('../services/copyTraderService');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeWallet(svc: any, address: string) {
  svc.wallets.set(address, {
    address,
    shortAddress: `${address.slice(0, 4)}...${address.slice(-4)}`,
    nickname: 'drill-leader',
    enabled: true,
    addedAt: Date.now(),
    lastSeenAt: null,
    buysSeen: 0,
    sellsSeen: 0,
    copiedBuys: 0,
    copiedSells: 0,
    skippedSignals: 0,
    realizedPnlUsd: 0,
    lastCopiedBuyAt: null,
  });
  return svc.wallets.get(address);
}

async function main(): Promise<void> {
  const svc: any = copyTrader;
  svc.config = {
    ...svc.config,
    enabled: true,
    tradingMode: 'paper',
    copySells: true,
    sellMode: 'mirror',
    buySizeMode: 'fixed',
    fixedBuySol: 0.05,
    maxBuySol: 1,
    minLeaderBuySol: 0,
    blockRepeatBuys: false,
    maxOpenPositions: 10,
    perWalletCooldownSec: 0,
    feedAutoClearMinutes: 0,
  };

  const LEADER = 'DrillLeader11111111111111111111111111111111';
  const MINT = 'DrillMint111111111111111111111111111111pump';
  const wallet = makeWallet(svc, LEADER);

  console.log('\n-- 1. Leader BUY is copied (paper) --');
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_buy_1', mint: MINT, side: 'buy', solAmount: 0.5,
    tokenAmount: 100_000, priceSol: 0.000005, pool: 'pump', via: 'helius', kind: 'trade',
  });
  let pos = svc.positions.find((p: any) => p.mint === MINT && p.status !== 'CLOSED');
  check('a copy position opened', Boolean(pos), 'no open position after the buy signal');
  check('buysSeen=1, copiedBuys=1', wallet.buysSeen === 1 && wallet.copiedBuys === 1,
    `buysSeen=${wallet.buysSeen} copiedBuys=${wallet.copiedBuys}`);
  const tokensAfterBuy = pos ? pos.tokensHeld : 0;
  check('tokens are held', tokensAfterBuy > 0, `tokensHeld=${tokensAfterBuy}`);

  console.log('\n-- 2. Leader sells HALF → mirrored partial exit --');
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_sell_1', mint: MINT, side: 'sell', solAmount: 0.3,
    tokenAmount: 50_000, remainingTokens: 50_000, priceSol: 0.000006,
    pool: 'pump', via: 'helius', kind: 'trade',
  });
  pos = svc.positions.find((p: any) => p.mint === MINT);
  check('sellsSeen=1, copiedSells=1', wallet.sellsSeen === 1 && wallet.copiedSells === 1,
    `sellsSeen=${wallet.sellsSeen} copiedSells=${wallet.copiedSells}`);
  check('position is PARTIAL', pos?.status === 'PARTIAL', `status=${pos?.status}`);
  check('about half the bag was sold', pos && Math.abs(pos.tokensHeld - tokensAfterBuy / 2) < tokensAfterBuy * 0.01,
    `tokensHeld=${pos?.tokensHeld} of ${tokensAfterBuy}`);

  console.log('\n-- 3. Leader EXITS FULLY → position closes --');
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_sell_2', mint: MINT, side: 'sell', solAmount: 0.3,
    tokenAmount: 50_000, remainingTokens: 0, priceSol: 0.000006,
    pool: 'pump', via: 'helius', kind: 'trade',
  });
  pos = svc.positions.find((p: any) => p.mint === MINT);
  check('position is CLOSED with 0 tokens', pos?.status === 'CLOSED' && pos?.tokensHeld === 0,
    `status=${pos?.status} tokensHeld=${pos?.tokensHeld}`);
  check('sellsSeen=2, copiedSells=2', wallet.sellsSeen === 2 && wallet.copiedSells === 2,
    `sellsSeen=${wallet.sellsSeen} copiedSells=${wallet.copiedSells}`);
  const sells = svc.history.filter((h: any) => h.side === 'sell' && h.mint === MINT);
  check('history holds 2 sell records', sells.length === 2, `found ${sells.length}`);
  check('paper sells carry sim_ txids', sells.every((h: any) => String(h.txid).startsWith('sim_')));

  console.log('\n-- 4. copySells OFF → the bot HOLDS and says so --');
  const MINT2 = 'DrillMint222222222222222222222222222222pump';
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_buy_2', mint: MINT2, side: 'buy', solAmount: 0.5,
    tokenAmount: 100_000, priceSol: 0.000005, pool: 'pump', via: 'helius', kind: 'trade',
  });
  svc.config.copySells = false;
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_sell_3', mint: MINT2, side: 'sell', solAmount: 0.6,
    tokenAmount: 100_000, remainingTokens: 0, priceSol: 0.000006,
    pool: 'pump', via: 'helius', kind: 'trade',
  });
  const pos2 = svc.positions.find((p: any) => p.mint === MINT2);
  check('position stays OPEN with copySells off', pos2?.status === 'OPEN', `status=${pos2?.status}`);
  check('the HOLDING line reached the feed', svc.feed.some((f: any) => /HOLDING/.test(f.detail)));
  svc.config.copySells = true;

  console.log('\n-- 5. Token MOVES: a held bag leaving the leader wallet is an exit --');
  // 5a. Dust shuffle (0.5% of the bag) — held, not mirrored.
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_move_dust', mint: MINT2, side: 'sell', solAmount: 0,
    tokenAmount: 500, remainingTokens: 99_500, pool: undefined, via: 'helius', kind: 'transfer',
  });
  check('a dust-level move (0.5%) is HELD', svc.positions.find((p: any) => p.mint === MINT2)?.status === 'OPEN');
  check('the dust hold reached the feed', svc.feed.some((f: any) => /dust-level shuffle/.test(f.detail)));

  // 5b. The full bag leaves with no SOL back (the 2026-08-23 cupsey exit shape).
  const sellsSeenBefore = wallet.sellsSeen;
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_move_full', mint: MINT2, side: 'sell', solAmount: 0,
    tokenAmount: 100_000, remainingTokens: 0, pool: undefined, via: 'helius', kind: 'transfer',
  });
  const pos2b = svc.positions.find((p: any) => p.mint === MINT2);
  check('a full token move MIRRORS as an exit — position CLOSED', pos2b?.status === 'CLOSED',
    `status=${pos2b?.status}`);
  check('the move counted as a sell', wallet.sellsSeen === sellsSeenBefore + 1,
    `sellsSeen ${sellsSeenBefore} → ${wallet.sellsSeen}`);
  check('the EXIT explanation reached the feed', svc.feed.some((f: any) => /Treating it as an EXIT/.test(f.detail)));

  // 5c. A transfer-sell of a mint we do NOT hold stays ignored.
  const skippedBefore = wallet.skippedSignals;
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_move_unheld', mint: 'DrillMint444444444444444444444444444444pump', side: 'sell', solAmount: 0,
    tokenAmount: 100_000, remainingTokens: 0, pool: undefined, via: 'helius', kind: 'transfer',
  });
  check('un-held token move stays ignored', wallet.skippedSignals === skippedBefore + 1);

  // 5d. Tokens ARRIVING with no SOL (airdrop) stay ignored — never a buy.
  const buysBefore = wallet.buysSeen;
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_airdrop', mint: 'DrillMint555555555555555555555555555555pump', side: 'buy', solAmount: 0,
    tokenAmount: 100_000, pool: undefined, via: 'helius', kind: 'transfer',
  });
  check('airdrop-shaped inflow is never copied as a buy', wallet.buysSeen === buysBefore);

  // 5e. The toggle restores the old behavior exactly.
  const MINT6 = 'DrillMint666666666666666666666666666666pump';
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_buy_6', mint: MINT6, side: 'buy', solAmount: 0.5,
    tokenAmount: 100_000, priceSol: 0.000005, pool: 'pump', via: 'helius', kind: 'trade',
  });
  svc.config.mirrorLeaderTokenMoves = false;
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_move_toggled_off', mint: MINT6, side: 'sell', solAmount: 0,
    tokenAmount: 100_000, remainingTokens: 0, pool: undefined, via: 'helius', kind: 'transfer',
  });
  check('with the toggle OFF a full move is ignored (old behavior)',
    svc.positions.find((p: any) => p.mint === MINT6)?.status === 'OPEN');
  svc.config.mirrorLeaderTokenMoves = true;

  console.log('\n-- 6. A REAL position is never paper-exited in paper mode --');
  const MINT3 = 'DrillMint333333333333333333333333333333pump';
  svc.positions.unshift({
    id: 'cp_drill_real', mint: MINT3, tokenSymbol: 'REALBAG', tokenName: 'Real Bag',
    leaderWallet: LEADER, leaderNickname: 'drill-leader', pool: 'pump',
    tokensHeld: 1000, investedSol: 0.01, investedUsd: 1, entryPriceSol: 0.00001,
    currentPriceSol: 0.00001, pnlPct: 0, pnlUsd: 0, pnlSol: 0, entryTime: Date.now(),
    buyTxid: '5RealTxidDrill1111111111111111111111111111111111111111111111111111111111111111111111111',
    fillVerified: true, status: 'OPEN', realizedPnlUsd: 0, realizedPnlSol: 0,
    lastPriceAt: Date.now(), exitInFlight: false,
  });
  await svc.handleLeaderSignal(wallet, {
    signature: 'drill_sell_real_1', mint: MINT3, side: 'sell', solAmount: 0.5,
    tokenAmount: 1000, remainingTokens: 0, priceSol: 0.00001,
    pool: 'pump', via: 'helius', kind: 'trade',
  });
  const pos3 = svc.positions.find((p: any) => p.mint === MINT3);
  check('real position stays OPEN in paper mode', pos3?.status === 'OPEN' && pos3?.tokensHeld === 1000,
    `status=${pos3?.status} tokensHeld=${pos3?.tokensHeld}`);
  check('the refusal reached the feed', svc.feed.some((f: any) => /REAL position but trading mode is PAPER/.test(f.detail)));
  check('no phantom sell was booked', !svc.history.some((h: any) => h.mint === MINT3 && h.side === 'sell'));

  console.log(`\n==== COPY-SELL DRILL: ${passed} passed, ${failed} failed ====`);
  console.log(`(state written under ${drillDir})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('DRILL CRASHED:', err);
  process.exit(1);
});
