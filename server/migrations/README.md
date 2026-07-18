# D1 migrations — apply path

Versioned migrations for the `zombiefarm` D1 database. `wrangler.toml` points
`migrations_dir` here, so the standard Wrangler workflow applies:

```sh
wrangler d1 migrations list  zombiefarm --remote   # what's pending
wrangler d1 migrations apply zombiefarm --remote   # apply pending, in order
# (use --local against the dev DB)
```

Wrangler records applied migrations in a `d1_migrations` table and runs only the
pending ones, in filename order. **Testing note:** the upgrade-from-a-prod-snapshot
dry run is part of the deployment testing pass and is not covered here.

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
command; insert the rows directly (names must match the filenames exactly):

```sh
wrangler d1 execute zombiefarm --remote --command "
CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT (CURRENT_TIMESTAMP));
INSERT OR IGNORE INTO d1_migrations (name) VALUES
 ('0001_trackA_upgrade.sql'),('0002_grant_settlement.sql'),('0003_raid_cooldown.sql'),
 ('0004_economy_ledger.sql'),('0005_farm_economy.sql'),('0006_session_labels.sql'),
 ('0007_raid_rewards.sql'),('0008_boost_inventory.sql'),('0009_roster.sql'),
 ('0010_combine_jobs.sql'),('0011_shop_state.sql'),('0012_level_rewards.sql'),
 ('0013_quest_completions.sql'),('0014_object_ownership.sql'),('0015_plowed_soil.sql'),
 ('0016_raid_session_reserve.sql'),('0017_raid_progress.sql'),('0018_item_storage.sql'),
 ('0019_integrity_v2.sql'),('0020_permanent_import_closure.sql'),
 ('0020_protocol_v3_reset.sql'),('0021_epic_boss.sql'),
 ('0022_epic_boss_retry_skip.sql'),('0023_raid_revives.sql'),
 ('0024_epic_boss_tokens.sql'),('0025_writer_lease.sql'),('0026_black_market.sql');"
```

From then on, only migrations added after this baseline apply via `migrations apply`.
Whenever `schema.sql` gains a table, add its migration filename to this fresh-database
baseline in the same change.

## Existing/older database (upgrade)

Run `wrangler d1 migrations apply zombiefarm --remote`. It applies only the pending
migrations in order. **Before applying, mind the non-idempotent ones** — SQLite has no
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

The remaining current migrations use repeatable deletes or `CREATE … IF NOT EXISTS`.
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

## Going forward

Treat **migrations as the source of truth** for schema changes; keep `schema.sql`
updated as the current full snapshot (for fresh DBs + local dev), and add a matching
`00NN_*.sql` migration for every change so existing databases can upgrade.
