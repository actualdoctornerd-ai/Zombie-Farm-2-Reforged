// The pilot ladder: `idle` → `casual` → `competent` → `expert`.
//
// "With or without player input" is not a switch, it is a range, and the SPREAD is the
// interesting number. A raid whose idle and expert flights look alike has mechanics that
// do not matter; a raid that idle loses and expert clears without a casualty is a raid
// that asks to be played. The old harness reported that spread as zero for every fight
// in the game, because it only ever flew the bottom rung.
//
// All four are ONE policy with four parameter sets (`PilotProfile`). That is deliberate:
// two independently-written policies would differ in a hundred small ways and the spread
// between them would measure the authors rather than the fight. Here the only thing that
// changes up the ladder is how fast the player notices, how often they miss, and which
// mechanics they bother to engage with at all.
//
// EVERY PILOT IS DETERMINISTIC. Its hesitations and misses come from a seeded generator,
// so `(ruleset, raid, wave seed, roster, pilot, pilot seed)` reproduces a flight exactly
// — which is what makes a stored difficulty number worth comparing to a later one.
import type { BattleSim, SimUnit } from "../BattleSim";
import { seededRandom } from "../RaidCatalog";
import { RAID_TICK_MS } from "../replay";
import { TOUCH_TAPS } from "../hazardTaps";
import type { Pilot, PilotAction } from "./pilot";

export interface PilotProfile {
  id: string;
  /** Ms between an opportunity appearing and this player acting on it. A human's
   *  notice-decide-move loop; the floor on how sharp any flight can look. */
  reactionMs: number;
  /** Chance a given opportunity is missed outright. Rolled ONCE per opportunity, not
   *  per tick, so a miss is "I didn't see that one" rather than a stutter. */
  missChance: number;
  /** Pop butterfly (distraction) bubbles too, not just the brain that gates release. */
  popButterflies: boolean;
  /** Use the Bash/Smash family as it comes off cooldown. */
  useBash: boolean;
  /** Mount a Mini Buddy on a Large before it deploys. */
  useMini: boolean;
  /** Minimum enemies on the field before spending the army's one-use Explode. 0 fires
   *  it the instant it is offered, which is how a casual player spends it. */
  explodeMinTargets: number;
  /** Tap the three SIMULATED hazards: the boss wall, a burning zombie, a converted
   *  pixel zombie. Every one of these taps is transcribed. */
  tapHazards: boolean;
  /** Tap the CLIENT-ONLY rescues (trapeze, crab, Mega-Robot eyes). Untranscribed — see pilot.ts. */
  rescueGrabs: boolean;
  /** Answer the Lawyer's placard. */
  pickSigns: boolean;
  /** How the saucer's limited cancel budget is spent. `always` burns it on whatever is
   *  charging; `worst` holds it for the casts that actually cost the army. */
  cancels: "never" | "always" | "worst";
  /** Break the pirate captain's charge (raid 13): hold the poise sources back until he is
   *  winding up, then spend the cheapest set that fills the bar.
   *
   *  A separate switch from `useBash` because the two want opposite things from the same
   *  button — Smash on cooldown is damage, Smash banked is an interrupt — and a fight
   *  that asks "which slams do you stop" cannot be measured by a pilot that has already
   *  spent the answer on the wave. */
  interrupts: boolean;
  /** Gap between repeated taps on one hazard. The sim enforces its own cadence and
   *  refuses anything faster, so a pilot that ignores this only inflates its refusal
   *  count — pacing itself keeps the count meaningful. */
  tapCadenceMs: number;
}

/** No inputs at all — EXACTLY the fight the old harness measured. Kept as the floor of
 *  the ladder, and as the thing every other rung is read against. */
export const IDLE: PilotProfile = {
  id: "idle",
  reactionMs: Infinity, missChance: 1,
  popButterflies: false, useBash: false, useMini: false, explodeMinTargets: 0,
  tapHazards: false, rescueGrabs: false, pickSigns: false, interrupts: false, cancels: "never",
  tapCadenceMs: TOUCH_TAPS.cooldownMs,
};

/** Someone playing with one eye on the fight. Releases zombies when the brain bubble
 *  stops the queue (because the queue visibly stops), spends moves as they light up, and
 *  does not engage with anything that needs a plan. */
export const CASUAL: PilotProfile = {
  id: "casual",
  reactionMs: 800, missChance: 0.35,
  popButterflies: false, useBash: true, useMini: false, explodeMinTargets: 0,
  tapHazards: false, rescueGrabs: true, pickSigns: false, interrupts: false, cancels: "never",
  tapCadenceMs: 400,
};

/** Someone playing properly: every bubble, every hazard, the placard answered, the
 *  Explode held until it is worth something. The rung the loss-less target is aimed at. */
