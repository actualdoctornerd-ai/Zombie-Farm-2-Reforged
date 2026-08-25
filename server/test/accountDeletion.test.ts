// The purge list, held to the schema it mirrors.
//
// `accountDeletion.ts` cannot read SQLite's foreign-key metadata at runtime — D1
// refuses `pragma_foreign_key_list` with SQLITE_AUTH — so the list of tables to
// clear is written out by hand there. This test is the reason that is safe: it
// loads the real `schema.sql` into node:sqlite, asks SQLite itself which columns
// reference `accounts(id)`, and requires the answer to match the constant exactly.
//
// A migration that adds a table referencing accounts therefore fails HERE, loudly,
// instead of silently leaving that table's rows behind when a player deletes their
// account. Fixing it is one line in ACCOUNT_REFERENCES — and if the fix is not
// obvious, the failure message names the tables.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_REFERENCES } from "../src/accountDeletion";

interface SchemaRef { table: string; column: string; action: string }

/** What the schema actually declares, straight from SQLite. */
function schemaReferences(): SchemaRef[] {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const rows = db.prepare(`
    SELECT m.name AS tbl, f."from" AS col, f.on_delete AS act
    FROM sqlite_master m
    JOIN pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND f."table" = 'accounts'
    ORDER BY m.name, f."from"`).all() as Array<{ tbl: string; col: string; act: string | null }>;
  return rows.map((row) => ({
    table: row.tbl,
    column: row.col,
    action: (row.act ?? "NO ACTION").toUpperCase(),
  }));
}

const key = (table: string, column: string) => `${table}.${column}`;

describe("ACCOUNT_REFERENCES mirrors the schema", () => {
  const schema = schemaReferences();

  it("finds a believable number of references at all", () => {
    // Guards the guard: if the introspection silently returned nothing, every
    // assertion below would pass vacuously and the purge would look verified.
    expect(schema.length).toBeGreaterThan(50);
  });

  it("lists every column that references accounts, and nothing that doesn't", () => {
    const declared = new Set(ACCOUNT_REFERENCES.map(([t, c]) => key(t, c)));
    const actual = new Set(schema.map((ref) => key(ref.table, ref.column)));

    const missing = [...actual].filter((k) => !declared.has(k)).sort();
    const stale = [...declared].filter((k) => !actual.has(k)).sort();

    expect(missing, `a migration added these references — add them to ACCOUNT_REFERENCES or a deleted player's rows will be left behind:\n  ${missing.join("\n  ")}`).toEqual([]);
    expect(stale, `these no longer exist in schema.sql and would make the purge throw:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("clears each reference the way the schema says to", () => {
    for (const ref of schema) {
      const entry = ACCOUNT_REFERENCES.find(([t, c]) => t === ref.table && c === ref.column)!;
      const action = entry[2] ?? "delete";
      // SET NULL means the row belongs to SOMEBODY ELSE and only mentions this
      // account. Deleting it would take their data with it.
      const expected = ref.action === "SET NULL" ? "null" : "delete";
      expect(action, `${key(ref.table, ref.column)} is ${ref.action} in schema.sql`).toBe(expected);
    }
  });

  it("keeps the one row that belongs to another player", () => {
    // Stated as its own case because it is the single most consequential entry in
    // the list: this column is how a completed trade remembers who filled it.
    const fulfilled = ACCOUNT_REFERENCES
      .find(([t, c]) => t === "black_market_orders" && c === "fulfilled_by_account_id");
    expect(fulfilled?.[2]).toBe("null");
  });

  it("has no duplicate entries", () => {
    const keys = ACCOUNT_REFERENCES.map(([t, c]) => key(t, c));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never clears the accounts table through this list — that row is deleted last, by hand", () => {
    expect(ACCOUNT_REFERENCES.some(([table]) => table === "accounts")).toBe(false);
  });
});
