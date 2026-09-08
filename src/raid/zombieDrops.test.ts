import { describe, expect, it } from "vitest";
import {
  DIVER_ZOMBIE_KEY,
  dropsOldMcZombie,
  EVENT_ZOMBIE_DROP_RATE,
  FOREST_ZOMBIE_KEY,
  OLD_MC_ZOMBIE_DROP_RATE,
  OLD_MC_ZOMBIE_KEY,
  hasRaidZombieDrop,
  nextRaidZombieDryWins,
  RAID_ZOMBIE_PITY_WINS,
  raidZombieDropRate,
  rollRaidZombieDrop,
  rollRaidZombieDropWithPity,
  TEDDY_ZOMBIE_KEY,
  ZOMBIE_LUCK_DICE_CAP,
  RAID_ZOMBIE_DROPS,
  RAID_ELITE_ZOMBIE_DROPS,
  RAID_ZOMBIE_SOURCES,
  raidZombieDropFor,
  raidZombieDryKey,
  STORY_ZOMBIE_DROP_RATES,
  ELITE_PRIZE_RATE_MULTIPLIER,
  DEPUTY_ZOMBIE_KEY,
  SHERIFF_ZOMBIE_KEY,
  MER_ZOMBIE_KEY,
  POSEIDON_ZOMBIE_KEY,
  NINJOMBIE_KEY,
  MASTER_NINJOMBIE_KEY,
  ZOMBIE_BOT_KEY,
  OMEGA_ZOMBIE_BOT_KEY,
  ZASTRONAUT_KEY,
  ZOSMONAUT_KEY,
  ZOMBOZO_KEY,
  CIRCUS_RAID_ID,
  ELITE_PRIZE_RATE_CAP,
  isRareInvasionZombieName,
} from "./zombieDrops";
import { ELITE_BRAIN_LUCK } from "./eliteInvasion";
import raidRows from "../../public/assets/raids/raids.json";

describe("rare raid zombie drops", () => {
  it("keeps Old McZombie on its existing exact 1% threshold", () => {
    expect(OLD_MC_ZOMBIE_KEY).toBe("ZombieActorOldMcZombie");
    expect(OLD_MC_ZOMBIE_DROP_RATE).toBe(0.01);
    expect(dropsOldMcZombie(1, true, 0)).toBe(true);
    expect(dropsOldMcZombie(1, true, 0.009999999)).toBe(true);
    expect(dropsOldMcZombie(1, true, 0.01)).toBe(false);
  });

  it.each([
    [7, DIVER_ZOMBIE_KEY],
    [10, FOREST_ZOMBIE_KEY],
    [11, TEDDY_ZOMBIE_KEY],
  ])("drops the configured event zombie from raid %i at exactly 1%%", (raidId, key) => {
    expect(EVENT_ZOMBIE_DROP_RATE).toBe(0.01);
    expect(rollRaidZombieDrop(raidId, true, 0)?.key).toBe(key);
    expect(rollRaidZombieDrop(raidId, true, 0.009999999)?.key).toBe(key);
    expect(rollRaidZombieDrop(raidId, true, 0.01)).toBeNull();
  });

  it("never drops from a loss, an unrelated invasion, or an invalid roll", () => {
    expect(rollRaidZombieDrop(7, false, 0)).toBeNull();
    expect(rollRaidZombieDrop(9, true, 0)).toBeNull(); // the Video Games have no rare zombie
    expect(rollRaidZombieDrop(10, true, -0.1)).toBeNull();
    expect(rollRaidZombieDrop(11, true, Number.NaN)).toBeNull();
  });
});

