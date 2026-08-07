import { PumpfunMcpServer } from "./mcp/pumpfunMcpServer";
import { PumpfunMcpClient } from "./mcp/pumpfunMcpClient";
import { RugCheckService } from "./services/rugcheckService";
import { DexScreenerService } from "./services/dexscreenerService";
import { RiskFilter } from "./filters/riskFilter";
import { Scheduler } from "./scheduler";
import { PumpTokenLaunch } from "./types";

async function main() {
  console.log("🚀 Initializing Pump.fun Token Screening Pipeline...");

  // 1. Initialize MCP Server & Client
  const mcpServer = new PumpfunMcpServer();
  const mcpClient = new PumpfunMcpClient(mcpServer);
  await mcpClient.connect();

  // 2. Initialize Services & Risk Filter
  const rugCheckService = new RugCheckService({
    maxRetries: 3,
    retryDelayMs: 1000,
    rateLimitMs: 400,
  });

  const riskFilter = new RiskFilter({
    maxScore: 1000,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
    minLpLockedPct: 0,
  });

  // 3. Initialize Scheduler (Reporting every 5 minutes in production, or immediate test report)
  // For demonstration in CLI, we set 5-minute interval and trigger initial evaluation
  const REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const scheduler = new Scheduler({
    intervalMs: REPORT_INTERVAL_MS,
    onReport: (report) => {
      console.log(`[Pipeline] Periodic report delivered with ${report.passedCount} safe token(s).`);
    },
  });

  scheduler.start();

  // Helper pipeline function to evaluate single token launch
  const processLaunch = async (launch: PumpTokenLaunch) => {
    try {
      console.log(`\n🔍 Screening launch: [${launch.symbol}] ${launch.name} (${launch.mint})`);

      // Enrich with live market microstructure before scoring. Without this the
      // filter has no demand data to work with and correctly rejects everything.
      const dex = await DexScreenerService.getTokenMarketData(launch.mint);
      const enriched: Partial<PumpTokenLaunch> = { ...launch, hasLiveMarketData: dex.hasPair };
      if (dex.hasPair) {
        enriched.priceUsd = dex.priceUsd;
        enriched.volume5mUsd = dex.volume5mUsd;
        enriched.volume1hUsd = dex.volume1hUsd;
        enriched.marketCapUsd = dex.marketCapUsd;
        enriched.fdvUsd = dex.fdvUsd;
        enriched.liquidityUsd = dex.liquidityUsd;
        enriched.buys5m = dex.buys5m;
        enriched.sells5m = dex.sells5m;
        enriched.buyPressurePct = dex.buyPressurePct;
        enriched.priceChange5mPct = dex.priceChange5mPct;
        enriched.priceChange1hPct = dex.priceChange1hPct;
        enriched.turnover5m = dex.turnover5m;
        enriched.socialCount = dex.socialCount;
        enriched.isBoosted = dex.isBoosted;
        enriched.pairAgeSeconds = dex.pairAgeSeconds;
      }

      const report = await rugCheckService.getReport(launch.mint);
      const evalResult = riskFilter.evaluateToken(report, enriched);

      scheduler.addEvaluatedToken(evalResult);

      if (evalResult.isSafe) {
        console.log(`✅ [SAFE TOKEN DETECTED] ${evalResult.tokenSymbol} - Score: ${evalResult.score}`);
      } else {
        console.log(`⚠️ [RISKY TOKEN FLAGGED] ${evalResult.tokenSymbol} - Reasons: ${evalResult.reasons.join(" | ")}`);
      }
    } catch (error) {
      console.error(`❌ Error screening launch ${launch.mint}:`, error);
    }
  };

  // 4. Fetch existing latest launches via MCP tool
  console.log("\n📥 Fetching recent launches via MCP client tool 'get_latest_pump_launches'...");
  const initialLaunches = await mcpClient.getLatestLaunches(5);
  console.log(`Found ${initialLaunches.length} initial launches. Processing...`);

  for (const launch of initialLaunches) {
    await processLaunch(launch);
  }

  // 5. Subscribe to real-time launches via MCP client tool 'subscribe_pump_launches'
  console.log("\n📡 Subscribing to live launch stream via MCP client tool 'subscribe_pump_launches'...");
  await mcpClient.subscribeLaunches(true);

  mcpClient.onLiveLaunch((launch) => {
    console.log(`\n⚡ Real-time stream event received: ${launch.symbol} (${launch.mint})`);
    processLaunch(launch).catch((err) => console.error("Error processing live launch:", err));
  });

  // Trigger an initial report summary after initial processing
  console.log("\n📊 Triggering immediate initial pipeline summary report:");
  scheduler.generateAndSendReport();

  console.log("🟢 Pipeline running! Press Ctrl+C to exit.\n");

  // Graceful shutdown handling
  const shutdown = () => {
    console.log("\n🛑 Shutting down Pump.fun Token Screening Pipeline...");
    scheduler.stop();
    mcpServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error in pipeline:", err);
  process.exit(1);
});
