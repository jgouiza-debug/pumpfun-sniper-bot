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
  /**
   * Whether this call belongs in the rolling success-rate figure. Default true.
   *
   * Set false for background pollers. The counters exist to explain why
   * CANDIDATES were rejected (see the header): a health heartbeat firing every
   * two seconds, or an 8-second balance poll, would outnumber the screening
   * calls many times over and turn `successRate` into a measure of the
   * heartbeat rather than of the RPC's quality where it costs money.
   *
   * A rejected credential still latches — that is real signal no matter which
   * call happened to notice it.
   */
  countHealth?: boolean;
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
  const countHealth = opts.countHealth !== false;

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

      if (countHealth) {
        state.ok++;
        state.consecutiveFailures = 0;
      }
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

  if (countHealth) {
    state.failed++;
    state.consecutiveFailures++;
    state.lastError = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    state.lastErrorAt = Date.now();
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'RPC call failed'));
}

/**
 * Record the outcome of an RPC call made OUTSIDE withRpcRetry.
 *
 * The health counters drive the failover/degraded reporting, and until now
 * only two call sites fed them: the honeypot mint read and the wallet-balance
 * probe. Every RPC call on the TRADING path — confirmation polling, fill
 * inspection, the copy trader's parsed-transaction fetches — bypassed them
 * entirely. So the health signal was measuring a corner of the system while a
 * 429 storm on the hot path went unrecorded: the operator saw a healthy RPC
 * pill during exactly the outage that was turning every trade into a timeout.
 *
 * A credential error latches the rejected-key flag here too, so a key that
 * dies mid-session demotes every consumer instead of only the prober.
 */
export function noteRpcOutcome(ok: boolean, err?: unknown): void {
  if (ok) {
    state.ok++;
    state.consecutiveFailures = 0;
    return;
  }
  if (isCredentialError(err)) state.credentialRejected = true;
  state.failed++;
  state.consecutiveFailures++;
  state.lastError = err instanceof Error ? err.message : String(err ?? 'unknown');
  state.lastErrorAt = Date.now();
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
 * Normalizes whatever the operator pasted into the "Helius RPC Key" field.
 *
 * WHY: `rpcEndpoint` used to interpolate the string unconditionally, and
 * NOTHING validated it — not the UI field, not `updateConfig`, not `storeKey`.
 * Paste the full Helius RPC URL instead of the bare key (the dashboard shows
 * both, and the URL is the one people copy) and you built
 * `...?api-key=https://mainnet.helius-rpc.com/?api-key=xxx`, which fails every
 * call forever.
 *
 * That was far worse than a transient failure, because the broken value was
 * then written to `.api-keys.json`, and a stored key outranks `.env`. The bad
 * credential survived every restart while `heliusApiKeySet` reported true — the
 * operator had done everything right and the bot said RPC DOWN indefinitely
 * with no way to see why.
 *
 * The rule: repair what is unambiguously repairable, REFUSE what provably
 * cannot work, and pass through anything else with a warning. Helius keys are
 * UUIDs today, but that is their choice to change, so a non-UUID token is
 * warned about and still accepted — only characters that cannot survive being
 * placed in a query string are rejected outright.
 */
export interface NormalizedRpcKey {
  /** The bare API key. Empty when the input could not be used. */
  key: string;
  ok: boolean;
  /** Populated whenever the input was not already a clean bare key. */
  note?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeHeliusKey(raw: string | undefined | null): NormalizedRpcKey {
  let value = (raw || '').trim();
  if (!value) return { key: '', ok: false, note: 'No key supplied.' };

  // Copied out of a JSON file or a quoted .env line.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  // A pasted endpoint URL. The key is in the query string — take it rather than
  // nesting one URL inside another.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const embedded = (parsed.searchParams.get('api-key') || parsed.searchParams.get('api_key') || '').trim();
      if (embedded) {
        return {
          key: embedded,
          ok: true,
          note: `Read the api-key out of the ${parsed.host} URL you pasted — store just the key next time.`,
        };
      }
      return {
        key: '',
        ok: false,
        note: `That is an endpoint URL with no api-key in it. This field wants the bare Helius key; to point the bot at a custom node, set SOLANA_RPC_URL=${value} in the .env beside the app instead.`,
      };
    } catch {
      return { key: '', ok: false, note: 'That looks like a URL but could not be parsed.' };
    }
  }

  // Anything that cannot survive being placed in a query string is not a key,
  // and silently encoding it would recreate the same invisible breakage.
  if (/[\s/?#&=]/.test(value)) {
    return { key: '', ok: false, note: 'A Helius API key contains no spaces, slashes or URL punctuation — this does not look like one.' };
  }

  if (!UUID_RE.test(value)) {
    return {
      key: value,
      ok: true,
      note: 'That is not the UUID shape Helius issues. Accepting it, but if RPC stays down this is the first thing to re-check.',
    };
  }

  return { key: value, ok: true };
}

export type RpcEndpointSource = 'env-override' | 'helius' | 'fallback-env' | 'public';

export interface ResolvedRpcEndpoint {
  url: string;
  source: RpcEndpointSource;
  /** Host only. Safe to log and to show in the UI — never the query string. */
  host: string;
  /**
   * True when a Helius key IS configured but something else won anyway. This is
   * the state that produced "valid credentials, RPC still down": the operator
   * sees `heliusApiKeySet: true` and has no way to learn the key is unused.
   */
  keyOverridden: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'custom endpoint';
  }
}

