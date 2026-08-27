import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PVP_REPLAYS_KEPT } from "../../src/raid/pvp";

const source = readFileSync(
  fileURLToPath(new URL("../src/v3/pvp.ts", import.meta.url)),
  "utf8",
);

describe("PvP defender reward settlement", () => {
  it("checks and stamps the daily defense cap in the same settlement update", () => {
    const settlement = source.match(
      /UPDATE pvp_sessions_v3 SET finished_at[\s\S]*?WHERE id = \? AND finished_at IS NULL/,
    )?.[0];

    expect(settlement, "the PvP settlement UPDATE has been reshaped").toBeTruthy();
    expect(settlement).toMatch(/defense_rewarded\s*=\s*CASE/i);
    expect(settlement).toMatch(/SELECT COUNT\(\*\) FROM pvp_sessions_v3 paid/i);
    expect(settlement).toMatch(/paid\.defender_id\s*=\s*\?/i);
    expect(settlement).toMatch(/paid\.defense_rewarded\s*=\s*1/i);
    expect(settlement).toMatch(/paid\.finished_at\s*>=\s*\?/i);
  });

  it("does not make a separate raceable defender-cap read before settlement", () => {
    const accounting = source.match(
      /\/\/ Daily income accounting[\s\S]*?const tiers =/,
    )?.[0];

    expect(accounting, "the daily accounting block has been reshaped").toBeTruthy();
    expect(accounting).not.toMatch(/WHERE defender_id\s*=\s*\?/i);
  });
});

describe("PvP defense history", () => {
  it("never returns more than ten defenses", () => {
    expect(PVP_REPLAYS_KEPT).toBe(10);
    expect(source).toMatch(
      /const roleQuery[\s\S]*?ORDER BY finished_at DESC LIMIT \?`\)[\s\S]*?\.bind\(accountId, PVP_REPLAYS_KEPT\)/,
    );
  });
});
