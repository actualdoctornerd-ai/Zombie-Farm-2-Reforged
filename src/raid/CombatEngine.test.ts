import { describe, it, expect } from "vitest";
import { resolveRaid, buildEnemyUnits, buildPlayerUnits } from "./CombatEngine";
import type { CombatUnit } from "./types";
import type { OwnedZombie } from "../zombie/types";
import shippedStats from "../../public/assets/raids/enemy_stats.json";
import shippedAttacks from "../../public/assets/raids/attacks.json";

// resolveRaid is the deterministic instant-resolver. These tests pin the outcome
// direction and, crucially, that the recovered damage formula
// (max(0, dmg − armor) × (1 − DR)) is wired into the hit step.

function mk(over: Partial<CombatUnit> & { id: string; team: "player" | "enemy" }): CombatUnit {
  return {
    sourceKey: over.id,
    name: over.id,
    str: 10,
    dex: 5,
    con: 10,
    focus: 0,
    hp: 100,
    maxHp: 100,
    attackCooldownMs: 1000,
    attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false,
    alive: true,
    isGarden: false,
    isHeadless: false,
    abilities: [],
    ...over,
  };
}

describe("resolveRaid outcome direction", () => {
  it("a strong army beats a weak wave", () => {
    const player = [mk({ id: "p", team: "player", str: 50, con: 50 })];
    const enemy = [mk({ id: "e", team: "enemy", str: 2, con: 5 })];
    expect(resolveRaid(player, enemy).win).toBe(true);
  });

  it("a weak army loses to a strong wave", () => {
    const player = [mk({ id: "p", team: "player", str: 2, con: 5 })];
    const enemy = [mk({ id: "e", team: "enemy", str: 50, con: 50 })];
    expect(resolveRaid(player, enemy).win).toBe(false);
  });
});

describe("damage formula is wired into the resolver", () => {
  const player = () => [mk({ id: "p", team: "player", str: 20, con: 30, dex: 10 })];

  it("near-total damage reduction on the enemy flips a win into a loss", () => {
    const winnable = resolveRaid(player(), [mk({ id: "e", team: "enemy", str: 3, con: 20 })]);
    expect(winnable.win).toBe(true);

    const armored = resolveRaid(player(), [
      mk({ id: "e", team: "enemy", str: 3, con: 20, damageReduction: 0.99 }),
    ]);
    expect(armored.win).toBe(false); // player's damage is reduced to ~0 → can't kill
  });

  it("flat armor ≥ the attacker's per-hit damage blocks all of it", () => {
    // player hitDamage = finalPower(str20×10) × mult(1) × K(0.7) = 140; armor 200 absorbs it.
    const blocked = resolveRaid(player(), [
      mk({ id: "e", team: "enemy", str: 3, con: 20, armor: 200 }),
    ]);
    expect(blocked.win).toBe(false);
    expect(blocked.playerDamage).toBe(0);
  });
});

describe("enemies engage one at a time (army concentration matters)", () => {
  const army = (team: "player" | "enemy", n: number) =>
    Array.from({ length: n }, (_, i) => mk({ id: `${team}${i}`, team, str: 10, con: 10 }));

  it("an even-stat army beats a same-size wave by focusing it down one at a time", () => {
    // Under an all-at-once wave this is a loss; one-at-a-time, the army's concentrated
    // fire wins with survivors.
    const r = resolveRaid(army("player", 5), army("enemy", 5));
    expect(r.win).toBe(true);
    expect(r.enemiesBeaten).toBe(5);
    expect(r.survivors.length).toBeGreaterThan(0);
  });

  it("still loses when badly outnumbered by equal units", () => {
    const r = resolveRaid(army("player", 1), army("enemy", 4));
    expect(r.win).toBe(false);
  });

  it("faces the wave sequentially — a lone zombie can chip several before falling", () => {
    // Weak-but-many player vs one tanky enemy: the whole army piles the single enemy.
    const tank = mk({ id: "boss", team: "enemy", str: 8, con: 40 });
    const r = resolveRaid(army("player", 6), [tank]);
    expect(r.win).toBe(true);
  });
});

