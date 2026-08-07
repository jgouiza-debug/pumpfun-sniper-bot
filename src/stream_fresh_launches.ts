import WebSocket from 'ws';
import axios from 'axios';

interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  txType?: string;
  traderPublicKey?: string;
  uri?: string;
  timestamp: number;
}

interface DexMarketData {
  volume5mUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  priceChange5mPct: number;
  pairAgeMinutes: number;
  hasMarketData: boolean;
}

interface RugCheckReport {
  score: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLockedPct: number;
  risks: string[];
  isIndexed: boolean;
}

interface EvaluatedToken {
  token: NewTokenEvent;
  dex: DexMarketData;
  rug: RugCheckReport;
  isSafe: boolean;
  disqualifyReasons: string[];
}

const CYCLE_DURATION_MS = 3000; // Auto scan every 3 seconds
const MAX_MARKET_CAP_USD = 60000; // Max $60k MC (Must be early coin before major pump)
const MAX_PRICE_CHANGE_5M_PCT = 150; // Max +150% 5m gain (Has NOT pumped a lot yet)
const MAX_PAIR_AGE_MINUTES = 30; // Max 30 minutes old (Early fresh launch)

const seenMints = new Set<string>();
let currentBatch: NewTokenEvent[] = [];
let ws: WebSocket | null = null;
let scanCycleCount = 0;

async function fetchDexMarketData(mint: string): Promise<DexMarketData> {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeout: 5000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PumpFunTokenScreener/2.0'
      }
    });

    const pairs = response.data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) {
      return {
        volume5mUsd: 0,
        marketCapUsd: 0,
        fdvUsd: 0,
        liquidityUsd: 0,
        priceChange5mPct: 0,
        pairAgeMinutes: 0,
        hasMarketData: false
      };
    }

    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const bestPair = pairs[0];

    const volume5mUsd = Number(bestPair.volume?.m5 || 0);
    const marketCapUsd = Number(bestPair.marketCap || bestPair.fdv || 0);
    const fdvUsd = Number(bestPair.fdv || marketCapUsd);
    const liquidityUsd = Number(bestPair.liquidity?.usd || 0);
    const priceChange5mPct = Number(bestPair.priceChange?.m5 || 0);

    const createdAt = bestPair.pairCreatedAt ? Number(bestPair.pairCreatedAt) : Date.now();
    const pairAgeMinutes = Math.max(0, Math.round((Date.now() - createdAt) / 60000));

    return {
      volume5mUsd,
      marketCapUsd,
      fdvUsd,
      liquidityUsd,
      priceChange5mPct,
      pairAgeMinutes,
      hasMarketData: true
    };
  } catch (err) {
    return {
      volume5mUsd: 0,
      marketCapUsd: 0,
      fdvUsd: 0,
      liquidityUsd: 0,
      priceChange5mPct: 0,
      pairAgeMinutes: 0,
      hasMarketData: false
    };
  }
}

async function fetchRugCheckReport(mint: string): Promise<RugCheckReport> {
  try {
    const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      timeout: 6000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'PumpFunTokenScreener/2.0'
      }
    });
    const data = response.data;
    const score = Number(data.score ?? 0);
    const mintAuthorityRevoked = data.token?.mintAuthority === null;
    const freezeAuthorityRevoked = data.token?.freezeAuthority === null;

    let lpLockedPct = Number(data.totalLPPercent ?? 0);
    if (Array.isArray(data.markets)) {
      for (const m of data.markets) {
        if (m.lp?.lpLockedPct !== undefined) {
          lpLockedPct = Math.max(lpLockedPct, Number(m.lp.lpLockedPct));
        }
      }
    }

    const risks = (data.risks || []).map((r: any) => `${r.name} [${r.level}]`);

    return {
      score,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      lpLockedPct,
      risks,
      isIndexed: true
    };
  } catch (err: any) {
    return {
      score: 9999,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      lpLockedPct: 0,
      risks: [`Not Indexed Yet on RugCheck`],
      isIndexed: false
    };
  }
}

