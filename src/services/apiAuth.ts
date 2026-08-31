import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { installPath } from './installPaths';

/**
 * Access control for the local API.
 *
 * This process holds a signing key and exposes endpoints that buy, sell, add
 * copy-trade leaders and rewrite the strategy config. It binds loopback, which
 * keeps the LAN out — but loopback is NOT a trust boundary against the browser.
 * Any page the user visits can issue `fetch('http://localhost:3001/api/...',
 * {method:'POST'})`. Wildcard CORS only decided whether that page could READ the
 * reply; the request itself executed either way. So `/api/bot/sell-position`,
 * `/api/copy/wallets` and `/api/wallet/link` were reachable from any open tab.
 *
 * Two controls, in order of what they actually stop:
 *
 * 1. ORIGIN ALLOWLIST (`originGuard`) — the one that closes the hole above.
 *    Browsers set `Origin` on every cross-site request and scripts cannot forge
 *    it, so refusing non-loopback origins outright refuses evil.com's POST
 *    before it reaches a handler. Loopback origins stay allowed on every port,
 *    which is what keeps the instance switcher (UI on :3001 driving the API on
 *    :3002) and the vite dev server on :3010 working.
 *
 * 2. BEARER TOKEN (`requireApiToken`) — defence in depth on mutating calls.
 *    Honest scope: a local process running as this user can read the token file
 *    exactly as it can read `.photon-wallet.json`, so this does not defeat local
 *    malware. It does stop unauthenticated pokes at the port from anything that
 *    never got the token — stray scripts, other tools, a mis-pointed instance.
 */

const TOKEN_FILE = '.api-token';

function tokenFilePath(): string {
  // MUST go through installBaseDir(). This function used to compute its own
  // base dir as `process.pkg ? dirname(execPath) : process.cwd()`, which is
  // wrong under Electron: `process.pkg` is undefined there, so the base became
  // process.cwd() — and a .app launched from Finder has cwd `/`. Writing
  // `/.api-token` fails, the failure is swallowed, and a NEW random token is
  // minted on every start. That silently breaks the one thing the file exists
  // for (the UI on :3001 authenticating against another instance on :3002) and
  // makes the API unscriptable, since the token is never anywhere on disk.
  //
  // installBaseDir() already resolves SNIPER_DATA_DIR (which the Electron main
  // process sets to a real per-user app-data path), then the packaged exe dir,
  // then cwd — the same rule keyStore and loadEnv follow.
  return installPath(TOKEN_FILE);
}

let cachedToken: string | null = null;

/**
 * The token every instance in this install directory shares.
 *
 * File-backed rather than per-process so the instance switcher keeps working:
 * the UI served by :3001 can authenticate against :3002 without a handshake.
 * SNIPER_API_TOKEN overrides it for anyone scripting the API.
 */
export function apiToken(): string {
  if (cachedToken) return cachedToken;

  const fromEnv = process.env.SNIPER_API_TOKEN?.trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }

  const file = tokenFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      cachedToken = existing;
      return cachedToken;
    }
  } catch { /* first run — fall through and mint one */ }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    // 0o600 is honoured on POSIX and a no-op on Windows, where the file inherits
    // the directory ACL. Same caveat as .photon-wallet.json.
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch {
    // Read-only install dir: the token still works, it just does not survive a
    // restart, and the UI re-reads it from /api/session-token each load.
  }
  cachedToken = generated;
  return cachedToken;
}

/** http(s) on a loopback host, on any port. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // WHATWG URL keeps the brackets on IPv6 hostnames.
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Refuse anything that announces a non-loopback origin. Requests with no Origin
 * at all (curl, the packaged window's navigations) pass here and are caught by
 * the token check if they mutate.
 */
/**
 * A Host header that names a loopback address.
 *
 * THE GAP THIS CLOSES (DNS rebinding). originGuard reads only `Origin`, and a
 * browser omits that header on same-origin GETs — which is exactly what a
 * rebinding attack produces. An attacker page loads from their domain, the
 * domain's DNS then resolves to 127.0.0.1, and the page's subsequent fetches are
 * "same-origin" from the browser's point of view: no Origin header, so the guard
 * waved them through. The requests still carry `Host: attacker.example`, because
 * the browser sends the NAME it resolved, not the address.
 *
 * So the Host header is the discriminator the Origin header cannot be. A real
 * local client always addresses the server as localhost or 127.0.0.1; nothing
 * legitimate reaches it under someone else's domain name.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;                       // HTTP/1.1 requires Host; absent is not a pass
  const raw = host.trim().toLowerCase();
  let name: string;
  if (raw.startsWith('[')) {
    // Bracketed IPv6, optionally with a port: [::1] or [::1]:3001.
    name = raw.slice(1, raw.indexOf(']') === -1 ? undefined : raw.indexOf(']'));
  } else if ((raw.match(/:/g) || []).length > 1) {
    // A bare IPv6 literal carries several colons and cannot carry a port —
    // stripping ":<digits>" from it would eat the last group and turn '::1'
    // into ':'.
    name = raw;
  } else {
    name = raw.replace(/:\d+$/, '');
  }
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0:0:0:0:0:0:0:1';
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !isLoopbackOrigin(origin)) {
    console.warn(`⛔ [API] Refused cross-origin ${req.method} ${req.path} from ${origin}`);
    res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
    return;
  }
  // Checked even when Origin is absent — that absence is the attack, not the
  // exemption. See isLoopbackHost.
  if (!isLoopbackHost(req.headers.host)) {
    console.warn(`⛔ [API] Refused ${req.method} ${req.path} addressed to Host "${req.headers.host}" — not a loopback name (DNS rebinding).`);
    res.status(403).json({ error: 'This server only answers requests addressed to localhost.' });
    return;
  }
  next();
}

function presentedToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const header = req.headers['x-sniper-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  const provided = presentedToken(req);
  if (!provided || !constantTimeEquals(provided, apiToken())) {
    console.warn(`⛔ [API] Refused unauthenticated ${req.method} ${req.path}`);
    res.status(401).json({ error: 'Missing or invalid API token.' });
    return;
  }
  next();
}
