// Generation, progress and claiming for daily / weekly quests.
//
// Everything here is PURE and DETERMINISTIC: the same (accountId, scope, period,
// level) always produces the same set, and nothing reads a clock or Math.random on its
// own. That is what lets the offline build generate its own quests locally while the
// online build takes the server's — the two run the identical code, so a set generated
// on either side is the set the other would have produced.
//
// Rewards are XP only, and are FROZEN into the quest at generation time. Sizing them
// at claim time instead would pay a completed quest at whatever level the player had
// climbed to by the time they pressed the button, which is worth deliberately waiting
// for — an incentive to sit on finished quests rather than play.

import { questSubjectMatches } from "../matching";
import { periodEndsAt, periodIndex } from "./periods";
import { DAILY_SLOTS, WEEKLY_SLOTS, levelBand, type QuestTemplate } from "./templates";
import type {
  PeriodicQuest, PeriodicQuestState, PeriodicQuestView, PeriodicScope,
  PeriodicScopeState, PeriodicScopeView,
} from "./types";

/** Dailies appear once the tutorial's own quest rail is behind the player. */
export const DAILY_UNLOCK_LEVEL = 5;
/** Weeklies are a later commitment — a week-long goal needs a farm that can meet it. */
export const WEEKLY_UNLOCK_LEVEL = 15;

/** A day's worth of quests is worth this share of the CURRENT level's XP requirement.
 *
 *  The share DECLINES with level rather than staying flat. Flat looked right in the
 *  abstract but paid far too little where it matters: the XP curve steepens ~28x from
 *  level 10 to level 40 while the farm's own XP income barely doubles, so a flat share
 *  produces a daily worth a rounding error early and a windfall late. Interpolating
 *  between these two endpoints lands a single daily at roughly 27 XP around level 10,
 *  270 around level 40 and 330 at the cap, which is the intended feel across the range.
 *
 *  The max-level endpoint was HALVED (0.08 -> 0.04) after modelling what the board is
 *  actually worth up there: above level 35 the farm loop and raid gold have both gone
 *  flat (no crop unlocks past 45), so periodic XP was carrying ~70% of a level on its
 *  own and the endgame cleared at a near-constant ~5 days a level however steep the
 *  curve got. Because the reward is a SHARE of the requirement, raising thresholds
 *  could never slow that down — only this number can. The unlock endpoint is untouched:
 *  early dailies were never the problem, and the taper means levels under ~20 barely
 *  move (a level-10 daily goes 28 -> 27). */
const DAILY_SHARE_AT_UNLOCK = 0.18;
const DAILY_SHARE_AT_MAX_LEVEL = 0.04;
const MAX_LEVEL = 45;

/** One weekly quest PAYS seven dailies — literally "a week of showing up".
 *
 *  It only COSTS five (templates.WEEKLY_COUNT_MULTIPLIER), and the gap is the point: a
 *  weekly has to survive a missed day or two to be worth starting, so it asks for five
 *  days of play across seven and pays the whole week for finishing it. Keep the two
 *  numbers apart — collapsing them to one would silently price that slack out. */
export const WEEKLY_MULTIPLIER = 7;

/** Per-slot reward weights, summing to the slot count so the pool is preserved. The
 *  invasion slot pays more than the farm chores because it costs a real cooldown. */
const DAILY_SLOT_WEIGHTS = [0.9, 0.9, 1.2] as const;
const WEEKLY_SLOT_WEIGHTS = [1, 1] as const;

/** The last level whose own step the periodic board is paid against. Every level from here
 *  up is priced as if it were still this one.
 *
 *  THE BOARD IS FROZEN AT ITS LEVEL-45 VALUE (owner decision, docs/POST_45_PROGRESSION.md).
 *  A periodic reward is a SHARE OF THE REQUIREMENT, so without this the daily and weekly
 *  payouts would inflate in lockstep with the new 46-50 thresholds and the extra levels
 *  would take exactly as long as the old ones — the file's own note below says as much:
 *  raising thresholds can never slow progression down, only this can. Levels 46-50 are meant
 *  to be bought with the new invasions instead.
 *
 *  It is 44, NOT 45, and the difference is the whole point. `xpToNextLevel(45)` used to mean
 *  "the final step reused" (218,000 - 193,000 = 25,000) because 45 was the top of the array.
 *  With five more tiers above it, 45 has a real next step — the new, much larger 45→46 one —
 *  so clamping at 45 would hand the board a raise at exactly the level it is supposed to be
 *  pinned to. Clamping at 44 keeps the 25,000 figure the shipped board has always been paid
 *  from, which is also what generate.test.ts asserts.
 *
 *  `dailyShare()` needs no such clamp: its interpolation already saturates at MAX_LEVEL. */
