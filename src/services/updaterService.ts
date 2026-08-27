import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

/**
 * The release asset this build should update itself with.
 *
 * Must agree exactly with the names the release workflow uploads, because the
 * updater overwrites the running binary with whatever it downloads: matching
 * the wrong asset replaces a Mac build with a Windows one and the app never
 * starts again.
 */
export function releaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  if (platform === 'win32') return 'pumpfun-sniper-bot.exe';
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'pumpfun-sniper-bot-macos-arm64'
      : 'pumpfun-sniper-bot-macos-x64';
  }
  return `pumpfun-sniper-bot-${platform}-${arch}`;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl?: string;
  /** SHA256 asset URL. Without it an update cannot be applied — see apply(). */
  checksumUrl?: string;
  assetSizeBytes?: number;
  releaseNotes?: string;
  publishedAt?: string;
  /** True when this build can replace itself in place (packaged exe only). */
  canSelfUpdate: boolean;
  error?: string;
}

export type UpdateStage =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'swapping'
  | 'restarting'
  | 'done'
  | 'failed';

export interface UpdateProgress {
  stage: UpdateStage;
  receivedBytes: number;
  totalBytes: number;
  pct: number;
  message: string;
  error?: string;
}

/** Suffix left behind for the previous build; cleaned up on the next start. */
const OLD_SUFFIX = '.old';
const NEW_SUFFIX = '.new';

export class UpdaterService {
  private repoOwner = 'jgouiza-debug';
  private repoName = 'pumpfun-sniper-bot';
  private currentVersion = '0.0.0';

  private progress: UpdateProgress = {
    stage: 'idle',
    receivedBytes: 0,
    totalBytes: 0,
    pct: 0,
    message: 'No update in progress.',
  };

  /**
   * Answers "is it safe to restart right now". Wired to the engine by server.ts
   * so this module does not import it (the engine imports the updater's route
   * neighbours, and a cycle here would be a startup hazard).
   */
  private restartGuard: () => { ok: boolean; reason?: string } = () => ({ ok: true });

  constructor() {
    this.readLocalVersion();
    this.cleanupPreviousBuild();
  }

  public setRestartGuard(fn: () => { ok: boolean; reason?: string }): void {
    this.restartGuard = fn;
  }

