# Final report — audit, rebuild, and desktop packaging

Date: 2026-08-28 · Branch: `audit/phase3-hardening` (25 commits off `master` @ `0b19fc5`, **not pushed**) · Every change tested; full suite green after each.

This is the summary. Supporting evidence: `audit/phase0-baseline.md`, `phase1-full-audit.md` (45 findings), `phase2-competitive-research.md`, `phase3-changelog.md` (finding→commit map), `phase4-packaging-notes.md`. The standing pre-existing study (`docs/research/`) and its **NO-EDGE / paper-only** decision are unchanged and honored throughout.

---

## The one-paragraph version

The bot had real defects — a couple that could **lose the wallet** (it signed transactions from a third party without checking them; it echoed the funded API keys to any local web page), several that produced **wrong or missed trades** (a failed manual liquidation silently abandoned a real bag; the same leader trade could be copied twice; the sniper could sell the same position twice; migration entries acted on a made-up liquidity number), and a **Critical supply-chain trap** where the in-app updater would "upgrade" installs onto a divergent code line that had none of the recent copy-trade fixes. All of the Critical and High findings are fixed, with a proof test each; most of the Mediums and Lows too. Runtime RPC failover (one of your actual "RPC stays down" complaints) now exists. The app is now a **real Electron desktop application** with the wallet key and API keys **encrypted in the OS keychain** instead of a plaintext file. None of this changes the prior study's conclusion that the **sniper strategy has no measurable edge** — the work makes the bot safe and honestly measurable, which is exactly the precondition the kill-criteria require before any live run.

---

## What was broken, and what's fixed

### Critical (1) — fixed
- **Divergent-lineage updater clobber.** `origin/main` carries v1.0.9–v1.1.0 releases built from a branch missing every v1.0.3–v1.0.8 copy-trade fix and the whole test suite; the in-app updater follows those GitHub releases and would install v1.1.0 over v1.0.8 as an "upgrade," silently deleting the gas-float, leader-move-as-sell, and crash-recovery protections. **Fix:** the updater now refuses any release whose commit doesn't descend from the running build (GitHub compare), the build commit is baked in CI, and the checksum step is no longer mislabeled a "signature" check. **Your decision (recorded):** master is canonical — retire the v1.0.9–v1.1.0 tags so the release channel points back at it.

### High (7) — all fixed, each with a proof test
- **Signed PumpPortal txs without verifying intent** → a hostile/MITM'd response could drain the wallet. New pre-sign guard asserts fee-payer, sole signer, allowed programs, and no unexpected transfers/authority changes; 7 tests including the old drain shape.
- **Config endpoint echoed the raw Helius + funded PumpPortal keys** to any loopback page. Now returns the same sanitized shape the status endpoint already used (verified: keys blanked).
- **Failed manual LIQUIDATE marked a real position closed and zeroed the tokens** → the bag rode to zero unwatched. Now checks the on-chain balance and keeps the position unless the wallet is confirmed empty.
- **Duplicate copy execution** (unsigned-PumpPortal dedup keyed on a global health flag; not checked on all delivery paths) → doubled buys / oversold. Now per-leader and consulted everywhere.
- **Migration entries acted on a fabricated liquidity constant**, and the **pool-drain exit was never seeded from real reserves.** Now the router refuses unmeasured liquidity, and the drain peak is seeded from the measured value at entry.

### Medium / Low (37) — the great majority fixed
Highlights: **runtime RPC failover** to a backup endpoint when the primary dies (your "RPC stays down" issue); the sniper's own **double-sell** on a timed-out sell; **shared-wallet overdraft** between the sniper and copy trader; **per-install files** (wallet key, lock, reports) no longer written to a foreign `cwd`; **copy-buy slippage** capped at 30%; the **failure breaker** and other guardrail caps now actually honor their config; **priority fee** sampled against the pump.fun program instead of the global fee market; **clean-shutdown** recorded so restarts stop crying crash; leader-balance writes **slot-ordered** so a late reconcile can't mis-size a sell. Full list in `phase3-changelog.md`.

**Deliberately deferred (documented, not live-risk):** finishing the local-tx-build rollout (needs a shadow-parity data run, not a code edit), a RugCheck cache, an always-on wallet-reconcile loop, and a copy token allowlist/denylist. Rationale for each is in the changelog.

---

## Adopted from competitor research (Phase 2)

