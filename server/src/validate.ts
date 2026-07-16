// Runtime validation of the client-authored save blob at the API boundary.
//
// The save is still client-authored (moving progression fully server-side is the
// Track B rebuild), so this does NOT prove a save is *legitimate*. What it does is
// guarantee a stored save is *well-formed and bounded*: finite non-negative
// numbers, sane field dimensions, and capped collection sizes. That closes two
// concrete holes the audit called out:
//   • oversized / deeply-nested / high-cardinality blobs as a storage/DoS vector;
//   • malicious farms that hang a *visitor's* browser (a visitor only ever renders
//     a stored save, so rejecting the bad save on write protects every visitor).
//
// Dependency-free on purpose: no zod/ajv pulled into the Worker (smaller bundle,
// no supply-chain surface — in the spirit of the audit). Just small guards.

// ---- limits -------------------------------------------------------------
/** Hard cap on the serialized save. Generous for a real farm, tiny vs. an attack. */
export const MAX_SAVE_BYTES = 512 * 1024; // 512 KB
/** Field dimensions. The base fields are ~20×20; 128 leaves head-room for expansion
 *  while making a "resize to 10^9 tiles" allocation attack impossible. */
export const MAX_FIELD_DIM = 128;
/** Largest integer we accept for any currency/xp/count. Above JS-safe-int games
 *  get silently lossy; this is already absurdly high for legitimate play. */
export const MAX_INT = 1e15;
/** Collection caps — each is far above real play, low enough to bound work. */
export const LIMITS = {
  plots: 8192,
  objects: 8192,
  ownedZombies: 4096,
  storageItems: 2048,
  storageReceived: 4096,
  boosts: 512,
  questsActive: 512,
  questsCompleted: 4096,
  unlockedAbilities: 512,
  terrainOverrides: MAX_FIELD_DIM * MAX_FIELD_DIM,
  ownedClimates: 256,
  socialFriends: 4096,
  nameLen: 64,
  keyLen: 64,
  idLen: 128,
  arrayIdLen: 8192, // any generic string-id array
} as const;

// ---- primitive guards ---------------------------------------------------
type Result = { ok: true } | { ok: false; error: string };
const OK: Result = { ok: true };
const bad = (error: string): Result => ({ ok: false, error });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Finite non-negative integer within MAX_INT. */
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT;
}
/** Any finite number within ±MAX_INT (timestamps, coords that may be negative). */
function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_INT;
}
function isStr(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}
function arrayWithin(v: unknown, max: number): v is unknown[] {
  return Array.isArray(v) && v.length <= max;
}

// ---- save validation ----------------------------------------------------
/** Validate a parsed save object structurally and by bounds. Returns ok, or the
 *  first failing reason. Unknown extra fields are tolerated (forward-compat), but
 *  every field we DO understand must be finite/bounded. */
