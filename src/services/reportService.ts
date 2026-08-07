import fs from 'fs';
import path from 'path';
import { BotConfig, RunReport, RunReportOpenPosition, TradeHistoryRecord } from '../types';

const REPORTS_DIR = path.resolve(process.cwd(), 'reports');

/**
 * Tracks a single bot run (start -> stop) and produces the end-of-run report.
 *
 * Counters are incremented as events happen rather than derived at the end, so
 * the screening funnel (how many tokens were seen vs. bought) survives even
 * though rejected tokens are never persisted anywhere.
 */
export class ReportService {
  private runId: string | null = null;
  private startedAt = 0;
  private startingBankrollUsd = 0;
  private startingWalletSol = 0;
  private modeAtStart: 'paper' | 'real' = 'paper';
  private leniencyAtStart = '';
  private walletAtStart: string | null = null;

  private tokensSeen = 0;
  private tokensPassed = 0;
  private tokensRejected = 0;
  private rejectionReasons = new Map<string, number>();
  private positionsOpened = 0;

  private trades: TradeHistoryRecord[] = [];
  private lastReport: RunReport | null = null;

  public isRunning(): boolean {
    return this.runId !== null;
  }

  public getRunId(): string | null {
    return this.runId;
  }

  public start(config: BotConfig, bankrollUsd: number, walletSol: number, walletAddress: string | null): void {
    this.runId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.startedAt = Date.now();
    this.startingBankrollUsd = bankrollUsd;
    this.startingWalletSol = walletSol;
    this.modeAtStart = config.tradingMode;
    this.leniencyAtStart = config.leniencyMode;
    this.walletAtStart = walletAddress;

    this.tokensSeen = 0;
    this.tokensPassed = 0;
    this.tokensRejected = 0;
    this.rejectionReasons.clear();
    this.positionsOpened = 0;
    this.trades = [];
  }

  public recordScreened(passed: boolean, primaryReason?: string): void {
    if (!this.runId) return;
    this.tokensSeen++;
    if (passed) {
      this.tokensPassed++;
      return;
    }
    this.tokensRejected++;
    if (primaryReason) {
      // Bucket by the reason's leading clause so counts stay readable rather
      // than fragmenting on interpolated numbers.
      const key = primaryReason.split('(')[0].trim().slice(0, 80);
      this.rejectionReasons.set(key, (this.rejectionReasons.get(key) || 0) + 1);
    }
  }

  public recordPositionOpened(): void {
    if (this.runId) this.positionsOpened++;
  }

  public recordTrade(record: TradeHistoryRecord): void {
    if (this.runId) this.trades.push(record);
  }

  /** Live snapshot of the in-progress run, for the dashboard. */
  public getLiveSummary(openPositions: number, unrealizedUsd: number): Partial<RunReport> | null {
    if (!this.runId) return null;
    const realizedUsd = this.trades.reduce((acc, t) => acc + t.pnlUsd, 0);
    return {
      runId: this.runId,
      startedAt: this.startedAt,
      durationSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      tokensSeen: this.tokensSeen,
      tokensPassed: this.tokensPassed,
      tokensRejected: this.tokensRejected,
      positionsOpened: this.positionsOpened,
      positionsStillOpen: openPositions,
      realizedPnlUsd: Number(realizedUsd.toFixed(2)),
      unrealizedPnlUsd: Number(unrealizedUsd.toFixed(2)),
    };
  }

