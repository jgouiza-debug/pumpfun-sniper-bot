# Phase 3 — Fix & rebuild changelog

Branch: `audit/phase3-hardening` off `master` @ `0b19fc5`. **19 commits, not pushed.** Every fix is a separate commit with its own proof; the full suite (`npm run test:all`) is green after each: **385 unit + 20 guardrail + 35 copy-sell drill + 9 gas-sim**, up from 378/19/9 at baseline (net +30 tests, all for these fixes).

Live-funds safety held throughout: no key ever handled, all work against the keyless paper/dev state, nothing pushed. The standing **NO-EDGE / paper-only** decision is unchanged — these fixes make the bot safer and honestly measurable, they do not re-enable live trading.

## Finding → commit map

| Finding | Sev | Commit | What changed |
|---|---|---|---|
| **C1** divergent-lineage updater clobber | Critical | `e6aa80b` | Updater refuses a release whose commit doesn't descend from this build (GitHub compare); build commit baked in CI |
| **H1** unverified PumpPortal tx signed | High | `4d636ed` | `txIntentGuard.assertOutboundTradeTx` gates the single sign site; fails closed on drain shapes; +7 tests incl. the old drain case |
| **H2** failed LIQUIDATE orphans a real bag | High | `c299e7d` | On-chain balance check before close; keeps the position unless the wallet is confirmed empty |
| **H3** duplicate unsigned-PumpPortal copies | High | `7aafe18` | Per-leader liveness gate + `unsignedCopies` consulted on every Helius delivery path |
| **H4** migration entry on fabricated liquidity | High | `5015ae9` | `routePlay` refuses the floor on `liquidityIsAsserted` |
| **H5** drain-peak never seeded from reserves | High | `5015ae9` | `peakLiquidityUsd` seeded at entry from measured liquidity |
| **H6** updater has no provenance, mislabels hash | High | `e6aa80b` | Lineage guard + "Verifying checksum" (not "signature"); ported main's GITHUB_TOKEN/403 + getCurrentVersion |
| **H7** config endpoint echoes raw keys | High | `56ea1b9` | Single `getPublicConfig()` sanitizer shared by status + config-save; verified at runtime |
| sec-deps-1 release runs install scripts | Med | `46817be` | `npm ci --ignore-scripts` in CI |
| sec-keys-4 wallet key at `cwd()` | Med | `628c869` | `installPaths` exe-relative rule + migration |
| server-updater-2 real-mode lock at `cwd()` | Med | `628c869` | Lock moved machine-global (`os.tmpdir()`) |
| server-updater-4 reports at `cwd()` | Med | `628c869` | Reports exe-relative |
| sec-rpc-tx-2 copy buy slippage to 100% | Med | `38ae1d0` | Copy buys clamped to 30% |
| quality-tests-1 breaker cap decorative | Med | `38ae1d0` | `FailureBreaker.setMax` re-read each entry; proof it drives the trip |
| perf-latency-1 fee off global distribution | Med | `bfa3e26` | Fee sample scoped to the pump.fun program |
| sniper-correctness-5 sniper double-sell | Med | `487b755` | Timed-out sell resolved before any retry |
| sec-rpc-tx-4 / sniper-correctness-4 no RPC failover | Med | `50bbc27` | Runtime failover to backup endpoint + retry-primary timer; +test |
| sec-rpc-tx-3 WS ignores SOLANA_RPC_URL | Low | `50bbc27` | `rpcWsEndpoint` follows the same precedence |
| copy-correctness-3 leaderBalances race | Med | `a3b97e7` | Slot-ordered writes via `setLeaderBalance` |
| copy-correctness-7 leaderBalances unbounded | Low | `a3b97e7` | Zero-drop + 500-key cap |
| sec-keys-3 session-token to any loopback page | Med | `6874c6a` | Endpoint disabled in the packaged build |
| perf-latency-4 copy fetch head-of-line block | Med | `6874c6a` | Priority queue: live classification jumps reconcile |
| copy-correctness-5 shared-wallet overdraft | Med | `66ba350` | Sniper subtracts copy's in-flight (registered provider) |
| sniper-correctness-6 false crash on restart | Low | `65bf98c` | `markCleanShutdown` on every real exit path |
| sniper-correctness-7 migrationSeenAt unbounded | Low | `65bf98c` | 10-min sweep |
| server-updater-3 exit paths bypass guard | Low | `65bf98c` | `gracefulShutdown` logs stranded positions |
| copy-correctness-4 unsafe ✕ dismiss | Low | `6b0308f` | Balance check + loud warning before honoring dismiss |
| quality-tests-4 dismiss pollutes win rate | Low | `6b0308f` | `dismissed` flag excluded from stats |
| quality-tests-3 clampConfig gaps | Low | `6b0308f` | Guardrail caps added to the bands |
| sec-keys-5/6, sec-deps-3/4 | Low | `f2398b7` | gitignore bot.log, delete dead parser, nanoid bump, pkg target relabel |
| divergence-4/5 port updater fixes | Low | `e6aa80b` | GITHUB_TOKEN/403 + getCurrentVersion ported to master |
| divergence-2 avoid tab-close shutdown | Low | — | **AVOID** (no port); noted in Phase 1. Superseded by `gracefulShutdown` gated on the restart guard |
| baseline (operator WIP) | — | `e3a3269` | Captured the uncommitted Aug-24 work verbatim before the fix series |

