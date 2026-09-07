// RaidManager's half of the Brain Ticket: what beginRaid actually charges, what it
// scales, and what it refuses to do twice.
import { describe, expect, it } from "vitest";
import { RaidManager } from "./RaidManager";
import { GameState } from "../GameState";
import { BRAIN_TICKET_KEY, ELITE_BRAIN_LUCK, ELITE_PROFILES } from "./eliteInvasion";
import { VOUCHER_KEY, RAID_COOLDOWN_MS } from "./RaidCatalog";
import { raidZombieDropRate, OLD_MC_ZOMBIE_KEY, NINJOMBIE_KEY, MASTER_NINJOMBIE_KEY,
  RAID_ZOMBIE_PITY_WINS } from "./zombieDrops";
import type { EnemyStat, RaidDef, RaidOutcome } from "./types";

const ENEMY_STATS: Record<string, EnemyStat> = {
  Grunt: { str: 2, con: 3, dex: 1, attacks: [{ frequency: 100, name: "hit" }] },
  Chief: {
    str: 4, con: 10, dex: 2,
    attacks: [{ frequency: 100, name: "hit" }],
    bossActions: [
      { name: "throw", frequency: 50, damage: 20, sprite: "rock.png", spriteSize: 32 },
      { name: "alienLaser", frequency: 50, damage: 40, castTime: 1, cooldownTime: 2 },
      { name: "wall", frequency: 20, hp: 1500, sprite: "carrotWall.png" },
    ],
  },
};

/** Raid 4 (the Ninjas) so the wall multiplier is live; two stages so the level-1 fight
 *  resolves to the boss stage. */
const RAID = {
  id: 4, name: "Test Invasion", recommendedLevel: 20, unlockLevel: 0, playable: true,
  goldReward: 100, bonusGold: 0, xp: 0, loot: [[], [], [], []], throwSpeed: 2,
  stages: [{ enemyKeys: ["Grunt", "Grunt"], bossKey: "Chief" }],
  obstacleLimit: 0, obstacleSpawnSecs: 0, obstacleActors: [], initialSpawnClass: "",
  hasGrab: false, seasonal: false,
} as unknown as RaidDef;

const PARTY_IDS = Array.from({ length: 8 }, (_, i) => `z${i}`);
const WIN: RaidOutcome = {
  win: true, rounds: 1, survivors: PARTY_IDS, losses: [], enemiesBeaten: 3, playerDamage: 0,
};

// `now` starts well past the cooldown so an ordinary launch is not gated; the one
// test that WANTS a live cooldown sets lastRaidAt to this same instant.
const NOW = RAID_COOLDOWN_MS * 10;

function makeManager(now = NOW) {
  const state = new GameState();
  state.addXp(200_000); // level is XP-derived; this clears the level-25 stat ramp
  const roster = PARTY_IDS.map((id) => ({
    id, key: "ZombieActorRegular", name: id, typeName: "Regular", group: "Regular",
    className: "Green", str: 5, dex: 2, con: 5, focus: 50, invasions: 0, mutation: 0,
    stored: false, col: 0, row: 0,
  }));
  const zombies = {
    roster: () => roster,
    recordInvasion: () => {},
    removeCasualties: () => {},
  } as never;
  const granted: string[] = [];
  const assets = {
    raids: [RAID], enemyStats: ENEMY_STATS, raidAttacks: {}, boosts: [], drops: {},
  } as never;
  const raids = new RaidManager(assets, state, zombies, {
    save: () => {},
    grantZombie: (key: string) => { granted.push(key); },
  }, RAID_COOLDOWN_MS, () => now);
  return { state, raids, granted };
}

