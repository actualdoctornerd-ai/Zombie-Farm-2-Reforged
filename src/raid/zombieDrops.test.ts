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
  STORY_ZOMBIE_DROP_RATE,
  STORY_ELITE_ZOMBIE_DROP_RATE,
  DEPUTY_ZOMBIE_KEY,
  SHERIFF_ZOMBIE_KEY,
  MER_ZOMBIE_KEY,
  POSEIDON_ZOMBIE_KEY,
  NINJOMBIE_KEY,
  MASTER_NINJOMBIE_KEY,
  ZOMBIE_BOT_KEY,
  OMEGA_ZOMBIE_BOT_KEY,
  ZASTRONAUT_KEY,
  isRareInvasionZombieName,
} from "./zombieDrops";
import { ELITE_BRAIN_LUCK } from "./eliteInvasion";

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
  ])("drops the configured event zombie from raid %i at exactly 0.8%%", (raidId, key) => {
    expect(EVENT_ZOMBIE_DROP_RATE).toBe(0.008);
    expect(rollRaidZombieDrop(raidId, true, 0)?.key).toBe(key);
    expect(rollRaidZombieDrop(raidId, true, 0.007999999)?.key).toBe(key);
    expect(rollRaidZombieDrop(raidId, true, 0.008)).toBeNull();
  });

  it("never drops from a loss, an unrelated invasion, or an invalid roll", () => {
    expect(rollRaidZombieDrop(7, false, 0)).toBeNull();
    expect(rollRaidZombieDrop(8, true, 0)).toBeNull(); // the Circus has no rare zombie
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
    expect(raidZombieDropRate(7, 5)).toBeCloseTo(0.048, 10); // event zombies: 0.8% base
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
    expect(rollRaidZombieDrop(8, true, 0.0, 10)).toBeNull();
    expect(raidZombieDropRate(8, 10)).toBe(0);
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

  it("only the nine raids with a rare zombie have a streak that means anything", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10, 11].every(hasRaidZombieDrop)).toBe(true);
    // The Circus and Video Games pay no rare zombie.
    expect([8, 9].some(hasRaidZombieDrop)).toBe(false);
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
    expect(rollRaidZombieDropWithPity(8, true, MISS, 10_000)).toBeNull();
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
    expect(raidZombieDropRate(7, 0, ELITE_BRAIN_LUCK)).toBeCloseTo(0.032, 10);
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
    expect(raidZombieDropRate(8, 5, ELITE_BRAIN_LUCK)).toBe(0);
    expect(rollRaidZombieDrop(8, true, 0, 5, ELITE_BRAIN_LUCK)).toBeNull();
  });

  it("cannot exceed certainty", () => {
    expect(raidZombieDropRate(1, ZOMBIE_LUCK_DICE_CAP, 1000)).toBe(1);
  });
});

describe("the story invasions' prize pairs", () => {
  const MISS = 1;
  const PAIRS: Array<[number, string, string]> = [
    [2, DEPUTY_ZOMBIE_KEY, SHERIFF_ZOMBIE_KEY],
    [3, MER_ZOMBIE_KEY, POSEIDON_ZOMBIE_KEY],
    [4, NINJOMBIE_KEY, MASTER_NINJOMBIE_KEY],
    [5, ZOMBIE_BOT_KEY, OMEGA_ZOMBIE_BOT_KEY],
  ];

  it("pins the first-pass rates: 1% ordinary, 2% for the promoted prize", () => {
    expect(STORY_ZOMBIE_DROP_RATE).toBe(0.01);
    expect(STORY_ELITE_ZOMBIE_DROP_RATE).toBe(0.02);
  });

  it.each(PAIRS)("raid %i pays its base zombie on an ordinary win at 1%", (raidId, base) => {
    expect(raidZombieDropFor(raidId)?.key).toBe(base);
    expect(raidZombieDropRate(raidId)).toBeCloseTo(0.01, 10);
    expect(rollRaidZombieDrop(raidId, true, 0.009)?.key).toBe(base);
    expect(rollRaidZombieDrop(raidId, true, 0.01)).toBeNull();
  });

  it.each(PAIRS)("raid %i pays its PROMOTED zombie instead on an elite win, at 2%", (raidId, base, promoted) => {
    expect(raidZombieDropFor(raidId, true)?.key).toBe(promoted);
    // Twice the ordinary rate — and NOT the 4x elite luck on top of that.
    expect(raidZombieDropRate(raidId, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.02, 10);
    expect(rollRaidZombieDrop(raidId, true, 0.019, 0, ELITE_BRAIN_LUCK, true)?.key).toBe(promoted);
    expect(rollRaidZombieDrop(raidId, true, 0.02, 0, ELITE_BRAIN_LUCK, true)).toBeNull();
    // The base zombie never comes out of an elite fight, however lucky the roll.
    expect(rollRaidZombieDrop(raidId, true, 0, 5, ELITE_BRAIN_LUCK, true)?.key).not.toBe(base);
  });

  it("still lets Golden Dice widen the promoted prize's roll", () => {
    expect(raidZombieDropRate(2, 1, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.04, 10);
    expect(raidZombieDropRate(2, 5, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.12, 10);
  });

  it("asking for the elite prize of a single-prize raid is the ordinary prize at elite luck", () => {
    expect(raidZombieDropFor(1, true)?.key).toBe(OLD_MC_ZOMBIE_KEY);
    expect(raidZombieDropRate(1, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.04, 10);
    expect(raidZombieDropFor(8, true)).toBeNull();
  });

  it("gives the Aliens the Zastronaut as a single prize that takes the 4x elite luck", () => {
    expect(RAID_ZOMBIE_DROPS[6].key).toBe(ZASTRONAUT_KEY);
    expect(RAID_ELITE_ZOMBIE_DROPS[6]).toBeUndefined();
    expect(raidZombieDropRate(6)).toBeCloseTo(0.01, 10);
    expect(raidZombieDropRate(6, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.04, 10);
    expect(rollRaidZombieDrop(6, true, 0.03, 0, ELITE_BRAIN_LUCK, true)?.key).toBe(ZASTRONAUT_KEY);
  });

  it("keeps a separate pity streak for each prize of a paired raid, and one for the rest", () => {
    expect(raidZombieDryKey(2, false)).toBe("2");
    expect(raidZombieDryKey(2, true)).toBe("2:elite");
    expect(raidZombieDryKey(1, true)).toBe("1"); // Old McZombie: one prize, one streak
    expect(raidZombieDryKey(6, true)).toBe("6"); // Zastronaut likewise
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
    expect(byKey.get(OLD_MC_ZOMBIE_KEY)).toMatchObject({ raidId: 1, elite: false });
    expect(byKey.size).toBe(13);
    // Every source key is a distinct zombie: no prize is reachable from two places.
    expect(new Set(RAID_ZOMBIE_SOURCES.map((s) => s.drop.key)).size).toBe(RAID_ZOMBIE_SOURCES.length);
  });

  it("counts the promoted prizes as rare invasion zombies for the quest alias", () => {
    expect(isRareInvasionZombieName("Sheriff Zombie")).toBe(true);
    expect(isRareInvasionZombieName("Deputy Zombie")).toBe(true);
    expect(isRareInvasionZombieName("Zastronaut")).toBe(true);
    expect(isRareInvasionZombieName("Bombie")).toBe(false);
  });
});
