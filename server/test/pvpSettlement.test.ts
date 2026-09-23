import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PVP_HISTORY_ROWS, PVP_REPLAYS_KEPT } from "../../src/raid/pvp";

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
  it("bounds each role's list by the HISTORY window, not the replay-retention count", () => {
    // These were one number, and the result was that the panel forgot outcomes the
    // database still held: PVP_REPLAYS_KEPT is about how much heavy replay payload is
    // worth storing, and using it as the history window meant an eleventh invasion
    // pushed the first one out of sight. PVP_REPLAYS_KEPT's own comment promises the
    // opposite ("Older rows keep their RESULT ... forever").
    expect(PVP_HISTORY_ROWS).toBeGreaterThan(PVP_REPLAYS_KEPT);
    expect(source).toMatch(
      /const roleQuery[\s\S]*?ORDER BY finished_at DESC LIMIT \?`\)[\s\S]*?\.bind\(accountId, PVP_HISTORY_ROWS\)/,
    );
  });

  it("still bounds the list", () => {
    // It is a window, not "everything": the panel renders every row it is given.
    expect(source).toMatch(/ORDER BY finished_at DESC LIMIT \?/);
    expect(PVP_HISTORY_ROWS).toBeLessThanOrEqual(100);
  });
});

describe("PvP practice runs", () => {
  it("opens no session, charges nothing and writes no audit row", () => {
    const practice = source.match(/export async function practicePvp[\s\S]*?closeInvalidPvp/)?.[0];
    expect(practice, "practicePvp has been reshaped").toBeTruthy();
    // The whole safety argument for having no /finish and no replay verification is
    // that a practice run cannot touch anything. If it ever starts writing, that
    // argument stops holding and the route needs the real settlement path.
    expect(practice).not.toMatch(/INSERT INTO/i);
    expect(practice).not.toMatch(/UPDATE /i);
    expect(practice).not.toMatch(/DELETE /i);
  });

  it("fights the caller's OWN defense", () => {
    const practice = source.match(/export async function practicePvp[\s\S]*?closeInvalidPvp/)?.[0];
    expect(practice).toMatch(/buildPinnedPvpRaid\(db, accountId, accountId,/);
  });

  it("keeps the ruleset gate", () => {
    // Without it the client could simulate a fight its real defense would never
    // fight, which is the one thing a defense test must not do.
    const practice = source.match(/export async function practicePvp[\s\S]*?closeInvalidPvp/)?.[0];
    expect(practice).toMatch(/stale_ruleset/);
  });
});
