# Zombie Farm — Security & Capacity Runbook

Operational companion to [`../SECURITY.md`](../SECURITY.md). Covers what the Worker
logs, what to alert on, and how to respond.

> **Protocol-v3 notice (2026-07-15):** much of the detailed event catalog below was
> created for the retired v2 save/action/replay routes. Protocol v3 emits request
> metrics and selected successful-command audit rows, but individual semantic command
> rejections inside an HTTP-200 batch are not yet emitted through `slog()`. Do not
> assume the absence of v2 rejection events proves that v3 traffic is clean.
>
> For an active gameplay-integrity incident, set `MUTATIONS_DISABLED=1` and deploy.
> Raising `MIN_PROTOCOL_VERSION` currently stops stale `/commands` clients only; it
> does not stop `/raid/start`, `/raid/finish`, or `/presentation`.

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

| `sec` | `lvl` | Meaning | Alert when |
|---|---|---|---|
| `dev_auth_rejected` | alert | A `devSub` (dev-bypass) sign-in hit a **prod** server (`DEV_AUTH` unset). Should be impossible in normal use. | **any** occurrence → page. Confirm `DEV_AUTH` is unset in prod. |
| `auth_token_invalid` | warn | A Google ID token failed verification. | > ~20/min globally, or a burst from one IP → credential/endpoint probing. |
| `auth_denied` | info | A request was rejected at auth. `stage:"token"` = bad/expired/absent JWT (routine). `stage:"session"` = valid signature but the session is revoked / idle-expired / mismatched. | Spike in `stage:"session"` → possible **leaked-token replay after a revoke**. Investigate the account; consider logout-all + secret rotation. |
| `rate_limited` | warn | A route’s per-key limit tripped (`route`, `who`). | Sustained for one `who` → abuse or a stuck client. Global spike across routes → attack/DDoS. |
| `save_invalid` | warn | `PUT /save` failed structural/bounds validation (`reason`). | > a few/min for one `account` → modified client forging a save. Investigate that account. |
| `save_too_large` | warn | Save body exceeded `MAX_SAVE_BYTES`. | Repeated for one `account` → modified/broken client. |
| `economy_rejected` | warn | One or more currency events were rejected (overdraw, over-cap, bad reason). `rejected` = count in the batch. | > a few/min for one `account` → currency-cheat attempts. |
| `farm_rejected` | warn | One or more `/farm/actions` were rejected (unaffordable, plot state, **not-grown** = insta-harvest attempt). | > a few/min for one `account` → farm-cheat attempts. |
| `inventory_rejected` | warn | One or more `/inventory/actions` were rejected (can't afford a buy, **none owned** = using a boost you don't have, stack full). | > a few/min for one `account` → boost-fabrication attempts. |
| `roster_rejected` | warn | One or more `/roster/actions` were rejected (**no_unit** = selling a zombie the server doesn't own, bad key). | > a few/min for one `account` → fabricated-zombie sell attempts. |
| `shop_rejected` | warn | A `/shop/*` purchase was rejected (bad/non-sequential size, can't afford, climate already owned). | > a few/min for one `account` → farm-size/climate fabrication attempts. |
| `gift_credit_deferred` | warn | A gift claim couldn’t settle the brain to the balance immediately (crash-window path). | Recurring for the same `account`/`gift` → settlement stuck; see §4 reconcile. |
| `save_conflict` | info | Optimistic-concurrency loser on `PUT /save` (client retries with fresh rev). Normal. | High global rate → a client save-loop bug, not an attack. |
| `grants_reconciled` | info | Deferred gift grants were credited on `GET /save`. Healthy self-heal. | — |
| `logout_all` | info | An account revoked all its sessions. | — |
| `cleanup` | info | Nightly cron purge counts (sessions/buckets/requests/raid/ledger/farm). | Absence for > 24h → cron not firing. |

**General rule:** a single `warn` is usually a modified client poking one account —
scope the response to that account. A **global** rise in `warn`/`alert` across many
accounts is an attack or a regression — treat as an incident.

---

## 3. Capacity signals to watch

The correctness controls are D1 constraints, but the **free-tier D1 write budget** is
the scaling ceiling (see `SECURITY.md` “Method for reducing server load”). Track, in
the Cloudflare dashboard:

- **D1 rows written / day** — the binding constraint. The save path is ~3 writes per
  flush; the client debounces (5s / 30s-max, see `SaveManager`) to stay within it.
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

**Reconcile stuck gift grants** — normally automatic on `GET /save`. To inspect:
```sh
wrangler d1 execute zombiefarm --remote \
  --command "SELECT id, account_id, source_gift_id FROM grants WHERE settled_at IS NULL"
```
Then have the affected account load once (fires `reconcilePendingGrants`), or settle
manually against `balances`.

**Quarantine / inspect a suspect save** — read the blob out before touching it:
```sh
wrangler d1 execute zombiefarm --remote \
  --command "SELECT rev, length(blob) FROM saves WHERE account_id = 'ACCT'"
```
To neutralize a weaponized save (it can’t exceed the validator, but to be safe), CAS
in a sanitized blob at the current `rev`. Keep a copy of the original first.

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
2. If a client-side forgery got through, add a regression case to the integration
   suite (`test/integration/`) so it can’t recur silently.
3. Note the event + response here if the procedure was missing or wrong.
