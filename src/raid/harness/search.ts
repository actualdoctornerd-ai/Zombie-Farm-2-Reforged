// LAYER 3 — finding good armies instead of grading the ones we thought of.
//
// Everything below this is an EVALUATOR. The strength sweep grades a sampled pool, the
// build grid grades 1,404 enumerated shapes, the mechanic table grades one pilot against
// itself. All of them answer "how does THIS army do", and none of them can answer "what is
// the best army for this fight", which is the question a balance pass actually needs: a
// rung is only too hard if nothing clears it, and nothing in the harness could look.
//
// The space is far too big to enumerate. Sixteen slots over ~60 obtainable species, with
// order significant, is 60^16 — and order IS significant, measured: the same sixteen
// zombies reordered went from a two-casualty clear to a loss-less one, and the build grid
// put `grouped`/`frontLoad` 25 points of clean-clear rate ahead of `interleave`. So this
// searches.
//
// THE GENOME IS THE ARMY ARRAY. Sixteen species keys in deploy order — nothing else. That
// is deliberate and it is the reason this can work at all: composition, species choice and
// deploy order are three separate decisions in the rest of the harness, and all three are
// the same sixteen-cell array here, so one set of operators moves all of them and a
// crossover can inherit "the support goes first" from one parent and "use Zombugs" from
// the other.
//
// WHY AN EVOLUTIONARY SEARCH rather than a hill climb. The fitness is measured by flying
// three seeded fights, so it is stochastic and it is cheap-ish but not free; and the space
// has obvious local optima (a mono-species army is a broad plateau). A population keeps
// several basins alive at once and crossover is a good fit for a genome whose building
// blocks are contiguous runs — "four Gardens in slots 2-5" is exactly the sort of thing
// one-point crossover preserves.
//
// EVERY RUN IS DETERMINISTIC. The population seed, the operator rolls and each candidate's
// fight seeds all derive from one string, so a frontier found today can be diffed against
// the same search after a ruleset change and the difference is the ruleset.
import { seededRandom } from "../RaidCatalog";
import { buildFight } from "../buildFight";
import { flyFight } from "./pilot";
import { EXPERT, makePilot, type PilotProfile } from "./pilots";
import { harnessFight } from "./raidFight";
import {
  appropriateAt, buildExplicit, GROUPS, isHealer, type AccountSpec, type Group,
} from "./roster";
import { MIN_HEALERS, MIN_LINE } from "./composition";
import raidsJson from "../../../public/assets/raids/raids.json";
import type { RaidDef } from "../types";
import type { ZombieDef } from "../../assets";

const raids = raidsJson as RaidDef[];

export const SEARCH_SHARDS = 6;
/** Slots in the genome — the base army cap, like everywhere else in the harness. */
export const GENOME_SIZE = 16;
/** Candidates alive at once. Small on purpose: every one costs `SEARCH_SEEDS` fights per
 *  generation, and breadth past this buys less than depth does. */
export const POPULATION = 24;
export const GENERATIONS = 20;
/** Wave seeds a candidate is judged on. Three because a build that wins on its luckiest
 *  seed is not a build that wins, and the search will happily overfit to one if allowed. */
export const SEARCH_SEEDS = 3;
/** Candidates kept untouched into the next generation. */
const ELITES = 4;
/** Entrants per selection tournament. */
const TOURNAMENT = 3;

/** The account every candidate belongs to. Held still so the search moves the ARMY and
 *  nothing else — this is a question about composition, not about progression. */
export const SEARCH_ACCOUNT: AccountSpec = {
  playerLevel: 50, invasions: 5, mutation: "best", abilityTiers: 4, farmerLifeMult: 1.1,
};

/** Sixteen species keys, in deploy order. */
export type Genome = readonly string[];

// ---------------------------------------------------------------------------
// THE ALPHABET
// ---------------------------------------------------------------------------

/** Every species the search may put in a slot, grouped by class.
 *
 *  `appropriateAt` rather than the whole catalog: the search is looking for an army a
 *  player would build, and a shortlist that already drops the Blues keeps the space from
 *  filling with candidates nobody would field. It also keeps the orphaned-ability carriers
 *  in (the Resurrect Garden, the Explode Small), which is what lets the search discover a
 *  revive build rather than being handed one. */