  /**
   * Closes the run, computes the report, writes it to disk and returns it.
   * Safe to call when no run is active — returns null.
   */
  public finish(
    endingBankrollUsd: number,
    endingWalletSol: number,
    openPositionsCount: number,
    unrealizedUsd: number,
    solPriceUsd: number,
    openPositions: RunReportOpenPosition[] = []
  ): RunReport | null {
    if (!this.runId) return null;

    const endedAt = Date.now();
    const wins = this.trades.filter(t => t.pnlUsd > 0);
    const losses = this.trades.filter(t => t.pnlUsd <= 0);
    const realizedPnlUsd = Number(this.trades.reduce((acc, t) => acc + t.pnlUsd, 0).toFixed(2));
    const totalFeesUsd = Number(this.trades.reduce((acc, t) => acc + (t.feeDragUsd || 0), 0).toFixed(2));
    const fillVerifiedLegs = this.trades.filter(t => t.fillVerified).length;

    const byPlaybook: Record<string, { trades: number; pnlUsd: number; wins: number }> = {};
    const byExitReason: Record<string, { count: number; pnlUsd: number }> = {};

    for (const t of this.trades) {
      const pb = t.playbook || 'UNKNOWN';
      byPlaybook[pb] ??= { trades: 0, pnlUsd: 0, wins: 0 };
      byPlaybook[pb].trades++;
      byPlaybook[pb].pnlUsd = Number((byPlaybook[pb].pnlUsd + t.pnlUsd).toFixed(2));
      if (t.pnlUsd > 0) byPlaybook[pb].wins++;

      // Strip per-leg annotations before bucketing so counts don't fragment
      // on interpolated amounts ("[final leg; position total +$3]").
      const reasonKey = (t.exitReason || 'Unknown')
        .replace(/\s*\[final leg.*$/i, '')
        .split('(')[0]
        .trim()
        .slice(0, 60);
      byExitReason[reasonKey] ??= { count: 0, pnlUsd: 0 };
      byExitReason[reasonKey].count++;
      byExitReason[reasonKey].pnlUsd = Number((byExitReason[reasonKey].pnlUsd + t.pnlUsd).toFixed(2));
    }

    const sortedByPnl = [...this.trades].sort((a, b) => b.pnlUsd - a.pnlUsd);
    const avgHold = this.trades.length
      ? Math.floor(this.trades.reduce((acc, t) => acc + t.holdTimeSeconds, 0) / this.trades.length)
      : 0;

    const report: RunReport = {
      runId: this.runId,
      startedAt: this.startedAt,
      endedAt,
      durationSeconds: Math.floor((endedAt - this.startedAt) / 1000),
      tradingMode: this.modeAtStart,
      leniencyMode: this.leniencyAtStart,
      walletAddress: this.walletAtStart,
      solPriceUsd,

      tokensSeen: this.tokensSeen,
      tokensPassed: this.tokensPassed,
      tokensRejected: this.tokensRejected,
      passRatePct: this.tokensSeen ? Number(((this.tokensPassed / this.tokensSeen) * 100).toFixed(2)) : 0,
      topRejectionReasons: [...this.rejectionReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count })),

      positionsOpened: this.positionsOpened,
      positionsClosed: this.trades.length,
      positionsStillOpen: openPositionsCount,

      totalTrades: this.trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRatePct: this.trades.length ? Number(((wins.length / this.trades.length) * 100).toFixed(1)) : 0,

      realizedPnlUsd,
      realizedPnlSol: Number((realizedPnlUsd / (solPriceUsd || 1)).toFixed(4)),
      unrealizedPnlUsd: Number(unrealizedUsd.toFixed(2)),
      totalFeesUsd,

      startingBankrollUsd: Number(this.startingBankrollUsd.toFixed(2)),
      endingBankrollUsd: Number(endingBankrollUsd.toFixed(2)),
      roiPct: this.startingBankrollUsd
        ? Number((((endingBankrollUsd - this.startingBankrollUsd) / this.startingBankrollUsd) * 100).toFixed(2))
        : 0,
      startingWalletSol: this.startingWalletSol,
      endingWalletSol: endingWalletSol,

      bestTrade: sortedByPnl[0]
        ? { symbol: sortedByPnl[0].tokenSymbol, pnlUsd: sortedByPnl[0].pnlUsd, pnlPct: sortedByPnl[0].pnlPct, mint: sortedByPnl[0].mint }
        : null,
      worstTrade: sortedByPnl.length > 1
        ? {
            symbol: sortedByPnl[sortedByPnl.length - 1].tokenSymbol,
            pnlUsd: sortedByPnl[sortedByPnl.length - 1].pnlUsd,
            pnlPct: sortedByPnl[sortedByPnl.length - 1].pnlPct,
            mint: sortedByPnl[sortedByPnl.length - 1].mint,
          }
        : null,
      avgHoldSeconds: avgHold,
      byPlaybook,
      byExitReason,

      walletDeltaSol: Number((endingWalletSol - this.startingWalletSol).toFixed(5)),
      walletDeltaUsd: Number(((endingWalletSol - this.startingWalletSol) * solPriceUsd).toFixed(2)),
      fillVerifiedLegs,
      estimatedLegs: this.trades.length - fillVerifiedLegs,
      trades: [...this.trades],
      openPositions,
    };

