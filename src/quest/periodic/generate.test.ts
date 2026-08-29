import { describe, it, expect } from "vitest";
import plants from "../../../public/assets/plants.json";
import { cropAvailableInMarket } from "../../marketOrder";
import { XP_THRESHOLDS } from "../../GameState";
import {
  DAILY_UNLOCK_LEVEL, WEEKLY_MULTIPLIER, WEEKLY_UNLOCK_LEVEL, applyPeriodicEvents,
  claimPeriodicQuest, claimablePeriodicCount, dailyUnitXp, generatePeriodicSet,
  refreshPeriodicState, xpToNextLevel,
} from "./generate";
import {
  DAILY_FIELD_MAX, DAILY_MAX_GROW_MS, WEEKLY_COUNT_MULTIPLIER, WEEKLY_FIELD_MAX,
} from "./templates";
import { dayIndex } from "./periods";
import { emptyPeriodicState, type PeriodicQuestState } from "./types";

const ACCOUNT = "account-under-test";
const toNext = (level: number) => xpToNextLevel(level, XP_THRESHOLDS);
const daily = (level: number, period: number, accountId = ACCOUNT) =>
  generatePeriodicSet({ accountId, scope: "daily", period, level, xpToNext: toNext(level) });
const weekly = (level: number, period: number, accountId = ACCOUNT) =>
  generatePeriodicSet({ accountId, scope: "weekly", period, level, xpToNext: toNext(level) });

const cropByName = new Map(plants.map((crop) => [crop.name, crop]));

