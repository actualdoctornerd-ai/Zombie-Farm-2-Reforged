// The Video Games crew's moves (owner design, 2026-11-12; ruleset 92): the dragon's gout, the
// knight's shield slam and Zedzox's magic, driven directly on hand-placed units.
import { describe, expect, it } from "vitest";
import enemyStats from "../../public/assets/raids/enemy_stats.json";
import attacks from "../../public/assets/raids/attacks.json";
import raids from "../../public/assets/raids/raids.json";
import { BattleSim, ENEMY_HOLD_X, type SimUnit } from "./BattleSim";
import { composeFight } from "./composeFight";
import { eliteProfile } from "./eliteInvasion";
import { fightStage } from "./RaidCatalog";
import type { CombatUnit, RaidDef } from "./types";
import {
  GOUT_BURN_MS, GOUT_BURN_PCT, GOUT_BURST_PCT, GOUT_COOLDOWN_MS, GOUT_WINDUP_MS, MAGIC_BEAM_GARDEN_SHARE,
  MAGIC_CAST_MS, MAGIC_FIREBALL_GARDEN_SHARE,
  SHIELD_SLAM_STUN_MS, VG_BOSS_KEY, VG_DRAGON_KEY, VG_KNIGHT_KEY, VG_STAGE_GARDEN_HP,
  goutFor, raidMagicFor, shieldSlamFor,
} from "./videoGameMoves";

function unit(over: Partial<CombatUnit> & Pick<CombatUnit, "id" | "sourceKey" | "team">): CombatUnit {
  return {
    name: over.id, str: 5, dex: 5, con: 30, focus: 100, hp: 3000, maxHp: 3000,
    attackCooldownMs: 1000, attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [], ...over,
  };
}

/** Three zombies at the front and one far back at the Gardens' station. */
function line(sim: BattleSim, frontX: number): SimUnit[] {
  const ps = ["a", "b", "c", "garden"].map((id) => sim.units.find((u) => u.id === id)!);
  [frontX - 30, frontX - 70, frontX - 110, frontX - 900].forEach((x, i) => { ps[i].x = x; ps[i].state = "fight"; });
  return ps;
}
const army = () => ["a", "b", "c", "garden"].map((id) => unit({ id, sourceKey: "ZombieActorRegularTier1", team: "player" }));
const step = (sim: BattleSim, name: string, ...args: unknown[]) => (sim as any)[name](...args);

describe("the dragon's gout", () => {
  const setup = () => {
    const dragon = unit({ id: "dragon", sourceKey: VG_DRAGON_KEY, team: "enemy", hp: 1e6, maxHp: 1e6, charge: goutFor() });
    const sim = new BattleSim(army(), [dragon], null, true);
    const e = sim.units.find((u) => u.id === "dragon")!;
    e.x = ENEMY_HOLD_X; e.state = "fight";
    return { sim, e, ps: line(sim, e.x) };
  };

  it("takes 10% of each front zombie's own hit points at once and burns 15% more over 6 s", () => {
    const { sim, e, ps } = setup();
    step(sim, "stepSlamCharge", e, GOUT_WINDUP_MS);
    expect(e.chargeSlamSeq).toBe(1);
    for (const p of ps.slice(0, 3)) {
      expect(p.hp).toBeCloseTo(p.maxHp * (1 - GOUT_BURST_PCT), 0);
      expect(p.dotMs).toBe(GOUT_BURN_MS);
    }
    // The Gardens' station is out of reach.
    expect(ps[3].hp).toBe(ps[3].maxHp);
    expect(ps[3].dotMs).toBe(0);
    for (let t = 0; t < GOUT_BURN_MS; t += 50) step(sim, "stepDot", ps[0], 50);
    expect(ps[0].hp).toBeCloseTo(ps[0].maxHp * (1 - GOUT_BURST_PCT - GOUT_BURN_PCT), 0);
    expect(ps[0].dotMs).toBe(0);
  });

  it("does not swing while it winds up, nor through the 2 s cool-down after", () => {
    const { sim, e } = setup();
    step(sim, "stepSlamCharge", e, GOUT_WINDUP_MS / 2);
    expect(e.chargeMs).toBeGreaterThan(0);
    step(sim, "stepSlamCharge", e, GOUT_WINDUP_MS / 2);
    expect(e.chargeLockMs).toBe(GOUT_COOLDOWN_MS);
    step(sim, "stepSlamCharge", e, GOUT_COOLDOWN_MS);
    expect(e.chargeLockMs).toBe(0);
  });

  it("is cancelled outright by a stun during the wind-up, which then lands", () => {
    const { sim, e, ps } = setup();
    step(sim, "stepSlamCharge", e, GOUT_WINDUP_MS / 2);
    step(sim, "stunEnemy", e, 1000, "stun");
    expect(e.chargeMs).toBe(0);
    expect(e.stunMs).toBeGreaterThan(0);
    expect(e.chargeBreakSeq).toBe(1);
    expect(ps[0].hp).toBe(ps[0].maxHp);
    // ...and it is not a "charger" the duel logic banks stuns for.
    expect(sim.hasCharge()).toBe(false);
  });
});

