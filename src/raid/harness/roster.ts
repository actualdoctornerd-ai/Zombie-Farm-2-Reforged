// A party, described the way a player builds one.
//
// THE THING THIS REPLACES. `eliteInvasion.balance.test.ts`'s `stickArmy(size, power)`
// took the six strongest ordinary species by `str + con`, repeated them `i % 6`, and
// multiplied str and con by one scalar standing in for "mutations, monoliths, farmer
// heads — all the channels this test does not model individually". Three things were
// wrong with that and all three are load-bearing:
//
//   1. Those six species are 3 Regular, 2 Large and 1 Headless. No Garden, so no heal,
//      no healAOE and no Resurrect; no Small, so no Explode and no Mini Buddy; no
//      Female, so no chivalry and no stun. The stick could not express a party.
//   2. `i % 6` is a fixed rotation, and the army ARRAY IS THE FORMATION. Deploy order
//      is a first-class decision — measured, it is the difference between a two-casualty
//      clear and a loss-less one on the same twenty zombies.
//   3. One multiplier on str and con is not what the game does. The real channels have
//      different SHAPES: veterancy is a flat all-stat multiplier (+5%/rank, ×1.25 at
//      Master), a mutation is a flat ADD applied last (best-in-slot is +5 str / +4 dex /
//      +9 con), a farmer head is ×1.1 on strength or on life but not both, the level ramp
//      is its own curve up to 25, and the team auras scale with HOW MANY carriers are
//      fielded. Collapsing them loses the interactions that decide fights.
//
// So this module carries no synthetic power dial at all. Every axis here is a channel the
// game actually has, which means a roster the harness measures is a roster a player could
// own — and the ceiling it reports is the real ceiling rather than an arbitrary one.
import zombiesJson from "../../../public/assets/zombies.json";
import { bestMutationMask } from "../../devtools/bestMutations";
import { buildPlayerUnits } from "../CombatEngine";
import { MAX_VET_RANK } from "../../zombie/traits";
import raidsJson from "../../../public/assets/raids/raids.json";
import { activeAbilities } from "../../zombie/abilities";
import { epicBossUnlockLevel, EPIC_BOSSES } from "../../epicBoss/catalog";
import { EPIC_QUEST_ZOMBIE_REWARDS } from "../../epicBoss/rewards";
import { COMBINE_SPECIAL_BY_GROUP, COMBINE_SPECIAL_LEVEL } from "../../zombie/combineSpecies";
import {
  ALIENS_RAID_ID, NINJAS_RAID_ID, RAID_ZOMBIE_SOURCES, ROBOTS_RAID_ID, VIDEO_GAMES_RAID_ID,
} from "../zombieDrops";
import { makeOwned, type OwnedZombie } from "../../zombie/types";
import type { RaidDef } from "../types";
import type { ZombieDef } from "../../assets";
import type { CombatUnit } from "../types";

/** The six ordinary body types, which are also the six aura constituencies. */
export type Group = "Headless" | "Garden" | "Regular" | "Female" | "Large" | "Small";
export const GROUPS: readonly Group[] = ["Headless", "Garden", "Regular", "Female", "Large", "Small"];

const zombieDefs = zombiesJson as unknown as ZombieDef[];

/** Everything a player can end up fielding, EXCLUDING the tier-less Yellow uniques.
 *
 *  The old measuring stick threw out the whole Special category, and this harness
 *  inherited that without re-examining it. It was wrong, and wrong in the direction that
 *  matters most: a special is 1.4x to **4.05x** the best ordinary zombie of its class on
 *  the Strength Ladder, and post-level-25 they are where essentially all of a roster's
 *  power comes from. Measuring the endgame against Silvers was measuring an army nobody
 *  fields. (The Yellows stay out because they are genuinely tier-less one-offs; add them
 *  as an explicit archetype if that ever becomes a question.) */
export const CATALOG: readonly ZombieDef[] = zombieDefs.filter((z) => z.className !== "Yellow");

/** The ordinary ladder alone — Green through Silver. Kept because "how far does a roster
 *  get without a single special" is a real question and now has to be asked explicitly. */
export const ORDINARY: readonly ZombieDef[] = CATALOG.filter(
  (z) => (z as { category?: string }).category !== "special"
);

