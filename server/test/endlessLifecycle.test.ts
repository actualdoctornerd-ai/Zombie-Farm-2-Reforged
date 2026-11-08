import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  abandonEndless, activeEndless, chooseEndlessBossReward, finishEndlessWave,
} from "../src/v3/endless";
import zombiesJson from "../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../src/raid/CombatEngine";
import { beginEndlessRun, endlessBossDraft, type EndlessRunState } from "../../src/raid/endless";
import { endlessFightConfig, endlessSimFor } from "../../src/raid/endlessFight";
import { flyFight } from "../../src/raid/harness/pilot";
import { EXPERT, makePilot } from "../../src/raid/harness/pilots";
import { makeOwned } from "../../src/zombie/types";
import type { ZombieDef } from "../../src/assets";
import { RAID_RULESET_VERSION } from "../../src/raid/replay";

type Row = Record<string, unknown>;
class Statement {
  args: unknown[] = [];
  constructor(readonly sql: string, private readonly row: Row | null, private readonly writes: Statement[]) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>() { return this.row as T | null; }
  async run() { this.writes.push(this); return { meta: { changes: 1 } }; }
}

function fakeDb(row: Row) {
  const batches: Statement[][] = [];
  const writes: Statement[] = [];
  const db = {
    prepare(sql: string) {
      return new Statement(sql, sql.startsWith("SELECT") ? row : null, writes);
    },
    async batch(statements: Statement[]) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, batches, writes };
}

function session(wave: number, payload: Row): Row {
  return {
    id: "endless-session", account_id: "account-1", mode: "endless", current_wave: wave,
    run_state_json: JSON.stringify(payload), army_json: "[]", fight_config_json: "{}",
    ruleset_version: RAID_RULESET_VERSION, started_at: 1_000, fight_started_at: 1_000,
    finished_at: null, result_json: null,
  };
}