describe("the knight's shield slam", () => {
  it("stuns everyone in the front area for 2 s and hits them for twice its swing", () => {
    const base = unit({ id: "knight", sourceKey: VG_KNIGHT_KEY, team: "enemy", hp: 1e6, maxHp: 1e6, str: 15 });
    const knight = { ...base, charge: shieldSlamFor(base) };
    const sim = new BattleSim(army(), [knight], null, true);
    const e = sim.units.find((u) => u.id === "knight")!;
    e.x = ENEMY_HOLD_X; e.state = "fight";
    const ps = line(sim, e.x);
    step(sim, "stepSlamCharge", e, knight.charge!.windupMs);
    for (const p of ps.slice(0, 3)) {
      expect(p.stunMs).toBe(SHIELD_SLAM_STUN_MS);
      expect(p.maxHp - p.hp).toBeCloseTo(knight.charge!.damage, 0);
    }
    expect(ps[3].stunMs).toBe(0);
  });
});

describe("Zedzox's magic", () => {
  const hash = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
  /** The first cast count whose pick is the beam (1) or the fireball (2). */
  const countFor = (kind: 1 | 2) => { for (let n = 0; ; n++) if ((hash(n * 61 + 7) < 0.5 ? 1 : 2) === kind) return n; };
  const setup = (kind: 1 | 2) => {
    const boss = unit({ id: "zedzox", sourceKey: VG_BOSS_KEY, team: "enemy", isBoss: true, hp: 1e6, maxHp: 1e6, magic: raidMagicFor() });
    const sim = new BattleSim(army(), [boss], null, true);
    const b = sim.units.find((u) => u.id === "zedzox")!;
    b.state = "structure";
    b.magicCount = countFor(kind);
    return { sim, b, ps: line(sim, 300) };
  };
  const run = (sim: BattleSim, ms: number) => { for (let t = 0; t < ms; t += 50) step(sim, "stepBossMagic", 50); };

  it("charges for 3 s, then sweeps a beam from the front all the way back to the Gardens", () => {
    const { sim, b, ps } = setup(1);
    run(sim, MAGIC_CAST_MS - 100);
    expect(b.chargeFrac).toBeGreaterThan(0.9);
    expect(ps.every((p) => p.hp === p.maxHp)).toBe(true);
    run(sim, 2_000);
    const dmg = VG_STAGE_GARDEN_HP * MAGIC_BEAM_GARDEN_SHARE;
    for (const p of ps) expect(p.maxHp - p.hp).toBeCloseTo(dmg, 0); // the Garden too, exactly once
  });

  it("or lobs a fireball onto the front group and sends it flying", () => {
    const { sim, ps } = setup(2);
    run(sim, MAGIC_CAST_MS + 100);
    for (const p of ps.slice(0, 3)) {
      expect(p.maxHp - p.hp).toBeCloseTo(VG_STAGE_GARDEN_HP * MAGIC_FIREBALL_GARDEN_SHARE, 0);
    }
    expect(ps[3].hp).toBe(ps[3].maxHp); // the Gardens are far behind the front group
  });

  it("stops casting once he comes down to fight", () => {
    const { sim, b, ps } = setup(1);
    b.state = "fight";
    run(sim, 10_000);
    expect(ps.every((p) => p.hp === p.maxHp)).toBe(true);
    expect(b.magicSeq).toBe(0);
  });
});

describe("where the moves are attached", () => {
  const compose = (raidId: number, elite: boolean, tier = 0) => {
    const raid = (raids as RaidDef[]).find((r) => r.id === raidId)!;
    const stage = fightStage(raid, raid.recommendedLevel)!;
    return composeFight({ enemyStats: enemyStats as never, raidAttacks: attacks as never }, raid, stage, {
      playerLevel: raid.recommendedLevel, tier, elite: eliteProfile(raidId, elite), priorWins: 5, waveSeed: "seed", hazards: false,
    }).enemyUnits;
  };

  it("arms every knight and dragon, and prices Zedzox's magic off a base Nightshade in both modes", () => {
    const ord = compose(9, false), eli = compose(9, true);
    for (const u of ord) {
      if (u.sourceKey === VG_DRAGON_KEY) expect(u.charge?.effect).toBe("gout");
      if (u.sourceKey === VG_KNIGHT_KEY) expect(u.charge?.effect).toBe("shieldSlam");
    }
    expect(ord.find((u) => u.isBoss)!.magic!.beamDamage).toBe(Math.round(VG_STAGE_GARDEN_HP * MAGIC_BEAM_GARDEN_SHARE));
    expect(eli.find((u) => u.isBoss)!.magic!.beamDamage).toBe(Math.round(VG_STAGE_GARDEN_HP * MAGIC_BEAM_GARDEN_SHARE));
    // The beam stuns nobody: a whole-army stun is what made the first cut too hard.
    expect(ord.find((u) => u.isBoss)!.magic!.beamStunMs).toBe(0);
  });
});