    this.lastReport = report;
    this.persist(report);
    this.runId = null;
    return report;
  }

  public getLastReport(): RunReport | null {
    return this.lastReport;
  }

  /** Lists previously written reports, newest first. */
  public listSavedReports(limit = 20): Array<{ file: string; runId: string; endedAt: number }> {
    try {
      if (!fs.existsSync(REPORTS_DIR)) return [];
      return fs
        .readdirSync(REPORTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const stat = fs.statSync(path.join(REPORTS_DIR, f));
          return { file: f, runId: f.replace(/\.json$/, ''), endedAt: stat.mtimeMs };
        })
        .sort((a, b) => b.endedAt - a.endedAt)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private persist(report: RunReport): void {
    try {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(REPORTS_DIR, `${report.runId}.json`), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(REPORTS_DIR, `${report.runId}.md`), this.toMarkdown(report));
      console.log(`\n[Report] Saved to reports/${report.runId}.json and .md`);
    } catch (err: any) {
      console.warn(`[Report] Could not write report: ${err.message}`);
    }
  }

  /** `-$13.20` / `+$41.50` — sign outside the currency symbol, always 2dp. */
  private static money(n: number): string {
    const v = Number(n) || 0;
    return `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;
  }

  private static pct(n: number): string {
    const v = Number(n) || 0;
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  }

  /** Console rendering, printed when a run ends. */
  public toConsole(r: RunReport): string {
    const dur = `${Math.floor(r.durationSeconds / 60)}m ${r.durationSeconds % 60}s`;
    const money = ReportService.money;
    const pct = ReportService.pct;
    const lines = [
      '',
      '═══════════════════════════════════════════════════════════════',
      `  RUN REPORT — ${r.runId}`,
      '═══════════════════════════════════════════════════════════════',
      `  Mode          ${r.tradingMode.toUpperCase()} / ${r.leniencyMode.toUpperCase()}   Duration: ${dur}`,
      r.walletAddress ? `  Wallet        ${r.walletAddress}` : '  Wallet        (paper — no wallet)',
      '',
      '  ── Screening funnel ──────────────────────────────────────────',
      `  Seen ${r.tokensSeen}   Passed ${r.tokensPassed}   Rejected ${r.tokensRejected}   Pass rate ${r.passRatePct}%`,
      ...(r.topRejectionReasons.length
        ? r.topRejectionReasons.slice(0, 5).map(x => `    ${String(x.count).padStart(5)}  ${x.reason}`)
        : ['    (no rejections recorded)']),
      '',
      '  ── Positions ─────────────────────────────────────────────────',
      `  Opened ${r.positionsOpened}   Closed ${r.positionsClosed}   Still open ${r.positionsStillOpen}`,
      `  Trades ${r.totalTrades}   W/L ${r.winCount}/${r.lossCount}   Win rate ${r.winRatePct}%`,
      `  Avg hold ${Math.floor(r.avgHoldSeconds / 60)}m ${r.avgHoldSeconds % 60}s`,
      '',
      '  ── P&L ───────────────────────────────────────────────────────',
      ...(r.tradingMode === 'real'
        ? [`  WALLET Δ      ${r.walletDeltaSol >= 0 ? '+' : ''}${r.walletDeltaSol} SOL (${money(r.walletDeltaUsd)})  ← ground truth`]
        : []),
      `  Realized      ${money(r.realizedPnlUsd)}  (${r.realizedPnlSol >= 0 ? '+' : ''}${r.realizedPnlSol} SOL, ${r.fillVerifiedLegs} on-chain / ${r.estimatedLegs} est.)`,
      `  Unrealized    ${money(r.unrealizedPnlUsd)}  (${r.positionsStillOpen} open)`,
      `  Fees          ${money(-Math.abs(r.totalFeesUsd))}`,
      `  Bankroll      $${r.startingBankrollUsd.toFixed(2)} -> $${r.endingBankrollUsd.toFixed(2)}   ROI ${pct(r.roiPct)}`,
      ...(r.walletAddress ? [`  Wallet SOL    ${r.startingWalletSol} -> ${r.endingWalletSol}`] : []),
      '',
      ...(r.bestTrade ? [`  Best   $${r.bestTrade.symbol}  ${money(r.bestTrade.pnlUsd)} (${pct(r.bestTrade.pnlPct)})`] : []),
      ...(r.worstTrade ? [`  Worst  $${r.worstTrade.symbol}  ${money(r.worstTrade.pnlUsd)} (${pct(r.worstTrade.pnlPct)})`] : []),
      '',
      '  ── By exit reason ────────────────────────────────────────────',
      ...(Object.keys(r.byExitReason).length
        ? Object.entries(r.byExitReason)
            .sort((a, b) => b[1].pnlUsd - a[1].pnlUsd)
            .map(([reason, v]) => `    ${String(v.count).padStart(4)}x  ${money(v.pnlUsd).padStart(11)}  ${reason}`)
        : ['    (no closed trades)']),
      '═══════════════════════════════════════════════════════════════',
      '',
    ];
    return lines.join('\n');
  }

  private static clock(ts: number): string {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  }

  private static qty(n: number | undefined): string {
    if (!n || !isFinite(n)) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toFixed(0);
  }

  private toMarkdown(r: RunReport): string {
    const dur = `${Math.floor(r.durationSeconds / 60)}m ${r.durationSeconds % 60}s`;
    const money = ReportService.money;
    const pct = ReportService.pct;
    const clock = ReportService.clock;
    const qty = ReportService.qty;

    // ---- Trade ledger: one row per closed leg, chronological ----
    const ledgerRows = [...r.trades]
      .sort((a, b) => a.exitTime - b.exitTime)
      .map((t, i) => {
        const proceeds = Number((t.pnlUsd + t.investedUsd + (t.feeDragUsd || 0)).toFixed(2));
        const solscan = t.sellTxid ? ` [tx](https://solscan.io/tx/${t.sellTxid})` : '';
        return `| ${i + 1} | $${t.tokenSymbol} | ${clock(t.entryTime)} | ${qty(t.tokensSold)} | ${clock(t.exitTime)} | $${t.investedUsd.toFixed(2)} | $${proceeds.toFixed(2)} | ${money(t.pnlUsd)} (${pct(t.pnlPct)}) | ${t.fillVerified ? '✅ on-chain' : '≈ estimate'} | ${(t.exitReason || '').replace(/\|/g, '/').slice(0, 60)}${solscan} |`;
      })
      .join('\n') || '| — | — | — | — | — | — | — | — | — | no closed trades |';

    const openRows = r.openPositions
      .map(p => `| $${p.symbol} | ${clock(p.boughtAt)} | ${qty(p.tokensHeld)} | $${p.investedUsd.toFixed(2)} | ${money(p.unrealizedPnlUsd)} | ${p.fillVerified ? '✅' : '≈'} | \`${p.mint.slice(0, 8)}...\` |`)
      .join('\n');

    const isReal = r.tradingMode === 'real';
    const gapUsd = Number((r.realizedPnlUsd - r.walletDeltaUsd).toFixed(2));
    const openCostUsd = Number(r.openPositions.reduce((a, p) => a + p.investedUsd, 0).toFixed(2));

    const groundTruth = isReal ? `## Ground truth (wallet)

The wallet delta is what actually happened; per-trade figures approximate it.

| | |
|---|---|
| Wallet SOL | ${r.startingWalletSol} → ${r.endingWalletSol} (**${r.walletDeltaSol >= 0 ? '+' : ''}${r.walletDeltaSol} SOL / ${money(r.walletDeltaUsd)}**) |
| Per-trade realized sum | ${money(r.realizedPnlUsd)} (${r.fillVerifiedLegs} legs on-chain, ${r.estimatedLegs} estimated) |
| Still deployed in open positions | $${openCostUsd.toFixed(2)} across ${r.openPositions.length} position(s) |
${Math.abs(gapUsd) > 1 && r.estimatedLegs > 0 ? `\n> ⚠️ Realized sum differs from wallet delta by ${money(gapUsd)} — ${r.estimatedLegs} leg(s) were quote estimates and open positions still hold cost. Trust the wallet line.\n` : ''}
` : '';

    const playbookRows = Object.entries(r.byPlaybook)
      .map(([pb, v]) => `| ${pb} | ${v.trades} | ${v.wins} | ${v.trades ? ((v.wins / v.trades) * 100).toFixed(0) : 0}% | ${money(v.pnlUsd)} |`)
      .join('\n') || '| — | 0 | 0 | 0% | $0.00 |';

    const exitRows = Object.entries(r.byExitReason)
      .sort((a, b) => b[1].pnlUsd - a[1].pnlUsd)
      .map(([reason, v]) => `| ${reason} | ${v.count} | ${money(v.pnlUsd)} |`)
      .join('\n') || '| — | 0 | $0.00 |';

    const rejectRows = r.topRejectionReasons
      .map(x => `| ${x.reason} | ${x.count} |`)
      .join('\n') || '| — | 0 |';

    return `# Run Report — ${r.runId}

**Mode:** ${r.tradingMode.toUpperCase()} · **Leniency:** ${r.leniencyMode.toUpperCase()} · **Duration:** ${dur}
**Started:** ${new Date(r.startedAt).toISOString()}
**Ended:** ${new Date(r.endedAt).toISOString()}
${r.walletAddress ? `**Wallet:** \`${r.walletAddress}\`` : '**Wallet:** none (paper trading)'}
**SOL price used:** $${r.solPriceUsd}

