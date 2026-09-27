// The FAST half of the difficulty harness: relations, in seconds, in CI.
//
// The slow half (`report.ts`, `npm run test:difficulty`) produces a table to read and
// argue with. This one produces pass/fail, and the difference matters: a report you tune
// numbers against stops being a measurement. So nothing here asserts an absolute — no
// clear time, no win rate, no strength figure. Only properties that are true because of
// how the game is built, and one ratchet.
//
// THE RATCHET. `NOT_YET_LOSSLESS` names every fight that cannot currently be cleared
// without casualties by the best roster its own era can field. The test asserts that
// every fight NOT on that list can be. Adding a line to it is a visible diff that says
// "we made a fight harder than the target", and removing one is a fix. The list can
// shrink silently; it cannot grow silently. That is the whole mechanism — it keeps the
// loss-less target enforceable without pretending today's content already meets it.
import { describe, expect, it } from "vitest";
import raidsJson from "../../../public/assets/raids/raids.json";
import { eraForLevel, ERA_BY_ID, gridFor } from "./archetypes";
import { measure, type Target } from "./measure";
import { EXPERT, IDLE } from "./pilots";
import { RAID_MAX_TICKS, RAID_TICK_MS } from "../replay";
import type { RaidDef } from "../types";

const raids = (raidsJson as RaidDef[]).filter((r) => r.playable);
const CAP_SECS = (RAID_MAX_TICKS * RAID_TICK_MS) / 1000;

/** Two seeds and the era's own grid — enough for a relation, far short of the report. */
const SEEDS = 2;

const at = (raidId: number, tier?: number): { target: Target; era: string; label: string } => {
  const raid = raids.find((r) => r.id === raidId)!;
  return {
    target: { raidId, tier },
    era: tier ? "endgame" : eraForLevel(raid.recommendedLevel).id,
    label: `${raidId} ${raid.name}${tier ? ` t${tier}` : ""}`,
  };
};

/** Every ordinary invasion at its own era, plus the four dual invasions at the bottom
 *  and top of their ladders. The elite rows are left to the report — a Brain Ticket is
 *  an opt-in harder fight, not a rung the target speaks about. */
const FIGHTS = [
  ...raids.filter((r) => r.id <= 11).map((r) => at(r.id)),
  ...[12, 13, 14, 15].flatMap((id) => [at(id, 1), at(id, 10)]),
];

/** Fights that cannot be cleared clean by the best roster of their own era, with WHY.
 *  Every entry is a tuning or rules decision that has not been made yet, not a
 *  tolerance. Re-measured 2026-09-21 at ruleset 61, AFTER the special zombies were added
 *  to the roster catalog — which is what took the list from five entries to three, since
 *  a level-appropriate endgame army is two to four times stronger than the ordinary
 *  Silvers the harness had been measuring.
 *
 *  Two separate causes:
 *   · raid 13 — the dex tax makes the ninja's throw rate track the army's own speed, so
 *     the rosters that clear fastest are the ones taking the most incoming. Every rung
 *     now WINS at 100%, and none of them clears clean on any lineup. It is the only
 *     fight in the game like that.
 *   · raid 14 t10 — the top of that ladder, over the target as tuned, and the one rung
 *     that still reaches the Garden deadlock below.
 *
 *  And from 2026-09-27, t10 of every dual invasion by design: the owner made t10 a PUSH
 *  target that may need rewards from the lower rungs (docs/POST_45_PROGRESSION.md Part 2B),
 *  so the era's own roster is not expected to clear it clean. */
const NOT_YET_LOSSLESS = new Set([
  "12 Zombies vs Lawyers & Farmers t10",
  "13 Zombies vs Ninjas & Pirates t10",
  "14 Zombies vs Circus & Video Games t10",
  "15 Zombies vs Aliens & Robots t10",
]);

