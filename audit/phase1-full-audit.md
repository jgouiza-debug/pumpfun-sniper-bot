# Phase 1 — Full system audit

Date: 2026-08-28 · Scope: working tree at `master` @ `0b19fc5` (v1.0.8) **including the uncommitted Aug-24 changes** on `copyTraderService.ts`, `server.ts`, `CopyTradingPage.tsx`. Method: 8 domain-specialist read-only passes over the whole `src/` tree, each finding then adversarially verified against the actual code. **45 findings survived verification (1 Critical, 7 High, 21 Medium, 16 Low); 0 were refuted.** Two findings were re-rated by the verifier (Helius-key-in-history High→Medium — it's an RPC credential with no signing power; no-RPC-failover Medium→ up-rated). Machine-readable set: `audit/.phase1-findings.json`.

Cross-reference: this supersedes `docs/research/audit-2026-08-20-phase1-full-system.md`. "still_open" below means the earlier audit flagged it and it remains unfixed. Owner-intentional behaviors (hold-biased exits, advisory size gates, launchSnipe skipping RugCheck, the sniper's NO-EDGE expectancy) were treated as decisions, not bugs, and are not reported.

---

## CRITICAL

### C1 · A v1.1.0 release from `origin/main` silently downgrades every live install, stripping all copy-trade hardening while presented as an upgrade
`src/services/updaterService.ts:217` · category: supply-chain / correctness · status: **new**

The in-app updater polls this repo's `releases/latest` and self-swaps the running exe whenever the release tag is numerically greater than the local version (`isVersionGreater`, `updaterService.ts:217/267`); `App.tsx:353-357` auto-checks on mount and every 300s and shows a one-click Update button. `master` is `1.0.8`; `origin/main` is `1.1.0` (tag `v1.1.0` → commit `e828d08`). `origin/main` forked at `8841413` and is **missing master's v1.0.3–v1.0.8 work** — confirmed absent on main: `guardrails.ts`, `positionStore.ts`, `leaderTxClassifier.ts`, `pumpEventDecoder.ts`, `copyExitPolicy.ts`, `walletLogWatcher.ts`, and in `copyTraderService.ts` the gas-float reserve and leader-move-as-sell logic. main's copy trader reverts to raw `heliusConn.onLogs` (the subscription `walletLogWatcher` was written to replace precisely because it never detects a dead socket).

**Impact:** an operator on v1.0.8 sees "Update available: v1.1.0", clicks it (the checksum verifies because the release workflow publishes the matching `.sha256`), and is relaunched into a build that regresses every copy-trade safeguard at once: copy-buys airdrops/dust and copy-sells on a mere bag-move again (the 2026-08-23 bugs, [[copy-trader-gas-economics]]); a copy buy can overdraft so the exit sell has no gas (the v1.0.7 failure); leaders who exit by *moving* their bag (cupsey) are never detected as sells; the wallet feed can die silently while the UI still reads "ON-CHAIN OK"; no crash recovery. **Trading looks alive and "newer" while its funds-protection was deleted.**

**This is the headline decision of the whole engagement and it is yours to make** (which lineage is canonical). The fix is not primarily code: either never publish a release from the main lineage and cut the next release from master with a version > 1.0.8 that *contains* the hardening, or merge master's v1.0.3–v1.0.8 work into main before any v1.1.0 asset ships. Code-level belt-and-suspenders (C1↔H6): make the updater refuse a feature-set downgrade and stop mislabeling a hash check as a signature check (see H6).

---

## HIGH

### H1 · Signed transactions from PumpPortal are never verified against intent before signing/broadcast
`src/services/sniperEngine.ts:1562` · security / tx-construction · **still_open (never addressed)**

The live path POSTs to `pumpportal.fun/api/trade-local`, deserializes the returned bytes into a `VersionedTransaction`, calls `tx.sign([keypair])` and `sendRawTransaction(..., {skipPreflight:true})` — **with nothing between deserialize and sign inspecting the message.** No check that the fee payer is our wallet, that instructions target only the pump program and expected mint, that amounts match `solAmount`/`maxSolCost`, or that there is no extra SystemProgram transfer / token `setAuthority` to a third party. `skipPreflight:true` also removes the simulate that might catch it. The one structural check (`localTxBuilder.shadowCompare`) runs fire-and-forget *after* submission and only when a flag is on.

**Impact:** a malicious or compromised PumpPortal response, or a successful MITM of that HTTPS hop, returns a transaction the wallet blindly signs and broadcasts — e.g. a transfer of the whole balance. Since the same wallet builds 100% of buys and sells this way, one hostile response drains the linked wallet. **Fix:** before `tx.sign`, assert fee-payer == our pubkey, every writable-signed account is ours, the pump instruction targets `mint`, amounts match intent, and reject any unexpected transfer/approve/setAuthority. The verify machinery already exists in `localTxBuilder.describe()` — call it synchronously as a fail-closed gate.

### H2 · Failed manual LIQUIDATE marks a REAL position CLOSED and zeroes `tokensHeld`, orphaning tokens still in the wallet
`src/services/copyTraderService.ts:1662` · copy correctness · **new (in the uncommitted Aug-24 code)**

In `runExit`, when `executeRealSell` returns `null` on a manual liquidation it now sets `pos.status='CLOSED'; pos.tokensHeld=0` and books a "closed after external exit" record. But `executeRealSell` returns `null` after `COPY_SELL_MAX_ATTEMPTS` **on-chain failures** (slippage 6004, reject, timeout) — in every one of those the tokens were **not** sold and remain in the wallet. The code assumes `null` means "already gone externally"; it overwhelmingly means "the sell failed and the bag is still held."

**Impact:** operator presses LIQUIDATE, the venue is briefly illiquid / RPC is storming, all attempts fail → the bot marks it CLOSED, drops it from persistence, stops watching it, and books a fake sell. The real tokens ride to zero unattended while the operator believes they exited. This reintroduces the exact stranded-bag failure the rest of the file guards against. **Fix:** only auto-close after confirming the on-chain token balance for `pos.mint` is ~0; otherwise keep the position OPEN and surface the failure, and keep the explicit "dismiss already-liquidated" action (`forceClosePosition`) separate.

### H3 · Unsigned-PumpPortal dedup keys off the GLOBAL `isHealthy()` and is never checked by the fast/normal Helius paths → duplicate real buys/sells
`src/services/copyTraderService.ts:1111` · copy correctness · **new**

When a PumpPortal payload has no signature, `handlePumpPortalMessage` decides whether to execute solely from `if (this.logWatcher?.isHealthy() ?? false) return;`. `isHealthy()` returns false if **any** tracked subscription is unacked (it loops all subs). On add-wallet, existing subs stay live and keep delivering while the new sub is unacked — so `isHealthy()` is false even though the trading leader's own sub is live. The `unsignedCopies` guard is consulted **only** on the 20s retry path; `handleFastLog` and the normal dispatch never check it.

**Impact:** in any window where a leader's sub is live but another wallet's is momentarily unacked (add-wallet, multi-wallet startup ramp), an unsigned PumpPortal buy/sell executes as "sole source," and Helius then *also* delivers the same pump.fun tx via the fast lane (which has no `unsignedCopies` check) and executes it again → a duplicated real BUY (doubles intended size) or SELL (oversell). Signature dedup can't catch it because the PumpPortal leg had no signature. **Fix:** gate the unsigned fallback on a **per-leader** liveness check, and consult `unsignedCopies` in `handleFastLog` and the normal dispatch, not only the retry branch.

### H4 · Migration entries act on a fabricated liquidity constant with no on-chain pool verification
`src/services/sniperEngine.ts:2061` · sniper correctness · **still_open (Phase B DIE-class)**

For a migrate event whose DexScreener pool hasn't indexed, the engine sets `liquidityUsd = 2*79*solPrice` and `liquidityIsAsserted=true`. The comment says everything treating liquidity as evidence "must consult `liquidityIsAsserted` first" — but that flag is **never read again**. `routePlay` applies the Play-3 liquidity floor to the fabricated ~$12.5k number blind, and nothing does a `getAccountInfo` on the pump-amm pool to confirm it exists, is AMM-owned, or holds reserves. The entire migration decision rests on one `pool` string from the PumpPortal websocket.

**Impact:** a spoofed migration event, or a real graduation whose LP the deployer pulls in the next slot, passes the floor on the asserted constant and the bot buys into an empty/drained pool — and per H5 the position then has no working drain exit either. **Fix:** before a migration buy, one `getAccountInfo` on the destination pool — confirm existence, AMM ownership, decode real reserves — feed those (not the assertion) to the router floor, and refuse when the pool is unverifiable.

### H5 · `peakLiquidityUsd` is never seeded from on-chain reserves, so the pool-drain exit is blind to a pre-index rug
`src/services/sniperEngine.ts:3763` · sniper correctness · **still_open (Phase B DIE-class)**

`pos.peakLiquidityUsd` is written in exactly one place — the monitor tick, from `dexData.liquidityUsd`, only when `hasPair && liquidityUsd>0`. The position created in `executeBuy` never seeds it, so at entry it's `undefined`; `isPoolDrained` needs `peak >= 2000` to arm, so the first observation can't fire, and if the first DexScreener reading arrives *after* a rug, the drained value becomes the recorded "peak." Pre-migration positions are covered by `CURVE_DRAINED` from on-chain curve reserves; the gap is specifically the **post-migration / Play 3 path — the strategy the bot runs most.**

**Impact:** a token that migrates and has its LP pulled before DexScreener indexes has `POOL_DRAINED` permanently disarmed; with no price stop underneath (owner-intentional) the bag is held to zero. **Fix:** seed `peakLiquidityUsd` at entry from the same on-chain reserve read as H4, so the drain fraction is measured against real graduation depth from tick one.

### H6 · Auto-updater has no code-provenance verification and points at the divergent-lineage repo
`src/services/updaterService.ts:209` · security / supply-chain · **new** · (verifier: severity honest at High — click-gated, not zero-interaction)

`repoOwner/repoName` are hardcoded to `jgouiza-debug/pumpfun-sniper-bot`. `applyUpdate()` downloads the release asset and "verifies" it against a SHA256 fetched from the **same release's own assets** — a self-referential check that proves only that the download matches what that release published, not that the publisher is trusted. There is **no code signing and no pinned key.** The progress string "Verifying signature…" and the "refusing to install an unverified binary" comment misrepresent a hash-equality check as cryptographic provenance.

**Impact:** benign — a click regresses the user onto the divergent lineage (C1). Malicious — a compromised GitHub account publishes a drainer binary + its matching `.sha256`, it passes "verification," and the swap-and-relaunch runs attacker code beside `.photon-wallet.json`. Click-gating (confirm dialog, token-gated POST, mid-trade refusal) is the only reason this isn't a zero-interaction drainer. **Fix:** ship a detached signature (minisign/cosign) over each binary and verify against a public key baked into the build, or pin an allowlist of known-good SHA256s; until the lineage is reconciled, disable self-update or require explicit repo+version+hash confirmation; stop labeling the hash check "Verifying signature." **(Touches the auto-update mechanism — an owner-decision per the engagement guardrails.)**

### H7 · POST `/api/bot/config` response echoes the raw Helius and PumpPortal API keys
`src/services/sniperEngine.ts:736` · security / secret-exposure · **new**

`getConfig()` returns `{ ...this.config, allInSizing }` — and `this.config` holds the resolved raw `heliusApiKey` and `pumpPortalApiKey`. `server.ts:226` sends it verbatim. This violates the module's own invariant: `getStatus()` (line 1282) carefully destructures both keys out and returns only a set/last-4 hint. Exploit chain (independently reconfirmed by me): `GET /api/session-token` is GET-exempt from the token gate (`server.ts:84`) and CORS reflects any loopback origin (`server.ts:63-66`), so **any page served from any localhost port** can read the token, POST an empty body to `/api/bot/config`, and read back both keys — including the funded PumpPortal key the code itself notes "can spend SOL."

**Impact:** another project's dev server, a Jupyter notebook, any local tool with a compromised dependency can exfiltrate the funded PumpPortal key (→ direct fund loss) and the Helius key. High rather than Critical because it needs an attacker already serving a loopback page (`evil.com` is blocked by `originGuard`). **Fix:** return the same sanitized shape `getStatus` builds; give the one internal consumer (`copyTraderService.ts:551`) a dedicated raw-key accessor. **This is the first Phase 3 commit.**

---

## MEDIUM (21) — grouped by domain

**Security / auth boundary**
- **sec-keys-1** — Live Helius key in public git history + a commit message, never rotated (`bd900ed` et al.). RPC credential, no signing power → quota/billing abuse + a stranger can throttle your live-exit RPC path. **Rotate in the Helius dashboard** (I can't; it's a credential action); add a pre-commit secret scan. *(re-rated High→Medium)*
- **sec-keys-3** — `GET /api/session-token` hands the bearer token to any loopback-origin page (`server.ts:76`). Restrict to same-port (Host/Referer check) or drop it and rely on the token injected into the served HTML. Pairs with H7.
- **sec-keys-4** — `.photon-wallet.json` is read/written at `process.cwd()`, not the packaged-exe base dir every other secret file uses (`walletService.ts:26`). A Task-Scheduler/shortcut launch writes the **plaintext signing key** into an unrelated directory and silently fails to auto-load next boot. Use the `isPackaged?execPath:cwd` rule + migrate on startup.
- **sec-rpc-tx-2** — Copy-trade BUY slippage can reach 100%, bypassing the 30% ceiling the engine enforces on its own orders (`copyTraderService.ts:2182`). Clamp copy-buy slippage to 30.
- **sec-rpc-tx-4** — No runtime RPC failover; the `Connection` is resolved once and never fails over on a dead credential/outage (`rpcHealth.ts:300`). *(up-rated)* Rebuild against `SOLANA_RPC_FALLBACK_URL` on latched rejection/failure streak.
- **sec-deps-1** — Release/exe builds still run dependency install scripts (`release.yml:45`, Phase B #9). Add `--ignore-scripts` to both `npm ci` (verified safe: ws addons and esbuild both work without their postinstalls).
- **server-updater-2** — Real-mode double-spend lock keyed on `process.cwd()`, so two instances from different dirs both arm live on the same wallet (`realModeLock.ts:4`). Key on the wallet address or a machine-global path.

**Copy-trade correctness**
- **copy-correctness-3** — `leaderBalances` written by concurrent async paths with no ordering guard; a late reconcile clobbers a newer balance and mis-sizes the next mirror sell (`:814`). Apply only reconciles whose slot ≥ last applied.
- **copy-correctness-5** — Sniper sizing doesn't subtract the copy trader's in-flight buy reservations on the **shared wallet** → joint overdraft (`sniperEngine.ts:2774`). Subtract copy's reserved SOL in the sniper's deployable calc.
- **divergence-3** — PORT from main: own-wallet on-chain balance reconciliation to detect manual/external sells (`eccc9c3`); master never re-reads its own token balances. Port the read, but route the close through master's `runExit` (keep CLOSED-for-history; don't adopt main's array-removal).

**Sniper correctness / reliability**
- **sniper-correctness-3** — A buy unconfirmed within 30s opens a position on *estimated* tokens with no on-chain reconciliation (`:1624`). Verify `tokensHeld` against `getTokenAccountBalance` before treating it as real.
- **sniper-correctness-4** — Runtime RPC failover absent; a Helius outage mid-run leaves the bot unable to price or exit (`:509`). Same fix as sec-rpc-tx-4.
- **sniper-correctness-5** — The sniper's *own* timed-out sell can execute twice; the double-submit guard covers only external/copy callers (`:1624`). Route the own-sell path through `resolveTimedOutSell` too.

**Performance**
- **perf-latency-1** — Dynamic priority fee is p75 of the **global** fee distribution, not the contended pump.fun accounts → underbids the exact races it exists to win (`priorityFeeService.ts:39`). Pass the writable accounts to `getRecentPrioritizationFees`; add a hard cap + fallback (Phase 2 A3).
- **perf-latency-2** — RugCheck reads serialize through one global 500ms chain, no cache, no priority lane → a migration (the trade you'd take) queues behind every create it'll never buy (`rugcheckService.ts:57`). Add a short-TTL per-mint cache + a priority lane.
- **perf-latency-3** — Every real buy/sell pays a PumpPortal `/api/trade-local` HTTP build round-trip on the hot path with a 10s timeout and no fallback (`:1535`). Finish the `localTxBuild` rollout.
- **perf-latency-4** — Copy live-trade fetches share a 2-slot RPC semaphore with fire-and-forget reconciles → a live exit on a non-pump venue can be head-of-line-blocked for seconds (`copyTraderService.ts:264`, the uncommitted Aug-24 code). Give live-trade fetches priority; make reconcile yield when any live fetch is queued.

**Code quality / tests**
- **quality-tests-1** — `maxConsecutiveTxFailures` is a decorative config field — never applied to the breaker; the failure log misreports the trip point (`:3391`). Add `FailureBreaker.setMax()`, re-read it in the entry guard, and strengthen the test to prove the value *drives* the trip.
- **quality-tests-2** — The live-money copy execution paths (real-mode sizing, the new 429 throttle, blockhash-expiry double-sell guard, redelivery dedup) have **no executing test** (`:1322`). Extend `copySellDrill` with a `real`-mode pass + the specific drills.
- **clampConfig / quality-tests-3** *(Low, listed here for grouping)* — omits several risk-bearing fields its docstring claims to clamp.

---

## LOW (16) — batched

| ID | File | One-line fix |
|---|---|---|
| sec-keys-5 | `.gitignore` | Add `bot.log`, `bot.log.*` (console tee, public repo). |
| sec-keys-6 | `sniperEngine.ts:1402` | Delete dead `getKeypairFromPrivateKey` (dupes `parseSecret`). |
| sec-deps-2 | `package-lock.json` | uuid 8.3.2 advisory via web3.js→jayson: accept/monitor, do **not** `audit fix --force`. |
| sec-deps-3 | `package-lock.json` | `npm update nanoid` (devDeps only, trivial). |
| sec-deps-4 | `package.json:31` | pkg targets say node18 but `--targets host` embeds node24; bump/relabel. |
| sec-rpc-tx-3 | `rpcHealth.ts:327` | `rpcWsEndpoint` ignores `SOLANA_RPC_URL`, splits providers. |
| copy-correctness-4 | `copyTraderService.ts:456` | `forceClosePosition` (✕) abandons a real bag with no balance check. |
| copy-correctness-6 | `:1536` | Second leader's sell mirrors against another leader's position. |
| copy-correctness-7 | `:814` | `leaderBalances` map grows unbounded. |
| sniper-correctness-6 | `sniperEngine.ts:3334` | `markCleanShutdown` is dead → every restart falsely reports a crash. |
| sniper-correctness-7 | `:1792` | `migrationSeenAt` map grows unbounded. |
| server-updater-3 | `server.ts:702` | Window-close / shutdown bypass the mid-trade guard, stranding positions. |
| server-updater-4 | `reportService.ts:5` | Reports written to `cwd()/reports`, scatter on foreign cwd. |
| quality-tests-3 | `sniperEngine.ts:796` | `clampConfig` omits fields its docstring claims. |
| quality-tests-4 | `copyTraderService.ts:456` | Dismiss books a synthetic sell that pollutes win-rate stats. |
| divergence-2 | `server.ts:331` | **AVOID** porting main's tab-close auto-shutdown (kills engine, strands positions). |
| divergence-4/5 | `updaterService.ts` | PORT from main: updater `GITHUB_TOKEN`/403 handling + `getCurrentVersion` re-read. |

---

## Audit summary by the task's four categories

- **Security** — the serious cluster. Direct fund-loss vectors: H1 (unverified PumpPortal tx), H7 (config key echo), C1/H6 (updater). Key-at-rest and secret-hygiene: sec-keys-1/3/4. All the RPC/tx findings confirmed. No committed *wallet* key; the committed Helius key is a rotate-now RPC credential.
- **Correctness / reliability** — H2/H3 (copy-trade orphan + duplicate execution), H4/H5 (migration entry & drain-exit blind to on-chain truth), plus the timeout/reconciliation and RPC-failover Mediums. Several are the same Phase B DIE-class items still open.
- **Performance** — priority-fee bidding on the wrong distribution, RugCheck head-of-line blocking, the remote build round-trip, and the new copy semaphore's head-of-line risk. All bounded, all fixable.
- **Code quality** — decorative config fields, unclamped inputs, dead code, unbounded maps, and — most important — **no executing test on the live-money copy paths**, which is why the Aug-24 regressions (H2) shipped uncommitted without a proof catching them.

## Recommended Phase 3 order

1. **H7** (config key echo) — mechanical, matches `getStatus`, first commit.
2. **H1** (PumpPortal intent verification) — highest fund-loss leverage.
3. **H2, H3** (copy orphan + duplicate exec) — live-money lane, in the uncommitted code.
4. **H4 + H5 together** (on-chain pool read seeds both the entry floor and the drain peak).
5. Mediums by domain; Lows batched; add the missing copy-path tests (quality-tests-2) alongside each fix.
6. **C1 / H6** (updater/lineage) — **needs your decision first** (see the questions accompanying this report); I'll implement the belt-and-suspenders guard regardless of which lineage you pick.
7. Fold in the Phase 2 "adopt" list — the honest `simulateTransaction` paper mode is the biggest single quality win and the prerequisite for a trustworthy 30-day paper run.