/** How long AFTER a raid unlocks before its elite (Brain Ticket) prize is worth counting
 *  as obtainable, per raid.
 *
 *  Owner's call, 2026-09-21: an elite invasion is "quite difficult when initially
 *  unlocked", so a player does not start farming its promoted prize the day the raid
 *  opens — but the gap CLOSES as the account matures. An early elite is a wall to a small
 *  army with two ability tiers; by the Aliens the player has a full kit and a roster of
 *  specials, and can take the harder fight almost straight away.
 *
 *  The owner named two points — **five levels at the Ninjas, three at the Aliens** — and
 *  ten was the flat figure before that. The rest of the ramp is filled in monotonically
 *  between them and is the part to change first if any of this looks wrong:
 *
 *    Lawyers 16 → 26   Pirates 21 → 31     (10, unchanged)
 *    Ninjas  26 → 31                       (5,  OWNER)
 *    Robots  31 → 35                       (4,  interpolated)
 *    Aliens  36 → 39                       (3,  OWNER)
 *    Video Games 43 → 46                   (3,  carried forward)
 *
 *  The Video Games row matters on its own: at the flat ten its Boss Zombie gated at 53,
 *  above the level cap of 50, so no roster the harness could build was allowed to contain
 *  the game's rarest zombie. At three it lands at 46 and is reachable again.
 *
 *  Deliberately a HARNESS assumption, not a game rule: `specialZombieSourceLevel` in
 *  src/zombie/specialUnlock.ts still returns the raid's own level, because that one gates
 *  the Black Market and an elite prize should stay TRADEABLE with its raid. This only
 *  moves what a measuring roster is allowed to contain. */
export const ELITE_PRIZE_DELAY_DEFAULT = 10;

/** …and nothing elite happens before this level whatever the delay says, because a Brain
 *  Ticket is what makes an elite fight possible at all and tickets unlock at 20 (owner,
 *  2026-09-21). It binds on the four early raids, whose unlock plus ten still lands under
 *  it: Old McDonnell's 0→10, Valentine's 6→16 and Tree World 8→18 are all floored up to
 *  20, and Summer Break's 10→20 was already there. */
export const ELITE_TICKET_LEVEL = 20;
export const ELITE_PRIZE_DELAY: Readonly<Record<number, number>> = {
  [NINJAS_RAID_ID]: 5,
  [ROBOTS_RAID_ID]: 4,
  [ALIENS_RAID_ID]: 3,
  [VIDEO_GAMES_RAID_ID]: 3,
};

/** The delay in force for one raid's elite prize. */
export function elitePrizeDelay(raidId: number): number {
  return ELITE_PRIZE_DELAY[raidId] ?? ELITE_PRIZE_DELAY_DEFAULT;
}

/** The level an elite (Brain Ticket) fight of `raidId` first becomes reachable: the
 *  raid's own unlock plus its delay, never below the ticket level. The prize gate below
 *  and the report's row ordering both read this, so they cannot disagree. */
export function eliteReachableAt(raidId: number): number {
  const unlock = RAID_UNLOCK.get(raidId) ?? 0;
  return Math.max(ELITE_TICKET_LEVEL, unlock + elitePrizeDelay(raidId));
}

const RAID_UNLOCK: ReadonlyMap<number, number> = new Map(
  (raidsJson as RaidDef[]).map((r) => [r.id, Math.max(0, Math.trunc((r as { unlockLevel?: number }).unlockLevel ?? 0))])
);

/** Which Epic Boss owns each quest id — the same derivation specialUnlock makes. */
const EPIC_BOSS_BY_QUEST: ReadonlyMap<string, string> = new Map(
  EPIC_BOSSES.flatMap((boss) => boss.questIds.map((q) => [q, boss.id] as const))
);

/** Earliest level each SPECIAL can be earned, built here rather than taken from
 *  `specialZombieSourceLevel` so the elite delay above can apply to the elite route only.
 *  A zombie with several routes takes the earliest of them. */
