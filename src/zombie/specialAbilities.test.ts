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

  it("the Doctors are healers around the Cupid Zombie after the 2026-10-01 nerf, not tanks", () => {
    const cupid = strength(def("ZombieActorGardenCupid"));
    const dr = strength(def("ZombieActorDrZombie"));
    const omega = strength(def("ZombieActorOmegaDrZombie"));
    expect(dr).toBeLessThan(cupid); // x0.8 str/con: owner found them a bit strong
    expect(omega).toBeGreaterThan(dr);
    expect(omega / cupid).toBeLessThan(1.1);
    expect(def("ZombieActorDrZombie")).toMatchObject({ str: 11, dex: 2.0, con: 18 });
    expect(def("ZombieActorOmegaDrZombie")).toMatchObject({ str: 12, dex: 2.2, con: 20 });
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

// The 2026-09-24 reshuffle (docs/ABILITY_IDEAS.md). Fifteen prize zombies were group
// Regular and so ran the IDENTICAL stock ladder; these seven keys each take one scarce
// ability onto a body that cannot normally hold it.
const RESHUFFLE: Array<[string, (string | null)[]]> = [
  ["ZombieActorCaptain", ["grace", "chivalry", "tankHitPointsBuff", "protect"]],
  ["ZombieActorAdmiral", ["grace", "chivalry", "tankHitPointsBuff", "protect"]],
  ["ZombieActorOldMcZombie", ["buffAllStats", "chivalry", "tankHitPointsBuff", "healAOE"]],
  ["ZombieActorForest", ["heal", "grace", "stun", "doubleStrike"]],
  ["ZombieActorBrockColey", ["buffAllStats", "chivalry", "tankHitPointsBuff", "bash"]],
  ["ZombieActorZastronaut", ["buffAllStats", "chivalry", "turboSpeed", "zomBeam"]],
  ["ZombieActorZosmonaut", ["buffAllStats", "chivalry", "turboSpeed", "zomBeam"]],
];

describe("reshuffled specials (2026-09-24)", () => {
  it.each(RESHUFFLE)("%s carries its agreed ladder", (key, expected) => {
    expect(ladder(key), key).toEqual(expected);
  });

  // THE INVARIANT THAT MAKES CROSS-TIER PLACEMENT SAFE. A slot does not set the unlock —
  // `abilityUnlocked` keys off the ability's OWN tier — so an override can park a tier-2
  // ability in the tier-3 slot. That is fine as long as the four unlock bosses never run
  // BACKWARDS down the card, which would show a player a later slot unlocking before an
  // earlier one. Checked over the whole table, not just the new rows.
  it("no override's unlock bosses run backwards down its four slots", () => {
    for (const [key, row] of Object.entries(SPECIAL_ABILITIES)) {
      const tiers = row.map((ability) => (ability ? abilityTierOf(ability) : 0));
      const present = tiers.filter((t) => t > 0);
      expect([...present].sort((a, b) => a - b), `${key}: ${row.join("/")}`).toEqual(present);
    }
  });

  it("the Admiral is a support body: four stacking auras and no attack ability", () => {
    const auras = ["grace", "chivalry", "tankHitPointsBuff", "protect"];
    // All four are tier 2, so they unlock TOGETHER at the Lawyers rather than laddering.
    for (const aura of auras) expect(abilityTierOf(aura), aura).toBe(2);
    const admiral = def("ZombieActorAdmiral");
    expect(activeAbilities(admiral, (key) => abilityTierOf(key) <= 1)).toEqual([]);
    expect(activeAbilities(admiral, (key) => abilityTierOf(key) <= 2)).toEqual(auras);
  });

  it("Old McZombie and Brock Coley trade BOTH lasers away, and keep their stat lines", () => {
    for (const key of ["ZombieActorOldMcZombie", "ZombieActorBrockColey"]) {
      expect(ladder(key), key).not.toContain("laserBeam");
      expect(ladder(key), key).not.toContain("zomBeam");
    }
    // The ability swap IS the change — an earlier draft retuned Old McZombie's str/dex and
    // was dropped, so a stat edit here means someone re-opened a closed decision.
    expect(def("ZombieActorOldMcZombie")).toMatchObject({ str: 8, dex: 3.67, con: 12 });
    expect(def("ZombieActorBrockColey")).toMatchObject({ str: 46, dex: 3, con: 8 });
  });

  it("Fortitude reaches Old McZombie EARLIER than the laser it replaced — no dead window", () => {
    // Stock, its first tier-3 slot ability (laserBeam) waits for the Pirates; Fortitude is
    // tier 2, so the support arrives at the Lawyers and the damage loss never leads it.
    expect(abilityTierOf("laserBeam")).toBe(3);
    expect(abilityTierOf("tankHitPointsBuff")).toBe(2);
  });

  it("Resurrect stays rationed — only the Garden group and the two Minis carry it", () => {
    const holders = Object.entries(SPECIAL_ABILITIES)
      .filter(([, row]) => row.includes("ressurect"))
      .map(([key]) => key);
    expect(holders.sort()).toEqual(["ZombieActorProto", "ZombieActorZombug"]);
    expect(GROUP_ABILITIES.Garden).toContain("ressurect");
  });
});