describe("weighted raid populations", () => {
  it("preserves the authored population exactly after weight apportionment", () => {
    const stats = Object.fromEntries(["a", "b", "c"].map((key) => [key, {
      str: 1, dex: 1, con: 1, attacks: [],
    }]));
    const units = buildEnemyUnits({
      enemyKeys: [],
      population: 11,
      weighted: [
        { enemy: "a", frequency: 50 },
        { enemy: "b", frequency: 33 },
        { enemy: "c", frequency: 17 },
      ],
    }, stats, {});
    expect(units).toHaveLength(11);
    expect(units.filter((unit) => unit.sourceKey === "a")).toHaveLength(5);
    expect(units.filter((unit) => unit.sourceKey === "b")).toHaveLength(4);
    expect(units.filter((unit) => unit.sourceKey === "c")).toHaveLength(2);
  });
});

describe("buildPlayerUnits — level-scaling is applied", () => {
  const headless = (): OwnedZombie[] => [
    {
      id: "z1",
      key: "ZombieActorHeadless",
      name: "Bob",
      typeName: "Skull Head",
      group: "Headless",
      className: "Green",
      classColor: "#000",
      mutation: 0,
      str: 11,
      dex: 1,
      con: 29.7, // base con; Headless con floor is 11
      focus: 100,
      invasions: 0,
      col: 0,
      row: 0,
    },
  ];

  it("a low-level army fights weaker than a maxed one (con ramps HP)", () => {
    const lo = buildPlayerUnits(headless(), { playerLevel: 8 })[0]; // con -> floor 11
    const hi = buildPlayerUnits(headless(), { playerLevel: 25 })[0]; // con -> base 29.7
    expect(lo.maxHp).toBeLessThan(hi.maxHp);
    expect(lo.maxHp).toBe(1100); // con 11 × 100 (ground-truth hitPointsTotal)
    expect(hi.maxHp).toBe(2970); // con 29.7 × 100
  });

  it("omitting playerLevel fights at full base stats (no scaling)", () => {
    const full = buildPlayerUnits(headless(), {})[0];
    expect(full.maxHp).toBe(2970);
  });

  it("does not scale focus (only str/con/dex)", () => {
    const lo = buildPlayerUnits(headless(), { playerLevel: 8 })[0];
    expect(lo.focus).toBe(100); // unchanged despite low level
  });

  it("applies equipped farmer head strength and life bonuses", () => {
    const base = buildPlayerUnits(headless())[0];
    const buffed = buildPlayerUnits(headless(), {
      farmerStrengthMult: 1.1,
      farmerLifeMult: 1.1,
    })[0];
    expect(buffed.str).toBeCloseTo(base.str * 1.1);
    expect(buffed.maxHp).toBeCloseTo(base.maxHp * 1.1);
  });

  it("carries the owned mutation mask into the raid combat unit", () => {
    const mutated = headless()[0];
    mutated.group = "Regular";
    mutated.mutation = 4 | 64;
    expect(buildPlayerUnits([mutated])[0].mutation).toBe(4 | 64);
  });
});

// Ground truth: `-[ZombieActor modifyStats:]` chains modifyStatWithLevelScale: →
// modifyStatWithFarmerHeads: → modifyStatWithAbilities: → modifyStatWithRank: →
// modifyStatWithMutations:, so a mutation's flat bonus lands LAST — never scaled by the
// level ramp, never multiplied by veterancy. `OwnedZombie.str/con/dex` already include
// the bonus (makeOwned bakes it in for the detail card), so buildPlayerUnits peels it
// off, runs the chain, and adds it back. Baking it in before the ramp — the old
// behaviour — left a full 5-slot set worth ~25 % of its face value at level 12.
describe("buildPlayerUnits — mutations apply last, as a flat bonus", () => {
  // Garlichead (+3 str, head) | Dragon-arm (+4 str, arm) | Carrot-eyed (+1 dex, hair_eye)
  const MASK = 256 | 4096 | 4;
  const MUT_STR = 7;
  const MUT_DEX = 1;

  /** A Blue Regular (base str 5 / dex 2 / con 5 — exactly the Regular endpoints, so the
   *  level ramp is a no-op on the base and any level dependence must come from the
   *  mutation). `str`/`dex` carry the bonus, as makeOwned produces them. */
  const mutant = (over: Partial<OwnedZombie> = {}): OwnedZombie[] => [
    {
      id: "m1", key: "ZombieActorRegularTier2", name: "Zyborg", typeName: "Zyborg",
      group: "Regular", className: "Blue", classColor: "#5aa8ff",
      mutation: MASK,
      str: 5 + MUT_STR, dex: 2 + MUT_DEX, con: 5,
      focus: 100, invasions: 0, col: 0, row: 0,
      ...over,
    },
  ];

  it("pays the mutation at face value well below level 25", () => {
    const lo = buildPlayerUnits(mutant(), { playerLevel: 12 })[0];
    expect(lo.str).toBeCloseTo(5 + MUT_STR);
    expect(lo.dex).toBeCloseTo(2 + MUT_DEX);
  });

  it("pays the same mutation at level 12 and level 25", () => {
    const lo = buildPlayerUnits(mutant(), { playerLevel: 12 })[0];
    const hi = buildPlayerUnits(mutant(), { playerLevel: 25 })[0];
    expect(lo.str).toBeCloseTo(hi.str);
  });

  it("veterancy multiplies the base stat only, not the flat mutation", () => {
    const master = buildPlayerUnits(mutant({ invasions: 5 }), { playerLevel: 25 })[0];
    expect(master.str).toBeCloseTo(5 * 1.25 + MUT_STR); // 13.25, not 12 × 1.25 = 15
  });

  it("still ramps the UNMUTATED base while paying the mutation in full", () => {
    // Headless con: endpoint 11, base 29.7, +3 con from Lima Bean -> listed 32.7.
    // Lima Bean deliberately, not a hair/eye mutation: this unit is HEADLESS, which
    // may hold body/arm/neck bits and nothing else (HEADLESS_SLOTS).
    const mask = 1024;
    const head = (): OwnedZombie[] => [
      { ...mutant()[0], group: "Headless", key: "ZombieActorHeadless", mutation: mask,
        str: 11, dex: 1, con: 29.7 + 3 },
    ];
    expect(buildPlayerUnits(head(), { playerLevel: 8 })[0].maxHp).toBe(1400); // (11 + 3) × 100
    expect(buildPlayerUnits(head(), { playerLevel: 25 })[0].maxHp).toBe(3270); // (29.7 + 3) × 100
  });
});