const SPECIAL_GATE: ReadonlyMap<string, number> = (() => {
  const gate = new Map<string, number>();
  const note = (key: string, level: number) => {
    const known = gate.get(key);
    if (known === undefined || level < known) gate.set(key, Math.max(0, Math.trunc(level)));
  };
  for (const source of RAID_ZOMBIE_SOURCES) {
    const unlock = RAID_UNLOCK.get(source.raidId) ?? 0;
    // An elite prize cannot be earned before its fight is even possible, so it takes the
    // ticket floor too rather than just the delay.
    note(source.drop.key, source.elite ? eliteReachableAt(source.raidId) : unlock);
  }
  for (const [questId, key] of Object.entries(EPIC_QUEST_ZOMBIE_REWARDS)) {
    const bossId = EPIC_BOSS_BY_QUEST.get(questId);
    if (bossId !== undefined) note(key, epicBossUnlockLevel(bossId));
  }
  for (const key of Object.values(COMBINE_SPECIAL_BY_GROUP)) note(key, COMBINE_SPECIAL_LEVEL);
  return gate;
})();

/** The player level at which a species first becomes obtainable, or null if it never
 *  does. Two different systems, because a special is not a crop:
 *
 *   · an ordinary zombie is a MARKET CROP, gated by its own `level`;
 *   · a special is the prize at the end of some other system — an invasion, an Epic Boss
 *     event, the Zombie Pot — so its gate is that system's unlock level (plus the elite
 *     delay above where the only route is a Brain Ticket win). Its `level` field is not
 *     that number and is sometimes negative.
 *
 *  The five PLANTABLE specials (Bombie, Crazy, Cupid, Dapper, Granny) are the exception
 *  in both directions: no prize source, but they do have a crop, so `marketHidden: false`
 *  is what makes them reachable and `level` is the gate again.
 *
 *  A special with neither route — the orphaned seasonals, which survive only in old saves
 *  and as trade goods — returns null and never enters a roster. That is deliberate: this
 *  answers "could this player have EARNED one", and the Black Market's level-20 floor is
 *  a trade rule rather than a source. */
export function obtainableAt(z: ZombieDef): number | null {
  const isSpecial = (z as { category?: string }).category === "special";
  if (!isSpecial) return z.level ?? 1;
  const routes: number[] = [];
  const gate = SPECIAL_GATE.get(z.key);
  if (gate !== undefined) routes.push(gate);
  if ((z as { marketHidden?: boolean }).marketHidden === false) routes.push(z.level ?? 1);
  return routes.length ? Math.min(...routes) : null;
}

/** THE LEVEL EACH MUTATION TIER BECOMES AVAILABLE, derived from the catalog rather than
 *  written down here.
 *
 *  A mutation's tier IS a colour class — mutations.ts is explicit that the ladder runs
 *  "tier 1 through Silver for tier 4" — and a colour class is gated by the level its
 *  cheapest member unlocks at. So the gate falls out of zombies.json: Green 1, Blue 8,
 *  Red 15, Silver 25.
 *
 *  This exists because `mutation: "best"` was being applied at EVERY level, which put
 *  tier-4 Pumpkings and Heartichokes on level-10 armies. Mutations are flat adds, so they
 *  matter most to the weakest bodies — a Green at 3/1/4 is ladder 3.5 and the same Green
 *  best-in-slot is 22.8, six and a half times the number — and the result was a difficulty
 *  grid whose early columns were Greens wearing endgame heads. A maxed level-10 army beat
 *  every invasion in the game up to level 43. */
const TIER_CLASS: Readonly<Record<number, string>> = {
  1: "Green", 2: "Blue", 3: "Red", 4: "Silver",
};

export const MUTATION_TIER_LEVEL: Readonly<Record<number, number>> = (() => {
  const out: Record<number, number> = {};
  for (const [tier, className] of Object.entries(TIER_CLASS)) {
    const levels = zombieDefs
      .filter((z) => z.className === className &&
        (z as { category?: string }).category !== "special" && (z.level ?? 0) > 0)
      .map((z) => z.level ?? 0);
    out[Number(tier)] = levels.length ? Math.min(...levels) : 1;
  }
  return out;
})();

/** Highest mutation tier an account at `level` can have obtained. */
export function mutationTierAt(level: number): number {
  let tier = 0;
  for (let t = 1; t <= 4; t++) if (level >= (MUTATION_TIER_LEVEL[t] ?? 99)) tier = t;
  return tier;
}

