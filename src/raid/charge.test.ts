// The duel (raid 13): the pirate captain's charge and poise bar, the stand-down around him,
// the stagger, the ninja's dex tax, counter, stunning throws and smoke swap, and iron will.
// See docs/POST_45_PROGRESSION.md Part 2B and dualInvasion.ts.
//
// The numbers are placeholders and will move. What these pin is the SHAPE: that a girl proc
// is a contribution and not an answer, that a one-use move breaks a charge below iron will,
// that a broken charge staggers him, that the captain is fought ALONE, and that each rung
// adds the one rule it names.
import { describe, expect, it } from "vitest";
import { BattleSim } from "./BattleSim";
import {
  CHARGE_RAID_ID, chargeFor, COUNTER_STUN_MULT, COUNTER_STUN_TIER, DEX_TAX_HALF_AT,
  DEX_TAX_MIN_FRACTION, DEX_TAX_TIER, dexTaxedInterval, duelFor, IRON_WILL_POISE, IRON_WILL_TIER,
  MAX_TIER, MIDPOINT_WAVE_FRAC, NINJA_RETREAT_FRAC, poiseFor, POISE_THRESHOLD, SMOKE_SWAP_MS,
  SMOKE_SWAP_TIER, STAGGER_DAMAGE_MULT, STUNNING_THROWS_TIER, THROW_STUN_MS,
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
type Stun = { stunEnemy: (u: unknown, ms: number, src: string, by?: unknown) => void };

/** A fight against the captain (on the field from the start unless `wave` is given) and a
 *  perched ninja. Punchbags throughout, so a test can watch several slams. */
function duelFight(tier = 1, opts: { playerOver?: Partial<CombatUnit>; wave?: number } = {}) {
  const charge = chargeFor(CHARGE_RAID_ID, tier)!;
  const players = [unit({ id: "z0", group: "Regular", hp: 1e6, maxHp: 1e6, ...opts.playerOver })];
  const wave = Array.from({ length: opts.wave ?? 0 }, (_, i) => unit({
    id: `w${i}`, sourceKey: "NinjaStageActorMinion", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6,
  }));
  const enemies = [
    ...wave,
    unit({
      id: "captain", sourceKey: "PirateStageActorBoss", team: "enemy",
      str: 0, hp: 1e6, maxHp: 1e6, charge,
      ...(opts.wave ? { deployAtWaveFrac: MIDPOINT_WAVE_FRAC } : {}),
    }),
    unit({
      id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true,
      str: 0, hp: 1e6, maxHp: 1e6,
    }),
  ];
  const sim = new BattleSim(
    players, enemies, null, true, [], NO_ENRAGE_MS, null, null, false, false, false,
    undefined, null, null, { maxActive: 6, dripMs: 1000 }, null, null, duelFor(CHARGE_RAID_ID, tier)
  );
  return { sim, charge };
}

const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) sim.step(50); };
const byId = (sim: BattleSim, id: string) => sim.units.find((u) => u.id === id)!;
const kill = (sim: BattleSim, id: string) => {
  const e = byId(sim, id);
  e.alive = false; e.hp = 0; e.state = "dead";
};
function runUntilCharging(sim: BattleSim): void {
  for (let i = 0; i < 2_000 && byId(sim, "captain").chargeMs <= 0; i++) sim.step(50);
}

describe("the ladder", () => {
  it("belongs to this invasion alone", () => {
    for (const other of [1, 6, 9, 12, 14, 15]) {
      expect(chargeFor(other, 1)).toBeNull();
      expect(duelFor(other, 1)).toBeNull();
    }
  });

  it("adds each rung's rule at its own rung and not before", () => {
    const at = (t: number) => duelFor(CHARGE_RAID_ID, t)!;
    expect(at(DEX_TAX_TIER - 1).dexTax).toBe(false);
    expect(at(DEX_TAX_TIER).dexTax).toBe(true);
    expect(at(COUNTER_STUN_TIER - 1).counterStunMult).toBe(0);
    expect(at(COUNTER_STUN_TIER).counterStunMult).toBe(COUNTER_STUN_MULT);
    expect(at(STUNNING_THROWS_TIER - 1).throwStunMs).toBe(0);
    expect(at(STUNNING_THROWS_TIER).throwStunMs).toBe(THROW_STUN_MS);
    expect(at(SMOKE_SWAP_TIER - 1).swapMs).toBe(0);
    expect(at(SMOKE_SWAP_TIER).swapMs).toBe(SMOKE_SWAP_MS);
    expect(chargeFor(CHARGE_RAID_ID, IRON_WILL_TIER - 1)!.poiseThreshold).toBe(POISE_THRESHOLD);
    expect(chargeFor(CHARGE_RAID_ID, IRON_WILL_TIER)!.poiseThreshold).toBe(IRON_WILL_POISE);
    expect(chargeFor(CHARGE_RAID_ID, IRON_WILL_TIER)!.poiseDrainPerSec).toBeGreaterThan(0);
    // The wind-up itself does not move up the ladder — the rungs change the rules around him.
    expect(chargeFor(CHARGE_RAID_ID, 1)!.windupMs).toBe(chargeFor(CHARGE_RAID_ID, MAX_TIER)!.windupMs);
  });
});

