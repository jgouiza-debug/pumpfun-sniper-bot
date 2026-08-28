/**
 * Standalone runner for the agent lane — paper mode, own process, ZERO changes
 * to the sniper engine.
 *
 * Why standalone: the engine owns the live money path, and the settled plan is
 * that no agent code touches it until the paper lane has produced evidence.
 * This process opens its own PumpPortal WS (the same feed the engine uses),
 * enriches with RugCheck, and runs the full loop against PaperPort. It can run
 * TODAY, alongside or instead of the app, and crash without consequence.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx ts-node src/agent/runAgentLane.ts
 *   ... --bankroll 1.0 --review-at 12
 *
 * Stop with Ctrl+C — the journal flushes synchronously on exit.
 */

import '../services/loadEnv'; // side-effect: reads .env before anything touches process.env
import WebSocket from 'ws';
import { AgentLoop, LOOP_DEFAULTS } from './agentLoop';
import { PaperPort } from './executionPort';
import { AGENT_DEFAULTS } from './geminiClient';
import { RugCheckService } from '../services/rugcheckService';
import { DexScreenerService } from '../services/dexscreenerService';
import { PumpTokenLaunch } from '../types';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
const DEX_POLL_MS = 20_000;

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

export interface LaunchedLane { loop: AgentLoop; port: PaperPort; }

export async function launchAgentLane(): Promise<LaunchedLane> {
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set — the agent lane cannot decide without it.');
    process.exit(2);
  }

  const rugcheck = new RugCheckService();
  const port = new PaperPort(Number(arg('--bankroll', '1.0')));
  const held = new Set<string>();
  let ws: WebSocket | null = null;

  const loop = new AgentLoop(
    port,
    {
      agent: { apiKey, ...AGENT_DEFAULTS },
      ...LOOP_DEFAULTS,
      reviewAtMinutes: Number(arg('--review-at', String(LOOP_DEFAULTS.reviewAtMinutes))),
    },
    () => DexScreenerService.getSolPriceUsd(),
    (mint, hold) => {
      // Subscribe/unsubscribe the mint's trade stream so the sensors stay fed.
      if (hold) held.add(mint); else held.delete(mint);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          method: hold ? 'subscribeTokenTrade' : 'unsubscribeTokenTrade',
          keys: [mint],
        }));
      }
    }
  );

  const connect = () => {
    ws = new WebSocket(PUMPPORTAL_WS);
    ws.on('open', () => {
      console.log('[agent-lane] feed connected');
      ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
      if (held.size) ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...held] }));
    });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg?.mint) return;

      // Trade events for held mints feed the sensors and the paper price mark.
      if (held.has(msg.mint)) loop.onTradeEvent(msg);

      // New launches and migrations become candidates. Enrichment is detached —
      // a slow RugCheck must not block the feed handler.
      if (msg.txType === 'create' || msg.txType === 'migrate') {
        const launch: PumpTokenLaunch = {
          mint: msg.mint, name: msg.name ?? '', symbol: msg.symbol ?? '',
          creator: msg.traderPublicKey ?? 'Unknown', timestamp: Date.now(),
          metadataUri: msg.uri, vSolInBondingCurve: msg.vSolInBondingCurve,
          vTokensInBondingCurve: msg.vTokensInBondingCurve,
          marketCapSol: msg.marketCapSol, pool: msg.pool, ageSeconds: 0,
        };
        void rugcheck.getReport(msg.mint)
          .catch(() => null)
          .then((rug) => loop.onCandidate(launch, rug, msg.txType === 'migrate'));
      }
    });
    ws.on('close', () => { console.log('[agent-lane] feed dropped, reconnecting in 3s'); setTimeout(connect, 3_000); });
    ws.on('error', () => { /* close handler reconnects */ });
  };

  // Post-migration positions need DexScreener liquidity samples for the
  // pool-drain sensor. Poll only what is held — 1 batched call per 20s.
  setInterval(() => {
    const mints = [...held];
    if (!mints.length) return;
    void DexScreenerService.getManyTokenMarketData(mints).then((map) => {
      for (const [mint, d] of map) loop.onDexSample(mint, { priceUsd: d.priceUsd, liquidityUsd: d.liquidityUsd });
    }).catch(() => { /* sensor stays dark; ladder treats dark as silence */ });
  }, DEX_POLL_MS);

  setInterval(() => console.log('[agent-lane]', JSON.stringify(loop.status())), 60_000);

  process.on('SIGINT', () => { console.log('\n[agent-lane] stopping'); loop.stop(); process.exit(0); });

  connect();
  loop.start();
  console.log(`[agent-lane] running | policy ${loop.policy} | paper bankroll ${port.bankrollSol()} SOL`);
  return { loop, port };
}

// Bare-runner mode: `npx ts-node src/agent/runAgentLane.ts`
if (require.main === module) {
  launchAgentLane().catch((e) => { console.error(e); process.exit(1); });
}
