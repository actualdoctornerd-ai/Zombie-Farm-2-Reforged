// Pure exact-economics rules for farm actions — no D1, no Hono. Unit-tested; the
// db layer (applyFarmActions) supplies the crop econ + plot record + balance and
// persists the computed effects.
//
// The point of this over the bounds-validated economy path: the SERVER computes the
// seed cost, harvest value, xp, and — crucially — gates harvest by GROW TIME against
// the server-recorded plant time. So a modified client can't fabricate crop gold or
// fast-harvest by editing its clock. (Residual: `fertilized` is a client assertion
// at plant time, honoured but capped at a 2x multiplier — making it exact needs the
// player's Garden-zombie roster server-side, a later layer.)
import type { CropEcon } from "./catalog";
import { zombieCropEcon, type ZombieCropEcon } from "./zombieCropCatalog";

export interface Balance {
  gold: number;
  brains: number;
  xp: number;
}

/** A server-recorded planted crop (economics locked at plant time). */
export interface PlotRecord {
  crop_key: string;
  planted_at: number;
  grow_ms: number;
  sell: number; // base gold value (pre-fertilize)
  xp: number;
  fertilized: number; // 0 | 1
}

export type FarmAction =
  | { id: string; type: "plant"; oc: number; or: number; cropKey: string; fertilized?: boolean }
  // `unitId` is used ONLY when harvesting a zombie crop: the client-assigned id of the
  // owned unit the harvest yields, which the server records as a verified roster unit.
  | { id: string; type: "harvest"; oc: number; or: number; unitId?: string }
  // Till a plot: debits the plow cost + grants 1 xp and records the soil as PLOWED,
  // which a plant then requires. Re-tilling a harvested plot is the same action.
  | { id: string; type: "plow"; oc: number; or: number };

/** Max field coordinate we accept (matches the save validator's field cap). This is the
 *  absolute structural cap; the real bound is the account's OWNED farm size (see
 *  plotWithin) — a farm is at most 60x60 today. */
export const MAX_COORD = 128;

/** Tiles per plot side — a crop occupies a PLOT x PLOT block of base tiles.
 *  Mirrors src/Field.ts PLOT. */
export const PLOT = 4;

/** Ceiling on plots in one seed import — a DoS bound on the batch, not a game rule.
 *  The largest farm (60x60) holds 15x15 = 225 plots; this leaves generous head-room.
 *  Entries outside the owned farm are dropped by plotWithin regardless. */
export const MAX_SEED_PLOTS = (MAX_COORD / PLOT) ** 2; // 1024

/** Gold to plow one plot, mirroring src/JobSystem.ts PLOW_COST. Free while the account
 *  owns a Plowing Monolith (the db layer checks object ownership). */
export const PLOW_COST = 10;
/** xp granted for tilling one plot (JobSystem: state.addXp(1)). */
export const PLOW_XP = 1;
/** The object key whose ownership makes plowing free (assets.ts: p.plowFree). */
export const PLOW_FREE_OBJECT = "monolithPlowing";

/** Grow-gate grace. The server records plant time when the plant action FLUSHES,
 *  which lags the client's local plant time by the flush cadence (up to the ~30s
 *  max-dirty window) plus latency. So the server's elapsed time is slightly less
 *  than the client's; without slack, a legit harvest right at the ripe boundary
 *  would be wrongly rejected. This grace absorbs that offset. It's tiny next to the
 *  shortest real grow time (15 min), so the anti-insta-harvest gate still holds. */
export const GROW_GRACE_MS = 120_000;

function validCoord(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < MAX_COORD;
}

/** Does a PLOT x PLOT plot at origin (oc,or) fit inside a `size` x `size` farm?
 *  Mirrors Field.fits(): `oc + PLOT - 1 < size`. The farm only ever grows south/east
 *  from origin (0,0), so the owned size is the only bound that matters. Without this a
 *  client could farm land it never bought — the whole 128x128 structural cap. */