/**
 * Strict Safe & Early Coin Evaluator (Filters out coins that already pumped)
 */
function evaluateTokenSafety(dex: DexMarketData, rug: RugCheckReport): { isSafe: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Check 1: RugCheck Score <= 100
  if (rug.score > 100) {
    reasons.push(`RugCheck score exceeds limit (${rug.score} > 100)`);
  }

  // Check 2: Mint Authority Revoked (null)
  if (!rug.mintAuthorityRevoked) {
    reasons.push('Mint Authority active (Token can be inflated)');
  }

  // Check 3: Freeze Authority Revoked (null)
  if (!rug.freezeAuthorityRevoked) {
    reasons.push('Freeze Authority active (Wallets can be blacklisted)');
  }

  // Check 4: 5m Volume >= $1,000
  if (dex.volume5mUsd < 1000) {
    reasons.push(`5m Volume below $1,000 threshold ($${dex.volume5mUsd.toLocaleString()} < $1,000)`);
  }

  // Check 5: Market Cap >= $1,000 AND <= $60,000 (Early micro-cap)
  if (dex.marketCapUsd < 1000) {
    reasons.push(`Market Cap below $1,000 threshold ($${dex.marketCapUsd.toLocaleString()} < $1,000)`);
  } else if (dex.marketCapUsd > MAX_MARKET_CAP_USD) {
    reasons.push(`Market Cap already pumped past $60k cap ($${dex.marketCapUsd.toLocaleString()} > $60,000)`);
  }

  // Check 6: FDV >= $1,000 AND <= $60,000
  if (dex.fdvUsd < 1000) {
    reasons.push(`FDV below $1,000 threshold ($${dex.fdvUsd.toLocaleString()} < $1,000)`);
  } else if (dex.fdvUsd > MAX_MARKET_CAP_USD) {
    reasons.push(`FDV already pumped past $60k cap ($${dex.fdvUsd.toLocaleString()} > $60,000)`);
  }

  // Check 7: Liquidity Depth >= $1,000
  if (dex.liquidityUsd < 1000) {
    reasons.push(`Liquidity below $1,000 threshold ($${dex.liquidityUsd.toLocaleString()} < $1,000)`);
  }

  // EARLY COIN CHECK 8: Has NOT pumped a lot yet (+150% max 5m price gain)
  if (dex.priceChange5mPct > MAX_PRICE_CHANGE_5M_PCT) {
    reasons.push(`Token already mega-pumped (+${dex.priceChange5mPct.toFixed(1)}% > +150% max cap)`);
  }

  // EARLY COIN CHECK 9: Fresh launch (Age <= 30 minutes)
  if (dex.pairAgeMinutes > MAX_PAIR_AGE_MINUTES) {
    reasons.push(`Token is not early (${dex.pairAgeMinutes}m old > 30m max age)`);
  }

  return {
    isSafe: reasons.length === 0,
    reasons
  };
}

function startWebSocketStream(): void {
  console.log('📡 Connecting to live Pump.fun token stream via PumpPortal WebSocket...');
  ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    console.log('⚡ Connected! Subscribed to real-time "subscribeNewToken" launch feed.');
    ws?.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.mint && !seenMints.has(payload.mint)) {
        seenMints.add(payload.mint);
        const token: NewTokenEvent = {
          mint: payload.mint,
          name: payload.name || 'Unknown Token',
          symbol: payload.symbol || 'UNK',
          txType: payload.txType,
          traderPublicKey: payload.traderPublicKey,
          uri: payload.uri,
          timestamp: Date.now()
        };
        currentBatch.push(token);
        console.log(`✨ [STREAM DETECTED] $${token.symbol} (${token.name}) | Mint: ${token.mint}`);
      }
    } catch (e) {
      // Ignore parse error
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.warn('WebSocket closed. Reconnecting in 3s...');
    setTimeout(startWebSocketStream, 3000);
  });
}

