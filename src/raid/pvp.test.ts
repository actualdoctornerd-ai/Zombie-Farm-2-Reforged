// Friend invasions (PvP) — shared-rule tests.
//
// The pinned config is server-built and client-adopted, so what needs locking here is
// the SHARED maths both read: the defense conversion (a defender zombie must be exactly
// as strong on the enemy side as on its own), the difficulty score and its reward
// tiers, and the property the whole design leans on — that a defense-vs-attack fight
// runs deterministically through the REAL BattleSim to a conclusion inside the replay
// cap, with no sim changes and no ruleset bump.
import { describe, expect, it } from "vitest";
import zombiesJson from "../../public/assets/zombies.json";
import boostsJson from "../../public/assets/boosts.json";
import { BattleSim } from "./BattleSim";
import { buildPlayerUnits } from "./CombatEngine";
import { makeOwned } from "../zombie/types";
import { RAID_MAX_TICKS, RAID_TICK_MS, replayRaid } from "./replay";
import {
  PVP_ARMY_SIZE,
  PVP_DEFENSE_CAP,
  PVP_TIER_REWARDS,
  PVP_WAVE_CADENCE,
  DEF_LINE_X,
  DEF_SUPPORT_X,
  DEF_TANK_X,
  PVP_DEFENSE_DRIP_MS,
  PVP_DEFENSE_PASSIVE_ABILITIES,
  PVP_PERCH_X,
  PVP_PERCH_Y,
  PVP_THROW_INTERVAL_MS,
  PVP_ZOMBIE_SPRITE_PREFIX,
  pvpBossThrow,
  armyScore,
  buildPvpRaidDef,
  enemyCopies,
  formationDefenseUnits,
  groupTierPoints,
  orderedDefenseUnits,
  pvpRewardsForTier,
  pvpTierForPoints,
  selectFormationDefense,
  defenseSeatForGroup,
  PVP_DEFENSE_SEATS,
  PVP_ROLE_BY_GROUP,
  toDefenseUnits,
  unitScore,
  unitTierPoints,
} from "./pvp";
import { bitOf } from "../zombie/mutations";
import type { CombatUnit } from "./types";

const zombieDefs = zombiesJson as Array<Record<string, unknown>>;
const boostDefs = boostsJson as Array<{ key: string }>;

/** A synthetic army off the catalog, every stat × `power` (see the balance test's
 *  measuring stick — same idea, both sides built through the real buildPlayerUnits). */
function army(size: number, power: number, idPrefix = "z"): CombatUnit[] {
  const pool = zombieDefs
    .filter((z) => z.category !== "special")
    .sort((a, b) => ((b.str as number) + (b.con as number)) - ((a.str as number) + (a.con as number)))
    .slice(0, 6)
    .map((z) => ({ ...z, str: (z.str as number) * power, con: (z.con as number) * power }));
  const party = Array.from({ length: size }, (_, i) =>
    makeOwned(`${idPrefix}${i}`, pool[i % pool.length] as Parameters<typeof makeOwned>[1], 0, 0, 3, 0)
  );
  return buildPlayerUnits(party, { concentration: true, abilityUnlocked: () => true, playerLevel: 30 });
}

describe("toDefenseUnits", () => {
  it("flips team, strips abilities/auras, and keeps combat stats identical", () => {
    const built = army(6, 1);
    const defense = toDefenseUnits(built);
    expect(defense).toHaveLength(6);
    for (const unit of defense) {
      expect(unit.team).toBe("enemy");
      expect(unit.abilities).toEqual([]);
      expect(unit.teamAuraStats).toBeUndefined();
      // The same zombie, by key, fights with the same numbers on either side — in
      // particular the ATTACK CLOCK stays player-side (2 s/dex), not enemy (1 s/dex).
      const source = built.find((candidate) => candidate.sourceKey === unit.sourceKey)!;
      expect(unit.attackCooldownMs).toBe(source.attackCooldownMs);
      expect(unit.maxHp).toBe(source.maxHp);
      expect(unit.str).toBe(source.str);
    }
  });

  it("caps at the strongest PVP_DEFENSE_CAP, ordered weakest-first", () => {
    const big = army(24, 1);
    // Make one unit clearly the strongest and one clearly the weakest.
    big[0].str *= 50;
    big[0].con *= 50;
    big[0].maxHp *= 50;
    const defense = toDefenseUnits(big);
    expect(defense).toHaveLength(PVP_DEFENSE_CAP);
    const scores = defense.map(unitScore);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    // The boosted unit survives the cut and emerges LAST (strongest at the back).
    expect(defense[defense.length - 1].sourceKey).toBe(big[0].sourceKey);
    // Ids are re-minted so nothing downstream mistakes them for roster ids.
    expect(defense.map((u) => u.id)).toEqual(defense.map((_, i) => `d${i}`));
  });

  it("is deterministic", () => {
    const built = army(12, 2);
    expect(toDefenseUnits(built)).toEqual(toDefenseUnits(built));
  });
});

