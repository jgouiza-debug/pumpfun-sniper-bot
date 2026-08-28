import WebSocket from 'ws';
import { attachKeepalive, reconnectDelayMs, KeepaliveHandle } from './wsKeepalive';

/**
 * `logsSubscribe` for a set of wallet addresses over our own Helius websocket.
 *
 * WHY NOT `Connection.onLogs` (what the copy trader used until 2026-08-22):
 *
 *  - web3.js reconnects only from the socket's `close` event. A connection that
 *    dies without a FIN — dropped route, sleeping NIC, upstream proxy timeout —
 *    never fires it, so every subscription stays registered in memory, the UI
 *    keeps reporting ON-CHAIN OK, and no leader buy or sell is ever seen again.
 *    The sniper's launch feed was blinded exactly this way on 2026-08-13 (see
 *    wsKeepalive.ts); the copy trader's wallet watcher had the same hole.
 *    web3.js does send a JSON-RPC `ping` every 5s, but never checks that
 *    anything comes back.
 *
 *  - `onLogs` was subscribed at 'confirmed', the slowest moment to learn about
 *    a trade: ~0.5–2s after the leader's transaction lands, and the copy sell
 *    then starts its own build → sign → send → confirm on top of that.
 *    Subscribing at 'processed' hands the signature over as soon as a node has
 *    executed the transaction; the caller polls the transaction itself at
 *    'confirmed' (the only level `getTransaction` serves) and acts the instant
 *    it becomes readable.
 *
 * Liveness rests on the pong, not on data: a wallet that is not trading is
 * legitimately silent for hours. attachKeepalive pings every 20s; silence past
 * the threshold terminates the socket, which synthesises `close` and runs the
 * reconnect, and every address is re-subscribed on `open`.
 */

export type LogCommitment = 'processed' | 'confirmed' | 'finalized';

export interface WalletLogEvent {
  /** The tracked wallet whose subscription produced this notification. */
  address: string;
  signature: string;
  /** Non-null when the transaction failed on-chain — nothing moved. */
  err: unknown;
  slot: number;
  logs: string[];
}

/** The slice of `ws` used here — a test hands in a fake. */
export interface SocketLike {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
  ping(): void;
}

export interface WalletLogWatcherOptions {
  getWsUrl: () => string;
  onLog: (ev: WalletLogEvent) => void;
  /** Default 'processed' — see the header. */
  commitment?: LogCommitment;
  log?: (level: 'warn' | 'info', msg: string) => void;
  /** Fired on connect, disconnect and every subscription acknowledgement. */
  onStatusChange?: () => void;
  /** Injectable for tests. */
  socketFactory?: (url: string) => SocketLike;
  /** Keepalive tuning — tests shrink these. */
  pingMs?: number;
  staleMs?: number;
  /** Reconnect pacing — tests shrink this. */
  reconnectDelay?: (attempt: number) => number;
}

interface Sub {
  address: string;
  /** JSON-RPC id of the subscribe call, to correlate the acknowledgement. */
  requestId: number;
  /** Server subscription id once acknowledged. */
  subId?: number;
}

const WS_OPEN = 1;

export class WalletLogWatcher {
  private ws: SocketLike | null = null;
  private subs = new Map<string, Sub>();       // address -> sub
  private bySubId = new Map<number, string>();  // server sub id -> address
  private nextId = 1;
  private connecting = false;
  private running = false;
  private keepalive: KeepaliveHandle | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly commitment: LogCommitment;
  private readonly log: (level: 'warn' | 'info', msg: string) => void;

  constructor(private readonly opts: WalletLogWatcherOptions) {
    this.commitment = opts.commitment ?? 'processed';
    this.log = opts.log ?? (() => {});
  }

  public start(): void {
    this.running = true;
    this.connect();
  }

