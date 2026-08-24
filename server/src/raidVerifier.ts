import raidsJson from "../../public/assets/raids/raids.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { BattleSim, type BattleSimSnapshot } from "../../src/raid/BattleSim";
import { buildEnemyUnits, buildPlayerUnits } from "../../src/raid/CombatEngine";
import {
  fightStage,
  minArmyFor,
  bossThrowIntervalSecs,
  fightScaledThrow,
  resolveStageWave,
  seededRandom,
  ARMY_CAP,
} from "../../src/raid/RaidCatalog";
import { makeOwned } from "../../src/zombie/types";
import { ABILITY_TIER, abilityTierOf } from "../../src/zombie/traits";
import { advanceRaidSegment, replayRaid, RAID_RULESET_VERSION, type RaidReplayInput, type ReplayResult } from "../../src/raid/replay";
import type {
  AttackDef,
  BossSpecial,
  BossThrowConfig,
  CombatUnit,
  EnemyStat,
  RaidDef,
  RaidStage,
  GrabberConfig,
  SummonConfig,
  WaveCadence,
} from "../../src/raid/types";
import { summonConfigFor, waveCadenceFor } from "../../src/raid/alienStage";
import { turnedUnitFor } from "../../src/raid/videoGameStage";
import {
  eliteBossSpecials,
  eliteBossThrow,
  eliteProfile,
  eliteWallHp,
  type EliteProfile,
} from "../../src/raid/eliteInvasion";
import { levelForXp } from "./levels";
import { activeBonusHeadId, farmerMultiplier } from "../../src/farmer";
import {
  PVP_ARMY_SIZE,
  PVP_DEFENSE_CAP,
  PVP_MIN_LEVEL,
  PVP_RAID_ID,
  PVP_WAVE_CADENCE,
  PVP_DEFENSE_MODE_DEFAULT,
  armyScore,
  enemyCopies,
  formationDefenseUnits,
  groupTierPoints,
  pvpTierForPoints,
  selectAutoDefense,
  selectFormationDefense,
  type PvpConfigInfo,
  type PvpDefenseMode,
} from "../../src/raid/pvp";
import { parseRosterColor } from "./v3/rosterColor";

export { RAID_RULESET_VERSION };
export type { RaidReplayInput };

interface RosterRow {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
}

export interface PinnedRaidConfig {
  raidId: number;
  raidName: string;
  rosterIds: string[];
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossThrow: BossThrowConfig | null;
  bossSpecials: BossSpecial[];
  /** The alien boss's abductee queue (raid 6 only) — see src/raid/alienStage.ts. */
  summon: SummonConfig | null;
  /** How the stage feeds its wave in. Pinned rather than re-derived from raidId so a
   *  settled session still replays under the cadence it was actually fought at. */
  waveCadence: WaveCadence;
  wallTemplate: CombatUnit | null;
  /** The pixel zombie `turnZombie` converts a zombie into (raid 9 only) — see
   *  src/raid/videoGameStage.ts. Optional so a session pinned before the conversion
   *  existed still parses; such a session is rejected at the ruleset handshake anyway. */
  turnedTemplate?: CombatUnit | null;
  grabber: GrabberConfig | null;
  concentration: boolean;
  /** A Brain Ticket was charged at /raid/start: every combat value above is already
   *  scaled by this raid's elite profile. Stored so a settled session can be read back
   *  and explained without re-deriving it. */
  elite?: boolean;
}

interface V3RosterRow {
  unit_id: string;
  zombie_key: string;
  mutation: number;
  invasions: number;
}

const raids = raidsJson as RaidDef[];
const enemyStats = enemyStatsJson as Record<string, EnemyStat>;
const attacks = attacksJson as Record<string, AttackDef>;
const zombieDefs = new Map((zombiesJson as Array<{ key: string }>).map((z) => [z.key, z]));

/** Hazards are CLIENT-ONLY. The verifier deliberately simulates the UN-HARASSED fight, so
 *  its replay is an optimistic ceiling the live game can only fall short of — the player
 *  then concedes a lost fight via `clientWin` (see v3/raid.ts finishRaid). Previously the
 *  trapeze ran here but NOT in the live scene, so Circus players lost zombies to a hazard
 *  they never saw. Returning null keeps every hazard on one side of the line. */
