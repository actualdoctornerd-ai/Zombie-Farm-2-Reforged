# Zombie Farm — Security & Capacity Runbook

Operational companion to [`../SECURITY.md`](../SECURITY.md). Covers what the Worker
logs, what to alert on, and how to respond.

Last reviewed: 2026-08-14.

> **Stop a live gameplay-integrity incident:** set `MUTATIONS_DISABLED=1` and deploy. That is
> the one lever that halts every mutation route. `MIN_PROTOCOL_VERSION` stops stale
> `/commands` clients *only* — `/raid/*`, `/epic-boss/*`, `/black-market/*` and
> `PUT /presentation` are gated instead by the writer lease's `X-Integrity-Version` check
> under `WRITER_LEASE_MODE=enforce`.
>
> **Quiet logs do not prove clean traffic.** Semantic command rejections inside an HTTP-200
> `/commands` batch never reach `slog()` at all, and the retired v2 handlers' `slog()` calls
> are unreachable behind the `410` middleware (§2, dead events).

The Worker is a Cloudflare Worker (`src/index.ts`) backed by one D1 database named
`zombiefarm` (see `wrangler.toml`). Logs go to stdout; view them live with
`wrangler tail` or in the Cloudflare dashboard (Workers → Logs).

---

## 1. Log shape

Every security-relevant line is one JSON object emitted by `slog()`:

```json
{ "sec": "<event>", "lvl": "info|warn|alert", "account": "…", "…": "…" }
```

- `sec` — the event name (stable; alert rules key on it).
- `lvl` — severity, so a rule can filter cheaply:
  - **info** — routine / operational. Alert only on an unusual *rate*, never on one line.
  - **warn** — a rejected or abnormal request. Alert on a per-account or global *threshold*.
  - **alert** — a strong signal. Page a human on essentially any occurrence.
- All lines are **PII-free** (ids only), so they are safe to retain and forward.

Tail only security lines:

```sh
wrangler tail --format json | grep '"sec":'
# just the high-signal ones:
wrangler tail --format json | grep '"lvl":"alert"'
```

---

## 2. Events, meaning, and alert thresholds

**Live under protocol v3:**

| `sec` | `lvl` | Meaning | Alert when |
|---|---|---|---|
| `dev_auth_rejected` | alert | A `devSub` (dev-bypass) sign-in hit a **prod** server (`DEV_AUTH` unset). Should be impossible in normal use. | **any** occurrence → page. Confirm `DEV_AUTH` is unset in prod. |
| `account_command_rejected` | alert | An account exceeded its hourly/daily command-volume ceiling and was refused. | **any** sustained occurrence → automation or a runaway client on that account. |
| `command_batch_invalid` | alert | A `/commands` envelope failed structural validation and was refused `400`. Carries `build`, `integrityVersion` and `describeInvalidBatch`'s reason (envelope faults named before any command). Unrecoverable for that account — the client will retry the same bad batch forever. | **any** occurrence → a shipped client is emitting batches the server won't take. Read `build` first; a single build id across many accounts is a release regression. |
| `account_delete_failed` | alert | `POST /account/delete` could not purge the account: the atomic `db.batch` threw (`reason` names the statement — historically `no such table`, when `ACCOUNT_REFERENCES` named a table a migration had dropped) and the player got `500 purge_failed` with nothing deleted. `account_deleted` is only logged after a successful purge, so a delete attempt with no `account_deleted` line is this. Guard: `server/test/schemaParity.test.ts` proves `schema.sql` matches the migration replay and that every `ACCOUNT_REFERENCES` table exists. | **any** occurrence → a schema/migration drift; fix before another player tries. |
| `black_market_sweep_failed` | warn | The opportunistic expiry sweep of stale Black Market posts threw. The request it rode on still succeeds. | Repeated → posts are not expiring; check the 3-day expiry query against `created_at`. |
| `auth_token_invalid` | warn | A Google ID token failed verification. | > ~20/min globally, or a burst from one IP → credential/endpoint probing. |
| `auth_denied` | info | A request was rejected at auth. `stage:"token"` = bad/expired/absent JWT (routine). `stage:"session"` = valid signature but the session is revoked / idle-expired / mismatched. | Spike in `stage:"session"` → possible **leaked-token replay after a revoke**. Investigate the account; consider logout-all + secret rotation. |
| `rate_limited` | warn | A route's per-key limit tripped (`route`, `who`). | Sustained for one `who` → abuse or a stuck client. Global spike across routes → attack/DDoS. |
| `signup_refused` | info | An unknown Google identity was turned away at `/auth` because the service closedown (`mode` field) is not `open`. Expected traffic during a planned closedown. | **Never alert on this while a closedown is deliberate.** Any occurrence while you believe the service is `open` → check `service_state`; the switch may have been left set. |
| `account_command_volume` | warn | An account's command volume crossed the soft warning threshold (`hourly`, `daily`). | Repeated for one `account` → precursor to `account_command_rejected`. |
| `writer_operation_rejected` | warn | A mutation was refused because another operation held the account's writer fence. | Sustained for one `account` → a stuck lease or two clients fighting; check `active_batch_expires_at`. |
| `gift_claim_deferred` | warn | A gift claim lost the account fence to a live raid/Epic Boss/command settlement and returned `409 operation_in_progress` for the client to retry. The gift stays in the inbox — nothing is lost. | Recurring for the same `account`/`gift` → the fence is not clearing; inspect `active_batch_id`. |
| `logout_all` | info | An account revoked all its sessions. | — |
| `cleanup` | info | Nightly cron purge counts (`sessions`, `buckets`, `requests`, `raidSessions`). v3 deliberately retains premium, purchase/refund, zombie-lifecycle, and raid audit events. | Absence for > 24h → cron not firing. |

