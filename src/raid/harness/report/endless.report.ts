// Endless runs flown by real prod armies, floor by floor, until each run dies. Prints how deep
// each level band gets and how long its fights take; the clocks are tuned against this.
//
//   ENDLESS_ARMIES=<file> npx vitest run --config vitest.endless.config.ts
//
// ENDLESS_ARMIES: { "<level column>": [{ id, acct, level, units: [[key, mutation, invasions]] }] }.
// Optional overrides for comparing clocks: ENDLESS_REG_S, ENDLESS_ALIEN_S, ENDLESS_BOSS_S, ENDLESS_OT_S.
// Writes the table to ENDLESS_OUT (default tmp/endless_report.txt), raw floors to ENDLESS_DUMP.
// Writes the table to ENDLESS_OUT (default tmp/endless_report.txt), raw floors to ENDLESS_DUMP.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import zombiesJson from "../../../../public/assets/zombies.json";
import { buildPlayerUnits } from "../../CombatEngine";
import {
  applyEndlessCurse, applyEndlessStop, beginEndlessRun, endlessMaxStartTier, endlessBossDraft, endlessWavePlan,
  ENDLESS_FIGHTS_PER_LOCATION, type EndlessBoon, type EndlessCurse, type EndlessMode, type EndlessRunState,
} from "../../endless";
import { endlessApplyBoon, endlessCarryFromSim, endlessFightConfig, endlessSimFor } from "../../endlessFight";
import { makeOwned } from "../../../zombie/types";
import { MAX_VET_RANK } from "../../../zombie/traits";
import { flyFight } from "../pilot";
import { COMPETENT, EXPERT, makePilot, type PilotProfile } from "../pilots";
import type { ZombieDef } from "../../../assets";

const ENV = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const BY_KEY = new Map((zombiesJson as ZombieDef[]).map((z) => [z.key, z]));
const MAX_WAVE = 60;

interface Army { id: string; level: number; units: [string, number, number][] }
interface Floor { wave: number; location: string; modifier: string | null; boss: boolean; win: boolean; secs: number; losses: number; alive: number; timedOut: boolean; overtime: boolean }

function partyFor(army: Army) {
  const party = army.units.flatMap(([key, mutation, invasions], i) => {
    const def = BY_KEY.get(key);
    return def ? [makeOwned(`z${i}`, def, 0, 0, Math.min(invasions, MAX_VET_RANK), mutation)] : [];
  });
  return buildPlayerUnits(party, { abilitySlotUnlocked: (slot) => slot >= 1 && slot <= 4, playerLevel: army.level });
}

/** A sensible player's pick: damage first, then the deployment boons, and the curses that
 *  cost a mixed army least. */
function boonScore(run: EndlessRunState, b: EndlessBoon): number {
  return b.kind === "damage" ? 5 : b.kind === "temporary-zombie" ? 5
    : b.kind === "opening-deploy" ? (run.openingDeploy >= 3 ? 0 : 4)
    : b.kind === "vanguard" ? 3 : b.kind === "deployment" ? 3 : 1;
}
const pickBoon = (run: EndlessRunState, boons: EndlessBoon[]) =>
  [...boons].sort((a, b) => boonScore(run, b) - boonScore(run, a))[0];
const CURSE_ORDER: EndlessCurse["kind"][] = [
  "enemy-knockback-headless", "enemy-stun", "enemy-explosion", "headless-stat",
  "enemy-attack-speed", "enemy-health", "enemy-damage",
];
const pickCurse = (curses: EndlessCurse[]) =>
  [...curses].sort((a, b) => CURSE_ORDER.indexOf(a.kind) - CURSE_ORDER.indexOf(b.kind))[0];

