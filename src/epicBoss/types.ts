export interface EpicBossAnimation {
  file: string;
  cellWidth: number;
  cellHeight: number;
  frameCount: number;
  frameSeconds: number;
}

export interface EpicBossLoot {
  level: number;
  name: string;
  tile?: string;
  stageActor?: string;
  sprite: string;
}

export interface EpicBossDef {
  id: string;
  sourceId: number;
  name: string;
  costBrains: number;
  durationMs: number;
  fightMs: number;
  retryMs: number;
  encounterMs: number;
  baseHp: number;
  multipliers: number[];
  maxLevel: number;
  introText: string;
  successText: string;
  failedText: string;
  animations: Record<string, EpicBossAnimation>;
  levelAssets: { anchor: string; position: string; sprite: string; z: number }[];
  loot: EpicBossLoot[];
  questIds: number[];
  portrait: string;
  lootIcon: string;
  questIcon: string;
  music: string;
  punchSfx: string;
}

import type { EpicBossProjection } from "../net/protocol";

export type EpicBossRun = EpicBossProjection;

export interface EpicBossAttemptResult {
  run: EpicBossRun;
  defeatedLevel: number | null;
  completed: boolean;
  escaped: boolean;
}
