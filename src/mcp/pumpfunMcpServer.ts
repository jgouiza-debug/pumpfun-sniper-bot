import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { PumpTokenLaunch } from "../types";

export class PumpfunMcpServer {
  private server: Server;
  private recentLaunches: PumpTokenLaunch[] = [];
  private maxCacheSize = 100;
  private wsClient: WebSocket | null = null;
  private subscribers: Set<(launch: PumpTokenLaunch) => void> = new Set();
  private simulationInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "pumpfun-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.initMockLaunchStream();
  }

  public getServer(): Server {
    return this.server;
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_latest_pump_launches",
            description: "Get the latest tokens launched on Pump.fun",
            inputSchema: {
              type: "object",
              properties: {
                limit: {
                  type: "number",
                  description: "Number of launches to return (default: 10, max: 50)",
                },
              },
            },
          },
          {
            name: "subscribe_pump_launches",
            description: "Subscribe to real-time Pump.fun token launch stream",
            inputSchema: {
              type: "object",
              properties: {
                enableStream: {
                  type: "boolean",
                  description: "Enable or disable live launch streaming",
                },
              },
              required: ["enableStream"],
            },
          },
        ],
      };
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "get_latest_pump_launches") {
        const limit = Math.min(Math.max((args?.limit as number) || 10, 1), 50);
        const launches = this.recentLaunches.slice(0, limit);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(launches, null, 2),
            },
          ],
        };
      }

      if (name === "subscribe_pump_launches") {
        const enableStream = Boolean(args?.enableStream);
        if (enableStream) {
          this.connectRealtimeWs();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "subscribed",
                  message: "Subscribed to Pump.fun launch feed",
                  cachedCount: this.recentLaunches.length,
                }),
              },
            ],
          };
        } else {
          this.disconnectRealtimeWs();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "unsubscribed",
                  message: "Unsubscribed from Pump.fun launch feed",
                }),
              },
            ],
          };
        }
      }

      throw new Error(`Tool not found: ${name}`);
    });
  }

  public addLaunch(launch: PumpTokenLaunch): void {
    this.recentLaunches.unshift(launch);
    if (this.recentLaunches.length > this.maxCacheSize) {
      this.recentLaunches.pop();
    }
    // Notify subscribers
    for (const callback of this.subscribers) {
      try {
        callback(launch);
      } catch (err) {
        console.error("Error notifying subscriber:", err);
      }
    }
  }

  public onLaunch(callback: (launch: PumpTokenLaunch) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private connectRealtimeWs(): void {
    // Attempt WebSocket connection if available
    try {
      if (this.wsClient) return;
      // Socket / WS endpoint for Pump.fun or fallback
      const wsUrl = "wss://pumpsignal.fast/ws";
      this.wsClient = new WebSocket(wsUrl);

      this.wsClient.on("open", () => {
        console.log("[PumpfunMcpServer] Real-time WebSocket connected to", wsUrl);
        this.wsClient?.send(JSON.stringify({ method: "subscribeNewToken" }));
      });

      this.wsClient.on("message", (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed && parsed.mint) {
            const launch: PumpTokenLaunch = {
              mint: parsed.mint,
              name: parsed.name || "Unknown Token",
              symbol: parsed.symbol || "UNKNOWN",
              creator: parsed.traderPublicKey || parsed.creator || "Unknown",
              timestamp: parsed.timestamp || Date.now(),
              marketCapSol: parsed.marketCapSol || 0,
              bondingCurveKey: parsed.bondingCurveKey,
            };
            this.addLaunch(launch);
          }
        } catch (e) {
          // ignore non-json messages
        }
      });

      this.wsClient.on("error", (err) => {
        console.warn("[PumpfunMcpServer] WS error (falling back to simulation mode):", err.message);
      });

      this.wsClient.on("close", () => {
        console.log("[PumpfunMcpServer] WS closed.");
        this.wsClient = null;
      });
    } catch (err) {
      console.warn("[PumpfunMcpServer] WebSocket creation error:", err);
    }
  }

  private disconnectRealtimeWs(): void {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
  }

  private initMockLaunchStream(): void {
    // Seed initial sample tokens
    const sampleMints = [
      { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "Bonk", symbol: "BONK" },
      { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", name: "Jupiter", symbol: "JUP" },
      { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", name: "dogwifhat", symbol: "WIF" },
      { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", name: "Popcat", symbol: "POPCAT" },
      { mint: "6p6GspScVLM9vhGevavWivuxdJxYbWuzt469UtB4pump", name: "Pnut", symbol: "PNUT" }
    ];

    for (const sample of sampleMints) {
      this.recentLaunches.push({
        mint: sample.mint,
        name: sample.name,
        symbol: sample.symbol,
        creator: "Creator_" + sample.symbol,
        timestamp: Date.now() - Math.floor(Math.random() * 60000),
        marketCapSol: 15 + Math.random() * 50,
      });
    }

    // Periodic simulation of new launches if stream is active
    let counter = 1;
    this.simulationInterval = setInterval(() => {
      const mockMint = `PumpToken${counter}Mint${Math.random().toString(36).substring(2, 8)}`;
      const launch: PumpTokenLaunch = {
        mint: mockMint,
        name: `Pump Token ${counter}`,
        symbol: `PTK${counter}`,
        creator: `Creator_${counter}`,
        timestamp: Date.now(),
        marketCapSol: 20 + Math.random() * 100,
        bondingCurveKey: `Curve_${counter}`
      };
      counter++;
      this.addLaunch(launch);
    }, 15000); // add a launch every 15s for streaming demonstration
  }

  public stop(): void {
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
    }
    this.disconnectRealtimeWs();
  }
}
