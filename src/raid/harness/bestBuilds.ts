// What the BEST party can do on the hardest fights — and specifically, whether any of
// them brings everybody home.
//
// THE QUESTION THE STRENGTH GRID CANNOT ANSWER. That table reports mean casualties across
// every flight in a band, so a cell reading "70% / 7.4 lost" folds two different things
// together: the 30% that were wiped at sixteen, and the 70% that won at some cost. The
// number a player actually feels is the second one — what a WIN costs — and the loss-less
// target ("mid-late invasions doable loss-less with a powerful army and good inputs") is a
// claim about whether that cost can reach zero. Averaging wipes into it hides the answer
// in both directions.
//
// It also cannot answer it because a band is not a build. Twenty-five rosters sampled into
// a strength bin differ on composition, order, species and duplicate cap all at once, so a
// band tells you what the MIDDLE of that cloud does and nothing about its best corner.
//
// So this module drops the sampler and enumerates builds on purpose. Five axes, each one a
// decision a player actually makes, and every combination of them flown against every hard
// fight:
//
//   · SHAPE      how many Headless and how many Garden, from the bare floor (1/2) up to
//                half the army (6/4, 5/5, 4/6). This is the axis the strength grid was
//                accidentally measuring, so here it is measured deliberately.
//   · FILLER     what the remaining slots are: one damage class, or a split of two.
//   · ORDER      interleave / frontLoad / grouped. The army array IS the formation and one
//                zombie charges every 3.6 s, so where the support sits in a sixteen-strong
//                queue decides whether it arrives before the fight is decided.
//   · PLAN       which species take the slots. `power` is the strongest of each class;
//                `reviveGarden` puts the best RESURRECT carrier at the head of the Garden
//                list instead, because the strongest Gardens (the Doctors) traded Resurrect
//                for a laser; `boomRevive` adds the best Explode carrier at the head of the
//                Small list, which is a deliberate casualty the Resurrect is there to undo.
//   · CAP        uncapped (a ceiling roster that may field ten of one species) against at
//                most two of any species (what an account that earns its prizes one at a
//                time can actually field). Both are reported, because "the best build" and
//                "the best build you could own" are different questions and the gap between
//                them is worth seeing.
//
// Every build is otherwise identical — sixteen bodies, level 50, Master rank, best-in-slot
// mutations, the farmer's life head — so a difference between two rows is the axis and not
// the account.
import raidsJson from "../../../public/assets/raids/raids.json";
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot } from "./pilots";
import { harnessFight } from "./raidFight";
import { ORDER_POLICIES, orderOf, type Composition, type OrderPolicy } from "./composition";
import { appropriateAt, bestCarrierOf, buildRoster, eliteReachableAt, GROUPS, type Group, type RosterSpec } from "./roster";
import type { RaidDef } from "../types";

const raids = raidsJson as RaidDef[];

export const BUILD_SHARDS = 6;
/** Sixteen bodies, like the strength grid, so the two tables compare. */
export const BUILD_SIZE = 16;
/** The account every build belongs to: level cap, Master, Pot-fed, life head. */
export const BUILD_LEVEL = 50;
/** Wave seeds per build. Three rather than two because a loss-less claim is a claim about
 *  every evening, and one unlucky Robots boss should not be able to make it or break it. */
export const BUILD_SEEDS = 3;

// ---------------------------------------------------------------------------
// THE FIGHTS
// ---------------------------------------------------------------------------

/** The hard end of the game: every dual-invasion rung above the first, plus the three
 *  elites the strength grid still shows costing a powerful army real casualties. Raid 3's
 *  elite is on the list by name — the Pirates are the fight the owner cites as the one
 *  "where several zombie deaths are expected if they're not careful", which makes it the
 *  natural test of whether a Resurrect build changes that. */
export interface HardFight {
  raidId: number;
  tier?: number;
  elite?: boolean;
}

const HARD: readonly HardFight[] = [
  { raidId: 3, elite: true },
  { raidId: 6, elite: true },
  { raidId: 9, elite: true },
  { raidId: 12, tier: 5 }, { raidId: 12, tier: 10 },
  { raidId: 13, tier: 1 }, { raidId: 13, tier: 5 }, { raidId: 13, tier: 10 },
  { raidId: 14, tier: 1 }, { raidId: 14, tier: 5 }, { raidId: 14, tier: 10 },
  { raidId: 15, tier: 5 }, { raidId: 15, tier: 10 },
];

export interface FightRow {
  label: string;
  raidId: number;
  tier: number;
  elite: boolean;
  /** Where the fight sits in the game, for row ordering — the same rule the strength grid
   *  uses, so the two tables list things in the same sequence. */
  unlock: number;
  /** The level the WAVE is scaled to: the raid's own recommended level. */
  fightLevel: number;
}