describe("orderedDefenseUnits (authored defenses)", () => {
  it("keeps the authored order as the emergence order, with the same per-unit flip", () => {
    const built = army(6, 1);
    const defense = orderedDefenseUnits(built);
    expect(defense).toHaveLength(6);
    // Authored slot 1 emerges first — no strongest ranking, no weakest-first reverse.
    expect(defense.map((u) => u.sourceKey)).toEqual(built.map((u) => u.sourceKey));
    expect(defense.map((u) => u.id)).toEqual(defense.map((_, i) => `d${i}`));
    for (let i = 0; i < defense.length; i++) {
      expect(defense[i].team).toBe("enemy");
      expect(defense[i].abilities).toEqual([]);
      expect(defense[i].teamAuraStats).toBeUndefined();
      expect(defense[i].attackCooldownMs).toBe(built[i].attackCooldownMs);
      expect(defense[i].maxHp).toBe(built[i].maxHp);
      expect(defense[i].str).toBe(built[i].str);
    }
  });

  it("caps at PVP_DEFENSE_CAP without re-ranking", () => {
    const built = army(20, 1);
    const defense = orderedDefenseUnits(built);
    expect(defense).toHaveLength(PVP_DEFENSE_CAP);
    expect(defense.map((u) => u.sourceKey))
      .toEqual(built.slice(0, PVP_DEFENSE_CAP).map((u) => u.sourceKey));
  });
});

describe("difficulty score and reward tiers", () => {
  it("scores a stronger army strictly higher", () => {
    expect(armyScore(army(8, 3))).toBeGreaterThan(armyScore(army(8, 1)));
    expect(armyScore(army(16, 1))).toBeGreaterThan(armyScore(army(8, 1)));
  });

  it("maps points to monotonically non-decreasing tiers 1..5", () => {
    let last = 0;
    for (const points of [0, 20_000, 100_000, 400_000, 1_000_000, 5_000_000]) {
      const tier = pvpTierForPoints(points);
      expect(tier).toBeGreaterThanOrEqual(1);
      expect(tier).toBeLessThanOrEqual(5);
      expect(tier).toBeGreaterThanOrEqual(last);
      last = tier;
    }
    expect(pvpTierForPoints(0)).toBe(1);
    expect(pvpTierForPoints(Number.MAX_SAFE_INTEGER)).toBe(5);
  });

  it("rewards exist for every tier, use only real boost keys, and only tier 5 pays a Brain Ticket", () => {
    const keys = new Set(boostDefs.map((b) => b.key));
    expect(PVP_TIER_REWARDS).toHaveLength(5);
    PVP_TIER_REWARDS.forEach((rewards, index) => {
      expect(rewards.length).toBeGreaterThan(0);
      for (const reward of rewards) {
        expect(keys.has(reward.key), `tier ${index + 1}: ${reward.key}`).toBe(true);
        expect(reward.qty).toBeGreaterThan(0);
      }
      const hasTicket = rewards.some((reward) => reward.key === "brain_ticket");
      expect(hasTicket).toBe(index === 4);
    });
    // Out-of-range tiers clamp instead of throwing.
    expect(pvpRewardsForTier(0)).toEqual(pvpRewardsForTier(1));
    expect(pvpRewardsForTier(99)).toEqual(pvpRewardsForTier(5));
  });
});

