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

Migration filenames are deployed identities, not cosmetic labels. The two historical
`0020_*` files are an immutable naming collision: renaming either would make an existing
D1 database see the renamed destructive migration as pending. `npm run migrations:check`
allows only that exact legacy pair, rejects future duplicate/gapped numbers, and verifies
that this document's fresh-database baseline contains every migration filename. New
migrations must therefore continue at `0027` and use one unique number per file.

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
