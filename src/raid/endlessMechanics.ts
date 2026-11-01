import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import type { GameAssets } from "../assets";
import { buildUnitsForKeys } from "./CombatEngine";
import { wallTemplateFor } from "./fightConfig";
import { scaleEndlessEnemy, type EndlessCurse, type EndlessWavePlan } from "./endless";
import { turnedUnitFor } from "./videoGameStage";
import type { CombatUnit, EndlessStageMechanics, RaidStage } from "./types";

const DEFAULT_ASSETS = {
  enemyStats: enemyStatsJson as GameAssets["enemyStats"],
  raidAttacks: attacksJson as GameAssets["raidAttacks"],
};

/** Resolve the plan's timed terrain rules into the same combat templates used by raids.
 *  Pass the returned object to RaidScene/buildFight for both live and headless fights. */
export function buildEndlessStageMechanics(
  plan: EndlessWavePlan,
  playerLevel = 30,
  assets: Pick<GameAssets, "enemyStats" | "raidAttacks"> = DEFAULT_ASSETS,
  curses: readonly EndlessCurse[] = [],
): EndlessStageMechanics {
  const enemyTemplate = (sourceKey: string, raidId: number): CombatUnit | null => {
    const built = buildUnitsForKeys([sourceKey], null, assets.enemyStats, assets.raidAttacks, {
      raidId,
      playerLevel,
    })[0];
    return built ? scaleEndlessEnemy(built, plan, curses) : null;
  };

  const mechanics: EndlessStageMechanics = { cooldownsMs: plan.mechanicCooldownsMs };
  if (plan.location === "ninja") {
    mechanics.flankerTemplate = enemyTemplate("NinjaStageActorGirl", 3);
    const wall = wallTemplateFor(assets, {
      enemyKeys: [],
      bossKey: "NinjaStageActorBoss",
    } satisfies RaidStage);
    if (wall) {
      wall.maxHp = Math.max(1, Math.round(wall.maxHp * plan.healthScale));
      wall.hp = wall.maxHp;
      wall.con = Math.ceil(wall.maxHp / 100);
      mechanics.wallTemplate = wall;
    }
  } else if (plan.location === "alien") {
    const beamIns = [
      ["FarmStageActorFarmhand", 1], ["NinjaStageActorGirl", 3],
      ["FarmStageActorLumberjack", 1], ["PirateStageActorSwashbuckler", 4],
      ["VideoGameStageGhostActor", 9],
    ] as const;
    const [source, sourceRaid] = beamIns[Math.min(beamIns.length - 1, Math.floor((plan.wave - 1) / 4))];
    mechanics.reinforcementTemplate = enemyTemplate(source, sourceRaid);
  } else if (plan.location === "video-game") {
    const pixel = turnedUnitFor(9, assets.enemyStats, assets.raidAttacks, {
      raidId: 9,
      playerLevel,
    });
    mechanics.turnedTemplate = pixel ? scaleEndlessEnemy(pixel, plan, curses) : null;
  }
  return mechanics;
}
