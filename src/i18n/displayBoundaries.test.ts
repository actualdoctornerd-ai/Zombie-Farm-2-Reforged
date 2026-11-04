import { afterEach, describe, expect, it } from "vitest";
import { Container, Text } from "pixi.js";
import { JobSystem } from "../JobSystem";
import { buildStatsView } from "../statsView";
import { newFarmStats } from "../stats";
import { obtainHint } from "../zombie/almanac";
import { mutationLabelFor, mutationTipText } from "../zombie/mutationDisplay";
import type { ZombieDef } from "../assets";
import { useMessages } from "./translate";
import original from "./locales/zh-CN.json";
import extra from "./locales/zh-CN-extra.json";

afterEach(() => useMessages("en", {}));
const chinese = () => useMessages("zh-CN", { ...original, ...extra });

describe("localized display paths", () => {
  it("draws localized work bars while keeping queued job kinds canonical", () => {
    for (const language of ["zh-CN", "en"] as const) {
      if (language === "zh-CN") chinese();
      else useMessages("en", {});
      for (const kind of ["till", "plant", "harvest", "harvestTree"] as const) {
        const field = {
          highlightLayer: new Container(), plowHighlightLayer: new Container(), labelLayer: new Container(),
          resolveTill: () => ({ valid: true, oc: 0, or: 0 }),
          plotOriginAt: () => ({ oc: 0, or: 0 }),
          reserveTill: () => {}, unreserveTill: () => {},
          plotCenterOf: () => ({ x: 0, y: 0 }),
          canPlant: () => true, isRipe: () => true, ripeZombieAt: () => false,
          objectHighlightArea: () => null, hasFastWork: () => false, hasPlowFree: () => false,
        };
        const walk = { goToPoint: (_x: number, _y: number, arrive: () => void) => { arrive(); return true; } };
        const jobs = new JobSystem(field as never, { setWorking: () => {} } as never,
          walk as never, { gold: 100 } as never, () => {});
        if (kind === "harvestTree") expect(jobs.enqueueTreeHarvest("tree", 0, 0)).toBe(true);
        else expect(jobs.enqueue(kind, 0, 0)).toBe(true);
        jobs.update(0);
        const bar = field.labelLayer.children[0] as Container;
        const label = bar.children.find(child => child instanceof Text) as Text;
        const labels = language === "zh-CN"
          ? { till: "犁", plant: "种植", harvest: "收获", harvestTree: "收获" }
          : { till: "Plow", plant: "Plant", harvest: "Harvest", harvestTree: "Harvest" };
        expect(label.text).toBe(labels[kind]);
        expect(jobs.serializePending()?.jobs[0].kind).toBe(kind);
        field.labelLayer.destroy({ children: true });
        field.highlightLayer.destroy({ children: true });
        field.plowHighlightLayer.destroy({ children: true });
      }
    }
  });

  it("localizes statistics values without translating a matching player name", () => {
    chinese();
    const now = 1_800_000_000_000;
    const stats = newFarmStats(now);
    stats.harvested.carrot = 3;
    const sections = buildStatsView({ stats, now, name: "Carrots", level: 1, xp: 0, gold: 100,
      brains: 0, zombiesDeployed: 0, zombieMax: 16, zombiesStored: 0,
      speciesDiscovered: 0, speciesTotal: 1, mutationsDiscovered: 0, mutationsTotal: 1,
      cropName: () => "Carrots" });
    const rows = sections.flatMap(section => section.rows);
    expect(rows.find(row => row.label === "Farmer")?.value).toBe("Carrots");
    expect(rows.find(row => row.label === "Favourite crop")?.value).toBe("胡萝卜");
    expect(rows.find(row => row.label === "Keeping count for")?.value).toBe("今天");
    expect(stats.harvested).toEqual({ carrot: 3 });
  });

  it("localizes nested almanac prices and multi-mutation descriptions", () => {
    chinese();
    const hint = obtainHint({ key: "test", level: 3, cost: 20 } as ZombieDef,
      { raidNameById: () => undefined, epicBossNameByQuestId: () => undefined });
    expect(hint).toContain("20金币");
    expect(hint).not.toMatch(/[A-Za-z]/);
    const tip = mutationTipText({ bit: 1, partKey: "test", icon: "", name: "test", slotLabel: "Head",
      effects: [{ stat: "dex", statLabel: "Speed", delta: 23 }] });
    expect(tip).not.toMatch(/Speed|Head|slot/);
    expect(mutationLabelFor("ZombieActorRegularTier1", 3)).not.toMatch(/Onion|Tomato/);
  });
});
