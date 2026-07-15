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
});