describe("periodic quest generation", () => {
  it("is deterministic — the same account, day and level always roll the same board", () => {
    expect(daily(20, 20670)).toEqual(daily(20, 20670));
    expect(weekly(30, 2953)).toEqual(weekly(30, 2953));
  });

  it("gives two different accounts different boards on the same day", () => {
    const mine = daily(25, 20670, "account-a");
    const theirs = daily(25, 20670, "account-b-quite-different");
    expect(mine.quests.map((q) => q.text)).not.toEqual(theirs.quests.map((q) => q.text));
  });

  it("fills every daily slot: a named crop, a farm chore, and an invasion", () => {
    const set = daily(20, 20670);
    expect(set.quests).toHaveLength(3);
    expect(set.quests[0].notificationID).toBe("kCropHarvestedNotification");
    expect(set.quests[0].notificationObject).not.toBe("");
    expect(["kInvasionSuccessfulNotification", "kInvasionPerfectGameNotification"])
      .toContain(set.quests[2].notificationID);
  });

  // Rotation rather than a fair roll is the whole reason the generator has no PRNG.
  // A repeat on consecutive days is the exact failure it exists to prevent.
  it("never repeats a quest on consecutive periods", () => {
    for (let period = 20670; period < 20690; period++) {
      const today = daily(30, period).quests.map((q) => q.text);
      const tomorrow = daily(30, period + 1).quests.map((q) => q.text);
      today.forEach((text, slot) => expect(tomorrow[slot]).not.toBe(text));
    }
  });

  // Below level 20 the invasion slot has only one buildable template, so it is the
  // same every day ON PURPOSE — the two crop/chore slots carry the variety.
  it("still varies the crop and chore slots before the flawless-win variant unlocks", () => {
    for (let period = 20670; period < 20690; period++) {
      const today = daily(12, period).quests.map((q) => q.text);
      const tomorrow = daily(12, period + 1).quests.map((q) => q.text);
      expect(tomorrow[0]).not.toBe(today[0]);
      expect(tomorrow[1]).not.toBe(today[1]);
    }
  });

  it("cycles every farm chore and every weekly goal across a full rotation", () => {
    const chores = new Set<string>();
    const goals = new Set<string>();
    for (let period = 20670; period < 20678; period++) chores.add(daily(30, period).quests[1].template);
    for (let period = 2953; period < 2961; period++) goals.add(weekly(30, period).quests[0].template);
    expect(chores.size).toBeGreaterThanOrEqual(4);
    expect(goals.size).toBeGreaterThanOrEqual(4);
  });

  it("only ever names a crop the player has unlocked", () => {
    for (let level = DAILY_UNLOCK_LEVEL; level <= 45; level++) {
      for (const set of [daily(level, 20670), weekly(level, 2953)]) {
        for (const quest of set.quests) {
          const crop = cropByName.get(quest.notificationObject);
          if (!crop) continue; // wildcard or non-crop objective
          expect(crop.level).toBeLessThanOrEqual(level);
        }
      }
    }
  });

  // Unlocked is not the same as OBTAINABLE. Seasonal seeds are withheld from every
  // purchase surface (marketOrder.ts cropAvailableInMarket) while their unlock levels
  // stay authored in plants.json, so a pool filtered on level alone happily named
  // Candy Corn at a farm with no way to buy one. The board rotates its pool rather
  // than rolling it, so such a crop is not a rare unlucky day — it comes round on a
  // schedule — which is why this sweeps whole periods, not one board.
  it("never names a crop the player cannot buy the seed for", () => {
    for (let level = DAILY_UNLOCK_LEVEL; level <= 45; level++) {
      for (let period = 20670; period < 20678; period++) {
        const sets = [daily(level, period), weekly(level, period)];
        for (const set of sets) {
          for (const quest of set.quests) {
            const crop = cropByName.get(quest.notificationObject);
            if (!crop) continue; // wildcard or non-crop objective
            expect(cropAvailableInMarket(crop)).toBe(true);
          }
        }
      }
    }
  });

  // A daily asking you to HARVEST a 24h crop cannot be finished inside its own day
  // unless the player happened to already have a field of it planted. Planting has no
  // such constraint, which is why only the harvest objective is bounded here.
  it("keeps daily HARVEST objectives inside a grow time a day can actually cycle", () => {
    for (let level = DAILY_UNLOCK_LEVEL; level <= 45; level++) {
      for (let period = 20670; period < 20676; period++) {
        for (const quest of daily(level, period).quests) {
          if (quest.notificationID !== "kCropHarvestedNotification") continue;
          const crop = cropByName.get(quest.notificationObject);
          if (crop) expect(crop.growMs).toBeLessThanOrEqual(DAILY_MAX_GROW_MS);
        }
      }
    }
  });

  // The weekly counts are DERIVED from the daily ones, so this is the property that
  // keeps a weekly a fixed multiple of its daily after either is tuned. Most objectives
  // use WEEKLY_COUNT_MULTIPLIER; harvestAny carries an override so its ramp can stay
  // under a 200 ceiling (see WEEKLY_MULTIPLIER_OVERRIDE).
  it("asks a weekly for a fixed multiple of its daily counterpart", () => {
    const pairs: [string, string, keyof typeof CEILING | "invade" | "harvestAny" | "other"][] = [
      ["daily_harvest_any", "weekly_harvest_any", "harvestAny"],
      ["daily_harvest_crop", "weekly_harvest_crop", "other"],
      ["daily_harvest_zombies", "weekly_harvest_zombies", "other"],
      ["daily_invade", "weekly_invade", "invade"],
    ];
    const CEILING = { invade: 8, harvestAny: WEEKLY_FIELD_MAX, other: Infinity } as const;
    const MULT = { invade: WEEKLY_COUNT_MULTIPLIER, harvestAny: 3.3, other: WEEKLY_COUNT_MULTIPLIER };
    for (let level = 20; level <= 45; level += 5) {
      const dailies = new Map<string, number>();
      const weeklies = new Map<string, number>();
      // Walk a full rotation so every template in every slot gets built at this level.
      for (let period = 0; period < 12; period++) {
        for (const q of daily(level, 20670 + period).quests) dailies.set(q.template, q.countTotal);
        for (const q of weekly(level, 2953 + period).quests) weeklies.set(q.template, q.countTotal);
      }
      for (const [dailyKey, weeklyKey, kind] of pairs) {
        const one = dailies.get(dailyKey);
        const many = weeklies.get(weeklyKey);
        if (one === undefined || many === undefined) continue;
        const k = kind as keyof typeof CEILING;
        expect(many, `${weeklyKey} at level ${level}`)
          .toBe(Math.min(Math.round(one * MULT[k]), CEILING[k]));
      }
    }
  });

  // The two ceilings the board is tuned against: a daily field chore must fit inside what
  // an hour of play produces (measured at ~176 harvests a day for a full level-44 field),
  // and a week may ask a multiple of that but not an open-ended one. These are design
  // constraints, not preferences — a band edited past them fails here.
  //
  // BOTH field objectives are covered. Harvesting and plowing track each other one-for-one
  // (every spent plot is re-tilled before it is replanted), so capping one and leaving the
  // other simply moves the day's workload to the uncapped slot — which is exactly what
  // happened when harvestAny was capped on its own.
  it("keeps every field objective under its daily and weekly ceiling", () => {
    // Plowing has no weekly template — the weekly board's field slot is the harvest one.
    const DAILY_FIELD = ["daily_harvest_any", "daily_plow"];
    const WEEKLY_FIELD = ["weekly_harvest_any"];
    const seen = new Set<string>();
    for (let level = DAILY_UNLOCK_LEVEL; level <= 45; level++) {
      for (let period = 0; period < 12; period++) {
        for (const q of daily(level, 20670 + period).quests) {
          if (!DAILY_FIELD.includes(q.template)) continue;
          seen.add(q.template);
          expect(q.countTotal, `${q.template} at level ${level}`)
            .toBeLessThanOrEqual(DAILY_FIELD_MAX);
        }
        if (level < 15) continue;
        for (const q of weekly(level, 2953 + period).quests) {
          if (!WEEKLY_FIELD.includes(q.template)) continue;
          seen.add(q.template);
          expect(q.countTotal, `${q.template} at level ${level}`)
            .toBeLessThanOrEqual(WEEKLY_FIELD_MAX);
        }
      }
    }
    // Guard against the assertions above silently covering nothing if a template is
    // renamed — every field objective must actually have been rolled and checked.
    expect([...seen].sort()).toEqual([...DAILY_FIELD, ...WEEKLY_FIELD].sort());
  });

  // Invasions are the one objective bounded by a real-time cooldown rather than by the
  // farm, so these ceilings are a design constraint and not a tuning preference.
  it("never asks for more than 2 invasions a day or 8 a week", () => {
    const INVASION_EVENTS = new Set([
      "kInvasionSuccessfulNotification", "kInvasionPerfectGameNotification",
    ]);
    for (let level = DAILY_UNLOCK_LEVEL; level <= 45; level++) {
      for (let period = 0; period < 12; period++) {
        for (const quest of daily(level, 20670 + period).quests) {
          if (INVASION_EVENTS.has(quest.notificationID)) {
            expect(quest.countTotal, `daily ${quest.template} at level ${level}`).toBeLessThanOrEqual(2);
          }
        }
        if (level < WEEKLY_UNLOCK_LEVEL) continue;
        for (const quest of weekly(level, 2953 + period).quests) {
          if (INVASION_EVENTS.has(quest.notificationID)) {
            expect(quest.countTotal, `weekly ${quest.template} at level ${level}`).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });

  // The weekly counts are derived from the daily ones, and a derivation carries a
  // template's NUMBER across without its reasons. `daily_invade_clean` withholds itself
  // below level 20 because a farm that cannot absorb a stage should not be asked for a
  // flawless win — and 5x of a quest that was never offered is how a level-15 board came
  // to demand five of them. Both scopes answer the level question the same way now.
  it("asks neither scope for a flawless invasion before the daily would offer one", () => {
    const FLAWLESS = "kInvasionPerfectGameNotification";
    for (let level = WEEKLY_UNLOCK_LEVEL; level < 20; level++) {
      for (let period = 0; period < 12; period++) {
        for (const quest of daily(level, 20670 + period).quests) {
          expect(quest.notificationID, `daily at level ${level}`).not.toBe(FLAWLESS);
        }
        for (const quest of weekly(level, 2953 + period).quests) {
          expect(quest.notificationID, `weekly at level ${level}`).not.toBe(FLAWLESS);
        }
      }
    }
  });

  // Withholding the flawless variant must not cost the slot — it falls through to the
  // ordinary win rather than leaving the board a quest short.
  it("still fills the invasion slot in both scopes below that gate", () => {
    const INVASION_EVENTS = new Set([
      "kInvasionSuccessfulNotification", "kInvasionPerfectGameNotification",
    ]);
    const hasInvasion = (quests: { notificationID: string }[]) =>
      quests.some((q) => INVASION_EVENTS.has(q.notificationID));
    for (let level = WEEKLY_UNLOCK_LEVEL; level < 20; level++) {
      for (let period = 0; period < 12; period++) {
        expect(hasInvasion(daily(level, 20670 + period).quests), `daily at level ${level}`).toBe(true);
        expect(hasInvasion(weekly(level, 2953 + period).quests), `weekly at level ${level}`).toBe(true);
      }
    }
  });

  // Above the gate the derivation applies as it does everywhere else: one a day, five a
  // week. Pinned because this pair is the one the 5x property test above cannot cover —
  // the daily does not exist at every band, so it is excluded from `pairs` there.
  it("asks a weekly for five flawless wins once the daily asks for one", () => {
    for (const level of [20, 30, 45]) {
      const dailies = new Map<string, number>();
      const weeklies = new Map<string, number>();
      for (let period = 0; period < 12; period++) {
        for (const q of daily(level, 20670 + period).quests) dailies.set(q.template, q.countTotal);
        for (const q of weekly(level, 2953 + period).quests) weeklies.set(q.template, q.countTotal);
      }
      expect(dailies.get("daily_invade_clean"), `daily at level ${level}`).toBe(1);
      expect(weeklies.get("weekly_perfect_invade"), `weekly at level ${level}`).toBe(5);
    }
  });

  it("lets a planting objective name a crop no harvest daily could", () => {
    const grows: number[] = [];
    for (let period = 0; period < 12; period++) {
      for (const quest of daily(40, 20670 + period).quests) {
        if (quest.notificationID !== "kCropPlantedNotification") continue;
        const crop = cropByName.get(quest.notificationObject);
        if (crop) grows.push(crop.growMs);
      }
    }
    expect(grows.length).toBeGreaterThan(0);
    expect(grows.some((growMs) => growMs > DAILY_MAX_GROW_MS)).toBe(true);
  });

  it("lets weeklies name the long crops a daily cannot", () => {
    const named: number[] = [];
    for (let period = 2953; period < 2969; period++) {
      const crop = cropByName.get(weekly(40, period).quests[0].notificationObject);
      if (crop) named.push(crop.growMs);
    }
    expect(named.some((growMs) => growMs > DAILY_MAX_GROW_MS)).toBe(true);
  });
});

describe("periodic quest rewards", () => {
  // The two anchors the curve was fitted to. They are what makes a daily feel worth
  // doing at both ends of a 28x XP curve; a flat share of the level cannot hit both.
  it("pays roughly 30 XP for a daily around level 10 and roughly 330 at the cap", () => {
    expect(dailyUnitXp(10, toNext(10))).toBeGreaterThanOrEqual(20);
    expect(dailyUnitXp(10, toNext(10))).toBeLessThanOrEqual(40);
    expect(dailyUnitXp(45, toNext(45))).toBeGreaterThanOrEqual(250);
    expect(dailyUnitXp(45, toNext(45))).toBeLessThanOrEqual(420);
  });

  // The point of the halved max-level endpoint: the top of the curve must not be able
  // to out-earn the early game's SHARE of a level. A regression that walked the cap
  // share back up would show here first.
  it("pays a smaller share of the level at the cap than at the unlock level", () => {
    const shareAt = (level: number) => (dailyUnitXp(level, toNext(level)) * 3) / toNext(level);
    expect(shareAt(45)).toBeLessThan(shareAt(DAILY_UNLOCK_LEVEL) / 2);
    expect(shareAt(45)).toBeCloseTo(0.04, 3);
  });

  it("makes one weekly worth about seven dailies", () => {
    const level = 30;
    const unit = dailyUnitXp(level, toNext(level));
    for (const quest of weekly(level, 2953).quests) {
      expect(quest.xp).toBeCloseTo(unit * WEEKLY_MULTIPLIER, -1);
    }
  });

  it("never pays zero, even at the lowest unlocked level", () => {
    for (const quest of daily(DAILY_UNLOCK_LEVEL, 20670).quests) {
      expect(quest.xp).toBeGreaterThan(0);
    }
  });

  it("keeps paying at the level cap, where there is no next level", () => {
    expect(toNext(45)).toBe(XP_THRESHOLDS[44] - XP_THRESHOLDS[43]);
    expect(daily(45, 20670).quests.every((q) => q.xp > 0)).toBe(true);
  });
});

describe("periodic quest lifecycle", () => {
  const ctx = (level: number, now: number) =>
    ({ accountId: ACCOUNT, level, xpToNext: toNext(level), now });

  it("withholds each scope until its unlock level", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const early = emptyPeriodicState();
    refreshPeriodicState(early, ctx(DAILY_UNLOCK_LEVEL - 1, now));
    expect(early.daily).toBeNull();
    expect(early.weekly).toBeNull();

    const mid = emptyPeriodicState();
    refreshPeriodicState(mid, ctx(WEEKLY_UNLOCK_LEVEL - 1, now));
    expect(mid.daily).not.toBeNull();
    expect(mid.weekly).toBeNull();

    const late = emptyPeriodicState();
    refreshPeriodicState(late, ctx(WEEKLY_UNLOCK_LEVEL, now));
    expect(late.weekly).not.toBeNull();
  });

  it("regenerates on a new day and discards unclaimed progress", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, ctx(30, now));
    state.daily!.counts[0] = state.daily!.quests[0].countTotal;
    const yesterday = state.daily!.period;

    expect(refreshPeriodicState(state, ctx(30, now + 60_000))).toBe(false); // same day
    expect(state.daily!.counts[0]).toBeGreaterThan(0);

    expect(refreshPeriodicState(state, ctx(30, now + 86_400_000))).toBe(true);
    expect(state.daily!.period).toBe(yesterday + 1);
    expect(state.daily!.counts).toEqual([0, 0, 0]);
    expect(state.daily!.claimed).toEqual([]);
  });

  it("freezes the reward at the level the board was generated for", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, ctx(20, now));
    const rewardAtGeneration = state.daily!.quests[0].xp;
    // Level up without the day changing: the board — and its rewards — must not move.
    refreshPeriodicState(state, ctx(40, now + 60_000));
    expect(state.daily!.quests[0].xp).toBe(rewardAtGeneration);
    expect(state.daily!.level).toBe(20);
  });
});

