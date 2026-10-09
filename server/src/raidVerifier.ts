import raidsJson from "../../public/assets/raids/raids.json";
import enemyStatsJson from "../../public/assets/raids/enemy_stats.json";
import attacksJson from "../../public/assets/raids/attacks.json";
import zombiesJson from "../../public/assets/zombies.json";
import { BattleSim, type BattleSimSnapshot } from "../../src/raid/BattleSim";
import { buildFight } from "../../src/raid/buildFight";
import { buildPlayerUnits } from "../../src/raid/CombatEngine";
import { composeFight } from "../../src/raid/composeFight";
import {
  fightStage,
  minArmyFor,
  resolveStageWave,
  seededRandom,
  ARMY_CAP,
} from "../../src/raid/RaidCatalog";
import { makeOwned } from "../../src/zombie/types";
import { abilitySlotUnlocked, farmLifeForce, lifeForceLevel } from "../../src/lifeForce";
import { lifeForceKeysOf, lifeForceOf } from "./objectCatalog";
import { advanceRaidSegment, replayRaid, RAID_RULESET_VERSION, type RaidReplayInput, type ReplayResult } from "../../src/raid/replay";
import type {
  AttackDef,
  BossSpecial,
  BossThrowConfig,
  CombatUnit,
  EnemyStat,
  RaidDef,
  GrabberConfig,
  SummonConfig,
  WaveCadence,
} from "../../src/raid/types";
import { waveCadenceFor } from "../../src/raid/alienStage";
import { eliteProfile } from "../../src/raid/eliteInvasion";
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
  pvpBossThrow,
  pvpTierForPoints,
  selectAutoDefense,
  selectFormationDefense,
  type PvpConfigInfo,
  type PvpDefenseMode,
} from "../../src/raid/pvp";
import { parseRosterColor } from "./v3/rosterColor";
import {
  fightTimeLimitMs, isDualInvasion, MAX_TIER, MIN_TIER, raidProfile,
  type BigTopConfig, type BubbleConfig, type DuelConfig, type SignConfig,
} from "../../src/raid/dualInvasion";
import { effectiveUnlockLevel, isPracticeRaid } from "../../src/raid/practice";

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
  /** The dual-invasion rung this fight IS (0 for every raid without a ladder). Pinned here
   *  because it is part of the fight: the placard rotation below is derived from it, and a
   *  win credits THIS value rather than anything the finish request says. */
  tier?: number;
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
  /** The Lawyer boss's placard rotation, pinned at /raid/start (raid 12 only). */
  sign?: SignConfig | null;
  /** The duel's fight-wide rules (raid 13 only). */
  duel?: DuelConfig | null;
  /** The big top's rules (raid 14 only). */
  bigTop?: BigTopConfig | null;
  /** The saucer's five-action bubble, and the wall its `wall` action drops (raid 15). */
  bubble?: BubbleConfig | null;
  bubbleWall?: CombatUnit | null;
  /** The ringmaster's early drop and the mid-lane station he then fights from (raid 14,
   *  rung 5+). Pinned like everything else the rung decides. */
  bossDropAtMs?: number | null;
  bossGroundStationX?: number | null;
  /** This fight's clock, pinned like everything else (six minutes on a dual invasion). */
  timeLimitMs?: number;
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

export type BuildPinnedResult =
  | { ok: true; config: PinnedRaidConfig; lifeForceLevel: number }
  | { ok: false; error: string; unlockedTier?: number };

/** The Life Force level of an account's farm, from the objects it holds as PLACED.
 *  Ability slots work from this level (slot k from level k), so every fight the server pins
 *  derives it here from its own object document, never from anything the client sends. */
export function lifeForceLevelOfObjects(objectsJson: string | null | undefined): number {
  let objects: { catalogKey?: unknown; status?: unknown }[] = [];
  try {
    const parsed = JSON.parse(objectsJson ?? "[]");
    if (Array.isArray(parsed)) objects = parsed;
  } catch { /* a bad blob counts as an empty farm */ }
  return lifeForceLevel(farmLifeForce(lifeForceKeysOf(objects), lifeForceOf));
}