describe("group tiers read the ACTUAL fight stats — owner's calibration rules", () => {
  const defOf = (key: string) =>
    zombieDefs.find((z) => z.key === key) as unknown as Parameters<typeof makeOwned>[1];
  // The strongest legal 5-slot mutation set: Pumpking (head, wearable by anyone via
  // Pot inheritance), Eyebiscus (hair/eye), Dragon-arm, Heartichoke (body), Flytrap
  // (neck). Distinct bits, so plain addition composes the mask without bitwise ops.
  const MAX_MUTATIONS = ["pumpking", "eyebiscus", "dragon", "heartichoke", "flytrap"]
    .reduce((mask, key) => mask + bitOf(key), 0);
  const buildGroup = (keys: string[], level: number, mask = 0) =>
    buildPlayerUnits(
      keys.map((k, i) => makeOwned(`u${i}`, defOf(k), 0, 0, 0, mask)),
      { concentration: true, abilityUnlocked: () => true, playerLevel: level }
    );
  const tierOf = (units: CombatUnit[], base = PVP_DEFENSE_CAP) =>
    pvpTierForPoints(groupTierPoints(units, base));
  const greens = (n: number, level: number, mask = 0) =>
    buildGroup(Array.from({ length: n }, () => "ZombieActorRegularTier1"), level, mask);
  const EPIC_SHELF = ["ZombieActorVagabond", "ZombieActorScrooge", "ZombieActorOmegaZombieBot",
    "ZombieActorMadame", "ZombieActorBandido", "ZombieActorAdmiral"];

  it("a lawn of plain greens is tier 1 at ANY level — the ramp bands species, not accounts", () => {
    expect(tierOf(greens(6, 7))).toBe(1);
    expect(tierOf(greens(6, 30))).toBe(1);
    expect(tierOf(greens(10, 45))).toBe(1);
  });

  it("more zombies raise the score a bit (√count) — but count never buys weaklings a tier", () => {
    const six = groupTierPoints(greens(6, 45), PVP_DEFENSE_CAP);
    const ten = groupTierPoints(greens(10, 45), PVP_DEFENSE_CAP);
    expect(ten).toBeGreaterThan(six);
    expect(pvpTierForPoints(ten)).toBe(1);
  });

  it("greens NEVER reach tier 3 — even the theoretical max mutation set stops at 2", () => {
    const maxed = greens(6, 30, MAX_MUTATIONS);
    expect(tierOf(maxed)).toBe(2); // mutations count: out of tier 1...
    expect(tierOf(maxed)).toBeLessThan(3); // ...but the ceiling is HARD
  });

  it("one powerful zombie out-scores a weakling crowd, yet a lone zombie is no tier-5 GROUP", () => {
    const lone = buildGroup(["ZombieActorVagabond"], 45);
    expect(groupTierPoints(lone, PVP_DEFENSE_CAP))
      .toBeGreaterThan(groupTierPoints(greens(10, 45), PVP_DEFENSE_CAP));
    const loneTier = tierOf(lone);
    expect(loneTier).toBeGreaterThanOrEqual(3); // a monster alone still reads strong
    expect(loneTier).toBeLessThan(5); // but five stars take a full shelf
  });

  it("the top epic shelf is tier 5 with ZERO mutations (epics can't carry any)", () => {
    const shelf = buildGroup(EPIC_SHELF, 45);
    for (const epic of shelf) expect(epic.mutation ?? 0).toBe(0);
    expect(tierOf(shelf)).toBe(5);
  });

  it("a five-star defense can afford its healers — support slots don't cost the tier", () => {
    // Healers score almost nothing on hp×dps but make the fight harder; the tier-5
    // threshold is deliberately low enough that a top shelf fielding TWO of them
    // stays five stars (owner's calibration, 2026-08-24).
    const withHealers = buildGroup(
      [...EPIC_SHELF.slice(0, 4), "ZombieActorGardenTier5", "ZombieActorGardenTier4"], 45);
    expect(tierOf(withHealers)).toBe(5);
  });

  it("Protect counts as staying power: damage reduction raises a unit's points", () => {
    const [unit] = buildGroup(["ZombieActorRegularTier4"], 30);
    const shielded = { ...unit, damageReduction: 0.5 };
    expect(unitTierPoints(shielded)).toBeCloseTo(unitTierPoints(unit) * 2, 5);
  });
});

describe("a Garden zombie only stations when it can actually support (ruleset v40a)", () => {
  // Found by the first friend-invasion playtest: an attacker's Flower Zombie with no
  // healing ability unlocked stood at the rear station doing nothing, soft-locking the
  // fight into the four-minute cap when it was the last survivor. `isGarden` is the
  // SUPPORT flag now, not the body type.
  it("keeps isGarden only for units carrying a healing-type ability", () => {
    const def = zombieDefs.find((z) => z.group === "Garden")!;
    const party = [makeOwned("g", def as unknown as Parameters<typeof makeOwned>[1], 0, 0, 0, 0)];
    const locked = buildPlayerUnits(party, { abilityUnlocked: () => false });
    const unlocked = buildPlayerUnits(party, { abilityUnlocked: () => true });
    expect(locked[0].isGarden).toBe(false); // no heal yet — it fights in the line
    expect(unlocked[0].isGarden).toBe(true); // a real healer keeps the station
    expect(locked[0].group).toBe("Garden"); // the body type itself is untouched
  });
});

