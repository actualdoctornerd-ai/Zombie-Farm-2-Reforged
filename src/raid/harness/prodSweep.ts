// SCRATCH — per-row difficulty sweep over real prod parties, for the pre-dual re-tune.
// Scales the IN-FORCE profile (story or elite) in place: str and specialDamage by L,
// con/bossCon by B. Throws, dex, walls untouched (the throw is floored separately).
import prodArmiesJson from "../../../tmp/prod_armies.json";
import { buildFight } from "../buildFight";
import { buildPlayerUnits } from "../CombatEngine";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { makeOwned, type OwnedZombie } from "../../zombie/types";
import { ABILITY_TIER, abilityTierOf, MAX_VET_RANK } from "../../zombie/traits";
import zombiesJson from "../../../public/assets/zombies.json";
import { ELITE_PROFILES, STORY_PROFILES, type EliteProfile } from "../eliteInvasion";
import type { ZombieDef } from "../types";

const BY_KEY = new Map((zombiesJson as ZombieDef[]).map((z) => [z.key, z]));
type ProdUnit = [string, number, number];
interface ProdArmy { id: string; acct: string; units: ProdUnit[] }
const POOLS = prodArmiesJson as unknown as Record<string, ProdArmy[]>;

export const SWEEP_ROWS: { raidId: number; elite: boolean }[] = JSON.parse(
  process.env.SWEEP_ROWS ?? '[[5,0],[3,1],[6,0],[4,1],[5,1],[9,0],[6,1],[9,1]]'
).map(([raidId, e]: [number, number]) => ({ raidId, elite: !!e }));
export const SWEEP_KNOBS: [number, number][] = JSON.parse(
  process.env.SWEEP_KNOBS ?? "[[1,1],[1.5,1],[2,1],[3,1],[4,1],[6,1],[2,1.4],[3,1.4]]");
export const SWEEP_COLS: number[] = JSON.parse(process.env.SWEEP_COLS ?? "[25,30,35,40,45]");
export const SWEEP_SEEDS = Number(process.env.SWEEP_SEEDS ?? 2);

function unitsFor(army: ProdArmy, playerLevel: number) {
  const party: OwnedZombie[] = army.units.map((u, i) =>
    makeOwned(`z${i}`, BY_KEY.get(u[0])!, 0, 0, Math.min(u[2], MAX_VET_RANK), u[1]));
  return buildPlayerUnits(party, {
    abilityUnlocked: (key) => { const t = abilityTierOf(key); return t > 0 && t <= 4 && ABILITY_TIER[t].includes(key); },
    playerLevel,
  });
}

function withProfile<T>(raidId: number, elite: boolean, L: number, B: number, fn: () => T): T {
  const table = (elite ? ELITE_PROFILES : STORY_PROFILES) as Record<number, EliteProfile>;
  const orig = table[raidId];
  const base: EliteProfile = orig ?? { str: 1, con: 1, dex: 1, throwDamage: 1, throwRate: 1, wallHp: 1, specialDamage: 1 };
  table[raidId] = { ...base, str: base.str * L, specialDamage: base.specialDamage * L,
    con: base.con * B, bossCon: base.bossCon !== undefined ? base.bossCon * B : (B !== 1 ? base.con * B : undefined) };
  try { return fn(); } finally { if (orig) table[raidId] = orig; else delete table[raidId]; }
}

export function runSweepShard(shard: number, shards: number) {
  const jobs = SWEEP_ROWS.flatMap((r) => SWEEP_KNOBS.flatMap((k) => SWEEP_COLS.map((c) => ({ r, k, c }))));
  const out: any[] = [];
  for (let i = shard; i < jobs.length; i += shards) {
    const { r, k, c } = jobs[i];
    for (const army of POOLS[String(c)] ?? []) {
      for (let s = 0; s < SWEEP_SEEDS; s++) {
        const seed = `${r.raidId}:0:${r.elite ? "e" : "b"}:${army.id}:${s}`;
        const f = withProfile(r.raidId, r.elite, k[0], k[1], () => {
          const { spec } = harnessFight({ raidId: r.raidId, elite: r.elite, hazards: true,
            playerLevel: c, playerUnits: unitsFor(army, c), waveSeed: seed });
          return flyFight(buildFight(spec), makePilot(EXPERT), { seed });
        });
        out.push([r.raidId, r.elite ? 1 : 0, k[0], k[1], c, army.acct, army.id, s,
          f.win ? 1 : 0, f.losses, f.timedOut ? 1 : 0, f.deadlocked ? 1 : 0, army.units.length, Math.round(f.secs)]);
      }
    }
  }
  return out;
}
