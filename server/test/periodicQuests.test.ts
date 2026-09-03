// Daily/weekly quests through the authoritative engine.
//
// The generator itself is covered client-side (src/quest/periodic/generate.test.ts).
// What matters HERE is the part only the server can get wrong: that a command batch
// advances the board, that the claim command is the only thing that pays, and that it
// cannot be made to pay twice or to pay for an expired day.
import { describe, it, expect } from "vitest";
import plantRows from "../../public/assets/plants.json";
import { applyCommandBatch, freshGameplayState, periodicStateOf } from "../src/v3/engine";
import { XP_THRESHOLDS, levelForXp } from "../src/levels";
import { generatePeriodicSet, xpToNextLevel } from "../../src/quest/periodic/generate";
import { periodIndex } from "../../src/quest/periodic/periods";
import type { GameplayCommand } from "../../src/net/protocol";
import type { MutableGameplayState } from "../src/v3/engine";

const ACCOUNT = "account-periodic";
const NOON = Date.UTC(2026, 7, 8, 12);
const DAY = 86_400_000;

const commands = (...list: GameplayCommand[]) =>
  list.map((command, index) => ({ sequence: index + 1, command }));

/** A state at a level high enough for both scopes, with gold to actually farm. */
function stateAtLevel(level: number): MutableGameplayState {
  const state = freshGameplayState();
  state.balance.xp = XP_THRESHOLDS[level - 1];
  state.balance.gold = 500_000;
  expect(levelForXp(state.balance.xp)).toBe(level);
  return state;
}

/** Plow + plant + harvest one plot of `cropKey`, returning the resulting state. */
function harvestOnce(state: MutableGameplayState, cropKey: string, now: number, plot = 0) {
  const oc = plot * 4;
  const plowed = applyCommandBatch(state, commands(
    { type: "farm.plow", oc, or: 0 },
    { type: "farm.plant", oc, or: 0, cropKey },
  ), { now, accountId: ACCOUNT });
  expect(plowed.results.every((r) => r.status === "applied")).toBe(true);
  // Five hours: past the grow time of anything a daily can name (they are capped at
  // four), but deliberately still INSIDE the same UTC day. Waiting a full day instead
  // would roll the board over and count the harvest against tomorrow's quests.
  const later = now + 5 * 3_600_000;
  return applyCommandBatch(plowed.state, commands({ type: "farm.harvest", oc, or: 0 }),
    { now: later, accountId: ACCOUNT });
}

