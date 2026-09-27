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
import {
  bossThrowIntervalSecs, fightScaledThrow, pacedBossThrow, stageRaidId,
} from "./RaidCatalog";
import type {
  BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, MegaBotConfig, RaidDef,
  RaidStage, SummonConfig,
} from "./types";
import { turnedUnitFor } from "./videoGameStage";
import { buildUnitsForKeys } from "./CombatEngine";
import {
  CAPTAIN_HP_MULT, chargeFor, FARMER_MOB_HP_MULT, FARMER_MOB_TIER, FARMER_SQUAD_LEADER, FARMER_SQUAD_MINION, FARMER_SQUAD_MINIONS, MIDPOINT_WAVE_FRAC,
  BUBBLE_RAID_ID, BUBBLE_ROBOT_KEY,
  BIG_TOP_RAID_ID, SIGN_RAID_ID,
} from "./dualInvasion";

/** The pirate captain's authored unit — `str 500, dex 0.4`, the biggest single blow in the
 *  game. He leads the Pirates' own invasion; here he is a ground minion with a charge. */
const PIRATE_CAPTAIN_KEY = "PirateStageActorBoss";

/** The slice of the asset bundle a fight config is built from. */
export type FightAssets = Pick<GameAssets, "enemyStats" | "raidAttacks">;

/** Real grab-hazard art per raid id. Circus = the trapeze girl (extracted from the
 *  stage atlas). Keyed by the STAGE's raid (see RaidCatalog.stageRaidId), so an invasion
 *  fought on the Circus stage gets the trapeze that stage has rather than losing it to a
 *  table lookup on an id the table never heard of. */
const GRAB_SPRITE: Record<number, string> = {
  8: "hazard_trapeze_girl.png",
};
/** The authored midget stack — what a bozo is built as. See bozoFor. */
const CIRCUS_STACK_KEY = "CircusStageActorMinion2";
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
  // Then the boss's own pace (Bro-Bot), on the sized throw — see BOSS_THROW_PACE for why
  // the order is rebalance -> pace -> elite. The Worker's bossThrowOf mirrors this.
  return pacedBossThrow(fightScaledThrow({ intervalMs: secs * 1000, options }, raid), stage);
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
  return wall ? wallUnitFrom(wall, elite) : null;
}

/** One `wall` action's blocker, split out of the builder above because raid 15's wall
 *  comes from the BUBBLE rather than from the stage's boss — the saucer has no `wall` in
 *  its list, so that fight borrows the JunkBot's (see bubbleWallFor). */
