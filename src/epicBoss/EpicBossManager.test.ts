import { describe, expect, it } from "vitest";
import { DR_GROUNDHOG, epicBossHp } from "./catalog";
import { EpicBossManager } from "./EpicBossManager";

describe("Dr. Groundhog event", () => {
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
});