/**
 * Which endpoint to talk to, in precedence order, and WHY that one won.
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
 *
 * The `source` half is new and is the actual fix for the reported bug. A stale
 * `SOLANA_RPC_URL` in the .env beside the exe silently outranked a freshly
 * typed, perfectly good Helius key, and NOTHING anywhere — status payload, UI,
 * startup log — reported which endpoint was really in use. Callers now surface
 * this so the answer is visible instead of deducible.
 */
/**
 * The exact key value a live probe saw rejected. Latched by key STRING, not a
 * bare boolean, so applying a different key un-latches on its own and a
 * transient 401 in some unrelated hot path can never demote a good credential.
 *
 * WHY this exists: shape validation cannot know a key is revoked, expired or
 * over quota. On 2026-08-28 an 89-character value sat in `heliusApiKey` — not
 * a UUID, but free of the punctuation normalizeHeliusKey rejects, so it was
 * accepted with a note. Every socket then answered 401 and web3.js retried
 * forever: 8,000 `ws error: Unexpected server response: 401` lines, no leader
 * feed, no launch stream, and not one line anywhere saying the key was the
 * problem. A key the server refuses must be treated as no key at all.
 */
let rejectedHeliusKey: string | null = null;

/** Record that the server refused this exact key. Endpoint resolution then skips it. */
export function markHeliusKeyRejected(key: string): void {
  rejectedHeliusKey = (key || '').trim() || null;
}

/** True when `key` is the one a probe saw refused. */
export function isHeliusKeyRejected(key: string | undefined | null): boolean {
  const k = (key || '').trim();
  return Boolean(k) && k === rejectedHeliusKey;
}

export interface HeliusProbeResult {
  ok: boolean;
  /** HTTP status when the server answered; undefined when the request never completed. */
  status?: number;
  /** The credential itself was refused — retrying changes nothing. */
  rejected: boolean;
  note?: string;
}

/**
 * One live call to Helius to find out whether the key actually works, so a dead
 * credential is reported once, in words, instead of as an endless 401 retry
 * storm. A network failure is NOT a rejection: unreachable is transient, 401 is
 * terminal, and conflating them would demote a good key on a flaky connection.
 */