describe("periodic quests — the authoritative board", () => {
  it("generates a board on the first batch of the day", () => {
    const result = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const periodic = periodicStateOf(result.state);
    expect(periodic.daily?.quests).toHaveLength(3);
    expect(periodic.weekly?.quests).toHaveLength(2);
    expect(result.periodicChanged).toBe(true);
  });

  it("withholds both scopes below their unlock levels", () => {
    const result = applyCommandBatch(stateAtLevel(3), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    expect(periodicStateOf(result.state).daily).toBeNull();
    expect(periodicStateOf(result.state).weekly).toBeNull();
  });

  it("advances a harvest objective from the ordinary farm commands", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const board = periodicStateOf(seeded.state);
    const index = board.daily!.quests.findIndex(
      (quest) => quest.notificationID === "kCropHarvestedNotification");
    expect(index).toBeGreaterThanOrEqual(0);
    const quest = board.daily!.quests[index];
    // "Harvest N <crop>" names a crop; "Harvest N crops" is the wildcard. Either way
    // harvesting the named crop (or any crop, for the wildcard) has to count.
    const cropKey = quest.notificationObject
      ? plantKeyForName(quest.notificationObject)
      : "carrot";
    const after = harvestOnce(seeded.state, cropKey, NOON);
    expect(after.results[0].status).toBe("applied");
    expect(periodicStateOf(after.state).daily!.counts[index]).toBe(1);
  });

  it("pays only on claim — finishing a quest grants nothing by itself", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const board = periodicStateOf(seeded.state);
    const quest = board.daily!.quests[0];
    board.daily!.counts[0] = quest.countTotal;
    const xpBefore = seeded.state.balance.xp;

    // A batch that touches nothing must not pay for the finished quest.
    const idle = applyCommandBatch(seeded.state, commands({ type: "writer.claim" }),
      { now: NOON + 1000, accountId: ACCOUNT });
    expect(idle.state.balance.xp).toBe(xpBefore);

    const claimed = applyCommandBatch(idle.state,
      commands({ type: "quest.periodic_claim", scope: "daily", questId: quest.id }),
      { now: NOON + 2000, accountId: ACCOUNT });
    expect(claimed.results[0].status).toBe("applied");
    expect(claimed.state.balance.xp).toBe(xpBefore + quest.xp);
  });

  it("refuses a second claim of the same quest", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const quest = periodicStateOf(seeded.state).daily!.quests[0];
    periodicStateOf(seeded.state).daily!.counts[0] = quest.countTotal;

    const claim: GameplayCommand = { type: "quest.periodic_claim", scope: "daily", questId: quest.id };
    const twice = applyCommandBatch(seeded.state, commands(claim, claim),
      { now: NOON + 1000, accountId: ACCOUNT });
    expect(twice.results[0].status).toBe("applied");
    // Resource poisoning only fires behind a REJECTED command, and the first claim
    // succeeded — so the second really does reach the engine, and the claimed-id list
    // is what stops it. That is the guard that matters: it survives the two claims
    // arriving in separate batches, or from two devices, where nothing else would.
    expect(twice.results[1]).toMatchObject({ status: "rejected", error: "already_claimed" });
    expect(twice.state.balance.xp).toBe(seeded.state.balance.xp + quest.xp);
  });

  it("refuses a claim for an unfinished quest", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const quest = periodicStateOf(seeded.state).daily!.quests[0];
    const result = applyCommandBatch(seeded.state,
      commands({ type: "quest.periodic_claim", scope: "daily", questId: quest.id }),
      { now: NOON + 1000, accountId: ACCOUNT });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "not_complete" });
    expect(result.state.balance.xp).toBe(seeded.state.balance.xp);
  });

  // The reason the roll-forward happens BEFORE commands are applied: a claim that
  // arrives after midnight is judged against the new day's board, where yesterday's
  // finished quest no longer exists.
  it("refuses a claim that arrives after its day has rolled over", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const quest = periodicStateOf(seeded.state).daily!.quests[0];
    periodicStateOf(seeded.state).daily!.counts[0] = quest.countTotal;
    const xpBefore = seeded.state.balance.xp;

    const late = applyCommandBatch(seeded.state,
      commands({ type: "quest.periodic_claim", scope: "daily", questId: quest.id }),
      { now: NOON + DAY, accountId: ACCOUNT });
    expect(late.results[0].status).toBe("rejected");
    expect(late.state.balance.xp).toBe(xpBefore);
    expect(periodicStateOf(late.state).daily!.counts).toEqual([0, 0, 0]);
  });

  it("rejects an unknown quest id rather than paying anything", () => {
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const result = applyCommandBatch(seeded.state,
      commands({ type: "quest.periodic_claim", scope: "daily", questId: "not_a_real_quest" }),
      { now: NOON + 1000, accountId: ACCOUNT });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "no_such_quest" });
    expect(result.state.balance.xp).toBe(seeded.state.balance.xp);
  });

  // The batch that CROSSES level 5. The sets used to be rolled forward only before
  // the commands ran, at the level the player arrived with — so this batch saw level
  // 4, generated nothing, and the board appeared a batch later (one more command and
  // up to thirty seconds) or on reload. The plot is plowed and planted in an earlier
  // batch, the XP is then pinned one short of level 5, and the harvest crosses it.
  function crossingBatch(extra: GameplayCommand[] = [], target: 5 | 15 = 5, now = NOON) {
    const scope = target === 5 ? "daily" : "weekly";
    const state = freshGameplayState();
    state.balance.gold = 500_000;
    state.balance.xp = XP_THRESHOLDS[target - 2];
    expect(levelForXp(state.balance.xp)).toBe(target - 1);
    const plowed = applyCommandBatch(state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
    ), { now, accountId: ACCOUNT });
    expect(plowed.results.every((r) => r.status === "applied")).toBe(true);
    expect(periodicStateOf(plowed.state)[scope]).toBeNull();
    plowed.state.balance.xp = XP_THRESHOLDS[target - 1] - 1;
    return applyCommandBatch(plowed.state, commands({ type: "farm.harvest", oc: 0, or: 0 }, ...extra),
      { now: now + 5 * 3_600_000, accountId: ACCOUNT });
  }

  it("hands a level-5 crossing its board in that batch's own response", () => {
    const after = crossingBatch();
    expect(after.results[0].status).toBe("applied");
    const level = levelForXp(after.state.balance.xp);
    expect(level).toBeGreaterThanOrEqual(5);
    const daily = periodicStateOf(after.state).daily;
    expect(daily?.quests.length).toBeGreaterThan(0);
    expect(daily?.level).toBe(level);
    expect(after.periodicChanged).toBe(true);
  });

  it("installs the board the client authored for the level it crossed", () => {
    const after = crossingBatch([{ type: "quest.periodic_author", scope: "daily", level: 5 }]);
    expect(after.results[1]).toMatchObject({ status: "applied" });
    const daily = periodicStateOf(after.state).daily!;
    expect(daily.level).toBe(5);
    expect(daily.counts.every((count) => count === 0)).toBe(true);
    expect(daily.claimed).toEqual([]);
    // The exact set the client drew: same generator, same account, same period, same
    // level — nothing about it crossed the wire.
    const expected = generatePeriodicSet({
      accountId: ACCOUNT, scope: "daily", period: periodIndex("daily", NOON), level: 5,
      xpToNext: xpToNextLevel(5, XP_THRESHOLDS),
    });
    expect(daily.quests).toEqual(expected.quests);
  });

  it("clamps a forged level to the XP the server holds", () => {
    const after = crossingBatch([{ type: "quest.periodic_author", scope: "daily", level: 40 }]);
    expect(after.results[1]).toMatchObject({ status: "applied" });
    expect(periodicStateOf(after.state).daily!.level).toBe(levelForXp(after.state.balance.xp));
  });

  it("refuses to author a scope below its unlock", () => {
    const result = applyCommandBatch(stateAtLevel(3),
      commands({ type: "quest.periodic_author", scope: "daily", level: 5 }),
      { now: NOON, accountId: ACCOUNT });
    expect(result.results[0]).toMatchObject({ status: "rejected", error: "below_unlock" });
    expect(periodicStateOf(result.state).daily).toBeNull();
    expect(result.periodicChanged).toBe(false);
  });

  it("never re-rolls a board that already exists for the period", () => {
    // The per-day cap's backbone: a second author for the same period would be a free
    // reset of counts and claims, so it is refused and the board is left untouched.
    const seeded = applyCommandBatch(stateAtLevel(30), commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const board = periodicStateOf(seeded.state);
    board.daily!.counts[0] = 2;
    board.daily!.claimed = [board.daily!.quests[1].id];
    const before = JSON.stringify(board);

    const again = applyCommandBatch(seeded.state,
      commands({ type: "quest.periodic_author", scope: "daily", level: 30 }),
      { now: NOON + 1000, accountId: ACCOUNT });
    expect(again.results[0]).toMatchObject({ status: "rejected", error: "already_authored" });
    expect(JSON.stringify(periodicStateOf(again.state))).toBe(before);
    expect(again.periodicChanged).toBe(false);
  });

  it("authors the weekly scope the same way, in the batch that crosses 15", () => {
    const after = crossingBatch([{ type: "quest.periodic_author", scope: "weekly", level: 15 }], 15);
    expect(after.results[1]).toMatchObject({ status: "applied" });
    expect(periodicStateOf(after.state).weekly?.level).toBe(15);
    // And the daily board the player already had is untouched by the crossing.
    expect(periodicStateOf(after.state).daily?.level).toBe(14);
  });

  // The client coalesces up to 30 seconds of play into one POST, so the harvest that
  // finishes a quest and the claim for it genuinely can share a batch.
  it("lets a claim collect a quest finished earlier in the same batch", () => {
    const state = stateAtLevel(30);
    const seeded = applyCommandBatch(state, commands({ type: "writer.claim" }),
      { now: NOON, accountId: ACCOUNT });
    const board = periodicStateOf(seeded.state);
    const index = board.daily!.quests.findIndex((quest) => quest.template === "daily_plow");
    if (index < 0) return; // this account's board has a different chore today
    const quest = board.daily!.quests[index];
    // One short of the target, so a single plow inside the batch finishes it.
    board.daily!.counts[index] = quest.countTotal - 1;
    const xpBefore = seeded.state.balance.xp;

    const batch = applyCommandBatch(seeded.state, commands(
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "quest.periodic_claim", scope: "daily", questId: quest.id },
    ), { now: NOON + 1000, accountId: ACCOUNT });
    expect(batch.results[0].status).toBe("applied");
    expect(batch.results[1].status).toBe("applied");
    expect(batch.state.balance.xp).toBeGreaterThanOrEqual(xpBefore + quest.xp);
  });
});

/** plants.json key for a display name, so a generated objective can be acted on. */
function plantKeyForName(name: string): string {
  const row = (plantRows as { key: string; name: string }[]).find((crop) => crop.name === name);
  expect(row, `no plant named ${name}`).toBeTruthy();
  return row!.key;
}