export async function loadLifeForceLevel(db: D1Database, accountId: string): Promise<number> {
  const row = await db.prepare("SELECT current_json FROM object_documents_v3 WHERE account_id = ?")
    .bind(accountId).first<{ current_json: string }>();
  return lifeForceLevelOfObjects(row?.current_json);
}

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
  if (level < effectiveUnlockLevel(raid)) return { ok: false, error: "locked" };
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
  const lifeForce = await loadLifeForceLevel(db, accountId);
  // raidId + playerLevel drive the farm raid's enemy speed-up; the client passes the
  // same pair in RaidManager.beginRaid — they MUST match or the replay diverges.
  const profile = eliteProfile(raidId, elite);
  // Same composer as the v3 path, the client and the harness. This legacy path fights no
  // dual invasion, so the rung is 0 and the ladder's fields all come back null — that is
  // the composer answering, not this function deciding.
  const composed = composeFight({ enemyStats, raidAttacks: attacks }, raid, stage, {
    playerLevel: level,
    tier: 0,
    elite: profile,
    priorWins: wins.get(raidId) ?? 0,
    waveSeed,
    hazards: false,
  });
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party, {
        concentration,
        abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, lifeForce),
        playerLevel: level,
      }),
      ...composed,
      concentration,
      elite,
    },
    lifeForceLevel: lifeForce,
  };
}

