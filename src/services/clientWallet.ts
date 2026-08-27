import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Browser-side key handling — DELIBERATELY MINIMAL.
 *
 * This module used to (a) hardcode a Helius API key, (b) open its own RPC
 * connection from the browser, and (c) persist the raw signing key in browser
 * storage. All three are gone:
 *
 *  - The key is never written to disk or storage by the browser. It is typed
 *    into the link form, POSTed once to the loopback server, and dropped. The
 *    only at-rest copy is the server's `.photon-wallet.json`, written only when
 *    the user ticks "save", and only the server ever signs.
 *  - Balances come from the server's /api/wallet status, so no RPC credential
 *    needs to exist in browser-shipped code.
 *
 * What remains is a pure, offline format check so the user gets an immediate
 * "that key is malformed" instead of a round trip. It touches no network and no
 * storage.
 */

/**
 * Universal browser-safe private key parser.
 * Supports:
 *  - Base58 strings (Phantom, Solflare, Photon)
 *  - Quoted strings ("5Kb8..." or '5Kb8...')
 *  - JSON byte arrays ([123, 45, 67...])
 *  - Comma-separated numbers (123, 45, 67...)
 *  - 128-char hex strings & 64-char hex seeds
 */
export function parseClientSecretKey(secret: string): Keypair | null {
  try {
    let trimmed = secret.trim();
    if (!trimmed) return null;

    // Strip surrounding double/single quotes
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
      const bytes = Uint8Array.from(trimmed.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
      return Keypair.fromSecretKey(bytes);
    }
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      const bytes = Uint8Array.from(trimmed.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
      return Keypair.fromSeed(bytes);
    }

    // Base58 string (most common for Phantom / Solflare / Photon exports)
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
  } catch {
    return null;
  }
  return null;
}

/**
 * Address preview for the link form. Returns only the public key — the caller
 * gets no way to hold key material beyond the input string it already has.
 */
export function previewWalletAddress(secret: string): string | null {
  const kp = parseClientSecretKey(secret);
  return kp ? kp.publicKey.toBase58() : null;
}
