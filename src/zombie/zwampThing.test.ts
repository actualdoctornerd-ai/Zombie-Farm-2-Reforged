// Zwamp Thing counts its mutations twice (owner design, docs/ENDLESS_MODE_REWARDS.md), and at
// its maximum is about as strong as a mutated Video Game Zombie.
import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import type { ZombieDef } from "../assets";
import { buildPlayerUnits } from "../raid/CombatEngine";
import { mutationEntries } from "./mutationDisplay";
import { bitOf, mutationBonus } from "./mutations";
import { statBreakdown } from "./statDisplay";
import { makeOwned } from "./types";
import { maskUnion } from "./mutationMask";

const ALL = zombiesJson as ZombieDef[];
const def = (key: string) => ALL.find((z) => z.key === key)!;
const ZWAMP = "ZombieActorZwampThing";
// The strongest legal set on a Regular body: one per slot.
const FULL = ["pumpking", "cauli", "dragon", "heartichoke", "flytrap"].map(bitOf).reduce((m, b) => maskUnion(m, b), 0);

describe("Zwamp Thing", () => {
  it("bakes in its mutations twice, and only its own", () => {
    const once = mutationBonus(FULL);
    const zwamp = makeOwned("z", def(ZWAMP), 0, 0, 0, FULL);
    expect(zwamp.str).toBe(def(ZWAMP).str! + 2 * once.str);
    expect(zwamp.con).toBe(def(ZWAMP).con! + 2 * once.con);
    const regular = makeOwned("r", def("ZombieActorRegularTier1"), 0, 0, 0, FULL);
    expect(regular.str).toBe(def("ZombieActorRegularTier1").str! + once.str);
  });

  it("fields the doubled bonus in battle, peeled and re-added consistently", () => {
    const opts = { abilitySlotUnlocked: () => false };
    const [bare] = buildPlayerUnits([makeOwned("a", def(ZWAMP), 0, 0, 0, 0)], opts);
    const [mutated] = buildPlayerUnits([makeOwned("b", def(ZWAMP), 0, 0, 0, FULL)], opts);
    const once = mutationBonus(FULL);
    expect(mutated.str - bare.str).toBeCloseTo(2 * once.str, 6);
    expect(mutated.con - bare.con).toBeCloseTo(2 * once.con, 6);
  });

  it("reaches a mutated Video Game Zombie's strength when fully mutated", () => {
    const opts = { abilitySlotUnlocked: () => false };
    const [zwamp] = buildPlayerUnits([makeOwned("z", def(ZWAMP), 0, 0, 0, FULL)], opts);
    const [video] = buildPlayerUnits([makeOwned("v", def("ZombieActorRegularVideoGame"), 0, 0, 0, FULL)], opts);
    const dps = (u: typeof zwamp) => u.str / u.attackCooldownMs;
    // Damage per second within 15%, Life within 20%.
    expect(dps(zwamp) / dps(video)).toBeGreaterThan(0.85);
    expect(dps(zwamp) / dps(video)).toBeLessThan(1.15);
    expect(zwamp.maxHp / video.maxHp).toBeGreaterThan(0.8);
  });

  it("shows the doubled numbers on its card", () => {
    const zwamp = makeOwned("z", def(ZWAMP), 0, 0, 0, FULL);
    const regular = makeOwned("r", def("ZombieActorRegularTier1"), 0, 0, 0, FULL);
    const sum = (z: typeof zwamp) => mutationEntries(z).flatMap((e) => e.effects).reduce((t, e) => t + e.delta, 0);
    expect(sum(zwamp)).toBeGreaterThan(sum(regular));
    const breakdown = statBreakdown({ ...zwamp, className: "Special" }, "str", () => false);
    expect(breakdown).toBeTruthy();
  });
});