export function createPinnedSim(config: PinnedRaidConfig): BattleSim {
  return buildFight({
    playerUnits: config.playerUnits,
    enemyUnits: config.enemyUnits,
    bossThrow: config.bossThrow,
    concentration: config.concentration,
    bossSpecials: config.bossSpecials,
    summon: config.summon,
    wallTemplate: config.wallTemplate,
    // Hazards stay OFF here on purpose: the verifier simulates the un-harassed fight so
    // its replay is a ceiling the live game can only fall short of (see `grabberOf`).
    // `config.grabber` is null for every raid this build pins; it is still read rather
    // than hard-coded because a PINNED config is persisted and an older session's may
    // carry one, and a stored fight must replay under the rules it was pinned with. The
    // crab and the Mega-Robot have never been pinned at all, so they are named null.
    grabber: config.grabber,
    crab: null,
    megaBot: null,
    waveCadence: config.waveCadence ?? waveCadenceFor(config.raidId),
    turnedTemplate: config.turnedTemplate,
    sign: config.sign,
    duel: config.duel,
    bigTop: config.bigTop,
    bossDropAtMs: config.bossDropAtMs,
    bossGroundStationX: config.bossGroundStationX,
    bubble: config.bubble,
    bubbleWall: config.bubbleWall,
    timeLimitMs: config.timeLimitMs ?? fightTimeLimitMs(config.raidId),
  });
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
  elite = false,
  /** The dual-invasion rung the client asked for. Validated HERE, against this account's
   *  own ladder, because this function already reads `raid_state_v3` and because what it
   *  validates is part of the config it pins — splitting the two would let a caller pin a
   *  fight at one rung and then record another. Ignored for raids without a ladder. */
  requestedTier: unknown = 0
): Promise<BuildPinnedResult> {
  if (!Array.isArray(orderedIds) || orderedIds.length > ARMY_CAP || orderedIds.length === 0) {
    return { ok: false, error: "bad_roster" };
  }
  const ids = orderedIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length !== orderedIds.length || new Set(ids).size !== ids.length) return { ok: false, error: "bad_roster" };
  const raid = raids.find((candidate) => candidate.id === raidId && candidate.playable);
  if (!raid) return { ok: false, error: "bad_raid" };

  const placeholders = ids.map(() => "?").join(",");
  const [balance, owned, raidState, coreRow, lifeForce] = await Promise.all([
    db.prepare("SELECT xp FROM balances WHERE account_id = ?").bind(accountId).first<{ xp: number }>(),
    db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND stored=0 AND locked_by_raid IS NULL AND unit_id IN (${placeholders})`)
      .bind(accountId, ...ids).all<V3RosterRow>(),
    db.prepare("SELECT progress_json, tier_json FROM raid_state_v3 WHERE account_id=?")
      .bind(accountId).first<{ progress_json: string; tier_json: string }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>(),
    loadLifeForceLevel(db, accountId),
  ]);
  const level = levelForXp(balance?.xp ?? 0);
  if (level < effectiveUnlockLevel(raid)) return { ok: false, error: "locked" };
  const rows = owned.results ?? [];
  if (rows.length !== ids.length) return { ok: false, error: "unit_not_owned" };
  const byId = new Map(rows.map((row) => [row.unit_id, row]));
  const winsObject = (() => {
    try { return JSON.parse(raidState?.progress_json ?? "{}") as Record<string, number>; }
    catch { return {}; }
  })();
  if (ids.length < minArmyFor(raid, winsObject[String(raidId)] ?? 0)) return { ok: false, error: "army_too_small" };
  // THE RUNG. A dual invasion is fought at a chosen tier; everything else is tier 0. The
  // ladder is progression and therefore server state — the client's picker is a
  // convenience, not the rule — so the request is checked against what this account has
  // actually cleared, and the answer becomes part of the pinned config.
  let tier = 0;
  if (isDualInvasion(raidId)) {
    const cleared = (() => {
      try { return JSON.parse(raidState?.tier_json ?? "{}") as Record<string, number>; }
      catch { return {}; }
    })();
    // Practice opens every rung (src/raid/practice.ts); otherwise the climbed ladder decides.
    const unlocked = isPracticeRaid(raidId)
      ? MAX_TIER
      : Math.min(MAX_TIER, Math.max(0, Math.floor(cleared[String(raidId)] ?? 0)) + 1);
    const wanted = Number.isFinite(Number(requestedTier)) ? Math.floor(Number(requestedTier)) : MIN_TIER;
    if (wanted < MIN_TIER || wanted > unlocked) {
      return { ok: false, error: "tier_locked", unlockedTier: unlocked };
    }
    tier = wanted;
  }
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

  // raidId + playerLevel drive the farm raid's enemy speed-up; the client passes the
  // same pair in RaidManager.beginRaid — they MUST match or the replay diverges.
  // The multipliers this fight runs under: the pinned rung's profile on a dual invasion,
  // the Brain Ticket's anywhere else. Same helper the client calls, off the same inputs.
  const profile = raidProfile(raidId, { elite, tier });
  // The whole opposition, from the ONE composer the client's RaidManager and the
  // difficulty harness also call (src/raid/composeFight.ts). `hazards: false` is the
  // verifier's standing decision: it simulates the UN-HARASSED fight, so its replay is a
  // ceiling the live game can only fall short of and a client-only trapeze or crab can
  // never invent a win. See the `grabberOf` note above.
  const composed = composeFight({ enemyStats, raidAttacks: attacks }, raid, stage, {
    playerLevel: level,
    tier,
    elite: profile,
    priorWins: winsObject[String(raidId)] ?? 0,
    waveSeed,
    hazards: false,
  });
  return {
    ok: true,
    config: {
      raidId,
      raidName: raid.name,
      rosterIds: ids,
      playerUnits: buildPlayerUnits(party as ReturnType<typeof makeOwned>[], {
        concentration,
        // Slot k works from Life Force level k, derived above from this account's own
        // placed objects. The client is handed this same number at /raid/start and fights
        // with it, so the two simulations cannot disagree about decor placed a moment ago.
        abilitySlotUnlocked: (slot) => abilitySlotUnlocked(slot, lifeForce),
        playerLevel: level,
        farmerStrengthMult: farmerMultiplier(bonusHead, "zombieStrength"),
        farmerLifeMult: farmerMultiplier(bonusHead, "zombieLife"),
      }),
      // Everything below comes from the composer, PINNED rather than recomputed at
      // replay time so the verifier reads back the exact wave, placard rotation, rung
      // rules and templates the fight was fought under.
      ...composed,
      concentration,
      elite,
      tier,
    },
    lifeForceLevel: lifeForce,
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

/** One account's fight-relevant context: level, ability slots (from Life Force), farmer-head bonuses. */
async function accountFightContext(db: D1Database, accountId: string) {
  const [balance, coreRow, lifeForce] = await Promise.all([
    db.prepare("SELECT xp FROM balances WHERE account_id = ?").bind(accountId).first<{ xp: number }>(),
    db.prepare("SELECT current_json FROM gameplay_documents_v3 WHERE account_id = ?")
      .bind(accountId).first<{ current_json: string }>(),
    loadLifeForceLevel(db, accountId),
  ]);
  const level = levelForXp(balance?.xp ?? 0);
  const core = (() => {
    try {
      return JSON.parse(coreRow?.current_json ?? "{}") as
        { farmerHeadId?: number; farmerBonusHeadId?: number | null };
    } catch { return {}; }
  })();
  const bonusHead = activeBonusHeadId(Number(core.farmerHeadId ?? 1), core.farmerBonusHeadId);
  const slotUnlocked = (slot: number): boolean => abilitySlotUnlocked(slot, lifeForce);
  return { level, abilitySlotUnlocked: slotUnlocked, bonusHead };
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
    abilitySlotUnlocked: context.abilitySlotUnlocked,
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
    abilitySlotUnlocked: attacker.abilitySlotUnlocked,
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
      // Formation mode perches the brute and lets it lob the mini; classic has no
      // boss and no throw at all.
      bossThrow: mode === "formation" ? pvpBossThrow(enemyUnits) : null,
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