export const COMPETENT: PilotProfile = {
  id: "competent",
  reactionMs: 300, missChance: 0.08,
  popButterflies: true, useBash: true, useMini: true, explodeMinTargets: 2,
  tapHazards: true, rescueGrabs: true, pickSigns: true, interrupts: true, cancels: "always",
  tapCadenceMs: TOUCH_TAPS.cooldownMs,
};

/** The ceiling a human can plausibly reach. Still bounded by a reaction time and by the
 *  transcript budget — it is not an oracle, and it is not meant to be one: a pilot with
 *  no reaction time measures a fight no client could even transmit. */
export const EXPERT: PilotProfile = {
  id: "expert",
  reactionMs: 150, missChance: 0,
  popButterflies: true, useBash: true, useMini: true, explodeMinTargets: 3,
  tapHazards: true, rescueGrabs: true, pickSigns: true, interrupts: true, cancels: "worst",
  tapCadenceMs: TOUCH_TAPS.cooldownMs,
};

export const PILOT_LADDER: readonly PilotProfile[] = [IDLE, CASUAL, COMPETENT, EXPERT];

/** What the saucer's casts cost an army that is trying not to lose anybody, worst first.
 *  The blast takes a slice off every deployed zombie, the army stun and the portal hand the
 *  wave free time or throw half the line to the back; the wall and the robot cost tempo,
 *  and tempo is cheaper than a casualty. `worst` spends only on the first three — with five
 *  cancels for the whole fight, that is what holding them back means. */
const CAST_COST: Readonly<Record<string, number>> = {
  aoe: 5, stunAll: 4, portal: 3, robot: 2, wall: 1,
};
const CANCEL_WORTH_IT = new Set(["aoe", "stunAll", "portal"]);

/** THE INTERRUPT MENU (raid 13), cheapest answer first.
 *
 *  Priced the way the fight prices them (dualInvasion.POISE_CONTRIBUTION). Smash is half a
 *  bar and comes back every ten seconds, so it is the answer you want to be using; the
 *  fuse and the ram are each a whole bar but cost you the zombie or the mini, so they are
 *  what you spend when Smash is not back yet and the slam is landing anyway.
 *
 *  `stun` is deliberately absent even though it contributes 0.1: ten Female procs to break
 *  one charge is not a plan, it is a rounding error, and a pilot that "spent an interrupt"
 *  on it would report having answered a slam it did not answer. It still counts toward the
 *  bar in the sim — it is just never the reason a pilot presses a button. */
const INTERRUPTS: readonly { key: string; poise: number }[] = [
  { key: "bashV2", poise: 0.5 },
  { key: "explodeV2", poise: 1 },
  { key: "explode", poise: 1 },
  { key: "attachMini", poise: 1 },
];

/** Keys a banking pilot will not spend on the wave, because they are the only things that
 *  stop a slam. Smash and the fuse only — the Mini Buddy stays available as the pre-deploy
 *  buff it also is, and is reached for as an interrupt only when nothing else can fill the
 *  bar in time. */
const BANKED = new Set(["bashV2", "explode", "explodeV2"]);

/** Enemies a player can see and an area attack can reach — the same set BattleSim's own
 *  blast loop walks. A converted pixel zombie is excluded: it is one of YOUR zombies with
 *  a million hit points and the army is not supposed to be fighting it. */
function onField(sim: BattleSim): SimUnit[] {
  return sim.units.filter((u) =>
    u.team === "enemy" && u.alive && !u.isWall && !u.isTurned &&
    u.state !== "queued" && u.state !== "structure" && u.state !== "descending");
}

