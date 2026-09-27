// The charge observer and the interrupt policy (raid 13).
//
// These pin the thing that was missing rather than the numbers that come out of it: for a
// fight whose whole question is "which slams do you stop", the pilot has to be able to SEE
// a wind-up, and it has to hold its answers back for one. Before `BattleSim.chargeStatus`
// existed it could do neither, and the measured result was 63 slams against 3 broken
// charges — every one of those three an accident of something being off cooldown.
//
// The last test is the one that matters and the one most likely to rot: the interrupt is
// only worth anything when a poise carrier is actually deployed, and the standard lineups
// put Smalls and Larges at the BACK of a queue that releases one body every 3.6 s. So it
// is asserted on a roster that fronts its carriers — which is a statement about the
// policy, not about any lineup a player would field.
import { describe, expect, it } from "vitest";
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildRoster, type Group, type RosterSpec } from "./roster";
import { CHARGE_RAID_ID, POISE_THRESHOLD } from "../dualInvasion";
import { RAID_TICK_MS } from "../replay";

const BASE: Omit<RosterSpec, "pattern"> = {
  size: 16, catalogLevel: 50, playerLevel: 50, invasions: 5,
  mutation: "best", abilityTiers: 4, farmerLifeMult: 1.1,
};

/** Poise carriers first, so Smash is on the field while the captain is winding up. */
const CARRIERS_FIRST: Group[] = [
  ...Array<Group>(8).fill("Small"), "Headless", "Garden", "Garden", "Headless",
  "Garden", "Garden", "Garden", "Garden",
];

function fly(raidId: number, tier: number, interrupts: boolean, pattern = CARRIERS_FIRST) {
  const roster = buildRoster({ ...BASE, pattern });
  const seed = `interrupt:${raidId}:${tier}:${interrupts}`;
  const { spec } = harnessFight({
    raidId, tier: tier || undefined, hazards: true, playerLevel: 47,
    playerUnits: roster.units, waveSeed: seed,
  });
  const sim = buildFight(spec);
  const profile = { ...EXPERT, interrupts, id: interrupts ? "expert" : "expert-noint" };
  const flight = flyFight(sim, makePilot(profile), { seed });
  let slams = 0, breaks = 0;
  for (const u of sim.units) {
    if (!u.chargeCfg) continue;
    slams += u.chargeSlamSeq;
    breaks += u.chargeBreakSeq;
  }
  return { sim, flight, slams, breaks };
}

describe("the charge observer", () => {
  it("reports nothing on a fight without a charging enemy", () => {
    const roster = buildRoster({ ...BASE, pattern: CARRIERS_FIRST });
    const { spec } = harnessFight({
      raidId: 4, hazards: true, playerLevel: 26,
      playerUnits: roster.units, waveSeed: "nocharge",
    });
    const sim = buildFight(spec);
    expect(sim.hasCharge()).toBe(false);
    expect(sim.chargeStatus()).toBeNull();
    for (let i = 0; i < 400; i++) {
      sim.step(RAID_TICK_MS);
      expect(sim.chargeStatus()).toBeNull();
    }
  });

  it("sees the captain wind up, and reports poise against a real threshold", () => {
    const roster = buildRoster({ ...BASE, pattern: CARRIERS_FIRST });
    const { spec } = harnessFight({
      raidId: CHARGE_RAID_ID, tier: 5, hazards: true, playerLevel: 47,
      playerUnits: roster.units, waveSeed: "charge",
    });
    const sim = buildFight(spec);
    let seen = null as ReturnType<typeof sim.chargeStatus>;
    // The captain walks on at the MIDPOINT now, so give the army the whole clock to get him
    // there rather than the opening half-minute.
    for (let i = 0; i < 4_800 && !seen && !sim.finished; i++) {
      sim.step(RAID_TICK_MS);
      seen = sim.chargeStatus();
    }
    expect(seen, "no wind-up at all in raid 13 t5").not.toBeNull();
    expect(sim.hasCharge()).toBe(true);
    expect(seen!.threshold).toBe(POISE_THRESHOLD);
    expect(seen!.poise).toBeGreaterThanOrEqual(0);
    expect(seen!.windupMsLeft).toBeGreaterThan(0);
    // The observer reads state, it does not invent it: what is left can never exceed the
    // rung's own wind-up length.
    expect(seen!.windupMsLeft).toBeLessThanOrEqual(seen!.windupTotalMs);
  });

  it("is a pure read — polling it changes no outcome", () => {
    const quiet = fly(CHARGE_RAID_ID, 5, true);
    const roster = buildRoster({ ...BASE, pattern: CARRIERS_FIRST });
    const { spec } = harnessFight({
      raidId: CHARGE_RAID_ID, tier: 5, hazards: true, playerLevel: 47,
      playerUnits: roster.units, waveSeed: `interrupt:${CHARGE_RAID_ID}:5:true`,
    });
    const sim = buildFight(spec);
    const pilot = makePilot({ ...EXPERT, interrupts: true, id: "expert" });
    // Same flight, but hammering the observer every tick on the way through.
    const noisy = flyFight(sim, {
      id: pilot.id,
      reset: (s) => pilot.reset(s),
      decide: (s, t) => { s.chargeStatus(); s.hasCharge(); s.chargeStatus(); return pilot.decide(s, t); },
    }, { seed: `interrupt:${CHARGE_RAID_ID}:5:true` });
    expect(noisy.win).toBe(quiet.flight.win);
    expect(noisy.losses).toBe(quiet.flight.losses);
    expect(noisy.ticks).toBe(quiet.flight.ticks);
  });
});

describe("the interrupt policy", () => {
  it("breaks charges a pilot without it eats", () => {
    // t3, below the counter: at t5+ a Smash that lands on the grounded ninja is reflected,
    // which is a different question from whether banking beats spending.
    const on = fly(CHARGE_RAID_ID, 3, true);
    const off = fly(CHARGE_RAID_ID, 3, false);
    // Both see the same fight; the one that banks its Smash stops more of it. Asserted as
    // a strict improvement rather than a fixed count, because the count is a balance
    // number and this file is about the mechanism.
    expect(on.breaks).toBeGreaterThan(off.breaks);
    // A maxed roster can now kill a lone captain inside one wind-up, so the slams may both
    // be zero; what must hold is that banking never lets MORE through.
    expect(on.slams).toBeLessThanOrEqual(off.slams);
    // Every broken charge is a slam that did not land, so the two have to move together.
    expect(on.breaks + on.slams).toBeGreaterThan(0);
  });

  it("does not bank moves on a fight with no charge to break", () => {
    // The bank is gated on `hasCharge`, so the other thirty-three fights must be
    // unaffected — a Smash held back forever on the Ninjas is pure loss.
    const on = fly(4, 0, true, ["Headless", "Garden", "Large", "Large"] as Group[]);
    const off = fly(4, 0, false, ["Headless", "Garden", "Large", "Large"] as Group[]);
    expect(on.flight.win).toBe(off.flight.win);
    expect(on.flight.losses).toBe(off.flight.losses);
    expect(on.flight.ticks).toBe(off.flight.ticks);
  });
});
