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
  /** Rungs in this event's ladder. Every boss runs 10, and each rung sums TWO of ZF2's
   *  authored HP multipliers (EpicBossHP.json), so an event carries exactly the HP it
   *  always did — 645x `baseHp` — in half as many fights.
   *
   *  Two cuts got it here. The seven bosses that advertised 40 were padding levels 21-40
   *  with a copy of level 20's multiplier, so the back half was 20 more fights at an
   *  unchanging 107x; that padding went first (40 -> 20). The bottom half of what was
   *  left was then a formality for any real army — a rung costs at least one attempt
   *  however far you overkill it — so pairs were merged (20 -> 10), which deletes those
   *  without touching the rungs where HP genuinely gates progress. */
  maxLevel: number;
  introText: string;
  successText: string;
  failedText: string;
  unitStats: {
    str: number;
    dex: number;
    con: number;
    /** `damageTiming` is the attack's authored 0..1 connect point (Attacks.json),
     *  baked in by the prep tool. Absent only if an attack is missing from that file. */
    attacks: { name: string; frequency: number; mult?: number; damageTiming?: number }[];
  };
  /** Optional non-throw boss actions, shared by the live client and replay verifier. */
  specials?: { name: string; weight: number; castMs: number; cooldownMs: number; damage: number }[];
  /** Hidden catalog entry used for development; it cannot be activated through the game. */
  availableInGame?: boolean;
  animations: Record<string, EpicBossAnimation>;
  levelAssets: { anchor: string; position: string; sprite: string; z: number }[];
  loot: EpicBossLoot[];
  questIds: string[];
  portrait: string;
  lootIcon: string;
  questIcon: string;
  bossTexture: string;
  music: string;
  punchSfx: string;
  /** True when shipped art survived without the original gameplay/atlas metadata. */
  /** True for the three bosses whose atlases shipped with no frame metadata. Their
   *  combat art is recovered from the sheet by geometry and their animation ordering
   *  is hand-authored (tools/art/epic-boss-frames), rather than read from ZF2. */
  reconstructed?: boolean;
  /** [x, y, w, h] of `bossTexture` inside that atlas — present only when the art was
   *  cut from the sheet, which is what makes it combat art rather than a menu card.
   *  Loose about its length because it arrives through a JSON import. */
  staticFrame?: number[];
}

import type { EpicBossProjection } from "../net/protocol";

export type EpicBossRun = EpicBossProjection;

export interface EpicBossAttemptResult {
  run: EpicBossRun;
  defeatedLevel: number | null;
  completed: boolean;
  escaped: boolean;
}
