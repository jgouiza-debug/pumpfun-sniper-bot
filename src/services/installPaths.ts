import path from 'path';

/**
 * The per-install base directory: next to the executable when packaged, else the
 * working directory. Every per-install file — the wallet key (.photon-wallet.json),
 * API keys (.api-keys.json), bearer token (.api-token), .env, run reports, the
 * copy-trader state — must resolve from HERE, not from process.cwd().
 *
 * Why it matters: a packaged exe launched by Task Scheduler or a shortcut with a
 * different "Start in" has cwd set to somewhere like C:\Windows\System32. Writing
 * the plaintext signing key there drops it outside the install dir (and outside
 * .gitignore), and on the next normal launch the wallet silently fails to load.
 * keyStore/apiAuth/loadEnv already followed this rule; this centralizes it so the
 * remaining files stop drifting from it.
 */
export function installBaseDir(): string {
  // Under Electron the main process sets SNIPER_DATA_DIR to app.getPath('userData')
  // — a real per-user app-data location (AppData on Windows, ~/Library on macOS,
  // ~/.config on Linux) — so per-install files live there, not next to the
  // (read-only, often Program Files) executable.
  const dataDir = (process.env.SNIPER_DATA_DIR || '').trim();
  if (dataDir) return dataDir;
  const isPackaged = Boolean((process as any).pkg);
  return isPackaged ? path.dirname(process.execPath) : process.cwd();
}

/** Resolve a per-install file name against the install base directory. */
export function installPath(fileName: string): string {
  return path.join(installBaseDir(), fileName);
}
