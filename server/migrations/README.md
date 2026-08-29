# D1 migrations — apply path

Versioned migrations for the `zombiefarm` (prod) and `zombiefarm-staging` D1
databases. `wrangler.toml` points `migrations_dir` here for both, so the standard
Wrangler workflow applies — but note the default environment is STAGING; prod
needs an explicit `--env production` (without it, wrangler errors "Couldn't find
a D1 DB … in your wrangler.toml" rather than touching anything):

```sh
wrangler d1 migrations list  zombiefarm-staging --remote                    # staging: what's pending
wrangler d1 migrations apply zombiefarm-staging --remote                    # staging: apply, in order
wrangler d1 migrations list  zombiefarm --remote --env production           # prod: what's pending
wrangler d1 migrations apply zombiefarm --remote --env production           # prod: apply, in order
# (use --local against the dev DB)
```

Apply to staging first and soak-test there; remember staging was built fresh, so
it does not rehearse the non-idempotent upgrade path below — do that against a
prod snapshot.

Wrangler records applied migrations in a `d1_migrations` table and runs only the
pending ones, in filename order. **Testing note:** the upgrade-from-a-prod-snapshot
dry run is part of the deployment testing pass and is not covered here.

Migration filenames are deployed identities, not cosmetic labels. The two historical
`0020_*` files are an immutable naming collision: renaming either would make an existing
D1 database see the renamed destructive migration as pending. `npm run migrations:check`
allows only that exact legacy pair, rejects future duplicate/gapped numbers, and verifies
that the fresh-database baseline ledger contains every migration filename. New migrations
must therefore continue at the next free number and use one unique number per file — run
`npm run migrations:check`, which prints it. Take the number from that command rather than
from this page: it is the only source that cannot be out of date.

---

## The schema.sql ⇄ migrations relationship (read this first)

There are two SQL sources and they overlap:

- **`../schema.sql`** — the *complete current schema*, all `CREATE TABLE IF NOT
  EXISTS`. It includes the base tables (`accounts`, `saves`, `gifts`, `friendships`,
  `sessions`, …) that predate the migration system and are **not** reproduced in any
  migration file.
- **`migrations/00NN_*.sql`** — the *incremental* changes layered on top of that base,
  from the Track-A pass onward.

Because they overlap, **pick one path per database** (below). Do not run
`schema.sql` and then `migrations apply` on the same DB — the `ALTER` migrations will
error on already-existing columns.

---

## Fresh database (new deploy)

`schema.sql` already contains everything the migrations produce, so:

```sh
wrangler d1 execute zombiefarm --remote --file=./schema.sql
```

Then **baseline** the migration tracker so a later `migrations apply` doesn't try to
re-run migrations whose effect is already present. Wrangler has no native baseline
command, so the repository keeps the exact immutable filename ledger in one checked
SQL file:

```sh
wrangler d1 execute zombiefarm --remote --file=./scripts/baseline-migrations.sql
```

From then on, only migrations added after this baseline apply via `migrations apply`.
Whenever `schema.sql` gains a table, add its migration filename to
`scripts/baseline-migrations.sql` in the same change. `npm run migrations:check`
enforces that ledger automatically. For a fresh local database, `npm run db:init:local`
runs both initialization steps.

## Existing/older database (upgrade)

Run `wrangler d1 migrations apply zombiefarm --remote --env production`. It applies
only the pending migrations in order. **Before applying, mind the non-idempotent ones** — SQLite has no
`ADD COLUMN IF NOT EXISTS`, so these error if the column already exists (e.g. a prior
manual `schema.sql` touched the table):

| Migration | Non-idempotent statement | Watch for |
|---|---|---|
| `0001_trackA_upgrade` | `ALTER TABLE gifts ADD COLUMN day_bucket` + backfill + **dedup DELETE** + UNIQUE index | Fails if `day_bucket` exists. The `DELETE` drops historical duplicate same-day gifts (`from_id,to_id,day_bucket`) so the UNIQUE index can build — irreversible; snapshot `gifts` first. |
| `0002_grant_settlement` | `ALTER TABLE grants ADD COLUMN settled_at` + backfill | Fails if `settled_at` exists. |
| `0006_session_labels` | `ALTER TABLE sessions ADD COLUMN label` | Fails if `label` exists. |
| `0007_raid_rewards` | `ALTER TABLE raid_sessions ADD COLUMN raid_id` | Fails if `raid_id` exists. |
| `0024_epic_boss_tokens` | `ALTER TABLE epic_boss_runs_v3 ADD COLUMN token_count` | Fails if `token_count` exists. |
| `0025_writer_lease` | Four `ALTER TABLE account_runtime_v3 ADD COLUMN` statements | Fails if a writer-lease column was added manually. |
| `0030_black_market_specific_mutations` | `ALTER TABLE black_market_orders ADD COLUMN mutation_required` (with a `CHECK` constraint) | Fails if `mutation_required` exists. |
| `0031_account_last_online` | `ALTER TABLE accounts ADD COLUMN last_online_at` + backfill from sessions | Fails if `last_online_at` exists. |
| `0032_black_market_collection` | `ALTER TABLE black_market_orders ADD COLUMN acknowledged_at` | Fails if `acknowledged_at` exists. Pre-existing FULFILLED rows intentionally stay `NULL` so their creators finally see them as collectible. |
| `0033_black_market_history` | Two `ALTER TABLE black_market_orders ADD COLUMN delivered_*` statements + backfill | Fails if either column exists. Historical filled requests keep `NULL` delivered details (never recorded); only sales backfill from escrow. |
| `0034_quest_45_popcorn_backfill` | Data-only `UPDATE`: grants the Circus Popcorn quest 45 always owed but never paid | No schema change. Idempotent — skips any account that already has the key, so re-running is a no-op. Only touches accounts with `"45"` in their completed quests. Not race-proof against a live command batch; verify after applying (see below). |
| `0035_headless_mutation_repair` | Data-only `UPDATE`: clears illegal head and hair/eye mutation bits from live `roster_v3` headless units | No schema change. Idempotent. Deliberately does not reference the optional retired `roster` table, which protocol-v3 upgrade migration `0020` drops. |
| `0036_raid_brain_pity` | `ALTER TABLE raid_state_v3 ADD COLUMN brain_dry_streak` | Fails if `brain_dry_streak` exists. Every account starts the streak at 0 — no backfill is possible, since dry invasions before this were never counted. |
| `0037_raid_zombie_pity` | `ALTER TABLE raid_state_v3 ADD COLUMN zombie_dry_json` | Fails if `zombie_dry_json` exists. Every account starts empty (`'{}'`) — as above, dry wins before this were never counted, and `progress_json` records lifetime wins, not wins since the last rare zombie. |
| `0038_gift_reward_roll` | Two `ALTER TABLE gifts ADD COLUMN reward_*` statements | Fails if either column exists. Gifts already sitting unclaimed in an inbox take the defaults (`'brain'` / `1`) and so still pay the single brain their sender was promised. |
| `0039_roster_escrow_return` | `ALTER TABLE roster_v3 ADD COLUMN from_escrow` | Fails if `from_escrow` exists. Every existing unit starts at 0 — zombies restored from a cancelled sale before this were already credited to the Almanac, and those counts never decrease. |
| `0040_black_market_delivery_claim` | Two `ALTER TABLE black_market_orders ADD COLUMN` (`claimed_at`, `delivered_unit_id`) + backfill | Fails if either column exists. Pre-existing FULFILLED rows are backfilled `claimed_at = closed_at`, so historical trades are treated as already collected rather than reappearing as claimable. |
| `0041_roster_color` | Three `ALTER TABLE … ADD COLUMN` across `roster_v3` (`color`) and `black_market_orders` (`escrow_color`, `delivered_color`) | Fails if any of the three exists. Existing units keep `NULL`, which means "derive the colour from the species" — the same thing the client already did. |
| `0043_black_market_brain_payout` | `ALTER TABLE black_market_orders ADD COLUMN payout_at` + backfill | Fails if `payout_at` exists. Historical FULFILLED rows backfill from `closed_at` so a long-settled sale isn't presented as an uncollected payout. |
| `0044_black_market_mutation_width` | **Table rebuild**: recreates `black_market_orders` (to widen `mutation_required`'s CHECK from `BETWEEN 1 AND 8191` to `> 0`) *and* `black_market_receipts`, then drops and renames | The first rebuild since `0020`. Rows are copied by explicit column list; the old **receipts** table is dropped **before** the old orders table, because `DROP TABLE` fires `ON DELETE CASCADE` and would otherwise take every idempotency receipt with it. Re-running it fails (the `_0044` tables already exist) — snapshot both tables first, and verify the counts afterwards. |
| `0045_black_market_gold` | **Table rebuild**, same shape as `0044`: recreates `black_market_orders` (to widen `price_brains` from `BETWEEN 1 AND 1000000` to `1 … 10,000,000` and add `currency`) and `black_market_receipts` | The second rebuild. The same cascade ordering applies for the same reason — receipts first. Re-running fails on the existing `_0045` tables; snapshot and verify counts as with `0044`. A pre-existing post needs no data change: it is already a brains post. |
| `0048_fallen_released_at` | `ALTER TABLE fallen_v3 ADD COLUMN released_at` | Fails if `released_at` exists. Existing rows keep `NULL` and are ranked by `died_at`, as they were before. |
| `0054_epic_boss_started_crop` | `ALTER TABLE epic_boss_runs_v3 ADD COLUMN started_crop TEXT NOT NULL DEFAULT ''` | Fails if `started_crop` exists. Every existing row correctly becomes `''`, which means "bought" — the non-empty case is a run a favourite crop lured onto the farm for free, which is the only one the client announces. |
| `0057_pvp_rework` | Two `ALTER TABLE pvp_sessions_v3 ADD COLUMN` (`attacker_rewarded`, `defense_rewarded`) plus two new tables, then a backfill `UPDATE` | Fails if either column exists. The backfill reads historical fights as rewarded on their winning side, so no past invasion is retroactively unpaid. Only reachable where `0055_pvp_invasions` has run. |

The remaining current migrations use repeatable deletes or `CREATE … IF NOT EXISTS`
(including `0029_restore_ledger`, which recreates the `ledger` table dropped by the v3
reset — gift claims now write their XP reward there, so an upgraded database needs it).
Read destructive reset migrations before applying them; repeatable does not mean safe
for data retention.

If an `ALTER` migration errors because its column already exists, mark just that one as
applied and continue:

```sh
wrangler d1 execute zombiefarm --remote --command \
  "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_session_labels.sql');"
```

## After any upgrade

- If the applied set includes a session/reset migration, communicate the resulting
  re-login or data-reset requirement before maintenance begins.
- Confirm `DEV_AUTH = "0"` in the deployed `[vars]` (it is in `wrangler.toml`).
- Smoke-check with `scripts/smoke.sh` (see `../RUNBOOK.md`).
- For Epic Boss support, verify `epic_boss_runs_v3.token_count` exists after
  migrations `0021` and `0024`. The `0022` retry-skip table is legacy and unused.
- For post-raid revival support, verify `raid_revivals_v3` and its
  `idx_raid_revivals_pending` index exist after migration `0023`.
- For gift claiming, verify the `ledger` table and `idx_ledger_account` exist after
  migration `0029` — a claim writes its XP reward there and fails without it.
- For specific-mutation Black Market orders, verify
  `black_market_orders.mutation_required` exists after migration `0030`.
- For administrative account activity, verify `accounts.last_online_at` exists
  after migration `0031`.
- For Black Market fulfillment collection, verify `black_market_orders.acknowledged_at`
  and `idx_black_market_uncollected` exist after migration `0032`.
- For the Black Market History tab, verify `black_market_orders.delivered_mutation`,
  `delivered_invasions`, and `idx_black_market_fulfiller` exist after migration `0033`.
- For the invasion brain pity floor, verify `raid_state_v3.brain_dry_streak` exists after
  migration `0036` — `/raid/start` selects it and fails the raid launch without it.
- For the rare-zombie pity, verify `raid_state_v3.zombie_dry_json` exists after migration
  `0037` — `/raid/finish` selects it and fails the settlement without it.
- For rolled gift contents, verify `gifts.reward_kind` and `gifts.reward_amount` exist
  after migration `0038` — `POST /gifts` writes both and the send fails without them.
- For Black Market sale cancellation, verify `roster_v3.from_escrow` exists after
  migration `0039` — the bootstrap roster projection selects it, and the cancel that
  returns the escrowed zombie writes it, so both fail without it.
- For daily/weekly quests, verify `periodic_quest_documents_v3` exists after migration
  `0049` — `ensureV3` writes it and `loadRows` selects it on every bootstrap, so the whole
  game 500s without it (not just one feature). Apply it BEFORE deploying the Worker; see
  "Applying migration `0049_periodic_quests`" in `../RUNBOOK.md`.
- For the service-closedown switch, verify the one-row `service_state` table exists after
  migration `0042`. Reads deliberately **fail open**, so a missing table serves `open` rather
  than erroring — which means its absence is silent. Check it explicitly.
- For the Memorial Statue, verify `fallen_v3` exists after migration `0047`. Both the invasion
  and the Epic Boss settlement write to it, and the bootstrap projection selects it.
- For the tier-4 variant mutations, migration `0050` rewrites live `roster_v3` and
  `black_market_orders` masks onto the widened catalog bits. It is data-only, but it is a
  **mask rewrite on live rows** — snapshot both tables first.
- For the Epic Boss ladder cuts, `0051` (20 rungs → 10) and `0052` (per-boss `baseHp`) repair
  runs that are mid-flight across the change. Both **cap** `current_hp` rather than resetting
  it, so damage a player has already paid attempts for is kept. Apply them with the Worker
  deploy that carries the matching ruleset, not before it.
- Migration `0053` backfills the graveyard for zombies already lost to an Epic Boss, from the
  party stored in each finished session's replay config. Names revert to the deterministic
  default and veterancy reads 0 — neither is recoverable from server-side state.
- After migration `0044`, verify the rebuild kept everything: `SELECT COUNT(*) FROM
  black_market_orders` and `... FROM black_market_receipts` should match the
  pre-migration snapshot, no `black_market_orders_0044` / `black_market_receipts_0044`
  should remain, and `SELECT sql FROM sqlite_master WHERE name='black_market_orders'`
  should show `mutation_required > 0` (not `BETWEEN 1 AND 8191`). Composing a wanted
  post for Pumpking is the end-to-end check — it was rejected before this migration.

## Going forward

Treat **migrations as the source of truth** for schema changes; keep `schema.sql`
updated as the current full snapshot (for fresh DBs + local dev), and add a matching
`00NN_*.sql` migration for every change so existing databases can upgrade.
