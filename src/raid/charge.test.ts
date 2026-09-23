// The pirate captain's charge, its poise bar, and the ninja's dex tax (raid 13).
// See docs/POST_45_PROGRESSION.md and dualInvasion.ts.
//
// The numbers here are placeholders and will move. What these pin is the SHAPE the design
// argues for: that a girl proc is a contribution and not an answer, that a one-use move is
// always sufficient on its own, that a broken charge costs the captain his wind-up, and
// that the sky tightens with the army's attack speed rather than with the clock.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  CHARGE_MS_AT_MAX_TIER, CHARGE_MS_AT_MIN_TIER, CHARGE_RAID_ID, chargeFor,
  DEX_TAX_HALF_AT, DEX_TAX_MIN_FRACTION, dexTaxedInterval, MAX_TIER, poiseFor,
  POISE_THRESHOLD,
} from "./dualInvasion";
import type { CombatUnit } from "./types";

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 10, dex: 2, con: 10, focus: 100, hp: 1000, maxHp: 1000,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;

/** A fight against the captain alone, charging. The zombie is a punchbag with enough HP to
 *  survive several slams, so a test can watch more than one. */
function chargeFight(tier = 1, playerOver: Partial<CombatUnit> = {}) {
  const charge = chargeFor(CHARGE_RAID_ID, tier)!;
  const players = [unit({ id: "z0", group: "Regular", hp: 1e6, maxHp: 1e6, ...playerOver })];
  const enemies = [
    unit({
      id: "captain", sourceKey: "PirateStageActorBoss", team: "enemy",
      str: 0, hp: 1e6, maxHp: 1e6, charge,
    }),
    unit({
      id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true,
      str: 0, hp: 1e6, maxHp: 1e6,
    }),
  ];
  const sim = new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, undefined, null, null, true
  );
  return { sim, charge };
}

const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };
const captainOf = (sim: BattleSim) => sim.units.find((u) => u.id === "captain")!;

/** Step until the captain is mid-wind-up. Waiting for the STATE rather than for a fixed
 *  span, because the wind-up shortens up the ladder: a warm-up long enough to engage at
 *  tier 1 is long enough for the whole charge to have come and gone at tier 10. */
function runUntilCharging(sim: BattleSim): void {
  for (let i = 0; i < 2_000 && captainOf(sim).chargeMs <= 0; i++) sim.step(50);
}