describe("formation defense mode", () => {
  const defOf = (key: string) =>
    zombieDefs.find((z) => z.key === key) as unknown as Parameters<typeof makeOwned>[1];
  const ONE_PER_CLASS = [
    "ZombieActorHeadlessTier3", "ZombieActorGardenTier3", "ZombieActorLargeTier3",
    "ZombieActorSmallTier3", "ZombieActorRegularTier3", "ZombieActorGirlTier3",
  ];
  const build = (keys: string[], prefix: string, unlocked = true) => buildPlayerUnits(
    keys.map((k, i) => makeOwned(`${prefix}${i}`, defOf(k), 0, 0, 0, 0)),
    { concentration: true, abilityUnlocked: () => unlocked, playerLevel: 30 }
  );
  const formation = (unlocked = true) =>
    formationDefenseUnits(selectFormationDefense(build(ONE_PER_CLASS, "d", unlocked)));

  it("has one post per class, so all PVP_DEFENSE_CAP of them can be filled", () => {
    // The bug this pins: Regular and Girl share the "line" JOB, so anything enforcing
    // "one each" by ROLE merged them into a single post and left the sixth slot
    // permanently unfillable — a full defense read 5/6. The posts are what the picker
    // and the auto snapshot both count, and there are exactly PVP_DEFENSE_CAP of them.
    const seats = Object.keys(PVP_ROLE_BY_GROUP).map((group) => defenseSeatForGroup(group));
    expect(new Set(seats).size).toBe(PVP_DEFENSE_CAP);
    expect(new Set(seats)).toEqual(new Set(PVP_DEFENSE_SEATS));
    expect(PVP_DEFENSE_SEATS).toHaveLength(PVP_DEFENSE_CAP);
    expect(defenseSeatForGroup("Regular")).not.toBe(defenseSeatForGroup("Female"));
    expect(defenseSeatForGroup("Sasquatch")).toBeNull(); // a class with no post

    // ...and one zombie of each class really does fill every one of them.
    expect(selectFormationDefense(build(ONE_PER_CLASS, "d"))).toHaveLength(PVP_DEFENSE_CAP);
  });

  it("lets a defending Regular fire its beam while the attackers walk in", () => {
    // The mirror of the attacker's walking laser (BattleSim.stepDefenderLaser). A defender
    // stands on a station and never walks, so the firer-walks trigger would have handed it a
    // beam it could never use; it fires while THEY close instead. Without this the laser was
    // the one ability only an attacker could ever have, so every player-side damage buff
    // tilted the mode — see the balance target below.
    const defense = formation();
    const regular = defense.find((u) => u.sourceKey === "ZombieActorRegularTier3")!;
    expect(regular.abilities).toContain("laserBeam"); // kept by PVP_DEFENSE_PASSIVE_ABILITIES
    const attackers = build(["ZombieActorHeadlessTier4", "ZombieActorHeadlessTier4"], "a");
    const sim = new BattleSim(attackers, defense, null, true, [], undefined, null, null,
      false, false, false, undefined, null, null, { maxActive: 1, dripMs: 0 }, null);
    const firer = sim.units.find((u) => u.id === regular.id)!;
    const startHp = sim.units.filter((u) => u.team === "player").reduce((s, u) => s + u.hp, 0);
    // Attackers are chosen for having NO beam of their own, so any damage here is the
    // defender's: it is the only thing on the field that can shoot while nobody is in range.
    let ticks = 0;
    while (firer.laserFxSeq === 0 && ticks < 400) { sim.step(RAID_TICK_MS); ticks++; }
    expect(firer.laserFxSeq).toBeGreaterThan(0);
    expect(firer.laserTargetId).toMatch(/^a/);
    expect(sim.units.filter((u) => u.team === "player").reduce((s, u) => s + u.hp, 0))
      .toBeLessThan(startHp);
  });

  it("holds the beam while nobody is walking in", () => {
    // The window is the APPROACH, both ways round: an attacker's beam goes quiet when it
    // arrives and starts swinging, and a defender's goes quiet when there is nobody left to
    // shoot at. A defender that kept firing into a stalled line would be grinding down a
    // fight it is not winning, which is not what the ability is.
    const defense = formation();
    const regular = defense.find((u) => u.sourceKey === "ZombieActorRegularTier3")!;
    const sim = new BattleSim(build(["ZombieActorHeadlessTier4"], "a"), defense, null, true, [],
      undefined, null, null, false, false, false, undefined, null, null,
      { maxActive: 1, dripMs: 0 }, null);
    const firer = sim.units.find((u) => u.id === regular.id)!;
    // Nothing has been released from the charge queue, so no zombie is walking in yet.
    for (let t = 0; t < 10; t++) sim.step(RAID_TICK_MS);
    expect(sim.units.some((u) => u.team === "player" && u.walkingThisTick)).toBe(false);
    expect(firer.laserFxSeq).toBe(0);
  });

  it("leaves classic mode stripped, beam included", () => {
    // Classic defenses clear EVERY ability (see toEnemyCopy); only formation mode keeps the
    // ones that run themselves. A raid is protected by the same gate from the other side:
    // every authored enemy carries `abilities: []`, so laserInterval returns 0 for it.
    const classic = toDefenseUnits(build(ONE_PER_CLASS, "d"));
    expect(classic.every((u) => u.abilities.length === 0)).toBe(true);
    const sim = new BattleSim(build(["ZombieActorRegularTier3"], "a"), classic, null, true, [],
      undefined, null, null, false, false, false, undefined, null, null,
      { maxActive: 1, dripMs: 0 }, null);
    for (let t = 0; t < 400; t++) sim.step(RAID_TICK_MS);
    expect(sim.units.filter((u) => u.team === "enemy").every((u) => u.laserFxSeq === 0)).toBe(true);
  });

  it("gives every class its own job, front to back, one seat each", () => {
    const units = formation();
    expect(units.map((u) => u.defenseRole)).toEqual(
      ["tank", "brute", "mini", "line", "line", "support"]
    );
    // The tank holds the front; the support stands deepest, out of the combat band.
    const at = (role: string) => units.find((u) => u.defenseRole === role)!;
    expect(at("tank").stationX).toBe(DEF_TANK_X);
    expect(at("mini").stationX).toBe(DEF_LINE_X);
    expect(at("support").stationX).toBe(DEF_SUPPORT_X);
    expect(at("tank").stationX!).toBeLessThan(at("support").stationX!);
    // The BRUTE is up on the perch — the boss of the farm — so its station is in the
    // air, above and right of the ground line. refreshFrontLine skips it entirely.
    expect(at("brute").isBoss).toBe(true);
    expect(at("brute").stationY!).toBeLessThan(0);
    // The Headless leads because it is the WALL THAT BARELY BITES: lowest dex in the
    // game on the highest con. Put a brute in front instead and the standing formation
    // becomes a meat grinder — see docs/PVP_DEFENSE_FORMATION.md.
    expect(at("tank").sourceKey).toContain("Headless");
  });

  it("arms the perched brute with a throw that looks like the defense's own mini", () => {
    const units = formation();
    const throwCfg = pvpBossThrow(units)!;
    expect(throwCfg).toBeTruthy();
    expect(throwCfg.intervalMs).toBe(PVP_THROW_INTERVAL_MS);
    const [option] = throwCfg.options;
    // The projectile IS the mini: drawn from its portrait, hitting for what it hits for.
    const mini = units.find((u) => u.defenseRole === "mini")!;
    expect(option.sprite).toBe(`${PVP_ZOMBIE_SPRITE_PREFIX}${mini.sourceKey}`);
    expect(option.damage).toBeGreaterThan(0);
    // No brute or no mini means no throw, rather than a throw of nothing.
    expect(pvpBossThrow(units.filter((u) => u.defenseRole !== "mini"))).toBeNull();
    expect(pvpBossThrow(units.filter((u) => u.defenseRole !== "brute"))).toBeNull();
  });

  it("perches the brute clear of the ground stations and drops the perch on descent", () => {
    const brute = formation().find((u) => u.defenseRole === "brute")!;
    expect(brute.stationY).toBe(PVP_PERCH_Y);
    expect(brute.stationY!).toBeLessThan(0); // up in the air, not on the lawn
    expect(brute.stationX).toBe(PVP_PERCH_X);
  });

  it("stands the defense up at once and reinforces the line on the drip", () => {
    const units = formation();
    for (const role of ["tank", "brute", "support"]) {
      expect(units.find((u) => u.defenseRole === role)!.deployAtMs).toBe(0);
    }
    const line = units.filter((u) => u.defenseRole === "line");
    expect(line.map((u) => u.deployAtMs)).toEqual([PVP_DEFENSE_DRIP_MS, PVP_DEFENSE_DRIP_MS * 2]);
  });

  it("holds the mini off-field as ammunition, on no clock at all", () => {
    const mini = formation().find((u) => u.defenseRole === "mini")!;
    // It is the thing being thrown, so it must not also be standing in the line being
    // hit. A descent is an EVENT, so it carries no arrival time — giving it one would
    // walk it on partway through its own bombardment.
    expect(mini.deployWithBoss).toBe(true);
    expect(mini.deployAtMs).toBeUndefined();

    // ...but only when something is actually throwing it. With no brute in the defense
    // there is no descent to wait for, so a held mini would stand the fight up until
    // the time cap; it deploys normally instead.
    const bruteless = build(ONE_PER_CLASS.filter((k) => !k.includes("Large")), "n");
    const units = formationDefenseUnits(selectFormationDefense(bruteless));
    expect(units.some((u) => u.defenseRole === "brute")).toBe(false);
    const lone = units.find((u) => u.defenseRole === "mini")!;
    expect(lone.deployWithBoss).toBeUndefined();
    expect(lone.deployAtMs).toBe(0);
  });

  it("the brute and its mini take the field together, and not before", () => {
    // The owner's rule: the mini is the ammunition for the whole perch phase, then the
    // pair charges out together (the Mini Buddy mount is the flavour; simultaneous
    // arrival is the mechanic). So the mini must be off-field for every tick the brute
    // is up on the structure, and on-field from the tick it starts down.
    const defenders = formation();
    const attackers = build(
      Array.from({ length: PVP_ARMY_SIZE }, () => "ZombieActorRegularTier4"), "a");
    const sim = new BattleSim(
      attackers, defenders, pvpBossThrow(defenders), true, [], undefined,
      null, null, false, false, false, undefined, null, null,
      { maxActive: 1, dripMs: 0 }, null
    );
    const roster = (sim as unknown as {
      enemies: { defenseRole: string | null; state: string; alive: boolean }[];
    }).enemies;
    const brute = roster.find((e) => e.defenseRole === "brute")!;
    const mini = roster.find((e) => e.defenseRole === "mini")!;

    let sawPerchedTogether = false;
    let releasedWhileBrutePerched = false;
    let strandedAfterDescent = false;
    for (let t = 0; t < RAID_MAX_TICKS && !sim.finished; t++) {
      sim.step(RAID_TICK_MS);
      if (brute.state === "structure") {
        sawPerchedTogether = true;
        if (mini.state !== "queued") releasedWhileBrutePerched = true;
      } else if (brute.alive && mini.alive && mini.state === "queued") {
        strandedAfterDescent = true;
      }
    }
    expect(sawPerchedTogether, "the brute never perched — the fixture is wrong").toBe(true);
    expect(releasedWhileBrutePerched, "the mini walked on mid-bombardment").toBe(false);
    expect(strandedAfterDescent, "the mini was left in the barn after the brute came down")
      .toBe(false);
  });

  it("the brute comes down once only the healer is left holding the ground", () => {
    // Owner's rule: the brute descends when the headless, normal and girl zombies are
    // dead — or any time the Garden zombie is the only one down there, which is what
    // happens when an attacker kills the tank before a reinforcement lands. A Garden
    // zombie cannot hold a line, so leaving the brute perched while the farm is picked
    // apart just parks the defense's best fighter somewhere unreachable.
    //
    // The assertion that matters is DESCENDS WITH THE HEALER STILL ALIVE: the old rule
    // waited for every last defender, healer included, and could never satisfy it.
    // Measured, the descent moved from 33.0 s to 24.5 s on this fight.
    const defenders = formation();
    const attackers = build(["ZombieActorRegularTier3", "ZombieActorHeadlessTier3",
      "ZombieActorLargeTier3", "ZombieActorGirlTier3", "ZombieActorSmallTier3",
      "ZombieActorRegularTier4", "ZombieActorHeadlessTier4", "ZombieActorLargeTier4"], "a");
    const sim = new BattleSim(
      attackers, defenders, pvpBossThrow(defenders), true, [], undefined,
      null, null, false, false, false, undefined, null, null,
      { maxActive: 1, dripMs: 0 }, null
    );
    const roster = (sim as unknown as {
      enemies: { defenseRole: string | null; state: string; alive: boolean; isBoss: boolean }[];
    }).enemies;
    const brute = roster.find((e) => e.defenseRole === "brute")!;
    const support = roster.find((e) => e.defenseRole === "support")!;

    let descended = false;
    let holdersAtDescent = -1;
    let supportAliveAtDescent = false;
    for (let t = 0; t < RAID_MAX_TICKS && !sim.finished; t++) {
      sim.step(RAID_TICK_MS);
      if (brute.state === "structure" || !brute.alive) continue;
      descended = true;
      // The mini is excluded because the descent is what RELEASES it — it walks out
      // with the brute, so by this tick it is already standing.
      holdersAtDescent = roster.filter((e) => e.alive && !e.isBoss &&
        e.state !== "queued" && e.defenseRole !== "support" && e.defenseRole !== "mini").length;
      supportAliveAtDescent = support.alive;
      break;
    }
    expect(descended, "the brute never left its perch").toBe(true);
    // Not early: it does not abandon the line while the line still holds.
    expect(holdersAtDescent, "came down while a non-healer still held the ground").toBe(0);
    // Not late: this is the half the old "wait for every defender" rule failed.
    expect(supportAliveAtDescent, "waited for the healer to die too").toBe(true);
  });

  it("the throw carries BOTH zombies' swings, not just the mini's", () => {
    // Owner's ruling, and the fix for a throw that measured as noise: the brute
    // supplies the arm, the mini the teeth.
    const units = formation();
    const brute = units.find((u) => u.defenseRole === "brute")!;
    const mini = units.find((u) => u.defenseRole === "mini")!;
    const hit = (u: typeof brute) =>
      Math.max(1, Math.round(u.str * 10 * (u.attacks[0]?.mult ?? 1)));
    expect(pvpBossThrow(units)!.options[0].damage).toBe(hit(brute) + hit(mini));
    // Sanity: the brute is the larger half, so this is not a rounding-level change.
    expect(hit(brute)).toBeGreaterThan(hit(mini));
  });

  it("keeps the abilities that run themselves and strips every tap", () => {
    const units = formation();
    const support = units.find((u) => u.defenseRole === "support")!;
    expect(support.abilities).toContain("heal");
    for (const unit of units) {
      for (const key of unit.abilities) {
        expect(PVP_DEFENSE_PASSIVE_ABILITIES).toContain(key);
      }
    }
    // Classic mode is unchanged: it strips everything, healer included.
    expect(toDefenseUnits(build(ONE_PER_CLASS, "c")).every((u) => u.abilities.length === 0))
      .toBe(true);
  });

  it("a defending healer HEALS — the silent no-op this mode exists to fix", () => {
    const defenders = formation();
    const attackers = build(Array.from({ length: PVP_ARMY_SIZE }, () => "ZombieActorRegularTier4"), "a");
    const sim = new BattleSim(
      attackers, defenders, null, true, [], undefined,
      null, null, false, false, false, undefined, null, null,
      { maxActive: 1, dripMs: 0 }, null
    );
    const hpWas = new Map<string, number>();
    let healed = false;
    for (let t = 0; t < RAID_MAX_TICKS && !sim.finished; t++) {
      sim.step(RAID_TICK_MS);
      for (const u of sim.units) {
        if (u.team !== "enemy" || !u.alive) continue;
        const prev = hpWas.get(u.id);
        if (prev !== undefined && u.hp > prev) healed = true;
        hpWas.set(u.id, u.hp);
      }
    }
    expect(healed, "a defending Garden zombie restored a defender's hit points").toBe(true);
    // ...and the fight still reaches a verdict rather than idling into the cap: the
    // support drops its station once it is alone, so it can be reached and fought.
    expect(sim.finished).toBe(true);
  });

  it("holds the balance target: a defense breaks even near a fair mirror", () => {
    // The reason this mode exists. Measured on the shipped classic defense, an
    // attacker needed a 1.24x STRONGER defense to be stopped — it fields three
    // zombies at a time while the attacker accumulates without a ceiling. A standing
    // formation with a working healer brought that to ~1.05x.
    //
    // WHICH WAY THIS NUMBER POINTS, because earlier notes here had it inverted: it is
    // the multiplier the DEFENSE needs before it holds, so 1.00 is a fair mirror and
    // ABOVE 1.00 means the ATTACKER is favoured. Confirmed directly — the full red six
    // loses to a mirror-power eight at 0.5x, 1.0x and 1.2x, and only holds from ~1.34x.
    //
    // MEASURED REGRESSION, RECORDED NOT ACCEPTED (ruleset 42). Holding the mini back as
    // the brute's ammunition moved this 1.19x -> 1.39x: the mini left the defensive
    // line, so the line got weaker, which is exactly as plain as it sounds. That is
    // worse than the classic mode formation was built to improve on (1.24x).
    //
    // Paying the throw BOTH zombies' swings (owner's ruling) is the first repair,
    // taking the throw from worth 0.007x of this number to 0.058x (1.395 with it off,
    // 1.337 with it on) — the perch phase now does something. The descent trigger that
    // followed does NOT move it at all (1.337 either side) even though the descent
    // itself lands 8.5 s earlier: coming down sooner both adds the brute's damage and
    // exposes it to being killed, and those cancel.
    //
    // MEASURED LEVERS, swept across compositions. Both work in the intuitive direction
    // and stack; a fair mirror wants roughly the 7.5s/x3 corner:
    //          mixed  8xRegT4  8xHeadT4  8xSmallT4
    //   15s x1  1.34     1.59      1.97       1.13   <- shipped
    //   15s x3  1.23     1.47      1.95       1.00
    //   10s x1  1.22     1.44      1.71       1.04
    //   7.5s x1 1.17     1.38      1.57       0.99
    //   7.5s x3 1.06     1.33      1.54       0.88
    // ATTACKER COMPOSITION MATTERS MORE THAN EITHER DIAL. Eight Headless T4 (the
    // tankiest body in the game) sit at 1.97 and barely respond to the throw, because
    // they out-last it rather than out-damage it; eight Small T4 are already at parity.
    // No dial closes that spread — it is the shape of the fight, and worth knowing
    // before anyone tunes to a single column.
    //
    // RESOLVED by the drip, not the throw: 15 s -> 5 s brings this fight to 1.13 and the
    // goal band is restored. The drip won because it is the only dial that moves the
    // tanky-attacker case — eight Headless T4 go 1.97 -> 1.45, while three times the
    // throw damage barely touched them (1.97 -> 1.95). Armies that out-LAST a defense
    // are answered by more defenders on the ground sooner, not by bigger numbers. It
    // also fixed a pacing bug nobody had noticed: at 15 s the SECOND reinforcement
    // landed at 30 s into a ~33 s fight, so half the line never fought.
    //
    // Full sweep at 5 s (13 defense x 6 attacker compositions), full red six:
    //   mixed 1.13 · 8xRegT4 1.37 · 8xHeadT4 1.45 · 8xLargeT4 1.16 · 8xSmallT4 0.97
    // The spread nearly halved (0.84 wide -> 0.48) but has NOT closed, and no dial
    // closes it — tune against the spread, never against one column.
    //
    // RULESET 43 (the walking laser, and the defender's mirror of it). Re-swept, full red six:
    //   before          mixed 1.125 · RegT4 1.374 · HeadT4 1.450 · LargeT4 1.161 · SmallT4 0.973
    //   beam buff only  mixed 1.175 · RegT4 1.538 · HeadT4 1.450 · LargeT4 1.161 · SmallT4 0.973
    //   + defender beam mixed 1.101 · RegT4 1.480 · HeadT4 1.404 · LargeT4 1.078 · SmallT4 0.924
    // The middle row is the whole argument for stepDefenderLaser: only the two columns with
    // beam carriers move at all, and they move against the defense, because the beam was the
    // one ability a defender could not have. Give it back and every column comes down, the
    // all-Regular one included. Four of the five now sit BELOW where they started.
    // The exception is 8xRegT4 (1.374 -> 1.480), and it is structural rather than a miss: an
    // attacker may field eight beam carriers, a one-per-class formation defense exactly one,
    // so the mirror is 8:1 in that column and cannot fully answer it. It is worth noting the
    // TOP of the spread barely moved (1.450 -> 1.480); what widened it (0.477 -> 0.556) is the
    // bottom coming down, i.e. the defense improving against the armies it already beat.
    // With the mirror in, laser DAMAGE is close to spread-neutral: at ground-truth damage the
    // mixed column reads 1.111 against 1.101 at the shipped 2x, so a bigger beam now very
    // slightly favours the DEFENSE — it covers the whole approach, the attacker's only its own.
    //
    // Pinned as a BAND, not a number: the sim is fully deterministic, so the search
    // below is stable and any FURTHER drift fails here rather than in a playtest.
    const ATTACK = ["ZombieActorRegularTier3", "ZombieActorHeadlessTier3", "ZombieActorLargeTier3",
      "ZombieActorGirlTier3", "ZombieActorSmallTier3", "ZombieActorRegularTier4",
      "ZombieActorHeadlessTier4", "ZombieActorLargeTier4"];
    const scaled = (keys: string[], power: number, prefix: string) => buildPlayerUnits(
      keys.map((k, i) => {
        const base = zombieDefs.find((z) => z.key === k)!;
        return makeOwned(`${prefix}${i}`, { ...base,
          str: (base.str as number) * power, dex: (base.dex as number) * power,
          con: (base.con as number) * power } as unknown as Parameters<typeof makeOwned>[1],
          0, 0, 0, 0);
      }),
      { concentration: true, abilityUnlocked: () => true, playerLevel: 30 }
    );
    const attackerWins = (defPower: number) => {
      const defense = formationDefenseUnits(selectFormationDefense(scaled(ONE_PER_CLASS, defPower, "d")));
      const sim = new BattleSim(
        scaled(ATTACK, 1, "a"),
        defense,
        // The real fight ships with the brute's throw, so measure it. (It barely moves
        // the number today — that is the finding above, not an argument for dropping it.)
        pvpBossThrow(defense), true, [], undefined,
        null, null, false, false, false, undefined, null, null,
        { maxActive: 1, dripMs: 0 }, null
      );
      let t = 0;
      while (!sim.finished && t < RAID_MAX_TICKS) { sim.step(RAID_TICK_MS); t++; }
      return sim.playerWon;
    };
    let lo = 0.2;
    let hi = 4.0;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (attackerWins(mid)) lo = mid; else hi = mid;
    }
    expect(hi).toBeGreaterThan(0.9); // the defense must not simply win by standing
    expect(hi).toBeLessThan(1.25); // ...nor need a materially stronger roster to hold
  });

  it("credits support in the tier — a healer is worth what a fighter is worth", () => {
    // Six fighters versus five fighters and a healer: the healer must not be a
    // downgrade (owner's ruling). Without the group-level credit it scored ~zero.
    const sixFighters = build(
      ["ZombieActorHeadlessTier3", "ZombieActorLargeTier3", "ZombieActorSmallTier3",
       "ZombieActorRegularTier3", "ZombieActorGirlTier3", "ZombieActorRegularTier4"], "f");
    const withHealer = formation();
    const fighters = groupTierPoints(enemyCopies(sixFighters), PVP_DEFENSE_CAP);
    const healer = groupTierPoints(withHealer, PVP_DEFENSE_CAP);
    expect(healer / fighters).toBeGreaterThan(0.6);
    // The credit only applies where the healing is REAL: strip the abilities (classic
    // mode) and the same six zombies score strictly lower.
    expect(groupTierPoints(toDefenseUnits(build(ONE_PER_CLASS, "d")), PVP_DEFENSE_CAP))
      .toBeLessThan(healer);
  });
});