function grabberOf(_raid: RaidDef): GrabberConfig | null {
  return null;
}

function bossThrowOf(
  raid: RaidDef,
  stage: RaidStage,
  priorWins: number,
  elite: EliteProfile | null
): BossThrowConfig | null {
  if (!stage.bossKey || stage.throwingDisabled) return null;
  const options = (enemyStats[stage.bossKey]?.bossActions ?? [])
    .filter((a) => a.name === "throw")
    .map((a) => ({
      damage: a.damage ?? 0,
      weight: a.frequency,
      sprite: a.sprite ?? "",
      spriteSize: a.spriteSize ?? 32,
    }))
    .filter((o) => o.sprite);
  if (!options.length) return null;
  const secs = bossThrowIntervalSecs(raid, stage, priorWins);
  // Same order as RaidManager.bossThrowOf: rebalance onto the raid's rung, THEN elite.
  return eliteBossThrow(fightScaledThrow({ intervalMs: secs * 1000, options }, raid), elite);
}

// Strictly the BOSS's own actions — mirrors RaidManager.bossSpecialsOf, and must stay
// in step with it or the pinned config and the client's fight disagree.
function bossSpecialsOf(stage: RaidStage, elite: EliteProfile | null): BossSpecial[] {
  if (!stage.bossKey || stage.throwingDisabled) return [];
  const actions = enemyStats[stage.bossKey]?.bossActions ?? [];
  return eliteBossSpecials(
    actions
      .filter((a) => a.name !== "throw")
      .map((a) => ({
        name: a.name,
        weight: a.frequency,
        castMs: (a.castTime ?? 0) * 1000,
        cooldownMs: (a.cooldownTime ?? a.castTime ?? 2) * 1000,
        damage: a.damage ?? 0,
      })),
    elite
  );
}

