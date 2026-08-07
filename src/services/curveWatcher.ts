import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';

/**
 * Bonding-curve progress tracker over the Helius WebSocket. Flag: playbookRouting.
 *
 * WHY THIS REPLACED THE PUMPPORTAL TRADE STREAM (measured 2026-08-05):
 * `subscribeTokenTrade` returns
 *   "only available when connecting with an API key funded with at least 0.02 SOL"
 * and delivers ZERO events on the free tier — verified across 18 tokens over 6
 * minutes. Play 2 (mid-curve entry) and the dev-sell structural stop both
 * depended on it, so both were silently dead code.
 *
 * The curve state we actually need is a public on-chain account. Subscribing to
 * the bonding-curve PDA via Helius `accountSubscribe` gives the same virtual
 * reserves in real time, on infrastructure already in use, at no extra cost.
 *
 * TRADE-OFF, STATED PLAINLY: account updates reveal curve POSITION but not who
 * traded. Unique-buyer counts — the wash-trade-resistant demand signal — are not
 * derivable from this feed. Callers must fall back to progress VELOCITY, which
 * cannot distinguish one whale from twenty buyers. Restoring true buyer counts
 * requires the funded PumpPortal key.
 */

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface CurveUpdate {
  mint: string;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  realSolInCurve: number;
  progressPct: number;
  complete: boolean;
  creator: string | null;
  at: number;
}

interface Entry {
  mint: string;
  curvePda: string;
  subId?: number;
  /** JSON-RPC id used for the subscribe call, to correlate the ack. */
  requestId: number;
  last?: CurveUpdate;
}

export function bondingCurvePda(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM
  )[0];
}

/** Decodes the pump.fun BondingCurve account. Returns null on an unexpected layout. */
export function decodeCurveAccount(data: Buffer): Omit<CurveUpdate, 'mint' | 'at'> | null {
  if (!data || data.length < 49) return null;
  try {
    const vTokensRaw = data.readBigUInt64LE(8);
    const vSolLamports = data.readBigUInt64LE(16);
    const complete = data.readUInt8(48) === 1;
    const creator = data.length >= 81 ? new PublicKey(data.subarray(49, 81)).toBase58() : null;

    const vSol = Number(vSolLamports) / 1e9;
    const vTokens = Number(vTokensRaw) / 1e6;
    const realSol = Math.max(0, vSol - 30);
    return {
      vSolInBondingCurve: vSol,
      vTokensInBondingCurve: vTokens,
      realSolInCurve: realSol,
      progressPct: Math.min(100, (realSol / 85) * 100),
      complete,
      creator,
    };
  } catch {
    return null;
  }
}

export class CurveWatcher {
  private ws: WebSocket | null = null;
  private entries = new Map<string, Entry>();   // mint -> entry
  private bySubId = new Map<number, string>();  // subscription id -> mint
  private nextId = 1;
  private connecting = false;
  private closed = false;

  constructor(
    private getWsUrl: () => string,
    private onUpdate: (u: CurveUpdate) => void,
    /** Cap concurrent subscriptions; each costs Helius credits on every update. */
    private maxWatched = 40
  ) {}

  public size(): number {
    return this.entries.size;
  }

  public isWatching(mint: string): boolean {
    return this.entries.has(mint);
  }

  public start(): void {
    this.closed = false;
    this.connect();
  }

  public stop(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
    this.entries.clear();
    this.bySubId.clear();
  }

  private connect(): void {
    if (this.connecting || this.closed || this.ws) return;
    this.connecting = true;

    try {
      const ws = new WebSocket(this.getWsUrl());
      this.ws = ws;

      ws.on('open', () => {
        this.connecting = false;
        // Re-subscribe everything: a reconnect otherwise leaves the watchlist
        // silently blind, which is exactly the failure this class exists to fix.
        for (const entry of this.entries.values()) this.sendSubscribe(entry);
      });

      ws.on('message', (raw: WebSocket.Data) => this.handleMessage(raw));

      ws.on('close', () => {
        this.connecting = false;
        this.ws = null;
        this.bySubId.clear();
        for (const e of this.entries.values()) e.subId = undefined;
        if (!this.closed) setTimeout(() => this.connect(), 3000);
      });

      ws.on('error', () => { /* close handler owns reconnect */ });
    } catch {
      this.connecting = false;
      if (!this.closed) setTimeout(() => this.connect(), 5000);
    }
  }

  private handleMessage(raw: WebSocket.Data): void {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Subscription acknowledgement: {id, result: <subId>}
    if (typeof msg.id === 'number' && typeof msg.result === 'number') {
      for (const entry of this.entries.values()) {
        if (entry.requestId === msg.id) {
          entry.subId = msg.result;
          this.bySubId.set(msg.result, entry.mint);
          return;
        }
      }
      return;
    }

    if (msg.method !== 'accountNotification') return;
    const subId = msg.params?.subscription;
    const mint = this.bySubId.get(subId);
    if (!mint) return;

    const dataField = msg.params?.result?.value?.data;
    const b64 = Array.isArray(dataField) ? dataField[0] : null;
    if (!b64) return;

    const decoded = decodeCurveAccount(Buffer.from(b64, 'base64'));
    if (!decoded) return;

    const update: CurveUpdate = { mint, at: Date.now(), ...decoded };
    const entry = this.entries.get(mint);
    if (entry) entry.last = update;
    this.onUpdate(update);
  }

  private sendSubscribe(entry: Entry): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    entry.requestId = this.nextId++;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: entry.requestId,
      method: 'accountSubscribe',
      params: [entry.curvePda, { encoding: 'base64', commitment: 'confirmed' }],
    }));
  }

  /** @returns false when the mint was already watched or the cap is reached. */
  public watch(mint: string): boolean {
    if (this.entries.has(mint)) return false;
    if (this.entries.size >= this.maxWatched) return false;

    let curvePda: string;
    try { curvePda = bondingCurvePda(mint).toBase58(); } catch { return false; }

    const entry: Entry = { mint, curvePda, requestId: 0 };
    this.entries.set(mint, entry);
    this.sendSubscribe(entry);
    if (!this.ws) this.connect();
    return true;
  }

  public unwatch(mint: string): void {
    const entry = this.entries.get(mint);
    if (!entry) return;
    this.entries.delete(mint);
    if (entry.subId !== undefined) {
      this.bySubId.delete(entry.subId);
      try {
        this.ws?.send(JSON.stringify({
          jsonrpc: '2.0', id: this.nextId++, method: 'accountUnsubscribe', params: [entry.subId],
        }));
      } catch { /* connection gone; server drops it anyway */ }
    }
  }

  public getLast(mint: string): CurveUpdate | undefined {
    return this.entries.get(mint)?.last;
  }

  /** Oldest-first eviction so a full watchlist still admits fresh candidates. */
  public evictOldest(): string | null {
    const first = this.entries.keys().next();
    if (first.done) return null;
    this.unwatch(first.value);
    return first.value;
  }
}
