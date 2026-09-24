// What makes a pilot's number trustworthy.
//
// A simulated player is a model, and a wrong model is a new and more confident way to be
// wrong about difficulty. Two properties keep it honest, and both are tested here:
//
//   1. THE FLIGHT IS REAL. Every transcribed action a pilot takes goes into a
//      `RaidReplayInput[]`, and that transcript, replayed by `replayRaid` against a
//      freshly built sim under the server's own rules, reaches the SAME outcome. A
//      difficulty number can then never describe a fight the live game would refuse —
//      and the same transcript drops into the Raid Lab's playback mode, so the fight can
//      be watched rather than trusted.
//   2. THE PLAYER IS BOUNDED. A pilot cannot out-tap what a client could transmit
//      (`RAID_MAX_INPUTS`, and the live client's 64-input hazard reserve), and it does
//      not act on the same frame it sees.
//
// The ladder's ORDERING is deliberately not asserted here. "Expert beats casual" is a
// claim about a raid's tuning, not about this code, and pinning it in a unit test is how
// a harness turns back into a thing you tune numbers to satisfy. It belongs in the
// difficulty report.
import { describe, expect, it } from "vitest";
import zombiesJson from "../../../public/assets/zombies.json";
import { buildFight } from "../buildFight";
import { buildPlayerUnits } from "../CombatEngine";
import { RAID_MAX_INPUTS } from "../replay";
import { replayRaid } from "../replay";
import { makeOwned } from "../../zombie/types";
import { flyFight } from "./pilot";
import { CASUAL, COMPETENT, EXPERT, IDLE, makePilot, PILOT_LADDER } from "./pilots";
import { harnessFight } from "./raidFight";
import type { CombatUnit } from "../types";

const zombieDefs = zombiesJson as Array<Record<string, unknown>>;

/** A plain mid-power army: the six strongest ordinary species, repeated. Crude on
 *  purpose — this file is testing the PILOT, not the roster layer. */
function army(size = 16): CombatUnit[] {
  const pool = zombieDefs
    .filter((z) => z.category !== "special" && z.className !== "Yellow")
    .sort((a, b) => ((b.str as number) + (b.con as number)) - ((a.str as number) + (a.con as number)))
    .slice(0, 6);
  const party = Array.from({ length: size }, (_, i) =>
    makeOwned(`z${i}`, pool[i % pool.length] as unknown as Parameters<typeof makeOwned>[1], 0, 0, 5, 0));
  return buildPlayerUnits(party, { abilityUnlocked: () => true, playerLevel: 45 });
}

/** Raids with something for each half of the ladder to do: the tutorial, a mid rung, the
 *  wall raid, the converting boss, and one dual invasion off each new mechanic. */
const RAIDS: { id: number; tier?: number; label: string }[] = [
  { id: 1, label: "Old McDonnell's" },
  { id: 4, label: "Ninjas (wall)" },
  { id: 9, label: "Video Games (turn + fire)" },
  { id: 12, tier: 6, label: "Lawyers & Farmers (placard)" },
  { id: 15, tier: 6, label: "Aliens & Robots (saucer bubble)" },
];

describe("a pilot flies a fight the server would accept", () => {
  for (const { id, tier, label } of RAIDS) {
    it(`replays ${label} exactly, from the transcript alone`, () => {
      // Hazards OFF on both sides. The trapeze and the crab are client-only, so a
      // flight that uses them is deliberately NOT reproducible on the server — that
      // asymmetry is tested separately below rather than papered over here.
      const spec = () => harnessFight({
        raidId: id, tier, playerUnits: army(), hazards: false, waveSeed: `parity:${id}`,
      }).spec;

      const flown = flyFight(buildFight(spec()), makePilot(EXPERT), { seed: `parity:${id}` });
      const replayed = replayRaid(buildFight(spec()), flown.ticks, flown.inputs);

      expect(replayed.ok, `replay refused: ${replayed.ok ? "" : replayed.error}`).toBe(true);
      if (!replayed.ok) return;
      expect(replayed.outcome.win).toBe(flown.win);
      expect(replayed.outcome.losses.sort()).toEqual(flown.outcome.losses.sort());
      expect(replayed.outcome.survivors.sort()).toEqual(flown.outcome.survivors.sort());
      // Zero divergence is the strong form: the server neither had to run past the
      // player's clock nor drop a single tap. Anything else means the two simulations
      // saw different fights, which is precisely the bug class this guards.
      expect(replayed.divergence.refusedInputs, "server refused a tap").toBe(0);
      expect(replayed.divergence.inputsAfterFinish, "taps outlived the server's fight").toBe(0);
      expect(replayed.divergence.overrunTicks, "server had to keep fighting").toBe(0);
    });
  }

  it("emits a structurally legal transcript", () => {
    const { spec } = harnessFight({ raidId: 9, playerUnits: army(), hazards: false });
    const flown = flyFight(buildFight(spec), makePilot(COMPETENT), { seed: "legal" });
    expect(flown.inputs.length).toBeGreaterThan(0);
    expect(flown.inputs.length).toBeLessThanOrEqual(RAID_MAX_INPUTS);
    flown.inputs.forEach((input, i) => {
      expect(input.seq, "sequence numbers are 1..n with no gaps").toBe(i + 1);
      expect(Number.isInteger(input.tick)).toBe(true);
      if (i > 0) expect(input.tick).toBeGreaterThanOrEqual(flown.inputs[i - 1].tick);
      expect(input.tick).toBeLessThanOrEqual(flown.ticks);
    });
  });
});