Raid integrity is audited durably in D1 rather than through `slog()`: `audit_events_v3` carries
raid start/finish rows and a `raid_finish_rejected` row for every refused finish (including the
`concessionFallbackError` code). Query that table, not the logs, when investigating raid forgery.

**Dead — retired v2 handlers (do not build alert rules on these):**

`save_invalid`, `save_too_large`, `save_conflict`, `grants_reconciled`, `economy_rejected`,
`farm_rejected`, `inventory_rejected`, `object_rejected`, `roster_rejected`, `shop_rejected`,
`storage_rejected`, `quest_rejected`, and the legacy `raid_replay` / `invalid_raid_input` pair.
Their call sites still exist in `src/index.ts`, but every route that reaches them is intercepted
by the `retiredV2` `410` middleware, so they can no longer fire. (The live v3 raid path logs to
`audit_events_v3` instead.) An older alert rule keyed on these will be silent forever — which
reads as "clean" and is not.

**General rule:** a single `warn` is usually a modified client poking one account —
scope the response to that account. A **global** rise in `warn`/`alert` across many
accounts is an attack or a regression — treat as an incident.

---

## 3. Capacity signals to watch

The correctness controls are D1 constraints, but the **free-tier D1 write budget** is
the scaling ceiling (see `SECURITY.md` “Method for reducing server load”). Track, in
the Cloudflare dashboard:

- **D1 rows written / day** — the binding constraint. Under v3 the dominant write path is
  `/commands` batches (plus raid/Epic Boss settlement and presentation writes), not the retired
  per-flush save. The client coalesces gameplay into batches — the rollout doc's smoke check is
  fifty farm commands settling in no more than six `/commands` requests per minute.
- **D1 rows read / day**, **database size**.
- **Worker requests, CPU time, error rate (5xx).**

Rate-limit counters use the Cloudflare Rate Limiting **binding** (no D1 writes); the
D1 fallback only runs if the binding is unavailable. So throttling does not itself
consume the write budget.

---

## 4. Response procedures

All commands target the remote DB; add `--remote` (omit for local dev). Replace
`ACCT` / `SID` with the id from the log line.

**Revoke one stolen session** (from the device list, or by id):
```sh
wrangler d1 execute zombiefarm --remote \
  --command "UPDATE sessions SET revoked_at = strftime('%s','now')*1000 WHERE id = 'SID'"
```

**Sign an account out everywhere** (revoke all its sessions):
```sh
wrangler d1 execute zombiefarm --remote \
  --command "UPDATE sessions SET revoked_at = strftime('%s','now')*1000 WHERE account_id = 'ACCT' AND revoked_at IS NULL"
```
(Or call `POST /session/logout-all` as that account.) Sessions also idle-expire
automatically after `SESSION_IDLE_MAX_MS` (8 days; see `db.ts`).

**Rotate the session secret** — invalidates **every** JWT (all users re-login once).
Use on secret compromise or a broad token-leak scare:
```sh
wrangler secret put SESSION_SECRET
```

**Disable one abused route fast** — tighten its limiter to near-zero and redeploy
(edit the `rateLimit(...)` line in `index.ts`), or add an early `return c.json({error:"disabled"},503)`
at the top of the handler. Prefer this over taking the whole Worker down.

**Stuck gift claims** — the v2 deferred-`grants` model is retired along with `GET /save`, so
there is no longer a self-healing reconcile pass. Under v3 a gift claim is atomic
(`db.claimGiftBrain`); if it loses the account fence it logs `gift_claim_deferred`, returns
`409 operation_in_progress`, and **leaves the gift claimable in the inbox** for the client to
retry. Nothing is owed and nothing needs manual settlement. If the 409 repeats for one account,
the problem is a stuck writer fence, not the gift:
```sh
wrangler d1 execute zombiefarm --remote \
  --command "SELECT active_batch_id, active_batch_expires_at FROM account_runtime_v3 WHERE account_id = 'ACCT'"
```
An expired `active_batch_expires_at` that is not clearing points at a settlement that died
mid-operation; releasing the lease (or waiting out the TTL) unblocks the account.

