import fs from 'fs';
import path from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { withRpcRetry } from './rpcHealth';
import { installPath } from './installPaths';
import { encryptSecret, decryptSecret, secureStorageAvailable } from './secureStore';

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

// Next to the exe when packaged, per installPaths — NOT process.cwd(). A
// Task Scheduler / shortcut launch has cwd = C:\Windows\System32, and writing
// the plaintext signing key there both leaks it outside the install and makes
// the wallet silently unloadable on the next normal launch.
const WALLET_FILE = installPath('.photon-wallet.json');
// The location earlier builds used. Read once at startup so an operator who
// already linked a wallet does not lose it when the path is corrected.
const LEGACY_WALLET_FILE = path.resolve(process.cwd(), '.photon-wallet.json');

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

  /**
   * Hysteresis on `rpcHealthy`. One failure is not an outage.
   *
   * This flag is not cosmetic: `getBlockers()` turns it into
   * "RPC unreachable — cannot confirm balance", and `toggleBot` refuses to arm
   * REAL mode while any blocker stands. Flipping it on a single 429 from a
   * shared Helius key meant a momentary blip could refuse to start the bot on a
   * wallet and a credential that were both entirely fine.
   */
  private consecutiveRpcFailures = 0;
  /** Whether the LAST probe proved the RPC, regardless of the latched flag. */
  private lastProbeOk = false;

  private static readonly FAILURES_BEFORE_DOWN = 2;

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

  /** A proven read. Clears the latch immediately — recovery needs no hysteresis. */
  private markRpcOk(): void {
    this.consecutiveRpcFailures = 0;
    this.lastProbeOk = true;
    this.rpcHealthy = true;
  }

  /** A failed read. Only goes DOWN once failures repeat — see FAILURES_BEFORE_DOWN. */
  private markRpcFailure(): void {
    this.consecutiveRpcFailures++;
    this.lastProbeOk = false;
    if (this.consecutiveRpcFailures >= WalletService.FAILURES_BEFORE_DOWN) {
      this.rpcHealthy = false;
    }
  }

  /**
   * A single unretried getSlot used to latch `rpcHealthy` false on one cold
   * connection or momentary blip, with nothing to un-latch it until a wallet
   * got linked (refreshBalance is the only other writer). A fixed Helius key
   * would lose that one race and the badge stayed on DOWN forever. Retrying
   * here, plus the unconditional recheck in sniperEngine's 2s wallet-sync tick,
   * means a real outage still reads as down but a blip self-heals.
   *
   * `countHealth: false` keeps this heartbeat out of the rolling success rate.
   * It fires every 2s while no wallet is linked — i.e. exactly when nothing is
   * being screened — so counting it would replace a measure of RPC quality on
   * the trading path with a measure of the heartbeat itself.
   */
  public async checkRpcHealth(): Promise<boolean> {
    try {
      await withRpcRetry(() => this.connection.getSlot('confirmed'), {
        attempts: 2,
        baseDelayMs: 150,
        maxDelayMs: 400,
        countHealth: false,
      });
      this.markRpcOk();
      return true;
    } catch {
      this.markRpcFailure();
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
          this.markRpcOk();
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

    // One-time migration: an earlier build wrote the wallet at process.cwd().
    // If the install-dir file is absent but a legacy one exists, move it so the
    // operator's linked wallet survives the path correction.
    try {
      if (WALLET_FILE !== LEGACY_WALLET_FILE && !fs.existsSync(WALLET_FILE) && fs.existsSync(LEGACY_WALLET_FILE)) {
        fs.renameSync(LEGACY_WALLET_FILE, WALLET_FILE);
        console.log('[Wallet] Migrated .photon-wallet.json from the working directory to the install directory.');
      }
    } catch { /* fall through to the load; a failed migration is not fatal */ }

    try {
      if (fs.existsSync(WALLET_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        // decryptSecret returns plaintext for legacy files and decrypts
        // OS-keychain-encrypted ones.
        const kp = WalletService.parseSecret(decryptSecret(String(raw.privateKey || '')));
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

    // Snapshot what to go back to. A link that reports failure MUST leave the
    // service exactly as it found it: the previous version assigned the keypair
    // first and the RPC-failure path returned ok:false without ever undoing it,
    // so the UI said "link failed" while the engine was armed with that wallet
    // and would sign with it. With `persist` set, nothing was written either —
    // so it looked linked for the session and vanished on the next restart.
    const prevKeypair = this.keypair;
    const prevSource = this.source;
    const prevCheckedAt = this.lastCheckedAt;

    this.keypair = kp;
    this.source = 'runtime';
    this.lastCheckedAt = 0;
    this.subscribeToBalance();

    const balance = await this.refreshBalance(true);

    // `lastProbeOk`, not `rpcHealthy`: linking demands a PROVEN read. The
    // latched flag now tolerates one failure by design, and inheriting that
    // tolerance here would report a successful link on a balance never read.
    if (!this.lastProbeOk) {
      this.keypair = prevKeypair;
      this.source = prevSource;
      this.lastCheckedAt = prevCheckedAt;
      this.unsubscribeBalance();
      if (this.keypair) this.subscribeToBalance();
      return {
        ok: false,
        error: 'Key parsed, but the RPC could not be reached to confirm the balance. The wallet was NOT linked. Check the Helius key and try again.',
        status: this.getStatus(0),
      };
    }

    if (persist) {
      try {
        fs.writeFileSync(
          WALLET_FILE,
          // Encrypt the signing key at rest when the OS keychain is available
          // (Electron); plaintext passthrough otherwise, as before.
          JSON.stringify({ privateKey: encryptSecret(secret.trim()), address: kp.publicKey.toBase58() }, null, 2),
          { mode: 0o600 }
        );
        this.source = 'file';
        console.log(`[Wallet] Persisted to .photon-wallet.json${secureStorageAvailable() ? ' (OS-keychain encrypted)' : ' (plaintext — add it to .gitignore)'}.`);
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

    if (this.inflightBalance) {
      if (!force) return this.inflightBalance;
      // A FORCED read must observe the chain no earlier than now. The read in
      // flight may have started before the state change the caller needs to
      // see (a draining buy just confirmed) — handing back its result lets a
      // sell fee clamp trust a pre-buy balance. Chain a fresh read behind it.
      return this.inflightBalance.then(() => this.refreshBalance(true));
    }

    const pubkey: PublicKey = this.keypair.publicKey;
    this.inflightBalance = (async () => {
      try {
        // This was the one RPC call in this file with no retry, while every
        // other read went through withRpcRetry. A single 429 from a shared key
        // therefore reached `getBlockers()` and could refuse to arm REAL mode.
        const lamports = await withRpcRetry(() => this.connection.getBalance(pubkey, 'confirmed'), {
          attempts: 2,
          baseDelayMs: 150,
          maxDelayMs: 400,
          countHealth: false,
        });
        this.solBalance = Number((lamports / LAMPORTS_PER_SOL).toFixed(5));
        this.markRpcOk();
        this.lastCheckedAt = Date.now();
      } catch {
        // Keep the last known balance; mark the RPC unhealthy so the UI can say so.
        this.markRpcFailure();
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

  /**
   * Queries actual on-chain SPL token balances for specified mints in a single
   * batched RPC call. Returns a map from mint to UI token balance, or null on RPC error.
   */
  public async getOnChainTokenBalances(mints: string[]): Promise<Map<string, number> | null> {
    if (!this.keypair || !mints.length) return new Map();

    const mintSet = new Set(mints);
    const balances = new Map<string, number>();
    for (const m of mints) balances.set(m, 0);

    try {
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const res = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID },
        'confirmed'
      );

      for (const item of res.value) {
        const info = item.account.data?.parsed?.info;
        if (!info) continue;
        const mint = info.mint;
        if (mintSet.has(mint)) {
          const uiAmount = info.tokenAmount?.uiAmount ?? 0;
          balances.set(mint, (balances.get(mint) || 0) + uiAmount);
        }
      }

      // Check Token-2022 program as well
      try {
        const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
        const res2022 = await this.connection.getParsedTokenAccountsByOwner(
          this.keypair.publicKey,
          { programId: TOKEN_2022_PROGRAM_ID },
          'confirmed'
        );
        for (const item of res2022.value) {
          const info = item.account.data?.parsed?.info;
          if (!info) continue;
          const mint = info.mint;
          if (mintSet.has(mint)) {
            const uiAmount = info.tokenAmount?.uiAmount ?? 0;
            balances.set(mint, (balances.get(mint) || 0) + uiAmount);
          }
        }
      } catch {
        // Token-2022 optional
      }

      return balances;
    } catch (err) {
      // RPC hit failed: return null so callers don't falsely treat a network error as 0 tokens
      return null;
    }
  }
}