/** Everything of a group a player at `level` could have earned, strongest first. */
function obtainablePool(group: Group, level: number): ZombieDef[] {
  return CATALOG
    .filter((z) => {
      if (z.group !== group) return false;
      const at = obtainableAt(z);
      return at !== null && at <= level;
    })
    .sort((a, b) => strength(b) - strength(a));
}

/** The abilities a species carries with every tier unlocked. Cheap and pure — it is the
 *  same `activeAbilities` the detail card and the sim read. */
export function abilitiesOf(z: ZombieDef): string[] {
  return activeAbilities(
    { key: z.key, group: z.group ?? "Regular", className: z.className ?? "Green" },
    () => true
  );
}

/** What a player at `level` would plausibly field from a class, strongest first.
 *
 *  TWO WAYS IN, because there are two reasons to pick a zombie.
 *
 *  1. IT IS STRONG. The top `depth` by the Strength Ladder (√(str·dex·con) — see
 *     devtools/bestMutations; ranking by `str+con` as the old stick did is blind to dex,
 *     which is half the damage equation and the stat raid 13 taxes), floored at
 *     `APPROPRIATE_FLOOR` of the best one's score. The floor matters: a bare top-3 of a
 *     four-species ordinary class reaches down to the Blue, and with specials in the pool
 *     it would reach across a 4x gap. Neither is a choice anybody makes.
 *
 *  2. IT DOES SOMETHING NOTHING ELSE IN THE CLASS STILL DOES. For each ability carried
 *     anywhere in the class's obtainable pool but by none of the strong picks, the
 *     STRONGEST carrier of it joins the shortlist. This is not a nicety — it is the only
 *     way the shortlist can describe how the game is actually played:
 *
 *       · Resurrect belongs to the ordinary Garden ladder, and the Dr. Zombie and Omega
 *         Dr. Zombie that displace it on strength trade it away for a laser. Without this
 *         rule an endgame roster can never revive anybody.
 *       · Explode belongs to the ordinary Small ladder, and the Zombug and Proto that
 *         displace it carry Resurrect and Smash instead.
 *
 *     Owner, 2026-09-21: "people may still use the mini zombies with explosion, or garden
 *     zombies with revive … people may want more revives in a fight like the Pirates,
 *     where several zombie deaths are expected". A shortlist ranked on stats alone cannot
 *     express that, so it does not rank on stats alone. */
export function appropriateAt(group: Group, level: number, depth = APPROPRIATE_DEPTH): ZombieDef[] {
  const pool = obtainablePool(group, level);
  if (!pool.length) return pool;

  const strong = pool.slice(0, depth);
  const floor = strength(strong[0]) * APPROPRIATE_FLOOR;
  const shortlist = strong.filter((z) => strength(z) >= floor);

  const covered = new Set(shortlist.flatMap(abilitiesOf));
  for (const candidate of pool) {
    if (shortlist.includes(candidate)) continue;
    const brings = abilitiesOf(candidate).filter((a) => !covered.has(a));
    if (!brings.length) continue;
    shortlist.push(candidate);
    for (const a of brings) covered.add(a);
  }
  return shortlist;
}

/** The abilities that make a zombie a HEALER — restoring hit points to the living, as
 *  distinct from Resurrect, which brings back the dead and is a different job. Both sit on
 *  the Garden ladder, and the party floor (composition.ts PARTY_FLOOR) counts the first. */
export const HEAL_ABILITIES: readonly string[] = ["heal", "healAOE"];

/** Whether a species heals. True of every Garden in today's catalog — the Doctors trade
 *  Resurrect for a laser but keep `heal` at tier 1 and `healAOE` at tier 4 — and of
 *  nothing else. Read by the sampler and pinned by floor.test.ts, so the floor stays a
 *  statement about the JOB rather than about the class that currently does it. */
export function isHealer(z: ZombieDef): boolean {
  return abilitiesOf(z).some((a) => HEAL_ABILITIES.includes(a));
}

/** The strongest obtainable species of a group carrying `ability`, or undefined. Lets a
 *  caller ask for a build rather than for a stat line — "the best reviver I can field". */
export function bestCarrierOf(group: Group, level: number, ability: string): ZombieDef | undefined {
  return obtainablePool(group, level).find((z) => abilitiesOf(z).includes(ability));
}

