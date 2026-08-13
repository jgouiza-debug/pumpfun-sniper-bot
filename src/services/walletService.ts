import fs from 'fs';
import path from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export type WalletSource = 'none' | 'runtime' | 'env' | 'file';

/** Everything the UI is allowed to see. Deliberately contains no secret material. */
export interface WalletStatus {
  linked: boolean;
  address: string | null;
  /** Truncated for display, e.g. "7xKX...9fPq". Never the full key. */
  shortAddress: string | null;
  source: WalletSource;
  solBalance: number;
  usdBalance: number;
  /** Balance minus the gas float — what the bot may actually deploy. */
  deployableSol: number;
  lastCheckedAt: number;
  rpcHealthy: boolean;
  /** Populated when the wallet cannot be used for live trading, with the reason. */
  blockers: string[];
}

const WALLET_FILE = path.resolve(process.cwd(), '.photon-wallet.json');

/**
 * Holds the signing key for live execution.
 *
 * Two rules this class exists to enforce:
 *   1. The secret never leaves this module. `getStatus()` is the only thing the
 *      HTTP layer may serialize, and it carries an address, not a key.
 *   2. A key is validated and its balance confirmed *before* live mode is armed,
 *      so a typo surfaces as a clear error rather than a failed buy mid-run.
 */
export class WalletService {
  private keypair: Keypair | null = null;
  private source: WalletSource = 'none';
  private connection: Connection;

  private solBalance = 0;
  private lastCheckedAt = 0;
  private rpcHealthy = false;

  /** SOL held back so exits always have gas, even when fully deployed. */
  private gasFloatSol = 0.005;

  private balanceTtlMs = 8000;
  private inflightBalance: Promise<number> | null = null;