describe("the fight itself (real BattleSim, defenders as the enemy team)", () => {
  const fight = (attackPower: number, defensePower: number, defenders = 8) => {
    const sim = new BattleSim(
      army(PVP_ARMY_SIZE, attackPower, "a"),
      toDefenseUnits(army(defenders, defensePower, "b")),
      null, // no boss throw
      true, // concentration pinned for PvP: auto-release, no bubble inputs
      [],
      undefined,
      null, null, false, false, false, undefined, null, null,
      PVP_WAVE_CADENCE,
      null
    );
    return replayRaid(sim, 0, []);
  };

  it("runs to a deterministic conclusion with an empty transcript", () => {
    const first = fight(3, 1);
    const second = fight(3, 1);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok) {
      expect(first.outcome.win).toBe(true); // a 3x attacker beats a 1x defense
      // Comfortably inside the 4-minute replay cap the server enforces.
      expect(first.outcome.rounds * RAID_TICK_MS)
        .toBeLessThan(RAID_MAX_TICKS * RAID_TICK_MS * 0.75);
    }
  });

  it("a strong defense repels a weak attack", () => {
    const result = fight(1, 4, 16);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.outcome.win).toBe(false);
  });
});

describe("buildPvpRaidDef", () => {
  it("borrows the given stage assets and stays hazard-free", () => {
    const def = buildPvpRaidDef(
      { raidName: "Pat's Farm", defenderName: "Pat" },
      {
        music: "farmStageBGM.mp3",
        levelAssets: [{ sprite: "fightBGFarm_bg.png", position: "{0,0}", anchor: "{0,0}", z: 0 }],
      } as never
    );
    expect(def.id).toBeLessThan(0);
    expect(def.levelAssets).toHaveLength(1);
    expect(def.music).toBe("farmStageBGM.mp3");
    expect(def.obstacleLimit).toBe(0);
    expect(def.hasGrab).toBe(false);
    expect(def.stages[0].bossKey).toBeUndefined();
  });
});
