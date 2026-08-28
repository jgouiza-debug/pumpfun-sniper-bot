# Phase 2 — Competitive research (read-only, sandboxed)

Date: 2026-08-28 · Method: static source review via GitHub web/raw only. **No repo was cloned, installed, or executed; no repo was given an RPC endpoint or any wallet.** Every repo was treated as hostile until its key-handling code was read.

## How the field was filtered

Scouting surfaced ~22 candidates across snipers, copy-traders, and execution infra. The overwhelming majority of "free Solana sniper bot" repos **failed the bars or showed active malware-distribution tells** and were excluded from deep review:

| Repo | Why excluded |
|---|---|
| `MortarStallionMarina/Solana-PumpFun-Sniper-V2` | **README tells users to disable antivirus** — a hallmark of drainer distribution. Hard avoid, not reviewed. |
| `cutupdev/Solana-Copytrading-bot`, `Immutal0/Solana-CopyTrading-Bot`, `justFiveDev/...` | Ship a **precompiled binary in-repo** / empty commit history / shared "hire-me" README template across a bot-farm ring. Never run. |
| `coffellas-cto/Solana-Copy-Trading-Bot`, `DeFiCryptoBots/...` | No sim mode; keyword-stuffed marketing shells; real logic gated behind an external paid download (unauditable). |
| `1fge/...`, `TreeCityWes/...`, `handi-cat`, `outsmartchad/...` | Abandoned (2024–early-2025) or no dry-run mode — fail the recency/sim bars. |

Six repos passed the bars **and** had clean key handling on the code actually read (private key stays in-memory, never logged/serialized/network-sent; no pre/postinstall hooks; readable source, not dist-only). None showed a drainer path. These got deep review:

