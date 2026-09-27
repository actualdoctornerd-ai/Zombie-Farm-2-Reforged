// WHAT IS THIS FIGHT'S MECHANIC ACTUALLY WORTH?
//
// The four dual invasions are built mechanics-first — dualInvasion.ts says so outright:
// "the difficulty of these fights is not meant to be in their stats … the tier ladder is
// supposed to introduce and tighten THOSE before it touches a multiplier." That is a
// design intention, and right now there is no number attached to it, so a rebalance would
// be tuning by feel against a harness that cannot see whether it worked.
//
// This is the number. For one fight, fly a pool of good armies twice: once by a pilot that
// plays everything, and once by the same pilot with ONE INPUT REMOVED. The gap is what
// that input is worth on that fight. Applied to the fight's OWN mechanic, it is the
// headline — the price of ignoring what the fight is about.
//
// WHY NOT THE casual → competent GAP, which the strength grid already has. Because that
// step turns on three separate things at once (the placard, the cancel budget, every
// hazard tap) and tightens reaction time and the miss roll at the same time. A raid-15
// reading off it is contaminated by trapeze taps, and a raid-12 reading by both. Leaving
// exactly one channel out of an otherwise identical pilot is the only way the delta is
// attributable.
//
// LEAVE-ONE-OUT ACROSS EVERY CHANNEL, not just the fight's own, because the interesting
// answer is often somewhere else: raid 14's biggest single input turns out to be the
// trapeze rescue rather than anything to do with its copies, and a table that only ever
// asked about copies would never have found that.
//
// A NOTE ON WHAT "THE MECHANIC" MEANS PER FIGHT, because the four are not alike:
//
//   12  the objection  — one tap, one bubble. `pickSigns` is exactly it.
//   15  the bubble     — the cancel budget. `cancels` is exactly it.
//   13  the charge     — the poise interrupt. Needs `interrupts`, which only became
//                        expressible once BattleSim grew a charge observer; before that
//                        this row read zero because the pilot could not see a wind-up.
//   14  the copies     — HAS NO INPUT. A copy is made per DEPLOYMENT, of whichever zombie
//                        the player released, so the lever is the roster order and the
//                        decision of when to pop a focus bubble — both of which the sweep
//                        varies but neither of which is a channel that can be switched
//                        off. Its row therefore reports the trapeze instead, and the
//                        honest reading of raid 14 is that its mechanic is answered
//                        before the fight starts rather than during it.
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot, type PilotProfile } from "./pilots";
import { harnessFight } from "./raidFight";
import { buildRoster } from "./roster";
import { strengthPool, type SweepRoster } from "./strengthSweep";
import {
  BUBBLE_RAID_ID, CHARGE_RAID_ID, BIG_TOP_RAID_ID, SIGN_RAID_ID,
} from "../dualInvasion";
import raidsJson from "../../../public/assets/raids/raids.json";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

export const MECHANIC_SHARDS = 6;
/** Wave seeds per roster. */
export const MECHANIC_SEEDS = 2;
/** Which strength bands the pool is drawn from. The question is "does a player who has
 *  the army for this fight still need the mechanic", so the weak bands would only add
 *  rows that lose either way and dilute the delta. */
export const MECHANIC_BANDS: readonly number[] = [5, 6, 7];

// ---------------------------------------------------------------------------
// CHANNELS
// ---------------------------------------------------------------------------

/** One switchable thing a player does. Each maps to the profile fields that turn it off
 *  and nothing else, so a delta is attributable to the name on the tin. */
export type Channel = "objection" | "cancels" | "interrupt" | "hazards" | "rescues" | "bubbles";

export const CHANNELS: readonly Channel[] = [
  "objection", "cancels", "interrupt", "hazards", "rescues", "bubbles",
];

export const CHANNEL_LABEL: Readonly<Record<Channel, string>> = {
  objection: "answer the placard",
  cancels: "spend the cancel budget",
  interrupt: "break the captain's charge",
  hazards: "tap fire / turned / wall",
  rescues: "tap the trapeze and the crab",
  bubbles: "pop the focus bubbles",
};

const CHANNEL_OFF: Readonly<Record<Channel, Partial<PilotProfile>>> = {
  objection: { pickSigns: false },
  cancels: { cancels: "never" },
  interrupt: { interrupts: false },
  hazards: { tapHazards: false },
  rescues: { rescueGrabs: false },
  // The brain bubble gates the deploy queue, so leaving it alone is not "skip a nicety",
  // it is "deploy at the sim's own pace". Kept as a channel because it is the single
  // largest standing cost of not playing and belongs on the same scale as the rest.
  bubbles: { popButterflies: false },
};