/** How many of the strongest species of a class count as "level appropriate". */
export const APPROPRIATE_DEPTH = 3;

/** …and how far below the best they may fall, as a fraction of its Strength Ladder score.
 *  A count alone is not enough: most ordinary classes have exactly four species, one per
 *  colour, so "top three" at level 45 reaches down to the BLUE (constitution 11 against
 *  the Silver's 27). Nobody fields that, and including it made the roster cohorts overlap
 *  almost completely. 0.6 keeps a class's top two or three real options and drops the
 *  rest. */
export const APPROPRIATE_FLOOR = 0.6;

/** The single strongest species of a group obtainable by `level`. */
export function bestOfGroup(group: Group, level = 99): ZombieDef | undefined {
  return appropriateAt(group, level, 1)[0];
}

const strength = (z: ZombieDef) =>
  Math.sqrt(Math.max(0.1, z.str) * Math.max(0.1, z.dex) * Math.max(0.1, z.con));

export interface RosterSpec {
  /** THE LINEUP. A repeating block of groups, filled to `size` — the shape players
   *  actually describe a party in ("headless, garden, two or three dps, repeat"). The
   *  resulting array IS the formation, so this is the deploy order.
   *
   *  A group with no species available is skipped, and the block repeats until the roster
   *  is full, so a 4-long block at size 20 lays down five copies of it. */
  pattern: readonly Group[];
  size: number;
  /** A group's species PREFERENCE, best first — one key, or an ordered list. Slots of
   *  that group take the first preference still under `maxPerSpecies`, then the next, and
   *  fall through to the class's level-appropriate shortlist when the list runs out.
   *
   *  A list rather than a single key because the duplicate cap has to have somewhere to
   *  go: pinning one species per class and then capping it at two would leave eighteen
   *  slots unfillable. It is also how a roster says "I want the reviver, but I only have
   *  two of them" — put the carrier first and the shortlist behind it. */
  species?: Partial<Record<Group, string | readonly string[]>>;
  /** Most copies of any ONE species the roster may contain. An army of twenty Vagabonds
   *  is a ceiling, not a player: an Epic event pays one prize per rung and an invasion
   *  drop is 1–4.5%, so a realistic roster is a MIX. Unset means no cap (the ceiling
   *  cohorts keep it that way on purpose). When the cap bites, the next-strongest
   *  appropriate species of the same class takes the slot, and the class falls back to
   *  its best if everything appropriate is already capped out. */
  maxPerSpecies?: number;
  /** The level whose SHELF the army was drawn from — what the player could have obtained
   *  when they built it. Defaults to `playerLevel`; a cohort carrying an older army sets
   *  it lower while leaving `playerLevel` where the account actually is. It replaces an
   *  earlier `maxClass` colour cap, which was a proxy for availability and a bad one: a
   *  special is class "Special" at every level, so a colour cap either let a level-12
   *  farm field an Omega Dr. Zombie or kept a level-45 one from fielding any special at
   *  all. Obtainability is the real gate, so it is the one used. */
  catalogLevel?: number;
  /** Survived invasions per zombie → veterancy. 0 = Newbie, 5+ = Master (×1.25 all
   *  stats). Capped by the ladder itself, so 99 and 5 are the same roster. */
  invasions?: number;
  /** "none" (an unmutated line), "best" (the exhaustive best-in-slot mask per species —
   *  a CEILING nothing in the game hands a player), or an explicit mask. */
  mutation?: "none" | "best" | number;
  /** Caps what `"best"` may reach for, as a mutation TIER (see `mutationTierAt`). Unset
   *  means tier 4, which is only right for an endgame account — a sampler drawing an
   *  early-era roster must set it or it will hand Greens their Silver-class heads. */
  mutationTier?: number;
  /** The level the army fights at. Below 25 the stat ramp is still climbing. */
  playerLevel?: number;
  /** How many ability tiers are unlocked, 0..4. The real gate is per-ability within a
   *  tier (its boss beaten enough times); whole tiers is the coarse, honest version and
   *  the one that spans "early account" to "everything". */
  abilityTiers?: number;
  /** Farmer head: ×1.1 on strength OR on life, never both — one head is worn. */
  farmerStrengthMult?: number;
  farmerLifeMult?: number;
}

