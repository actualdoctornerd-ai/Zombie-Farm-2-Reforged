// What counts as a casualty.
//
// The loss-less target makes `outcome.losses` the headline number of the whole harness,
// so what goes into it has to be exactly right — and the one mechanic that can take a
// zombie back OUT of it is Resurrect. A Garden holder revives the most recent corpse at
// full life, INCLUDING an exploder (ruleset 21: the blanket `isSmall` refusal was read
// off a wrong annotation and the suicide-refusal is deliberately not carried over).
//
// `BattleSim.abilities.test.ts` already pins the mechanic on a two-unit fixture. What is
// NOT covered there, and is what a difficulty number actually rests on, is the same thing
// in a REAL invasion with a real roster: that the exploder's death goes through
// `dealDamage` into the corpse backlog, that a deployed holder picks it up, and that the
// zombie is therefore alive at the end and absent from `losses`.
//
// It also pins the failure mode that made this worth testing at all. A Garden that never
// leaves the staging group cannot cast — `canResurrect` requires `advance | fight` — so a
// roster with two Resurrect holders can still finish a fight with `resurrectsLeft() === 0`
// and its exploders counted as losses, purely because the deploy queue never reached
// them. That is a fact about the lineup, not about the ability, and the two must not be
// confused when reading a casualty count.
import { describe, expect, it } from "vitest";
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildRoster, BROAD, SUPPORT_LAST, type Group } from "./roster";

/** Master-rank, best-in-slot, everything unlocked — and with the Garden and the Small
 *  PINNED to their ordinary Silvers, which is the whole reason this note exists.
 *
 *  Both abilities under test have MOVED SPECIES at the top of the ladder:
 *   · Resurrect belongs to the ordinary Garden ladder at tier 3. The level-appropriate
 *     Gardens from level 24 on are the Dr. Zombie and the Omega Dr. Zombie, whose
 *     `SPECIAL_ABILITIES` are heal / tankHitPointsBuff / **zomBeam** / healAOE — they
 *     trade Resurrect for a laser. An endgame roster picked on strength has no Resurrect
 *     in its Gardens at all.
 *   · Explode belongs to the ordinary Small ladder. The level-appropriate Smalls from
 *     level 32 on are the Zombug and the Proto, which carry Resurrect at tier 3 and
 *     Smash at tier 4 — no Explode.
 *
 *  So at the endgame Resurrect leaves the Garden and lands on the Mini, and the exploder
 *  stops being something anyone fields. Pinning both keeps this a test of the MECHANIC
 *  rather than of today's species ranking; the ranking itself is the difficulty report's
 *  business, and the interaction is worth knowing about on its own. */
const maxed = (pattern: readonly Group[]) => buildRoster({
  pattern,
  size: 20,
  invasions: 5,
  mutation: "best",
  playerLevel: 45,
  abilityTiers: 4,
  farmerLifeMult: 1.1,
  species: { Small: "ZombieActorSmallTier4", Garden: "ZombieActorGardenTier4" },
});

describe("a revived zombie is not a casualty", () => {
  it("takes the exploder back out of `losses` when a deployed holder revives it", () => {
    const roster = maxed(BROAD);
    const { spec } = harnessFight({
      raidId: 13, tier: 5, playerUnits: roster.units, hazards: true, waveSeed: "rez",
    });
    const sim = buildFight(spec);
    const flight = flyFight(sim, makePilot(EXPERT), { seed: "rez" });

    // The premise: the pilot really did spend the fuse, and a holder really did cast.
    const feats = flight.outcome.feats;
    const exploded = !!feats?.abilityKills.some((k) => k.ability.startsWith("explode"));
    const revived = feats?.resurrections.length ?? 0;
    expect(exploded || revived > 0, "nothing detonated and nothing revived — premise gone").toBe(true);

    // The claim: every zombie the sim brought back is alive and absent from the losses.
    // Checked against `alive` rather than against a count, so it holds however many
    // casualties the fight produced.
    const losses = new Set(flight.outcome.losses);
    for (const unit of sim.units) {
      if (unit.team !== "player") continue;
      expect(losses.has(unit.id), `${unit.id} is alive=${unit.alive} yet losses=${losses.has(unit.id)}`)
        .toBe(!unit.alive);
    }
    expect(flight.losses).toBe(flight.outcome.losses.length);
    expect(flight.survivors + flight.losses).toBe(roster.units.length);
  });

  it("only counts a revive the holder was on the field to make", () => {
    // Same roster, same fight, same pilot — the ONLY difference is where the Gardens sit
    // in the lineup. `supportLast` is the order a player gets by not thinking about it,
    // and on a fight this short the queue never reaches them.
    const fight = (pattern: readonly Group[]) => {
      const roster = maxed(pattern);
      const { spec } = harnessFight({
        raidId: 13, tier: 5, playerUnits: roster.units, hazards: true, waveSeed: "order",
      });
      const sim = buildFight(spec);
      const flight = flyFight(sim, makePilot(EXPERT), { seed: "order" });
      const gardens = sim.units.filter((u) => u.team === "player" && u.group === "Garden");
      return {
        flight,
        deployed: gardens.filter((g) => g.state !== "waiting").length,
        gardens: gardens.length,
        rezLeft: sim.resurrectsLeft(),
      };
    };

    const early = fight(BROAD);
    const late = fight(SUPPORT_LAST);

    expect(early.gardens, "the lineup fielded no Garden at all").toBeGreaterThan(0);
    // Interleaving gets the support out; grouping it at the tail does not. Note that even
    // `standard` does not land ALL five of its Gardens on a fight this short — the last
    // one sits in slot 18 of 20, past the ~72 s the charge queue needs — which is itself
    // the reason army size is not a free dial.
    expect(early.deployed, "interleaving beats grouping at the tail")
      .toBeGreaterThan(late.deployed);
    // The diagnosis, pinned: a holder that never deploys is a holder that cannot cast.
    // `resurrectsLeft` counts only holders in `advance | fight` with the ability unspent,
    // so it can never exceed the number that actually got out. If this stops being true
    // it is because the deploy queue or the Garden's station changed, and the casualty
    // numbers in the difficulty report move with it.
    expect(late.rezLeft).toBeLessThanOrEqual(late.deployed);
    expect(early.rezLeft).toBeLessThanOrEqual(early.deployed);
  });
});
