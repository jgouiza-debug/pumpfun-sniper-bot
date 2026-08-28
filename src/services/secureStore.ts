/**
 * At-rest encryption for local secrets, backed by the OS credential store when
 * available.
 *
 * When the process runs inside Electron, `safeStorage` encrypts with a key the
 * OS keeps in its credential manager (Windows DPAPI, macOS Keychain, Linux
 * libsecret) — so the wallet key and API keys on disk are ciphertext an
 * attacker cannot read without the logged-in user's session. Outside Electron
 * (dev, or the legacy pkg exe) there is no such facility, so this degrades to a
 * transparent passthrough that stores plaintext exactly as before. Callers get
 * one API and do not need to know which mode is active.
 *
 * A small magic prefix marks ciphertext, so a store written in one mode is read
 * correctly in the other (e.g. a plaintext file from the pkg build still opens
 * under Electron, and is re-encrypted on the next write).
 */

const ENC_PREFIX = 'ssb1:'; // safeStorage blob, v1 — base64 follows

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function getSafeStorage(): SafeStorage | null {
  // Only present in an Electron process. A guarded require keeps this module
  // usable under plain Node / pkg, where 'electron' is not installed at runtime.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    const ss: SafeStorage | undefined = electron?.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) return ss;
  } catch {
    /* not running under Electron */
  }
  return null;
}

/** True when secrets written now will be OS-keychain-encrypted at rest. */
export function secureStorageAvailable(): boolean {
  return getSafeStorage() !== null;
}

/** Encrypt for storage. Returns a marked string safe to write to a text file. */
export function encryptSecret(plain: string): string {
  const ss = getSafeStorage();
  if (!ss) return plain; // passthrough — plaintext, as the pre-Electron build did
  try {
    return ENC_PREFIX + ss.encryptString(plain).toString('base64');
  } catch {
    return plain;
  }
}

/** Decrypt a value produced by encryptSecret (or a plaintext value from before). */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored; // plaintext legacy value
  const ss = getSafeStorage();
  if (!ss) {
    // Ciphertext but no way to decrypt it (e.g. the pkg exe reading an
    // Electron-written store). Nothing safe to return.
    return '';
  }
  try {
    return ss.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}