describe("Golden Dice raise the rare-zombie rate", () => {
  it("adds one base rate per die", () => {
    expect(raidZombieDropRate(1, 0)).toBeCloseTo(0.01, 10); // no dice: unchanged
    expect(raidZombieDropRate(1, 1)).toBeCloseTo(0.02, 10);
    expect(raidZombieDropRate(1, 2)).toBeCloseTo(0.03, 10);
    expect(raidZombieDropRate(1, 5)).toBeCloseTo(0.06, 10); // the five a full loot table allows
    expect(raidZombieDropRate(7, 5)).toBeCloseTo(0.06, 10); // event zombies: the same 1% base
    expect(raidZombieDropRate(6, 5)).toBeCloseTo(0.12, 10); // Zastronaut: 2% base
  });

  it("widens the winning roll window accordingly", () => {
    // 0.015 misses at one die's 2%... but not at zero dice's 1%.
    expect(rollRaidZombieDrop(1, true, 0.015, 0)).toBeNull();
    expect(rollRaidZombieDrop(1, true, 0.015, 1)?.key).toBe(OLD_MC_ZOMBIE_KEY);
    expect(rollRaidZombieDrop(1, true, 0.055, 5)?.key).toBe(OLD_MC_ZOMBIE_KEY);
    expect(rollRaidZombieDrop(1, true, 0.061, 5)).toBeNull();
  });

  it("still pays nothing on a loss or for a raid with no rare zombie", () => {
    expect(rollRaidZombieDrop(1, false, 0.0, 10)).toBeNull();
    expect(rollRaidZombieDrop(9, true, 0.0, 10)).toBeNull();
    expect(raidZombieDropRate(9, 10)).toBe(0);
  });

  it("clamps a garbage or oversized dice count instead of guaranteeing the drop", () => {
    const capped = raidZombieDropRate(1, ZOMBIE_LUCK_DICE_CAP);
    expect(capped).toBeCloseTo(0.11, 10);
    expect(raidZombieDropRate(1, 10_000)).toBe(capped);
    expect(raidZombieDropRate(1, -5)).toBeCloseTo(0.01, 10);
    expect(raidZombieDropRate(1, Number.NaN)).toBeCloseTo(0.01, 10);
    expect(capped).toBeLessThan(1);
  });
});

describe("rare zombie pity floor", () => {
  const MISS = 1; // a roll above every drop rate

  it("only the ten raids with a rare zombie have a streak that means anything", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 10, 11].every(hasRaidZombieDrop)).toBe(true);
    // The Video Games pay no rare zombie.
    expect(hasRaidZombieDrop(9)).toBe(false);
  });

  it("withholds the zombie until the raid's dry wins reach the threshold", () => {
    for (let wins = 0; wins < RAID_ZOMBIE_PITY_WINS; wins++) {
      expect(rollRaidZombieDropWithPity(1, true, MISS, wins)).toBeNull();
    }
    expect(rollRaidZombieDropWithPity(1, true, MISS, RAID_ZOMBIE_PITY_WINS)?.key).toBe(OLD_MC_ZOMBIE_KEY);
  });

  it("guarantees each raid's own zombie", () => {
    expect(rollRaidZombieDropWithPity(7, true, MISS, RAID_ZOMBIE_PITY_WINS)?.key).toBe(DIVER_ZOMBIE_KEY);
    expect(rollRaidZombieDropWithPity(10, true, MISS, RAID_ZOMBIE_PITY_WINS)?.key).toBe(FOREST_ZOMBIE_KEY);
    expect(rollRaidZombieDropWithPity(11, true, MISS, RAID_ZOMBIE_PITY_WINS)?.key).toBe(TEDDY_ZOMBIE_KEY);
  });

  it("never conjures a zombie for a raid that has none, or for a loss", () => {
    expect(rollRaidZombieDropWithPity(9, true, MISS, 10_000)).toBeNull();
    expect(rollRaidZombieDropWithPity(1, false, MISS, RAID_ZOMBIE_PITY_WINS)).toBeNull();
  });

  it("does not override a natural drop", () => {
    expect(rollRaidZombieDropWithPity(1, true, 0, 0)?.key).toBe(OLD_MC_ZOMBIE_KEY);
  });

  it("passes dice through to the natural roll before falling back to the floor", () => {
    // Inside the diced window: a real roll, well short of the guarantee.
    expect(rollRaidZombieDropWithPity(1, true, 0.015, 0, 1)?.key).toBe(OLD_MC_ZOMBIE_KEY);
    expect(rollRaidZombieDropWithPity(1, true, 0.015, 0, 0)).toBeNull();
    // Dice don't disturb the guarantee either way.
    expect(rollRaidZombieDropWithPity(1, true, MISS, RAID_ZOMBIE_PITY_WINS, 5)?.key).toBe(OLD_MC_ZOMBIE_KEY);
  });

  it("counts dry wins up and resets whenever the zombie lands", () => {
    let dry = 0;
    for (let i = 0; i < RAID_ZOMBIE_PITY_WINS; i++) dry = nextRaidZombieDryWins(dry, false);
    expect(dry).toBe(RAID_ZOMBIE_PITY_WINS);
    const guaranteed = rollRaidZombieDropWithPity(1, true, MISS, dry);
    dry = nextRaidZombieDryWins(dry, !!guaranteed);
    expect(dry).toBe(0);
    // Collecting one starts the next streak over rather than handing out a second.
    expect(rollRaidZombieDropWithPity(1, true, MISS, dry)).toBeNull();
  });

  it("clamps the stored count and shrugs off garbage", () => {
    expect(nextRaidZombieDryWins(RAID_ZOMBIE_PITY_WINS, false)).toBe(RAID_ZOMBIE_PITY_WINS);
    expect(nextRaidZombieDryWins(9_999, false)).toBe(RAID_ZOMBIE_PITY_WINS);
    expect(nextRaidZombieDryWins(-7, false)).toBe(1);
    expect(nextRaidZombieDryWins(42, true)).toBe(0);
  });

  it("takes at most threshold+1 wins of one raid to see its zombie, however unlucky", () => {
    let dry = 0;
    let received = 0;
    for (let win = 1; win <= RAID_ZOMBIE_PITY_WINS + 1; win++) {
      const drop = rollRaidZombieDropWithPity(1, true, MISS, dry);
      if (drop) received = win;
      dry = nextRaidZombieDryWins(dry, !!drop);
    }
    expect(received).toBe(RAID_ZOMBIE_PITY_WINS + 1);
  });
});

