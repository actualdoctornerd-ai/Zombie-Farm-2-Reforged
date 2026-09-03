// The purge itself, run for real: a row for the leaving player in EVERY table that
// references accounts, the actual batch `purgeAccount` builds, foreign keys
// enforced, and then an audit of what is left.
//
// `accountDeletion.test.ts` proves the list of tables is right; `schemaParity.test.ts`
// proves the schema those tables come from is the one production has. This is the
// third leg: that the statements built from that list actually run, in that order,
// against a database with the rows in it. The outage this batch of tests came out of
// was a purge that had never once been executed against a table that was missing —
// and a purge that had never once been executed against a table that was PRESENT
// and populated would be the next surprise (a NO ACTION child deleted after its
// parent, say, which throws just as fatally and just as atomically).
//
// The seeding is generic on purpose. It reads each table's columns from SQLite and
// fills the NOT NULL ones with dummies, so a table added tomorrow is exercised the
// day it joins ACCOUNT_REFERENCES, with no edit here. Only the Black Market order
// row is written out by hand, because its CHECK constraints describe a real trade.
//
// Run against node:sqlite behind the slice of the D1 interface the purge uses,
// including `batch`, which here is a real transaction — D1 documents its batches
// as one implicit transaction, and the failure test below leans on exactly that.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { ACCOUNT_REFERENCES, attemptPurge, purgeAccount } from "../src/accountDeletion";

const NOW = 1_700_000_000_000;
const ME = "acct-leaver";
const THEM = "acct-stays";

/** D1 numbered placeholders (`?1`) to node:sqlite's anonymous ones. */
function toAnonymousPlaceholders(sql: string, params: unknown[]): [string, unknown[]] {
  const expanded: unknown[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, index: string) => {
    expanded.push(params[Number(index) - 1]);
    return "?";
  });
  return rewritten === sql ? [sql, params] : [rewritten, expanded];
}

interface Bound { run(): void }

/** node:sqlite behind the D1 methods the purge calls: prepare/bind/first/run and
 *  batch. Foreign keys are ON, as they are on D1, so a delete in the wrong order
 *  fails here the way it would fail there. */
function openSchemaDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const statement = (sql: string, params: unknown[]) => {
    const [text, bound] = toAnonymousPlaceholders(sql, params);
    return {
      first: async () => raw.prepare(text).get(...(bound as never[])) ?? null,
      run: () => { raw.prepare(text).run(...(bound as never[])); },
      bind: (...more: unknown[]) => statement(sql, more),
    };
  };
  const db = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: Bound[]) => {
      raw.exec("BEGIN");
      try {
        for (const s of statements) s.run();
        raw.exec("COMMIT");
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  } as unknown as D1Database;
  return { db, raw };
}

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface ForeignKey { from: string; table: string; to: string }

/** account-referencing columns per table, in list order. */
const accountColumns = new Map<string, string[]>();
for (const [table, column] of ACCOUNT_REFERENCES) {
  accountColumns.set(table, [...(accountColumns.get(table) ?? []), column]);
}

/** Tables ordered so that a table with a foreign key into another listed table
 *  comes after it — the seeding needs the parent row first. */
function seedOrder(raw: DatabaseSync): string[] {
  const tables = [...accountColumns.keys()];
  const parents = (t: string): string[] =>
    (raw.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(t) as unknown as ForeignKey[])
      .map((k) => k.table).filter((p) => p !== "accounts" && accountColumns.has(p));
  const ordered: string[] = [];
  const visit = (t: string) => {
    if (ordered.includes(t)) return;
    for (const p of parents(t)) visit(p);
    ordered.push(t);
  };
  for (const t of tables) visit(t);
  return ordered;
}

/** The one hand-written row: a settled, collected sale, which is the healthy trade
 *  shape `accountDeletionGuards.test.ts` uses and the CHECK constraints accept. */