async function runScanCycle(): Promise<void> {
  scanCycleCount++;
  const batch = [...currentBatch];
  currentBatch = [];

  console.log(`\n================================================================================`);
  console.log(`⏱️ 3-SECOND AUTO SCAN CYCLE #${scanCycleCount} | Captured ${batch.length} fresh launches`);
  console.log(`🎯 FILTER CRITERIA: RugCheck <= 100 | Mint/Freeze Revoked | $1k-$60k MC/FDV | Max +150% 5m Gain`);
  console.log(`================================================================================\n`);

  if (batch.length === 0) {
    console.log('No new token launches detected during this 3s window. Waiting for next 3s cycle...\n');
    return;
  }

  console.log(`🔍 Evaluating ${batch.length} tokens against RugCheck API & DexScreener 5m Metrics...\n`);

  const evaluated: EvaluatedToken[] = [];

  for (const token of batch) {
    console.log(`   Checking $${token.symbol} (${token.mint.slice(0, 8)}...)...`);

    // Rate-limit throttle delay (300ms)
    await new Promise((r) => setTimeout(r, 300));

    const [rug, dex] = await Promise.all([
      fetchRugCheckReport(token.mint),
      fetchDexMarketData(token.mint)
    ]);

    const evaluation = evaluateTokenSafety(dex, rug);

    evaluated.push({
      token,
      dex,
      rug,
      isSafe: evaluation.isSafe,
      disqualifyReasons: evaluation.reasons
    });
  }

  const safeTokens = evaluated.filter((e) => e.isSafe);
  const rejectedTokens = evaluated.filter((e) => !e.isSafe);

  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`✅ VERIFIED SAFE EARLY COINS (${safeTokens.length}/${evaluated.length} passed strict early filters):`);
  console.log(`--------------------------------------------------------------------------------`);

  if (safeTokens.length === 0) {
    console.log('   (No coins cleared all strict safety & early pre-pump rules in this cycle)');
  } else {
    for (const { token, dex, rug } of safeTokens) {
      console.log(`\n🔥 [$${token.symbol}] ${token.name} (EARLY PRE-PUMP GEM)`);
      console.log(`   Mint Address: ${token.mint}`);
      console.log(`   🛡️ RugCheck Score: ${rug.score}/100 | Mint Revoked: ${rug.mintAuthorityRevoked} | Freeze Revoked: ${rug.freezeAuthorityRevoked}`);
      console.log(`   📊 DexScreener Metrics: 5m Vol: $${dex.volume5mUsd.toLocaleString()} | MC: $${dex.marketCapUsd.toLocaleString()} | FDV: $${dex.fdvUsd.toLocaleString()} | 5m Gain: +${dex.priceChange5mPct.toFixed(1)}% | Age: ${dex.pairAgeMinutes}m`);
      console.log(`   🛒 Photon SOL Buy Link: https://photon-sol.tinyastro.io/en/lp/${token.mint}`);
      console.log(`   🛡️ RugCheck Report Link: https://rugcheck.xyz/tokens/${token.mint}`);
    }
  }

  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`❌ REJECTED COINS (${rejectedTokens.length}/${evaluated.length} failed safety/early rules):`);
  console.log(`--------------------------------------------------------------------------------`);
  for (const { token, disqualifyReasons } of rejectedTokens) {
    console.log(`   ⚠️ $${token.symbol} (${token.mint.slice(0, 8)}...): ${disqualifyReasons.join(' | ')}`);
  }

  console.log(`\n⏳ Next automatic 3-second scan cycle scheduled...\n`);
}

function main() {
  console.log('🚀 Starting Pump.fun Early Coin Screening Pipeline (Auto Scan Every 3s)\n');
  startWebSocketStream();

  setTimeout(async () => {
    await runScanCycle();
    setInterval(runScanCycle, CYCLE_DURATION_MS);
  }, 3000);
}

if (typeof require !== 'undefined' && require.main === module) {
  main();
}

export { main, runScanCycle, evaluateTokenSafety, fetchDexMarketData, fetchRugCheckReport };