export async function probeHeliusKey(key: string, timeoutMs = 8000): Promise<HeliusProbeResult> {
  const normalized = normalizeHeliusKey(key).key;
  if (!normalized) return { ok: false, rejected: false, note: 'No key to probe.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(normalized)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, rejected: true, note: `Helius refused the key (HTTP ${res.status}).` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, rejected: false, note: `Helius answered HTTP ${res.status}.` };
    }
    return { ok: true, status: res.status, rejected: false };
  } catch (err: any) {
    return { ok: false, rejected: false, note: `Could not reach Helius (${err?.name === 'AbortError' ? 'timed out' : err?.message || 'network error'}).` };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveRpcEndpoint(heliusKey: string | undefined | null): ResolvedRpcEndpoint {
  // A key the server refused is not a key. Skipping it here means every caller
  // — engine, copy trader, curve watcher — falls back together, with no edit at
  // any of their call sites.
  const key = isHeliusKeyRejected(heliusKey) ? '' : normalizeHeliusKey(heliusKey).key;

  const explicit = (process.env.SOLANA_RPC_URL || '').trim();
  if (explicit) {
    return { url: explicit, source: 'env-override', host: hostOf(explicit), keyOverridden: Boolean(key) };
  }

  if (key) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
    return { url, source: 'helius', host: hostOf(url), keyOverridden: false };
  }

  const fallback = (process.env.SOLANA_RPC_FALLBACK_URL || '').trim();
  if (fallback) {
    return { url: fallback, source: 'fallback-env', host: hostOf(fallback), keyOverridden: false };
  }

  const pub = 'https://api.mainnet-beta.solana.com';
  return { url: pub, source: 'public', host: hostOf(pub), keyOverridden: false };
}

export function rpcEndpoint(heliusKey: string | undefined | null): string {
  return resolveRpcEndpoint(heliusKey).url;
}

/**
 * WebSocket peer of {@link rpcEndpoint}, for accountSubscribe. Must follow the
 * SAME precedence as resolveRpcEndpoint, or an operator who sets SOLANA_RPC_URL
 * to a non-Helius HTTP endpoint would still get their WS traffic (and the Helius
 * key) routed to Helius — split across two providers.
 */
export function rpcWsEndpoint(heliusKey: string | undefined | null): string {
  const explicitWs = (process.env.SOLANA_RPC_WS_URL || '').trim();
  if (explicitWs) return explicitWs;

  // Honor an HTTP override as the WS source too (http->ws), matching
  // resolveRpcEndpoint's env-override precedence over the Helius key.
  const httpOverride = (process.env.SOLANA_RPC_URL || '').trim();
  if (httpOverride) return httpOverride.replace(/^http/, 'ws');

  // A key the server REFUSED is not a key — the same rule resolveRpcEndpoint
  // applies. Without this check the HTTP side demoted to the public endpoint on
  // a 401 while every websocket kept dialling the rejected Helius URL forever:
  // the reconnect loop retried on schedule, each attempt was rejected, and the
  // copy trader's leader watcher was simply deaf. Silently — the socket layer
  // reports "reconnecting", not "your key is dead", so the UI showed a bot that
  // looked alive and saw nothing.
  const key = isHeliusKeyRejected(heliusKey) ? '' : normalizeHeliusKey(heliusKey).key;
  if (key) return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;

  const fallback = (process.env.SOLANA_RPC_FALLBACK_URL || '').trim();
  if (fallback) return fallback.replace(/^http/, 'ws');
  return 'wss://api.mainnet-beta.solana.com';
}

/** True when we are running without a real credential — worth saying out loud. */
export function isFallbackEndpoint(heliusKey: string | undefined | null): boolean {
  const source = resolveRpcEndpoint(heliusKey).source;
  return source === 'fallback-env' || source === 'public';
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
  rejectedHeliusKey = null;
  state.ok = 0;
  state.failed = 0;
  state.consecutiveFailures = 0;
  state.credentialRejected = false;
  state.lastError = null;
  state.lastErrorAt = null;
}
