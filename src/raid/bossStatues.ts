// Boss Statues — invasion MILESTONE prizes: the invasion's boss carved in stone on the
// Memorial Statue's plinth, and a golden variation of the same (art baked by
// tools/boss_statues.py).
//
// A REIMPLEMENTATION ADDITION, not a ZF2 drop, so it stays off the binary's 6-tier
// loot tables:
//
//   · the stone statue is handed over on the invasion's 15th win, the golden one on
//     its 50th — a player already past either mark gets it on their next win;
//   · once a statue has been handed over it is an ordinary random chance on every
//     later win: 2% stone, 1% golden;
//   · a statue REPLACES that win's ordinary drop, so a win still pays exactly one item
//     and the whole existing grant path (Received, claim, the result panel) carries it.
//
// "Handed over" is remembered as a flag, NOT read off what the player owns: a statue
// sold back must not re-trigger its milestone, or every win would mint another one.
// The flags ride in the per-raid pity map (server `raid_state_v3.zombie_dry_json`,
// offline `GameState.zombieDryWins`) under their own `statue:` / `goldenStatue:` keys,
// which the rare-zombie streaks never read — that map is server-only and already
// persisted in the same write as the win, so no new column is needed.
//
// The dual invasions (12-15) carve nothing yet.
//
// The eight EPIC bosses (src/epicBoss/catalog.ts) have statues too, wired in as plain
// ITEMS ONLY: baked by tools/boss_statues.py EPIC_STATUES (`epicStatue*` tiles, drops.json,
// the server catalogs, the shared sell price) but nothing grants them yet — settleBossStatue
// never looks at EPIC_BOSS_STATUES and no loot table names them. Their drop rules come later.
//
// Imported by BOTH sides — the server settles it online (v3/raid.ts), RaidManager
// offline — so the rules have one definition.

export interface BossStatue {
  name: string; // drop name (drops.json / Received)
  tile: string; // placeable key
  goldenName: string;
  goldenTile: string;
}

const statue = (name: string, tile: string): BossStatue => ({
  name: `${name} Statue`,
  tile,
  goldenName: `Golden ${name} Statue`,
  goldenTile: `${tile}Golden`,
});

/** KEEP IN SYNC with STATUES in tools/boss_statues.py. */
export const BOSS_STATUES: Readonly<Record<number, BossStatue>> = {
  1: statue("Old McDonnell", "bossStatueOldMcDonnell"),
  2: statue("CorporateVille", "bossStatueCorporateVille"),
  3: statue("Arrrnold", "bossStatueArrrnold"),
  4: statue("Mr. Whiskers", "bossStatueMrWhiskers"),
  5: statue("Bro-Bot", "bossStatueBroBot"),
  6: statue("Alien Overlord", "bossStatueAlien"),
  7: statue("SquiDude", "bossStatueSquiDude"),
  8: statue("Ringmaster", "bossStatueRingmaster"),
  9: statue("Zedzox", "bossStatueZedzox"),
  10: statue("Goffy", "bossStatueGoffy"),
  11: statue("Felix Wonky", "bossStatueFelixWonky"),
};

/** The eight epic bosses' statues, by epic boss id (src/epicBoss/catalog.ts). Items only —
 *  NOTHING GRANTS THESE YET. KEEP IN SYNC with EPIC_STATUES in tools/boss_statues.py. */
export const EPIC_BOSS_STATUES: Readonly<Record<string, BossStatue>> = {
  "dr-groundhog": statue("Dr. Groundhog", "epicStatueDrGroundhog"),
  "bully-frog": statue("Bully Frog", "epicStatueBullyFrog"),
  "rocky-rhino": statue("Rocky Rhino", "epicStatueRockyRhino"),
  "general-larvaelus": statue("General Larvaelus", "epicStatueGeneralLarvaelus"),
  "mystical-mamba": statue("Mystical Mamba", "epicStatueMysticalMamba"),
  "foul-owl": statue("Foul Owl", "epicStatueFoulOwl"),
  "skunkarella": statue("Skunkarella", "epicStatueSkunkarella"),
  "loco-locust": statue("Loco Locust", "epicStatueLocoLocust"),
};

/** Wins of one invasion that hand over its stone / golden statue. */
export const BOSS_STATUE_WINS = 15;
export const GOLDEN_STATUE_WINS = 50;
/** Chance per win AFTER the statue has been handed over. */
export const BOSS_STATUE_RATE = 0.02;
export const GOLDEN_STATUE_RATE = 0.01;

export function bossStatueFor(raidId: number): BossStatue | null {
  return Object.prototype.hasOwnProperty.call(BOSS_STATUES, raidId) ? BOSS_STATUES[raidId] : null;
}

/** The pity-map keys remembering that a milestone statue was handed over. */
export const statueFlagKey = (raidId: number, golden: boolean): string =>
  `${golden ? "goldenStatue" : "statue"}:${raidId}`;

export interface BossStatueSettlement {
  /** The statue this win hands over (its drop name), or null. */
  drop: string | null;
  /** The pity map to store, with any milestone flag this win set. A copy. */
  flags: Record<string, number>;
}

/** Settle one WIN's statue. `wins` is this invasion's win count INCLUDING this one;
 *  `flags` the stored pity map; `goldenRoll` / `roll` two independent uniform [0,1)
 *  draws from the caller's RNG. At most one statue per win: a due milestone first
 *  (stone before golden — the stone mark comes first anyway), then the golden chance,
 *  then the stone chance. */
export function settleBossStatue(
  raidId: number,
  wins: number,
  flags: Readonly<Record<string, number>>,
  goldenRoll: number,
  roll: number,
): BossStatueSettlement {
  const next: Record<string, number> = { ...flags };
  const s = bossStatueFor(raidId);
  if (!s) return { drop: null, flags: next };
  const stoneKey = statueFlagKey(raidId, false);
  const goldenKey = statueFlagKey(raidId, true);
  const hasStone = (flags[stoneKey] ?? 0) > 0;
  const hasGolden = (flags[goldenKey] ?? 0) > 0;
  if (!hasStone && wins >= BOSS_STATUE_WINS) {
    next[stoneKey] = 1;
    return { drop: s.name, flags: next };
  }
  if (!hasGolden && wins >= GOLDEN_STATUE_WINS) {
    next[goldenKey] = 1;
    return { drop: s.goldenName, flags: next };
  }
  if (hasGolden && goldenRoll < GOLDEN_STATUE_RATE) return { drop: s.goldenName, flags: next };
  if (hasStone && roll < BOSS_STATUE_RATE) return { drop: s.name, flags: next };
  return { drop: null, flags: next };
}
