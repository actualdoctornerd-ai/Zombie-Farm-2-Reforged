import groundhogRaw from "../../public/assets/epic-bosses/dr-groundhog/catalog.json";
import locustRaw from "../../public/assets/epic-bosses/loco-locust/catalog.json";
import frogRaw from "../../public/assets/epic-bosses/bully-frog/catalog.json";
import owlRaw from "../../public/assets/epic-bosses/foul-owl/catalog.json";
import skunkRaw from "../../public/assets/epic-bosses/skunkarella/catalog.json";
import rhinoRaw from "../../public/assets/epic-bosses/rocky-rhino/catalog.json";
import larvaRaw from "../../public/assets/epic-bosses/general-larvaelus/catalog.json";
import mambaRaw from "../../public/assets/epic-bosses/mystical-mamba/catalog.json";
import type { EpicBossDef } from "./types";

export const DR_GROUNDHOG = groundhogRaw as EpicBossDef;
export const LOCO_LOCUST = locustRaw as EpicBossDef;
export const BULLY_FROG = frogRaw as EpicBossDef;
export const FOUL_OWL = owlRaw as EpicBossDef;
export const SKUNKARELLA = skunkRaw as EpicBossDef;
export const ROCKY_RHINO = rhinoRaw as EpicBossDef;
export const GENERAL_LARVAELUS = larvaRaw as EpicBossDef;
export const MYSTICAL_MAMBA = mambaRaw as EpicBossDef;
export const EPIC_BOSSES: readonly EpicBossDef[] = [
  DR_GROUNDHOG, LOCO_LOCUST, BULLY_FROG, FOUL_OWL, SKUNKARELLA,
  ROCKY_RHINO, GENERAL_LARVAELUS, MYSTICAL_MAMBA,
];
const BY_ID = new Map(EPIC_BOSSES.map((boss) => [boss.id, boss]));

// Per-boss unlock level, ordered by HOW STRONG THE PRIZE ZOMBIES ARE — the eight
// events are not interchangeable, so gating them all at one level put Loco Locust's
// Vagabond (the strongest zombie in the game) beside Dr. Groundhog's Omega, which
// deals a quarter of its damage, at the same price and the same player level.
//
// The ladder runs weakest prize first, by the sustained DPS of each boss's best
// reward zombie (str x 10 damage per 2/dex seconds, abilities folded in):
//   24  Dr. Groundhog     Omega Dr. Zombie   307 DPS / 4043 HP   (entry boss, 3 brains)
//   28  Bully Frog        Captain Zombie     307 DPS / 4742 HP
//   30  Rocky Rhino       Brock Coley        662 DPS /  735 HP
//   32  General Larvaelus Zombug             579 DPS / 2275 HP
//   34  Mystical Mamba    Zomtar             662 DPS / 2275 HP
//   38  Foul Owl          Scrooge Zombie     573 DPS / 5110 HP   (the best tank)
//   40  Skunkarella       Madame Zombie      991 DPS / 2200 HP
//   42  Loco Locust       Vagabond Zombie   1102 DPS / 2700 HP
//
// Rocky Rhino and Foul Owl are swapped against a strict DPS sort on purpose: Brock
// Coley is a 40-str/735-HP glass cannon that dies to anything, while Scrooge is the
// highest-HP zombie in the game and worth holding back as a late-ladder reward.
export const EPIC_BOSS_UNLOCK_LEVELS: Readonly<Record<string, number>> = {
  "dr-groundhog": 24,
  "bully-frog": 28,
  "rocky-rhino": 30,
  "general-larvaelus": 32,
  "mystical-mamba": 34,
  "foul-owl": 38,
  "skunkarella": 40,
  "loco-locust": 42,
};
/** Fallback for a boss with no entry above (a future event). */
export const DEFAULT_EPIC_BOSS_UNLOCK_LEVEL = 32;

export function epicBossById(id: string | null | undefined): EpicBossDef | null {
  return id ? BY_ID.get(id) ?? null : null;
}
export function epicBossUnlockLevel(boss: EpicBossDef | string): number {
  const id = typeof boss === "string" ? boss : boss.id;
  return EPIC_BOSS_UNLOCK_LEVELS[id] ?? DEFAULT_EPIC_BOSS_UNLOCK_LEVEL;
}
/** Where in the boss's swing the blow connects, 0..1, from its attack's authored entry
 *  in Attacks.json (baked into the catalog by tools/prep_all_epic_bosses.py).
 *
 *  Presentation-only: the sim's clock decides when a hit lands, this decides which frame
 *  is on screen at that moment. It is nonetheless read on BOTH sides — the client and the
 *  Worker each build the boss unit — so it lives here rather than being written twice.
 *
 *  It is NOT one number for all eight. Six of them swing `EpicBossAttack` and connect at
 *  0.88; Dr. Groundhog and Loco Locust bite (`VideoGameZombieBite`) and connect at 0.25.
 *  Both used to be hardcoded to 0.88, which put their impact frame two thirds of a swing
 *  late — invisible until the attack strip started being driven off this number.
 *
 *  The fallback matches BattleSim's own default for a unit that names no timing. */
export function epicBossDamageTiming(def: EpicBossDef): number {
  const timing = def.unitStats.attacks[0]?.damageTiming;
  return typeof timing === "number" ? timing : 0.5;
}

export function epicBossHp(def: EpicBossDef, level: number): number {
  const index = Math.max(0, Math.min(def.maxLevel - 1, Math.floor(level) - 1));
  return Math.round(def.baseHp * (def.multipliers[index] ?? 1));
}

/** Compounding damage growth per rung climbed. Rung 1 is the catalog's authored value
 *  (tools/prep_all_epic_bosses.py EPIC_BOSS_DAMAGE); every rung above it hits 5% harder
 *  than the one below, so the top of a ten-rung ladder lands at 1.05^9 = 1.55x.
 *
 *  WHY IT COMPOUNDS RATHER THAN GATING ON HP. HP only ever buys attempts — the fight is
 *  capped at 60 s and damage carries over, so a rung too tough to burn in one go is a rung
 *  you burn in two. Damage is the only lever that can say "not with this army": it is
 *  deliberately REGRESSIVE, costing a weak roster far more than a developed one, and that
 *  is the point — the deep rungs of an endgame event should not be walkable by a bad army
 *  with enough patience. The bounding rule (src/epicBoss/combat.test.ts) is what keeps
 *  that from becoming "own the one right tank": a level-appropriate best-mutated headless
 *  must still survive the TOP rung backed by two level-appropriate healers. */
export const EPIC_BOSS_DAMAGE_RUNG_STEP = 0.05;

/** This boss's attack power on `level`.
 *
 *  Computed by repeated multiplication rather than `Math.pow`, which the spec leaves
 *  implementation-approximated: the client's sim and the Worker's replay verifier must
 *  agree BIT for bit or a won fight fails verification, and only exactly-rounded IEEE-754
 *  operations guarantee that. Rounded to 4 dp for the same reason it is rounded at all —
 *  so the number that lands in a stored session config is one a human can read back. */
export function epicBossDamage(def: EpicBossDef, level: number): number {
  const rung = Math.max(1, Math.min(def.maxLevel, Math.floor(level)));
  let scale = 1;
  for (let step = 1; step < rung; step++) scale *= 1 + EPIC_BOSS_DAMAGE_RUNG_STEP;
  return Math.round(def.unitStats.str * scale * 10_000) / 10_000;
}