export function plotWithin(oc: number, or: number, size: number): boolean {
  return oc >= 0 && or >= 0 && oc + PLOT <= size && or + PLOT <= size;
}

/** Level gate. Catalog levels use -1 for "no requirement" (59 placeables, seasonal
 *  items), which passes for free — matching the client's `state.level < def.level`
 *  check. `level` is derived from server-owned xp, never sent by the client. */
export function levelAllows(playerLevel: number, required: number): boolean {
  return playerLevel >= required;
}

/** Server-owned facts a plant is judged against, none of them client-sent: the farm
 *  size the account actually bought, its level (derived from server xp), and whether
 *  the target plot's soil was recorded as plowed. */
export interface PlantContext {
  size: number;
  level: number;
  plowed: boolean;
}

/** Result of pricing a plant. `plot` is the row to record (economics locked now). */
export type PlantPlan =
  | { ok: true; goldDelta: number; plot: PlotRecord }
  | { ok: false; error: string };

/** Plan a plant: crop must exist and be unlocked at the player's (server-derived) level,
 *  the plot must sit on PLOWED soil inside the OWNED farm, be free, and the player must
 *  afford the exact seed cost. `fertilized` is decided by the SERVER (a roll over the
 *  player's Garden-zombie roster in the db layer), NOT the client's assertion — so a
 *  modified client can't force the 2x harvest. */
export function planPlant(
  a: Extract<FarmAction, { type: "plant" }>,
  crop: CropEcon | undefined,
  occupied: boolean,
  bal: Balance,
  now: number,
  fertilized: boolean,
  ctx: PlantContext
): PlantPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!plotWithin(a.oc, a.or, ctx.size)) return { ok: false, error: "outside_farm" };
  if (!crop) return { ok: false, error: "bad_crop" };
  if (!levelAllows(ctx.level, crop.level)) return { ok: false, error: "locked" };
  // `occupied` BEFORE `plowed`: a plant consumes its soil, so an occupied plot is never
  // plowed — checking plowed first would make plot_occupied unreachable and report a
  // replant as "not_plowed". Occupied is the specific, useful verdict; keeping both
  // means a double-plant is still blocked even if the two tables ever overlapped.
  if (occupied) return { ok: false, error: "plot_occupied" };
  if (!ctx.plowed) return { ok: false, error: "not_plowed" };
  if (bal.gold < crop.cost) return { ok: false, error: "insufficient" };
  return {
    ok: true,
    goldDelta: -crop.cost,
    plot: {
      crop_key: a.cropKey,
      planted_at: now,
      grow_ms: crop.growMs,
      sell: crop.sell,
      xp: crop.xp,
      fertilized: fertilized ? 1 : 0,
    },
  };
}

export type HarvestPlan =
  | { ok: true; goldDelta: number; xpDelta: number }
  | { ok: false; error: string };

/** Plan a harvest: the plot must exist and be grown by SERVER time. Reward is the
 *  locked-in base sell (x2 if fertilized) plus xp. */
export function planHarvest(
  a: Extract<FarmAction, { type: "harvest" }>,
  plot: PlotRecord | undefined,
  now: number
): HarvestPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!plot) return { ok: false, error: "nothing_planted" };
  if (now - plot.planted_at < plot.grow_ms - GROW_GRACE_MS) return { ok: false, error: "not_grown" };
  const mult = plot.fertilized ? 2 : 1;
  return { ok: true, goldDelta: plot.sell * mult, xpDelta: plot.xp };
}

// ---- plow (till soil so it can be planted) --------------------------------------
/** Result of pricing a plow. `cost` is 0 while a Plowing Monolith is owned. */
export type PlowPlan =
  | { ok: true; cost: number; xp: number }
  | { ok: false; error: string };

