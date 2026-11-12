// Quest progress rules that go beyond "count an event up to a target", shared by the
// client QuestSystem and the Worker's applyQuestEvents so the two can never disagree
// about when a quest is done. Introduced for Omni-Farmer (the L44 quest that unlocks the
// 90x90 farm), but written as two general requirement kinds:
//
//  - GAUGES: an objective about the farm as it stands RIGHT NOW ("have 40 different
//    items placed"), not an event tally. Its count is overwritten from a live reading on
//    every evaluation, so it can fall as well as rise; the quest completes only at a
//    moment when every objective holds at once. A gauge never matches an event.
//
//  - SWEEPS: a set of named-subject tallies judged together. Every member must reach
//    `each`, and at least one must reach `best` ("5 of every crop, and 100 of one"). The
//    members are ordinary event requirements whose countTotal is `best`, so the stored
//    counts array keeps the same one-number-per-requirement shape as every other quest
//    and the tallies only ever count events received while the quest is active.
//
// A quest with neither is judged exactly as before: every count >= its countTotal.

/** The live readings a gauge requirement can name. */
export type QuestGauge = "uniqueItemsPlaced" | "almanacZombies";
export type QuestGauges = Partial<Record<QuestGauge, number>>;

/** The never-emitted notification id gauge requirements carry. Nothing posts it, so the
 *  event loops on both sides skip a gauge without having to know about gauges. */
export const GAUGE_NOTIFICATION = "kQuestGaugeReading";

export interface ProgressRequirement {
  notificationID: string;
  countTotal: number;
  /** Set on a gauge requirement: which live reading its count follows. */
  gauge?: QuestGauge;
  /** Set on a sweep member (see QuestSweep). */
  sweep?: boolean;
}

/** The thresholds a quest's sweep members are judged by. */
export interface QuestSweep {
  /** Every member must reach this. */
  each: number;
  /** At least one member must reach this (also every member's countTotal). */
  best: number;
}

export interface ProgressDef {
  requirements: readonly ProgressRequirement[];
  sweep?: QuestSweep;
}

export const hasGauges = (def: ProgressDef): boolean => def.requirements.some((r) => !!r.gauge);

/** Overwrite every gauge count in `counts` from `gauges`. A reading the caller does not
 *  have (undefined) leaves the stored count alone — the last known value — rather than
 *  zeroing it. Returns whether anything changed. */
export function applyGauges(def: ProgressDef, counts: number[], gauges: QuestGauges): boolean {
  let changed = false;
  def.requirements.forEach((r, i) => {
    if (!r.gauge) return;
    const reading = gauges[r.gauge];
    if (reading === undefined || !Number.isFinite(reading)) return;
    const next = Math.max(0, Math.min(r.countTotal, Math.floor(reading)));
    if (counts[i] !== next) {
      counts[i] = next;
      changed = true;
    }
  });
  return changed;
}

/** Is every objective of the quest met by `counts`? The ONE completion rule. */
export function requirementsMet(def: ProgressDef, counts: readonly number[]): boolean {
  const sweep = def.sweep;
  let sweepMembers = 0;
  let sweepBest = false;
  for (let i = 0; i < def.requirements.length; i++) {
    const r = def.requirements[i];
    const n = counts[i] ?? 0;
    if (sweep && r.sweep) {
      sweepMembers++;
      if (n < sweep.each) return false;
      if (n >= sweep.best) sweepBest = true;
      continue;
    }
    if (n < r.countTotal) return false;
  }
  return sweepMembers === 0 || sweepBest;
}

/** Objects the client draws but the Worker never records (the free starter shed is
 *  presentation-only — see object.upgrade in server/src/v3/engine.ts). Left out of the
 *  count on BOTH sides, so the rail can never read 40/40 while the server sees 39. */
const UNTRACKED_ITEMS = new Set(["storage01"]);

/** Distinct catalog keys among the objects standing on the farm (stored ones excluded). */
export function uniquePlacedItems(objects: Iterable<{ key: string; placed: boolean }>): number {
  const keys = new Set<string>();
  for (const o of objects) if (o.placed && !UNTRACKED_ITEMS.has(o.key)) keys.add(o.key);
  return keys.size;
}

/** Discovered Zombie Almanac species (count >= 1) that `classOf` classes at all
 *  (quest/omniFarmer.ts omniAlmanacClassifier): basics and specials together. A key it
 *  does not class — a mutant base species, a Pot promotion, an unknown key — is skipped. */
export function almanacZombieCount(
  discovered: unknown,
  classOf: (key: string) => "basic" | "special" | undefined
): number {
  if (!discovered || typeof discovered !== "object" || Array.isArray(discovered)) return 0;
  let n = 0;
  for (const [key, count] of Object.entries(discovered as Record<string, unknown>)) {
    if (typeof count !== "number" || !(count >= 1)) continue;
    if (classOf(key)) n++;
  }
  return n;
}

type LineRequirement = ProgressRequirement & { text: string; notificationObject?: string };

/** One objective line as the HUD shows it. `detail` is the tap-to-expand breakdown. */
export interface ObjectiveLine {
  text: string;
  count: number;
  total: number;
  done: boolean;
  detail?: { text: string; count: number; total: number; done: boolean }[];
}

/** The rail/quest-log lines for a quest: one per ordinary requirement, while a sweep's
 *  members collapse into two lines — "every crop" (counted in crops finished, with the
 *  per-crop list behind a tap) and "one crop to `best`" (the best tally so far). The two
 *  sweep lines take the place of the first sweep member, so authored order is kept. */
export function objectiveLines(
  def: {
    requirements: readonly LineRequirement[];
    sweep?: QuestSweep & { eachText?: string; bestText?: string };
  },
  counts: readonly number[]
): ObjectiveLine[] {
  const lines: ObjectiveLine[] = [];
  const sweep = def.sweep;
  const members = sweep
    ? def.requirements.map((r, i) => ({ r, n: counts[i] ?? 0 })).filter(({ r }) => r.sweep)
    : [];
  let sweepShown = false;
  def.requirements.forEach((r, i) => {
    const n = counts[i] ?? 0;
    if (sweep && r.sweep) {
      if (sweepShown) return;
      sweepShown = true;
      const finished = members.filter(({ n: m }) => m >= sweep.each).length;
      lines.push({
        text: sweep.eachText ?? `Harvest ${sweep.each} of every crop`,
        count: finished,
        total: members.length,
        done: finished === members.length,
        detail: members.map(({ r: m, n: c }) => ({
          text: m.notificationObject || m.text,
          count: Math.min(c, sweep.each),
          total: sweep.each,
          done: c >= sweep.each,
        })),
      });
      const top = members.reduce((best, m) => (m.n > best.n ? m : best), members[0]);
      const best = top?.n ?? 0;
      const leader = best > 0 && top ? ` (best: ${top.r.notificationObject})` : "";
      lines.push({
        text: `${sweep.bestText ?? `Harvest ${sweep.best} of one crop`}${leader}`,
        count: Math.min(best, sweep.best),
        total: sweep.best,
        done: best >= sweep.best,
      });
      return;
    }
    lines.push({ text: r.text, count: n, total: r.countTotal, done: n >= r.countTotal });
  });
  return lines;
}
