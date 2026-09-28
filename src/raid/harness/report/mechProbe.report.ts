// SCRATCH — which dual-invasion mechanics actually fire, and how much, against real prod
// armies. Samples the sim every tick through a wrapping pilot and writes per-flight
// counters to tmp/mechprobe/<raid>.json. Run one raid per worker:
//   npx vitest run --config vitest.mechprobe.config.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import zombiesJson from "../../../../public/assets/zombies.json";
import { buildFight } from "../../buildFight";
import { buildPlayerUnits } from "../../CombatEngine";
import type { BattleSim, SimUnit } from "../../BattleSim";
import { flyFight, type Pilot } from "../pilot";
import { EXPERT, makePilot } from "../pilots";
import { harnessFight } from "../raidFight";
import { makeOwned } from "../../../zombie/types";
import { ABILITY_TIER, abilityTierOf, MAX_VET_RANK } from "../../../zombie/traits";

import { loadProdPools, prodPools, type ProdArmy } from "../prodGrid";
const BY_KEY = new Map((zombiesJson as { key: string }[]).map((z) => [z.key, z]));
const COLS = [40, 45];
const TIERS = [1, 5, 10];
const SEEDS = 1;

function unitsFor(army: ProdArmy, level: number) {
  return buildPlayerUnits(army.units.map((u, i) =>
    makeOwned(`z${i}`, BY_KEY.get(u[0]) as never, 0, 0, Math.min(u[2], MAX_VET_RANK), u[1])), {
    abilityUnlocked: (key) => { const t = abilityTierOf(key); return t > 0 && t <= 4 && ABILITY_TIER[t].includes(key); },
    playerLevel: level,
  });
}

type Any = Record<string, any>;
const priv = (sim: BattleSim) => sim as unknown as Any;

/** A pilot that watches. It forwards every decision to the expert and records counters. */
function watching(inner: Pilot, c: Any): Pilot {
  const seen = new Set<string>();
  let lastBurn = new Set<string>();
  let lastStun = new Set<string>();
  return {
    id: inner.id,
    reset: (s) => inner.reset(s),
    decide(sim, tick) {
      const t = tick * 50;
      const units = sim.units as SimUnit[];
      const boss = units.find((u) => u.isBoss);
      // ---- common ----
      if (boss && boss.state === "structure") c.bossPerchMs += 50;
      if (boss && !boss.alive && c.bossDeathMs === null) c.bossDeathMs = t;
      if (boss && boss.state !== "structure" && c.bossDownMs === null && boss.alive) c.bossDownMs = t;
      // ---- raid 12: rulings ----
      const rulings = sim.activeRulings();
      if (rulings.length) c.rulingMs += 50;
      for (const r of rulings) {
        const k = r.kind === "barred" ? "barred" : r.kind;
        c.rulingKindMs[k] = (c.rulingKindMs[k] ?? 0) + 50;
      }
      for (const u of units) {
        if (u.id.startsWith("squad") && u.state !== "queued" && c.squadInMs === null) c.squadInMs = t;
      }
      // ---- raid 13: duel ----
      const cap = units.find((u) => !!u.chargeCfg);
      if (cap) {
        if (cap.state !== "queued" && c.captainInMs === null) c.captainInMs = t;
        if (cap.alive && cap.state !== "queued") c.captainOutMs += 50;
        if (!cap.alive && c.captainDeathMs === null) c.captainDeathMs = t;
        c.slams = cap.chargeSlamSeq; c.breaks = cap.chargeBreakSeq;
        if (cap.chargeMs > 0) c.windingMs += 50;
      }
      c.smokes = sim.smokeSeq;
      if (priv(sim).ninjaDown) c.ninjaDownMs += 50;
      c.ninjaRetreated = !!priv(sim).ninjaRetreated;
      c.throws = priv(sim).throwCount ?? 0;
      // stuns on zombies (throw stuns, counter stuns, whip, stunAll)
      const stunned = new Set(units.filter((u) => u.team === "player" && u.alive && u.stunMs > 0).map((u) => u.id));
      for (const id of stunned) if (!lastStun.has(id)) c.zombieStuns++;
      lastStun = stunned;
      // ---- raid 14: big top ----
      for (const g of sim.grabbers) if (g.drop && !seen.has(g.id)) { seen.add(g.id); c.trapezes++; }
      const bz = sim.bozoStatus();
      if (bz) { c.bozoMax = Math.max(c.bozoMax, bz.count); if (bz.count > 0) c.bozoMs += 50; }
      const burning = new Set(units.filter((u) => u.team === "player" && u.burnMs > 0 && u.burnWalk).map((u) => u.id));
      for (const id of burning) if (!lastBurn.has(id)) c.fires++;
      lastBurn = burning;
      const garden = units.filter((u) => u.team === "player" && u.alive && u.isGarden && u.stunMs > 0).length;
      if (garden) c.gardenStunMs += 50;
      // ---- raid 15: bubble ----
      c.activations = priv(sim).bubbleActivation ?? 0;
      c.cancelsUsed = 5 - sim.cancelsLeft();
      for (const u of units) {
        if (u.isBubbleRobot && !seen.has(u.id)) { seen.add(u.id); c.robots++; }
        if (u.isSummon && !u.isBubbleRobot && !u.isTurned && !u.isBozoStack && !u.isWall && !seen.has(u.id)) { seen.add(u.id); c.abductees++; }
        if (u.isWall && !seen.has(u.id)) { seen.add(u.id); c.walls++; }
      }
      const cast = sim.bubbleCast();
      if (cast) { const key = `${c.activations}`; if (!seen.has("cast" + key)) { seen.add("cast" + key); for (const a of cast.actions) c.castKinds[a] = (c.castKinds[a] ?? 0) + 1; } }
      return inner.decide(sim, tick);
    },
  };
}

