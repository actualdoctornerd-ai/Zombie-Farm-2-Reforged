import { describe, expect, it, vi } from "vitest";
import { GameState, XP_THRESHOLDS } from "../../GameState";
import { generatePeriodicSet, xpToNextLevel } from "./generate";
import { periodIndex } from "./periods";
import { QuestBus } from "../events";
import { PeriodicQuestSystem } from "./PeriodicQuestSystem";
import type { PeriodicScopeState } from "./types";

const completedDaily = (): PeriodicScopeState => ({
  period: 20_000,
  level: 10,
  quests: [{
    id: "daily_plow",
    template: "daily_plow",
    text: "Plow 5 plots",
    icon: "plow.png",
    notificationID: "kSoilPlowedNotification",
    notificationObject: "",
    countTotal: 5,
    xp: 30,
  }],
  counts: [5],
  claimed: [],
});

// The level-up that unlocks dailies. Online the client draws the board itself the
// instant it qualifies and asks the server for the same one; before this it waited for
// the next batch response, so the star button trailed Tim's level-5 notice by a batch.
describe("PeriodicQuestSystem authoritative authoring", () => {
  function online(submitAuthor = vi.fn(() => true)) {
    const state = new GameState();
    const render = vi.fn();
    const system = new PeriodicQuestSystem(state, () => "account", new QuestBus(), {
      authoritative: true,
      submitAuthor,
      render,
    });
    return { state, system, render, submitAuthor };
  }

  it("draws the daily board on the level-up and asks the server for the same one", () => {
    const { state, system, submitAuthor } = online();
    system.adoptAuthoritative({ daily: null, weekly: null });
    expect(system.views()).toEqual([]);

    state.addXp(XP_THRESHOLDS[4]); // level 5

    expect(submitAuthor).toHaveBeenCalledExactlyOnceWith("daily", 5);
    const [daily] = system.views();
    expect(daily.scope).toBe("daily");
    expect(daily.quests.length).toBeGreaterThan(0);
    // The exact set the server will derive: same generator, account, period and level.
    const expected = generatePeriodicSet({
      accountId: "account", scope: "daily", period: periodIndex("daily", Date.now()), level: 5,
      xpToNext: xpToNextLevel(5, XP_THRESHOLDS),
    });
    expect(daily.quests.map((quest) => quest.id)).toEqual(expected.quests.map((quest) => quest.id));
    expect(daily.quests.every((quest) => quest.count === 0 && !quest.claimed)).toBe(true);
  });

  it("asks once per period, however many changes follow", () => {
    const { state, system, submitAuthor } = online();
    system.adoptAuthoritative({ daily: null, weekly: null });
    state.addXp(XP_THRESHOLDS[4]);
    state.addXp(10);
    system.refresh();
    expect(submitAuthor).toHaveBeenCalledTimes(1);
  });

  it("draws nothing before the server's projection has been adopted", () => {
    const { state, system, submitAuthor } = online();
    state.addXp(XP_THRESHOLDS[4]);
    expect(submitAuthor).not.toHaveBeenCalled();
    expect(system.views()).toEqual([]);
  });

  it("is replaced by the server's board when the projection lands", () => {
    const { state, system } = online();
    system.adoptAuthoritative({ daily: null, weekly: null });
    state.addXp(XP_THRESHOLDS[4]);
    const server = completedDaily();
    system.adoptAuthoritative({ daily: server, weekly: null });
    expect(system.views()[0].quests.map((quest) => quest.id)).toEqual(["daily_plow"]);
    expect(system.claimable).toBe(1);
  });

  it("takes its own board down when the server says the level was not real", () => {
    const { state, system, render } = online();
    system.adoptAuthoritative({ daily: null, weekly: null });
    state.addXp(XP_THRESHOLDS[4]);
    expect(system.views()).toHaveLength(1);
    render.mockClear();

    system.authorRefused("daily", "below_unlock");

    expect(system.views()).toEqual([]);
    expect(render).toHaveBeenCalledOnce();
    // And it is not drawn again this period on the next change.
    state.addXp(1);
    expect(system.views()).toEqual([]);
  });

  it("keeps its board when the server already had the same one", () => {
    const { state, system } = online();
    system.adoptAuthoritative({ daily: null, weekly: null });
    state.addXp(XP_THRESHOLDS[4]);
    system.authorRefused("daily", "already_authored");
    expect(system.views()).toHaveLength(1);
  });

  it("retries a send that could not be queued on the next change", () => {
    const submitAuthor = vi.fn(() => false);
    const { state, system } = online(submitAuthor);
    system.adoptAuthoritative({ daily: null, weekly: null });
    state.addXp(XP_THRESHOLDS[4]);
    // Drawn regardless — the server's own roll-forward will confirm it — but asked
    // again once the queue is back.
    expect(system.views()).toHaveLength(1);
    submitAuthor.mockReturnValue(true);
    system.adoptAuthoritative({ daily: null, weekly: null }); // a projection without it yet
    state.addXp(1);
    expect(submitAuthor).toHaveBeenCalledTimes(2);
    expect(submitAuthor).toHaveBeenLastCalledWith("daily", 5);
  });
});