describe("difficulty, against the loss-less target", () => {
  const cells = FIGHTS.map((f) => ({
    ...f,
    expert: measure(f.target, gridFor(ERA_BY_ID[f.era]), EXPERT, { seeds: SEEDS }),
  }));

  it("lets the era's own roster clear its own fight, cleanly", () => {
    // "Doable loss-less with a powerful army available at the time, played well." One
    // lineup out of six is enough — the target is that a clean clear EXISTS, not that
    // every build manages one.
    const failing = cells
      .filter((c) => !NOT_YET_LOSSLESS.has(c.label) && !c.expert.cheapestLossless)
      .map((c) => c.label);
    expect(failing, "no lineup clears these clean — tune them, or add them to NOT_YET_LOSSLESS with a reason").toEqual([]);
  });

  it("does not quietly widen the list of fights that miss the target", () => {
    // The other half of the ratchet: an entry that starts passing should be REMOVED, so
    // the list stays a statement about today rather than a graveyard. This is a nudge,
    // not a failure — it only fires when the list is plainly stale.
    const fixed = cells
      .filter((c) => NOT_YET_LOSSLESS.has(c.label) && c.expert.losslessRate === 1)
      .map((c) => c.label);
    expect(fixed, "these now clear clean on every roster — take them off NOT_YET_LOSSLESS").toEqual([]);
  });

  it("never ends a fight in a deadlock", () => {
    // A living army that cannot advance is a RULES failure, not a tuning one: the fight
    // has no ending, and on the live service it settles as `truncated_transcript` — no
    // result, no reward, no explanation.
    //
    // ONE CAUSE, MANY FIGHTS. Every entry below is the same thing: a Garden carrying
    // heal / healAOE / Resurrect is `supportsFromRear` (CombatEngine), which pins it at
    // the rear station OUTSIDE the combat zone for the whole fight. When an army loses
    // down to nothing but supports, no zombie left will ever walk forward, the enemies
    // hold their own line waiting for someone to come to them, and neither win condition
    // can be reached. Measured over the full report at ruleset 61: 83% of every
    // four-minute timeout in the game is this, across sixteen different fights.
    //
    // It is listed rather than asserted away because the fix is a rules decision nobody
    // has made yet (let a lone support advance? score a support-only army as a loss?
    // both change the transcript and cost a ruleset bump). When it IS made, delete the
    // list — do not relax the assertion.
    const KNOWN_GARDEN_DEADLOCK = new Set([
      "10 Tree World",
      "11 Valentine's Day",
      "14 Zombies vs Circus & Video Games t10",
      // Owner ruling 2026-09-26: a healer-only clock-out is an ordinary loss, not a bug.
      "12 Zombies vs Lawyers & Farmers t10",
    ]);
    const deadlocked = cells
      .filter((c) => c.expert.deadlockRate > 0 && !KNOWN_GARDEN_DEADLOCK.has(c.label))
      .map((c) => `${c.label} (${Math.round(c.expert.deadlockRate * 100)}%)`);
    expect(deadlocked, "a living army that cannot reach the enemy").toEqual([]);
  });

  it("finishes a won fight well inside the settle cap", () => {
    // The failure that looks like success: a win at 195 s and a hang at 240 s are the
    // same `win: true` to a test that only checks the result, and the second one does
    // not settle. Measured on the fights that DO win, since that is the run a player is
    // meant to have.
    for (const c of cells) {
      if (c.expert.medianWinSecs === null) continue;
      expect(c.expert.medianWinSecs, c.label).toBeLessThan(CAP_SECS * 0.75);
    }
  });

  it("gives playing the fight something to do", () => {
    // Somewhere in the game, input has to matter — otherwise the four pilots are
    // measuring one thing under four names and the whole ladder is decoration. Stated
    // over the WHOLE set rather than per raid, because a fight an era's roster simply
    // overpowers is allowed to be a fight you can idle.
    const idle = FIGHTS.map((f) => measure(f.target, gridFor(ERA_BY_ID[f.era]), IDLE, { seeds: SEEDS }));
    const improved = cells.filter((c, i) =>
      c.expert.winRate > idle[i].winRate || c.expert.losslessRate > idle[i].losslessRate);
    expect(improved.length, "playing well changed nothing anywhere").toBeGreaterThan(FIGHTS.length / 2);
  });
}, 900_000);