describe("Endless run checkpoints and early exit", () => {
  it("resumes an old in-battle checkpoint from its pinned fight start", async () => {
    const run = beginEndlessRun("endless", []);
    const checkpoint = session(5, { run, playerLevel: 40, durationMs: 12_000 });
    checkpoint.started_at = 1_000;
    const { db } = fakeDb(checkpoint);

    const result = await activeEndless(db, "account-1");
    expect(result.status).toBe(200);
    expect(result.body.stage).toBe("battle");
    expect(result.body.wave).toBe(5);
    expect(result.body.fight).toEqual({});
  });

  it("resumes a cleared boss at its persisted boon/curse screen", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 7 };
    const checkpoint = session(6, { run, playerLevel: 45, durationMs: 28_000, pendingBossChoice: { wave: 6 } });
    const { db } = fakeDb(checkpoint);

    const result = await activeEndless(db, "account-1");
    expect(result.status).toBe(200);
    expect(result.body.stage).toBe("boss-choice");
    expect(result.body.bossDraft).toEqual(endlessBossDraft("endless", 6, run.weekSeed, run.stop.location));
    expect(result.body.fight).toBeUndefined();
  });

  it("commits a valid boss choice before opening the next battle", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 4 };
    const { db, writes } = fakeDb(session(3, {
      run, playerLevel: 35, durationMs: 21_000, pendingBossChoice: { wave: 3 },
    }));
    const draft = endlessBossDraft("endless", 3, run.weekSeed, run.stop.location);

    const result = await chooseEndlessBossReward(db, "account-1", {
      sessionId: "endless-session", boon: draft.boons[0], curse: draft.curses[0], location: draft.locations[1],
    }, 40_000);
    expect(result.status).toBe(200);
    expect(result.body.nextWave).toBe(4);
    expect(result.body.fight).toMatchObject({ wave: 4, ...draft.locations[1] });
    expect(JSON.parse(String(writes[0].args[1])).run.stop).toEqual(draft.locations[1]);
    expect(writes[0].sql).toContain("UPDATE endless_runs_v3 SET current_wave=?");
    expect(JSON.parse(String(writes[0].args[1])).pendingBossChoice).toBeUndefined();
  });

  it("refuses a location the draft did not offer", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 4 };
    const { db } = fakeDb(session(3, { run, playerLevel: 35, durationMs: 0, pendingBossChoice: { wave: 3 } }));
    const draft = endlessBossDraft("endless", 3, run.weekSeed, run.stop.location);
    const result = await chooseEndlessBossReward(db, "account-1", {
      sessionId: "endless-session", boon: draft.boons[0], curse: draft.curses[0], location: { location: "farm", modifier: null },
    }, 40_000);
    expect(result.status).toBe(400);
  });

  it("settles every cleared floor's gold when the player ends early", async () => {
    const run = { ...beginEndlessRun("endless", []), nextWave: 7 };
    const checkpoint = session(6, { run, playerLevel: 45, durationMs: 28_000, pendingBossChoice: { wave: 6 } });
    const { db, batches } = fakeDb(checkpoint);

    const result = await abandonEndless(db, "account-1", "endless-session", 90_000);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ runFinished: true, abandoned: true, deepestFloor: 6, gold: 7_500 });
    expect(batches).toHaveLength(1);
    expect(batches[0].map((statement) => statement.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE balances SET gold=gold+?"),
      expect.stringContaining("INSERT INTO ledger"),
      expect.stringContaining("INSERT INTO endless_leaderboard"),
    ]));
  });

  /** A really won fight at `wave`, so the server's replay settles it for real. */
  function wonFight(wave: number, mode: "endless" | "nightmare" = "endless") {
    const def = (zombiesJson as ZombieDef[]).find((z) => z.key === "ZombieActorZwampThing")!;
    const party = Array.from({ length: 20 }, (_, i) => makeOwned(`z${i}`, def, 0, 0, 5, 0));
    const units = buildPlayerUnits(party, { abilitySlotUnlocked: () => true, playerLevel: 45 });
    const run: EndlessRunState = { ...beginEndlessRun(mode, units), nextWave: wave };
    const config = endlessFightConfig(run, 45);
    const flight = flyFight(endlessSimFor(config), makePilot(EXPERT), { seed: `wave-${wave}` });
    expect(flight.win).toBe(true);
    const row = {
      ...session(wave, { run, playerLevel: 45, durationMs: 0 }),
      mode, fight_config_json: JSON.stringify(config),
      current_json: JSON.stringify({ inventory: {}, storage: { received: {}, stored: {} } }),
    };
    return { row, finish: { sessionId: "endless-session", wave, finalTick: flight.ticks, inputs: flight.inputs } };
  }
  const later = 3_600_000;

  it("pays a floor's loot with the win, granting it before the run advances", async () => {
    const { row, finish } = wonFight(1);
    const { db, batches } = fakeDb(row);
    const result = await finishEndlessWave(db, "account-1", finish, later);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ runFinished: false, nextWave: 2 });
    const [loot] = result.body.floorLoot as { key: string; quantity: number }[];
    const [grant, advance] = batches[0];
    expect(grant.sql).toContain("UPDATE gameplay_documents_v3");
    expect(JSON.parse(String(grant.args[0])).inventory[loot.key]).toBe(loot.quantity);
    expect(advance.sql).toContain("changes()=1");
  });

  it("pays a boss's full roll into its choice checkpoint", async () => {
    const { row, finish } = wonFight(3);
    const { db, batches } = fakeDb(row);
    const result = await finishEndlessWave(db, "account-1", finish, later);
    expect(result.status).toBe(200);
    expect(result.body.awaitingBossChoice).toBe(true);
    expect((result.body.bossLoot as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.parse(String(batches[0][1].args[1])).pendingBossChoice.loot).toEqual(result.body.bossLoot);
  });

  it("pays Nightmare no floor loot until its tables exist", async () => {
    const { row, finish } = wonFight(1, "nightmare");
    const { db, batches, writes } = fakeDb(row);
    const result = await finishEndlessWave(db, "account-1", finish, later);
    expect(result.status).toBe(200);
    expect(result.body.floorLoot).toEqual([]);
    expect(batches).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  /** A run sitting at a boss screen, the army intact. */
  function atBossScreen(wave: number, extra: Row = {}) {
    const def = (zombiesJson as ZombieDef[]).find((z) => z.key === "ZombieActorRegularTier1")!;
    const units = buildPlayerUnits(
      Array.from({ length: 4 }, (_, i) => makeOwned(`z${i}`, def, 0, 0, 0, 0)),
      { abilitySlotUnlocked: () => true, playerLevel: 45 },
    );
    const run = { ...beginEndlessRun("endless", units, "9", (extra.startTier as number) ?? 1), nextWave: wave + 1 };
    return { run, row: session(wave, { run, playerLevel: 45, durationMs: 0, pendingBossChoice: { wave, ...(extra.opening ? { opening: true } : {}) } }) };
  }

  it("applies a new army order with the boss choices, and refuses a made-up one", async () => {
    const { run, row } = atBossScreen(3);
    const draft = endlessBossDraft("endless", 3, run.weekSeed, run.stop.location);
    const order = run.units.map((u) => u.id).reverse();
    const choices = { sessionId: "endless-session", boon: draft.boons[0], curse: draft.curses[0], location: draft.locations[0] };
    const bad = await chooseEndlessBossReward(fakeDb(row).db, "account-1", { ...choices, order: [...order.slice(1), "stored-zombie"] }, 40_000);
    expect(bad.status).toBe(400);
    const { db, writes } = fakeDb(row);
    const good = await chooseEndlessBossReward(db, "account-1", { ...choices, order }, 40_000);
    expect(good.status).toBe(200);
    const saved = JSON.parse(String(writes[0].args[1])).run.units.map((u: { id: string }) => u.id).filter((id: string) => !id.startsWith("temp-"));
    expect(saved).toEqual(order);
  });

  it("drafts each skipped tier in turn, choosing a location only on the last", async () => {
    const run = beginEndlessRun("endless", [], "9", 3);
    const first = fakeDb(session(3, { run, playerLevel: 45, durationMs: 0, pendingBossChoice: { wave: 3, opening: true } }));
    const step = endlessBossDraft("endless", 3, "9", "farm", false);
    expect(step.locations).toEqual([]);
    const result = await chooseEndlessBossReward(first.db, "account-1", {
      sessionId: "endless-session", boon: step.boons[0], curse: step.curses[0],
    }, 40_000);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ stage: "boss-choice", opening: true, tier: 2 });
    expect(result.body.fight).toBeUndefined();
    const last = endlessBossDraft("endless", 6, "9", "farm");
    expect((result.body.bossDraft as { locations: unknown[] }).locations).toEqual(last.locations);
    const second = fakeDb(session(6, { run, playerLevel: 45, durationMs: 0, pendingBossChoice: { wave: 6, opening: true } }));
    const final = await chooseEndlessBossReward(second.db, "account-1", {
      sessionId: "endless-session", boon: last.boons[0], curse: last.curses[0], location: last.locations[0],
    }, 40_000);
    expect(final.body).toMatchObject({ nextWave: 7 });
    expect(final.body.fight).toMatchObject({ wave: 7, ...last.locations[0] });
  });

  it("pays a skipper nothing for going home before its first boss", async () => {
    const run = beginEndlessRun("endless", [], "9", 3);
    const during = fakeDb(session(3, { run, playerLevel: 45, durationMs: 0, pendingBossChoice: { wave: 3, opening: true } }));
    const draft = await abandonEndless(during.db, "account-1", "endless-session", 90_000);
    expect(draft.body).toMatchObject({ deepestFloor: 0, gold: 0 });
    expect(during.batches[0]).toHaveLength(1);
    const floorIn = fakeDb(session(8, { run: { ...run, nextWave: 8 }, playerLevel: 45, durationMs: 0 }));
    const oneFloor = await abandonEndless(floorIn.db, "account-1", "endless-session", 90_000);
    // It cleared floor 7 itself, worth 250 x T3, and nothing else until a boss falls.
    expect(oneFloor.body).toMatchObject({ deepestFloor: 7, gold: 1_875 });
    expect(floorIn.batches[0].map((s) => s.sql).join()).not.toContain("endless_leaderboard");
  });

  it("pays the skipped tiers' gold and scores it once the first boss falls", async () => {
    const run = beginEndlessRun("endless", [], "9", 3);
    const { db, batches } = fakeDb(session(9, { run: { ...run, nextWave: 10 }, playerLevel: 45, durationMs: 0, pendingBossChoice: { wave: 9 } }));
    const result = await abandonEndless(db, "account-1", "endless-session", 90_000);
    expect(result.body).toMatchObject({ deepestFloor: 9, gold: 15_000 });
    const sql = batches[0].map((s) => s.sql).join();
    expect(sql).toContain("INSERT INTO endless_leaderboard");
    expect(sql).toContain("INSERT INTO endless_weekly_leaderboard");
  });

  it("pays first-clear milestones once, tracking the best tier", async () => {
    const { row, finish } = wonFight(3);
    const fresh = fakeDb(row);
    const first = await finishEndlessWave(fresh.db, "account-1", finish, later);
    const zwamps = (first.body.bossLoot as { name: string }[]).filter((r) => r.name === "Zwamp Thing");
    expect(first.body.bossLoot as { name: string }[]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Brain Ticket" })]));
    expect(zwamps.length).toBeLessThanOrEqual(1);
    expect(fresh.batches[0].map((s) => s.sql).join()).toContain("INSERT INTO endless_progress");
    const again = fakeDb({ ...row, best_tier: 1 });
    const repeat = await finishEndlessWave(again.db, "account-1", finish, later);
    expect(repeat.status).toBe(200);
    expect(again.batches[0].map((s) => s.sql).join()).not.toContain("INSERT INTO endless_progress");
  });
});