// The display-only preview. Online the board's counts used to move only with the batch
// response — up to thirty seconds after the chore — while the catalog quests beside
// them moved at once. The preview applies the server's own counting function to a copy
// of the adopted state; the copy is discarded by every projection, and the Claim is
// still gated on the server's count.
describe("PeriodicQuestSystem authoritative preview", () => {
  const openDaily = (): PeriodicScopeState => ({ ...completedDaily(), counts: [3] });
  function online() {
    const bus = new QuestBus();
    const render = vi.fn();
    const requestConfirmation = vi.fn();
    const submitClaim = vi.fn(() => true);
    const system = new PeriodicQuestSystem(new GameState(), () => "account", bus, {
      authoritative: true, submitClaim, requestConfirmation, render,
    });
    return { bus, system, render, requestConfirmation, submitClaim };
  }

  it("moves the bar and the badge with the local event, before the server answers", () => {
    const { bus, system, render, requestConfirmation } = online();
    system.adoptAuthoritative({ daily: openDaily(), weekly: null });
    render.mockClear();

    bus.post("kSoilPlowedNotification", "Plow");

    expect(system.views()[0].quests[0]).toMatchObject({ count: 4, done: false });
    expect(render).toHaveBeenCalledOnce();
    expect(requestConfirmation).not.toHaveBeenCalled();

    bus.post("kSoilPlowedNotification", "Plow");

    expect(system.views()[0].quests[0]).toMatchObject({ count: 5, done: true, pending: true });
    expect(system.claimable).toBe(1);
    expect(requestConfirmation).toHaveBeenCalledOnce();
  });

  it("never offers the Claim ahead of the server's count", () => {
    const { bus, system, submitClaim } = online();
    system.adoptAuthoritative({ daily: openDaily(), weekly: null });
    bus.post("kSoilPlowedNotification", "Plow");
    bus.post("kSoilPlowedNotification", "Plow");

    system.claim("daily", "daily_plow");

    expect(submitClaim).not.toHaveBeenCalled();
    expect(system.views()[0].quests[0].pending).toBe(true);
  });

  it("is replaced by the projection, whichever way the server counted", () => {
    const { bus, system } = online();
    system.adoptAuthoritative({ daily: openDaily(), weekly: null });
    bus.post("kSoilPlowedNotification", "Plow");
    bus.post("kSoilPlowedNotification", "Plow");

    // Confirmed: the Claim opens and nothing reads as pending any more.
    system.adoptAuthoritative({ daily: completedDaily(), weekly: null });
    expect(system.views()[0].quests[0]).toMatchObject({ count: 5, done: true });
    expect(system.views()[0].quests[0].pending).toBeUndefined();
    expect(system.claimable).toBe(1);

    // Refused (the command was rejected): the preview vanished with it.
    system.adoptAuthoritative({ daily: openDaily(), weekly: null });
    expect(system.views()[0].quests[0]).toMatchObject({ count: 3, done: false });
    expect(system.claimable).toBe(0);
  });

  it("ignores events that arrive before the first projection", () => {
    const { bus, system } = online();
    bus.post("kSoilPlowedNotification", "Plow");
    expect(system.views()).toEqual([]);
  });

  it("never lets the preview touch the adopted state", () => {
    const { bus, system } = online();
    const adopted = openDaily();
    system.adoptAuthoritative({ daily: adopted, weekly: null });
    bus.post("kSoilPlowedNotification", "Plow");
    expect(adopted.counts).toEqual([3]);
  });
});

describe("PeriodicQuestSystem authoritative claims", () => {
  it("keeps a reward claimable when the command cannot be queued", () => {
    const submitClaim = vi.fn(() => false);
    const system = new PeriodicQuestSystem(new GameState(), () => "account", new QuestBus(), {
      authoritative: true,
      submitClaim,
      render: () => {},
    });
    system.adoptAuthoritative({ daily: completedDaily(), weekly: null });

    system.claim("daily", "daily_plow");

    expect(submitClaim).toHaveBeenCalledOnce();
    expect(system.views()[0].quests[0].claimed).toBe(false);
    expect(system.claimable).toBe(1);
  });

  it("latches an accepted claim against double taps until projection", () => {
    const submitClaim = vi.fn(() => true);
    const system = new PeriodicQuestSystem(new GameState(), () => "account", new QuestBus(), {
      authoritative: true,
      submitClaim,
      render: () => {},
    });
    system.adoptAuthoritative({ daily: completedDaily(), weekly: null });

    system.claim("daily", "daily_plow");
    system.claim("daily", "daily_plow");

    expect(submitClaim).toHaveBeenCalledOnce();
    expect(system.views()[0].quests[0].claimed).toBe(true);
  });
});
