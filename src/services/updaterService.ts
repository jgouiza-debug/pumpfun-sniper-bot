import axios from 'axios';
import fs from 'fs';
import path from 'path';

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  downloadUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
  error?: string;
}

export class UpdaterService {
  private repoOwner = 'jgouiza-debug';
  private repoName = 'pumpfun-sniper-bot';
  private currentVersion = '1.0.0';

  constructor() {
    this.readLocalVersion();
  }

  private readLocalVersion(): void {
    try {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) {
          this.currentVersion = pkg.version;
        }
      }
    } catch {
      // fallback to default 1.0.0
    }
  }

  public getCurrentVersion(): string {
    return this.currentVersion;
  }

  public async checkForUpdates(): Promise<UpdateCheckResult> {
    try {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'PumpfunSniperBot-AutoUpdater',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 5000
      });

      const release = response.data;
      const latestTag = (release.tag_name || '').replace(/^v/, '');
      const hasUpdate = this.isVersionGreater(latestTag, this.currentVersion);

      // Find exe asset if uploaded
      let downloadUrl = release.html_url;
      if (Array.isArray(release.assets)) {
        const exeAsset = release.assets.find((a: any) => a.name && a.name.endsWith('.exe'));
        if (exeAsset && exeAsset.browser_download_url) {
          downloadUrl = exeAsset.browser_download_url;
        }
      }

      return {
        currentVersion: this.currentVersion,
        latestVersion: latestTag || this.currentVersion,
        hasUpdate,
        releaseUrl: release.html_url || `https://github.com/${this.repoOwner}/${this.repoName}`,
        downloadUrl,
        releaseNotes: release.body || release.name || 'New release available.',
        publishedAt: release.published_at
      };
    } catch (err: any) {
      // If 404 (no releases created yet), check commits on main branch
      if (err.response && err.response.status === 404) {
        return this.checkForCommitUpdates();
      }

      return {
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        hasUpdate: false,
        releaseUrl: `https://github.com/${this.repoOwner}/${this.repoName}`,
        error: `Could not check for updates: ${err?.message || 'Network error'}`
      };
    }
  }

  private async checkForCommitUpdates(): Promise<UpdateCheckResult> {
    try {
      const url = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/commits/master`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'PumpfunSniperBot-AutoUpdater',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 5000
      });

      const commit = response.data;
      const shortSha = commit.sha ? commit.sha.substring(0, 7) : 'latest';
      const commitDate = commit.commit?.committer?.date;

      return {
        currentVersion: this.currentVersion,
        latestVersion: `main-${shortSha}`,
        hasUpdate: false,
        releaseUrl: commit.html_url || `https://github.com/${this.repoOwner}/${this.repoName}`,
        downloadUrl: `https://github.com/${this.repoOwner}/${this.repoName}/archive/refs/heads/main.zip`,
        releaseNotes: commit.commit?.message || 'Latest commit on main branch.',
        publishedAt: commitDate
      };
    } catch (err: any) {
      return {
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        hasUpdate: false,
        releaseUrl: `https://github.com/${this.repoOwner}/${this.repoName}`,
        error: `Commit check failed: ${err?.message || String(err)}`
      };
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
}

export const updaterService = new UpdaterService();