describe("spending a Brain Ticket", () => {
  it("does nothing without one in the inventory", () => {
    const { raids, state } = makeManager();
    const setup = raids.beginRaid(4, PARTY_IDS, { brainTicket: true })!;
    expect(setup.elite).toBe(false);
    expect(state.boostCount(BRAIN_TICKET_KEY)).toBe(0);
  });

  it("charges exactly one and marks the fight elite", () => {
    const { raids, state } = makeManager();
    state.addBoost(BRAIN_TICKET_KEY, 2);
    const setup = raids.beginRaid(4, PARTY_IDS, { brainTicket: true })!;
    expect(setup.elite).toBe(true);
    expect(state.boostCount(BRAIN_TICKET_KEY)).toBe(1);
  });

  it("is not charged when the player didn't ask for one", () => {
    const { raids, state } = makeManager();
    state.addBoost(BRAIN_TICKET_KEY, 1);
    const setup = raids.beginRaid(4, PARTY_IDS, {})!;
    expect(setup.elite).toBe(false);
    expect(state.boostCount(BRAIN_TICKET_KEY)).toBe(1);
  });

  it("scales the enemy line, the projectiles, the specials and the wall", () => {
    const { raids, state } = makeManager();
    const plain = raids.beginRaid(4, PARTY_IDS, {})!;
    state.addBoost(BRAIN_TICKET_KEY, 1);
    const elite = raids.beginRaid(4, PARTY_IDS, { brainTicket: true })!;
    const profile = ELITE_PROFILES[4];

    for (let i = 0; i < plain.enemyUnits.length; i++) {
      expect(elite.enemyUnits[i].maxHp).toBeGreaterThan(plain.enemyUnits[i].maxHp);
      expect(elite.enemyUnits[i].str).toBeGreaterThan(plain.enemyUnits[i].str);
      // dex > 1 for the Ninjas, so they also swing faster (a SHORTER interval).
      expect(elite.enemyUnits[i].attackCooldownMs).toBeLessThan(plain.enemyUnits[i].attackCooldownMs);
    }
    expect(elite.bossThrow!.intervalMs)
      .toBeCloseTo(plain.bossThrow!.intervalMs / profile.throwRate, 6);
    expect(elite.bossThrow!.options[0].damage)
      .toBeCloseTo(plain.bossThrow!.options[0].damage * profile.throwDamage, 6);
    expect(elite.bossSpecials[0].damage)
      .toBeCloseTo(plain.bossSpecials[0].damage * profile.specialDamage, 6);
    expect(elite.wallTemplate!.maxHp)
      .toBe(Math.round(plain.wallTemplate!.maxHp * profile.wallHp));
  });

  it("covers the cooldown by itself, without also eating an Invasion Voucher", () => {
    const { raids, state } = makeManager();
    state.lastRaidAt = NOW; // launched this instant: the full cooldown is live
    state.addBoost(BRAIN_TICKET_KEY, 1);
    state.addBoost(VOUCHER_KEY, 1);
    expect(raids.onCooldown()).toBe(true);

    // Without a ticket the cooldown blocks the launch outright.
    expect(raids.beginRaid(4, PARTY_IDS, {})).toBeNull();

    const setup = raids.beginRaid(4, PARTY_IDS, { brainTicket: true })!;
    expect(setup.elite).toBe(true);
    expect(state.boostCount(VOUCHER_KEY)).toBe(1); // untouched
    expect(state.boostCount(BRAIN_TICKET_KEY)).toBe(0);
  });

  it("does not charge a ticket for a launch that never happens", () => {
    const { raids, state } = makeManager();
    state.addBoost(BRAIN_TICKET_KEY, 1);
    // Below the eight-zombie minimum: beginRaid bails before anything is spent.
    expect(raids.beginRaid(4, PARTY_IDS.slice(0, 2), { brainTicket: true })).toBeNull();
    expect(state.boostCount(BRAIN_TICKET_KEY)).toBe(1);
  });

  it("adopts the server's answer online rather than its own request", () => {
    const { raids, state } = makeManager();
    state.addBoost(BRAIN_TICKET_KEY, 1);
    // The player asked, but the server declined to charge one: the pinned wave is the
    // ordinary one, so scaling it here would desync the replay from tick 0.
    const declined = raids.beginRaid(4, PARTY_IDS, {
      brainTicket: true, serverAuthorized: true, serverElite: false,
    })!;
    expect(declined.elite).toBe(false);
    const plain = raids.beginRaid(4, PARTY_IDS, {})!;
    expect(declined.enemyUnits[0].maxHp).toBe(plain.enemyUnits[0].maxHp);
  });
});