  /** onAccountChange subscription id, when the RPC websocket is up. */
  private accountSubId: number | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
    this.rpcHealthy = true;
    void this.checkRpcHealth();
    this.autoLoad();
    if (this.keypair) this.subscribeToBalance();
  }

  public async checkRpcHealth(): Promise<boolean> {
    try {
      await this.connection.getSlot('confirmed');
      this.rpcHealthy = true;
      return true;
    } catch {
      this.rpcHealthy = false;
      return false;
    }
  }

  public setConnection(connection: Connection): void {
    this.unsubscribeBalance();
    this.connection = connection;
    this.lastCheckedAt = 0;
    void this.checkRpcHealth();
    if (this.keypair) this.subscribeToBalance();
  }

  /**
   * Real-time balance: the RPC websocket pushes every account change (fills,
   * deposits, fees) the moment it confirms, instead of us discovering it on
   * the next 10s poll. The polled path stays as a safety net underneath.
   */
  private subscribeToBalance(): void {
    if (!this.keypair) return;
    this.unsubscribeBalance();
    try {
      this.accountSubId = this.connection.onAccountChange(
        this.keypair.publicKey,
        (accountInfo) => {
          this.solBalance = Number((accountInfo.lamports / LAMPORTS_PER_SOL).toFixed(5));
          this.lastCheckedAt = Date.now();
          this.rpcHealthy = true;
        },
        'confirmed'
      );
    } catch {
      // Websocket unavailable on this RPC — polling still covers us.
      this.accountSubId = null;
    }
  }

  private unsubscribeBalance(): void {
    if (this.accountSubId !== null) {
      const id = this.accountSubId;
      this.accountSubId = null;
      // Fire and forget; a failed remove just leaves a dead subscription behind.
      void this.connection.removeAccountChangeListener(id).catch(() => {});
    }
  }

  public setGasFloat(sol: number): void {
    this.gasFloatSol = Math.max(0, sol);
  }

  /**
   * Loads a key from the environment or a local file at startup so the operator
   * never has to paste a secret into a browser form.
   */
  private autoLoad(): void {
    const fromEnv = process.env.PHOTON_PRIVATE_KEY?.trim();
    if (fromEnv) {
      const kp = WalletService.parseSecret(fromEnv);
      if (kp) {
        this.keypair = kp;
        this.source = 'env';
        console.log(`[Wallet] Loaded from PHOTON_PRIVATE_KEY -> ${kp.publicKey.toBase58()}`);
        return;
      }
      console.warn('[Wallet] PHOTON_PRIVATE_KEY is set but could not be parsed. Ignoring it.');
    }

    try {
      if (fs.existsSync(WALLET_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        const kp = WalletService.parseSecret(String(raw.privateKey || ''));
        if (kp) {
          this.keypair = kp;
          this.source = 'file';
          console.log(`[Wallet] Loaded from .photon-wallet.json -> ${kp.publicKey.toBase58()}`);
        }
      }
    } catch (err: any) {
      console.warn(`[Wallet] Could not read .photon-wallet.json: ${err.message}`);
    }
  }

  /**
   * Accepts the three formats Photon and the common Solana wallets export:
   * base58 (most common), a JSON byte array, or raw hex.
   */
  public static parseSecret(secret: string): Keypair | null {
    try {
      let trimmed = secret.trim();
      if (!trimmed) return null;

      // Strip surrounding double/single quotes if copied with quotes
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        trimmed = trimmed.slice(1, -1).trim();
      }

      // JSON Array or bracketed numbers: e.g. [123, 45, 67...]
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const arr = JSON.parse(trimmed);
          if (Array.isArray(arr)) {
            const bytes = Uint8Array.from(arr);
            if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
            if (bytes.length === 32) return Keypair.fromSeed(bytes);
          }
        } catch { /* proceed */ }
      }

      // Comma-separated numbers without brackets: e.g. 123, 45, 67...
      if (/^\d+(\s*,\s*\d+){31,63}$/.test(trimmed)) {
        try {
          const arr = trimmed.split(',').map(n => parseInt(n.trim(), 10));
          const bytes = Uint8Array.from(arr);
          if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
          if (bytes.length === 32) return Keypair.fromSeed(bytes);
        } catch { /* proceed */ }
      }

      // 128-char hex string (64 bytes) or 64-char hex string (32 bytes seed)
      if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
        return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, 'hex')));
      }
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Keypair.fromSeed(Uint8Array.from(Buffer.from(trimmed, 'hex')));
      }

      // Base58 FIRST — it is what Phantom / Solflare / Photon actually export,
      // and the base64 branch below cannot be trusted to decline a base58 key.
      // The base58 alphabet is a subset of the base64 one, so an 86-character
      // base58 key matches the base64 regex and Buffer.from(x,'base64') decodes
      // it to exactly 64 bytes of garbage. That produced a VALID-LOOKING keypair
      // for a wallet the user does not own: the bot would link, show a 0 balance
      // for an address they never heard of, and sign with it. Trying base58
      // first makes the correct interpretation win whenever it is possible.
      try {
        const decoded = bs58.decode(trimmed);
        if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
        if (decoded.length === 32) return Keypair.fromSeed(decoded);
      } catch { /* not base58 — fall through to base64 */ }

      // Base64 string
      if (/^[A-Za-z0-9+/=]{44,88}$/.test(trimmed)) {
        try {
          const decodedB64 = Buffer.from(trimmed, 'base64');
          if (decodedB64.length === 64) return Keypair.fromSecretKey(Uint8Array.from(decodedB64));
          if (decodedB64.length === 32) return Keypair.fromSeed(Uint8Array.from(decodedB64));
        } catch { /* proceed */ }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Links a wallet and immediately proves it works by reading its on-chain
   * balance. Returns the sanitized status, never the key.
   */
  public async link(secret: string, persist = false): Promise<{ ok: boolean; error?: string; status: WalletStatus }> {
    const kp = WalletService.parseSecret(secret);
    if (!kp) {
      return {
        ok: false,
        error: 'Could not parse that key. Photon exports a base58 string; a JSON byte array or 128-char hex also work.',
        status: this.getStatus(0),
      };
    }

    this.keypair = kp;
    this.source = 'runtime';
    this.lastCheckedAt = 0;
    this.subscribeToBalance();

    const balance = await this.refreshBalance(true);

    if (!this.rpcHealthy) {
      return {
        ok: false,
        error: 'Key parsed, but the RPC could not be reached to confirm the balance. Check the Helius key and try again.',
        status: this.getStatus(0),
      };
    }

    if (persist) {
      try {
        fs.writeFileSync(
          WALLET_FILE,
          JSON.stringify({ privateKey: secret.trim(), address: kp.publicKey.toBase58() }, null, 2),
          { mode: 0o600 }
        );
        this.source = 'file';
        console.log('[Wallet] Persisted to .photon-wallet.json (add it to .gitignore).');
      } catch (err: any) {
        console.warn(`[Wallet] Could not persist wallet: ${err.message}`);
      }
    }

    console.log(`[Wallet] Linked ${kp.publicKey.toBase58()} | ${balance} SOL`);
    return { ok: true, status: this.getStatus(0) };
  }

  public unlink(deleteFile = false): void {
    this.unsubscribeBalance();
    this.keypair = null;
    this.source = 'none';
    this.solBalance = 0;
    this.lastCheckedAt = 0;
    void this.checkRpcHealth();

    if (deleteFile) {
      try {
        if (fs.existsSync(WALLET_FILE)) fs.unlinkSync(WALLET_FILE);
      } catch { /* best effort */ }
    }
    console.log('[Wallet] Unlinked.');
  }

  public isLinked(): boolean {
    return this.keypair !== null;
  }

  /** Signing access, for the execution path only. Never serialize the result. */
  public getKeypair(): Keypair | null {
    return this.keypair;
  }

  public getAddress(): string | null {
    return this.keypair ? this.keypair.publicKey.toBase58() : null;
  }

  public getSolBalance(): number {
    return this.solBalance;
  }

  public getDeployableSol(): number {
    return Number(Math.max(0, this.solBalance - this.gasFloatSol).toFixed(4));
  }

  /**
   * Reads the on-chain balance, collapsing concurrent callers into one RPC hit
   * and serving a cached value inside the TTL.
   */
  public async refreshBalance(force = false): Promise<number> {
    if (!this.keypair) {
      void this.checkRpcHealth();
      return 0;
    }

    if (!force && Date.now() - this.lastCheckedAt < this.balanceTtlMs) {
      return this.solBalance;
    }

    if (this.inflightBalance) return this.inflightBalance;

    const pubkey: PublicKey = this.keypair.publicKey;
    this.inflightBalance = (async () => {
      try {
        const lamports = await this.connection.getBalance(pubkey, 'confirmed');
        this.solBalance = Number((lamports / LAMPORTS_PER_SOL).toFixed(5));
        this.rpcHealthy = true;
        this.lastCheckedAt = Date.now();
      } catch (err: any) {
        // Keep the last known balance; mark the RPC unhealthy so the UI can say so.
        this.rpcHealthy = false;
      } finally {
        this.inflightBalance = null;
      }
      return this.solBalance;
    })();

    return this.inflightBalance;
  }

  /**
   * Everything that would stop this wallet from trading for real, as plain
   * sentences. Surfaced in the UI before live mode can be armed.
   *
   * Only physical impossibilities live here: no key, no RPC, nothing above the
   * gas float to deploy. There is deliberately NO minimum-size blocker — owner
   * decision 2026-08-12: whatever the wallet holds is tradeable, no matter the
   * amount. Size economics surface as warnings, never as refusals.
   */
  public getBlockers(): string[] {
    const blockers: string[] = [];
    if (!this.keypair) {
      blockers.push('No wallet linked.');
      return blockers;
    }
    if (!this.rpcHealthy) blockers.push('RPC unreachable — cannot confirm balance.');
    if (this.solBalance <= 0) blockers.push('Wallet holds 0 SOL.');
    else if (this.solBalance <= this.gasFloatSol) {
      blockers.push(`Balance ${this.solBalance} SOL is at or below the ${this.gasFloatSol} SOL gas float — nothing deployable.`);
    }
    return blockers;
  }

  public getStatus(solPriceUsd: number): WalletStatus {
    const address = this.getAddress();
    return {
      linked: this.keypair !== null,
      address,
      shortAddress: address ? `${address.slice(0, 4)}...${address.slice(-4)}` : null,
      source: this.source,
      solBalance: this.solBalance,
      usdBalance: Number((this.solBalance * solPriceUsd).toFixed(2)),
      deployableSol: this.getDeployableSol(),
      lastCheckedAt: this.lastCheckedAt,
      rpcHealthy: this.rpcHealthy,
      blockers: this.getBlockers(),
    };
  }
}
