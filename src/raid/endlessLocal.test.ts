import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { makeOwned, type OwnedZombie } from "../zombie/types";
import { buildPlayerUnits } from "./CombatEngine";
import { endlessFreeDayStart } from "./endless";
import { endlessSimFor, type EndlessFightConfig } from "./endlessFight";
import type { EndlessBossLoot } from "./endlessLoot";
import { EndlessLocalEngine, EndlessLocalError, type EndlessLocalSave } from "./endlessLocal";
import { endlessGoldReward } from "./endlessRunRules";
import { flyFight } from "./harness/pilot";
import { EXPERT, makePilot } from "./harness/pilots";

const ZOMBIES = zombiesJson as ZombieDef[];
const STRONG = ZOMBIES.filter((z) => z.key.includes("Tier4") || z.key.includes("Tier5")).slice(0, 12);

function farm(opts: { brains?: number; level?: number; now?: number } = {}) {
  const roster: OwnedZombie[] = STRONG.map((def, i) => makeOwned(`z${i}`, def as never, 0, 0, 5, 0));
  let save: EndlessLocalSave = { bestTier: 0 };
  const paid = { loot: [] as EndlessBossLoot[], gold: 0 };
  let brains = opts.brains ?? 5;
  let concentration = 1;
  let n = 0;
  const engine = new EndlessLocalEngine({
    now: () => opts.now ?? Date.UTC(2026, 10, 11, 12),
    random: () => 0.5,
    newId: () => `id${n++}`,
    level: () => opts.level ?? 45,
    brains: () => brains,
    spendBrains: (k) => (brains >= k ? ((brains -= k), true) : false),
    concentrations: () => concentration,
    useConcentration: () => (concentration > 0 ? (concentration--, true) : false),
    party: (ids) => {
      const found = ids.map((id) => roster.find((z) => z.id === id));
      return found.every(Boolean) ? found as OwnedZombie[] : null;
    },
    buildUnits: (party, level) => buildPlayerUnits(party, { playerLevel: level, abilitySlotUnlocked: () => true }),
    load: () => save,
    store: (next) => { save = next; },
    payLoot: (loot) => paid.loot.push(...loot),
    payGold: (gold) => { paid.gold += gold; },
  });
  return { engine, paid, roster, save: () => save, brains: () => brains, concentration: () => concentration };
}

const ids = (roster: OwnedZombie[]) => roster.map((z) => z.id);

describe("local Endless runs", () => {
  it("starts the day's first run free, then charges the entry", () => {
    const f = farm();
    const first = f.engine.start("endless", ids(f.roster));
    expect(first.freeRun).toBe(true);
    expect(f.brains()).toBe(5);
    f.engine.abandon(first.sessionId);
    const second = f.engine.start("endless", ids(f.roster));
    expect(second.freeRun).toBe(false);
    expect(f.brains()).toBe(4);
    expect(f.save().lastRunStartedAt).toBeGreaterThanOrEqual(endlessFreeDayStart(Date.UTC(2026, 10, 11, 12)));
  });

  it("refuses what the Worker refuses", () => {
    const low = farm({ level: 20 });
    expect(() => low.engine.start("endless", ids(low.roster))).toThrow(EndlessLocalError);
    const f = farm();
    expect(() => f.engine.start("endless", ["nope"])).toThrow(/bad_roster/);
    f.engine.start("endless", ids(f.roster));
    expect(() => f.engine.start("endless", ids(f.roster))).toThrow(/run_in_progress/);
    expect(() => f.engine.start("nightmare", ids(f.roster))).toThrow(/mode_closed/);
  });

  it("answers active with the run in progress, or a 404 that says whether today's run is free", () => {
    const f = farm();
    try { f.engine.active(); throw new Error("expected 404"); } catch (error) {
      expect(error).toBeInstanceOf(EndlessLocalError);
      expect((error as EndlessLocalError).status).toBe(404);
      expect((error as EndlessLocalError).body).toMatchObject({ freeRunAvailable: true });
    }
    const started = f.engine.start("endless", ids(f.roster), 1, true);
    expect(f.concentration()).toBe(0);
    const active = f.engine.active();
    expect(active.sessionId).toBe(started.sessionId);
    expect(active.stage).toBe("battle");
    expect((active as { fight?: EndlessFightConfig }).fight?.wave).toBe(1);
  });

  it("plays a floor through the same replay, pays its loot, and moves on", () => {
    const f = farm();
    const started = f.engine.start("endless", ids(f.roster));
    const config = (started as { fight?: unknown }).fight as EndlessFightConfig;
    const flight = flyFight(endlessSimFor(config), makePilot(EXPERT), { seed: "local-endless" });
    const result = f.engine.finish(started.sessionId, 1, flight.ticks, flight.inputs);
    expect(result).toMatchObject({ runFinished: false, won: true, clearedWave: 1, nextWave: 2 });
    expect(f.paid.loot.length).toBeGreaterThan(0);
    expect(f.save().run?.currentWave).toBe(2);
    expect(f.save().run?.fight?.wave).toBe(2);
  });

  it("ending a run pays depth gold once and leaves nothing to resume", () => {
    const f = farm();
    const started = f.engine.start("endless", ids(f.roster));
    const end = f.engine.abandon(started.sessionId);
    expect(end).toMatchObject({ runFinished: true, abandoned: true, deepestFloor: 0, gold: endlessGoldReward(0) });
    expect(f.save().run).toBeNull();
    expect(() => f.engine.abandon(started.sessionId)).toThrow(/bad_session/);
  });
});