function marketOrder(id: string, creator: string, fulfiller: string): Record<string, unknown> {
  return {
    id, creator_account_id: creator, kind: "SELL_ZOMBIE", zombie_key: "ZombieActorRegularTier1",
    mutated_required: 0, price_brains: 25, currency: "BRAINS", status: "FULFILLED",
    created_day: 1, created_at: NOW, fulfilled_by_account_id: fulfiller, source_unit_id: `unit-${id}`,
    escrow_mutation: 0, escrow_invasions: 0, escrow_brains: 0, claimed_at: NOW, payout_at: NOW,
  };
}

/** Seed `account` into every referencing table. A table with two account columns
 *  gets two rows: (account, account) and (account, other), so both columns are
 *  exercised in both roles once the other account is seeded the same way. */
function seedAccount(raw: DatabaseSync, account: string, other: string): void {
  // Both accounts rows first: the (account, other) rows below reference `other`.
  for (const id of [account, other]) {
    raw.prepare(`INSERT OR IGNORE INTO accounts (id, google_sub, username, friend_code, created_at, last_online_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, `sub-${id}`, id, `code-${id}`, NOW, NOW);
  }

  const ids = new Map<string, string>(); // table -> the id column value of the first row
  for (const table of seedOrder(raw)) {
    const columns = raw.prepare("SELECT * FROM pragma_table_info(?)").all(table) as unknown as ColumnInfo[];
    const keys = raw.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table) as unknown as ForeignKey[];
    const acct = accountColumns.get(table)!;
    const variants = acct.length >= 2 ? [[account, account], [account, other]] : [[account]];

    variants.forEach((variant, n) => {
      const row: Record<string, unknown> = {};
      const rowId = `${table}:${account}:${n}`;
      if (table === "black_market_orders") {
        Object.assign(row, marketOrder(rowId, variant[0], variant[1]));
      } else {
        acct.forEach((column, i) => { row[column] = variant[i]; });
        for (const c of columns) {
          if (c.name in row) continue;
          const key = keys.find((k) => k.from === c.name && k.table !== "accounts");
          if (key) { row[c.name] = ids.get(key.table); continue; }
          // A finished session: the live-session unique partial indexes allow one
          // unfinished raid / epic / PvP session per account, and two-row tables
          // would collide on it.
          if (c.name === "finished_at") { row[c.name] = NOW; continue; }
          // A TEXT PRIMARY KEY reads as nullable in SQLite's metadata; fill it anyway,
          // since a child table's foreign key needs it.
          if ((!c.notnull && !c.pk) || c.dflt_value !== null) continue;
          row[c.name] = /INT/i.test(c.type) ? 1 : c.name === "id" ? rowId : `${c.name}:${rowId}`;
        }
        if (table === "black_market_receipts") row.action = "CREATE";
      }
      const names = Object.keys(row);
      try {
        raw.prepare(`INSERT INTO "${table}" (${names.map((c) => `"${c}"`).join(",")})
          VALUES (${names.map(() => "?").join(",")})`).run(...(names.map((c) => row[c]) as never[]));
      } catch (error) {
        // A new table's constraint the generic dummies cannot satisfy lands here:
        // name it, so the fix (an override above) is obvious.
        throw new Error(`seeding ${table} with ${JSON.stringify(row)}: ${(error as Error).message}`);
      }
      if (n === 0 && typeof row.id === "string") ids.set(table, row.id);
    });
  }
}

const count = (raw: DatabaseSync, sql: string, ...params: unknown[]): number =>
  Number(Object.values(raw.prepare(sql).get(...(params as never[])) as Record<string, unknown>)[0]);

/** Rows in `table` that mention `account` in ANY of its account columns. */
function mentions(raw: DatabaseSync, table: string, account: string): number {
  const where = accountColumns.get(table)!.map((c) => `"${c}" = ?`).join(" OR ");
  return count(raw, `SELECT COUNT(*) FROM "${table}" WHERE ${where}`, ...accountColumns.get(table)!.map(() => account));
}

describe("purgeAccount, run for real against every referencing table", () => {
  function seeded() {
    const { db, raw } = openSchemaDb();
    seedAccount(raw, ME, THEM);
    seedAccount(raw, THEM, ME);
    return { db, raw };
  }

  it("seeds something in every table it is about to test (guards the guard)", () => {
    const { raw } = seeded();
    for (const table of accountColumns.keys()) {
      expect(mentions(raw, table, ME), `${table} has no row for the leaver`).toBeGreaterThan(0);
    }
  });

  it("removes every row that belongs to the account, and the account itself", async () => {
    const { db, raw } = seeded();

    const statements = await purgeAccount(db, ME);
    expect(statements).toBe(ACCOUNT_REFERENCES.length + 1);

    expect(count(raw, "SELECT COUNT(*) FROM accounts WHERE id = ?", ME)).toBe(0);
    for (const [table, column, action] of ACCOUNT_REFERENCES) {
      expect(count(raw, `SELECT COUNT(*) FROM "${table}" WHERE "${column}" = ?`, ME),
        `${table}.${column} still points at the deleted account (${action ?? "delete"})`).toBe(0);
    }
  });

  it("leaves the other player's rows exactly as they were", async () => {
    const { db, raw } = seeded();
    // Everything that does not mention the leaver, per table, before...
    const before = new Map<string, number>();
    for (const table of accountColumns.keys()) {
      before.set(table, count(raw, `SELECT COUNT(*) FROM "${table}"`) - mentions(raw, table, ME));
    }

    await purgeAccount(db, ME);

    // ...must be the whole table after. Rows that mentioned the leaver in a
    // `null` column survive too, so they are counted separately below.
    for (const [table, expected] of before) {
      const survivorsNulled = table === "black_market_orders" ? 1 : 0; // THEM's order ME had filled
      expect(count(raw, `SELECT COUNT(*) FROM "${table}"`), table).toBe(expected + survivorsNulled);
    }
    expect(count(raw, "SELECT COUNT(*) FROM accounts WHERE id = ?", THEM)).toBe(1);
  });

  it("nulls, rather than deletes, the trade somebody else completed with the account", async () => {
    const { db, raw } = seeded();
    const theirOrderMeFilled = `black_market_orders:${THEM}:1`;
    expect(count(raw, "SELECT COUNT(*) FROM black_market_orders WHERE id = ? AND fulfilled_by_account_id = ?",
      theirOrderMeFilled, ME)).toBe(1);

    await purgeAccount(db, ME);

    const row = raw.prepare("SELECT creator_account_id, fulfilled_by_account_id FROM black_market_orders WHERE id = ?")
      .get(theirOrderMeFilled) as { creator_account_id: string; fulfilled_by_account_id: string | null } | undefined;
    expect(row, "the other player's completed trade was deleted").toBeDefined();
    expect(row!.creator_account_id).toBe(THEM);
    expect(row!.fulfilled_by_account_id).toBeNull();
  });
});

describe("attemptPurge — the failure the route answers", () => {
  // THE OUTAGE, RECREATED. A table the purge list names is missing from the
  // database. The batch is one transaction, so it must fail as a whole: the account
  // and all its rows intact, and the database's message — the entire diagnosis —
  // handed back rather than thrown away.
  it("reports a missing table by name and deletes nothing", async () => {
    const { db, raw } = openSchemaDb();
    seedAccount(raw, ME, THEM);
    seedAccount(raw, THEM, ME);
    raw.exec("DROP TABLE epic_boss_retry_skips_v3");

    const outcome = await attemptPurge(db, ME);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/no such table: epic_boss_retry_skips_v3/);
    expect(count(raw, "SELECT COUNT(*) FROM accounts WHERE id = ?", ME)).toBe(1);
    expect(mentions(raw, "sessions", ME)).toBeGreaterThan(0);
  });

  it("reports success with the statement count when nothing is wrong", async () => {
    const { db, raw } = openSchemaDb();
    seedAccount(raw, ME, THEM);
    const outcome = await attemptPurge(db, ME);
    expect(outcome).toEqual({ ok: true, statements: ACCOUNT_REFERENCES.length + 1 });
    expect(count(raw, "SELECT COUNT(*) FROM accounts WHERE id = ?", ME)).toBe(0);
  });
});