// Mirrors RaidManager.summonConfigOf + wallTemplateOf + turnedTemplateOf. Both sides must
// build the same abductee roster, wall and pixel zombie off the same elite/level context,
// or the replay diverges the first time the boss casts. `raidId`/`playerLevel` are the
// pair buildEnemyUnits also needs.
function summonWallTemplates(
  stage: RaidStage,
  raidId: number,
  playerLevel: number,
  elite: EliteProfile | null
): {
  summon: SummonConfig | null;
  wallTemplate: CombatUnit | null;
  turnedTemplate: CombatUnit | null;
} {
  let summon: SummonConfig | null = null;
  let wallTemplate: CombatUnit | null = null;
  let turnedTemplate: CombatUnit | null = null;
  if (!stage.bossKey || stage.throwingDisabled) return { summon, wallTemplate, turnedTemplate };
  const actions = enemyStats[stage.bossKey]?.bossActions ?? [];
  if (actions.some((a) => a.name === "summonBoss")) {
    summon = summonConfigFor(raidId, enemyStats, attacks, { raidId, playerLevel, elite });
  }
  const wall = actions.find((a) => a.name === "wall");
  if (wall) {
    const hp = Math.max(1, Math.round(eliteWallHp(wall.hp ?? 1500, elite)));
    wallTemplate = {
      id: "wall",
      sourceKey: (wall.sprite ?? "carrotWall.png").replace(/\.png$/i, ""),
      team: "enemy",
      name: "Wall",
      str: 0,
      dex: 1,
      con: Math.round(hp / 10),
      focus: 0,
      hp,
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
  if (actions.some((a) => a.name === "turnZombie")) {
    turnedTemplate = turnedUnitFor(raidId, enemyStats, attacks, { raidId, playerLevel, elite });
  }
  return { summon, wallTemplate, turnedTemplate };
}

export type BuildPinnedResult =
  | { ok: true; config: PinnedRaidConfig }
  | { ok: false; error: string };

/** Build combat exclusively from the owned roster and server catalogs. */
export async function buildPinnedRaid(
  db: D1Database,
  accountId: string,
  raidId: number,
  orderedIds: unknown,
  concentration: boolean,
  /** Seed for the wave's own randomness (the Robots' random boss). It MUST be the
   *  session id the client is handed back, because the client resolves the same wave
   *  from it and this pinned config is what the replay is checked against. */
  waveSeed: string,
  /** A Brain Ticket was charged for this launch — fight the ELITE wave. The caller
   *  decides this (it is the side that debits the ticket) and hands the same answer to
   *  the client, which must adopt it rather than re-deriving one; the two simulations
   *  have to scale the wave identically or the replay diverges from tick 0. */
  elite = false
): Promise<BuildPinnedResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length > ARMY_CAP || orderedIds.length === 0) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) return { ok: false, error: "bad_roster" };
  const raid = raids.find((r) => r.id === raidId && r.playable);
  if (!raid) return { ok: false, error: "bad_raid" };
  const balance = await db
    .prepare("SELECT xp FROM balances WHERE account_id = ?")
    .bind(accountId)
    .first<{ xp: number }>();
  const level = levelForXp(balance?.xp ?? 0);
  if (level < raid.unlockLevel) return { ok: false, error: "locked" };
  const authored = fightStage(raid, level);
  if (!authored) return { ok: false, error: "bad_stage" };
  const stage = resolveStageWave(authored, seededRandom(waveSeed));

  const placeholders = ids.map(() => "?").join(",");
  const owned = await db
    .prepare(
      `SELECT id, key, mutation, invasions FROM roster
       WHERE account_id = ? AND id IN (${placeholders})`
    )
    .bind(accountId, ...ids)
    .all<RosterRow>();
  const byId = new Map((owned.results ?? []).map((r) => [r.id, r]));
  if (byId.size !== ids.length) return { ok: false, error: "unit_not_owned" };
  const locks = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM raid_roster_locks
       WHERE account_id = ? AND unit_id IN (${placeholders})`
    )
    .bind(accountId, ...ids)
    .first<{ n: number }>();
  if ((locks?.n ?? 0) > 0) return { ok: false, error: "unit_locked" };
  const progress = await db
    .prepare("SELECT raid_id, wins FROM raid_clears WHERE account_id = ?")
    .bind(accountId)
    .all<{ raid_id: number; wins: number }>();
  const wins = new Map((progress.results ?? []).map((r) => [r.raid_id, r.wins]));
  if (ids.length < minArmyFor(raid, wins.get(raidId) ?? 0)) return { ok: false, error: "army_too_small" };

  const party = ids.map((id) => {
    const row = byId.get(id)!;
    const def = zombieDefs.get(row.key);
    if (!def) throw new Error(`unknown roster catalog key ${row.key}`);
    return makeOwned(id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation);
  });
  const abilityUnlocked = (key: string): boolean => {
    const tier = abilityTierOf(key);
    const pool = ABILITY_TIER[tier] ?? [];
    const idx = pool.indexOf(key);
    return idx >= 0 && idx < Math.min(pool.length, wins.get(tier) ?? 0);
  };
  // raidId + playerLevel drive the farm raid's enemy speed-up; the client passes the
  // same pair in RaidManager.beginRaid — they MUST match or the replay diverges.
  const profile = eliteProfile(raidId, elite);
  const enemyUnits = buildEnemyUnits(stage, enemyStats, attacks, { raidId, playerLevel: level, elite: profile });
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party, { concentration, abilityUnlocked, playerLevel: level }),
      enemyUnits,
      bossThrow: bossThrowOf(raid, stage, wins.get(raidId) ?? 0, profile),
      bossSpecials: bossSpecialsOf(stage, profile),
      ...summonWallTemplates(stage, raidId, level, profile),
      waveCadence: waveCadenceFor(raidId),
      grabber: grabberOf(raid),
      concentration,
      elite,
    },
  };
}

export function createPinnedSim(config: PinnedRaidConfig): BattleSim {
  return new BattleSim(
    config.playerUnits,
    config.enemyUnits,
    config.bossThrow,
    config.concentration,
    config.bossSpecials,
    undefined,
    config.summon ?? null,
    config.wallTemplate,
    false,
    false,
    false,
    undefined,
    config.grabber ?? null,
    null,
    config.waveCadence ?? waveCadenceFor(config.raidId),
    config.turnedTemplate ?? null
  );
}

/** Build the same pinned combat configuration from protocol-v3 authoritative state. */
export async function buildPinnedV3Raid(
  db: D1Database,
  accountId: string,
  raidId: number,
  orderedIds: unknown,
  concentration: boolean,
  /** Seed for the wave's own randomness (the Robots' random boss). It MUST be the
   *  session id the client is handed back, because the client resolves the same wave
   *  from it and this pinned config is what the replay is checked against. */
  waveSeed: string,
  /** A Brain Ticket was charged for this launch — fight the ELITE wave. The caller
   *  decides this (it is the side that debits the ticket) and hands the same answer to
   *  the client, which must adopt it rather than re-deriving one; the two simulations
   *  have to scale the wave identically or the replay diverges from tick 0. */
  elite = false
): Promise<BuildPinnedResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length > ARMY_CAP || orderedIds.length === 0) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) return { ok: false, error: "bad_roster" };
  const raid = raids.find((candidate) => candidate.id === raidId && candidate.playable);
  if (!raid) return { ok: false, error: "bad_raid" };

  const placeholders = ids.map(() => "?").join(",");
  const [balance, owned, raidState, coreRow] = await Promise.all([
    db.prepare("SELECT xp FROM balances WHERE account_id = ?").bind(accountId).first<{ xp: number }>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${placeholders})`)
      .bind(accountId, ...ids).all<V3RosterRow>(),
    db.prepare("SELECT progress_json FROM raid_state_v3 WHERE account_id=?")
      .bind(accountId).first<{ progress_json: string }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>(),
  ]);
  const level = levelForXp(balance?.xp ?? 0);
  if (level < raid.unlockLevel) return { ok: false, error: "locked" };
  const rows = owned.results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "unit_not_owned" };
  const byId = new Map(rows.map((row) => [row.unit_id, row]));
  const winsObject = (() => {
    try { return JSON.parse(raidState?.progress_json ?? "{}") as Record<string, number>; }
    catch { return {}; }
  })();
  if (ids.length < minArmyFor(raid, winsObject[String(raidId)] ?? 0)) return { ok: false, error: "army_too_small" };
  const authored = fightStage(raid, level);
  if (!authored) return { ok: false, error: "bad_stage" };
  const stage = resolveStageWave(authored, seededRandom(waveSeed));
  const core = (() => {
    try {
      return JSON.parse(coreRow?.current_json ?? "{}") as
        { farmerHeadId?: number; farmerBonusHeadId?: number | null };
    } catch { return {}; }
  })();
  // The head supplying bonuses is the pinned one, else whatever is being worn. The
  // client's own BattleSim resolves it identically, and a mismatch here would make
  // every replay of a bonus-carrying party diverge.
  const bonusHead = activeBonusHeadId(Number(core.farmerHeadId ?? 1), core.farmerBonusHeadId);
  const party = ids.map((id) => {
    const row = byId.get(id)!;
    const def = zombieDefs.get(row.zombie_key);
    if (!def) return null;
    return makeOwned(id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation);
  });
  if (party.some((unit) => unit === null)) return { ok: false, error: "bad_roster" };
  const abilityUnlocked = (key: string): boolean => {
    const tier = abilityTierOf(key);
    const pool = ABILITY_TIER[tier] ?? [];
    const index = pool.indexOf(key);
    return index >= 0 && index < Math.min(pool.length, winsObject[String(tier)] ?? 0);
  };
  // raidId + playerLevel drive the farm raid's enemy speed-up; the client passes the
  // same pair in RaidManager.beginRaid — they MUST match or the replay diverges.
  const profile = eliteProfile(raidId, elite);
  const enemyUnits = buildEnemyUnits(stage, enemyStats, attacks, { raidId, playerLevel: level, elite: profile });
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party as ReturnType<typeof makeOwned>[], {
        concentration,
        abilityUnlocked,
        playerLevel: level,
        farmerStrengthMult: farmerMultiplier(bonusHead, "zombieStrength"),
        farmerLifeMult: farmerMultiplier(bonusHead, "zombieLife"),
      }),
      enemyUnits,
      bossThrow: bossThrowOf(raid, stage, winsObject[String(raidId)] ?? 0, profile),
      bossSpecials: bossSpecialsOf(stage, profile),
      ...summonWallTemplates(stage, raidId, level, profile),
      waveCadence: waveCadenceFor(raidId),
      grabber: grabberOf(raid),
      concentration,
      elite,
    },
  };
}