/** Plan a plow: the plot must sit inside the OWNED farm, must not already be plowed or
 *  planted, and the player must afford the plow cost. The cost is the server's (0 while
 *  a Plowing Monolith is owned — checked against server-owned object counts, not a
 *  client claim), so a client can't declare free plowing.
 *
 *  `plowed` = the soil is already tilled and empty; re-plowing it would mint xp for
 *  nothing. A HARVESTED plot (dirt/hole) is not `plowed`, so re-tilling it is allowed —
 *  that's the real re-till loop. */
export function planPlow(
  a: Extract<FarmAction, { type: "plow" }>,
  bal: Balance,
  size: number,
  cost: number,
  plowed: boolean,
  occupied: boolean
): PlowPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!plotWithin(a.oc, a.or, size)) return { ok: false, error: "outside_farm" };
  if (occupied) return { ok: false, error: "plot_occupied" };
  if (plowed) return { ok: false, error: "already_plowed" };
  if (bal.gold < cost) return { ok: false, error: "insufficient" };
  return { ok: true, cost, xp: PLOW_XP };
}

// ---- zombie crops (plant a zombie seed -> grow -> harvest an owned unit) -------
/** Result of pricing a zombie-crop plant. `plot` is the row to record (sell 0 — a
 *  zombie crop yields a UNIT, not gold). `currency` is what the cost debits. */
export type ZombiePlantPlan =
  | { ok: true; currency: "gold" | "brains"; cost: number; plot: PlotRecord }
  | { ok: false; error: string };

/** Plan planting a zombie crop: the key must be a real zombie crop unlocked at the
 *  player's level, on plowed soil inside the owned farm, the plot free, and the player
 *  must afford the exact cost in its currency (gold OR brains). The recorded plot yields
 *  the unit of the same key on harvest (sell 0). Same gates as a veggie plant — a zombie
 *  crop is the more valuable one, so it must not be the softer path. */
export function planZombiePlant(
  a: Extract<FarmAction, { type: "plant" }>,
  econ: ZombieCropEcon | undefined,
  occupied: boolean,
  bal: Balance,
  now: number,
  ctx: PlantContext
): ZombiePlantPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!plotWithin(a.oc, a.or, ctx.size)) return { ok: false, error: "outside_farm" };
  if (!econ) return { ok: false, error: "bad_crop" };
  if (!levelAllows(ctx.level, econ.level)) return { ok: false, error: "locked" };
  if (occupied) return { ok: false, error: "plot_occupied" }; // before `plowed` — see planPlant
  if (!ctx.plowed) return { ok: false, error: "not_plowed" };
  const currency = econ.brains ? "brains" : "gold";
  if (bal[currency] < econ.cost) return { ok: false, error: "insufficient" };
  return {
    ok: true,
    currency,
    cost: econ.cost,
    plot: {
      crop_key: a.cropKey,
      planted_at: now,
      grow_ms: econ.growMs,
      sell: 0, // a zombie crop yields a unit, never gold
      xp: econ.xp,
      fertilized: 0,
    },
  };
}

/** Result of harvesting a zombie crop: the unit key to grant + the harvest xp. */
export type ZombieHarvestPlan =
  | { ok: true; unitKey: string; xpDelta: number }
  | { ok: false; error: string };

/** Plan harvesting a zombie crop: the plot must exist and be grown by SERVER time. The
 *  yield is a verified owned unit of the plot's key (its provenance was validated at
 *  plant time) plus the harvest xp. Requires a non-empty client-assigned `unitId`. */
export function planZombieHarvest(
  a: Extract<FarmAction, { type: "harvest" }>,
  plot: PlotRecord | undefined,
  now: number
): ZombieHarvestPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!plot) return { ok: false, error: "nothing_planted" };
  if (typeof a.unitId !== "string" || !a.unitId) return { ok: false, error: "bad_unit" };
  if (now - plot.planted_at < plot.grow_ms - GROW_GRACE_MS) return { ok: false, error: "not_grown" };
  const econ = zombieCropEcon(plot.crop_key);
  if (!econ) return { ok: false, error: "bad_crop" };
  return { ok: true, unitKey: plot.crop_key, xpDelta: econ.xp };
}