/** `base` with one channel switched off. */
export function without(base: PilotProfile, channel: Channel): PilotProfile {
  return { ...base, ...CHANNEL_OFF[channel], id: `${base.id}-${channel}` };
}

/** The channel a fight's OWN mechanic lives on, or null where the fight has no mechanic
 *  a player can decline. See the header for raid 14. */
export function ownChannel(raidId: number): Channel | null {
  if (raidId === SIGN_RAID_ID) return "objection";
  if (raidId === CHARGE_RAID_ID) return "interrupt";
  if (raidId === BUBBLE_RAID_ID) return "cancels";
  if (raidId === BIG_TOP_RAID_ID) return "rescues";
  return null;
}

/** THE HEADLINE PILOT: plays everything an expert plays, except the thing this fight is
 *  about. `expert − mechanicBlind` is the price of ignoring the mechanic. */
export function mechanicBlind(raidId: number): PilotProfile {
  const channel = ownChannel(raidId);
  return channel ? { ...without(EXPERT, channel), id: "blind" } : { ...EXPERT, id: "blind" };
}

// ---------------------------------------------------------------------------
// THE FIGHTS
// ---------------------------------------------------------------------------

export interface MechanicFight {
  raidId: number;
  tier: number;
  elite: boolean;
  label: string;
  fightLevel: number;
  /** The channel this fight's own mechanic lives on, for the headline column. */
  own: Channel | null;
}

export function mechanicFights(): MechanicFight[] {
  const out: MechanicFight[] = [];
  const at = (raidId: number, tier: number, elite: boolean) => {
    const raid = raids.find((r) => r.id === raidId);
    if (!raid) return;
    out.push({
      raidId, tier, elite,
      label: `${raid.id} ${raid.name}${elite ? " ★" : ""}${tier ? ` t${tier}` : ""}`,
      fightLevel: raid.recommendedLevel,
      own: ownChannel(raidId),
    });
  };
  for (const id of [SIGN_RAID_ID, CHARGE_RAID_ID, BIG_TOP_RAID_ID, BUBBLE_RAID_ID]) {
    for (const tier of [1, 5, 10]) at(id, tier, false);
  }
  // Controls. Two hazard raids and one that has none, so the table shows what the metric
  // reads where there is nothing to find — a channel that matters nowhere else should
  // come back at zero here, and if it does not, the metric is measuring the pilot.
  at(8, 0, true);
  at(6, 0, true);
  at(4, 0, true);
  return out;
}

// ---------------------------------------------------------------------------
// THE MEASUREMENT
// ---------------------------------------------------------------------------

export interface ChannelResult {
  channel: string;
  flights: number;
  winRate: number;
  losslessRate: number;
  meanLosses: number;
}

export interface MechanicRow {
  label: string;
  raidId: number;
  tier: number;
  own: Channel | null;
  rosters: number;
  /** The full pilot, and then one entry per channel with that channel removed. */
  results: ChannelResult[];
}

function measureWith(
  fight: MechanicFight,
  pool: readonly SweepRoster[],
  profile: PilotProfile
): ChannelResult {
  let wins = 0, clean = 0, losses = 0, n = 0;
  for (const roster of pool) {
    for (let s = 0; s < MECHANIC_SEEDS; s++) {
      // Rebuilt per flight: the sim mutates its units.
      const built = buildRoster(roster.spec);
      const seed = `mech:${fight.raidId}:${fight.tier}:${profile.id}:${roster.strength.toFixed(0)}:${s}`;
      const { spec } = harnessFight({
        raidId: fight.raidId,
        tier: fight.tier || undefined,
        elite: fight.elite,
        hazards: true,
        playerLevel: fight.fightLevel,
        playerUnits: built.units,
        waveSeed: seed,
      });
      const f = flyFight(buildFight(spec), makePilot(profile), { seed });
      n++;
      if (f.win) wins++;
      if (f.win && f.losses === 0) clean++;
      losses += f.losses;
    }
  }
  return {
    channel: profile.id,
    flights: n,
    winRate: n ? wins / n : 0,
    losslessRate: n ? clean / n : 0,
    meanLosses: n ? losses / n : 0,
  };
}

export function runMechanicShard(shard: number, shards: number): MechanicRow[] {
  const pool = strengthPool().filter((r) => MECHANIC_BANDS.includes(r.bin));
  const out: MechanicRow[] = [];

  for (const fight of mechanicFights().filter((_, i) => i % shards === shard)) {
    const results: ChannelResult[] = [measureWith(fight, pool, EXPERT)];
    for (const channel of CHANNELS) {
      results.push(measureWith(fight, pool, without(EXPERT, channel)));
    }
    out.push({
      label: fight.label,
      raidId: fight.raidId,
      tier: fight.tier,
      own: fight.own,
      rosters: pool.length,
      results,
    });
  }
  return out;
}