describe("a Brain Ticket widens the rare-zombie roll too", () => {
  it("multiplies the rate on top of any dice", () => {
    expect(raidZombieDropRate(1, 0, ELITE_BRAIN_LUCK)).toBeCloseTo(0.04, 10);
    // Dice first (one die doubles the base), then the elite multiplier.
    expect(raidZombieDropRate(1, 1, ELITE_BRAIN_LUCK)).toBeCloseTo(0.08, 10);
    expect(raidZombieDropRate(7, 0, ELITE_BRAIN_LUCK)).toBeCloseTo(0.04, 10);
  });

  it("turns a roll that would have missed into a drop", () => {
    expect(rollRaidZombieDrop(1, true, 0.03, 0)).toBeNull();
    expect(rollRaidZombieDrop(1, true, 0.03, 0, ELITE_BRAIN_LUCK)?.key).toBe(OLD_MC_ZOMBIE_KEY);
  });

  it("carries through the per-raid pity roll", () => {
    expect(rollRaidZombieDropWithPity(1, true, 0.03, 0, 0, ELITE_BRAIN_LUCK)?.key)
      .toBe(OLD_MC_ZOMBIE_KEY);
  });

  it("still pays nothing on a raid with no rare zombie", () => {
    expect(raidZombieDropRate(9, 5, ELITE_BRAIN_LUCK)).toBe(0);
    expect(rollRaidZombieDrop(9, true, 0, 5, ELITE_BRAIN_LUCK)).toBeNull();
  });

  it("cannot exceed certainty", () => {
    expect(raidZombieDropRate(1, ZOMBIE_LUCK_DICE_CAP, 1000)).toBe(1);
  });
});

