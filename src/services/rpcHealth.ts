/**
 * Retry and health accounting for Solana RPC calls.
 *
 * WHY (measured 2026-08-13, 17,538 candidates): 70.9% of every candidate the
 * bot saw was rejected with "Sell-path safety unverifiable (mintAccount)".
 * That reason is produced by a SINGLE `getAccountInfo` attempt in
 * honeypotDetector — one shot, no retry, and any failure at all is recorded as
 * unverified. Because the gate treats unverified as unsafe, one dropped HTTP
 * request is indistinguishable from a genuine honeypot, and the trade is gone.
 *
 * Two distinct things were being conflated, and they need opposite handling:
 *
 *   TRANSIENT — a 429 from a shared key, a socket reset, a timeout, or a mint
 *   account that simply has not propagated to `confirmed` yet on a token that
 *   is 400ms old. Retrying fixes these, and the window is small enough that a
 *   few hundred milliseconds of backoff still lands in the first candle.
 *
 *   TERMINAL — the credential itself is rejected (401/403/"invalid api key").
 *   Retrying is pure latency: every attempt fails identically. Worse, it hides
 *   the real problem behind a generic "unverified" and the operator sees a
 *   quiet bot rather than a dead key. These fail fast and latch a flag the UI
 *   can show.
 *
 * The counters exist because "RPC is barely working" was a feeling with no
 * number attached. Now it has one.
 */

export interface RpcHealthSnapshot {
  ok: number;
  failed: number;
  consecutiveFailures: number;
  /** Latched once the provider rejects the credential itself. */
  credentialRejected: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Rolling success rate over all calls this process has made, 0..1. */
  successRate: number;
}

const state = {
  ok: 0,
  failed: 0,
  consecutiveFailures: 0,
  credentialRejected: false,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
};

/**
 * A rejected credential, as opposed to a busy or unreachable one.
 *
 * Helius answers a bad key with 401. Some proxies answer 403. The string forms
 * are checked too because web3.js wraps fetch failures in a generic Error whose
 * only surviving detail is the message.
 */
export function isCredentialError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api key is not valid|missing api key/.test(msg);
}

/** Rate limiting is transient but deserves a longer wait than a socket blip. */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return /\b429\b|too many requests|rate limit/.test(msg);
}

export interface RpcRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. */
  baseDelayMs?: number;
  /** Upper bound on any single delay — the hot path cannot afford long waits. */
  maxDelayMs?: number;
  /**
   * Treat a null/undefined result as retryable. Needed for a brand-new mint:
   * `getAccountInfo` legitimately returns null for a few hundred ms after the
   * create event, and that null is the difference between screening the token
   * and skipping it.
   */
  retryOnEmpty?: boolean;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs an RPC call with bounded retry, recording health either way.
 * Throws the last error if every attempt fails.
 */
export async function withRpcRetry<T>(fn: () => Promise<T>, opts: RpcRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 120;
  const maxDelayMs = opts.maxDelayMs ?? 1_000;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const value = await fn();

      if (opts.retryOnEmpty && (value === null || value === undefined) && attempt < attempts - 1) {
        const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        opts.onRetry?.(attempt + 1, delay, 'empty result (account not visible yet)');
        await sleep(delay);
        continue;
      }

      state.ok++;
      state.consecutiveFailures = 0;
      return value;
    } catch (err) {
      lastErr = err;

      // A rejected key fails identically on every retry. Fail fast and latch it
      // so the operator is told the credential is dead, not that the token was
      // unverifiable.
      if (isCredentialError(err)) {
        state.credentialRejected = true;
        break;
      }

      if (attempt < attempts - 1) {
        const rateLimited = isRateLimitError(err);
        const delay = Math.min(
          maxDelayMs,
          (rateLimited ? baseDelayMs * 3 : baseDelayMs) * Math.pow(2, attempt)
        );
        opts.onRetry?.(attempt + 1, delay, rateLimited ? 'rate limited' : String((err as Error)?.message ?? err));
        await sleep(delay);
      }
    }
  }

  state.failed++;
  state.consecutiveFailures++;
  state.lastError = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
  state.lastErrorAt = Date.now();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'RPC call failed'));
}

export function rpcHealth(): RpcHealthSnapshot {
  const total = state.ok + state.failed;
  return {
    ok: state.ok,
    failed: state.failed,
    consecutiveFailures: state.consecutiveFailures,
    credentialRejected: state.credentialRejected,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    successRate: total === 0 ? 1 : state.ok / total,
  };
}

/**
 * Which endpoint to talk to, in precedence order.
 *
 * Before this, a missing or dead Helius key produced
 * `https://mainnet.helius-rpc.com/?api-key=` — a URL that fails every single
 * call, so the bot could not price a position, verify a mint, or submit a
 * trade. Total loss of function from one absent string.
 *
 * The public endpoint is a genuinely poor substitute — aggressively rate
 * limited, and not something to snipe on — but "slow and rate limited" still
 * lets the bot value open positions and get out of them. That is the difference
 * between degraded and dead, and open positions are real money.
 *
 *   SOLANA_RPC_URL           explicit override, wins over everything
 *   <helius key>             the normal path
 *   SOLANA_RPC_FALLBACK_URL  operator-supplied backup
 *   public mainnet           last resort, loudly warned about
 */
export function rpcEndpoint(heliusKey: string | undefined | null): string {
  const explicit = (process.env.SOLANA_RPC_URL || '').trim();
  if (explicit) return explicit;

  const key = (heliusKey || '').trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;

  return (process.env.SOLANA_RPC_FALLBACK_URL || '').trim() || 'https://api.mainnet-beta.solana.com';
}

/** WebSocket peer of {@link rpcEndpoint}, for accountSubscribe. */
export function rpcWsEndpoint(heliusKey: string | undefined | null): string {
  const explicit = (process.env.SOLANA_RPC_WS_URL || '').trim();
  if (explicit) return explicit;

  const key = (heliusKey || '').trim();
  if (key) return `wss://mainnet.helius-rpc.com/?api-key=${key}`;

  const fallback = (process.env.SOLANA_RPC_FALLBACK_URL || '').trim();
  if (fallback) return fallback.replace(/^http/, 'ws');
  return 'wss://api.mainnet-beta.solana.com';
}

/** True when we are running without a real credential — worth saying out loud. */
export function isFallbackEndpoint(heliusKey: string | undefined | null): boolean {
  return !(process.env.SOLANA_RPC_URL || '').trim() && !(heliusKey || '').trim();
}

/**
 * Connection options. `new Connection(url, 'confirmed')` left every timeout at
 * its default and, more importantly, left `disableRetryOnRateLimit` unset —
 * stated explicitly here so a future edit has to mean it.
 */
export function connectionConfig() {
  return {
    commitment: 'confirmed' as const,
    // Sniping means submitting into congestion; the default gives up early.
    confirmTransactionInitialTimeout: 60_000,
    // web3.js honours Retry-After on 429s. On a shared key this is the
    // difference between backing off and being banned.
    disableRetryOnRateLimit: false,
  };
}

/** Cleared when a new key is applied, so a fixed credential clears the latch. */
export function resetRpcHealth(): void {
  state.ok = 0;
  state.failed = 0;
  state.consecutiveFailures = 0;
  state.credentialRejected = false;
  state.lastError = null;
  state.lastErrorAt = null;
}
