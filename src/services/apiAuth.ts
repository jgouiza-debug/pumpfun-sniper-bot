import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';

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
  // Same base-dir rule as the .env loader: next to the exe when packaged.
  const isPackaged = Boolean((process as any).pkg);
  const baseDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
  return path.join(baseDir, TOKEN_FILE);
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
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !isLoopbackOrigin(origin)) {
    console.warn(`⛔ [API] Refused cross-origin ${req.method} ${req.path} from ${origin}`);
    res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
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