describe("the pilot ladder", () => {
  it("leaves the bottom rung exactly where the old harness left it", () => {
    // `idle` must be bit-identical to `while (!sim.finished) sim.step()`, because every
    // other rung is read against it and because the elite balance numbers on record were
    // all measured that way. If this drifts, the ladder loses its zero.
    const { spec } = harnessFight({ raidId: 5, playerUnits: army(), hazards: false });
    const flown = flyFight(buildFight(spec), makePilot(IDLE), { seed: "floor" });
    expect(flown.inputs).toEqual([]);

    const bare = buildFight(harnessFight({ raidId: 5, playerUnits: army(), hazards: false }).spec);
    let ticks = 0;
    while (!bare.finished && ticks < flown.ticks) { bare.step(50); ticks++; }
    expect(bare.outcome().win).toBe(flown.win);
    expect(bare.outcome().losses.sort()).toEqual(flown.outcome.losses.sort());
  });

  it("is reproducible: the same seed flies the same fight twice", () => {
    // The whole point of a stored difficulty number is comparing it to a later one, so a
    // flight has to be a function of (fight, pilot, seed) and nothing else.
    const fly = () => {
      const { spec } = harnessFight({ raidId: 9, playerUnits: army(), hazards: false });
      return flyFight(buildFight(spec), makePilot(CASUAL), { seed: "same" });
    };
    const a = fly();
    const b = fly();
    expect(b.inputs).toEqual(a.inputs);
    expect(b.ticks).toBe(a.ticks);
    expect(b.outcome.losses).toEqual(a.outcome.losses);
  });

  it("gives a different fight on a different seed, but only where the pilot is fallible", () => {
    // `casual` misses a third of what it sees, so its seed matters. `expert` misses
    // nothing, so its flight must NOT move with the seed — a pilot whose "perfect" play
    // wanders is carrying randomness it should not have.
    const fly = (profile: typeof CASUAL, seed: string) => {
      const { spec } = harnessFight({ raidId: 9, playerUnits: army(), hazards: false });
      return flyFight(buildFight(spec), makePilot(profile), { seed });
    };
    expect(fly(EXPERT, "a").inputs).toEqual(fly(EXPERT, "b").inputs);
    expect(fly(CASUAL, "a").inputs).not.toEqual(fly(CASUAL, "b").inputs);
  });

  it("engages more of the fight the further up the ladder it goes", () => {
    // Not "wins harder" — that is a claim about tuning. Just that each rung reaches for
    // more of what the fight offers, which is what the profiles say and what makes the
    // idle→expert spread mean anything at all.
    const counts = PILOT_LADDER.map((profile) =>
      flyFight(buildFight(harnessFight({ raidId: 9, playerUnits: army(), hazards: false }).spec),
        makePilot(profile), { seed: "reach" }).inputs.length);
    expect(counts[0], "idle taps nothing").toBe(0);
    expect(counts[1], "casual taps something").toBeGreaterThan(0);
    expect(counts[2], "competent taps more than casual").toBeGreaterThan(counts[1]);
    // Expert against competent is NOT monotone and should never have been asserted as if
    // it were. Expert deliberately does less of some things: it holds Explode until three
    // enemies are on the field where competent spends it at two, and it spends the saucer's
    // cancels on `aoe`/`portal` only where competent burns them on whatever is charging.
    // Reaching for MORE of the fight and reaching for BETTER parts of it are different
    // claims, and this test is about the first — so the rung that matters is expert against
    // CASUAL, which is monotone by construction.
    expect(counts[3], "expert taps far more than casual").toBeGreaterThan(counts[1]);
  });

  it("never asks for more input than a client could transmit", () => {
    // The wall raid at a high rung is the tap-hungriest fight in the game: a blocker
    // every few seconds, each one twenty taps deep. This is where a pilot would run away
    // with the transcript if it were allowed to.
    const { spec } = harnessFight({ raidId: 13, tier: 10, playerUnits: army(20), hazards: true });
    const flown = flyFight(buildFight(spec), makePilot(EXPERT), { seed: "budget" });
    expect(flown.inputs.length).toBeLessThanOrEqual(RAID_MAX_INPUTS);
    // Whatever the pilot wanted beyond the budget was DROPPED, not smuggled into the
    // sim — the live client stops taking hazard taps rather than taking them silently,
    // and a harness that did otherwise would measure a fight the server never sees.
    expect(flown.inputs.filter((i) => i.type === "wallTap").length)
      .toBeLessThanOrEqual(RAID_MAX_INPUTS - 64);
  });

  it("keeps client-only rescues out of the transcript", () => {
    // The Circus trapeze. A pilot that grabs it changes ITS fight and tells the server
    // nothing, because the verifier has no trapeze to tell. The count is reported
    // separately precisely so a flight can say "this one will not reproduce".
    const { spec } = harnessFight({ raidId: 8, playerUnits: army(), hazards: true });
    const flown = flyFight(buildFight(spec), makePilot(EXPERT), { seed: "trapeze" });
    expect(flown.untranscribed, "the trapeze was never grabbed").toBeGreaterThan(0);
    expect(flown.inputs.some((i) => i.type.includes("rab"))).toBe(false);
  });
});
