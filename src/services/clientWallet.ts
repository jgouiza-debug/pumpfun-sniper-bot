import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const UNIVERSAL_HELIUS_KEY = 'c8547397-ee14-46c2-b10b-85a1eccbaa32';
export const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${UNIVERSAL_HELIUS_KEY}`;

export interface ClientWalletInfo {
  linked: boolean;
  address: string | null;
  shortAddress: string | null;
  solBalance: number;
  usdBalance: number;
  deployableSol: number;
  rpcHealthy: boolean;
  source: 'client_browser' | 'server' | 'none';
  privateKey: string | null;
}

const STORAGE_KEY = 'photon_client_private_key_v1';

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

export function saveStoredClientKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key.trim());
  } catch { /* storage disabled */ }
}

export function getStoredClientKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStoredClientKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage disabled */ }
}

export async function fetchOnChainWalletInfo(
  keypair: Keypair,
  solPriceUsd = 170
): Promise<{ solBalance: number; usdBalance: number; deployableSol: number; rpcHealthy: boolean }> {
  try {
    const connection = new Connection(HELIUS_RPC_URL, 'confirmed');
    const lamports = await connection.getBalance(keypair.publicKey, 'confirmed');
    const solBalance = Number((lamports / LAMPORTS_PER_SOL).toFixed(5));
    const usdBalance = Number((solBalance * solPriceUsd).toFixed(2));
    const deployableSol = Number(Math.max(0, solBalance - 0.005).toFixed(4));
    return { solBalance, usdBalance, deployableSol, rpcHealthy: true };
  } catch {
    return { solBalance: 0, usdBalance: 0, deployableSol: 0, rpcHealthy: false };
  }
}