function flyRun(army: Army, mode: EndlessMode, profile: PilotProfile): Floor[] {
  // ENDLESS_START=<tier>: skip as far as the army's level allows, drafting the skipped tiers.
  const startTier = Math.min(Number(ENV.ENDLESS_START ?? 1), endlessMaxStartTier(mode, army.level));
  let run = beginEndlessRun(mode, partyFor(army), ENV.ENDLESS_WEEK ?? "0", startTier);
  for (let wave = ENDLESS_FIGHTS_PER_LOCATION; wave < run.startWave; wave += ENDLESS_FIGHTS_PER_LOCATION) {
    const last = wave + ENDLESS_FIGHTS_PER_LOCATION >= run.startWave;
    const draft = endlessBossDraft(mode, wave, run.weekSeed, run.stop.location, last);
    run = applyEndlessCurse(endlessApplyBoon(run, pickBoon(run, draft.boons), army.level), pickCurse(draft.curses));
    if (last) run = applyEndlessStop(run, draft.locations[Number(ENV.ENDLESS_ROUTE ?? 0)] ?? draft.locations[0]);
  }
  const floors: Floor[] = [];
  while (run.nextWave <= MAX_WAVE && run.units.some((u) => u.alive)) {
    const wave = run.nextWave;
    const config = endlessFightConfig(run, army.level);
    const plan = endlessWavePlan(mode, wave, run.stop, run.weekSeed);
    const boss = plan.bossGate;
    const clock = Number(boss ? ENV.ENDLESS_BOSS_S : plan.location === "alien" ? ENV.ENDLESS_ALIEN_S : ENV.ENDLESS_REG_S);
    if (clock) config.timeLimitMs = clock * 1000;
    if (ENV.ENDLESS_OT_S) config.doOrDieMs = Number(ENV.ENDLESS_OT_S) * 1000;
    const sim = endlessSimFor(config);
    const f = flyFight(sim, makePilot(profile), { seed: `${army.id}:${wave}` });
    const overtime = sim.doOrDieMs > 0 && f.secs > sim.timeLimitMs / 1000;
    floors.push({
      wave, location: plan.location, modifier: plan.modifier, boss, win: f.win, secs: f.secs, losses: f.losses,
      alive: f.survivors, timedOut: f.timedOut, overtime,
    });
    if (!f.win) break;
    run = endlessCarryFromSim(run, sim);
    if (boss) {
      const draft = endlessBossDraft(mode, wave, run.weekSeed, run.stop.location);
      // ENDLESS_PICKS: "worst" reverses both preferences, "first" takes the first of each, so
      // the gap between them is how much the boss choices are worth.
      const picks = ENV.ENDLESS_PICKS;
      const boon = picks === "first" ? draft.boons[0]
        : picks === "worst" ? [...draft.boons].reverse().sort((a, b) => boonScore(run, a) - boonScore(run, b))[0]
        : pickBoon(run, draft.boons);
      const curse = picks === "first" ? draft.curses[0]
        : picks === "worst" ? [...draft.curses].sort((a, b) => CURSE_ORDER.indexOf(b.kind) - CURSE_ORDER.indexOf(a.kind))[0]
        : pickCurse(draft.curses);
      // ENDLESS_ROUTE=1 takes the second location option instead of the first.
      const stop = draft.locations[Number(ENV.ENDLESS_ROUTE ?? 0)] ?? draft.locations[0];
      run = applyEndlessStop(applyEndlessCurse(endlessApplyBoon(run, boon, army.level), curse), stop);
    }
  }
  return floors;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

describe("Endless balance report", () => {
  it("flies every army until its run dies", async () => {
    // A non-literal import, so the typecheck never needs the snapshot (see prodGrid.ts).
    const armiesPath = ENV.ENDLESS_ARMIES ?? "tmp/endless_armies.json";
    const mod = await import(/* @vite-ignore */ armiesPath);
    const pools = (mod.default ?? mod) as Record<string, Army[]>;
    const mode = (ENV.ENDLESS_MODE ?? "endless") as EndlessMode;
    const pilots = (ENV.ENDLESS_PILOTS ?? "expert").split(",").map((id) => id === "competent" ? COMPETENT : EXPERT);
    const lines: string[] = [];
    const dump: Record<string, unknown> = {};
    for (const profile of pilots) {
      for (const [col, armies] of Object.entries(pools)) {
        const runs = armies.map((a) => flyRun(a, mode, profile));
        dump[`${profile.id}:${col}`] = runs;
        const deepest = runs.map((r) => r.filter((f) => f.win).length);
        const tiers = deepest.map((d) => Math.floor(d / ENDLESS_FIGHTS_PER_LOCATION));
        const all = runs.flat();
        const reg = all.filter((f) => !f.boss && f.win).map((f) => f.secs);
        const boss = all.filter((f) => f.boss && f.win).map((f) => f.secs);
        const minutes = runs.map((r) => r.reduce((t, f) => t + f.secs, 0) / 60);
        lines.push(`${profile.id} L${col} n=${armies.length} floors p10/50/90 ${pct(deepest, .1)}/${pct(deepest, .5)}/${pct(deepest, .9)} max ${Math.max(...deepest)}`
          + ` | tier>=1 ${tiers.filter((t) => t >= 1).length} >=3 ${tiers.filter((t) => t >= 3).length} >=5 ${tiers.filter((t) => t >= 5).length} >=7 ${tiers.filter((t) => t >= 7).length} >=8 ${tiers.filter((t) => t >= 8).length}`
          + ` | reg win s p50/90/99 ${pct(reg, .5).toFixed(0)}/${pct(reg, .9).toFixed(0)}/${pct(reg, .99).toFixed(0)}`
          + ` | boss win s p50/90/99 ${pct(boss, .5).toFixed(0)}/${pct(boss, .9).toFixed(0)}/${pct(boss, .99).toFixed(0)}`
          + ` | run min p50/90 ${pct(minutes, .5).toFixed(0)}/${pct(minutes, .9).toFixed(0)}`
          + ` | losses/win ${(all.filter((f) => f.win).reduce((t, f) => t + f.losses, 0) / Math.max(1, all.filter((f) => f.win).length)).toFixed(2)}`
          + ` | end: timeout ${runs.filter((r) => r[r.length - 1]?.timedOut).length} OTwins ${all.filter((f) => f.win && f.overtime).length}`);
        // Where runs die, and how long winning fights took at each tier.
        const byTier = new Map<number, number[]>();
        for (const f of all.filter((x) => x.win && !x.boss)) (byTier.get(Math.ceil(f.wave / ENDLESS_FIGHTS_PER_LOCATION)) ?? byTier.set(Math.ceil(f.wave / ENDLESS_FIGHTS_PER_LOCATION), []).get(Math.ceil(f.wave / ENDLESS_FIGHTS_PER_LOCATION))!).push(f.secs);
        lines.push(`   reg p50 by tier: ${[...byTier].sort((a, b) => a[0] - b[0]).map(([t, xs]) => `T${t}:${pct(xs, .5).toFixed(0)}`).join(" ")}`);
      }
    }
    const text = lines.join("\n");
    writeFileSync(ENV.ENDLESS_OUT ?? "tmp/endless_report.txt", text);
    if (ENV.ENDLESS_DUMP) writeFileSync(ENV.ENDLESS_DUMP, JSON.stringify(dump));
    expect(lines.length).toBeGreaterThan(0);
  }, 3_600_000);
});