function probe(raidId: number) {
  const out: Any[] = [];
  for (const level of COLS) {
    for (const tier of TIERS) {
      for (const army of prodPools()[String(level)] ?? []) {
        for (let s = 0; s < SEEDS; s++) {
          const seed = `probe:${raidId}:${tier}:${army.id}:${s}`;
          const { spec } = harnessFight({
            raidId, tier, hazards: true, playerLevel: level, playerUnits: unitsFor(army, level), waveSeed: seed,
          });
          const sim = buildFight(spec);
          const c: Any = {
            raidId, tier, level, acct: army.acct, bossPerchMs: 0, bossDeathMs: null, bossDownMs: null,
            rulingMs: 0, rulingKindMs: {}, squadInMs: null,
            captainInMs: null, captainOutMs: 0, captainDeathMs: null, slams: 0, breaks: 0, windingMs: 0,
            smokes: 0, ninjaDownMs: 0, ninjaRetreated: false, throws: 0, zombieStuns: 0,
            trapezes: 0, bozoMax: 0, bozoMs: 0, fires: 0, gardenStunMs: 0,
            activations: 0, cancelsUsed: 0, robots: 0, abductees: 0, walls: 0, castKinds: {},
          };
          const f = flyFight(sim, watching(makePilot(EXPERT), c), { seed });
          const inputs: Any = {};
          for (const i of f.inputs) inputs[i.type] = (inputs[i.type] ?? 0) + 1;
          out.push({ ...c, win: f.win, losses: f.losses, secs: f.secs, timedOut: f.timedOut, inputs, size: army.units.length });
        }
      }
    }
  }
  mkdirSync("tmp/mechprobe", { recursive: true });
  writeFileSync(`tmp/mechprobe/${raidId}.json`, JSON.stringify(out));
  return out.length;
}

describe("mechanic probe", () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  const raid = Number(env?.PROBE_RAID ?? 0);
  for (const id of raid ? [raid] : [12, 13, 14, 15]) {
    it(`raid ${id}`, async () => { await loadProdPools(); expect(probe(id)).toBeGreaterThan(0); }, 3_600_000);
  }
});
