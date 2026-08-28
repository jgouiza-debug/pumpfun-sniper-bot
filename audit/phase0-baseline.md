# Phase 0 — Sync and baseline

Date: 2026-08-27 ~22:00 EDT · Machine: Windows 11 Home · Node v24.16.0 · npm 11.13.0 · deps installed (package-lock, npm)
Branch: `master` @ `0b19fc5` (v1.0.8, 2026-08-23) — up to date with `origin/master`.
Full raw output: [phase0-baseline.log](phase0-baseline.log).

## 1. Working tree was NOT clean before starting

Four files carry uncommitted changes dated **2026-08-24 13:50** (the day after v1.0.8):

| File | What the change does |
|---|---|
| `src/services/copyTraderService.ts` (+158/−28) | Caps concurrent `getParsedTransaction` calls at 2 (anti-429 storm); skips failed leader txs (`ev.err`); throttles "unreadable tx" feed warnings per leader (6s, unless a position is open); adds `forceClosePosition()` (operator dismiss); skips balance reconcile when the fetch queue is backed up |
| `src/server.ts` (+8) | New endpoint `POST /api/copy/positions/close` (force-close/dismiss) |
| `src/CopyTradingPage.tsx` (+38) | ✕ dismiss button per position; 5s rolling console-wipe display |
| `dist-exe/pumpfun-sniper-bot.exe` | Rebuilt binary including the above |

These are coherent, finished-looking changes that were never committed. **Nothing was discarded or stashed** — they are preserved as-is.

## 2. Upstream: a second, divergent lineage appeared TODAY (highest-priority Phase 0 finding)

`git fetch` brought in **11 new commits on `origin/main`** — all authored **today, 2026-08-27, 14:50–16:26 EDT**, by a second identity of the owner ("Jad G" / dufleuvecontact@gmail.com; local commits are "jgouiza"). Tags **v1.0.9, v1.0.10, v1.1.0** now exist upstream.

- Fork point: `8841413` ("Open as a desktop app window…"). Since then: **master has 24 commits** (all of v1.0.3→v1.0.8: copy-sell fixes, gas economics, leader-move-as-sell, plus the entire proof-test suite, guardrails, position store, leader-tx classifier, pump event decoder), **main has 11** (updater/release-workflow fixes, HEADLESS mode, external-sell detection, 1-buy-per-token limit, DISCARD action, auto-shutdown-on-tab-close, v1.1.0).
- Relative to master, the main lineage is **missing ~4,800 lines** including `src/tests/*` (the whole proof suite), `guardrails.ts`, `positionStore.ts`, `walletLogWatcher.ts`, `leaderTxClassifier.ts`, `pumpEventDecoder.ts`, `copyExitPolicy.ts`, `fileLogger.ts`.
- The two lineages implemented **overlapping features independently** (main's "DISCARD action" ≈ master's uncommitted `forceClosePosition`; main's "full exit on leader sell" ≈ master's v1.0.8).
- **Risk**: `updaterService.ts` pulls GitHub releases. The upstream release channel now advertises **v1.1.0 from the main lineage** — an auto- or prompted update would silently replace a v1.0.8 install with a build that lacks master's Aug-23 copy-trade fixes and its guardrail/test infrastructure. Which lineage is canonical is an **owner decision**; until then, all work in this engagement stays on `master` and is **not pushed**.

`git pull` on the current branch was a no-op (master == origin/master).

## 3. Secrets check (guardrail #1) — no P0 incident

- `git ls-files` and full history: **no `.env`, wallet file, or key material ever committed**. `.gitignore` covers `.env`, `.photon-wallet.json`, `.api-keys.json`, `.api-token`, `flags.json`, `.copy-trader.json`, `dist-exe/`.
- Local `.env` contains exactly one variable, `HELIUS_API_KEY` (value not read).
- **No wallet key exists on this machine** (`.photon-wallet.json` absent, `PHOTON_PRIVATE_KEY` unset) → nothing run during this engagement can sign a transaction. Guardrail #3 (no live trading) is structurally satisfied here.

## 4. Build / tests / smoke run — all green

- `npm run build` (vite + tsc): **exit 0**, no warnings beyond an npm-update notice.
- `npm run test:all` (proof suite + filter proofs + guardrail proofs + copy sell drill + copy gas sim): **exit 0** — 19/19 guardrail proofs, 9/9 gas-sim, all drills pass.
- Headless smoke boot (`SNIPER_NO_WINDOW=1 PORT=3901 npm run dev`): clean startup, Helius key loaded, UI served, API answers with bearer auth; copy-trader `enabled:false, tradingMode:"paper"`, wallet `linked:false`; live SOL price fetched. Shut down cleanly after probing.

## 5. Bug reproduction status

Nothing reproduces on this machine in the default (keyless, paper) state — the dev-environment failure modes are already fixed or not triggerable without live keys/traffic. The owner's actual runtime failures, reconstructed from history and prior session titles, are:

1. **Copy trader not selling** — root-caused and fixed on master in v1.0.7 (exit gas reservation) and v1.0.8 (leader token *moves* classified as sells). Fixed *differently* on the main lineage today (external-sell detection, full-exit-across-positions).
2. **"RPC stays down" with valid credentials** — previously audited in `docs/research/audit-2026-08-17-rpc-stays-down.md`; runtime RPC failover remains **not implemented** (confirmed deferred in the Phase C doc).
3. **Updater failures** (GitHub 403 rate-limit, `getCurrentVersion`) — fixed only on the main lineage today; **still present on master**.

## 6. Standing prior work this engagement must not contradict

`docs/research/` already contains a completed audit→research→harden→decide cycle (2026-08-20/21): full-system audit, red-team (phase B), hardening with proofs (phase C), a results review over 298 collected price paths (phase D), and a **go/no-go decision: NO EDGE — do not run the sniper lane with money**, plus pre-committed `KILL-CRITERIA.md`. Owner-confirmed positions (memory + docs): hold-biased exits, advisory-only size gates, launchSnipe lane without pre-entry RugCheck are **deliberate choices, not bugs**. The fresh Phase 1 audit below treats them as such.

## Environment summary

| Item | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node / npm | v24.16.0 / 11.13.0 |
| Package manager | npm (package-lock.json) |
| Key deps | @solana/web3.js 1.98.x, express 4.21, ws 8.18, axios 1.8, react 19, vite 6, TS 5.8 |
| Packaging today | `@yao-pkg/pkg` single-file exe (win x64 node18; mac targets node22), auto-launches a Chromium `--app=` window |
| Test entry | `npm run test:all` (5 ts-node suites) |