describe("the captain", () => {
  it("walks on at the midpoint, behind a smoke bomb, and the wave stands down for him", () => {
    const { sim } = duelFight(1, { wave: 4 });
    run(sim, 12_000);
    expect(byId(sim, "captain").state, "not before the midpoint").toBe("queued");
    const z = byId(sim, "z0");
    const xBefore = z.x;
    const smokes = sim.smokeSeq;
    kill(sim, "w0");
    kill(sim, "w1");
    sim.step(50);
    expect(byId(sim, "captain").state).not.toBe("queued");
    expect(sim.smokeSeq, "the smoke went off").toBeGreaterThan(smokes);
    expect(z.x, "the army was pushed back").toBeLessThan(xBefore);
    run(sim, 3_000);
    for (const id of ["w2", "w3"]) {
      const w = byId(sim, id);
      if (w.state === "queued") continue;
      expect(w.x, `${id} stepped back behind the doorway`).toBeGreaterThan(byId(sim, "captain").x);
    }
    // …and it is the captain the army is fighting.
    const targets = (sim as unknown as { targetEnemy: (u: unknown) => { id: string } | null }).targetEnemy(z);
    expect(targets?.id).toBe("captain");
  });

  it("brings the wave back when he falls", () => {
    const { sim } = duelFight(1, { wave: 4 });
    run(sim, 6_000);
    kill(sim, "w0");
    kill(sim, "w1");
    run(sim, 3_000);
    kill(sim, "captain");
    const z = byId(sim, "z0");
    const target = (sim as unknown as { targetEnemy: (u: unknown) => { id: string } | null }).targetEnemy(z);
    expect(target?.id === "w2" || target?.id === "w3").toBe(true);
  });

  it("winds up once engaged and lands on the whole deployed line", () => {
    const { sim, charge } = duelFight();
    run(sim, 6_000);
    const zombie = byId(sim, "z0");
    expect(byId(sim, "captain").chargeMs, "winding up").toBeGreaterThan(0);
    const before = zombie.hp;
    run(sim, charge.windupMs + 500);
    expect(zombie.hp, "the slam lands").toBeLessThan(before);
    expect(byId(sim, "captain").chargeSlamSeq).toBeGreaterThan(0);
  });

  it("is a bar, not an off switch: one girl proc does not stop it", () => {
    const { sim, charge } = duelFight();
    runUntilCharging(sim);
    const captain = byId(sim, "captain");
    const slamsBefore = captain.chargeSlamSeq;
    (sim as unknown as Stun).stunEnemy(captain, 1000, "stun");
    expect(captain.poise).toBeCloseTo(poiseFor("stun"), 5);
    expect(captain.stunMs, "it went into the bar").toBe(0);
    run(sim, charge.windupMs + 500);
    expect(captain.chargeSlamSeq).toBeGreaterThan(slamsBefore);
  });

  it("breaks on a single one-use move below iron will, and STAGGERS", () => {
    const { sim } = duelFight(1);
    runUntilCharging(sim);
    const captain = byId(sim, "captain");
    (sim as unknown as Stun).stunEnemy(captain, 3000, "explode");
    expect(captain.chargeMs).toBe(0);
    expect(captain.chargeBreakSeq).toBe(1);
    expect(captain.staggerMs, "staggered").toBeGreaterThan(0);
    // Staggered, he takes more.
    const hp = captain.hp;
    (sim as unknown as { dealDamage: (u: unknown, d: number, p: boolean) => void }).dealDamage(captain, 100, true);
    expect(hp - captain.hp).toBe(Math.round(100 * STAGGER_DAMAGE_MULT));
  });

  it("takes two Smashes, and remembers the first", () => {
    const { sim } = duelFight();
    runUntilCharging(sim);
    const captain = byId(sim, "captain");
    const stun = (src: string) => (sim as unknown as Stun).stunEnemy(captain, 1000, src);
    stun("bashV2");
    expect(captain.poise).toBeCloseTo(0.5, 5);
    expect(captain.chargeMs).toBeGreaterThan(0);
    stun("bashV2");
    expect(captain.chargeMs).toBe(0);
  });

  it("needs several bars under iron will, and the bar drains", () => {
    const { sim } = duelFight(IRON_WILL_TIER);
    runUntilCharging(sim);
    const captain = byId(sim, "captain");
    (sim as unknown as Stun).stunEnemy(captain, 3000, "explode");
    expect(captain.chargeMs, "one fuse is no longer enough").toBeGreaterThan(0);
    const poise = captain.poise;
    run(sim, 1_000);
    expect(captain.poise, "and it bleeds away").toBeLessThan(poise);
    (sim as unknown as Stun).stunEnemy(captain, 3000, "explode");
    (sim as unknown as Stun).stunEnemy(captain, 3000, "explode");
    (sim as unknown as Stun).stunEnemy(captain, 3000, "explode");
    expect(captain.chargeMs, "stuns landed together break it").toBe(0);
  });
});

