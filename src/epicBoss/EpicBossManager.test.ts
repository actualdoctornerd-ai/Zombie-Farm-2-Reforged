import { describe, expect, it } from "vitest";
import { DR_GROUNDHOG, EPIC_BOSSES, epicBossById, epicBossHp, epicBossRetrySkipCost } from "./catalog";
import { EpicBossManager } from "./EpicBossManager";

describe("Dr. Groundhog event", () => {
  it("registers all eight recovered bosses with usable combat presentation", () => {
    expect(EPIC_BOSSES).toHaveLength(8);
    expect(new Set(EPIC_BOSSES.map((boss) => boss.id)).size).toBe(8);
    expect(EPIC_BOSSES.slice(0, 5).every((boss) => Object.keys(boss.animations).length === 6)).toBe(true);
    expect(EPIC_BOSSES.slice(5).every((boss) => boss.reconstructed && boss.bossTexture)).toBe(true);
    for (const boss of EPIC_BOSSES) {
      expect(epicBossById(boss.id)).toBe(boss);
      expect(new EpicBossManager(boss, () => 1_000).activate("run").bossId).toBe(boss.id);
      expect(epicBossHp(boss, boss.maxLevel)).toBeGreaterThan(0);
    }
  });
  it("uses the recovered 20-level HP curve", () => {
    expect(epicBossHp(DR_GROUNDHOG, 1)).toBe(2_000);
    expect(epicBossHp(DR_GROUNDHOG, 2)).toBe(2_800);
    expect(epicBossHp(DR_GROUNDHOG, 20)).toBe(214_000);
  });

  it("retains damage for two hours then resets the current level", () => {
    let now = 1_000;
    const manager = new EpicBossManager(DR_GROUNDHOG, () => now);
    let run = manager.activate("run");
    const gate = manager.start(run, ["z1"]);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    run = manager.finish(gate.run, 600, false).run;
    expect(run.currentHp).toBe(1_400);
    expect(manager.start(run, ["z1"]).ok).toBe(false);
    now += DR_GROUNDHOG.retryMs;
    expect(manager.start(run, ["z1"]).ok).toBe(true);
    now = gate.run.encounterStartedAt + DR_GROUNDHOG.encounterMs;
    expect(manager.normalize(run)?.currentHp).toBe(2_000);
  });

  it("advances immediately through level 20 and completes", () => {
    let now = 1_000;
    const manager = new EpicBossManager(DR_GROUNDHOG, () => now);
    let run = manager.activate("run");
    for (let level = 1; level <= 20; level++) {
      const gate = manager.start(run, ["z1"]);
      expect(gate.ok).toBe(true);
      if (!gate.ok) return;
      const result = manager.finish(gate.run, gate.run.currentHp, true);
      expect(result.defeatedLevel).toBe(level);
      run = result.run;
      now++;
    }
    expect(run.completedAt).toBeGreaterThan(0);
    expect(manager.isActive(run)).toBe(false);
  });

  it("expires after fourteen real-world days", () => {
    let now = 1_000;
    const manager = new EpicBossManager(DR_GROUNDHOG, () => now);
    const run = manager.activate("run");
    now = run.expiresAt;
    expect(manager.start(run, [])).toEqual({ ok: false, error: "expired" });
  });

  it("prices retry skipping at one brain per started two-minute block", () => {
    expect(epicBossRetrySkipCost(0)).toBe(0);
    expect(epicBossRetrySkipCost(1)).toBe(1);
    expect(epicBossRetrySkipCost(8 * 60_000)).toBe(4);
    expect(epicBossRetrySkipCost(8 * 60_000 + 1)).toBe(5);

    let now = 1_000;
    const manager = new EpicBossManager(DR_GROUNDHOG, () => now);
    const active = manager.activate("run");
    const escaped = manager.finish(active, 1, false).run;
    now += 12 * 60_000;
    expect(manager.retrySkipCost(escaped)).toBe(4);
    expect(manager.skipRetry(escaped)?.retryReadyAt).toBe(0);
  });
});
