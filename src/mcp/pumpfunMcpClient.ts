import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PumpfunMcpServer } from "./pumpfunMcpServer";
import { PumpTokenLaunch } from "../types";

export class PumpfunMcpClient {
  private client: Client;
  private server: PumpfunMcpServer;

  constructor(server: PumpfunMcpServer) {
    this.server = server;
    this.client = new Client(
      {
        name: "pumpfun-mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
  }

  public async connect(): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    
    await Promise.all([
      this.client.connect(clientTransport),
      this.server.getServer().connect(serverTransport),
    ]);

    console.log("[PumpfunMcpClient] Connected to MCP server via InMemoryTransport.");
  }

  public async getLatestLaunches(limit: number = 10): Promise<PumpTokenLaunch[]> {
    const result = await this.client.callTool({
      name: "get_latest_pump_launches",
      arguments: { limit },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    if (content && content.length > 0 && content[0].text) {
      return JSON.parse(content[0].text) as PumpTokenLaunch[];
    }
    return [];
  }

  public async subscribeLaunches(enableStream: boolean = true): Promise<any> {
    const result = await this.client.callTool({
      name: "subscribe_pump_launches",
      arguments: { enableStream },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    if (content && content.length > 0 && content[0].text) {
      return JSON.parse(content[0].text);
    }
    return null;
  }

  public onLiveLaunch(callback: (launch: PumpTokenLaunch) => void): () => void {
    return this.server.onLaunch(callback);
  }
}
