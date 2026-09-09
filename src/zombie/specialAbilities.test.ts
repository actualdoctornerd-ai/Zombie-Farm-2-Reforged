// The five special PAIRS the owner reclassed on 2026-09-08 (see SPECIAL_ABILITIES in
// traits.ts). Each pair changed group, and with it the ability ladder the card shows, the
// gate the unlocks run through, and the family rules the sim applies (Mini Buddy, the
// Headless front push, the Garden support station). This pins the catalog row, the
// ladder and the one cross-tier placement — the Doctors' Laser Ver.2 in the tier-3 slot —
// together, so a regenerated zombies.json or an edited matrix cannot split them.
import { describe, expect, it } from "vitest";
import zombieRows from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { activeAbilities } from "./abilities";
import { zombieFarmScale } from "./displayScale";
import {
  ABILITY_POOL, GROUP_ABILITIES, SPECIAL_ABILITIES, abilityTierOf, unitAbilityAt,
} from "./traits";

const defs = zombieRows as ZombieDef[];
const def = (key: string): ZombieDef => {
  const row = defs.find((z) => z.key === key);
  if (!row) throw new Error(`no catalog row for ${key}`);
  return row;
};
const ladder = (key: string) =>
  [1, 2, 3, 4].map((t) => unitAbilityAt(key, def(key).group, t));
/** √(DPS × HP) on the plain catalog row — the Zombie Strength Ladder's yardstick. */
const strength = (z: ZombieDef) => Math.sqrt(z.str * z.dex * 5 * z.con * 100);

const PAIRS: Array<[string, string, string, (string | null)[]]> = [
  ["ZombieActorDrZombie", "ZombieActorOmegaDrZombie", "Garden",
    ["heal", "tankHitPointsBuff", "zomBeam", "healAOE"]],
  ["ZombieActorZombieBot", "ZombieActorOmegaZombieBot", "Headless",
    ["hitPointsBuff", "protect", "laserBeam", "block"]],
  ["ZombieActorMerZombie", "ZombieActorPoseidon", "Large",
    ["powerBuff", "attachMini", "stun", "bashV2"]],
  ["ZombieActorNinjombie", "ZombieActorMasterNinjombie", "Regular",
    ["buffAllStats", "chivalry", "turboSpeed", "doubleStrike"]],
  ["ZombieActorProto", "ZombieActorZombug", "Small",
    [null, null, "ressurect", "bashV2"]],
];

describe("reclassed special pairs (2026-09-08)", () => {
  it("every override names real pool abilities, one per slot", () => {
    for (const [key, row] of Object.entries(SPECIAL_ABILITIES)) {
      expect(row, key).toHaveLength(4);
      for (const ability of row) {
        if (ability !== null) expect(ABILITY_POOL[ability], `${key}: ${ability}`).toBeDefined();
      }
    }
  });

  it.each(PAIRS)("%s / %s fight as %s with their group's ladder, slots swapped",
    (base, elite, group, expected) => {
      for (const key of [base, elite]) {
        expect(def(key).group, key).toBe(group);
        expect(ladder(key), key).toEqual(expected);
        // Every slot the override keeps is the plain group's — it swaps, never reorders.
        GROUP_ABILITIES[group].forEach((a, i) => {
          if (expected[i] === a) return;
          expect(GROUP_ABILITIES[group], `${key} slot ${i + 1}`).not.toContain(expected[i]);
        });
      }
    });

  it("the Doctors' Laser Ver.2 is gated by ITS tier (the Ninjas), not the slot it sits in", () => {
    expect(abilityTierOf("zomBeam")).toBe(4);
    const doctor = def("ZombieActorDrZombie");
    const throughTier = (max: number) =>
      activeAbilities(doctor, (key) => abilityTierOf(key) <= max);
    expect(throughTier(3)).toEqual(["heal", "tankHitPointsBuff"]); // Pirates beaten, no beam yet
    expect(throughTier(4)).toEqual(["heal", "tankHitPointsBuff", "zomBeam", "healAOE"]);
  });

  it("the Doctors are healers held a step over the Cupid Zombie, not tanks", () => {
    const cupid = strength(def("ZombieActorGardenCupid"));
    const dr = strength(def("ZombieActorDrZombie"));
    const omega = strength(def("ZombieActorOmegaDrZombie"));
    expect(dr).toBeGreaterThan(cupid);
    expect(omega).toBeGreaterThan(dr);
    expect(omega / cupid).toBeLessThan(1.35); // "not too much higher than cupid zombies"
    expect(def("ZombieActorDrZombie")).toMatchObject({ str: 14, dex: 2.4, con: 22 });
    expect(def("ZombieActorOmegaDrZombie")).toMatchObject({ str: 15, dex: 2.65, con: 25 });
  });

  it("the Bots wear a Headless stat line — dex 1, tank-line con, their old strength", () => {
    expect(def("ZombieActorZombieBot")).toMatchObject({ str: 19, dex: 1, con: 41 });
    expect(def("ZombieActorOmegaZombieBot")).toMatchObject({ str: 22, dex: 1, con: 46 });
    // Stronger than any Market Headless: the point of the pair is a wall that hits.
    const bombie = def("ZombieActorBombie");
    expect(def("ZombieActorZombieBot").str).toBeGreaterThan(bombie.str);
    expect(def("ZombieActorZombieBot").con).toBeGreaterThan(bombie.con);
  });

  it("the Minis took the Mini rule literally — str and con x0.86, dex kept — and Mini size", () => {
    expect(def("ZombieActorProto")).toMatchObject({ str: 14, dex: 6, con: 10 });
    expect(def("ZombieActorZombug")).toMatchObject({ str: 15, dex: 7, con: 15 });
    for (const key of ["ZombieActorProto", "ZombieActorZombug"]) {
      const z = def(key);
      expect(zombieFarmScale(z.group, z.className, z.key), key).toBe(0.6);
    }
    // Reclassing into a body family never resizes a rig authored at Regular size.
    for (const key of ["ZombieActorMerZombie", "ZombieActorZombieBot", "ZombieActorDrZombie"]) {
      const z = def(key);
      expect(zombieFarmScale(z.group, z.className, z.key), key).toBe(0.9);
    }
  });
});