describe("the ninja", () => {
  it("counters a stun onto the zombie that threw it, from t5", () => {
    for (const [tier, reflects] of [[COUNTER_STUN_TIER - 1, false], [COUNTER_STUN_TIER, true]] as const) {
      const { sim } = duelFight(tier);
      run(sim, 3_000);
      const boss = byId(sim, "boss");
      const z = byId(sim, "z0");
      z.stunMs = 0;
      (sim as unknown as Stun).stunEnemy(boss, 1000, "bashV2", z);
      expect(z.stunMs > 0, `t${tier}`).toBe(reflects);
      if (reflects) expect(z.stunMs).toBe(1000 * COUNTER_STUN_MULT);
      expect(boss.stunMs > 0, `t${tier}: the ninja himself`).toBe(!reflects);
    }
  });

  it("swaps places with the captain every eight seconds from t9", () => {
    const { sim } = duelFight(SMOKE_SWAP_TIER);
    run(sim, 3_000);
    const boss = byId(sim, "boss");
    const captain = byId(sim, "captain");
    expect(boss.state).toBe("structure");
    run(sim, SMOKE_SWAP_MS + 100);
    expect(boss.state, "the ninja came down").not.toBe("structure");
    expect(captain.state, "the captain went up").toBe("structure");
    run(sim, SMOKE_SWAP_MS);
    expect(boss.state).toBe("structure");
    expect(captain.state).not.toBe("structure");
  });

  it("never swaps below t9", () => {
    const { sim } = duelFight(SMOKE_SWAP_TIER - 1);
    run(sim, 3 * SMOKE_SWAP_MS);
    expect(byId(sim, "boss").state).toBe("structure");
  });

  it("retreats at low health, and cannot be taken below it while the rest stand", () => {
    const { sim } = duelFight(SMOKE_SWAP_TIER);
    run(sim, 3_000 + SMOKE_SWAP_MS + 100);
    const boss = byId(sim, "boss");
    expect(boss.state).not.toBe("structure");
    (sim as unknown as { dealDamage: (u: unknown, d: number, p: boolean) => void }).dealDamage(boss, 1e7, true);
    expect(boss.alive, "not killed").toBe(true);
    expect(boss.hp).toBeCloseTo(boss.maxHp * NINJA_RETREAT_FRAC, -1);
    expect(boss.state, "back up top").toBe("structure");
    run(sim, 2 * SMOKE_SWAP_MS);
    expect(boss.state, "and he stays there").toBe("structure");
  });

  it("stuns with his throws from t7", () => {
    const throwCfg = { intervalMs: 300, options: [{ damage: 1, weight: 1, sprite: "shuriken.png", spriteSize: 32 }] };
    for (const [tier, stuns] of [[STUNNING_THROWS_TIER - 1, false], [STUNNING_THROWS_TIER, true]] as const) {
      const players = [unit({ id: "z0", group: "Regular", hp: 1e6, maxHp: 1e6 })];
      const enemies = [
        unit({ id: "w0", sourceKey: "NinjaStageActorMinion", team: "enemy", str: 0, hp: 1e6, maxHp: 1e6 }),
        unit({ id: "boss", sourceKey: "NinjaStageActorBoss", team: "enemy", isBoss: true, str: 0, hp: 1e6, maxHp: 1e6 }),
      ];
      const sim = new BattleSim(
        players, enemies, throwCfg, true, [], NO_ENRAGE_MS, null, null, false, false, false,
        undefined, null, null, undefined, null, null, duelFor(CHARGE_RAID_ID, tier)
      );
      let stunned = false;
      for (let t = 0; t < 15_000 && !stunned; t += 50) {
        sim.step(50);
        const z = byId(sim, "z0");
        if (z.stunMs > 0 && z.stunMs <= THROW_STUN_MS) stunned = true;
      }
      expect(stunned, `t${tier}`).toBe(stuns);
    }
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
    const quick = duelFight(DEX_TAX_TIER, { playerOver: { attackCooldownMs: 250 } }).sim;
    const slow = duelFight(DEX_TAX_TIER, { playerOver: { attackCooldownMs: 1_540 } }).sim;
    run(quick, 6_000);
    run(slow, 6_000);
    const dexOf = (sim: BattleSim) => (sim as unknown as { deployedDex: () => number }).deployedDex();
    expect(dexOf(quick)).toBeGreaterThan(dexOf(slow));
  });
});