describe("periodic quest progress", () => {
  const boardAt = (level: number, now: number): PeriodicQuestState => {
    const state = emptyPeriodicState();
    refreshPeriodicState(state, { accountId: ACCOUNT, level, xpToNext: toNext(level), now });
    return state;
  };

  it("counts a matching event and ignores everything else", () => {
    const state = boardAt(30, Date.UTC(2026, 7, 8, 12));
    const invasionIndex = state.daily!.quests.findIndex(
      (q) => q.notificationID === "kInvasionSuccessfulNotification");
    applyPeriodicEvents(state, [{ type: "kInvasionSuccessfulNotification", subject: "Old McDonnell's Farm" }]);
    expect(state.daily!.counts[invasionIndex]).toBe(1);
    applyPeriodicEvents(state, [{ type: "kPhotoTakenNotification", subject: "" }]);
    expect(state.daily!.counts[invasionIndex]).toBe(1);
  });

  it("respects the named subject, so a different crop does not count", () => {
    const state = boardAt(30, Date.UTC(2026, 7, 8, 12));
    const quest = state.daily!.quests[0];
    applyPeriodicEvents(state, [{ type: quest.notificationID, subject: "Definitely Not That Crop" }]);
    expect(state.daily!.counts[0]).toBe(0);
    applyPeriodicEvents(state, [{ type: quest.notificationID, subject: quest.notificationObject }]);
    expect(state.daily!.counts[0]).toBe(1);
  });

  it("clamps at the target rather than overshooting", () => {
    const state = boardAt(30, Date.UTC(2026, 7, 8, 12));
    const quest = state.daily!.quests[0];
    const events = Array.from({ length: quest.countTotal + 25 },
      () => ({ type: quest.notificationID, subject: quest.notificationObject }));
    applyPeriodicEvents(state, events);
    expect(state.daily!.counts[0]).toBe(quest.countTotal);
  });
});