${groundTruth}## Trade ledger

Every closed leg, in order. "on-chain" means quantities and P&L come from the
transaction's actual balance changes; "estimate" means quote-based.

| # | Token | Bought | Qty sold | Sold | Cost | Proceeds | P&L | Basis | Exit reason |
|---|---|---|---|---|---|---|---|---|---|
${ledgerRows}

${r.openPositions.length ? `### Still holding at run end

| Token | Bought | Qty held | Cost | Unrealized | Fill | Mint |
|---|---|---|---|---|---|---|
${openRows}
` : ''}## Headline

| Metric | Value |
|---|---|
| Realized P&L | ${money(r.realizedPnlUsd)} (${r.realizedPnlSol >= 0 ? '+' : ''}${r.realizedPnlSol} SOL) |
| Unrealized P&L | ${money(r.unrealizedPnlUsd)} |
| Fees paid | ${money(-Math.abs(r.totalFeesUsd))} |
| Bankroll | $${r.startingBankrollUsd.toFixed(2)} → $${r.endingBankrollUsd.toFixed(2)} |
| ROI | ${pct(r.roiPct)} |
${r.walletAddress ? `| Wallet SOL | ${r.startingWalletSol} → ${r.endingWalletSol} |\n` : ''}| Win rate | ${r.winRatePct}% (${r.winCount}W / ${r.lossCount}L) |
| Avg hold | ${Math.floor(r.avgHoldSeconds / 60)}m ${r.avgHoldSeconds % 60}s |

## Screening funnel

| Stage | Count |
|---|---|
| Tokens seen | ${r.tokensSeen} |
| Passed filter | ${r.tokensPassed} |
| Rejected | ${r.tokensRejected} |
| Pass rate | ${r.passRatePct}% |
| Positions opened | ${r.positionsOpened} |
| Positions closed | ${r.positionsClosed} |
| Still open | ${r.positionsStillOpen} |

### Top rejection reasons

| Reason | Count |
|---|---|
${rejectRows}

## By playbook

| Playbook | Trades | Wins | Win % | P&L |
|---|---|---|---|---|
${playbookRows}

## By exit reason

| Reason | Count | P&L |
|---|---|---|
${exitRows}

## Notable trades

${r.bestTrade ? `- **Best:** $${r.bestTrade.symbol} ${money(r.bestTrade.pnlUsd)} (${pct(r.bestTrade.pnlPct)}) — \`${r.bestTrade.mint}\`` : '- No trades closed.'}
${r.worstTrade ? `- **Worst:** $${r.worstTrade.symbol} ${money(r.worstTrade.pnlUsd)} (${pct(r.worstTrade.pnlPct)}) — \`${r.worstTrade.mint}\`` : ''}
`;
  }
}

export const reportService = new ReportService();