Six reputable open-source bots were statically reviewed (the rest of the field was excluded as abandoned or malware-flavored — one repo literally instructs users to disable antivirus). What was folded in: **account-scoped priority-fee sampling** with a hard cap, the **pre-sign verification** discipline (our H1 guard), the **failure-breaker/circuit-breaker** honoring config, and **RPC failover/reconnect**. The single biggest remaining idea — an **honest `simulateTransaction` paper mode** (build the real tx, simulate against live state, never broadcast; no RNG) — is specified as the top follow-up; the current `honestPaper` mode already prices against the real curve, so this is a fidelity upgrade, not a fix. Adopt/adapt/avoid detail is in `phase2-competitive-research.md`.

---

## Desktop app (Phase 4)

Now a real **Electron** application (owner-chosen), not localhost-in-a-browser. The Node/Express engine runs in Electron's main process; the dashboard is a native window. **Secrets are encrypted at rest in the OS keychain** (Windows DPAPI / macOS Keychain / Linux libsecret via `safeStorage`) — verified end-to-end: the packaged app boots the engine, serves the dashboard with live data, gates the dev-only session-token endpoint (404), and stores the wallet key as `ssb1:` ciphertext with a clean round-trip.

- **Built and verified locally:** the unpacked Windows app (`release-app/win-unpacked/…exe`, 190 MB).
- **Produced in CI, not on your box:** the wrapped installers (`.exe`/`.dmg`/`.AppImage`/`.deb`). The NSIS installer needs Developer-Mode/admin symlink privilege the dev machine doesn't have, and a `.dmg` only builds on a mac — so `.github/workflows/desktop.yml` builds all three on their native runners and publishes on a `v*` tag. This is standard for cross-platform desktop apps.
- One code fix the packaging surfaced: Electron's bundled Node couldn't `require()` an ESM-only `uuid` pulled by `@solana/web3.js`; pinned `uuid@9.0.1` (CJS), which also cleared the original uuid advisory.

---

## Remaining known limitations & risks (honest)

1. **The sniper strategy still has no measurable edge.** Nothing here changes the prior study's NO-EDGE finding. These fixes make it *safe to test*, not *profitable*.
2. **`npm audit`: 4 moderate (production), all the uuid chain.** The advisory is about uuid `v3/v5/v6` with a `buf` argument; `jayson`/`rpc-websockets` use only `v4` and never pass `buf`, so the vulnerable path isn't reachable. `audit fix --force` would downgrade `@solana/web3.js` to 0.0.3 and break the bot — do not run it. Accept and monitor (matches the earlier audit). The dev toolchain (electron-builder) adds build-time-only advisories that never ship.
3. **The committed Helius key is still live and public in git history.** Rotate it in the Helius dashboard — I can't (it's a credential action). It's an RPC key, not a wallet key, so it's throttling/billing risk, not fund loss.
4. **Auto-update is not yet code-signed.** The lineage guard closes the divergent-clobber path, but real provenance needs Windows/Apple signing certs (CI is wired for them). Until then, treat updates as manual/trusted.
5. **Copy-lane RPC failover and an always-on wallet reconcile** are follow-ups; the sniper lane has failover now, the copy lane re-resolves on key change.
6. **In-process engine:** an engine crash closes the desktop window. Fine for one operator; a sidecar is the isolation upgrade if wanted.

---

## Before you enable live trading — explicit checklist

Live trading is **off**, and re-enabling it is your manual decision. Before you do:

1. **Rotate the Helius key** (public in git history) and confirm the new one is the only one in `.env` / the app.
2. **Reconcile the lineage:** confirm master is canonical and delete/stop-publishing the `origin/main` v1.0.9–v1.1.0 tags, so the updater and any install point at the hardened line.
3. **Pre-commit to `docs/research/KILL-CRITERIA.md`** — the stop rules written while you hold no position.
4. **Run paper-only for the full window the kill-criteria require** (≥30 continuous days, one fixed policy, no tuning mid-run) on the packaged app. The harness and guardrails now make those numbers trustworthy.
5. **Implement the honest `simulateTransaction` paper mode** (Phase 2's top pick) first if you want the paper P&L to reflect exact on-chain fills.
6. **Sign the desktop builds** before distributing to anyone but yourself.
7. Only then, with the kill-criteria in hand and the paper run showing an edge that survives out-of-sample, consider a **small** live allocation — sized so a total loss is one you're willing to accept, consistent with your stated risk posture.

The engineering is in good shape. The open question was never the code quality — it's whether the strategy has an edge, and the honest answer from the data remains: not yet demonstrated. Everything above makes that question answerable safely.
