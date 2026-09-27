// Per-ARMY results for a few cells, so the column can be bootstrapped and jackknifed.
// The grid aggregates per cell, which cannot answer "is this one player".
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFight } from "../../buildFight";
import { buildPlayerUnits } from "../../CombatEngine";
import { flyFight } from "../pilot";
import { EXPERT, makePilot } from "../pilots";
import { harnessFight } from "../raidFight";
import { makeOwned } from "../../../zombie/types";
import { ABILITY_TIER, abilityTierOf, MAX_VET_RANK } from "../../../zombie/traits";
import zombiesJson from "../../../../public/assets/zombies.json";
import prodArmiesJson from "../../../../tmp/prod_armies.json";

const CAT = new Map((zombiesJson as any[]).map((z) => [z.key, z]));
const pools = prodArmiesJson as any;
const SEEDS = 6; // more seeds than the grid: we want the ARMY's mean, not the cell's

describe("prod probe", () => {
  it("emits per-army results for the L35/L40/L45 columns", () => {
    const out: any[] = [];
    const targets: [number, number][] = [[9, 0], [12, 1], [6, 0], [15, 1]];
    for (const level of [35, 40, 45]) {
      for (const army of pools[String(level)]) {
        const units = () => buildPlayerUnits(
          army.units.map((u: any, i: number) =>
            makeOwned(`z${i}`, CAT.get(u[0]), 0, 0, Math.min(u[2], MAX_VET_RANK), u[1])),
          { abilityUnlocked: (k: string) => { const t = abilityTierOf(k); return t > 0 && t <= 4 && ABILITY_TIER[t].includes(k); },
            playerLevel: level });
        for (const [raidId, tier] of targets) {
          let losses = 0, wins = 0;
          for (let s = 0; s < SEEDS; s++) {
            const seed = `p${raidId}:${tier}:${army.id}:${s}`;
            const { spec } = harnessFight({ raidId, tier: tier || undefined, hazards: true,
              playerLevel: level, playerUnits: units(), waveSeed: seed });
            const f = flyFight(buildFight(spec), makePilot(EXPERT), { seed });
            losses += f.losses; if (f.win) wins++;
          }
          out.push({ level, raidId, tier, acct: army.acct, id: army.id,
            size: army.units.length, meanLosses: losses / SEEDS, winRate: wins / SEEDS });
        }
      }
    }
    mkdirSync("tmp/probe", { recursive: true });
    writeFileSync("tmp/probe/perarmy.json", JSON.stringify(out));
    expect(out.length).toBeGreaterThan(0);
  }, 3_600_000);
});
