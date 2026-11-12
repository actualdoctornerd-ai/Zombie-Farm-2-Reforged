// How deadly the Ninja smoke bomb is to Gardens in Endless. Each real prod army that fields a
// Garden flies Ninja floors 1 and 2 at tiers 2-8 TWICE: once as built, once with the smoke
// bomb removed (same seed). The difference in Garden deaths is what the bomb costs; the
// per-bomb rows say how often the Garden it lands on dies before the ninja does.
//
//   SMOKE_ARMIES=tmp/prod_armies.json SMOKE_OUT=tmp/smoke_probe.txt npx vitest run --config vitest.smokeprobe.config.ts
//
// Armies start each fight at full strength, carrying the boons and curses an expert would
// have drafted by that tier (no casualties from earlier floors), with the expert pilot.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import zombiesJson from "../../../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../CombatEngine";
import {
  applyEndlessCurse, beginEndlessRun, endlessBossDraft, ENDLESS_FIGHTS_PER_LOCATION,
  type EndlessBoon, type EndlessCurse, type EndlessRunState,
} from "../../endless";
import { endlessApplyBoon, endlessFightConfig, endlessSimFor } from "../../endlessFight";
import { makeOwned } from "../../../zombie/types";
import { MAX_VET_RANK } from "../../../zombie/traits";
import { flyFight, type Pilot } from "../pilot";
import { EXPERT, makePilot } from "../pilots";
import type { ZombieDef } from "../../../assets";
import type { SimUnit } from "../../BattleSim";

const ENV = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const BY_KEY = new Map((zombiesJson as ZombieDef[]).map((z) => [z.key, z]));
const COLS = (ENV.SMOKE_COLS ?? "30,40,45").split(",");
const TIERS = [2, 3, 4, 5, 6, 7, 8];

interface Army { id: string; level?: number; units: [string, number, number][] }

function partyFor(army: Army, level: number) {
  const party = army.units.flatMap(([key, mutation, invasions], i) => {
    const def = BY_KEY.get(key);
    return def ? [makeOwned(`z${i}`, def, 0, 0, Math.min(invasions, MAX_VET_RANK), mutation)] : [];
  });
  return buildPlayerUnits(party, { abilitySlotUnlocked: (slot) => slot >= 1 && slot <= 4, playerLevel: level });
}

// Same draft preferences as endless.report.ts, kept short: first general boon, mildest curse.
const CURSE_ORDER: EndlessCurse["kind"][] = [
  "enemy-knockback-headless", "enemy-stun", "enemy-explosion", "headless-stat",
  "enemy-attack-speed", "enemy-health", "enemy-damage",
];
const pickCurse = (c: EndlessCurse[]) => [...c].sort((a, b) => CURSE_ORDER.indexOf(a.kind) - CURSE_ORDER.indexOf(b.kind))[0];
const pickBoon = (b: EndlessBoon[]) => b.find((x) => x.kind === "sharp-teeth" || x.kind === "thick-skin") ?? b[0];

function runAt(army: Army, level: number, tier: number, floor: 1 | 2): EndlessRunState {
  let run = beginEndlessRun("endless", partyFor(army, level), "0", 1);
  for (let wave = ENDLESS_FIGHTS_PER_LOCATION; wave < (tier - 1) * ENDLESS_FIGHTS_PER_LOCATION + 1; wave += ENDLESS_FIGHTS_PER_LOCATION) {
    const draft = endlessBossDraft("endless", wave, run.weekSeed, run.stop.location, true, run);
    run = applyEndlessCurse(endlessApplyBoon(run, pickBoon(draft.boons), level), pickCurse(draft.curses));
  }
  return { ...run, stop: { location: "ninja", modifier: null }, nextWave: (tier - 1) * ENDLESS_FIGHTS_PER_LOCATION + floor };
}

interface Result {
  win: boolean; gardens: number; gardenDeaths: number; deathsInFlank: number;
  bombs: number; bombKilledTarget: number; bombKilledAnyGarden: number; flankMs: number[];
}

