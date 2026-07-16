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
});