**Quarantine / inspect a suspect account** — v3 gameplay state is server-owned and no longer
lives in the v2 `saves` blob (`GET`/`PUT /save` both return `410`). Inspect the authoritative
tables instead — `balances`, `roster_v3`, `gameplay_documents_v3`, `farm_documents_v3`,
`object_documents_v3`, `account_runtime_v3` — and read `audit_events_v3` for how the account
got there:
```sh
wrangler d1 execute zombiefarm --remote \
  --command "SELECT kind, created_at, detail_json FROM audit_events_v3 WHERE account_id = 'ACCT' ORDER BY created_at DESC LIMIT 50"
```
Repair balance, roster, object, quest, and raid rows together — restoring one in isolation can
leave an inconsistent or exploitable account.

**Restore data** — D1 supports point-in-time restore (Time Travel). Find a bookmark
before the incident and restore:
```sh
wrangler d1 time-travel info zombiefarm --remote
wrangler d1 time-travel restore zombiefarm --remote --timestamp "<ISO8601>"
```

**Quota approaching the daily D1 write limit** — the game is offline-first, so shed
server load without breaking play: raise the client save cadence (increase
`SaveManager` debounce / max-dirty), and/or tighten write-route rate limits. No data
loss — the local save keeps the player whole until writes resume.

---

## 5. After any incident

1. Confirm the triggering `sec`/`lvl` rate has returned to baseline (`wrangler tail`).
2. If a client-side forgery got through, add a regression case to the integration suite so
   it can't recur silently. `vitest.integration.config.ts` globs the directory, so a new
   `*.spec.ts` runs the day it is written — only the four retired v2 specs named in its
   `exclude` are skipped. See `test/integration/README.md` for what those still leave dark.
3. Note the event + response here if the procedure was missing or wrong.

---

## 6. Player-report forensics (read-only)

Settle a "my stuff disappeared" report from the audit trail before theorising about
client bugs. `audit_events_v3` records every durable command (`durableKinds` in
`src/v3/db.ts`) with its full command JSON and `createdIds`, plus one
`command_rejected` row per batch and a `zombie_created` row.

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT id FROM accounts WHERE username LIKE '<name>'"
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT kind, detail_json, created_at FROM audit_events_v3 \
   WHERE account_id='<id>' ORDER BY created_at DESC LIMIT 20"
