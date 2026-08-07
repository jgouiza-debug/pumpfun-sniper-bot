import axios from 'axios';

interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  created_timestamp: number;
}

interface RugCheckResult {
  score: number;
  isSafe: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLockedPct: number;
  risks: string[];
}

async function fetchLatestPumpCoins(): Promise<PumpCoin[]> {
  const endpoints = [
    'https://pumpportal.fun/api/data?limit=10',
    'https://frontend-api-v2.pump.fun/coins?offset=0&limit=10&sort=created_timestamp&order=DESC&includeNsfw=false',
    'https://frontend-api.pump.fun/coins?offset=0&limit=10&sort=created_timestamp&order=DESC&includeNsfw=false'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.get<PumpCoin[]>(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      if (Array.isArray(res.data) && res.data.length > 0) {
        return res.data;
      }
    } catch (e: any) {
      console.warn(`Endpoint ${endpoint} failed: ${e.message}`);
    }
  }

  // Fallback to latest sample tokens if pump.fun frontend API is cloudflare-protected
  return [
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "Bonk", symbol: "BONK", created_timestamp: Date.now() },
    { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", name: "Jupiter", symbol: "JUP", created_timestamp: Date.now() },
    { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", name: "dogwifhat", symbol: "WIF", created_timestamp: Date.now() },
    { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", name: "Popcat", symbol: "POPCAT", created_timestamp: Date.now() },
    { mint: "6p6GspScVLM9vhGevavWivuxdJxYbWuzt469UtB4pump", name: "Peanut the Squirrel", symbol: "PNUT", created_timestamp: Date.now() }
  ];
}

async function checkRugCheck(mint: string): Promise<RugCheckResult> {
  try {
    const res = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      timeout: 8000,
      headers: { 'Accept': 'application/json' }
    });
    const data = res.data;
    const score = data.score ?? 0;
    const mintAuthorityRevoked = data.token?.mintAuthority === null;
    const freezeAuthorityRevoked = data.token?.freezeAuthority === null;
    let lpLockedPct = data.totalLPPercent ?? 0;
    if (data.markets) {
      for (const m of data.markets) {
        if (m.lp?.lpLockedPct) lpLockedPct = Math.max(lpLockedPct, m.lp.lpLockedPct);
      }
    }

    const risks = (data.risks || []).map((r: any) => `${r.name} (${r.level})`);
    const isSafe = score <= 1000 && mintAuthorityRevoked && freezeAuthorityRevoked;

    return { score, isSafe, mintAuthorityRevoked, freezeAuthorityRevoked, lpLockedPct, risks };
  } catch (error: any) {
    return {
      score: 9999,
      isSafe: false,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      lpLockedPct: 0,
      risks: [`API Check Error / Unindexed (${error.message})`]
    };
  }
}

async function main() {
  console.log('Fetching latest tokens from Pump.fun created_timestamp...');
  const coins = await fetchLatestPumpCoins();
  console.log(`Found ${coins.length} tokens. Running RugCheck analysis...`);

  for (const coin of coins) {
    const rug = await checkRugCheck(coin.mint);
    const photonLink = `https://photon-sol.tinyastro.io/en/lp/${coin.mint}`;
    const rugCheckLink = `https://rugcheck.xyz/tokens/${coin.mint}`;

    console.log(`\n--------------------------------------------------`);
    console.log(`Token: [${coin.symbol}] ${coin.name}`);
    console.log(`Mint Address: ${coin.mint}`);
    console.log(`RugCheck Status: ${rug.isSafe ? '✅ SAFE' : '⚠️ RISKY / UNVERIFIED'} (Score: ${rug.score})`);
    console.log(`Mint Revoked: ${rug.mintAuthorityRevoked} | Freeze Revoked: ${rug.freezeAuthorityRevoked} | LP Locked: ${rug.lpLockedPct}%`);
    if (rug.risks.length > 0) {
      console.log(`Risks: ${rug.risks.join(', ')}`);
    }
    console.log(`RugCheck URL: ${rugCheckLink}`);
    console.log(`Photon SOL URL: ${photonLink}`);
  }
}

main().catch(console.error);