// ---------------------------------------------------------------------------
// Friend invasions (PvP). The pinned config is PinnedRaidConfig-compatible — the
// same createPinnedSim/verifyRaid settle it — plus the `pvp` block the client and
// the reward path read. See src/raid/pvp.ts for the shared rules.

export type PinnedPvpConfig = PinnedRaidConfig & { pvp: PvpConfigInfo };

export type BuildPinnedPvpResult =
  | { ok: true; config: PinnedPvpConfig }
  | { ok: false; error: string };

interface PvpRosterRow extends V3RosterRow {
  color: string | null;
}

/** unit id -> owner-given name, harvested from an account's presentation blob. */
async function rosterNames(db: D1Database, accountId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const row = await db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  if (!row) return names;
  try {
    const layout = (JSON.parse(row.current_json) as { rosterLayout?: { id?: unknown; name?: unknown }[] })
      .rosterLayout;
    for (const entry of Array.isArray(layout) ? layout : []) {
      if (typeof entry?.id === "string" && typeof entry.name === "string" && entry.name) {
        names.set(entry.id, entry.name.slice(0, 24));
      }
    }
  } catch { /* names are cosmetic — a bad blob costs nothing but defaults */ }
  return names;
}

/** One account's fight-relevant context: level, ability unlocks, farmer-head bonuses. */
async function accountFightContext(db: D1Database, accountId: string) {
  const [balance, raidState, coreRow] = await Promise.all([
    db.prepare("SELECT xp FROM balances WHERE account_id = ?").bind(accountId).first<{ xp: number }>(),
    db.prepare("SELECT progress_json FROM raid_state_v3 WHERE account_id = ?")
      .bind(accountId).first<{ progress_json: string }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
      .bind(accountId).first<{ current_json: string }>(),
  ]);
  const level = levelForXp(balance?.xp ?? 0);
  const wins = (() => {
    try { return JSON.parse(raidState?.progress_json ?? "{}") as Record<string, number>; }
    catch { return {}; }
  })();
  const core = (() => {
    try {
      return JSON.parse(coreRow?.current_json ?? "{}") as
        { farmerHeadId?: number; farmerBonusHeadId?: number | null };
    } catch { return {}; }
  })();
  const bonusHead = activeBonusHeadId(Number(core.farmerHeadId ?? 1), core.farmerBonusHeadId);
  const abilityUnlocked = (key: string): boolean => {
    const tier = abilityTierOf(key);
    const pool = ABILITY_TIER[tier] ?? [];
    const index = pool.indexOf(key);
    return index >= 0 && index < Math.min(pool.length, wins[String(tier)] ?? 0);
  };
  return { level, abilityUnlocked, bonusHead };
}

