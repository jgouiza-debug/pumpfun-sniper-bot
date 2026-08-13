import fs from 'fs';
import path from 'path';

/**
 * Load a .env sitting NEXT TO the executable, BEFORE anything else initialises.
 *
 * This lives in its own module for one reason: import order. ES imports are
 * evaluated before the importing module's own statements, so the SniperEngine
 * singleton is constructed the moment `server.ts` imports it — earlier than any
 * function call in that file. When this loader ran inline in server.ts, the
 * engine had therefore already read `process.env.HELIUS_API_KEY` and found it
 * empty, and a packaged exe relying on a .env beside it would start with no RPC
 * credential at all.
 *
 * `npm run dev` hides this: node's --env-file-if-exists flag populates the
 * environment before any module loads. The packaged exe is launched by
 * double-click with no flags, which is exactly the case this file exists for —
 * so it must be the FIRST import in server.ts, above the service imports.
 *
 * The .env is deliberately NOT bundled into the binary (see the note in
 * package.json "pkg"), because that would bake the builder's own Helius key
 * into every copy handed out.
 *
 * Precedence: a real environment variable always wins over the file, and the
 * key entered in the UI wins over both (it is applied at runtime).
 */
function loadEnvBesideExecutable(): void {
  // process.execPath is the exe itself when packaged; cwd otherwise.
  const isPackaged = Boolean((process as any).pkg);
  const baseDir = isPackaged ? path.dirname(process.execPath) : process.cwd();
  const envPath = path.join(baseDir, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Never clobber a variable the user set in their shell.
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log(`🔑 Loaded settings from ${envPath}`);
  } catch {
    // A malformed .env must not stop the bot from starting — the UI can still
    // supply the key.
  }
}

loadEnvBesideExecutable();