export function makePilot(profile: PilotProfile): Pilot {
  /** When each opportunity was first seen, by identity. */
  let seenAt = new Map<string, number>();
  /** Opportunities this player already blew the roll on. */
  let missed = new Set<string>();
  /** Last tick a given hazard was tapped, so repeats are paced rather than spammed. */
  let tappedAt = new Map<string, number>();
  /** Per channel, how many times the thing has appeared. An opportunity's identity is
   *  channel + count, so a move coming off cooldown a second time is a second chance to
   *  be late or to miss it — and a single wait cannot be silently restarted by an
   *  identity that drifts underneath it. */
  let epochs = new Map<string, number>();
  let wasLive = new Set<string>();
  let rand = seededRandom("pilot");

  const latencyTicks = profile.reactionMs === Infinity
    ? Infinity : Math.max(0, Math.round(profile.reactionMs / RAID_TICK_MS));
  const cadenceTicks = Math.max(1, Math.round(profile.tapCadenceMs / RAID_TICK_MS));

  /** Has this player noticed `key` long enough ago to act, and not fluffed it?
   *  The miss roll happens on FIRST SIGHT, so one opportunity is one roll. */
  const acts = (key: string, tick: number): boolean => {
    if (latencyTicks === Infinity) return false;
    let first = seenAt.get(key);
    if (first === undefined) {
      first = tick;
      seenAt.set(key, tick);
      if (profile.missChance > 0 && rand() < profile.missChance) missed.add(key);
    }
    return !missed.has(key) && tick - first >= latencyTicks;
  };

  /** Rising-edge counter: bump `channel`'s epoch each time it goes from absent to
   *  present, and hand back the identity of the occurrence happening now. */
  const epoch = (channel: string, live: boolean): string => {
    if (live && !wasLive.has(channel)) {
      wasLive.add(channel);
      epochs.set(channel, (epochs.get(channel) ?? 0) + 1);
    } else if (!live) {
      wasLive.delete(channel);
    }
    return `${channel}#${epochs.get(channel) ?? 0}`;
  };

  /** Pace repeated taps on one target at the profile's cadence. */
  const canTap = (key: string, tick: number): boolean => {
    const last = tappedAt.get(key);
    if (last !== undefined && tick - last < cadenceTicks) return false;
    tappedAt.set(key, tick);
    return true;
  };

  return {
    id: profile.id,
    reset(seed: string) {
      seenAt = new Map();
      missed = new Set();
      tappedAt = new Map();
      epochs = new Map();
      wasLive = new Set();
      rand = seededRandom(`pilot:${profile.id}:${seed}`);
    },
    decide(sim, tick): PilotAction | null {
      if (latencyTicks === Infinity) return null;

      // ORDER IS THE POLICY. One action per tick, so what comes first is what a player
      // reaches for first — and the ranking is by what it costs to be late. A zombie
      // being carried off the field or burning is a casualty in progress; a placard or a
      // cast has a hard window; a bubble is only throughput. The wall is last of the
      // hazards because the army is already chewing on it.

      // 1. The placard. A narrow window, one tap, and getting it wrong benches a whole
      //    class — the highest value per input in the game.
      if (profile.pickSigns) {
        const offer = sim.signOffer();
        const index = sim.signOfferIndex();
        if (offer && index !== null && sim.signPick() === null && acts(`sign:${index}`, tick)) {
          return { type: "signPick", offer: index, option: cheaperBench(sim, offer) };
        }
      }

      // 2. The saucer's cast. Also a hard window, and `aoe`/`portal` are the two casts
      //    that can turn a clean fight into a lossy one.
      if (profile.cancels !== "never" && sim.cancelsLeft() > 0) {
        const cast = sim.bubbleCast();
        const id = epoch("cast", !!cast);
        // One cancel per activation, never into the t9 lockout (the sim would refuse it),
        // and under the t10 dual cast on whichever of the pair costs the army more.
        if (cast && cast.cancelled === null && !sim.cancelLocked()) {
          let slot = 0;
          for (let k = 1; k < cast.actions.length; k++) {
            if ((CAST_COST[cast.actions[k]] ?? 0) > (CAST_COST[cast.actions[slot]] ?? 0)) slot = k;
          }
          const action = cast.actions[slot];
          if (profile.cancels === "always" || CANCEL_WORTH_IT.has(action)) {
            if (acts(id, tick)) return slot ? { type: "castCancel", slot } : { type: "castCancel" };
          }
        }
      }

      // 3. The captain's charge. A hard window like the two above, and the only one whose
      //    answer has to be SAVED UP rather than merely noticed — see the bank below.
      const charge = profile.interrupts ? sim.chargeStatus() : null;
      if (charge) {
        const need = charge.threshold - charge.poise;
        const ready = new Map(sim.activatedGroupStatus().map((g) => [g.key, g.ready]));
        // Cheapest sufficient answer first, then the cheapest that at least advances the
        // bar — two Smashes across two ticks break a charge the same as one fuse, and
        // cost nothing, so a pilot that can reach the bar in halves always should.
        const pick =
          INTERRUPTS.find((i) => (ready.get(i.key) ?? 0) > 0 && i.poise >= need) ??
          INTERRUPTS.find((i) => (ready.get(i.key) ?? 0) > 0);
        // Keyed on the wind-up, not the ability: one charge is one decision, and being
        // late on it should cost the slam rather than silently retry next tick.
        const id = epoch("charge", true);
        if (pick && acts(id, tick)) return { type: "ability", abilityKey: pick.key };
      } else {
        epoch("charge", false);
      }

      // 4. The two client-only rescues. A zombie in a trapeze or a crab is out of the
      //    fight and on its way to being lost.
      if (profile.rescueGrabs) {
        const grabber = sim.activeGrabber();
        if (grabber && acts(`grab:${grabber.id}`, tick) && canTap(`grab:${grabber.id}`, tick)) {
          return { type: "grabberTap", id: grabber.id };
        }
        const crab = sim.activeCrabs().find((c) => c.grabbedId);
        if (crab && acts(`crab:${crab.id}`, tick) && canTap(`crab:${crab.id}`, tick)) {
          return { type: "crabTap", id: crab.id };
        }
        // The Mega-Robot's lit eyes: a zombie dies when the fuse runs out. One fuse is one
        // occurrence, so a miss costs that shot rather than retrying next tick.
        const bot = sim.megaBotCharging();
        const shot = epoch("megaBot", !!bot);
        if (bot && acts(shot, tick) && canTap("megaBot", tick)) {
          return { type: "megaBotTap" };
        }
      }

      if (profile.tapHazards) {
        // 4. A converted zombie — one of yours, turned, with a body the army cannot chew
        //    through. Taps are the only way to get it back.
        const turned = sim.turnedEnemies()[0];
        if (turned && acts(`turn:${turned.id}`, tick) && canTap(`turn:${turned.id}`, tick)) {
          return { type: "turnedTap", unitId: turned.id };
        }
        // 6. A burning zombie.
        const burning = sim.burningPlayers()[0];
        if (burning && acts(`fire:${burning.id}`, tick) && canTap(`fire:${burning.id}`, tick)) {
          return { type: "fireTap", unitId: burning.id };
        }
      }

      // 7. The focus bubble. Only one zombie charges at a time, so this is the whole
      //    army's deployment queue: leaving it un-popped is the single largest standing
      //    cost of not playing, and it is the one the old harness paid on every fight.
      const bubble = sim.chargingBubble();
      const bubbleId = epoch("bubble", !!bubble);
      if (bubble && (bubble.kind === "brain" || profile.popButterflies)) {
        if (acts(bubbleId, tick)) return { type: "bubble", unitId: bubble.id };
      }

      // 8. Activated moves, read off the STRIP the player is looking at — including
      //    `nextInGroup`'s choice of which key a stacked button fires, so the pilot
      //    spends the same move a tap would. Every button's edge is advanced first, so a
      //    move further down the list does not miss its own rising edge just because
      //    something above it was taken this tick.
      const groups = sim.activatedGroupStatus();
      const readyIds = new Map(groups.map((g) => [g.key, epoch(`ab:${g.key}`, g.ready > 0)]));
      for (const group of groups) {
        if (!group.ready) continue;
        const key = group.key;
        if (key === "attachMini" && !profile.useMini) continue;
        if ((key === "bash" || key === "bashV2") && !profile.useBash) continue;
        // THE BANK. On a fight with a charging enemy, the moves that fill the poise bar
        // are not wave clear — they are the only answer to the slam, and a slam is coming
        // every windup + 2.5 s whatever the army is doing. Spending Smash on a minion is
        // how the harness used to eat thirteen slams a fight without meaning to.
        //
        // Held only while the captain is ALIVE and only on a fight that has one, so this
        // never quietly benches a move on the other thirty-three fights; the wind-up
        // branch above is what spends them.
        if (profile.interrupts && BANKED.has(key) && sim.hasCharge()) continue;
        if (key === "explode" || key === "explodeV2") {
          // The army's biggest single hit, and it kills the zombie that throws it — so
          // spending it into one enemy is a casualty bought for nothing.
          if (onField(sim).length < profile.explodeMinTargets) continue;
        }
        // Keyed on the readiness EDGE: the badge dropping to zero and coming back is a
        // new opportunity, and a fresh chance to be late or to miss it.
        if (acts(readyIds.get(key) ?? key, tick)) return { type: "ability", abilityKey: key };
      }

      // 9. The boss wall, last: the army is already hitting it, so a tap only hurries
      //    something that is happening anyway.
      if (profile.tapHazards) {
        const wall = sim.units.find((u) => u.isWall && u.alive);
        if (wall && acts(`wall:${wall.id}`, tick) && canTap(`wall:${wall.id}`, tick)) {
          return { type: "wallTap", unitId: wall.id };
        }
      }

      return null;
    },
  };
}

/** Which bubble to take: the one that benches the classes this army leans on least.
 *
 *  Counted over LIVE zombies rather than the whole roster, because a class that has
 *  already been wiped out costs nothing to give up — and weighted by remaining health,
 *  so benching three zombies on their last legs beats benching one that is untouched.
 *  Ties go to option 0, which is arbitrary and has to be: the mechanic is a dilemma. */
function cheaperBench(sim: BattleSim, offer: readonly [readonly string[], readonly string[]]): 0 | 1 {
  const cost = (groups: readonly string[]): number =>
    sim.units.reduce((sum, p) =>
      p.team === "player" && p.alive && p.group && groups.includes(p.group)
        ? sum + Math.max(0, p.hp) : sum, 0);
  return cost(offer[1]) < cost(offer[0]) ? 1 : 0;
}
