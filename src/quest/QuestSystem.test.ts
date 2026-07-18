import { describe, expect, it, vi } from "vitest";
import { GameState } from "../GameState";
import { QuestBus, QuestEvent } from "./events";
import { QuestSystem } from "./QuestSystem";
import { QuestDef, RewardType } from "./types";

const quest = (): QuestDef => ({
  id: "1",
  title: "Fresh Dirt",
  messageComplete: "Done",
  tip: "Plow twice",
  sprite: "quest.png",
  levelRequired: -1,
  prerequisiteQuest: -1,
  requirements: [{
    notificationID: QuestEvent.SoilPlowed,
    notificationObject: "",
    countTotal: 2,
    text: "Plow 2 plots",
    type: 2,
    sprite: "soil.png",
  }],
  rewardType: RewardType.Xp,
  rewardValue: 10,
  rewardItem: "",
  rewardItemKey: "",
  tutorialQuest: false,
  epicEvent: false,
  seasonal: false,
  seasonalDate: "",
  removeQuest: false,
  ignoreCheckQuest: false,
});

describe("QuestSystem client-paced progress", () => {
  it("displays optimistic progress without making it durable", () => {
    const bus = new QuestBus();
    const grantReward = vi.fn();
    const system = new QuestSystem(new Map([["1", quest()]]), new GameState(), bus, {
      authoritative: true,
      grantReward,
      grantItem: vi.fn(), grantZombie: vi.fn(), completed: vi.fn(), render: vi.fn(),
    });
    system.restore();
    bus.post(QuestEvent.SoilPlowed);
    expect(system.views()[0].objectives[0].count).toBe(1);
    expect(system.serialize().active[0].counts[0]).toBe(0);
    expect(grantReward).not.toHaveBeenCalled();
    system.applyAuthoritativeChanges([{ questId: "1", counts: [1], completed: false }]);
    expect(system.views()[0].objectives[0].count).toBe(1);
  });

  it("requests prompt server confirmation when local events predict completion", () => {
    const bus = new QuestBus();
    const requestAuthoritativeCompletionCheck = vi.fn();
    const completed = vi.fn();
    const system = new QuestSystem(new Map([["1", quest()]]), new GameState(), bus, {
      authoritative: true,
      requestAuthoritativeCompletionCheck,
      grantItem: vi.fn(), grantZombie: vi.fn(), completed, render: vi.fn(),
    });
    system.restoreAuthoritative({ completed: [], progress: [{ questId: "1", counts: [0] }] });

    bus.post(QuestEvent.SoilPlowed);
    expect(requestAuthoritativeCompletionCheck).not.toHaveBeenCalled();
    expect(system.views()[0].objectives[0].count).toBe(1);

    bus.post(QuestEvent.SoilPlowed);
    bus.post(QuestEvent.SoilPlowed);
    expect(requestAuthoritativeCompletionCheck).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(system.views()[0].objectives[0].count).toBe(2);
    expect(system.completedCount).toBe(0);

    system.applyAuthoritativeChanges([{ questId: "1", counts: [2], completed: true }]);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(system.completedCount).toBe(1);
  });

  it("rolls optimistic progress back to the authoritative projection", () => {
    const bus = new QuestBus();
    const system = new QuestSystem(new Map([["1", quest()]]), new GameState(), bus, {
      authoritative: true,
      grantItem: vi.fn(), grantZombie: vi.fn(), completed: vi.fn(), render: vi.fn(),
    });
    system.restoreAuthoritative({ completed: [], progress: [{ questId: "1", counts: [0] }] });

    bus.post(QuestEvent.SoilPlowed);
    expect(system.views()[0].objectives[0].count).toBe(1);

    system.restoreAuthoritative({ completed: [], progress: [{ questId: "1", counts: [0] }] });
    expect(system.views()[0].objectives[0].count).toBe(0);
  });

  it("updates immediately and submits completion once", () => {
    const bus = new QuestBus();
    const grantReward = vi.fn(() => true);
    const completed = vi.fn();
    const system = new QuestSystem(new Map([["1", quest()]]), new GameState(), bus, {
      authoritative: false,
      grantReward,
      grantItem: vi.fn(),
      grantZombie: vi.fn(),
      completed,
      render: vi.fn(),
    });
    system.restore();

    bus.post(QuestEvent.SoilPlowed);
    expect(system.views()[0].objectives[0].count).toBe(1);
    bus.post(QuestEvent.SoilPlowed);
    bus.post(QuestEvent.SoilPlowed);

    expect(grantReward).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(system.completedCount).toBe(1);
  });

  it("does not let an older server projection roll local progress backward", () => {
    const bus = new QuestBus();
    const system = new QuestSystem(new Map([["1", quest()]]), new GameState(), bus, {
      authoritative: false,
      grantItem: vi.fn(),
      grantZombie: vi.fn(),
      completed: vi.fn(),
      render: vi.fn(),
    });
    system.restore();
    bus.post(QuestEvent.SoilPlowed);

    system.restoreAuthoritative({ completed: [], progress: [] });

    expect(system.views()[0].objectives[0].count).toBe(1);
  });

  it("hides inactive Epic quests without discarding lifetime progress", () => {
    const bus = new QuestBus();
    const epic = { ...quest(), id: "1000", epicEvent: true, requirements: [{
      ...quest().requirements[0], notificationID: QuestEvent.EpicStageEnemyDefeated,
      notificationObject: "5",
    }] };
    const system = new QuestSystem(new Map([[epic.id, epic]]), new GameState(), bus, {
      grantItem: vi.fn(), grantZombie: vi.fn(), completed: vi.fn(), render: vi.fn(),
    });
    system.setEpicBossActive(true);
    bus.post(QuestEvent.EpicStageEnemyDefeated, "5");
    const save = system.serialize();
    expect(save.active[0].counts[0]).toBe(1);
    system.setEpicBossActive(false);
    expect(system.views()).toEqual([]);

    const restored = new QuestSystem(new Map([[epic.id, epic]]), new GameState(), new QuestBus(), {
      grantItem: vi.fn(), grantZombie: vi.fn(), completed: vi.fn(), render: vi.fn(),
    });
    restored.restore(save);
    expect(restored.views()).toEqual([]);
    restored.setEpicBossActive(true);
    expect(restored.views()[0].objectives[0].count).toBe(1);
  });

  it("only surfaces and advances quests for the selected Epic Boss", () => {
    const bus = new QuestBus();
    const groundhog = { ...quest(), id: "1000", epicEvent: true, requirements: [{
      ...quest().requirements[0], notificationID: QuestEvent.EpicStageEnemyDefeated,
      notificationObject: "5",
    }] };
    const locust = { ...groundhog, id: "2000", title: "Loco Locust" };
    const system = new QuestSystem(new Map([[groundhog.id, groundhog], [locust.id, locust]]), new GameState(), bus, {
      grantItem: vi.fn(), grantZombie: vi.fn(), completed: vi.fn(), render: vi.fn(),
    });
    system.restore({ active: [{ id: "1000", counts: [0] }, { id: "2000", counts: [0] }], completed: [] });
    system.setEpicBossActive(true, ["2000"]);
    expect(system.views().map((view) => view.id)).toEqual(["2000"]);
    bus.post(QuestEvent.EpicStageEnemyDefeated, "5");
    const saved = system.serialize();
    expect(saved.active.find((active) => active.id === "1000")?.counts).toEqual([0]);
  });
});