export interface Roster {
  units: CombatUnit[];
  party: OwnedZombie[];
  /** How many of each group actually made it in — auras scale with this, and a pattern
   *  naming a group with no species silently drops it. */
  composition: Record<string, number>;
  /** √(Σ str·dex·con) over the built units: the Strength Ladder, as ONE number, for
   *  ranking rosters by cost against each other. Never for deciding a fight. */
  strength: number;
}

export function buildRoster(spec: RosterSpec): Roster {
  const shelfLevel = spec.catalogLevel ?? spec.playerLevel ?? 45;
  const cap = spec.maxPerSpecies ?? Infinity;
  const used = new Map<string, number>();

  /** The species that takes the next slot of `group`, honouring the duplicate cap.
   *
   *  Preferences first, in order, then the class's level-appropriate shortlist. A class
   *  whose whole list is spent falls back to its first option rather than leaving the
   *  slot empty — running out of variety is a reason to field a duplicate, not to field
   *  nobody, and a cap that could empty a roster would be measuring a different army. */
  const pickFor = (group: Group): ZombieDef | null => {
    const preference = spec.species?.[group];
    const preferred = (typeof preference === "string" ? [preference] : preference ?? [])
      .map((key) => CATALOG.find((z) => z.key === key))
      .filter((z): z is ZombieDef => !!z);
    const options = [...preferred, ...appropriateAt(group, shelfLevel)];
    if (!options.length) return null;
    return options.find((z) => (used.get(z.key) ?? 0) < cap) ?? options[0];
  };

  const party: OwnedZombie[] = [];
  const composition: Record<string, number> = {};
  const push = (def: ZombieDef, group: string) => {
    const mask = spec.mutation === "best" ? bestMutationMask(def, spec.mutationTier ?? 4)
      : typeof spec.mutation === "number" ? spec.mutation
      : 0;
    // Veterancy is capped by the ladder (Master at 5), so clamping here keeps
    // `invasions: 99` from reading as a different roster than `invasions: 5`.
    const invasions = Math.min(spec.invasions ?? 0, MAX_VET_RANK);
    party.push(makeOwned(`z${party.length}`, def, 0, 0, invasions, mask));
    used.set(def.key, (used.get(def.key) ?? 0) + 1);
    composition[group] = (composition[group] ?? 0) + 1;
  };

  // `pattern` is a repeating block filled to `size`. A sampler that has already decided
  // on a composition AND an order just passes the whole order as the pattern with
  // `size === pattern.length`, which lays it down verbatim — that is how "eight Brutes,
  // eight Minis, two Headless, two Gardens" is expressed, since it is not a block.
  const pattern = spec.pattern.filter((g) => !!(spec.species?.[g] ?? bestOfGroup(g, shelfLevel)));
  if (!pattern.length) throw new Error("roster pattern names no available group");
  for (let i = 0; i < spec.size; i++) {
    const group = pattern[i % pattern.length];
    const def = pickFor(group);
    if (!def) throw new Error(`no species for ${group}`);
    push(def, group);
  }

  const tiers = spec.abilityTiers ?? 4;
  const units = buildPlayerUnits(party, {
    abilitySlotUnlocked: (slot) => slot <= tiers,
    playerLevel: spec.playerLevel ?? 45,
    farmerStrengthMult: spec.farmerStrengthMult,
    farmerLifeMult: spec.farmerLifeMult,
  });

  return {
    units,
    party,
    composition,
    strength: Math.sqrt(units.reduce((sum, u) => sum + u.str * u.dex * u.con, 0)),
  };
}

/** The account knobs, without any statement about WHO is in the army. Shared by the
 *  pattern builder above and the explicit one below so the two cannot drift on what a
 *  level-50 Master roster means. */
export type AccountSpec = Pick<
  RosterSpec,
  | "invasions" | "mutation" | "mutationTier" | "playerLevel" | "abilityTiers"
  | "farmerStrengthMult" | "farmerLifeMult"
>;