/** Watches every tick: who the bomb landed on, and whether that Garden outlived the ninja. */
function watching(inner: Pilot, r: Result): Pilot {
  let seq = 0;
  let open: { ninja: string; target: string; start: number; killedTarget: boolean; killedAny: boolean } | null = null;
  let aliveGardens = new Set<string>();
  return {
    id: inner.id,
    reset: (s) => inner.reset(s),
    decide(sim, tick) {
      const units = sim.units as SimUnit[];
      const gardens = units.filter((u) => u.team === "player" && u.isGarden);
      const now = new Set(gardens.filter((u) => u.alive).map((u) => u.id));
      const died = [...aliveGardens].filter((id) => !now.has(id));
      r.gardenDeaths += died.length;
      if (open) {
        r.deathsInFlank += died.length;
        if (died.includes(open.target)) open.killedTarget = true;
        if (died.length) open.killedAny = true;
      }
      aliveGardens = now;
      const ninja = units.find((u) => u.team === "enemy" && u.isFlanker);
      if (open && (!ninja || !ninja.alive || ninja.id !== open.ninja)) {
        r.flankMs.push((tick - open.start) * 50);
        if (open.killedTarget) r.bombKilledTarget++;
        if (open.killedAny) r.bombKilledAnyGarden++;
        open = null;
      }
      if (sim.smokeSeq !== seq) {
        seq = sim.smokeSeq;
        if (ninja?.alive) {
          r.bombs++;
          const target = gardens.filter((g) => g.alive).sort((a, b) => Math.abs(a.x - ninja.x) - Math.abs(b.x - ninja.x))[0];
          open = { ninja: ninja.id, target: target?.id ?? "", start: tick, killedTarget: false, killedAny: false };
        }
      }
      return inner.decide(sim, tick);
    },
  };
}

function fly(army: Army, level: number, tier: number, floor: 1 | 2, smoke: boolean): Result {
  const config = endlessFightConfig(runAt(army, level, tier, floor), level);
  if (!smoke && config.endlessMechanics) {
    const { ["smoke-bomb-teleport"]: _, ...rest } = config.endlessMechanics.cooldownsMs;
    config.endlessMechanics = { ...config.endlessMechanics, cooldownsMs: rest };
  }
  const sim = endlessSimFor(config);
  const r: Result = {
    win: false, gardens: sim.units.filter((u) => u.team === "player" && u.isGarden).length,
    gardenDeaths: 0, deathsInFlank: 0, bombs: 0, bombKilledTarget: 0, bombKilledAnyGarden: 0, flankMs: [],
  };
  const f = flyFight(sim, watching(makePilot(EXPERT), r), { seed: `smoke:${army.id}:${tier}:${floor}` });
  r.win = f.win;
  return r;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

describe("smoke bomb probe", () => {
  it("measures Garden deaths to the Ninja smoke bomb", async () => {
    const mod = await import(/* @vite-ignore */ ENV.SMOKE_ARMIES ?? "tmp/prod_armies.json");
    const pools = (mod.default ?? mod) as Record<string, Army[]>;
    const lines: string[] = [];
    for (const col of COLS) {
      const level = Number(col);
      const armies = (pools[col] ?? []).filter((a) => partyFor(a, level).some((u) => u.isGarden));
      for (const floor of [1, 2] as const) {
        for (const tier of TIERS) {
          const on = armies.map((a) => fly(a, level, tier, floor, true));
          const off = armies.map((a) => fly(a, level, tier, floor, false));
          const sum = (rs: Result[], k: keyof Result) => rs.reduce((t, r) => t + (r[k] as number), 0);
          const bombs = sum(on, "bombs");
          const g = sum(on, "gardens");
          lines.push(`L${col} T${tier} F${floor} n=${armies.length} gardens/army ${(g / Math.max(1, armies.length)).toFixed(1)}`
            + ` | win ${on.filter((r) => r.win).length}/${off.filter((r) => r.win).length} (bomb/none)`
            + ` | garden deaths ${sum(on, "gardenDeaths")}/${sum(off, "gardenDeaths")} (bomb/none), ${sum(on, "deathsInFlank")} while flanked`
            + ` | bombs ${bombs}: target died ${sum(on, "bombKilledTarget")} (${(100 * sum(on, "bombKilledTarget") / Math.max(1, bombs)).toFixed(0)}%),`
            + ` any garden died ${sum(on, "bombKilledAnyGarden")} (${(100 * sum(on, "bombKilledAnyGarden") / Math.max(1, bombs)).toFixed(0)}%)`
            + ` | ninja lives p50/p90 ${(pct(on.flatMap((r) => r.flankMs), 0.5) / 1000).toFixed(1)}/${(pct(on.flatMap((r) => r.flankMs), 0.9) / 1000).toFixed(1)} s`);
        }
      }
    }
    writeFileSync(ENV.SMOKE_OUT ?? "tmp/smoke_probe.txt", lines.join("\n"));
    expect(lines.length).toBeGreaterThan(0);
  }, 3_600_000);
});
