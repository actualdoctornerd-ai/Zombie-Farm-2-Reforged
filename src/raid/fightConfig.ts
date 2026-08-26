// What the BOSS and the STAGE bring to a fight, derived from authored data alone.
//
// These seven builders turn (raid, stage, enemy stats) into the config objects
// RaidScene hands BattleSim: the projectile table, the special-action list, the alien
// summon rota, the pixel-zombie template, the junk/carrot wall, and the two rescue
// hazards. Every one of them is a pure function of the assets plus the player's level
// and elite profile — none of them reads the save.
//
// They used to be private methods on RaidManager, which meant the only way to obtain a
// faithful fight config was to own a GameState, a ZombieField and a cleared cooldown.
// That is fine for the game and wrong for everything else: the raid lab
// (src/devtools/raidLab.ts) wants to watch one boss action over and over, and the elite
// balance test had already grown its own second copy of the throw builder to get at one.
// A second copy of a rule is a rule that can quietly disagree with itself, so the rules
// live here and RaidManager calls them like everybody else.
//
// The SERVER's verifier derives its own configs from the same helpers this module calls
// (summonConfigFor / turnedUnitFor / eliteWallHp), so nothing here may fork from them.
import type { GameAssets } from "../assets";
import { summonConfigFor } from "./alienStage";
import { eliteWallHp, type EliteProfile } from "./eliteInvasion";
import { rescueHazardHp } from "./hazardTaps";
import { bossThrowIntervalSecs, fightScaledThrow } from "./RaidCatalog";
import type {
  BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, RaidDef, RaidStage,
  SummonConfig,
} from "./types";
import { turnedUnitFor } from "./videoGameStage";

/** The slice of the asset bundle a fight config is built from. */
export type FightAssets = Pick<GameAssets, "enemyStats" | "raidAttacks">;

/** Real grab-hazard art per raid id. Circus = the trapeze girl (extracted from the
 *  stage atlas). */
const GRAB_SPRITE: Record<number, string> = {
  8: "hazard_trapeze_girl.png",
};
/** The Beach crab hazard: identified by the raid's own `initialSpawnClass` rather than a
 *  per-id table, since that field is exactly what the source's obstacle timer spawns. */
const CRAB_ACTOR = "BeachStageActorCrab";
const CRAB_SPRITE = "hazard_beach_crab.png";
/** Authored rescue-hazard HP is 1000; 667 is the tuned touch figure both hazards share
 *  (see hazardTaps.ts, which halves it again for a mouse). */
const RESCUE_HAZARD_HP = 667;

/** The boss's own `bossActions`, or [] when the stage fields no boss / no throwing.
 *
 *  Strictly the BOSS's list. Each robot carries a different special (JunkBot the junk
 *  wall, BrainBot telekinesis, BroBot only faster throws) and the source note is explicit
 *  that "a Robot will only use their special abilities when they are the boss of the
 *  invasion" — so a stage-wide scan for an action is exactly the bug that had BrainBot
 *  summoning JunkBot's walls. */
function bossActionsOf(assets: FightAssets, stage: RaidStage) {
  if (!stage.bossKey || stage.throwingDisabled) return [];
  return assets.enemyStats[stage.bossKey]?.bossActions ?? [];
}

/** Build the boss's projectile config for the selected stage. Returns null when the
 *  stage has no boss OR throwing is disabled on it (early boss waves let the boss come
 *  down to fight without throwing — verified in the real game). The throw interval comes
 *  from the stage's throwSpeed, else the raid default. */
export function bossThrowFor(
  assets: FightAssets,
  raid: RaidDef,
  stage: RaidStage,
  priorWins: number
): BossThrowConfig | null {
  const options = bossActionsOf(assets, stage)
    .filter((a) => a.name === "throw")
    .map((a) => ({
      damage: a.damage ?? 0,
      weight: a.frequency,
      sprite: a.sprite ?? "",
      spriteSize: a.spriteSize ?? 32,
    }))
    .filter((o) => o.sprite);
  if (!options.length) return null;
  // `throwSpeed` is authored in seconds (ZFFightMan's projectile timer).
  const secs = bossThrowIntervalSecs(raid, stage, priorWins);
  // Damage is re-based onto the raid's own rung before the elite profile multiplies it,
  // so a Brain Ticket scales the rebalanced fight rather than the authored chip value.
  return fightScaledThrow({ intervalMs: secs * 1000, options }, raid);
}

/** Build the boss's SPECIAL (non-throw) actions for the selected stage — lasers, AoE
 *  bursts, turn-zombie, etc. Same gate as throws (needs a boss and an "active" stage).
 *  Cast/cooldown come from the source castTime/cooldownTime (seconds); where a special
 *  has no cooldown the cast doubles as the recovery. */