describe("periodic quest claiming", () => {
  const readyBoard = () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, { accountId: ACCOUNT, level: 30, xpToNext: toNext(30), now });
    return state;
  };

  it("refuses a quest that is not finished", () => {
    const state = readyBoard();
    expect(claimPeriodicQuest(state, "daily", state.daily!.quests[0].id))
      .toEqual({ ok: false, error: "not_complete" });
  });

  it("pays once and refuses the second attempt", () => {
    const state = readyBoard();
    const quest = state.daily!.quests[0];
    state.daily!.counts[0] = quest.countTotal;
    expect(claimablePeriodicCount(state)).toBe(1);

    const first = claimPeriodicQuest(state, "daily", quest.id);
    expect(first).toMatchObject({ ok: true, xp: quest.xp });
    expect(claimablePeriodicCount(state)).toBe(0);
    expect(claimPeriodicQuest(state, "daily", quest.id))
      .toEqual({ ok: false, error: "already_claimed" });
  });

  // This is the expiry rule. Yesterday's ids are simply not in today's set, so a claim
  // that arrives late pays nothing rather than paying against the new board.
  it("refuses a quest id from an expired period", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, { accountId: ACCOUNT, level: 30, xpToNext: toNext(30), now });
    const stale = state.daily!.quests[0];
    state.daily!.counts[0] = stale.countTotal;

    refreshPeriodicState(state, { accountId: ACCOUNT, level: 30, xpToNext: toNext(30), now: now + 86_400_000 });
    const result = claimPeriodicQuest(state, "daily", stale.id);
    // A different template today → unknown id. The same template → freshly zeroed.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["no_such_quest", "not_complete"]).toContain(result.error);
  });

  it("refuses a scope the player has not unlocked", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, { accountId: ACCOUNT, level: 10, xpToNext: toNext(10), now });
    expect(claimPeriodicQuest(state, "weekly", "weekly_invade"))
      .toEqual({ ok: false, error: "no_such_scope" });
  });

  it("puts today's board on today's day index", () => {
    const now = Date.UTC(2026, 7, 8, 12);
    const state = emptyPeriodicState();
    refreshPeriodicState(state, { accountId: ACCOUNT, level: 30, xpToNext: toNext(30), now });
    expect(state.daily!.period).toBe(dayIndex(now));
  });
});