const toParty = (rows: PvpRosterRow[], names: Map<string, string>) => rows.map((row) => {
  const def = zombieDefs.get(row.zombie_key);
  if (!def) return null;
  return makeOwned(
    row.unit_id, def as Parameters<typeof makeOwned>[1], 0, 0, row.invasions, row.mutation,
    parseRosterColor(row.color), names.get(row.unit_id)
  );
});

/** One defender in the scout preview: display fields only, never stats. */
export interface PvpDefenderPreview {
  key: string;
  name: string;
  mutation?: number;
  color?: [number, number, number];
  /** Formation mode only: the job this defender holds. */
  role?: string;
}

export type DefenseSnapshotResult =
  | {
      ok: true;
      /** Enemy-side units in EMERGENCE order, ready for the pinned config. */
      units: CombatUnit[];
      /** Informational fight score (hp × dps over built stats). */
      score: number;
      /** The group's tier (1..5) from the FIELDED zombies' raw stats + mutations —
       *  what the attacker's reward reads. See groupTierPoints in src/raid/pvp.ts. */
      tier: number;
      defenderName: string;
      defenders: PvpDefenderPreview[];
      /** True when the line-up came from the defender's saved defense, not the
       *  strongest-pick auto snapshot. */
      authored: boolean;
      /** Which defense mode composed this snapshot. */
      mode: PvpDefenseMode;
    }
  | { ok: false; error: string };

/** Snapshot a defender's PvP defense from D1 alone (nothing here mutates their
 *  account). Prefers the AUTHORED defense saved in pvp_defense_v3 — the saved order
 *  is the emergence order, and a zombie sold or perished since it was saved simply
 *  drops out — falling back to the strongest-16 auto pick (weakest emerging first)
 *  for defenders who never arranged one. Authored defenses may field crypt-stored
 *  zombies: a defense is a plan, not who happens to stand on the lawn. */
