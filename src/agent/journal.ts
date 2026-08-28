/**
 * The agent's journal — one JSONL line per decision, review, fill and exit.
 *
 * WHY ITS OWN FILE AND NOT latencyTimeline: the engine's timeline is keyed by
 * mint and a second begin() OVERWRITES the in-flight record, so sharing it
 * would corrupt the sniper lane's rows. And the corpus analysis this week
 * showed exactly what an under-written journal costs: 164 passed_no_buy rows
 * with no reason, undiagnosable forever. This journal's rule is the opposite:
 * EVERY event writes a row, refusals and rate-limit drops included, because
 * the rows you skip are always the rows you later need.
 *
 * Writes go through installPath() so Electron/Task Scheduler runs land in the
 * data dir, not cwd. A synchronous flush is registered on process exit — the
 * last trade before a crash is precisely the row that matters most.
 */

import fs from 'fs';
import path from 'path';
import { installPath } from '../services/installPaths';

export type JournalEvent =
  | 'candidate_seen' | 'triage_ranked' | 'triage_dropped' | 'screen_rate_limited'
  | 'decision' | 'broker_refusal' | 'buy_filled' | 'buy_failed'
  | 'exit_action' | 'exit_filled' | 'exit_failed'
  | 'review' | 'review_exit_refused' | 'reshape'
  | 'sensor_dark' | 'halt' | 'boot' | 'shutdown';

export class AgentJournal {
  private stream: fs.WriteStream;
  private pending: string[] = [];
  public readonly file: string;

  constructor(runDay = new Date().toISOString().slice(0, 10)) {
    this.file = installPath(path.join('reports', `agent-lane-${runDay}.jsonl`));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    // Synchronous last-gasp flush. appendFileSync, not the stream — the stream's
    // buffer is lost on process exit, and this hook may be the only chance.
    process.on('exit', () => {
      if (this.pending.length) {
        try { fs.appendFileSync(this.file, this.pending.join('')); } catch { /* dying anyway */ }
      }
    });
  }

  public write(event: JournalEvent, data: Record<string, unknown>): void {
    const line = JSON.stringify({ at: Date.now(), event, ...data }) + '\n';
    this.pending.push(line);
    this.stream.write(line, () => {
      const i = this.pending.indexOf(line);
      if (i >= 0) this.pending.splice(i, 1);
    });
  }

  public close(): void {
    try { this.stream.end(); } catch { /* shutdown */ }
  }
}