export function hardFights(): FightRow[] {
  const out: FightRow[] = [];
  for (const f of HARD) {
    const raid = raids.find((r) => r.id === f.raidId);
    if (!raid) continue;
    const unlockLevel = (raid as { unlockLevel?: number }).unlockLevel ?? 0;
    const tier = f.tier ?? 0;
    out.push({
      label: `${raid.id} ${raid.name}${f.elite ? " ★" : ""}${tier ? ` t${tier}` : ""}`,
      raidId: raid.id,
      tier,
      elite: !!f.elite,
      unlock: (f.elite ? eliteReachableAt(raid.id) : unlockLevel) + tier / 100,
      fightLevel: raid.recommendedLevel,
    });
  }
  return out.sort((a, b) => a.unlock - b.unlock || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// THE BUILDS
// ---------------------------------------------------------------------------

/** Headless / Garden counts worth flying, from the party floor up to half the army. */
const SHAPES: readonly (readonly [number, number])[] = [
  [1, 2], [2, 2], [2, 4], [2, 6], [3, 3], [3, 5],
  [4, 2], [4, 4], [4, 6], [5, 3], [5, 5], [6, 2], [6, 4],
];

/** What fills the slots the support does not take. A single class, or an even split of
 *  two — which is the "8 brute, 8 mini" shape and also the only way two damage auras are
 *  on the field at once. */
const FILLERS: Readonly<Record<string, readonly Group[]>> = {
  regular: ["Regular"],
  large: ["Large"],
  female: ["Female"],
  small: ["Small"],
  "regular+large": ["Regular", "Large"],
  "regular+female": ["Regular", "Female"],
};

/** Which species take the slots. See the header. */
export const PLANS = ["power", "reviveGarden", "boomRevive"] as const;
export type Plan = (typeof PLANS)[number];

/** Duplicate caps flown. `0` means uncapped — a ceiling roster. */
const CAPS: readonly number[] = [0, 2];

/** The species preference list per class under a plan, best first.
 *
 *  Always the full level-appropriate shortlist, so a capped build has somewhere to fall
 *  through to; a plan only changes WHICH member of a class leads it. That is the whole
 *  mechanism by which a player "builds for an ability": at the top of the stat ranking the
 *  Doctors have no Resurrect and the Zombug has no Explode, so asking for either means
 *  putting a slightly weaker body at the head of the list. */
function speciesFor(plan: Plan, level: number): Partial<Record<Group, readonly string[]>> {
  const out: Partial<Record<Group, readonly string[]>> = {};
  for (const group of GROUPS) {
    const options = appropriateAt(group, level);
    if (options.length) out[group] = options.map((z) => z.key);
  }
  const lead = (group: Group, ability: string) => {
    const carrier = bestCarrierOf(group, level, ability);
    if (!carrier) return;
    out[group] = [carrier.key, ...(out[group] ?? []).filter((k) => k !== carrier.key)];
  };
  if (plan === "reviveGarden" || plan === "boomRevive") lead("Garden", "ressurect");
  if (plan === "boomRevive") lead("Small", "explode");
  return out;
}

export interface Build {
  id: string;
  /** "H3G3" — the support shape, which is the axis most of the answers turn on. */
  shape: string;
  headless: number;
  garden: number;
  filler: string;
  order: OrderPolicy;
  plan: Plan;
  /** 0 = uncapped. */
  cap: number;
  strength: number;
  /** How many distinct species it actually fields — how min-maxed it is. */
  species: number;
  spec: RosterSpec;
}

/** Every combination of the five axes, as a flat list. Deterministic and order-stable, so
 *  a build id means the same thing between runs and two rulesets can be diffed. */
export function buildGrid(): Build[] {
  const out: Build[] = [];
  for (const [headless, garden] of SHAPES) {
    const rest = BUILD_SIZE - headless - garden;
    if (rest < 1) continue;
    for (const [fillerName, classes] of Object.entries(FILLERS)) {
      const composition: Composition = { Headless: headless, Garden: garden };
      // An odd remainder splits with the surplus on the first class named, which keeps
      // "regular+large" meaning Regular-leaning rather than rounding somewhere arbitrary.
      classes.forEach((g, i) => {
        composition[g] = Math.floor(rest / classes.length) + (i < rest % classes.length ? 1 : 0);
      });
      for (const order of ORDER_POLICIES) {
        // `shuffled` is the sampler's control and has no meaning for a named build — a
        // build a player follows is a build they can repeat.
        if (order === "shuffled") continue;
        // The order policies take a random source only for `shuffled`; the three kept here
        // are deterministic, so the generator is never consulted.
        const pattern = orderOf(composition, order, () => 0);
        if (pattern.length !== BUILD_SIZE) continue;
        for (const plan of PLANS) {
          for (const cap of CAPS) {
            const spec: RosterSpec = {
              pattern,
              size: BUILD_SIZE,
              species: speciesFor(plan, BUILD_LEVEL),
              maxPerSpecies: cap || undefined,
              catalogLevel: BUILD_LEVEL,
              playerLevel: BUILD_LEVEL,
              invasions: 5,
              mutation: "best",
              abilityTiers: 4,
              farmerLifeMult: 1.1,
            };
            const roster = buildRoster(spec);
            out.push({
              id: `H${headless}G${garden}/${fillerName}/${order}/${plan}/${cap || "free"}`,
              shape: `H${headless}G${garden}`,
              headless, garden,
              filler: fillerName,
              order,
              plan,
              cap,
              strength: roster.strength,
              species: new Set(roster.party.map((p) => p.key)).size,
              spec,
            });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE MEASUREMENT
// ---------------------------------------------------------------------------

export interface BuildResult {
  id: string;
  shape: string;
  headless: number;
  garden: number;
  filler: string;
  order: string;
  plan: string;
  cap: number;
  strength: number;
  species: number;
  flights: number;
  wins: number;
  /** Wins that cost nothing. The loss-less target, counted per FLIGHT. */
  clean: number;
  /** True when every seed won, and every seed won clean — the build actually clears the
   *  fight loss-lessly rather than having managed it once. */
  alwaysClean: boolean;
  alwaysWins: boolean;
  /** Mean casualties over the WINNING flights only: what a win costs. The strength grid's
   *  figure averages wipes into this and so cannot be compared with it. */
  meanLossOnWin: number;
  /** Mean RESURRECTIONS on the winning flights, and whether the build clears without
   *  needing any.
   *
   *  A loss-less clear is not one thing. The owner's rule is that a revived zombie is not
   *  a casualty — "the resurrection ability can undo casualties, including the explosion
   *  one" — so both of these count as zero losses:
   *
   *    · nobody fell;
   *    · eight fell and eight got back up.
   *
   *  They score identically and feel nothing alike, and the second is capped in a way the
   *  first is not: Resurrect is ONE USE PER CARRIER and a revived carrier is latched out
   *  (BattleSim `resurrectUsed`), so an army has exactly as many second chances as it has
   *  holders and no more. Reporting them apart is the difference between "this build
   *  beats the fight" and "this build survives the fight by spending its revives". */
  meanRevivesOnWin: number;
  /** Every seed won, cost nothing, AND needed no revive: the fight never touched it. */
  alwaysUntouched: boolean;
  /** Mean casualties over every flight, for continuity with the strength grid. */
  meanLoss: number;
  medianWinSecs: number | null;
  timeouts: number;
  deadlocks: number;
}

export interface BuildRow {
  label: string;
  unlock: number;
  fightLevel: number;
  builds: BuildResult[];
}

export function runBuildShard(shard: number, shards: number): BuildRow[] {
  const grid = buildGrid();
  const out: BuildRow[] = [];

  for (const fight of hardFights().filter((_, i) => i % shards === shard)) {
    const builds: BuildResult[] = [];
    for (const build of grid) {
      let wins = 0, clean = 0, loss = 0, lossOnWin = 0, timeouts = 0, deadlocks = 0;
      let revivesOnWin = 0, untouched = 0;
      const winSecs: number[] = [];
      for (let s = 0; s < BUILD_SEEDS; s++) {
        // Rebuilt per flight: the sim mutates its units, so a shared array would carry one
        // fight's damage into the next.
        const roster = buildRoster(build.spec);
        const seed = `build:${build.id}:${fight.raidId}:${fight.tier}:${s}`;
        const { spec } = harnessFight({
          raidId: fight.raidId,
          tier: fight.tier,
          elite: fight.elite,
          hazards: true,
          playerLevel: fight.fightLevel,
          playerUnits: roster.units,
          waveSeed: seed,
        });
        const f = flyFight(buildFight(spec), makePilot(EXPERT), { seed });
        const revives = f.outcome.feats?.resurrections.length ?? 0;
        loss += f.losses;
        if (f.win) { wins++; lossOnWin += f.losses; revivesOnWin += revives; winSecs.push(f.secs); }
        if (f.win && f.losses === 0) clean++;
        if (f.win && f.losses === 0 && revives === 0) untouched++;
        if (f.timedOut) timeouts++;
        if (f.deadlocked) deadlocks++;
      }
      winSecs.sort((a, b) => a - b);
      builds.push({
        id: build.id,
        shape: build.shape,
        headless: build.headless,
        garden: build.garden,
        filler: build.filler,
        order: build.order,
        plan: build.plan,
        cap: build.cap,
        strength: Math.round(build.strength),
        species: build.species,
        flights: BUILD_SEEDS,
        wins,
        clean,
        alwaysWins: wins === BUILD_SEEDS,
        alwaysClean: clean === BUILD_SEEDS,
        meanLossOnWin: wins ? lossOnWin / wins : 0,
        meanRevivesOnWin: wins ? revivesOnWin / wins : 0,
        alwaysUntouched: untouched === BUILD_SEEDS,
        meanLoss: loss / BUILD_SEEDS,
        medianWinSecs: winSecs.length ? winSecs[Math.floor(winSecs.length / 2)] : null,
        timeouts,
        deadlocks,
      });
    }
    out.push({ label: fight.label, unlock: fight.unlock, fightLevel: fight.fightLevel, builds });
  }
  return out;
}