  /**
   * Resolve this build's version.
   *
   * The old implementation read `package.json` from `process.cwd()`. A packaged
   * exe has no package.json beside it, so EVERY exe user reported 1.0.0 forever
   * and no comparison against a release tag could ever be true.
   *
   * `__dirname/../../package.json` resolves correctly in all three cases:
   * ts-node (src/services -> repo root), compiled JS (dist/services -> root),
   * and the pkg snapshot (/snapshot/<proj>/dist/services -> /snapshot/<proj>),
   * because pkg always embeds package.json in the snapshot.
   */
  private readLocalVersion(): void {
    const fromEnv = process.env.SNIPER_VERSION?.trim();
    if (fromEnv) {
      this.currentVersion = fromEnv.replace(/^v/, '');
      return;
    }

    const candidates = [
      path.join(__dirname, '..', '..', 'package.json'),
      path.join(__dirname, '..', 'package.json'),
      path.resolve(process.cwd(), 'package.json'),
    ];

    for (const pkgPath of candidates) {
      try {
        if (!fs.existsSync(pkgPath)) continue;
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg?.version) {
          this.currentVersion = String(pkg.version);
          return;
        }
      } catch {
        // try the next candidate
      }
    }
  }

  /** True only for a pkg-built exe, the only build that can swap itself. */
  public isPackaged(): boolean {
    return Boolean((process as any).pkg);
  }

  public getCurrentVersion(): string {
    this.readLocalVersion();
    return this.currentVersion;
  }

  private githubAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'PumpfunSniperBot-AutoUpdater',
      'Accept': 'application/vnd.github.v3+json',
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.SNIPER_GITHUB_TOKEN;
    if (token && token.trim()) {
      headers['Authorization'] = `token ${token.trim()}`;
    }
    return headers;
  }

  public getProgress(): UpdateProgress {
    return { ...this.progress };
  }

  /** Remove the previous build left behind by a successful swap. */
  private cleanupPreviousBuild(): void {
    if (!this.isPackaged()) return;
    const old = process.execPath + OLD_SUFFIX;
    try {
      if (fs.existsSync(old)) {
        fs.unlinkSync(old);
        console.log('🧹 Removed the previous build after a successful update.');
      }
    } catch {
      // Still running from the OS's perspective, or locked by AV. It is inert
      // either way and the next start tries again.
    }
  }

  public async checkForUpdates(): Promise<UpdateCheckResult> {
    const base: UpdateCheckResult = {
      currentVersion: this.currentVersion,
      latestVersion: this.currentVersion,
      hasUpdate: false,
      releaseUrl: `https://github.com/${this.repoOwner}/${this.repoName}`,
      canSelfUpdate: this.isPackaged(),
    };

    try {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
      const response = await axios.get(url, {
        headers: this.githubAuthHeaders(),
        timeout: 8000,
      });

      const release = response.data;
      const latestTag = (release.tag_name || '').replace(/^v/, '');

      let downloadUrl: string | undefined;
      let checksumUrl: string | undefined;
      let assetSizeBytes: number | undefined;

      if (Array.isArray(release.assets)) {
        // Pick the asset for THIS platform. Matching '.exe' unconditionally
        // meant a Mac build would happily download a Windows binary, overwrite
        // itself with it and relaunch into something that cannot execute.
        const wanted = releaseAssetName();
        const binAsset = release.assets.find((a: any) => a?.name === wanted)
          // Older Windows releases predate the platform suffix.
          ?? (process.platform === 'win32'
            ? release.assets.find((a: any) => typeof a?.name === 'string' && a.name.endsWith('.exe'))
            : undefined);

        if (binAsset?.browser_download_url) {
          downloadUrl = binAsset.browser_download_url;
          assetSizeBytes = Number(binAsset.size) || undefined;
        }
        // The checksum has to belong to the SAME asset. The old code took the
        // first '.sha256' in the array regardless of which binary it described,
        // which on a multi-platform release meant verifying the Windows exe
        // against the macOS hash. Exact-name match first, both extensions —
        // macOS checksums ship as .sha256sum precisely so that exactly one
        // '.sha256' exists for pre-1.0.1 clients (see release.yml).
        const sumAsset = release.assets.find((a: any) => a?.name === `${binAsset?.name}.sha256`)
          ?? release.assets.find((a: any) => a?.name === `${binAsset?.name}.sha256sum`);
        if (sumAsset?.browser_download_url) checksumUrl = sumAsset.browser_download_url;
      }

      return {
        ...base,
        latestVersion: latestTag || this.currentVersion,
        hasUpdate: this.isVersionGreater(latestTag, this.currentVersion),
        releaseUrl: release.html_url || base.releaseUrl,
        downloadUrl: downloadUrl ?? release.html_url,
        checksumUrl,
        assetSizeBytes,
        releaseNotes: release.body || release.name || 'New release available.',
        publishedAt: release.published_at,
      };
    } catch (err: any) {
      if (err?.response?.status === 404) return this.checkForCommitUpdates(base);
      if (err?.response?.status === 403) {
        const isRateLimit = err?.response?.headers?.['x-ratelimit-remaining'] === '0';
        return {
          ...base,
          error: isRateLimit
            ? 'GitHub API rate limit reached (60 req/hr). Will retry automatically.'
            : 'Access to GitHub releases restricted (403 Forbidden).',
        };
      }
      return { ...base, error: `Could not check for updates: ${err?.message || 'Network error'}` };
    }
  }

  /**
   * Fallback when the repo has no published releases at all.
   *
   * It reports honestly that there is nothing installable rather than
   * pretending. The old version returned `hasUpdate: false` unconditionally
   * even on the release path's success — combined with a repo that had zero
   * releases, that made the update banner unreachable by construction.
   */
  private async checkForCommitUpdates(base: UpdateCheckResult): Promise<UpdateCheckResult> {
    try {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/commits/master`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'PumpfunSniperBot-AutoUpdater',
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 8000,
      });

      const commit = response.data;
      const shortSha = commit?.sha ? String(commit.sha).substring(0, 7) : 'latest';

      return {
        ...base,
        latestVersion: `master-${shortSha}`,
        hasUpdate: false,
        releaseUrl: commit?.html_url || base.releaseUrl,
        releaseNotes: commit?.commit?.message || 'Latest commit on master.',
        publishedAt: commit?.commit?.committer?.date,
        error: 'No published release yet — push a v* tag to build and publish one.',
      };
    } catch (err: any) {
      return { ...base, error: `Commit check failed: ${err?.message || String(err)}` };
    }
  }

  private isVersionGreater(remoteVersion: string, localVersion: string): boolean {
    if (!remoteVersion) return false;
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
    const r = parse(remoteVersion);
    const l = parse(localVersion);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rVal = r[i] || 0;
      const lVal = l[i] || 0;
      if (rVal > lVal) return true;
      if (rVal < lVal) return false;
    }
    return false;
  }

  private setProgress(patch: Partial<UpdateProgress>): void {
    this.progress = { ...this.progress, ...patch };
    if (this.progress.totalBytes > 0) {
      this.progress.pct = Math.min(100, Math.round((this.progress.receivedBytes / this.progress.totalBytes) * 100));
    }
  }

  /** Fetch and parse the published `<hex>  <filename>` checksum file. */
  private async fetchExpectedSha256(checksumUrl: string): Promise<string | null> {
    try {
      const res = await axios.get(checksumUrl, {
        headers: { 'User-Agent': 'PumpfunSniperBot-AutoUpdater' },
        timeout: 15000,
        responseType: 'text',
        transformResponse: [(d) => d],
      });
      const match = String(res.data).match(/\b[a-fA-F0-9]{64}\b/);
      return match ? match[0].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  private async downloadTo(url: string, destPath: string): Promise<void> {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 0,
      maxRedirects: 5,
      headers: { 'User-Agent': 'PumpfunSniperBot-AutoUpdater' },
    });

    const total = Number(res.headers['content-length']) || this.progress.totalBytes || 0;
    this.setProgress({ totalBytes: total, receivedBytes: 0 });

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      res.data.on('data', (chunk: Buffer) => {
        this.setProgress({ receivedBytes: this.progress.receivedBytes + chunk.length });
      });
      res.data.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.data.pipe(out);
    });
  }

  private async sha256OfFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    });
  }

  /**
   * Replace this exe with the published release and restart into it.
   *
   * The Windows swap: a running image cannot be OVERWRITTEN, but it can be
   * RENAMED. So the sequence is rename-self-aside, move the new build into the
   * original path, launch it, exit. The next start deletes the `.old` file.
   *
   * Two refusals are deliberate and fail closed:
   *  - No published SHA256 means no update. An unverified binary that replaces
   *    the process holding the signing key is not worth the convenience.
   *  - Never mid-trade. Restarting with an open position would strand it
   *    between processes, and the real-mode lock would be held by a PID that is
   *    about to disappear.
   */
  public async applyUpdate(): Promise<{ ok: boolean; error?: string }> {
    if (this.progress.stage !== 'idle' && this.progress.stage !== 'failed' && this.progress.stage !== 'done') {
      return { ok: false, error: 'An update is already in progress.' };
    }

    if (!this.isPackaged()) {
      return { ok: false, error: 'Self-update only applies to the packaged .exe. In a dev checkout, use git pull.' };
    }

    const guard = this.restartGuard();
    if (!guard.ok) {
      return { ok: false, error: guard.reason || 'The bot is busy — stop it before updating.' };
    }

    const check = await this.checkForUpdates();
    if (!check.hasUpdate) {
      return { ok: false, error: check.error || 'Already on the latest version.' };
    }
    // The URL has to end in THIS platform's asset name. A Mac build that
    // accepted the .exe would overwrite itself with an unrunnable binary.
    const wantedAsset = releaseAssetName();
    if (!check.downloadUrl || !check.downloadUrl.endsWith(wantedAsset)) {
      return { ok: false, error: `That release has no ${wantedAsset} asset attached.` };
    }
    if (!check.checksumUrl) {
      return { ok: false, error: 'That release publishes no .sha256 checksum — refusing to install an unverified binary.' };
    }

    const exePath = process.execPath;
    const newPath = exePath + NEW_SUFFIX;
    const oldPath = exePath + OLD_SUFFIX;

    try {
      this.setProgress({
        stage: 'downloading',
        receivedBytes: 0,
        totalBytes: check.assetSizeBytes ?? 0,
        message: `Downloading ${check.latestVersion}…`,
        error: undefined,
      });

      try { if (fs.existsSync(newPath)) fs.unlinkSync(newPath); } catch { /* replaced below */ }
      await this.downloadTo(check.downloadUrl, newPath);

      this.setProgress({ stage: 'verifying', message: 'Verifying signature…' });
      const expected = await this.fetchExpectedSha256(check.checksumUrl);
      if (!expected) {
        throw new Error('Could not read the published checksum.');
      }
      const actual = await this.sha256OfFile(newPath);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch — expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…. The download was corrupt or tampered with.`);
      }

      // Re-check the guard: a position could have opened during the download.
      const guardAfter = this.restartGuard();
      if (!guardAfter.ok) throw new Error(guardAfter.reason || 'The bot became busy during the download.');

      this.setProgress({ stage: 'swapping', message: 'Installing…' });

      // A file arriving over HTTP has no execute bit, and on macOS/Linux the
      // swap would otherwise succeed and then fail to relaunch — leaving the
      // user with a binary that cannot start and no obvious cause. Windows
      // ignores the mode entirely.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(newPath, 0o755); } catch { /* the spawn below will report it */ }
        // Downloads are quarantined by Gatekeeper; without this the relaunch is
        // blocked by a dialog the headless restart cannot answer. Best effort:
        // absent xattr, the user clears it manually per the release notes.
        if (process.platform === 'darwin') {
          try {
            spawn('xattr', ['-d', 'com.apple.quarantine', newPath], { stdio: 'ignore' }).unref();
          } catch { /* not fatal — the binary still runs once approved */ }
        }
      }

      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch { /* best effort */ }
      fs.renameSync(exePath, oldPath);
      try {
        fs.renameSync(newPath, exePath);
      } catch (err) {
        // Put the working build back rather than leaving no exe at all.
        try { fs.renameSync(oldPath, exePath); } catch { /* nothing further we can do */ }
        throw err;
      }

      this.setProgress({ stage: 'restarting', message: 'Restarting into the new version…' });

      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
      child.unref();

      this.setProgress({ stage: 'done', message: `Updated to ${check.latestVersion}. Restarting…` });

      // Give the HTTP response time to reach the browser before the process
      // disappears underneath it.
      setTimeout(() => process.exit(0), 1200).unref();
      return { ok: true };
    } catch (err: any) {
      const message = err?.message || String(err);
      try { if (fs.existsSync(newPath)) fs.unlinkSync(newPath); } catch { /* best effort */ }
      this.setProgress({ stage: 'failed', message: 'Update failed.', error: message });
      return { ok: false, error: message };
    }
  }
}

export const updaterService = new UpdaterService();
