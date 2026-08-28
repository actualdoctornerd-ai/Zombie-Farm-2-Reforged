import { describe, expect, it } from "vitest";
import { selectTickPresentation, type RaidStrikePresentation } from "./combatPresentation";

describe("catch-up tick combat presentation", () => {
  it("retains an impact from an earlier catch-up tick when the final tick is empty", () => {
    const history: RaidStrikePresentation[] = [];
    for (const strikes of [
      [{ team: "enemy", attackName: "Claw" }] as RaidStrikePresentation[],
      [],
      [],
    ]) {
      const event = selectTickPresentation(strikes, null);
      if (event) history.push(event);
    }
    expect(history).toEqual([{ team: "enemy", attackName: "Claw" }]);
  });

  it("keeps one cue per tick across a five-tick catch-up frame", () => {
    const history: RaidStrikePresentation[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const event = selectTickPresentation(
        tick === 1 ? [{ team: "player", attackName: "ZombieBite" }] : [],
        tick === 3 ? { team: "enemy", impact: "projectile", sfxFile: "stun.wav" } : null
      );
      if (event) history.push(event);
    }
    expect(history).toEqual([
      { team: "player", attackName: "ZombieBite" },
      { team: "enemy", impact: "projectile", sfxFile: "stun.wav" },
    ]);
  });

  it("preserves the existing per-tick player and projectile priorities", () => {
    const simultaneous: RaidStrikePresentation[] = [
      { team: "enemy", attackName: "Punch" },
      { team: "player", attackName: "ZombieScratch" },
    ];
    expect(selectTickPresentation(simultaneous, null)?.attackName).toBe("ZombieScratch");
    expect(selectTickPresentation(simultaneous, {
      team: "enemy", impact: "projectile",
    })?.impact).toBe("projectile");
  });
});