## Phase 2 "adopt/adapt" folded in

- **A3 priority-fee hard cap + fallback** — already present; the missing piece (account-scoped percentile) landed in `bfa3e26`.
- **A4 circuit breaker pauses entries** — the existing `FailureBreaker` now honors its config (`38ae1d0`).
- **B5 runtime failover / reconnect** — `50bbc27` (sniper connection); a Geyser-feed reconnect is future work.
- **Pre-sign verification** — H1's `txIntentGuard` is our own take on the "verify the tx you sign matches intent" discipline.

## Copy-trade specifics (task item 3) — status

- **Subscriptions over polling**: already `logsSubscribe` (copy) + PumpPortal ws (sniper); Geyser is a documented future lane.
- **Duplicate-trade protection**: H3 (`7aafe18`) — per-leader liveness + cross-path dedup; signature dedup already existed.
- **Configurable filters**: `minLeaderBuySol` (min trade size), `blockRepeatBuys` / `maxOpenPositions` (1-buy-per-token), and now a hard **max copy-buy slippage** (`38ae1d0`) all exist. A token allowlist/denylist is **not yet implemented** — see below.

## Deliberately deferred, with rationale (honest)

These were assessed and consciously left for a later pass; none is a live-funds risk in the paper-only posture.

- **perf-latency-3 — finish the localTxBuild rollout** (Med). `localTxBuild` is a flag that only engages after in-session shadow-parity data confirms the local build matches trade-local; flipping it without that data is exactly the failure mode its guard exists to prevent. It needs a shadow-logging run to collect parity, then enabling — a data-gathering task, not a code edit. The HTTP build-hop remains a fallback meanwhile.
- **perf-latency-2 — RugCheck per-mint cache + priority lane** (Med). A latency/throughput refinement on the screening path; no correctness impact. Worth doing before a live run, straightforward.
- **divergence-3 — periodic own-wallet reconciliation loop** (Med). The *mechanism* (`getOwnedTokenAmount`) landed with H2 and is used at the decision points that matter (failed liquidation, dismiss). A always-on background reconcile that auto-registers manual external sells is the remaining half; deferred to avoid a steady RPC cost on a paper-only bot.
- **sniper-correctness-3 — verify tokensHeld on a buy timeout** (Med). Partially mitigated by H5's on-chain awareness and the existing crash-recovery `needsReconciliation`; a full post-timeout `getTokenAccountBalance` reconcile pairs naturally with divergence-3's loop.
- **copy-correctness-6 — one position per (leader, mint)** (Low). A deliberate model choice, not a bug: master keeps one position per mint. Re-keying to `(leader, mint)` is a data-model change with migration implications; documented as the intended behavior rather than churned.
- **Token allowlist/denylist for copy** (task item 3). Not yet implemented; the min-size, repeat, slippage, and venue filters cover the immediate safety needs. A denylist (e.g. stablecoins, known-scam mints) is a clean follow-up.

## Test harness expansion (task item 4)

Every fix ships a proof, and the money-path suites grew accordingly: `txIntentGuard` (7 drain-shape tests), `copySellDrill` sections 7–9 (failed-liquidation, per-leader dedup, slot-ordering — the live-money copy paths the audit flagged as untested, quality-tests-2), the RPC-failover drill, and the breaker-config proof. The harness now validates the exact behaviors that previously shipped only against real money.