describe("the charge", () => {
  it("only exists on the invasion that has one, and shortens up the ladder", () => {
    for (const other of [1, 6, 9, 12, 14, 15]) expect(chargeFor(other, 1)).toBeNull();
    expect(chargeFor(CHARGE_RAID_ID, 1)!.windupMs).toBe(CHARGE_MS_AT_MIN_TIER);
    expect(chargeFor(CHARGE_RAID_ID, MAX_TIER)!.windupMs).toBe(CHARGE_MS_AT_MAX_TIER);
    // The rung dials the TIME, never the bar: one banked answer is always enough for one
    // slam, at every rung. That is the promise the design makes.
    expect(chargeFor(CHARGE_RAID_ID, 1)!.windupMs)
      .toBeGreaterThan(chargeFor(CHARGE_RAID_ID, MAX_TIER)!.windupMs);
  });

  it("winds up once engaged and lands on the whole deployed line", () => {
    const { sim, charge } = chargeFight();
    run(sim, 6_000); // walk in and engage
    const zombie = sim.units.find((u) => u.id === "z0")!;
    expect(captainOf(sim).chargeMs, "winding up").toBeGreaterThan(0);

    const before = zombie.hp;
    run(sim, charge.windupMs + 500);
    expect(zombie.hp, "the slam lands").toBeLessThan(before);
    expect(captainOf(sim).chargeSlamSeq).toBeGreaterThan(0);
  });

  it("is a bar, not an off switch: one girl proc does not stop it", () => {
    const { sim, charge } = chargeFight();
    run(sim, 6_000);
    const captain = captainOf(sim);
    const slamsBefore = captain.chargeSlamSeq;

    // One proc's worth of poise, by hand — the roll itself is tested by the army below.
    (sim as unknown as { stunEnemy: (u: unknown, ms: number, src: string) => void })
      .stunEnemy(captain, 1000, "stun");
    expect(captain.poise).toBeCloseTo(poiseFor("stun"), 5);
    expect(captain.poise, "nowhere near the bar").toBeLessThan(POISE_THRESHOLD);
    expect(captain.stunMs, "and it did not stun him either — it went into the bar").toBe(0);

    run(sim, charge.windupMs + 500);
    expect(captain.chargeSlamSeq, "so the slam still lands").toBeGreaterThan(slamsBefore);
  });

  it("breaks on a single one-use move, at any rung", () => {
    for (const tier of [1, MAX_TIER]) {
      const { sim } = chargeFight(tier);
      runUntilCharging(sim);
      const captain = captainOf(sim);
      const windup = captain.chargeMs;
      expect(windup).toBeGreaterThan(0);

      (sim as unknown as { stunEnemy: (u: unknown, ms: number, src: string) => void })
        .stunEnemy(captain, 3000, "explode");

      expect(captain.chargeMs, `tier ${tier}: the wind-up is gone`).toBe(0);
      expect(captain.poise, "and the bar is emptied with it").toBe(0);
      expect(captain.chargeBreakSeq).toBe(1);
      expect(captain.chargeRestMs, "he has to rest before starting again").toBeGreaterThan(0);
    }
  });

  it("takes two Smashes, and remembers the first", () => {
    const { sim } = chargeFight();
    run(sim, 6_000);
    const captain = captainOf(sim);
    const stun = (src: string) =>
      (sim as unknown as { stunEnemy: (u: unknown, ms: number, src: string) => void })
        .stunEnemy(captain, 1000, src);

    stun("bashV2");
    expect(captain.poise).toBeCloseTo(0.5, 5);
    expect(captain.chargeMs, "half a bar is not a break").toBeGreaterThan(0);
    stun("bashV2");
    expect(captain.chargeMs, "the second one lands it").toBe(0);
    expect(captain.chargeBreakSeq).toBe(1);
  });

  it("does not let a broken charge be re-broken for free", () => {
    const { sim } = chargeFight();
    run(sim, 6_000);
    const captain = captainOf(sim);
    (sim as unknown as { stunEnemy: (u: unknown, ms: number, src: string) => void })
      .stunEnemy(captain, 3000, "explode");
    const rest = captain.chargeRestMs;

    // Mid-rest he is not winding up, so there is nothing to interrupt and no poise to bank
    // against the NEXT wind-up either.
    run(sim, Math.floor(rest / 2));
    expect(captain.chargeMs).toBe(0);
    expect(captain.poise).toBe(0);

    run(sim, rest);
    expect(captain.chargeMs, "and then he starts again").toBeGreaterThan(0);
  });
});

describe("the dex tax", () => {
  it("leaves the authored interval alone with nobody on the field", () => {
    expect(dexTaxedInterval(4_000, 0)).toBe(4_000);
  });

  it("halves the interval at the reference load, and keeps tightening", () => {
    expect(dexTaxedInterval(4_000, DEX_TAX_HALF_AT)).toBe(2_000);
    expect(dexTaxedInterval(4_000, DEX_TAX_HALF_AT * 3))
      .toBeLessThan(dexTaxedInterval(4_000, DEX_TAX_HALF_AT));
  });

  it("floors, so a maxed dex army cannot drive it to nothing", () => {
    expect(dexTaxedInterval(4_000, 100_000)).toBe(4_000 * DEX_TAX_MIN_FRACTION);
  });

  it("charges a fast army more than a slow one, for the same bodies", () => {
    // Same count, same everything but the cadence: the slow line pays less sky.
    const quick = chargeFight(1, { attackCooldownMs: 250 }).sim;   // dex 8, a Vagabond
    const slow = chargeFight(1, { attackCooldownMs: 1_540 }).sim;  // dex 1.3, a brute
    run(quick, 6_000);
    run(slow, 6_000);
    const dexOf = (sim: BattleSim) =>
      (sim as unknown as { deployedDex: () => number }).deployedDex();
    expect(dexOf(quick)).toBeGreaterThan(dexOf(slow));
    expect(dexTaxedInterval(4_000, dexOf(quick)))
      .toBeLessThan(dexTaxedInterval(4_000, dexOf(slow)));
  });
});