/** Build a roster from an EXPLICIT species per slot, in order.
 *
 *  `buildRoster` describes an army the way a player describes one — a repeating pattern of
 *  classes plus a preference per class — which is right for sampling plausible rosters and
 *  wrong for a search. A search's genome is the sixteen slots themselves: it needs to say
 *  "slot 3 is a Vagabond and slot 7 is a Madame", and the pattern builder cannot express
 *  that (with no duplicate cap `pickFor` always returns the head of the preference list, so
 *  every slot of a class comes out identical).
 *
 *  The array IS the deploy order, as everywhere else. Unknown keys throw rather than being
 *  skipped: a genome that names a zombie that does not exist is a bug in the operator that
 *  produced it, and silently shortening the army would hide it as a weaker roster. */
export function buildExplicit(species: readonly string[], account: AccountSpec = {}): Roster {
  const party: OwnedZombie[] = [];
  const composition: Record<string, number> = {};
  for (const key of species) {
    const def = CATALOG.find((z) => z.key === key);
    if (!def) throw new Error(`no species ${key}`);
    const mask = account.mutation === "best" ? bestMutationMask(def, account.mutationTier ?? 4)
      : typeof account.mutation === "number" ? account.mutation
      : 0;
    const invasions = Math.min(account.invasions ?? 0, MAX_VET_RANK);
    party.push(makeOwned(`z${party.length}`, def, 0, 0, invasions, mask));
    const group = def.group ?? "Regular";
    composition[group] = (composition[group] ?? 0) + 1;
  }

  const tiers = account.abilityTiers ?? 4;
  const units = buildPlayerUnits(party, {
    abilitySlotUnlocked: (slot) => slot <= tiers,
    playerLevel: account.playerLevel ?? 45,
    farmerStrengthMult: account.farmerStrengthMult,
    farmerLifeMult: account.farmerLifeMult,
  });

  return {
    units,
    party,
    composition,
    strength: Math.sqrt(units.reduce((sum, u) => sum + u.str * u.dex * u.con, 0)),
  };
}

// ---------------------------------------------------------------------------
// LINEUPS
// ---------------------------------------------------------------------------
//
// Named deploy orders. These are patterns players describe parties in, not an exhaustive
// space — the search layer will permute around them. They matter because the array is the
// formation and because only one zombie charges at a time: a 20-strong army needs roughly
// 72 seconds of queue to fully deploy, so anything at the tail of a fast fight never
// arrives at all. Where a Garden sits in this list decides whether the army has healing,
// and whether an exploder gets picked back up.

/** The standard line. A body to hold the front, the support right behind it so it is out
 *  early and stays out, then damage — repeating, so the army rebuilds that shape every
 *  time the front rank turns over rather than fielding one good block and then a tail. */
export const STANDARD: readonly Group[] = ["Headless", "Garden", "Regular", "Regular"];

/** The same idea with a wider damage block: fewer supports, more of the fight spent
 *  killing. Three dps to a healer instead of two. */
export const STANDARD_WIDE: readonly Group[] = ["Headless", "Garden", "Regular", "Regular", "Large"];

/** Support first and often — the loss-less line. Most healing on the field earliest, at
 *  the cost of putting bodies out later. */
export const SUSTAIN: readonly Group[] = ["Headless", "Garden", "Garden", "Regular", "Large"];

/** Everything forward. No support at all, which is the shape the old measuring stick had
 *  by accident; kept as a named archetype so the comparison is deliberate. */
export const ALL_IN: readonly Group[] = ["Headless", "Large", "Regular", "Regular"];

/** Every class represented, in the standard shape. The only lineup with an answer to
 *  each mechanic: a Small for the fuse, a Female for the stun, a Large for the mount. */
export const BROAD: readonly Group[] = [
  "Headless", "Garden", "Regular", "Large", "Headless", "Garden", "Regular", "Female", "Small",
];

/** Supports LAST — the natural harvest order a player gets by not thinking about it, and
 *  the one that leaves the Gardens in the staging group on any fight under ~72 s. Kept as
 *  a named archetype precisely because it is the accidental default. */
export const SUPPORT_LAST: readonly Group[] = [
  "Headless", "Regular", "Regular", "Large", "Female", "Small", "Garden",
];

export const LINEUPS: Readonly<Record<string, readonly Group[]>> = {
  standard: STANDARD,
  standardWide: STANDARD_WIDE,
  sustain: SUSTAIN,
  allIn: ALL_IN,
  broad: BROAD,
  supportLast: SUPPORT_LAST,
};