export function bossSpecialsFor(assets: FightAssets, stage: RaidStage): BossSpecial[] {
  return bossActionsOf(assets, stage)
    .filter((a) => a.name !== "throw")
    .map((a) => {
      const castMs = (a.castTime ?? 0) * 1000;
      const cooldownMs = (a.cooldownTime ?? a.castTime ?? 2) * 1000;
      return {
        name: a.name,
        weight: a.frequency,
        castMs,
        cooldownMs,
        damage: a.damage ?? 0,
      };
    });
}

/** The alien boss's abductee queue. `summonBoss` is the ALIEN boss's action and no
 *  other's, and what it summons is a rota of abducted humans rather than a copy of the
 *  wave — see raid/alienStage.ts for the disassembly. */
export function summonFor(
  assets: FightAssets,
  raid: RaidDef,
  stage: RaidStage,
  playerLevel: number,
  elite: EliteProfile | null = null
): SummonConfig | null {
  if (!bossActionsOf(assets, stage).some((a) => a.name === "summonBoss")) return null;
  return summonConfigFor(raid.id, assets.enemyStats, assets.raidAttacks, {
    raidId: raid.id,
    playerLevel,
    elite,
  });
}

/** The pixel zombie `turnZombie` converts a zombie into. `turnZombie` is the Video Games
 *  boss's action and no other's — see raid/videoGameStage.ts. */
export function turnedTemplateFor(
  assets: FightAssets,
  raid: RaidDef,
  stage: RaidStage,
  playerLevel: number,
  elite: EliteProfile | null = null
): CombatUnit | null {
  if (!bossActionsOf(assets, stage).some((a) => a.name === "turnZombie")) return null;
  return turnedUnitFor(raid.id, assets.enemyStats, assets.raidAttacks, {
    raidId: raid.id,
    playerLevel,
    elite,
  });
}

/** The blocker `wall` drops: a high-HP body sized from the action's own `hp`. Null
 *  unless the stage's BOSS carries the action. */
export function wallTemplateFor(
  assets: FightAssets,
  stage: RaidStage,
  elite: EliteProfile | null = null
): CombatUnit | null {
  const wall = bossActionsOf(assets, stage).find((a) => a.name === "wall");
  if (!wall) return null;
  const hp = Math.max(1, Math.round(eliteWallHp(wall.hp ?? 1500, elite)));
  // Use the action's own wall art (Ninja carrotWall.png / Robot junkWall.png); the
  // sourceKey strips ".png" so the renderer keys its preloaded texture by it.
  return {
    id: "wall",
    sourceKey: (wall.sprite ?? "carrotWall.png").replace(/\.png$/i, ""),
    team: "enemy",
    name: "Wall",
    str: 0,
    dex: 1,
    con: Math.round(hp / 10),
    focus: 0,
    hp, // the sim's toSim() uses maxHp directly, so set it to the wall's HP
    maxHp: hp,
    attackCooldownMs: 3500,
    attacks: [{ name: "", frequency: 1, mult: 0 }],
    isBoss: false,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
  };
}

/** Carried-grab hazard config for raids that field one (the Circus Trapeze Artist).
 *  Source HP is 1000; tuned to 667 for desktop input, with 100 damage per tap. The first
 *  sweep starts after ~4s (spawnState wait_4). Returns null for raids with no trapeze.
 *  (The Lawyers cars also `grabZombie` but ship no sprite / different motion — not wired
 *  here.) */
export function grabberFor(raid: RaidDef): GrabberConfig | null {
  const sprite = GRAB_SPRITE[raid.id];
  if (!raid.hasGrab || !sprite) return null;
  return { sprite, hp: rescueHazardHp(RESCUE_HAZARD_HP), tapDamage: 100, spawnDelayMs: 4000 };
}

/** Beach crab hazard config, from the raid's own `initialSpawnClass` + obstacle timer.
 *  Source HP is 1000; tuned to 667 for desktop input (seven 100-damage taps). It holds
 *  for 2.0 s before hauling the zombie off; spawn cadence + concurrent cap come straight
 *  from `obstacleSpawnSecs` / `obstacleLimit` (5 s / 2 on Summer Break).
 *
 *  DELIBERATELY CLIENT-ONLY. The server verifier (server/src/raidVerifier.ts) builds its
 *  sim without this, so the authoritative replay is the un-harassed run. A crab can
 *  therefore only ever make the player's own live result WORSE than the server ceiling,
 *  never better — which is why it needs no anti-cheat plumbing. */
export function crabFor(raid: RaidDef): CrabConfig | null {
  if (raid.initialSpawnClass !== CRAB_ACTOR || !raid.obstacleLimit) return null;
  return {
    sprite: CRAB_SPRITE,
    hp: rescueHazardHp(RESCUE_HAZARD_HP),
    tapDamage: 100,
    spawnMs: (raid.obstacleSpawnSecs > 0 ? raid.obstacleSpawnSecs : 5) * 1000,
    limit: raid.obstacleLimit,
    holdMs: 2000,
  };
}