describe("buildPlayerUnits — binary-authentic zombie abilities", () => {
  const owned = (
    id: string,
    group: string,
    className: string,
    over: Partial<OwnedZombie> = {}
  ): OwnedZombie => ({
    id,
    key: `ZombieActor${group}${className}`,
    name: id,
    typeName: id,
    group,
    className,
    classColor: "#000",
    mutation: 0,
    str: 10,
    dex: 2,
    con: 20,
    focus: 50,
    invasions: 0,
    col: 0,
    row: 0,
    ...over,
  });
  const unlocked = () => true;

  it("Chivalry buffs Girl stats but not its Regular carrier", () => {
    const girl = owned("girl", "Female", "Green");
    const carrier = owned("knight", "Regular", "Blue");
    const solo = buildPlayerUnits([girl], { abilitySlotUnlocked: unlocked })[0];
    const [buffed, regular] = buildPlayerUnits([girl, carrier], { abilitySlotUnlocked: unlocked });
    expect(buffed.str).toBeCloseTo(solo.str * 1.10);
    expect(buffed.dex).toBeCloseTo(solo.dex * 1.10);
    expect(buffed.maxHp).toBeCloseTo(solo.maxHp * 1.10);
    expect(regular.str).toBeCloseTo(10 * 1.05); // only its own +5% All Stats
  });

  it("Grace buffs Regular zombies", () => {
    const regular = owned("regular", "Regular", "Green");
    const carrier = owned("grace", "Female", "Blue");
    const solo = buildPlayerUnits([regular], { abilitySlotUnlocked: unlocked })[0];
    const [buffed] = buildPlayerUnits([regular, carrier], { abilitySlotUnlocked: unlocked });
    expect(buffed.str).toBeCloseTo(solo.str * 1.10);
    expect(buffed.dex).toBeCloseTo(solo.dex * 1.10);
    expect(buffed.maxHp).toBeCloseTo(solo.maxHp * 1.10);
  });

  it("stacks duplicate Chivalry and Grace carriers additively", () => {
    const girl = owned("girl", "Female", "Green");
    const knightA = owned("knight-a", "Regular", "Blue");
    const knightB = owned("knight-b", "Regular", "Blue");
    const regular = owned("regular", "Regular", "Green");
    const graceA = owned("grace-a", "Female", "Blue");
    const graceB = owned("grace-b", "Female", "Blue");
    const girlSolo = buildPlayerUnits([girl], { abilitySlotUnlocked: unlocked })[0];
    const regularSolo = buildPlayerUnits([regular], { abilitySlotUnlocked: unlocked })[0];
    const [buffedGirl] = buildPlayerUnits([girl, knightA, knightB], { abilitySlotUnlocked: unlocked });
    const [buffedRegular] = buildPlayerUnits([regular, graceA, graceB], { abilitySlotUnlocked: unlocked });
    expect(buffedGirl.str).toBeCloseTo(girlSolo.str * 1.20);
    expect(buffedGirl.dex).toBeCloseTo(girlSolo.dex * 1.20);
    expect(buffedGirl.maxHp).toBeCloseTo(girlSolo.maxHp * 1.20);
    expect(buffedRegular.str).toBeCloseTo(regularSolo.str * 1.20);
    expect(buffedRegular.dex).toBeCloseTo(regularSolo.dex * 1.20);
    expect(buffedRegular.maxHp).toBeCloseTo(regularSolo.maxHp * 1.20);
  });

  it("Protect shields the rest of the line, and a carrier does not shield itself", () => {
    // Headless used to be cut out of its own group's aura entirely, which left the game's
    // tank bodies as the only ones that could not be shielded — a Bombie carries the
    // highest hit points in the roster and still took every blow raw. Ruleset v38 grants
    // it to every body type, keeping only the self-exclusion: the aura is what a Protect
    // zombie gives the OTHERS, so one carrier alone is still worth nothing to itself.
    const regular = owned("regular", "Regular", "Green");
    const headless = owned("protector", "Headless", "Blue");
    const one = buildPlayerUnits([regular, headless], { abilitySlotUnlocked: unlocked });
    expect(one[0].damageReduction).toBeCloseTo(0.20); // shielded by the carrier
    expect(one[1].damageReduction).toBe(0); // …which does not shield itself

    // A second carrier shields the first — the case the old exclusion could never reach.
    const built = buildPlayerUnits(
      [regular, headless, owned("protector-2", "Headless", "Blue")],
      { abilitySlotUnlocked: unlocked }
    );
    expect(built[0].damageReduction).toBeCloseTo(0.40); // both carriers
    expect(built[1].damageReduction).toBeCloseTo(0.20); // the other one
    expect(built[2].damageReduction).toBeCloseTo(0.20);
  });

  it("stacks duplicate Protect carriers additively", () => {
    const regular = owned("regular", "Regular", "Green");
    const protectA = owned("protector-a", "Headless", "Blue");
    const protectB = owned("protector-b", "Headless", "Blue");
    const [buffed] = buildPlayerUnits([regular, protectA, protectB], { abilitySlotUnlocked: unlocked });
    expect(buffed.damageReduction).toBeCloseTo(0.40);
  });

  it("Fortitude gives Headless zombies 10% Life", () => {
    const headless = owned("headless", "Headless", "Green");
    const garden = owned("garden", "Garden", "Blue");
    const solo = buildPlayerUnits([headless], { abilitySlotUnlocked: unlocked })[0];
    const [buffed] = buildPlayerUnits([headless, garden], { abilitySlotUnlocked: unlocked });
    expect(buffed.maxHp).toBeCloseTo(solo.maxHp * 1.10);
  });

  it("stacks duplicate Fortitude carriers additively", () => {
    const headless = owned("headless", "Headless", "Green");
    const gardenA = owned("garden-a", "Garden", "Blue");
    const gardenB = owned("garden-b", "Garden", "Blue");
    const solo = buildPlayerUnits([headless], { abilitySlotUnlocked: unlocked })[0];
    const [buffed] = buildPlayerUnits([headless, gardenA, gardenB], { abilitySlotUnlocked: unlocked });
    expect(buffed.maxHp).toBeCloseTo(solo.maxHp * 1.20);
  });

  it("Turbo doubles walking only, without changing DEX or attack cadence", () => {
    const turbo = owned("turbo", "Headless", "Red");
    const base = owned("base", "Headless", "Green");
    const [fast] = buildPlayerUnits([turbo], { abilitySlotUnlocked: unlocked });
    const [normal] = buildPlayerUnits([base], { abilitySlotUnlocked: unlocked });
    expect(fast.dex).toBeCloseTo(normal.dex);
    expect(fast.attackCooldownMs).toBeCloseTo(normal.attackCooldownMs);
    expect(fast.walkingSpeedMult).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Enemy cadence. Ground truth: one attack cycle is exactly getFightAttackSpeed —
// speedMultiplier × (1/dex) for an enemy — with no animation gate. (This replaced
// the old ENEMY_ATTACK_PACE=2 fudge, which halved every enemy's sustained DPS.)

describe("buildEnemyUnits — attack cadence", () => {
  const stats = {
    Farmhand: { str: 2, dex: 1, con: 3, attacks: [{ name: "poke", frequency: 100 }] },
    Lumberjack: {
      str: 1.5,
      dex: 2,
      con: 4,
      attacks: [
        { name: "slice", frequency: 90 },
        { name: "special", frequency: 10 },
      ],
    },
    PirateStageActorScallywag: { str: 50, dex: 0.5, con: 40, attacks: [{ name: "poke", frequency: 100 }] },
    PirateStageActorBoss: { str: 500, dex: 0.4, con: 120, attacks: [{ name: "poke", frequency: 100 }] },
    PirateStageActorSwashbuckler: { str: 8, dex: 2, con: 25, attacks: [{ name: "poke", frequency: 100 }] },
  };
  const attacks = {
    poke: {},
    slice: {},
    special: { damageMultiplier: 1.5, speedMultiplier: 5 },
  };
  const build = (key: string, opts = {}) =>
    buildEnemyUnits({ enemyKeys: [key] }, stats, attacks, opts)[0];

  it("runs on the raw 1/dex clock — twice as often as an equal-dex zombie", () => {
    expect(build("Farmhand").attackCooldownMs).toBeCloseTo(1000); // 1.0 / dex 1
    expect(build("Lumberjack").attackCooldownMs / 2).toBeCloseTo(350); // see below
  });

  it("folds each attack's speedMultiplier in, so a heavy swing is slower AND harder", () => {
    const lumberjack = build("Lumberjack");
    // cycle = mean(0.9×1 + 0.1×5) × (1/2 s) = 1.4 × 500 ms
    expect(lumberjack.attackCooldownMs).toBeCloseTo(700);
    // damage = str1.5×10 × mean(0.9×1 + 0.1×1.5) = 15 × 1.05
    expect(lumberjack.attacks[0].mult).toBeCloseTo(1.05);
    // Sustained DPS matches the real renewal process E[dmg]/E[cycle] = 22.5.
    const dps = (lumberjack.str * 10 * lumberjack.attacks[0].mult) /
      (lumberjack.attackCooldownMs / 1000);
    expect(dps).toBeCloseTo(22.5, 1);
  });

  it("flags BOTH pirates as mirroring their opponent's speed", () => {
    // The Scallywag's mirror is recovered ground truth; the boss's is a deliberate
    // divergence (ruleset v38) — see combatStats.PIRATE_BOSS_KEY. Nothing outside the
    // pirate family mirrors.
    expect(build("PirateStageActorScallywag").mirrorsOpponentSpeed).toBe(true);
    expect(build("PirateStageActorBoss").mirrorsOpponentSpeed).toBe(true);
    expect(build("PirateStageActorSwashbuckler").mirrorsOpponentSpeed).toBe(false);
    expect(build("Farmhand").mirrorsOpponentSpeed).toBe(false);
  });

  it("speeds Old McDonnell's farm up as the player out-levels it — and only that raid", () => {
    expect(build("Farmhand", { raidId: 1, playerLevel: 5 }).attackCooldownMs).toBeCloseTo(1000);
    expect(build("Farmhand", { raidId: 1, playerLevel: 10 }).attackCooldownMs).toBeCloseTo(660);
    expect(build("Farmhand", { raidId: 1, playerLevel: 15 }).attackCooldownMs).toBeCloseTo(440);
    expect(build("Farmhand", { raidId: 3, playerLevel: 40 }).attackCooldownMs).toBeCloseTo(1000);
  });
});

describe("resolveRaid — recovered cadence rules reach the resolver", () => {
  // An unkillable, harmless punching bag: the fight runs to the sim cap, so
  // `playerDamage` is a clean measure of the army's sustained output.
  const bag = () => mk({ id: "e", team: "enemy", str: 0, hp: 1e9, maxHp: 1e9 });
  const zombie = (i: number) =>
    mk({ id: `p${i}`, team: "player", str: 5, hp: 1e9, maxHp: 1e9, attackCooldownMs: 1000 });

  it("a rear zombie's depth band slows it down as well as softening it", () => {
    const front = resolveRaid(Array.from({ length: 5 }, (_, i) => zombie(i)), [bag()]);
    const deep = resolveRaid(Array.from({ length: 16 }, (_, i) => zombie(i)), [bag()]);
    // 16 zombies out-damage 5 — but nowhere near 3.2×, because everything past the
    // front five hits softer (×0.85/0.7/0.55) AND slower (×1.425/2/4).
    expect(deep.playerDamage).toBeGreaterThan(front.playerDamage);
    expect(deep.playerDamage).toBeLessThan(front.playerDamage * 3.2);
    expect(deep.playerDamage / front.playerDamage).toBeCloseTo(1.97, 1);
  });

  it("a Scallywag mirrors its opponent instead of using its own dex", () => {
    // The zombie swings every 2 s and dies to two hits; the enemy's own clock is 2 s.
    const foe = () => mk({ id: "p", team: "player", str: 5, hp: 1000, maxHp: 1000, attackCooldownMs: 2000 });
    const enemy = (mirror: boolean) =>
      mk({
        id: "e",
        team: "enemy",
        str: 50,
        hp: 1e9,
        maxHp: 1e9,
        attackCooldownMs: 2000,
        mirrorsOpponentSpeed: mirror,
      });
    // Mirrored against a 2 s zombie the Scallywag runs at 2²/0.8 = 5 s, not its own
    // 2 s — so that zombie lives long enough to land far more swings.
    const vsMirror = resolveRaid([foe()], [enemy(true)]);
    const vsPlain = resolveRaid([foe()], [enemy(false)]);
    expect(vsMirror.playerDamage).toBeGreaterThan(vsPlain.playerDamage);
  });
});

// Data-fidelity regression on the SHIPPED tables (public/assets/raids/*.json).
describe("Lawyers boss — his special stuns, it does not push back", () => {
  const boss = () =>
    buildEnemyUnits(
      { enemyKeys: [], bossKey: "CityStageActorBoss" },
      shippedStats as unknown as Parameters<typeof buildEnemyUnits>[1],
      shippedAttacks as unknown as Parameters<typeof buildEnemyUnits>[2]
    )[0];

  it("carries the 1-second stun and NO knockback", () => {
    expect(boss().stunMs).toBe(1000);
    expect(boss().knockBack).toBeFalsy();
  });

  it("is still the only enemy in the game that stuns", () => {
    const stunners = Object.entries(shippedAttacks as Record<string, { stun?: boolean }>)
      .filter(([, def]) => def.stun)
      .map(([name]) => name);
    expect(stunners).toEqual(["CorporateBossPunchSpecial"]);
  });
});

describe("buildPlayerUnits — a mutation penalty cannot invert a zombie", () => {
  // A mutation may subtract (mutations.ts MutationStats), and a big enough penalty on
  // a weak species drives the raw stat below zero. Every stat here arrives already
  // baked (makeOwned), so these units stand in for one carrying such a mutation.
  const crippled = (over: Partial<OwnedZombie>): OwnedZombie[] => [{
    id: "z1", key: "ZombieActorRegularTier1", name: "Husk", typeName: "Zombie",
    group: "Regular", className: "Green", classColor: "#000",
    mutation: 0, str: 2, dex: 2, con: 3, focus: 100, invasions: 0, col: 0, row: 0,
    ...over,
  }];

  it("never produces a negative stat", () => {
    const u = buildPlayerUnits(crippled({ str: -6, dex: -3, con: -4 }))[0];
    expect(u.str).toBe(0);
    expect(u.dex).toBe(0);
    expect(u.con).toBe(0);
  });

  it("leaves it alive and harmless rather than healing what it hits", () => {
    // The real hazard: a negative str would make every swing ADD hp to the enemy.
    const u = buildPlayerUnits(crippled({ str: -6 }))[0];
    expect(u.str).toBe(0);
    expect(u.maxHp).toBeGreaterThan(0); // still a body on the field
    expect(u.attackCooldownMs).toBeGreaterThan(0);
    expect(Number.isFinite(u.attackCooldownMs)).toBe(true);
  });

  it("floors a zeroed speed to a real, very slow attack clock", () => {
    // dex 0 must not divide by zero — deriveAttackIntervalMs floors it at 0.1.
    const u = buildPlayerUnits(crippled({ dex: -5 }))[0];
    const healthy = buildPlayerUnits(crippled({}))[0];
    expect(u.attackCooldownMs).toBeGreaterThan(healthy.attackCooldownMs);
    expect(u.attackCooldownMs).toBe(20_000); // 2s ÷ the 0.1 dex floor
  });

  it("does not change a zombie whose stats are all positive", () => {
    // The floor must be inert on every unit that exists today, so recorded raids
    // replay identically (no ruleset bump for shipping it).
    const u = buildPlayerUnits(crippled({}))[0];
    expect(u.str).toBeCloseTo(2);
    expect(u.dex).toBeCloseTo(2);
    expect(u.con).toBeCloseTo(3);
  });
});
