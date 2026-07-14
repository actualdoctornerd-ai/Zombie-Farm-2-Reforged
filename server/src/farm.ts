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
  | { id: string; type: "harvest"; oc: number; or: number };

/** Max field coordinate we accept (matches the save validator's field cap). */
export const MAX_COORD = 128;

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

/** Result of pricing a plant. `plot` is the row to record (economics locked now). */
export type PlantPlan =
  | { ok: true; goldDelta: number; plot: PlotRecord }
  | { ok: false; error: string };

/** Plan a plant: crop must exist, the plot must be free, and the player must afford
 *  the exact seed cost. `fertilized` is decided by the SERVER (a roll over the player's
 *  Garden-zombie roster in the db layer), NOT the client's assertion — so a modified
 *  client can't force the 2x harvest. */
export function planPlant(
  a: Extract<FarmAction, { type: "plant" }>,
  crop: CropEcon | undefined,
  occupied: boolean,
  bal: Balance,
  now: number,
  fertilized: boolean
): PlantPlan {
  if (!validCoord(a.oc) || !validCoord(a.or)) return { ok: false, error: "bad_coord" };
  if (!crop) return { ok: false, error: "bad_crop" };
  if (occupied) return { ok: false, error: "plot_occupied" };
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