function wallUnitFrom(
  wall: { hp?: number; sprite?: string },
  elite: EliteProfile | null
): CombatUnit {
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
  // Raid 14 fights on the Circus stage but its trapeze is a SIMULATED rule of the big top
  // (the drop — see BigTopConfig), not this client-only rescue, so it never gets this one.
  if (raid.id === BIG_TOP_RAID_ID) return null;
  const sprite = GRAB_SPRITE[stageRaidId(raid)];
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

/** Zombies vs Robots — the only invasion the Mega-Robot appears in. The source spawns it
 *  from `ZFFightMan initialSpawn` when `currentEnemy == 5` and nowhere else. Deliberately
 *  keyed on the raid's OWN id, not its stage: it is a mechanic, not presentation (see
 *  RaidCatalog.stageRaidId), and no dual invasion is fought on the Robots stage anyway. */
export const MEGA_BOT_RAID_ID = 5;
/** Eye hitbox HP (`initWithHitBoxSize:` → 2400) and damage per tap (200): 12 taps. */
const MEGA_BOT_EYE_HP = 2400;
const MEGA_BOT_TAP_DAMAGE = 200;

/** Mega-Robot config for raid 5, else null. The eye HP takes the same per-device scaling
 *  as the other rescue hazards (12 taps on touch, 6 clicks with a mouse — see
 *  hazardTaps.ts), which is safe for the same reason: CLIENT-ONLY, never transcribed. */
export function megaBotFor(raid: RaidDef): MegaBotConfig | null {
  if (raid.id !== MEGA_BOT_RAID_ID) return null;
  return { eyeHp: rescueHazardHp(MEGA_BOT_EYE_HP), tapDamage: MEGA_BOT_TAP_DAMAGE };
}

/** The angry farmer mob (raid 12, t3+): Old McDonnell and three farmhands, walking on
 *  together once half the wave is down — the fight's midpoint (see dualInvasion.ts).
 *
 *  Returned as EXTRA enemy units to append to the wave. They carry `deployAtWaveFrac`, which
 *  keeps them off the drip budget: they arrive together at the midpoint rather than waiting
 *  for something to die. `anchorsLine` is left alone: they walk to the ordinary doorway like
 *  the rest of the wave, so there is no station to drag the player's line to.
 *
 *  Both sides build this from the same helper, off the raid id and the pinned tier, for the
 *  same reason every other fight config is shared: a wave the two simulations disagree
 *  about diverges the replay from tick 0. */
export function farmerSquadFor(
  assets: FightAssets,
  raid: RaidDef,
  tier: number,
  elite: EliteProfile | null = null,
  playerLevel = 0
): CombatUnit[] {
  // The angry farmer mob is the t3 rung (docs/POST_45_PROGRESSION.md Part 2B): absent below.
  if (raid.id !== SIGN_RAID_ID || tier < FARMER_MOB_TIER) return [];
  const keys = [
    FARMER_SQUAD_LEADER,
    ...Array.from({ length: FARMER_SQUAD_MINIONS }, () => FARMER_SQUAD_MINION),
  ].filter((key) => assets.enemyStats[key]);
  if (!keys.length) return [];
  // Built as ORDINARY units, never as bosses: the guest faction's leader arrives as a
  // powerful minion, because the sim has one boss slot and the lawyer is in it.
  //
  // AND WITHOUT McDONNELL'S SHOVE. `OldMcDonnellPunch` carries `knockBack` at frequency
  // 100, so on his own farm every single swing throws a zombie 150 units down the lane and
  // re-slots it last. That is a fine mechanic against a wave that trickles one body at a
  // time — the shoved zombie walks back and rejoins. Here it is a disaster: this wave LINES
  // UP (dualInvasion.dualWaveCadence), so a shove does not just interrupt one duel, it
  // carries the zombie out of reach of the whole line, and McDonnell does it on every hit
  // he lands for as long as he is standing. Owner call, 2026-09-19: off for this fight.
  //
  // Scoped to the squad rather than to the attack, so McDonnell keeps his shove on raid 1
  // where it belongs and where it has always worked.
  return buildUnitsForKeys(keys, null, assets.enemyStats, assets.raidAttacks, {
    raidId: raid.id, playerLevel, elite,
  }).map((unit, i) => ({
    ...unit, id: `squad${i}`, deployAtWaveFrac: MIDPOINT_WAVE_FRAC, knockBack: false, knockBackChance: 0,
    hp: Math.round(unit.hp * FARMER_MOB_HP_MULT), maxHp: Math.round(unit.maxHp * FARMER_MOB_HP_MULT),
  }));
}

/** The Ninjas & Pirates ground threat: the pirate captain, appended to the wave carrying
 *  his charge-up slam.
 *
 *  He is the guest faction's boss arriving as a POWERFUL MINION — the ninja holds the one
 *  boss slot — so he is built as an ordinary unit. He walks on at the fight's MIDPOINT
 *  (`deployAtWaveFrac`, like the farmer mob) and the rest of the wave stands down while he
 *  is out: see the duel in dualInvasion.ts. */
export function pirateCaptainFor(
  assets: FightAssets,
  raid: RaidDef,
  tier: number,
  elite: EliteProfile | null = null,
  playerLevel = 0
): CombatUnit[] {
  const charge = chargeFor(raid.id, tier);
  if (!charge || !assets.enemyStats[PIRATE_CAPTAIN_KEY]) return [];
  const [unit] = buildUnitsForKeys(
    [PIRATE_CAPTAIN_KEY], null, assets.enemyStats, assets.raidAttacks,
    { raidId: raid.id, playerLevel, elite }
  );
  return unit
    ? [{
      ...unit, id: "captain", charge, deployAtWaveFrac: MIDPOINT_WAVE_FRAC,
      hp: Math.round(unit.hp * CAPTAIN_HP_MULT), maxHp: Math.round(unit.maxHp * CAPTAIN_HP_MULT),
    }]
    : [];
}

/** The stacking little man a bozo is built as (raid 14, t5+): the Circus fight's own midget
 *  stack, at the rung's profile. The sim grows ONE stack unit a bozo at a time from it — see
 *  BattleSim's bozo stack. Null on every other raid. */
export function bozoFor(
  assets: FightAssets,
  raid: RaidDef,
  elite: EliteProfile | null = null,
  playerLevel = 0
): CombatUnit | null {
  if (raid.id !== BIG_TOP_RAID_ID || !assets.enemyStats[CIRCUS_STACK_KEY]) return null;
  const [unit] = buildUnitsForKeys(
    [CIRCUS_STACK_KEY], null, assets.enemyStats, assets.raidAttacks,
    { raidId: raid.id, playerLevel, elite }
  );
  return unit ? { ...unit, id: "bozo" } : null;
}

/** The robot the saucer's bubble beams down (raid 15), built at the rung's profile like
 *  the rest of the wave. The robots used to be IN the wave, and then a single escort on a
 *  clock; now they arrive when the saucer summons one (dualInvasion.BUBBLE_ROBOT_KEY), and
 *  only one may stand at a time. Null on every other raid. */
export function bubbleRobotFor(
  assets: FightAssets,
  raid: RaidDef,
  elite: EliteProfile | null = null,
  playerLevel = 0
): CombatUnit | null {
  if (raid.id !== BUBBLE_RAID_ID || !assets.enemyStats[BUBBLE_ROBOT_KEY]) return null;
  const [unit] = buildUnitsForKeys(
    [BUBBLE_ROBOT_KEY], null, assets.enemyStats, assets.raidAttacks,
    { raidId: raid.id, playerLevel, elite }
  );
  return unit ? { ...unit, id: "robot" } : null;
}

/** The wall the BUBBLE puts up (raid 15). Every other raid's wall belongs to a boss action
 *  and is built from the stage's own boss; the saucer has no `wall` in its list, so this
 *  fight borrows the JunkBot's — which is the guest heavy standing on the field anyway. */
export function bubbleWallFor(
  assets: FightAssets,
  raid: RaidDef,
  elite: EliteProfile | null = null
): CombatUnit | null {
  if (raid.id !== BUBBLE_RAID_ID) return null;
  const action = assets.enemyStats[BUBBLE_ROBOT_KEY]?.bossActions?.find((a) => a.name === "wall");
  if (!action) return null;
  return wallUnitFrom(action, elite);
}