| Repo | Type | Maintained | Real sim mode? | Malicious |
|---|---|---|---|---|
| [chainstacklabs/pumpfun-bonkfun-bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot) | pump.fun/bonk sniper (Py) | ✅ 2026-08-24, ~972★ | ✅ `simulateTransaction` harness | No |
| [chainstacklabs/pump-fun-bot](https://github.com/chainstacklabs/pump-fun-bot) | pump.fun sniper + copy example (Py) | ✅ 2026-08-24, 288+ commits | ✅ live-state sim | No |
| [gianlucamazza/solana-mmaker](https://github.com/gianlucamazza/solana-mmaker) | Jupiter market-maker (TS) | ✅ 2026-07-06 | ✅ **default-on** fail-closed sim | No |
| [bigmacman1129/solana-sniper-trading-mev-bot](https://github.com/bigmacman1129/solana-sniper-trading-mev-bot) | warp-id-derived sniper (TS) | ✅ 2026-08-25, 142★ | ✅ DRY_RUN + pre-send sim | No |
| [bitman09/pumpfun-sniper-bot](https://github.com/bitman09/pumpfun-sniper-bot) | pump.fun sniper (TS) | ⚠️ 2026-05-20 (marginal) | ✅ SIMULATION_MODE (footgun default) | No |
| [rpcpool/yellowstone-grpc](https://github.com/rpcpool/yellowstone-grpc) | Geyser gRPC infra (Rust/TS) | ✅ 2026-08-25, 992★ | N/A (data plane) | No |

> Note on our own bot: the `bigmacman` repo is a fork of the same warp-id lineage our codebase descends from, so several of its patterns are cousins of ours — useful for confirming we're not behind on fundamentals, and for the few places it pulled ahead.

## What they do better than us (specific mechanisms, cross-confirmed)

Five techniques showed up **independently in multiple legitimate repos**, which is the strongest signal:

1. **Honest `simulateTransaction` paper mode** — *(both chainstack bots, solana-mmaker, bigmacman)*. Build the **real** buy/sell tx through the live builder, call `simulateTransaction(tx,{sigVerify:false, replaceRecentBlockhash:true})`, read `value.err` and `value.unitsConsumed`, and **never broadcast**. Price comes from real on-chain reserves, **no RNG**. This is the direct cure for our paper mode's fictional +40%/min drift and the +$3,331 fantasy report ([[sniper-paper-vs-real]]). solana-mmaker's is *default-on and fail-closed*: `ENABLE_TRADING==='true'` is the only thing that trades; anything else simulates with a loud warning.

2. **Geyser / Yellowstone gRPC detection feed** — *(both chainstack bots, bitman09, yellowstone itself)*. A first-party on-chain `transactionSubscribe` with `account_include` on the pump program (sniper) or leader wallets (copy), at `processed` commitment. Lower latency than our PumpPortal-ws + Helius `logsSubscribe`, which is our single biggest detection gap. yellowstone-grpc is the reference client to *consume*, not reimplement (it also ships server-side account-set filters, token-owner "balance-changed" subscriptions, and reconnect-with-slot-replay).

3. **Blockhash-expiry-aware sender** — *(solana-mmaker has a working one; everyone else shares OUR gap)*. Capture `lastValidBlockHeight` from the same `getLatestBlockhash` used to sign; send with node retries disabled; self-rebroadcast on an interval; poll `getSignatureStatuses`; and treat `getBlockHeight() > lastValidBlockHeight` as a **terminal expired** state. This closes our known unhandled-expiry weakness on the PumpPortal-built path — but the fix must **refetch AND rebuild** the tx on expiry, which none of the copy targets except solana-mmaker actually do.

4. **Priority fee = percentile + hard cap + fallback** — *(bigmacman p75, both chainstack p70)*. We already compute dynamic fees; what we lack is the **explicit `maxMicroLamports` clamp** (so a network fee spike can't set an unbounded tip) and a **defined fallback** when `getRecentPrioritizationFees` fails. chainstack additionally scopes the percentile to the tx's writable accounts.

5. **Anchor `TradeEvent` binary decode for copy classification** — *(chainstack pump-fun-bot)*. Match the `TradeEvent` discriminator in program data, read `is_buy` as a single byte, pull amounts from the fixed binary layout, and **exclude the migrated-AMM program id**. This is exactly the robustness our log-line string classifier lacked — the mechanism behind the cupsey-exit misclassification ([[copy-trader-gas-economics]]).

Secondary, single-source but worth taking: **pre-send simulation gate** (bigmacman `SIMULATE_BEFORE_SEND`), **multi-endpoint submission fan-out / race-first-land** (bigmacman Jito 5-region, bitman09 NextBlock+bloXroute), **background-cached blockhash** paired with a liveness guard (chainstack), **bounded reverted-sell retry that re-prices each loop** (chainstack — confirms our v1.0.7/v1.0.8 direction is right), and **fail-fast numeric config validation** (solana-mmaker `parseNumberEnv` throws instead of coercing NaN).

## What NOT to copy (even from the clean repos)

- **Price-only stop-loss / trailing-stop as defaults** (bigmacman `exit-strategy.ts`, chainstack TP/SL) — violates the owner's hold-biased, evidence+time exit posture ([[meme-bot-risk-posture]], [[sniper-exit-policy-no-stoploss]]). Take at most the *opt-in, off-by-default* take-profit scale-out, wired as an owner toggle.
- **Closed third-party relay + per-tx skim** (bigmacman `warp.id` executor, hardcoded fee-transfer address) — no key leaves the client, but it makes execution depend on a censorship-capable external relay and pays a skim. Keep our direct-RPC/PumpPortal path.
- **Raw private key into third-party SDK constructors** (bitman09 `new HttpProvider(auth, PRIVATE_KEY, …)`) — sign behind our own boundary; hand over only serialized tx bytes.
- **`skipPreflight:true` by default** (bitman09, chainstack) — keep preflight configurable, not forced off, except a separately-measured latency lane.
- **Fixed-amount zero-RPC trade sizing** (chainstack extreme-fast) — the latency idea (skip the pre-buy `getAccountInfo`) is good, but sizing/min-out off a *constant token amount* makes the slippage floor fictional. Derive min-out from listener-delivered reserves instead.
- **Single-quote spot price as a hot-path oracle** (solana-mmaker `getUSDValue`) — a manipulation surface on a sniper; fine only for slow MM valuation.
- **Static priority fee / fixed 250k CU** (bitman09) — a regression from what we already have.
- **`sigVerify:false` anywhere near a real send path** — confine strictly to the sim harness.
- **napi/prebuilt-native addons in the single-file exe** — if we adopt yellowstone's client, pin exact versions + integrity hashes, or prefer an auditable pure-TS `grpc-js` path for the packaged binary.

## Adopt / Adapt / Avoid — the actionable list for Phase 3+

**ADOPT (build in our TS, high value, low risk):**
- **A1.** Replace RNG paper mode with a real `simulateTransaction` harness (our buy/sell builder → simulate → assert `err==null`, record `unitsConsumed`). *Biggest single win.*
- **A2.** Add a **fail-closed top-level LIVE gate**: default paper, must be explicitly enabled, logged loudly at boot, overriding per-feature toggles for both lanes. (Complements the existing real-mode lock; sits above it.)
- **A3.** Add the **priority-fee hard cap + fallback** to our existing fee helper.
- **A4.** Add a **circuit breaker that pauses *entries* (never sells)** after N consecutive send/confirm failures — aligns with the owner's "crashes acceptable, don't force exits" posture; we already have `FailureBreaker`, so this is hardening its wiring (see Phase 1 finding that it's constructed with a constant, not config).

**ADAPT (our design, their pattern):**
- **B1.** **Blockhash-expiry handling** on the local-tx path: `lastValidBlockHeight` tracking, refetch **and rebuild** on expiry, `confirmed`-not-`finalized` with a documented time cap. *(closes a known High.)*
- **B2.** **Anchor `TradeEvent` binary decode** in the copy classifier, excluding the migrated-AMM program id, with our `getParsedTransaction` fallback kept for the slow lane. *(hardens the live-money lane.)*
- **B3.** **Geyser/Yellowstone gRPC listener** behind a swappable `Listener` interface, as a *parallel* feed to PumpPortal-ws + Helius-logsSubscribe, dedup by mint/signature, act on whichever fires first. Keep the existing feeds as fallback.
- **B4.** **Pre-send `simulateTransaction` gate** behind a flag (copy/normal lanes on; launch-snipe Play 1 may skip for latency).
- **B5.** **Reconnect-with-checkpoint + dedup** and **app-level keepalive ping** on the long-lived detection stream (the concrete shape of the missing "runtime RPC failover" for the *detection* side).
- **B6.** **Multi-endpoint submission fan-out** (Helius + one staked relay, first-confirmation wins), our own signing, official vendor SDKs behind our adapter — later, lower priority.

**AVOID:** everything in the "What NOT to copy" section above — price-only auto-stops, closed relays/skims, raw-key-to-SDK, default `skipPreflight`, fixed-amount sizing, single-quote oracle, static fees, `sigVerify:false` on send, unpinned native addons in the exe.

## Honesty note

None of this changes the Phase D/E conclusion that the **sniper lane has no measurable edge** ([[sniper-audit-findings]], `docs/research/phaseCDE-...`). These techniques make the bot *faster, safer, and honestly measurable* — which is exactly what the standing "NO EDGE — paper only" recommendation requires before any restart criterion could even be tested. The `simulateTransaction` paper mode (A1) is the prerequisite for the 30-day paper run in `KILL-CRITERIA.md` producing numbers worth trusting.
