import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import { advanceRaidSegment, RAID_MAX_INPUTS, replayRaid } from "./replay";
import type { CombatUnit } from "./types";

const RUN_BENCHMARK = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.REPLAY_BENCH === "1";

function unit(id: string, team: "player" | "enemy", n: number): CombatUnit {
  return {
    id, sourceKey: id, team, name: id,
    str: 8 + n, dex: 3 + (n % 5), con: 80, focus: 50,
    hp: 800, maxHp: 800, attackCooldownMs: 700,
    attacks: [{ name: "hit", frequency: 1, mult: 1 }],
    isBoss: team === "enemy" && n === 15,
    alive: true, isGarden: n % 4 === 0, isHeadless: n % 5 === 0, abilities: [],
  };
}

function worstCaseSim(): BattleSim {
  const players = Array.from({ length: 16 }, (_, n) => unit(`p${n}`, "player", n));
  const enemies = Array.from({ length: 16 }, (_, n) => unit(`e${n}`, "enemy", n));
  return new BattleSim(players, enemies, null, false);
}

describe("deterministic raid replay", () => {
  it("rejects reordered, future, illegal, and oversized transcripts", () => {
    expect(replayRaid(worstCaseSim(), 1, [{ seq: 2, tick: 0, type: "retreat" }])).toMatchObject({ error: "bad_sequence" });
    expect(replayRaid(worstCaseSim(), 1, [{ seq: 1, tick: 2, type: "retreat" }])).toMatchObject({ error: "bad_input_tick" });
    expect(replayRaid(worstCaseSim(), 1, [{ seq: 1, tick: 0, type: "ability", abilityKey: "forged" }])).toMatchObject({ error: "illegal_ability" });
    const tooMany = Array.from({ length: RAID_MAX_INPUTS + 1 }, (_, n) => ({ seq: n + 1, tick: 0, type: "retreat" as const }));
    expect(replayRaid(worstCaseSim(), 1, tooMany)).toMatchObject({ error: "too_many_inputs" });
  });

  it("restores a checkpoint to the same outcome as one uninterrupted replay", () => {
    const full = replayRaid(worstCaseSim(), 600, [{ seq: 1, tick: 600, type: "retreat" }]);
    const first = advanceRaidSegment(worstCaseSim(), 0, 300, 0, [], false);
    expect(first.ok).toBe(true);
    const resumed = worstCaseSim();
    if (!first.ok) return;
    resumed.restore(first.snapshot);
    const second = advanceRaidSegment(resumed, 300, 600, first.lastSeq, [{ seq: 1, tick: 600, type: "retreat" }], true);
    expect(second.ok).toBe(true);
    if (full.ok && second.ok) expect(second.outcome).toEqual(full.outcome);
  });

  it.skipIf(!RUN_BENCHMARK)("keeps benchmark-selected 15-second checkpoint segments below the 8 ms p95 target", () => {
    // Measure steady-state verifier cost. Workerd keeps isolates warm between requests;
    // including V8's first compilation passes made this test primarily measure JIT.
    for (let i = 0; i < 4; i++) replayRaid(worstCaseSim(), 15 * 1000 / 50, []);
    const samples: number[] = [];
    for (let i = 0; i < 24; i++) {
      const start = performance.now();
      replayRaid(worstCaseSim(), 15 * 1000 / 50, []);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThan(8);
  });
});