export function alphabet(level = 50): Record<Group, ZombieDef[]> {
  const out = {} as Record<Group, ZombieDef[]>;
  for (const g of GROUPS) out[g] = [...appropriateAt(g, level)];
  return out;
}

const GROUP_OF = (pool: Record<Group, ZombieDef[]>, key: string): Group => {
  for (const g of GROUPS) if (pool[g].some((z) => z.key === key)) return g;
  return "Regular";
};

// ---------------------------------------------------------------------------
// THE CONSTRAINT
// ---------------------------------------------------------------------------

/** Force a genome back inside the party floor, in place of rejecting it.
 *
 *  REPAIR RATHER THAN REJECT, because rejection wastes the whole candidate and most of a
 *  mutated genome is usually fine — and because a floor-violating child is often one slot
 *  away from a good army, which rejection throws out. Slots are taken from the most
 *  numerous class, which is the same rule `enforceFloor` uses on compositions, so a
 *  lopsided candidate keeps its shape.
 *
 *  Repairs from the BACK, so the support the floor adds lands late in the queue rather
 *  than displacing whatever the search put at the front. That matters: the front of the
 *  array is the part the fight sees first, and a repair that overwrote it would be
 *  silently undoing the thing the search is trying to learn. */
export function repair(genome: Genome, pool: Record<Group, ZombieDef[]>): string[] {
  const out = [...genome];
  const countOf = (pred: (key: string) => boolean) => out.filter(pred).length;
  const isHeal = (key: string) => {
    const def = pool[GROUP_OF(pool, key)].find((z) => z.key === key);
    return !!def && isHealer(def);
  };
  const need: { has: () => number; min: number; group: Group }[] = [
    { has: () => countOf(isHeal), min: MIN_HEALERS, group: "Garden" },
    { has: () => countOf((k) => GROUP_OF(pool, k) === "Headless"), min: MIN_LINE, group: "Headless" },
  ];

  for (const req of need) {
    const options = req.group === "Garden" ? pool.Garden.filter(isHealer) : pool[req.group];
    if (!options.length) continue;
    while (req.has() < req.min) {
      // The most numerous class that is not itself a floor class pays, and the LAST slot
      // of it goes, so the head of the queue survives the repair.
      const tally = new Map<Group, number>();
      for (const k of out) {
        const g = GROUP_OF(pool, k);
        tally.set(g, (tally.get(g) ?? 0) + 1);
      }
      let donor: Group | null = null;
      let most = 0;
      for (const [g, n] of tally) {
        if (g === req.group) continue;
        if (g === "Garden" && countOf(isHeal) <= MIN_HEALERS) continue;
        if (g === "Headless" && (tally.get("Headless") ?? 0) <= MIN_LINE) continue;
        if (n > most) { most = n; donor = g; }
      }
      if (!donor) break;
      const at = out.map((k, i) => [k, i] as const)
        .filter(([k]) => GROUP_OF(pool, k) === donor).pop();
      if (!at) break;
      out[at[1]] = options[0].key;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// FITNESS
// ---------------------------------------------------------------------------

export interface Target {
  raidId: number;
  tier?: number;
  elite?: boolean;
  fightLevel: number;
}

export interface Fitness {
  /** Seeds won with zero casualties — the loss-less target, and the primary key. */
  clean: number;
  /** Seeds won at all. */
  wins: number;
  meanLosses: number;
  medianSecs: number;
  /** Strength Ladder of the army, used only to break ties DOWNWARD: between two builds
   *  that do the same thing, the cheaper one is the better answer. */
  strength: number;
}

/** Strictly better, in the order a balance question cares about: bring everybody home
 *  first, then win at all, then lose fewer, then do it with a smaller army. Lexicographic
 *  rather than a weighted sum, because the weights would be inventing an exchange rate
 *  between "a casualty" and "a point of strength" that nobody has. */
export function better(a: Fitness, b: Fitness): boolean {
  if (a.clean !== b.clean) return a.clean > b.clean;
  if (a.wins !== b.wins) return a.wins > b.wins;
  if (Math.abs(a.meanLosses - b.meanLosses) > 1e-9) return a.meanLosses < b.meanLosses;
  return a.strength < b.strength;
}

export function evaluate(
  genome: Genome,
  target: Target,
  profile: PilotProfile = EXPERT,
  seeds = SEARCH_SEEDS
): Fitness {
  let clean = 0, wins = 0, losses = 0;
  const secs: number[] = [];
  let strength = 0;
  for (let s = 0; s < seeds; s++) {
    // Rebuilt per flight: the sim mutates its units.
    const roster = buildExplicit(genome, SEARCH_ACCOUNT);
    strength = roster.strength;
    // Seeded on the GENOME, so the same army is always judged on the same fights however
    // it was arrived at — two searches that find it independently score it identically.
    const seed = `search:${target.raidId}:${target.tier ?? 0}:${genome.join(",")}:${s}`;
    const { spec } = harnessFight({
      raidId: target.raidId,
      tier: target.tier,
      elite: target.elite,
      hazards: true,
      playerLevel: target.fightLevel,
      playerUnits: roster.units,
      waveSeed: seed,
    });
    const f = flyFight(buildFight(spec), makePilot(profile), { seed });
    if (f.win) { wins++; secs.push(f.secs); }
    if (f.win && f.losses === 0) clean++;
    losses += f.losses;
  }
  secs.sort((a, b) => a - b);
  return {
    clean, wins,
    meanLosses: losses / seeds,
    medianSecs: secs.length ? secs[Math.floor(secs.length / 2)] : Infinity,
    strength,
  };
}

// ---------------------------------------------------------------------------
// OPERATORS
// ---------------------------------------------------------------------------

function randomGenome(rand: () => number, pool: Record<Group, ZombieDef[]>): string[] {
  const groups = GROUPS.filter((g) => pool[g].length);
  const out: string[] = [];
  for (let i = 0; i < GENOME_SIZE; i++) {
    const g = groups[Math.floor(rand() * groups.length) % groups.length];
    const options = pool[g];
    out.push(options[Math.floor(rand() * options.length) % options.length].key);
  }
  return repair(out, pool);
}

/** One-point crossover: the head of one parent, the tail of the other.
 *
 *  Order-preserving on purpose. The building blocks this search is trying to find are
 *  CONTIGUOUS RUNS — "the support block goes out first", "eight minis in the middle" — and
 *  one-point crossover is the operator that keeps those intact. A uniform crossover would
 *  shuffle a good front rank into a bad one every time it was used. */
function cross(a: Genome, b: Genome, rand: () => number): string[] {
  const cut = 1 + Math.floor(rand() * (GENOME_SIZE - 1));
  return [...a.slice(0, cut), ...b.slice(cut)];
}

/** Three kinds of change, because there are three kinds of decision in the genome.
 *
 *  A SWAP moves a zombie earlier or later without changing who is in the army — the
 *  deploy-order decision on its own. A RESKIN changes one slot's species inside its class,
 *  which is the "which Garden" decision. A REROLL changes the class outright, which is the
 *  composition decision. Keeping them separate means the search can refine an order it
 *  likes without constantly re-rolling the army underneath it. */
function mutate(genome: Genome, rand: () => number, pool: Record<Group, ZombieDef[]>): string[] {
  const out = [...genome];
  const roll = rand();
  if (roll < 0.4) {
    const i = Math.floor(rand() * GENOME_SIZE);
    const j = Math.floor(rand() * GENOME_SIZE);
    [out[i], out[j]] = [out[j], out[i]];
  } else if (roll < 0.75) {
    const i = Math.floor(rand() * GENOME_SIZE);
    const options = pool[GROUP_OF(pool, out[i])];
    if (options.length) out[i] = options[Math.floor(rand() * options.length) % options.length].key;
  } else {
    const groups = GROUPS.filter((g) => pool[g].length);
    const g = groups[Math.floor(rand() * groups.length) % groups.length];
    const i = Math.floor(rand() * GENOME_SIZE);
    out[i] = pool[g][Math.floor(rand() * pool[g].length) % pool[g].length].key;
  }
  return repair(out, pool);
}

// ---------------------------------------------------------------------------
// THE SEARCH
// ---------------------------------------------------------------------------

export interface SearchResult {
  target: Target;
  label: string;
  best: { genome: string[]; fitness: Fitness };
  /** The cheapest genome found that cleared every seed with no casualties, if any. */
  cheapestClean: { genome: string[]; fitness: Fitness } | null;
  /** Best fitness at each generation, to show whether the search had converged or was
   *  still climbing when the budget ran out — a frontier from a search still improving is
   *  a lower bound, and should be read as one. */
  history: { generation: number; clean: number; wins: number; losses: number; strength: number }[];
  evaluations: number;
}

export function search(target: Target, label: string, seed = "search"): SearchResult {
  const rand = seededRandom(seed);
  const pool = alphabet(SEARCH_ACCOUNT.playerLevel ?? 50);

  // Memoised by genome: crossover and elitism both re-present armies that have already
  // been flown, and a fight is by far the expensive part of this loop.
  const seen = new Map<string, Fitness>();
  let evaluations = 0;
  const fitness = (g: Genome): Fitness => {
    const key = g.join(",");
    const hit = seen.get(key);
    if (hit) return hit;
    const f = evaluate(g, target);
    evaluations++;
    seen.set(key, f);
    return f;
  };

  let population: string[][] = [];
  for (let i = 0; i < POPULATION; i++) population.push(randomGenome(rand, pool));

  const history: SearchResult["history"] = [];
  let best: { genome: string[]; fitness: Fitness } | null = null;
  let cheapestClean: { genome: string[]; fitness: Fitness } | null = null;

  const consider = (genome: string[], f: Fitness) => {
    if (!best || better(f, best.fitness)) best = { genome: [...genome], fitness: f };
    if (f.clean === SEARCH_SEEDS &&
        (!cheapestClean || f.strength < cheapestClean.fitness.strength)) {
      cheapestClean = { genome: [...genome], fitness: f };
    }
  };

  for (let gen = 0; gen < GENERATIONS; gen++) {
    const scored = population.map((g) => ({ genome: g, fitness: fitness(g) }));
    for (const s of scored) consider(s.genome, s.fitness);
    scored.sort((a, b) => (better(a.fitness, b.fitness) ? -1 : better(b.fitness, a.fitness) ? 1 : 0));

    const top = scored[0].fitness;
    history.push({
      generation: gen,
      clean: top.clean, wins: top.wins,
      losses: Math.round(top.meanLosses * 100) / 100,
      strength: Math.round(top.strength),
    });

    if (gen === GENERATIONS - 1) break;

    // Tournament selection, elitism on top. The elites are carried verbatim so a good
    // army can never be lost to an unlucky generation.
    const pick = (): string[] => {
      let winner = scored[Math.floor(rand() * scored.length) % scored.length];
      for (let i = 1; i < TOURNAMENT; i++) {
        const c = scored[Math.floor(rand() * scored.length) % scored.length];
        if (better(c.fitness, winner.fitness)) winner = c;
      }
      return winner.genome;
    };

    const next: string[][] = scored.slice(0, ELITES).map((s) => [...s.genome]);
    while (next.length < POPULATION) {
      const child = rand() < 0.7 ? cross(pick(), pick(), rand) : [...pick()];
      next.push(mutate(repair(child, pool), rand, pool));
    }
    population = next;
  }

  return {
    target, label,
    best: best!,
    cheapestClean,
    history,
    evaluations,
  };
}

/** The fights worth searching: the hard end of the game, where "can this be cleared at
 *  all" is still a live question. Everything below raid 12 is already cleared loss-lessly
 *  by most of the build grid, so a search there would spend its budget proving a known
 *  thing. The three elites are kept as controls — a search that cannot find a clean clear
 *  on the Pirates has a bug, not a finding. */
export function searchTargets(): { target: Target; label: string }[] {
  const out: { target: Target; label: string }[] = [];
  const at = (raidId: number, tier: number, elite: boolean) => {
    const raid = raids.find((r) => r.id === raidId);
    if (!raid) return;
    out.push({
      target: { raidId, tier: tier || undefined, elite, fightLevel: raid.recommendedLevel },
      label: `${raid.id} ${raid.name}${elite ? " ★" : ""}${tier ? ` t${tier}` : ""}`,
    });
  };
  for (const id of [12, 13, 14, 15]) for (const tier of [1, 5, 10]) at(id, tier, false);
  at(3, 0, true);
  at(9, 0, true);
  return out;
}

/** One shard of the search: every target whose index falls to this worker. */
export function runSearchShard(shard: number, shards: number): SearchResult[] {
  return searchTargets()
    .filter((_, i) => i % shards === shard)
    .map(({ target, label }) => search(target, label, `search:${label}`));
}
