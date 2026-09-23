// THE FIGHT CLOCK — four simulated minutes, after which the battle ends where it stands.
//
// Why this file exists: the cap is declared TWICE, in two files that do not import each
// other. `BattleSim.RAID_TIME_LIMIT_MS` stops the fight; `replay.RAID_MAX_TICKS` stops the
// verifier's replay. They agree today, and nothing but this test would notice if they ever
// stopped — so the failure mode is silent and lands on the player: the server's replay
// would run out before the sim finished, return `truncated_transcript`, and void a fight
// the player watched to its end with no result, no reward and no explanation.
//
// It also pins the CONSEQUENCE, which is easy to get wrong from reading the verifier alone:
// running out of time is an ordinary LOSS. It settles, it verifies, it pays a loss's
// rewards. It is not an unverifiable fight, and the four-minute cap is not a hole.
import { describe, expect, it } from "vitest";
import { BattleSim, RAID_TIME_LIMIT_MS } from "./BattleSim";
import { GameState } from "../GameState";
import { RaidManager } from "./RaidManager";
import { replayRaid, RAID_MAX_TICKS, RAID_TICK_MS } from "./replay";
import type { CombatUnit, RaidDef, RaidOutcome } from "./types";

const unit = (over: Partial<CombatUnit>): CombatUnit => ({
  id: "u", sourceKey: "ZombieActorRegularTier1", team: "player", name: "Z",
  str: 0, dex: 2, con: 10, focus: 100, hp: 1e6, maxHp: 1e6,
  attackCooldownMs: 1000, attacks: [{ name: "a", frequency: 100, damageMultiplier: 1 }],
  isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
  ...over,
} as CombatUnit);

const NO_ENRAGE_MS = 10 * 60 * 1000;

/** A fight neither side can ever finish: everybody swings for nothing. The only thing that
 *  can end it is the clock, which is exactly what is under test. */
const stalemate = () => new BattleSim(
  [unit({ id: "p1" }), unit({ id: "p2" })],
  [unit({ id: "e1", team: "enemy", sourceKey: "AlienStageActorMinion" })],
  null, true, [], NO_ENRAGE_MS,
);

/** Step to the end (or give up well past the cap, so a regression fails as a timeout
 *  rather than hanging the suite). */
function runOut(sim: BattleSim): number {
  let ticks = 0;
  while (sim.step(RAID_TICK_MS) && ticks < RAID_MAX_TICKS * 4) ticks++;
  return ticks;
}

describe("the fight clock", () => {
  it("is the same instant for the sim and for the verifier", () => {
    expect(RAID_TIME_LIMIT_MS).toBe(RAID_MAX_TICKS * RAID_TICK_MS);
  });

  it("ends an undecidable fight, rather than letting it run forever", () => {
    const sim = stalemate();
    const ticks = runOut(sim);
    expect(sim.finished).toBe(true);
    expect(ticks).toBeLessThanOrEqual(RAID_MAX_TICKS);
  });

  it("makes running out of time a LOSS the army survives", () => {
    const sim = stalemate();
    runOut(sim);
    const outcome = sim.outcome();
    expect(outcome.win).toBe(false);
    expect(outcome.outOfTime).toBe(true);
    // Nobody died — this is the one loss the player's whole army walks home from.
    expect(outcome.losses).toEqual([]);
    expect(outcome.survivors).toEqual(["p1", "p2"]);
  });

  it("tells a rout apart from a timeout", () => {
    // Enemies that can actually kill, against players who cannot fight back.
    const sim = new BattleSim(
      [unit({ id: "p1", hp: 1, maxHp: 1 })],
      [unit({ id: "e1", team: "enemy", sourceKey: "AlienStageActorMinion", str: 500 })],
      null, true, [], NO_ENRAGE_MS,
    );
    runOut(sim);
    const outcome = sim.outcome();
    expect(outcome.win).toBe(false);
    expect(outcome.outOfTime).toBe(false);
    expect(outcome.losses).toEqual(["p1"]);
  });

  it("settles on the server instead of coming back unverifiable", () => {
    // THE point of the file. A fight that runs the clock out replays to a clean loss:
    // `truncated_transcript` is not reachable from an ordinary finish.
    const played = stalemate();
    const finalTick = runOut(played);
    const verdict = replayRaid(stalemate(), finalTick, []);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.outcome.win).toBe(false);
    expect(verdict.outcome.outOfTime).toBe(true);
  });

  it("never reports a final tick the verifier would reject", () => {
    const sim = stalemate();
    // The client's own transcript is stamped with its tick counter, and `advanceRaidSegment`
    // rejects `finalTick > RAID_MAX_TICKS` outright (`bad_final_tick`) — a rejection the
    // concession path does NOT forgive. The sim stopping first is what keeps it unreachable.
    expect(runOut(sim)).toBeLessThan(RAID_MAX_TICKS);
  });

  it("finishes a fight the server has to carry on alone", () => {
    // A short transcript (the player's client died, or checkpointed and stopped) still
    // settles: the verifier runs the fight on unattended and hits the same clock.
    const verdict = replayRaid(stalemate(), 100, []);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.outcome.outOfTime).toBe(true);
    expect(verdict.divergence.overrunTicks).toBeGreaterThan(0);
  });

  it("counts down in simulated time, not wall clock", () => {
    const sim = stalemate();
    expect(sim.timeRemainingMs()).toBe(RAID_TIME_LIMIT_MS);
    for (let i = 0; i < 20; i++) sim.step(RAID_TICK_MS);
    expect(sim.timeRemainingMs()).toBe(RAID_TIME_LIMIT_MS - 20 * RAID_TICK_MS);
    runOut(sim);
    expect(sim.timeRemainingMs()).toBe(0);
  });
});

// And what the player is actually told. A timeout is the only loss the army walks home
// from, so reporting it as a rout ("ZOMBIES LOSE") describes a fight that did not happen
// and leaves the real reason — the clock — unmentioned anywhere on the panel.
const RAID = {
  id: 99, name: "Test Invasion", recommendedLevel: 20,
  goldReward: 100, bonusGold: 0, xp: 0, loot: [[], [], [], []],
} as unknown as RaidDef;
const PARTY = [{ id: "a" }] as never;

function manager() {
  const zombies = { roster: () => [], recordInvasion: () => {}, removeCasualties: () => {} } as never;
  return new RaidManager({} as never, new GameState(), zombies, {
    save: () => {}, grantZombie: () => {},
  });
}

const result = (over: Partial<RaidOutcome>): RaidOutcome => ({
  win: false, rounds: 1, survivors: ["a"], losses: [], enemiesBeaten: 0, playerDamage: 0, ...over,
});

describe("what the result panel says", () => {
  it("names the clock when it was the clock", () => {
    const view = manager().finishRaid(RAID, PARTY, result({ outOfTime: true }), 0, false, 0, true);
    expect(view.win).toBe(false);
    expect(view.title).toBe("OUT OF TIME");
  });

  it("still reports an ordinary defeat as one", () => {
    const view = manager().finishRaid(
      RAID, PARTY, result({ survivors: [], losses: ["a"] }), 0, false, 0, true);
    expect(view.title).toBe("ZOMBIES LOSE");
  });

  it("never dresses a win up as a timeout", () => {
    // Clearing the field on the final tick is a WIN — the sim decides before it expires.
    const view = manager().finishRaid(
      RAID, PARTY, result({ win: true, outOfTime: false }), 0, false, 0, true);
    expect(view.title).toBe("ZOMBIES WIN");
  });
});
