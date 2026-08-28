import fs from 'fs';
import path from 'path';
import { installBaseDir } from './installPaths';
import { encryptSecret, decryptSecret } from './secureStore';

/**
 * Persistence for the API credentials the operator supplies through the UI.
 *
 * WHY: removing the built-in Helius key made the credential per-install, which
 * is correct — no distributed copy should carry the builder's key. But only
 * half the flow was built. The UI field posts the key to `/api/bot/config`,
 * `SniperEngine` holds it in `this.config`, `getStatus` strips it so it is
 * never echoed back… and nothing ever writes it down. `sniperEngine` then
 * re-initialises from `process.env.HELIUS_API_KEY || ''` on the next start.
 *
 * So the intended path — hand someone the exe, they paste their own key in
 * Settings — worked exactly once per launch. Close the app and the credential
 * was gone, `heliusApiKeySet` read false again, and every RPC call started
 * failing with no statement of why. Editing a `.env` by hand was the only
 * durable option, which defeats the point of having the field at all.
 *
 * This is the same treatment `.photon-wallet.json` already gives the signing
 * key (walletService.ts), for a strictly less sensitive secret, and the same
 * base-directory rule as `.api-token` and the `.env` loader: beside the
 * executable when packaged, so a per-install file follows the install.
 *
 * SCOPE, HONESTLY: 0o600 is enforced on POSIX and a no-op on Windows, where
 * the file inherits the directory ACL. Any process running as this user can
 * read it — exactly as true of `.photon-wallet.json` and `.api-token`. This
 * protects against another user on the box and against the key reaching the
 * repo; it is not a defence against local malware.
 */

const STORE_FILE = '.api-keys.json';

export type StorableKeyField = 'heliusApiKey' | 'pumpPortalApiKey';

export interface StoredKeys {
  heliusApiKey?: string;
  pumpPortalApiKey?: string;
}

const FIELDS: StorableKeyField[] = ['heliusApiKey', 'pumpPortalApiKey'];

export function keyStorePath(): string {
  // installBaseDir centralizes the rule: the Electron data dir, else next to the
  // exe when packaged, else the working directory.
  return path.join(installBaseDir(), STORE_FILE);
}

/** Never throws — a corrupt or unreadable store must not stop the bot booting. */
export function loadStoredKeys(): StoredKeys {
  try {
    const raw = fs.readFileSync(keyStorePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const out: StoredKeys = {};
    for (const f of FIELDS) {
      const v = parsed?.[f];
      // decryptSecret transparently returns plaintext for legacy values and
      // decrypts OS-keychain-encrypted ones written under Electron.
      if (typeof v === 'string' && v.trim()) {
        const plain = decryptSecret(v).trim();
        if (plain) out[f] = plain;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Writes one credential, preserving the other.
 *
 * @returns true when the value reached disk. False means the key still works
 *          for this process but will not survive a restart — the caller says so
 *          rather than implying a durability it did not get.
 */
export function storeKey(field: StorableKeyField, value: string): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;

  const next: StoredKeys = { ...loadStoredKeys(), [field]: trimmed };
  return writeStore(next);
}

/** Removes one credential, or the whole file when nothing is left. */
export function clearStoredKey(field: StorableKeyField): boolean {
  const next = loadStoredKeys();
  if (!(field in next)) return true;
  delete next[field];

  if (Object.keys(next).length === 0) {
    try {
      fs.unlinkSync(keyStorePath());
      return true;
    } catch {
      return false;
    }
  }
  return writeStore(next);
}

function writeStore(next: StoredKeys): boolean {
  try {
    // Encrypt each value at rest when the OS keychain is available (Electron);
    // a passthrough plaintext write otherwise, exactly as before.
    const onDisk: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = next[f];
      if (typeof v === 'string' && v.trim()) onDisk[f] = encryptSecret(v.trim());
    }
    fs.writeFileSync(keyStorePath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    return true;
  } catch {
    // Read-only install directory, or the file is locked by another instance.
    return false;
  }
}

/**
 * Resolves a credential across its three sources and reports which one won.
 *
 * Precedence is stored-over-environment, matching the rule already written down
 * in loadEnv.ts: "the key entered in the UI wins over both". The alternative
 * traps the commonest repair: an operator whose `.env` holds a rotated, dead
 * key types a fresh one into Settings, it works, and then the dead file key
 * silently reclaims priority on the next restart — which is precisely the
 * failure this module exists to end.
 *
 * The cost is that a stale stored key outranks a corrected `.env`, so the
 * source is always reported and can be cleared deliberately.
 */
export function resolveKey(
  field: StorableKeyField,
  envValue: string | undefined,
  stored: StoredKeys = loadStoredKeys()
): { value: string; source: 'stored' | 'env' | 'none' } {
  const fromStore = stored[field];
  if (fromStore) return { value: fromStore, source: 'stored' };

  const fromEnv = (envValue || '').trim();
  if (fromEnv) return { value: fromEnv, source: 'env' };

  return { value: '', source: 'none' };
}