describe("the story invasions' prize pairs", () => {
  const MISS = 1;
  // raid, base zombie, promoted zombie, the raid's rung of the rate ladder (in percent)
  const PAIRS: Array<[number, string, string, number]> = [
    [2, DEPUTY_ZOMBIE_KEY, SHERIFF_ZOMBIE_KEY, 1.2],
    [3, MER_ZOMBIE_KEY, POSEIDON_ZOMBIE_KEY, 1.4],
    [4, NINJOMBIE_KEY, MASTER_NINJOMBIE_KEY, 1.6],
    [5, ZOMBIE_BOT_KEY, OMEGA_ZOMBIE_BOT_KEY, 1.8],
  ];

  it("pins the ladder: a fifth of a percent per story invasion to 2% on the Aliens, promoted prizes 3-4.5%", () => {
    const ladder: Record<number, number> = { 8: 0.01, 2: 0.012, 3: 0.014, 4: 0.016, 5: 0.018, 6: 0.02 };
    expect(Object.keys(STORY_ZOMBIE_DROP_RATES).map(Number).sort()).toEqual([2, 3, 4, 5, 6, 8]);
    for (const [id, rate] of Object.entries(ladder)) {
      expect(STORY_ZOMBIE_DROP_RATES[Number(id)], `raid ${id}`).toBeCloseTo(rate, 12);
    }
    expect(ELITE_PRIZE_RATE_MULTIPLIER).toBe(2.5);
    expect(RAID_ELITE_ZOMBIE_DROPS[2].rate).toBeCloseTo(0.03, 12);
    expect(RAID_ELITE_ZOMBIE_DROPS[3].rate).toBeCloseTo(0.035, 12);
    expect(RAID_ELITE_ZOMBIE_DROPS[4].rate).toBeCloseTo(0.04, 12);
    expect(RAID_ELITE_ZOMBIE_DROPS[5].rate).toBeCloseTo(0.045, 12);
    // The Aliens' 2.5 x 2% = 5% would leave the band; the cap holds it at the top.
    expect(ELITE_PRIZE_RATE_CAP).toBeCloseTo(0.045, 12);
    expect(RAID_ELITE_ZOMBIE_DROPS[6].rate).toBeCloseTo(0.045, 12);
  });

  it.each(PAIRS)("raid %i pays its base zombie on an ordinary win at its rung", (raidId, base, _p, rung) => {
    const rate = rung / 100;
    expect(raidZombieDropFor(raidId)?.key).toBe(base);
    expect(raidZombieDropRate(raidId)).toBeCloseTo(rate, 10);
    expect(rollRaidZombieDrop(raidId, true, rate - 1e-6)?.key).toBe(base);
    expect(rollRaidZombieDrop(raidId, true, rate + 1e-6)).toBeNull();
  });

  it.each(PAIRS)("raid %i pays its PROMOTED zombie instead on an elite win, at 2.5x", (raidId, base, promoted, rung) => {
    const rate = 2.5 * rung / 100;
    expect(raidZombieDropFor(raidId, true)?.key).toBe(promoted);
    // 2.5x the ordinary rate — and NOT the 4x elite luck on top of that.
    expect(raidZombieDropRate(raidId, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(rate, 10);
    expect(rollRaidZombieDrop(raidId, true, rate - 1e-6, 0, ELITE_BRAIN_LUCK, true)?.key).toBe(promoted);
    expect(rollRaidZombieDrop(raidId, true, rate + 1e-6, 0, ELITE_BRAIN_LUCK, true)).toBeNull();
    // The base zombie never comes out of an elite fight, however lucky the roll.
    expect(rollRaidZombieDrop(raidId, true, 0, 5, ELITE_BRAIN_LUCK, true)?.key).not.toBe(base);
  });

  it("still lets Golden Dice widen the promoted prize's roll", () => {
    expect(raidZombieDropRate(2, 1, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.06, 10);
    expect(raidZombieDropRate(2, 5, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.18, 10);
  });

  it("asking for the elite prize of a single-prize raid is the ordinary prize at elite luck", () => {
    expect(raidZombieDropFor(1, true)?.key).toBe(OLD_MC_ZOMBIE_KEY);
    expect(raidZombieDropRate(1, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.04, 10);
    expect(raidZombieDropFor(9, true)).toBeNull();
  });

  it("gives the Aliens the Zastronaut ordinarily and the Zosmonaut on a ticket, at the cap", () => {
    expect(RAID_ZOMBIE_DROPS[6].key).toBe(ZASTRONAUT_KEY);
    expect(RAID_ELITE_ZOMBIE_DROPS[6].key).toBe(ZOSMONAUT_KEY);
    expect(raidZombieDropRate(6)).toBeCloseTo(0.02, 10);
    // 4.5%, not 2.5 x 2% = 5% and not 4 x 2% = 8%: the promoted prize takes neither the
    // uncapped multiplier nor the single-prize elite luck.
    expect(raidZombieDropRate(6, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.045, 10);
    expect(rollRaidZombieDrop(6, true, 0.044, 0, ELITE_BRAIN_LUCK, true)?.key).toBe(ZOSMONAUT_KEY);
    expect(rollRaidZombieDrop(6, true, 0.046, 0, ELITE_BRAIN_LUCK, true)).toBeNull();
    expect(rollRaidZombieDrop(6, true, 0, 5, ELITE_BRAIN_LUCK, true)?.key).not.toBe(ZASTRONAUT_KEY);
  });

  it("gives the Circus the Zombozo as a single prize on the 1% floor, 4x on a ticket", () => {
    expect(RAID_ZOMBIE_DROPS[CIRCUS_RAID_ID].key).toBe(ZOMBOZO_KEY);
    expect(RAID_ELITE_ZOMBIE_DROPS[CIRCUS_RAID_ID]).toBeUndefined();
    expect(raidZombieDropRate(CIRCUS_RAID_ID)).toBeCloseTo(0.01, 10);
    expect(raidZombieDropRate(CIRCUS_RAID_ID, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.04, 10);
    expect(rollRaidZombieDrop(CIRCUS_RAID_ID, true, 0.009)?.key).toBe(ZOMBOZO_KEY);
    expect(rollRaidZombieDrop(CIRCUS_RAID_ID, true, 0.01)).toBeNull();
    expect(raidZombieDryKey(CIRCUS_RAID_ID, true)).toBe("8");
  });

  it("keeps a separate pity streak for each prize of a paired raid, and one for the rest", () => {
    expect(raidZombieDryKey(2, false)).toBe("2");
    expect(raidZombieDryKey(2, true)).toBe("2:elite");
    expect(raidZombieDryKey(1, true)).toBe("1"); // Old McZombie: one prize, one streak
    expect(raidZombieDryKey(6, true)).toBe("6:elite"); // the Aliens pay a pair too
    // A hundred dry ORDINARY wins guarantee the Deputy; the elite streak starts from zero.
    expect(rollRaidZombieDropWithPity(2, true, MISS, RAID_ZOMBIE_PITY_WINS)?.key).toBe(DEPUTY_ZOMBIE_KEY);
    expect(rollRaidZombieDropWithPity(2, true, MISS, RAID_ZOMBIE_PITY_WINS, 0, ELITE_BRAIN_LUCK, true)?.key)
      .toBe(SHERIFF_ZOMBIE_KEY);
    expect(rollRaidZombieDropWithPity(2, true, MISS, 0, 0, ELITE_BRAIN_LUCK, true)).toBeNull();
  });

  it("lists every prize, ordinary and elite, as a source with its raid", () => {
    const byKey = new Map(RAID_ZOMBIE_SOURCES.map((s) => [s.drop.key, s]));
    expect(byKey.get(DEPUTY_ZOMBIE_KEY)).toMatchObject({ raidId: 2, elite: false });
    expect(byKey.get(SHERIFF_ZOMBIE_KEY)).toMatchObject({ raidId: 2, elite: true });
    expect(byKey.get(ZASTRONAUT_KEY)).toMatchObject({ raidId: 6, elite: false });
    expect(byKey.get(ZOSMONAUT_KEY)).toMatchObject({ raidId: 6, elite: true });
    expect(byKey.get(OLD_MC_ZOMBIE_KEY)).toMatchObject({ raidId: 1, elite: false });
    expect(byKey.get(ZOMBOZO_KEY)).toMatchObject({ raidId: CIRCUS_RAID_ID, elite: false });
    expect(byKey.size).toBe(15);
    // Every source key is a distinct zombie: no prize is reachable from two places.
    expect(new Set(RAID_ZOMBIE_SOURCES.map((s) => s.drop.key)).size).toBe(RAID_ZOMBIE_SOURCES.length);
  });

  it("counts the promoted prizes as rare invasion zombies for the quest alias", () => {
    expect(isRareInvasionZombieName("Sheriff Zombie")).toBe(true);
    expect(isRareInvasionZombieName("Deputy Zombie")).toBe(true);
    expect(isRareInvasionZombieName("Zastronaut")).toBe(true);
    expect(isRareInvasionZombieName("Zosmonaut")).toBe(true);
    expect(isRareInvasionZombieName("Zombozo")).toBe(true);
    expect(isRareInvasionZombieName("Bombie")).toBe(false);
  });
});

describe("the rare-zombie rate ladder", () => {
  const recLevel = new Map((raidRows as { id: number; recommendedLevel: number }[])
    .map((raid) => [raid.id, raid.recommendedLevel]));
  const ordinary = Object.entries(RAID_ZOMBIE_DROPS)
    .map(([id, drop]) => ({ raidId: Number(id), rec: recLevel.get(Number(id))!, rate: drop.rate }))
    .sort((a, b) => a.rec - b.rec);

  it("keeps every ordinary prize between 1% and the Aliens' 2%", () => {
    for (const { raidId, rate } of ordinary) {
      expect(rate, `raid ${raidId}`).toBeGreaterThanOrEqual(0.01 - 1e-12);
      expect(rate, `raid ${raidId}`).toBeLessThanOrEqual(0.02 + 1e-12);
    }
    expect(RAID_ZOMBIE_DROPS[6].rate).toBeCloseTo(0.02, 12); // the top of the ladder IS the Aliens
  });

  it("keeps every promoted prize inside 3-4.5%", () => {
    for (const [id, drop] of Object.entries(RAID_ELITE_ZOMBIE_DROPS)) {
      expect(drop.rate, `raid ${id}`).toBeGreaterThanOrEqual(0.03 - 1e-12);
      expect(drop.rate, `raid ${id}`).toBeLessThanOrEqual(0.045 + 1e-12);
    }
  });

  it("never pays a harder invasion less than an easier one", () => {
    for (let i = 1; i < ordinary.length; i++) {
      expect(ordinary[i].rate, `raid ${ordinary[i].raidId} vs ${ordinary[i - 1].raidId}`)
        .toBeGreaterThanOrEqual(ordinary[i - 1].rate - 1e-12);
    }
  });

  it("climbs the story invasions strictly, in their unlock order", () => {
    const story = [2, 3, 4, 5, 6].map((id) => RAID_ZOMBIE_DROPS[id].rate);
    for (let i = 1; i < story.length; i++) expect(story[i]).toBeGreaterThan(story[i - 1]);
  });

  it("prices every promoted prize at the multiplier times its raid's ordinary rate, under the cap", () => {
    for (const [id, drop] of Object.entries(RAID_ELITE_ZOMBIE_DROPS)) {
      const uncapped = ELITE_PRIZE_RATE_MULTIPLIER * RAID_ZOMBIE_DROPS[Number(id)].rate;
      expect(drop.rate).toBeCloseTo(Math.min(ELITE_PRIZE_RATE_CAP, uncapped), 12);
    }
    // Only the top of the ladder is actually held down by the cap; the other four land
    // inside the band on the multiplier alone (Robots sits exactly ON the cap, uncapped).
    const capped = Object.keys(RAID_ELITE_ZOMBIE_DROPS).map(Number)
      .filter((id) => ELITE_PRIZE_RATE_MULTIPLIER * RAID_ZOMBIE_DROPS[id].rate > ELITE_PRIZE_RATE_CAP + 1e-12);
    expect(capped).toEqual([6]);
  });
});