```

Cross-check any `createdIds` against `roster_v3`; `locked_by_raid LIKE 'pot:%'`
identifies units currently reserved inside a Zombie Pot. `--json` output is prefixed by
a config warning banner, so slice from the first `[` before parsing.

**Brain-ledger forensic ("my brains are wrong / my Statistics say 141 earned").** The
Statistics counters are a client-authored tally and can be inflated by a balance that dipped
and recovered (fixed client-side 2026-09-04 — earlier history is not repaired); the WALLET is
authoritative and its trajectory is reconstructible. `raid_sessions_v3.result_json` carries
`balance.brains` after every settled invasion, and `audit_events_v3` carries every durable
command with its detail; walk them together in time order and the brains figure must move
only by the drops, gifts, market payouts and spends you can name:

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT finished_at, json_extract(result_json,'$.balance.brains') AS brains, \
          json_extract(result_json,'$.brains') AS drop FROM raid_sessions_v3 \
   WHERE account_id='<id>' AND result_json IS NOT NULL ORDER BY finished_at DESC LIMIT 40"
```

A tally that exceeds the sum of those movements is display inflation, not a lost or minted
brain; the current balance in `balances` is the answer to give the player.

Note that a Zombie Pot combine returns ONE unit, usually of slot 1's species: below level
25, combining two of a kind gives back one that looks identical to its parents, which is
reported as a loss far more often than it is one. At level 25+ a matched pair comes back
as that body type's silver (tier-4) instead, or rarely its tier-5 special.

### Verifying migration `0034_quest_45_popcorn_backfill`

It is a plain `UPDATE` outside the command pipeline's batch guard, so a player mid-batch
can be clipped. After applying, this must return 0; re-apply if it does not.

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT COUNT(*) AS still_owed FROM gameplay_documents_v3 g \
   WHERE json_extract(g.current_json,'\$.storage.received.\"Circus Popcorn\"') IS NULL \
     AND EXISTS (SELECT 1 FROM quest_documents_v3 q, \
                 json_each(json_extract(q.current_json,'\$.completed')) e \
                 WHERE q.account_id=g.account_id AND e.value='45')"
```

### Verifying migration `0035_headless_mutation_repair`

Clears head + hair/eye mutation bits (mask 951) from headless units, which the v3 combine
used to store even though the client strips them on load. It is a plain `UPDATE` on
`roster_v3`, so a player mid-batch can be clipped — re-running is a safe no-op.
After applying, this must return 0.

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT COUNT(*) AS v3_bad FROM roster_v3 WHERE (mutation & 951)!=0 \
     AND (zombie_key LIKE 'ZombieActorHeadless%' OR zombie_key='ZombieActorBombie')"
```

### Applying migration `0043_black_market_brain_payout`

The migration and the Worker deploy are a PAIR, and the order matters. The migration
backfills every order that is `FULFILLED` at the moment it runs as already paid
(`payout_at = closed_at`), because those brains were credited at settlement by the old
code. Any sale fulfilled AFTER the migration but BEFORE the new Worker is live is
credited by the old code *and* left `payout_at IS NULL`, so its seller would be paid a
second time when they collect.

Deploy the Worker straight after applying the migration, then close that window by
sweeping anything the old code settled inside it. `<deploy_epoch_ms>` is the moment the
new Worker went live:

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "UPDATE black_market_orders SET payout_at = closed_at \
   WHERE status='FULFILLED' AND payout_at IS NULL AND closed_at < <deploy_epoch_ms>"
```

Deploying BEFORE the migration is the worse order: the new code writes `payout_at` on
every fulfil, so the whole Black Market 500s on a missing column until the migration
lands. After both are in place this must return 0 — every unpaid row should be a sale
that settled under the new Worker and is genuinely waiting to be collected:

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT COUNT(*) AS suspect FROM black_market_orders \
   WHERE status='FULFILLED' AND payout_at IS NULL AND closed_at < <deploy_epoch_ms>"
```

### Applying migration `0045_black_market_gold`

Adds `black_market_orders.currency` and widens the price CHECK to 10,000,000, so a post
can be priced in gold. **Migrate first, then deploy** — the safe order, and unlike 0043
there is no window to sweep afterwards:

* Migration before Worker: every existing row backfills to `'BRAINS'`, which is what it
  was, and the old Worker keeps inserting brains posts (it never names the column, so the
  DEFAULT applies). Nothing behaves differently until the new Worker is live.
* Worker before migration: the new code names `currency` in its INSERT, so every post
  500s until the migration lands. Same failure shape as 0043.

The migration is a table REBUILD, and `black_market_receipts` cascades from the table it
drops — it is written in 0044's order (receipts dropped first) for that reason, and
rehearsed against real SQLite in `test/migration0045.test.ts`. After applying, the
receipts ledger must be intact and every pre-existing post must read as brains:

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT (SELECT COUNT(*) FROM black_market_receipts) AS receipts, \
          (SELECT COUNT(*) FROM black_market_orders WHERE currency NOT IN ('BRAINS','GOLD')) AS bad_currency"
```

### Applying migration `0049_periodic_quests`

Adds `periodic_quest_documents_v3` (daily/weekly quests) and backfills a row for every
existing account. **Migrate first, then deploy — and this one is not a partial outage.**

`ensureV3` writes this table and `loadRows` selects from it on EVERY `/bootstrap`, with no
guard around either. The two orders are not comparable:

* Migration before Worker: the table sits there unread — the old Worker never names it —
  and the backfill means the new Worker finds a row for everyone the moment it goes live.
  Nothing behaves differently in between.
* Worker before migration: `no such table` on every bootstrap, so **nobody can play at
  all** until the migration lands. 0043 and 0045 only 500'd the Black Market; this one
  takes the whole game down.

The backfill is what makes the order forgiving in the safe direction, and it also closes a
narrower hole: `/raid/finish` reads this row DIRECTLY (it loads no v3 projection) and
answers `state_conflict` when it is missing, which is a WON invasion paying nothing. That
path additionally does its own `INSERT OR IGNORE`, so it is covered even on a database
where the backfill was skipped. Rehearsed against real SQLite in
`test/migration0049.test.ts`.

After applying, every account should have exactly one board and no account should be
missing one:

```sh
wrangler d1 execute zombiefarm --remote --json --command \
  "SELECT (SELECT COUNT(*) FROM accounts) AS accounts, \
          (SELECT COUNT(*) FROM periodic_quest_documents_v3) AS boards, \
          (SELECT COUNT(*) FROM accounts a WHERE NOT EXISTS ( \
             SELECT 1 FROM periodic_quest_documents_v3 p WHERE p.account_id = a.id)) AS missing"
```
