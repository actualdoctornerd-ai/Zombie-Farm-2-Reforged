import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { MAX_FARM_LAYOUTS, MAX_LAYOUT_ITEMS, readFarmLayouts, validFarmLayouts, writeFarmLayouts } from "../src/farmLayouts";

const item = { key: "xmasTree", oc: 5, or: 2, turn: 0 };
const layout = (id: string, items: unknown[] = [item]) =>
  ({ id, name: "Winter", savedAt: 1_700_000_000_000, items });

describe("validFarmLayouts", () => {
  it("accepts a normal list, including an instance id on an item", () => {
    expect(validFarmLayouts([layout("a"), layout("b", [{ ...item, id: "obj-123" }])])).toBe(true);
    expect(validFarmLayouts([])).toBe(true);
  });

  it("bounds the number of layouts and items", () => {
    expect(validFarmLayouts(Array.from({ length: MAX_FARM_LAYOUTS + 1 }, (_, i) => layout(`l${i}`)))).toBe(false);
    expect(validFarmLayouts([layout("a", Array(MAX_LAYOUT_ITEMS + 1).fill(item))])).toBe(false);
    expect(validFarmLayouts([layout("a", Array(MAX_LAYOUT_ITEMS).fill(item))])).toBe(true);
  });

  it("rejects duplicate ids, bad names and malformed items", () => {
    expect(validFarmLayouts([layout("a"), layout("a")])).toBe(false);
    expect(validFarmLayouts([{ ...layout("a"), name: "" }])).toBe(false);
    expect(validFarmLayouts([{ ...layout("a"), name: "x".repeat(25) }])).toBe(false);
    expect(validFarmLayouts([{ ...layout("a"), name: "bad\u0007" }])).toBe(false);
    expect(validFarmLayouts([layout("a", [{ ...item, oc: 128 }])])).toBe(false);
    expect(validFarmLayouts([layout("a", [{ ...item, turn: 8 }])])).toBe(false);
    expect(validFarmLayouts([layout("a", [{ ...item, key: "../x" }])])).toBe(false);
    expect(validFarmLayouts({ layouts: [] })).toBe(false);
  });
});

describe("farm_layouts storage", () => {
  const openDb = () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    raw.prepare("INSERT INTO accounts (id, google_sub, friend_code, created_at) VALUES ('acct', 'g', 'F1', 0)").run();
    const statement = (sql: string, params: unknown[]) => ({
      bind: (...more: unknown[]) => statement(sql, more),
      first: async () => raw.prepare(sql).get(...(params as never[])) ?? null,
      run: async () => raw.prepare(sql).run(...(params as never[])),
    });
    return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
  };

  it("round-trips a list, strips unknown fields, and clears with []", async () => {
    const db = openDb();
    expect(await writeFarmLayouts(db, "acct", [{ ...layout("a"), extra: "x" }], 1)).toBe(true);
    expect(await readFarmLayouts(db, "acct")).toEqual([layout("a")]);
    expect(await writeFarmLayouts(db, "acct", [layout("b")], 2)).toBe(true);
    expect(await readFarmLayouts(db, "acct")).toEqual([layout("b")]);
    expect(await writeFarmLayouts(db, "acct", "nope", 3)).toBe(false);
    expect(await readFarmLayouts(db, "acct")).toEqual([layout("b")]);
    expect(await writeFarmLayouts(db, "acct", [], 4)).toBe(true);
    expect(await readFarmLayouts(db, "acct")).toEqual([]);
  });
});