export function validateSave(save: unknown): Result {
  if (!isObj(save)) return bad("save_not_object");
  if (!isCount(save.version)) return bad("bad_version");
  if (!isFiniteNum(save.savedAt)) return bad("bad_savedAt");

  const p = save.player;
  if (!isObj(p)) return bad("bad_player");
  if (p.name !== undefined && !isStr(p.name, LIMITS.nameLen)) return bad("bad_player_name");
  for (const k of ["gold", "brains", "xp", "zombieMax", "zombieCount"] as const) {
    if (p[k] !== undefined && !isCount(p[k])) return bad(`bad_player_${k}`);
  }
  if (p.unlockedAbilities !== undefined) {
    if (!arrayWithin(p.unlockedAbilities, LIMITS.unlockedAbilities)) return bad("bad_abilities");
    if (!p.unlockedAbilities.every((a) => isStr(a, LIMITS.keyLen))) return bad("bad_ability_key");
  }

  const farm = save.farm;
  if (!isObj(farm)) return bad("bad_farm");
  if (!isStr(farm.fieldId, LIMITS.keyLen)) return bad("bad_fieldId");
  if (!isCount(farm.w) || farm.w < 1 || farm.w > MAX_FIELD_DIM) return bad("bad_farm_w");
  if (!isCount(farm.h) || farm.h < 1 || farm.h > MAX_FIELD_DIM) return bad("bad_farm_h");
  if (!arrayWithin(farm.plots, LIMITS.plots)) return bad("too_many_plots");
  for (const plot of farm.plots as unknown[]) {
    if (!isObj(plot)) return bad("bad_plot");
    if (!isCount(plot.oc) || !isCount(plot.or)) return bad("bad_plot_coord");
    if (!isStr(plot.state, 16)) return bad("bad_plot_state");
    if (plot.crop !== undefined) {
      const c = plot.crop;
      if (!isObj(c) || !isStr(c.key, LIMITS.keyLen)) return bad("bad_crop_key");
      if (!isFiniteNum(c.plantedAt) || !isFiniteNum(c.growMs)) return bad("bad_crop_time");
    }
  }
  if (farm.terrainOverrides !== undefined && !arrayWithin(farm.terrainOverrides, LIMITS.terrainOverrides))
    return bad("too_many_terrain_overrides");
  if (farm.ownedClimates !== undefined && !arrayWithin(farm.ownedClimates, LIMITS.ownedClimates))
    return bad("too_many_climates");
  if (farm.background !== undefined &&
      farm.background !== "deep-forest" && farm.background !== "woodland" && farm.background !== "light-meadow")
    return bad("bad_farm_background");

  // Optional later-phase collections: bound their sizes and id uniqueness.
  if (save.objects !== undefined) {
    if (!arrayWithin(save.objects, LIMITS.objects)) return bad("too_many_objects");
    if (!uniqueIds(save.objects, "id")) return bad("dup_object_id");
  }
  if (save.ownedZombies !== undefined) {
    if (!arrayWithin(save.ownedZombies, LIMITS.ownedZombies)) return bad("too_many_zombies");
    if (!uniqueIds(save.ownedZombies, "id")) return bad("dup_zombie_id");
  }
  if (save.boosts !== undefined && !arrayWithin(save.boosts, LIMITS.boosts)) return bad("too_many_boosts");
  if (isObj(save.storage)) {
    if (save.storage.items !== undefined && !arrayWithin(save.storage.items, LIMITS.storageItems))
      return bad("too_many_items");
    if (save.storage.received !== undefined && !arrayWithin(save.storage.received, LIMITS.storageReceived))
      return bad("too_many_received");
  }
  if (isObj(save.quests)) {
    if (save.quests.active !== undefined && !arrayWithin(save.quests.active, LIMITS.questsActive))
      return bad("too_many_active_quests");
    if (save.quests.completed !== undefined && !arrayWithin(save.quests.completed, LIMITS.questsCompleted))
      return bad("too_many_completed_quests");
  }
  if (isObj(save.social) && save.social.friends !== undefined && !arrayWithin(save.social.friends, LIMITS.socialFriends))
    return bad("too_many_social_friends");

  return OK;
}

/** Every element is an object whose `field` (if present) is a unique short string. */
function uniqueIds(arr: unknown[], field: string): boolean {
  const seen = new Set<string>();
  for (const el of arr) {
    if (!isObj(el)) return false;
    const id = el[field];
    if (id === undefined) continue;
    if (typeof id !== "string" || id.length > LIMITS.idLen) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Bound the farm dimensions a *visitor* will act on, independent of the full
 *  save check. Even though stored saves are validated on write, the visitor client
 *  re-checks this before allocating/resizing (defense in depth; see visit.ts). */
export function farmDimsWithinBounds(w: unknown, h: unknown): boolean {
  return isCount(w) && isCount(h) && w >= 1 && h >= 1 && w <= MAX_FIELD_DIM && h <= MAX_FIELD_DIM;
}
