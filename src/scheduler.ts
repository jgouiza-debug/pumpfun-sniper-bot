import { FilterResult, PeriodicReportSummary } from "./types";

export interface SchedulerOptions {
  intervalMs?: number; // Default 5 minutes (300,000 ms)
  onReport?: (report: PeriodicReportSummary) => void;
}

export class Scheduler {
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private evaluatedTokens: FilterResult[] = [];
  private onReportCallback?: (report: PeriodicReportSummary) => void;
  private isRunning = false;

  constructor(options: SchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000; // 5 minutes
    this.onReportCallback = options.onReport;
  }

  public addEvaluatedToken(result: FilterResult): void {
    // Avoid duplicate evaluation records for same mint within current window
    const existingIndex = this.evaluatedTokens.findIndex((t) => t.mint === result.mint);
    if (existingIndex >= 0) {
      this.evaluatedTokens[existingIndex] = result;
    } else {
      this.evaluatedTokens.push(result);
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Scheduler] Started periodic reporting scheduler (Interval: ${this.intervalMs / 1000}s).`);

    this.timer = setInterval(() => {
      this.generateAndSendReport();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log("[Scheduler] Stopped periodic reporting scheduler.");
  }

  public generateAndSendReport(): PeriodicReportSummary {
    const safeTokens = this.evaluatedTokens.filter((t) => t.isSafe);
    const failedTokens = this.evaluatedTokens.filter((t) => !t.isSafe);

    const report: PeriodicReportSummary = {
      timestamp: Date.now(),
      intervalMinutes: this.intervalMs / (60 * 1000),
      totalEvaluated: this.evaluatedTokens.length,
      passedCount: safeTokens.length,
      failedCount: failedTokens.length,
      safeTokens: [...safeTokens],
    };

    console.log(`\n=================== 📊 PERIODIC TOKEN SCREENING REPORT 📊 ===================`);
    console.log(`Timestamp: ${new Date(report.timestamp).toISOString()}`);
    console.log(`Interval: ${report.intervalMinutes} minute(s)`);
    console.log(`Total Tokens Evaluated: ${report.totalEvaluated}`);
    console.log(`Passed (Safe): ${report.passedCount}`);
    console.log(`Failed (Flagged/Risky): ${report.failedCount}`);
    console.log(`-----------------------------------------------------------------------------`);

    if (safeTokens.length === 0) {
      console.log("No safe tokens detected in this reporting interval.");
    } else {
      console.log("Verified Safe Tokens:");
      safeTokens.forEach((token, index) => {
        console.log(
          `  ${index + 1}. [${token.tokenSymbol}] ${token.tokenName} (${token.mint})` +
          ` | Score: ${token.score}` +
          ` | MintRevoked: ${token.mintAuthorityRevoked}` +
          ` | FreezeRevoked: ${token.freezeAuthorityRevoked}` +
          ` | LP Locked: ${token.lpLockedPct.toFixed(1)}%`
        );
      });
    }
    console.log(`=============================================================================\n`);

    if (this.onReportCallback) {
      this.onReportCallback(report);
    }

    // Reset current window tokens after reporting
    this.evaluatedTokens = [];
    return report;
  }
}