  public stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.keepalive?.stop();
    this.keepalive = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* already gone */ }
    }
    this.subs.clear();
    this.bySubId.clear();
    this.opts.onStatusChange?.();
  }

  /** Diff the tracked set in place: new addresses subscribe, dropped ones unsubscribe. No reconnect. */
  public setAddresses(addresses: string[]): void {
    const want = new Set(addresses);
    for (const [address, sub] of [...this.subs]) {
      if (!want.has(address)) this.unsubscribe(sub);
    }
    for (const address of want) {
      if (this.subs.has(address)) continue;
      const sub: Sub = { address, requestId: 0 };
      this.subs.set(address, sub);
      this.sendSubscribe(sub);
    }
    if (this.running && !this.ws) this.connect();
    this.opts.onStatusChange?.();
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  /** Open socket AND every tracked address acknowledged by the server. */
  public isHealthy(): boolean {
    if (!this.isConnected() || this.subs.size === 0) return false;
    for (const sub of this.subs.values()) {
      if (sub.subId === undefined) return false;
    }
    return true;
  }

  /**
   * Open socket AND THIS address's subscription acknowledged. Unlike isHealthy()
   * (which is false whenever ANY other tracked wallet is mid-acknowledgement,
   * e.g. right after add-wallet), this answers only whether the Helius lane is
   * live for the specific leader in hand — the correct question when deciding
   * whether an unsigned PumpPortal payload for that leader is the sole source.
   */
  public isAddressLive(address: string): boolean {
    if (!this.isConnected()) return false;
    const sub = this.subs.get(address);
    return Boolean(sub && sub.subId !== undefined);
  }

  public trackedCount(): number {
    return this.subs.size;
  }

  public liveSubscriptionCount(): number {
    let n = 0;
    for (const sub of this.subs.values()) if (sub.subId !== undefined) n++;
    return n;
  }

  private connect(): void {
    if (this.connecting || !this.running || this.ws) return;
    this.connecting = true;

    try {
      const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
      const ws = factory(this.opts.getWsUrl());
      this.ws = ws;

      this.keepalive = attachKeepalive(ws as unknown as WebSocket, {
        pingMs: this.opts.pingMs,
        staleMs: this.opts.staleMs,
        onStale: (silentMs) => {
          this.log('warn', `On-chain wallet watcher unresponsive for ${(silentMs / 1000).toFixed(0)}s (no data and no pong) — forcing a reconnect; ${this.subs.size} tracked wallet(s) were blind.`);
        },
      });

      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.connecting = false;
        this.reconnectAttempt = 0;
        // Re-subscribe everything: a reconnect otherwise leaves the tracked
        // wallets silently blind, which is the failure this class exists to fix.
        for (const sub of this.subs.values()) this.sendSubscribe(sub);
        this.log('info', `On-chain wallet watcher connected — subscribing ${this.subs.size} wallet(s) at '${this.commitment}'.`);
        this.opts.onStatusChange?.();
      });

      ws.on('message', (raw: unknown) => {
        if (this.ws !== ws) return;
        this.keepalive?.touch();
        this.handleMessage(raw);
      });

      ws.on('close', () => {
        if (this.ws !== ws) return; // a superseded socket closing must not touch the live one
        this.connecting = false;
        this.keepalive?.stop();
        this.keepalive = null;
        this.ws = null;
        this.bySubId.clear();
        for (const sub of this.subs.values()) sub.subId = undefined;
        this.opts.onStatusChange?.();
        if (this.running) this.scheduleReconnect();
      });

      ws.on('error', () => { /* close handler owns reconnect */ });
    } catch (err: any) {
      this.connecting = false;
      this.ws = null;
      this.log('warn', `On-chain wallet watcher could not open a socket: ${err?.message ?? err}`);
      if (this.running) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = (this.opts.reconnectDelay ?? reconnectDelayMs)(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Responses to our own calls: {id, result} acknowledges, {id, error} refuses.
    if (typeof msg.id === 'number') {
      if (msg.error) {
        this.log('warn', `Helius refused a wallet subscription: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        return;
      }
      if (typeof msg.result === 'number') {
        for (const sub of this.subs.values()) {
          if (sub.requestId === msg.id) {
            sub.subId = msg.result;
            this.bySubId.set(msg.result, sub.address);
            this.opts.onStatusChange?.();
            return;
          }
        }
      }
      return; // unsubscribe acks (result: true) and ids from a previous socket
    }

    if (msg.method !== 'logsNotification') return;
    const address = this.bySubId.get(msg.params?.subscription);
    if (!address) return;
    const value = msg.params?.result?.value;
    if (!value || typeof value.signature !== 'string') return;

    this.opts.onLog({
      address,
      signature: value.signature,
      err: value.err ?? null,
      slot: Number(msg.params?.result?.context?.slot) || 0,
      logs: Array.isArray(value.logs) ? value.logs : [],
    });
  }

  private sendSubscribe(sub: Sub): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    sub.requestId = this.nextId++;
    sub.subId = undefined;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: sub.requestId,
      method: 'logsSubscribe',
      params: [{ mentions: [sub.address] }, { commitment: this.commitment }],
    }));
  }

  private unsubscribe(sub: Sub): void {
    this.subs.delete(sub.address);
    if (sub.subId === undefined) return;
    this.bySubId.delete(sub.subId);
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id: this.nextId++, method: 'logsUnsubscribe', params: [sub.subId],
      }));
    } catch { /* socket gone; the server drops it anyway */ }
  }
}
