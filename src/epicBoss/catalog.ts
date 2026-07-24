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

export const DR_GROUNDHOG_UNLOCK_LEVEL = 24;
export const OTHER_EPIC_BOSS_UNLOCK_LEVEL = 32;

export function epicBossById(id: string | null | undefined): EpicBossDef | null {
  return id ? BY_ID.get(id) ?? null : null;
}
export function epicBossUnlockLevel(boss: EpicBossDef | string): number {
  const id = typeof boss === "string" ? boss : boss.id;
  return id === DR_GROUNDHOG.id
    ? DR_GROUNDHOG_UNLOCK_LEVEL
    : OTHER_EPIC_BOSS_UNLOCK_LEVEL;
}
export function epicBossHp(def: EpicBossDef, level: number): number {
  const index = Math.max(0, Math.min(def.maxLevel - 1, Math.floor(level) - 1));
  return Math.round(def.baseHp * (def.multipliers[index] ?? 1));
}
