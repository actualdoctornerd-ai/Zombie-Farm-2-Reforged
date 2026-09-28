import { describe, it, expect } from "vitest";
import { creditLevelUps } from "../src/db";
import { XP_THRESHOLDS, levelForXp, levelUpBrains } from "../src/levels";

describe("levelForXp — server XP→level curve", () => {
  it("is level 1 at 0 xp and below the first real threshold", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(24)).toBe(1);
  });
  it("advances a level exactly at each threshold", () => {
    expect(levelForXp(25)).toBe(2); // threshold[1]
    expect(levelForXp(74)).toBe(2);
    expect(levelForXp(75)).toBe(3); // threshold[2]
    expect(levelForXp(150)).toBe(4);
  });
  it("caps at the top tier", () => {
    const top = XP_THRESHOLDS.length; // 45
    expect(levelForXp(XP_THRESHOLDS[top - 1])).toBe(top);
    expect(levelForXp(9_999_999)).toBe(top);
  });
  it("matches the client curve length (45 tiers)", () => {
    expect(XP_THRESHOLDS.length).toBe(45);
  });
});

describe("creditLevelUps authoritative raid cooldown", () => {
  it("resets the cooldown only while the previously claimed level still owns the CAS", async () => {
    type FakeStatement = {
      sql: string;
      args: unknown[];
      bind: (...args: unknown[]) => FakeStatement;
      first: <T>() => Promise<T | null>;
      run: () => Promise<{ meta: { changes: number } }>;
    };
    let batch: FakeStatement[] = [];
    const db = {
      prepare(sql: string): FakeStatement {
        const statement: FakeStatement = {
          sql,
          args: [],
          bind(...args: unknown[]) { statement.args = args; return statement; },
          async first<T>() { return { xp: 25, claimed_level: 1 } as T; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: FakeStatement[]) {
        batch = statements;
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    };

    await creditLevelUps(db as unknown as D1Database, "account", 123);

    expect(batch).toHaveLength(2);
    expect(batch[0].sql).toContain("UPDATE raid_state_v3 SET last_started_at = 0");
    expect(batch[0].sql).toContain("claimed_level = ?");
    expect(batch[0].args).toEqual(["account", "account", 1]);
    expect(batch[1].sql).toContain("UPDATE balances SET claimed_level = ?");
    expect(batch[1].args).toEqual([2, "account", 1]);
  });
});

describe("levelUpBrains — no brains post-brainflation revert", () => {
  it("grants no brains when leveling up (the +1-per-level drip was removed)", () => {
    expect(levelUpBrains(1, 2)).toBe(0);
    expect(levelUpBrains(1, 5)).toBe(0);
  });
  it("grants nothing when the level didn't rise either", () => {
    expect(levelUpBrains(5, 5)).toBe(0);
    expect(levelUpBrains(5, 3)).toBe(0);
  });
});