export const PERIODIC_XP_REFERENCE_LEVEL = 44;

/** XP needed to advance FROM `level` to the next one, for periodic-reward sizing. At the cap
 *  there is no next level, so the final step is reused — periodic quests keep paying at max
 *  level — and above PERIODIC_XP_REFERENCE_LEVEL the reference step is reused likewise. */
export function xpToNextLevel(level: number, thresholds: readonly number[]): number {
  const capped = Math.min(Math.floor(level), PERIODIC_XP_REFERENCE_LEVEL);
  const index = Math.max(1, Math.min(thresholds.length, capped));
  if (index >= thresholds.length) {
    return thresholds[thresholds.length - 1] - thresholds[thresholds.length - 2];
  }
  return thresholds[index] - thresholds[index - 1];
}

function dailyShare(level: number): number {
  const span = MAX_LEVEL - DAILY_UNLOCK_LEVEL;
  const t = Math.max(0, Math.min(1, (level - DAILY_UNLOCK_LEVEL) / span));
  return DAILY_SHARE_AT_UNLOCK + (DAILY_SHARE_AT_MAX_LEVEL - DAILY_SHARE_AT_UNLOCK) * t;
}

/** The value of ONE daily quest at this level — the unit every reward is a multiple
 *  of, dailies and weeklies alike. */
export function dailyUnitXp(level: number, xpToNext: number): number {
  return Math.max(1, Math.round((xpToNext * dailyShare(level)) / DAILY_SLOTS.length));
}

export function unlockLevel(scope: PeriodicScope): number {
  return scope === "daily" ? DAILY_UNLOCK_LEVEL : WEEKLY_UNLOCK_LEVEL;
}

// ------------------------------------------------------------------------ the roll

/** FNV-1a over the account id. Exact 32-bit integer arithmetic, so client and server
 *  derive the identical value for the identical account.
 *
 *  This is the ONLY entropy in the generator: everything else is a rotation driven by
 *  the period. A seeded PRNG was the obvious first choice, but rolling each slot
 *  independently every period means the same chore or crop can land two or three days
 *  running, which players read as a broken generator rather than as luck. Cycling
 *  guarantees variety and is trivially testable; the account term is what stops every
 *  farm seeing the same board on the same day. */