describe("what an elite invasion pays", () => {
  it("rolls brains at the elite multiplier", () => {
    const { raids, state } = makeManager();
    // 12% misses every ordinary tier at rec 20 (2/4/10%) and lands on the elite
    // 3-brain tier (8/16/40%). Math.random is the source beginRaid uses.
    const random = Math.random;
    try {
      Math.random = () => 0.12;
      expect(raids.beginRaid(4, PARTY_IDS, {})!.brainDrop).toBe(0);
      state.addBoost(BRAIN_TICKET_KEY, 1);
      expect(raids.beginRaid(4, PARTY_IDS, { brainTicket: true })!.brainDrop).toBe(3);
    } finally {
      Math.random = random;
    }
  });

  it("rolls the rare zombie at the elite multiplier", () => {
    const { raids, granted } = makeManager();
    const mcDonnell = { ...RAID, id: 1 } as RaidDef;
    const random = Math.random;
    try {
      // 3% misses Old McZombie's ordinary 1% and hits its elite 4%.
      expect(raidZombieDropRate(1)).toBeCloseTo(0.01, 10);
      expect(raidZombieDropRate(1, 0, ELITE_BRAIN_LUCK)).toBeCloseTo(0.04, 10);
      Math.random = () => 0.03;
      raids.finishRaid(mcDonnell, [] as never, WIN, 0, false, 0, true, false);
      expect(granted).toEqual([]);
      raids.finishRaid(mcDonnell, [] as never, WIN, 0, false, 0, true, true);
      expect(granted).toEqual([OLD_MC_ZOMBIE_KEY]);
    } finally {
      Math.random = random;
    }
  });
});

describe("a story invasion promotes its rare zombie on a Brain Ticket", () => {
  // The harness's raid IS the Ninjas (id 4): Ninjombie ordinarily, Master Ninjombie elite.
  it("pays the base zombie on an ordinary win and the promoted one on an elite win", () => {
    const { raids, granted } = makeManager();
    const random = Math.random;
    try {
      // 1.5% misses Ninjombie's 1% but lands inside Master Ninjombie's 2%.
      expect(raidZombieDropRate(4)).toBeCloseTo(0.01, 10);
      expect(raidZombieDropRate(4, 0, ELITE_BRAIN_LUCK, true)).toBeCloseTo(0.02, 10);
      Math.random = () => 0.015;
      raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, false);
      expect(granted).toEqual([]);
      raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, true);
      expect(granted).toEqual([MASTER_NINJOMBIE_KEY]);
      // 0.5% lands for both — and the ordinary fight still pays the BASE zombie.
      Math.random = () => 0.005;
      raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, false);
      expect(granted).toEqual([MASTER_NINJOMBIE_KEY, NINJOMBIE_KEY]);
    } finally {
      Math.random = random;
    }
  });

  it("keeps the ordinary and elite pity streaks apart", () => {
    const { raids, state, granted } = makeManager();
    const random = Math.random;
    try {
      Math.random = () => 1; // never a natural drop
      for (let i = 0; i < RAID_ZOMBIE_PITY_WINS; i++) raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, false);
      expect(state.zombieDryWins["4"]).toBe(RAID_ZOMBIE_PITY_WINS);
      expect(state.zombieDryWins["4:elite"]).toBeUndefined();
      // The floor is the DEPUTY-side one: an elite win here does not cash it in.
      raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, true);
      expect(granted).toEqual([]);
      expect(state.zombieDryWins["4:elite"]).toBe(1);
      // …but the next ordinary win does, and resets only its own streak.
      raids.finishRaid(RAID, [] as never, WIN, 0, false, 0, true, false);
      expect(granted).toEqual([NINJOMBIE_KEY]);
      expect(state.zombieDryWins["4"]).toBe(0);
      expect(state.zombieDryWins["4:elite"]).toBe(1);
    } finally {
      Math.random = random;
    }
  });

  it("tells the raid card which zombie the Brain Ticket fight pays instead", () => {
    const { raids } = makeManager();
    // The harness raid is a stub; give the card the one field raidCards() reads unguarded.
    (RAID as { introText?: string }).introText = "";
    const card = raids.raidCards().find((c) => c.id === 4)!;
    expect(card.zombieDrop).toEqual({
      name: "Ninjombie", rate: 0.01, eliteName: "Master Ninjombie", eliteRate: 0.02,
    });
  });
});