export async function buildDefenseSnapshot(
  db: D1Database,
  defenderId: string,
  mode: PvpDefenseMode = PVP_DEFENSE_MODE_DEFAULT
): Promise<DefenseSnapshotResult> {
  const [account, context, names, loadoutRow] = await Promise.all([
    db.prepare("SELECT username FROM accounts WHERE id = ?").bind(defenderId)
      .first<{ username: string | null }>(),
    accountFightContext(db, defenderId),
    rosterNames(db, defenderId),
    db.prepare("SELECT loadout_json FROM pvp_defense_v3 WHERE account_id = ?")
      .bind(defenderId).first<{ loadout_json: string }>(),
  ]);
  if (!account) return { ok: false, error: "bad_defender" };
  if (context.level < PVP_MIN_LEVEL) return { ok: false, error: "defender_level" };

  let loadoutIds: string[] = [];
  try {
    const parsed = JSON.parse(loadoutRow?.loadout_json ?? "{}") as { unitIds?: unknown };
    if (Array.isArray(parsed.unitIds)) {
      loadoutIds = parsed.unitIds.filter((id): id is string => typeof id === "string");
    }
  } catch { /* a bad loadout blob falls back to the auto snapshot */ }

  // The snapshot ignores raid locks either way: a defender zombie mid-raid elsewhere
  // still stands on the farm being copied.
  let party: ReturnType<typeof makeOwned>[] = [];
  let authored = false;
  if (loadoutIds.length) {
    const placeholders = loadoutIds.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT unit_id,zombie_key,mutation,invasions,color
      FROM roster_v3 WHERE account_id=? AND unit_id IN (${placeholders})`)
      .bind(defenderId, ...loadoutIds).all<PvpRosterRow>();
    const byId = new Map((rows.results ?? []).map((row) => [row.unit_id, row]));
    const ordered = loadoutIds.map((id) => byId.get(id)).filter((row): row is PvpRosterRow => !!row);
    party = toParty(ordered, names).filter((unit): unit is NonNullable<typeof unit> => unit !== null);
    authored = party.length > 0;
  }
  if (!party.length) {
    const rows = await db.prepare(`SELECT unit_id,zombie_key,mutation,invasions,color
      FROM roster_v3 WHERE account_id=? AND stored=0`).bind(defenderId).all<PvpRosterRow>();
    party = toParty(rows.results ?? [], names).filter(
      (unit): unit is NonNullable<typeof unit> => unit !== null
    );
  }
  if (!party.length) return { ok: false, error: "no_defense" };

  const built = buildPlayerUnits(party, {
    concentration: true,
    abilityUnlocked: context.abilityUnlocked,
    playerLevel: context.level,
    farmerStrengthMult: farmerMultiplier(context.bonusHead, "zombieStrength"),
    farmerLifeMult: farmerMultiplier(context.bonusHead, "zombieLife"),
  });
  // MODE decides how the defense is composed AND how it fights. In "formation" the
  // saved loadout narrows the pool (the defender's chosen zombies) and the builder
  // then fills one job per class from it; in "classic" the saved order IS the
  // emergence order, exactly as it shipped.
  // In formation mode the saved loadout NARROWS the pool (these are the zombies the
  // defender chose to stand guard) and the builder fills one job per class from it.
  // In classic mode the saved order IS the emergence order, exactly as it shipped.
  const pool = authored ? built.slice(0, PVP_DEFENSE_CAP) : built;
  const selected = mode === "formation"
    ? selectFormationDefense(authored ? pool : built)
    : (authored ? pool : selectAutoDefense(built));
  const units = mode === "formation"
    ? formationDefenseUnits(selected)
    : enemyCopies(selected);
  return {
    ok: true,
    units,
    score: armyScore(units),
    // The tier reads the FIELDED zombies' built fight stats (level ramp, veterancy,
    // mutations, auras, heads, Protect) — see groupTierPoints in src/raid/pvp.ts.
    tier: pvpTierForPoints(groupTierPoints(selected, PVP_DEFENSE_CAP)),
    defenderName: account.username?.trim() || "A friend",
    defenders: units.map((u) => ({
      key: u.sourceKey,
      name: u.name,
      ...(u.mutation !== undefined ? { mutation: u.mutation } : {}),
      ...(u.color ? { color: u.color } : {}),
      ...(u.defenseRole ? { role: u.defenseRole } : {}),
    })),
    authored,
    mode,
  };
}

/** Build a friend invasion's pinned config exclusively from D1: the attacker's chosen
 *  eight against a snapshot of the defender's PvP defense. Neither account has to
 *  be online, and nothing here mutates either one. */
export async function buildPinnedPvpRaid(
  db: D1Database,
  attackerId: string,
  defenderId: string,
  orderedIds: unknown,
  mode: PvpDefenseMode = PVP_DEFENSE_MODE_DEFAULT
): Promise<BuildPinnedPvpResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length !== PVP_ARMY_SIZE) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) {
    return { ok: false, error: "bad_roster" };
  }
  const placeholders = ids.map(() => "?").join(",");
  const [attackerRows, attacker, attackerNames, defense] = await Promise.all([
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions,color FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${placeholders})`)
      .bind(attackerId, ...ids).all<PvpRosterRow>(),
    accountFightContext(db, attackerId),
    rosterNames(db, attackerId),
    buildDefenseSnapshot(db, defenderId, mode),
  ]);
  if (attacker.level < PVP_MIN_LEVEL) return { ok: false, error: "attacker_level" };
  if (!defense.ok) return defense;
  const attackerById = new Map((attackerRows.results ?? []).map((row) => [row.unit_id, row]));
  if (attackerById.size !== ids.length) return { ok: false, error: "unit_not_owned" };

  const attackParty = toParty(ids.map((id) => attackerById.get(id)!), attackerNames);
  if (attackParty.some((unit) => unit === null)) return { ok: false, error: "bad_roster" };
  const attackers = attackParty as ReturnType<typeof makeOwned>[];

  // Both sides fight at full focus (concentration): the minigame is skipped in PvP,
  // and a snapshot defense has nobody home to pop bubbles for it anyway.
  const playerUnits = buildPlayerUnits(attackers, {
    concentration: true,
    abilityUnlocked: attacker.abilityUnlocked,
    playerLevel: attacker.level,
    farmerStrengthMult: farmerMultiplier(attacker.bonusHead, "zombieStrength"),
    farmerLifeMult: farmerMultiplier(attacker.bonusHead, "zombieLife"),
  });
  const enemyUnits = defense.units;
  const attackScore = armyScore(playerUnits);
  const defenseScore = defense.score;
  const defenderName = defense.defenderName;
  return {
    ok: true,
    config: {
      raidId: PVP_RAID_ID,
      raidName: `${defenderName}'s Farm`,
      rosterIds: ids,
      playerUnits,
      enemyUnits,
      bossThrow: null,
      bossSpecials: [],
      summon: null,
      // Classic mode feeds the defense through the wave drip. A formation defense
      // authors each unit's arrival instead, so the cadence is left at the one-at-a-
      // time default and never competes with it (see BattleSim.promote).
      waveCadence: mode === "formation" ? { maxActive: 1, dripMs: 0 } : PVP_WAVE_CADENCE,
      wallTemplate: null,
      turnedTemplate: null,
      grabber: null,
      concentration: true,
      pvp: {
        defenderId,
        defenderName,
        attackScore,
        defenseScore,
        // Tiers from built-stat hp×dps (groupTierPoints), pinned here so a payout
        // can never be re-priced: the attacker's from the defense group, the
        // defender's from the attack group.
        attackerTier: defense.tier,
        defenderTier: pvpTierForPoints(groupTierPoints(playerUnits, PVP_ARMY_SIZE)),
      },
    },
  };
}

export function verifyRaid(
  config: PinnedRaidConfig,
  finalTick: number,
  inputs: RaidReplayInput[]
): ReplayResult {
  return replayRaid(createPinnedSim(config), finalTick, inputs);
}

export function verifyRaidSegment(
  config: PinnedRaidConfig,
  snapshot: BattleSimSnapshot | null,
  startTick: number,
  finalTick: number,
  startingSeq: number,
  inputs: RaidReplayInput[],
  allowRetreat: boolean
) {
  const sim = createPinnedSim(config);
  if (snapshot) sim.restore(snapshot);
  return advanceRaidSegment(sim, startTick, finalTick, startingSeq, inputs, allowRetreat);
}
