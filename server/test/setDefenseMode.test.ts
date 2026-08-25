// The one-per-class rule belongs to FORMATION mode alone. Classic fields the saved
// order as-is, any six, so the same rule there would refuse a perfectly playable
// line-up — a farm of six Regulars could not save a defense at all. Production runs
// classic, so this is the mode that must stay permissive.
import { describe, expect, it } from "vitest";
import { setDefensePvp } from "../src/v3/pvp";

const ROSTER: Record<string, string> = {
  u0: "ZombieActorRegularTier1",
  u1: "ZombieActorRegularTier1",
  u2: "ZombieActorHeadlessTier1",
};

/** Enough of D1 for setDefensePvp: the ownership SELECT and the upsert. */
const fakeDb = () => {
  const writes: string[] = [];
  return {
    writes,
    db: {
      prepare(sql: string) {
        const stmt = {
          args: [] as unknown[],
          bind(...args: unknown[]) { stmt.args = args; return stmt; },
          async first() { return null; },
          async all() {
            const ids = stmt.args.slice(1) as string[];
            return { results: ids.filter((id) => ROSTER[id])
              .map((id) => ({ unit_id: id, zombie_key: ROSTER[id] })) };
          },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return stmt;
      },
    } as unknown as D1Database,
  };
};

describe("one zombie per class is a FORMATION rule", () => {
  it("refuses a duplicate class in formation mode", async () => {
    const { db } = fakeDb();
    const res = await setDefensePvp(db, "acct", { unitIds: ["u0", "u1"] }, 1, "formation");
    expect(res).toMatchObject({ status: 400, body: { error: "duplicate_class" } });
  });

  it("ALLOWS a duplicate class in classic mode", async () => {
    const { db, writes } = fakeDb();
    const res = await setDefensePvp(db, "acct", { unitIds: ["u0", "u1"] }, 1, "classic");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.unitIds).toEqual(["u0", "u1"]);
    expect(writes.some((sql) => sql.includes("INSERT INTO pvp_defense_v3"))).toBe(true);
  });

  it("accepts one of each class in either mode", async () => {
    for (const mode of ["formation", "classic"] as const) {
      const { db } = fakeDb();
      const res = await setDefensePvp(db, "acct", { unitIds: ["u0", "u2"] }, 1, mode);
      expect(res.status, `${mode}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it("still refuses an unowned unit before any class check", async () => {
    const { db } = fakeDb();
    const res = await setDefensePvp(db, "acct", { unitIds: ["u0", "nope"] }, 1, "formation");
    expect(res).toMatchObject({ status: 400, body: { error: "unit_not_owned" } });
  });
});
