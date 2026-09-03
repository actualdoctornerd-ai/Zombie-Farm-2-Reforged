// `schema.sql` must be the database the migrations build. This is the test that
// would have caught the account-deletion outage, and will catch the next drift.
//
// Two ways to build a Zombie Farm database exist side by side: a fresh one is
// created from `schema.sql` (staging, every test suite, a local dev DB), while
// production was built by replaying `migrations/` in order. Nothing had ever
// checked that the two agree. They did not: `schema.sql` still declared 25 pre-v3
// tables that `0020_protocol_v3_reset` had dropped, the account-deletion purge
// list mirrored `schema.sql` faithfully, every test passed against the tables
// `schema.sql` said existed, and every production deletion died on the first
// `DELETE FROM` a table that had not existed for months. (It also carried nonneg
// triggers on `balances` that production has never had, and a handful of
// defaults and foreign-key actions that differed.)
//
// So: replay the migration chain into real SQLite, load `schema.sql` into another,
// and diff the two object for object — every table, column (type, NOT NULL,
// default, primary key), foreign key (target and ON DELETE action), index (its
// normalised definition, which is what carries a partial index's WHERE clause) and
// trigger. Any difference fails, and the message names it.
//
// WHY THE REPLAY STARTS AT THE v3 RESET. The files before it alter tables that
// predate the migration system (`ALTER TABLE gifts ADD COLUMN day_bucket`) and so
// cannot run on an empty database; but the reset drops every table any of them
// created and rebuilds from nothing, so a replay from the reset onward IS the
// production shape. That premise is asserted below rather than assumed: if a
// future reset-style migration stops short of dropping something an earlier file
// built, the replay would silently be incomplete.
//
// WHAT THIS DOES NOT PROVE. That the chain matches PRODUCTION is verified by hand:
// on 2026-09-02, `SELECT name FROM sqlite_master` against the production database
// listed exactly the 32 tables and 28 indexes (and no triggers) the replay builds.
// A migration applied to production by hand, outside the chain, would not show
// here — the chain is the only record there is, which is one more reason there
// must never be such a migration.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_REFERENCES } from "../src/accountDeletion";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = `${root}migrations/`;

/** The destructive reset every later migration builds on. Its name is a deployed
 *  identity (see migrations/README.md) and cannot change. */
const RESET = "0020_protocol_v3_reset.sql";

const migrationFiles = (): string[] =>
  readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));

function replayMigrations(): DatabaseSync {
  const files = migrationFiles();
  const start = files.indexOf(RESET);
  expect(start, `${RESET} is missing from migrations/`).toBeGreaterThanOrEqual(0);
  const db = new DatabaseSync(":memory:");
  for (const file of files.slice(start)) {
    try {
      db.exec(readFileSync(migrationsDir + file, "utf8"));
    } catch (error) {
      throw new Error(`migration ${file} does not replay on SQLite: ${(error as Error).message}`);
    }
  }
  return db;
}

function loadSchema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(`${root}schema.sql`, "utf8"));
  return db;
}

/** Whitespace, `IF NOT EXISTS` and case are the only things allowed to differ
 *  between an index written in a migration and the same index in schema.sql. */
const normalise = (sql: string | null): string =>
  (sql ?? "")
    .replace(/\s+/g, " ")
    .replace(/IF NOT EXISTS /i, "")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .toLowerCase();

interface MasterRow { type: string; name: string; tbl_name: string; sql: string | null }
interface ColumnRow { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface ForeignKeyRow { from: string; table: string; to: string | null; on_delete: string; on_update: string }

/** One line per fact about the database, so a diff of two shapes reads as a
 *  list of exactly what differs. */
function shape(db: DatabaseSync): string[] {
  const lines: string[] = [];
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as unknown as MasterRow[];
  for (const o of objects) {
    if (o.type === "table") {
      lines.push(`table ${o.name}`);
      const columns = db.prepare(`SELECT * FROM pragma_table_info(?)`).all(o.name) as unknown as ColumnRow[];
      for (const c of columns) {
        lines.push(`  column ${o.name}.${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`);
      }
      const keys = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(o.name) as unknown as ForeignKeyRow[];
      for (const k of keys) {
        lines.push(`  foreign-key ${o.name}.${k.from} -> ${k.table}.${k.to} on-delete=${k.on_delete} on-update=${k.on_update}`);
      }
      // CHECK constraints have no pragma; their count is the best cheap signal.
      lines.push(`  checks ${o.name} ${(o.sql?.match(/CHECK\s*\(/gi) ?? []).length}`);
    } else {
      lines.push(`${o.type} ${o.name} on ${o.tbl_name}: ${normalise(o.sql)}`);
    }
  }
  return lines;
}

const tables = (db: DatabaseSync): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as unknown as Array<{ name: string }>).map((r) => r.name);

describe("schema.sql is the database the migrations build", () => {
  it("the v3 reset drops every table an earlier migration created, so replaying from it is the whole chain", () => {
    const files = migrationFiles();
    const reset = readFileSync(migrationsDir + RESET, "utf8");
    const dropped = new Set(
      [...reset.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map((m) => m[1])
    );
    const createdBefore = new Set<string>();
    for (const file of files.slice(0, files.indexOf(RESET))) {
      const sql = readFileSync(migrationsDir + file, "utf8");
      // Anchored to a line start so a mention inside a comment ("CREATE TABLE IF
      // NOT EXISTS), safe on fresh DBs") is not read as a table named IF.
      for (const m of sql.matchAll(/^\s*CREATE TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gim)) createdBefore.add(m[1]);
    }
    expect(createdBefore.size).toBeGreaterThan(20); // guards the guard
    const survivors = [...createdBefore].filter((t) => !dropped.has(t)).sort();
    expect(survivors, "tables created before the reset that the reset does not drop").toEqual([]);
  });

  it("replays into a believable database at all", () => {
    // If the replay silently produced nothing, the diff below would compare two
    // empty shapes and pass. Production had 32 tables on 2026-09-02.
    const db = replayMigrations();
    expect(tables(db).length).toBeGreaterThanOrEqual(32);
    db.close();
  });

  it("matches the replayed migration chain object for object", () => {
    const migrated = replayMigrations();
    const fresh = loadSchema();
    const a = shape(migrated);
    const b = shape(fresh);
    migrated.close();
    fresh.close();

    const onlyMigrations = a.filter((line) => !b.includes(line));
    const onlySchema = b.filter((line) => !a.includes(line));

    const report = [
      onlyMigrations.length ? `built by the migrations but not by schema.sql:\n  ${onlyMigrations.join("\n  ")}` : "",
      onlySchema.length ? `declared by schema.sql but not built by the migrations:\n  ${onlySchema.join("\n  ")}` : "",
      "A change to one needs the same change to the other, in the same commit (migrations/README.md).",
    ].filter(Boolean).join("\n");

    expect(onlyMigrations.concat(onlySchema), report).toEqual([]);
  });

  it("names only tables the migration chain actually builds in the account purge list", () => {
    // The direct statement of the outage. `accountDeletion.test.ts` holds the purge
    // list to schema.sql; this holds it to the migrations, so the two can never
    // again agree with each other and both be wrong.
    const db = replayMigrations();
    const built = new Set(tables(db));
    db.close();
    const phantom = ACCOUNT_REFERENCES.map(([table]) => table).filter((t) => !built.has(t));
    expect(phantom, "the purge would throw 'no such table' on production for these").toEqual([]);
  });
});
