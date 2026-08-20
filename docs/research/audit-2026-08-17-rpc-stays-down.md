# Bug audit — 2026-08-17

Scope: every branch, every file. Focus question from the owner: *"sometimes for
certain users RPC stays down even with full valid information."*

Baseline: `npx tsc --noEmit` clean, `npm test` 307 passed / 0 failed, on the
working tree (which carries two uncommitted files, both touching this bug).

**Status: all seven findings are implemented.** `tsc --noEmit` clean, 329
passed / 0 failed (22 new regression tests). Verified live against a running
instance: with `SOLANA_RPC_URL=https://stale-node.example/rpc` and a valid key
in `.env`, the header now reads `RPC DOWN · stale-node.example` plus
`⚠ HELIUS KEY UNUSED — SOLANA_RPC_URL OVERRIDE`, where it previously said only
`RPC DOWN`. Pasting `https://my-node.example/rpc` into the key field is refused
with the fix in the message, and `.api-keys.json` is never created — the value
that used to survive every restart no longer reaches disk.

## Branches

Nothing to merge. `origin/main` (`8841413`) is a strict ancestor of `master`;
`git merge-base --is-ancestor origin/main master` returns true and
`git log origin/main ^master` is empty. `master` == `origin/master` == `87d43e4`.
`origin/main` is simply a stale pointer 12 commits / 34 files behind — a
fast-forward of the remote branch, not a merge.

---

## Why RPC reads DOWN on a fully-configured install

Four independent causes. Each on its own reproduces the symptom, and each is
invisible from the UI, which is why it reads as "valid information, still down".

### 1. `SOLANA_RPC_URL` silently outranks the key, and is never surfaced

`rpcEndpoint()` (`src/services/rpcHealth.ts:172-174`) returns
`process.env.SOLANA_RPC_URL` before it ever looks at the Helius key. Same for
`SOLANA_RPC_WS_URL` in `rpcWsEndpoint()` (`:183-185`), which feeds the curve
watcher.

So a user with a stale, rotated, or typo'd `SOLANA_RPC_URL` in the `.env` beside
the exe can type a perfectly good Helius key into Settings and every RPC call
still goes to the dead endpoint. Everything they can see says configured:
`heliusApiKeySet: true`, `heliusApiKeyHint` shows their key's tail,
`heliusApiKeySource: 'stored'`. Nothing in the status payload or the UI reports
which endpoint is actually in use.

`isFallbackEndpoint()` (`:196-198`) also returns false whenever the override is
set, so the "you are on the rate-limited public endpoint" warning is suppressed
too.

The only place the real host is ever printed is the log line at
`sniperEngine.ts:820`, and only on a key change — never at startup, never in the
UI.

**Fix:** put the effective endpoint host and its source (`env-override` /
`helius` / `fallback-env` / `public`) into the `health.rpc` block of
`/api/bot/status`, and show it next to the RPC badge. Log the resolved host on
startup, not just on change. Warn loudly when `SOLANA_RPC_URL` is set *and* a
Helius key is present, because that combination means the key is being ignored.

### 2. Nothing validates the shape of the Helius key — and the bad value is persisted

`rpcEndpoint()` interpolates the string unconditionally:

```ts
if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
```

There is no format check anywhere — not in the UI field (`App.tsx:1449`), not in
`updateConfig` (`sniperEngine.ts:761-770`), not in `storeKey`
(`keyStore.ts:73`). Paste a full Helius RPC URL rather than the bare key and you
get `https://mainnet.helius-rpc.com/?api-key=https://mainnet.helius-rpc.com/?api-key=…`,
which fails every call forever.

This is worse than a transient failure because the bad value is written to
`.api-keys.json`, and a stored key outranks `.env` (`keyStore.ts:121-133`). The
broken credential now survives every restart, and `heliusApiKeySet` reads true
the whole time.

**Fix:** validate the key before storing it — a UUID-shaped string, or accept a
full URL and extract the `api-key` query param. Then probe it once with a real
`getSlot` and refuse to persist a credential that just got rejected, reporting
the actual error instead of silently saving it.

### 3. `rpcHealthy` latches false with only one un-latcher, gated on a linked wallet

*(Already addressed by the uncommitted working-tree change — the diagnosis in
those comments is correct. Keep it.)*

`rpcHealthy` had four writers: the constructor, `checkRpcHealth()`,
`refreshBalance()`, and the `onAccountChange` callback. On the no-wallet path,
`syncLiveWalletBalance()` returned before reaching `refreshBalance`
(`sniperEngine.ts:1023`), so once a single cold `getSlot` at startup or on
`setConnection()` failed, nothing ever asked again. The badge stayed DOWN for the
life of the process on a completely healthy key.

The working tree fixes both halves: `checkRpcHealth()` now retries
(`walletService.ts:71-84`), and the 2s wallet-sync tick rechecks unconditionally
when no wallet is linked (`sniperEngine.ts:1023-1030`).

### 4. `getBalance` is the one RPC call here with no retry — and it can refuse to arm REAL mode

`refreshBalance()` calls `this.connection.getBalance(...)` bare
(`walletService.ts:338`) and sets `rpcHealthy = false` on any throw (`:344`).
`checkRpcHealth` just got `withRpcRetry`; this path did not.

That matters more than a stale badge, because `getBlockers()` turns it into a
hard refusal:

- `walletService.ts:369` — `if (!this.rpcHealthy) blockers.push('RPC unreachable…')`
- `sniperEngine.ts:850-855` — any blocker refuses to start REAL mode

So one 429 from a shared Helius key, landing in the 8s window before the next
poll, is enough to refuse to arm the bot on a wallet and credential that are
both fine.

**Fix:** wrap the `getBalance` in `withRpcRetry` with the same shape used for
`getSlot`, and require N consecutive failures (or a `credentialRejected` latch)
before `rpcHealthy` goes false — one blip should not be a blocker.

---

## Other bugs found

### 5. A failed `link()` leaves the wallet armed anyway

`walletService.ts:249` assigns `this.keypair = kp` before the balance probe. The
RPC-failure early return at `:256-262` returns `ok: false` **without rolling that
back**. The caller logs `❌ Wallet link failed` (`sniperEngine.ts:575`) while
`getStatus().linked` is now `true` and the engine will sign with that key.

If `persist` was true it was never written either, so the wallet looks linked
this session and is gone after a restart. Given cause 4 above, a single 429 is
enough to trigger this.

**Fix:** snapshot the previous keypair/source and restore them on the failure
path.

### 6. The new 2s heartbeat pollutes the rpcHealth success-rate metric

`withRpcRetry` increments the module-global counters on every call
(`rpcHealth.ts:108`, `:134`), and `/api/bot/status` reports
`health.rpc.successRate` from them (`sniperEngine.ts:1153-1160`). Routing a
health probe through it 30×/minute means the heartbeat dominates the number that
exists to measure *trading-path* RPC quality — the "barely working now has a
number" purpose stated in that module's header.

**Fix:** give `checkRpcHealth` its own retry that does not touch the shared
counters, or add an `opts.countHealth = false`.

### 7. Stale comment

`sniperEngine.ts:1046` says "the next 10-second tick will retry". The interval is
2000ms (`:1057`).

---

## Suggested order

1 and 2 first — they are the ones that produce a *permanent* down state on a
valid credential, and both are pure diagnosis gaps: the bot knows which endpoint
it is using and never says. 4 and 5 next, since together they can refuse to arm
live mode and desync the wallet on a single 429. 3 is done. 6 and 7 are cleanup.