function accountSalt(accountId: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const slotsFor = (scope: PeriodicScope) => (scope === "daily" ? DAILY_SLOTS : WEEKLY_SLOTS);
const weightsFor = (scope: PeriodicScope) =>
  scope === "daily" ? DAILY_SLOT_WEIGHTS : WEEKLY_SLOT_WEIGHTS;

export interface PeriodicGenerationInput {
  accountId: string;
  scope: PeriodicScope;
  period: number;
  level: number;
  /** XP from `level` to the next — see xpToNextLevel. */
  xpToNext: number;
}

/** Roll one period's quests. The result carries its own counts (all zero) and an empty
 *  claim list, so it IS the starting state for that period. */
export function generatePeriodicSet(input: PeriodicGenerationInput): PeriodicScopeState {
  const { accountId, scope, period, level, xpToNext } = input;
  // Advances by exactly one every period, so every pool is WALKED rather than
  // re-rolled (see TemplateContext.rotation).
  const rotation = accountSalt(`${accountId}|${scope}`) + period;
  const band = levelBand(level);
  const unit = dailyUnitXp(level, xpToNext);
  const weights = weightsFor(scope);
  const scale = scope === "daily" ? 1 : WEEKLY_MULTIPLIER;
  const quests: PeriodicQuest[] = [];

  slotsFor(scope).forEach((pool, slot) => {
    // Step to this period's template, then walk forward from there so a template that
    // cannot build at this level (no crop in its window yet) falls through to a sibling
    // instead of silently dropping the slot. The per-slot offset keeps two slots from
    // advancing in lockstep.
    const start = (((rotation + slot * 3) % pool.length) + pool.length) % pool.length;
    let built: { template: QuestTemplate; quest: ReturnType<QuestTemplate["build"]> } | null = null;
    for (let i = 0; i < pool.length && !built; i++) {
      const template = pool[(start + i) % pool.length];
      const quest = template.build({ level, band, rotation });
      if (quest) built = { template, quest };
    }
    if (!built || !built.quest) return;
    quests.push({
      id: built.template.key,
      template: built.template.key,
      text: built.quest.text,
      icon: built.quest.icon,
      notificationID: built.quest.notificationID,
      notificationObject: built.quest.notificationObject,
      countTotal: built.quest.countTotal,
      xp: Math.max(1, Math.round(unit * scale * (weights[slot] ?? 1))),
    });
  });

  return { period, level, quests, counts: quests.map(() => 0), claimed: [] };
}

// ------------------------------------------------------------------- the lifecycle

export interface PeriodicRefreshContext {
  accountId: string;
  level: number;
  /** XP from `level` to the next — see xpToNextLevel. */
  xpToNext: number;
  now: number;
}

/** Bring both scopes in line with `now` and `level`, generating a fresh set whenever a
 *  period has rolled over (or a scope has just unlocked). Returns true if it changed
 *  anything, so callers can skip a write.
 *
 *  Rolling over DISCARDS unclaimed rewards — that is the point of a daily. */
export function refreshPeriodicState(
  state: PeriodicQuestState,
  ctx: PeriodicRefreshContext
): boolean {
  let changed = false;
  for (const scope of ["daily", "weekly"] as const) {
    if (ctx.level < unlockLevel(scope)) {
      if (state[scope]) { state[scope] = null; changed = true; }
      continue;
    }
    const period = periodIndex(scope, ctx.now);
    if (state[scope]?.period === period) continue;
    state[scope] = generatePeriodicSet({
      accountId: ctx.accountId, scope, period, level: ctx.level, xpToNext: ctx.xpToNext,
    });
    changed = true;
  }
  return changed;
}

/** An event as the engines emit it (server QuestEvent / client bus post). */
export interface PeriodicEvent {
  type: string;
  subject: string;
  aliases?: readonly string[];
}

/** Count events against both scopes. One event advances at most one step per quest,
 *  matching the catalog engine's behaviour. Returns true if any count moved. */
export function applyPeriodicEvents(
  state: PeriodicQuestState,
  events: readonly PeriodicEvent[]
): boolean {
  if (!events.length) return false;
  let changed = false;
  for (const scope of ["daily", "weekly"] as const) {
    const set = state[scope];
    if (!set) continue;
    set.quests.forEach((quest, index) => {
      const current = set.counts[index] ?? 0;
      if (current >= quest.countTotal) return;
      let next = current;
      for (const event of events) {
        if (next >= quest.countTotal) break;
        if (quest.notificationID !== event.type) continue;
        if (!questSubjectMatches(quest.notificationObject, event.subject, event.aliases)) continue;
        next++;
      }
      if (next !== current) { set.counts[index] = next; changed = true; }
    });
  }
  return changed;
}

export type PeriodicClaimResult =
  | { ok: true; xp: number; quest: PeriodicQuest }
  | { ok: false; error: "no_such_scope" | "no_such_quest" | "not_complete" | "already_claimed" };

/** Pay out one completed quest. The caller credits the XP — this only decides whether
 *  the claim is legal and records that it happened.
 *
 *  Call refreshPeriodicState FIRST. An id from an expired period is simply not in the
 *  current set, so it lands on `no_such_quest` and pays nothing. */
export function claimPeriodicQuest(
  state: PeriodicQuestState,
  scope: PeriodicScope,
  questId: string
): PeriodicClaimResult {
  const set = state[scope];
  if (!set) return { ok: false, error: "no_such_scope" };
  const index = set.quests.findIndex((quest) => quest.id === questId);
  if (index < 0) return { ok: false, error: "no_such_quest" };
  if (set.claimed.includes(questId)) return { ok: false, error: "already_claimed" };
  const quest = set.quests[index];
  if ((set.counts[index] ?? 0) < quest.countTotal) return { ok: false, error: "not_complete" };
  set.claimed = [...set.claimed, questId];
  return { ok: true, xp: quest.xp, quest };
}

/** Everything still worth claiming right now — used for the HUD's attention badge. */
export function claimablePeriodicCount(state: PeriodicQuestState): number {
  let total = 0;
  for (const scope of ["daily", "weekly"] as const) {
    const set = state[scope];
    if (!set) continue;
    set.quests.forEach((quest, index) => {
      if ((set.counts[index] ?? 0) >= quest.countTotal && !set.claimed.includes(quest.id)) total++;
    });
  }
  return total;
}

/** Presentation-ready view of both scopes, newest period boundary included. */
export function periodicViews(state: PeriodicQuestState, now: number): PeriodicScopeView[] {
  const out: PeriodicScopeView[] = [];
  for (const scope of ["daily", "weekly"] as const) {
    const set = state[scope];
    if (!set) continue;
    const quests: PeriodicQuestView[] = set.quests.map((quest, index) => {
      const count = Math.min(quest.countTotal, set.counts[index] ?? 0);
      return {
        scope,
        id: quest.id,
        text: quest.text,
        icon: quest.icon,
        count,
        total: quest.countTotal,
        done: count >= quest.countTotal,
        claimed: set.claimed.includes(quest.id),
        xp: quest.xp,
      };
    });
    out.push({ scope, endsAt: periodEndsAt(scope, now), quests });
  }
  return out;
}
