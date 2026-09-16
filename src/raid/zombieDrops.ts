/** Rare zombies are separate roster rewards, not part of the ordinary item-loot roll. */
export interface RaidZombieDrop {
  key: string;
  name: string;
  rate: number;
}

export const OLD_MC_ZOMBIE_KEY = "ZombieActorOldMcZombie";
export const OLD_MC_ZOMBIE_NAME = "Old McZombie";
export const OLD_MC_ZOMBIE_RAID_ID = 1;

// ---- The rare-zombie rate ladder ---------------------------------------------------
// Every rare invasion zombie sits on ONE ladder, read off how hard its invasion is (the
// raid's recommended level): 1% a win on the easy invasions, climbing a fifth of a
// percent per story invasion to 2% on the Aliens. Tuned to a feel, not a formula — the
// rates are written out so the whole ladder can be read at a glance and re-tuned in
// one place:
//
//   rec  5  Old McDonnell's   Old McZombie      1.0%
//   rec  6  Valentine's Day   Teddy Zombie      1.0%
//   rec  8  Tree World        Forest Zombie     1.0%
//   rec 10  Summer Break      Diver Zombie      1.0%
//   rec 12  Circus            Zombozo           1.0%   (single prize: x4 on a ticket)
//   rec 16  Lawyers           Deputy Zombie     1.2%   (Sheriff 3.0% on a ticket)
//   rec 21  Pirates           MerZombie         1.4%   (Poseidon 3.5%)
//   rec 26  Ninjas            Ninjombie         1.6%   (Master Ninjombie 4.0%)
//   rec 31  Robots            Zombie Bot        1.8%   (Omega Zombie Bot 4.5%)
//   rec 36  Aliens            Zastronaut        2.0%   (Cozmonaut 4.5%, capped)
//
// The promoted prizes run 3-4.5%: ELITE_PRIZE_RATE_MULTIPLIER x their raid's rung, held
// under ELITE_PRIZE_RATE_CAP — which is only ever the Aliens' 5% brought back to 4.5%.
//
// An elite (Brain Ticket) fight rolls for BOTH of a paired raid's prizes, independently:
// the promoted zombie at the rate above, and the ordinary one at ELITE_BRAIN_LUCK times
// its rung — the same 4x a single-prize raid's ticket has always paid. So a Lawyers ticket
// is Deputy 4.8% and Sheriff 3.0%, and the promoted prize is the rarer of the two inside
// the fight that pays it, the way its rank says it should be. Before this, an elite fight
// rolled ONLY the promoted prize, which left the Deputy unobtainable on a ticket and made
// the Sheriff — at 2.5x the Deputy's rate — the easier of the pair to farm.
//
// The five easy invasions share the floor on purpose — three of them are seasonal and
// unlock at level 6-10, Old McDonnell's is the tutorial raid, and the Circus (rec 12) is
// the first story invasion after it; none is harder than another in a way a rate should
// reward. The climb starts at the Lawyers. zombieDrops.test.ts pins the ladder to the
// recommended-level order so a re-tune cannot quietly invert it.
const pct = (percent: number): number => percent / 100;
export const OLD_MC_ZOMBIE_DROP_RATE = pct(1);
/** The three seasonal invasions' zombies — the ladder's floor, same as Old McZombie. */
export const EVENT_ZOMBIE_DROP_RATE = pct(1);

export const DIVER_ZOMBIE_KEY = "ZombieActorHeadless2Tier5";
export const DIVER_ZOMBIE_NAME = "Diver Zombie";
export const SPRING_BREAK_RAID_ID = 7;

export const FOREST_ZOMBIE_KEY = "ZombieActorForest";
export const FOREST_ZOMBIE_NAME = "Forest Zombie";
export const TREE_WORLD_RAID_ID = 10;

export const TEDDY_ZOMBIE_KEY = "ZombieActorRegular4Tier5";
export const TEDDY_ZOMBIE_NAME = "Teddy Zombie";
export const VALENTINES_DAY_RAID_ID = 11;

// ---- The story invasions' prize pairs ---------------------------------------------
// In the source these eight were ALTERNATE Epic Boss prizes for events that were never
// built. Here they are the story invasions' rare zombies instead, one pair per faction:
// the ordinary fight pays the base zombie, and an ELITE (Brain Ticket) fight pays either —
// the base zombie at the usual elite luck, or, rarer still, the promoted one. The sheriff
// outranks the deputy the way the elite invasion outranks the ordinary one, so he comes
// only out of a ticket and comes out of it less often than the deputy does.
export const LAWYERS_RAID_ID = 2;
export const PIRATES_RAID_ID = 3;
export const NINJAS_RAID_ID = 4;
export const ROBOTS_RAID_ID = 5;
export const ALIENS_RAID_ID = 6;
export const CIRCUS_RAID_ID = 8;

export const DEPUTY_ZOMBIE_KEY = "ZombieActorDeputy";
export const SHERIFF_ZOMBIE_KEY = "ZombieActorSheriff";
export const MER_ZOMBIE_KEY = "ZombieActorMerZombie";
export const POSEIDON_ZOMBIE_KEY = "ZombieActorPoseidon";
export const NINJOMBIE_KEY = "ZombieActorNinjombie";
export const MASTER_NINJOMBIE_KEY = "ZombieActorMasterNinjombie";
export const ZOMBIE_BOT_KEY = "ZombieActorZombieBot";
export const OMEGA_ZOMBIE_BOT_KEY = "ZombieActorOmegaZombieBot";
export const ZASTRONAUT_KEY = "ZombieActorZastronaut";
/** The Zastronaut in a rust suit and charcoal helmet — a derived recolour
 *  (tools/prep_assets.py DERIVED_SPECIAL_ZOMBIES), the Aliens' promoted prize. */
export const ZOSMONAUT_KEY = "ZombieActorZosmonaut";
/** A Mini zombie in the Circus clown's costume, cut from the enemy art
 *  (tools/prep_assets.py CUT_SPECIAL_ZOMBIES) — the Circus's rare zombie. */
export const ZOMBOZO_KEY = "ZombieActorZombozo";
/** The pixel zombie of the Video Games invasion as a playable species (a flipbook
 *  rig, see docs/SPECIAL_ZOMBIE_ACQUISITION.md) — that invasion's rare zombie, a
 *  special like the other prizes. */
export const VIDEO_GAMES_RAID_ID = 9;
export const VIDEO_GAME_ZOMBIE_KEY = "ZombieActorRegularVideoGame";
/** The Video Games' promoted prize: the pixel zombie's palette swap, the way a game's
 *  final boss is the same sprite in a stronger colour — a derived flipbook
 *  (tools/prep_assets.py DERIVED_FLIPBOOK_ZOMBIES). */
export const FINAL_BOSS_ZOMBIE_KEY = "ZombieActorRegularFinalBoss";

/** Each story invasion's ordinary-prize rate: its rung of the ladder above. The Video
 *  Games invasion (recommended level 43) sits past the Aliens at the ladder's top and
 *  pays the same 2% ceiling. */
export const STORY_ZOMBIE_DROP_RATES: Readonly<Record<number, number>> = {
  [CIRCUS_RAID_ID]: pct(1.0),
  [LAWYERS_RAID_ID]: pct(1.2),
  [PIRATES_RAID_ID]: pct(1.4),
  [NINJAS_RAID_ID]: pct(1.6),
  [ROBOTS_RAID_ID]: pct(1.8),
  [ALIENS_RAID_ID]: pct(2.0),
  [VIDEO_GAMES_RAID_ID]: pct(2.0),
};
/** A promoted prize's own rate on an elite fight is this many times its raid's ordinary
 *  rate, reflecting the harder wave — 2.5x puts the four promoted prizes on 3.0 / 3.5 /
 *  4.0 / 4.5%. That product is the WHOLE elite premium — see raidZombieDropRate. */
export const ELITE_PRIZE_RATE_MULTIPLIER = 2.5;
/** The promoted prizes are meant to sit inside 3-4.5%. The multiplier alone would put
 *  the Aliens' at 5%, so the top of the ladder is held here rather than by bending the
 *  multiplier for the other four. */
export const ELITE_PRIZE_RATE_CAP = pct(4.5);
const elitePrizeRate = (raidId: number): number =>
  Math.min(ELITE_PRIZE_RATE_CAP, ELITE_PRIZE_RATE_MULTIPLIER * STORY_ZOMBIE_DROP_RATES[raidId]);

/** What an ORDINARY win of each raid can pay. Every raid with a rare zombie appears here. */
export const RAID_ZOMBIE_DROPS: Readonly<Record<number, RaidZombieDrop>> = {
  [OLD_MC_ZOMBIE_RAID_ID]: {
    key: OLD_MC_ZOMBIE_KEY,
    name: OLD_MC_ZOMBIE_NAME,
    rate: OLD_MC_ZOMBIE_DROP_RATE,
  },
  [LAWYERS_RAID_ID]: { key: DEPUTY_ZOMBIE_KEY, name: "Deputy Zombie", rate: STORY_ZOMBIE_DROP_RATES[LAWYERS_RAID_ID] },
  [PIRATES_RAID_ID]: { key: MER_ZOMBIE_KEY, name: "MerZombie", rate: STORY_ZOMBIE_DROP_RATES[PIRATES_RAID_ID] },
  [NINJAS_RAID_ID]: { key: NINJOMBIE_KEY, name: "Ninjombie", rate: STORY_ZOMBIE_DROP_RATES[NINJAS_RAID_ID] },
  [ROBOTS_RAID_ID]: { key: ZOMBIE_BOT_KEY, name: "Zombie Bot", rate: STORY_ZOMBIE_DROP_RATES[ROBOTS_RAID_ID] },
  [ALIENS_RAID_ID]: { key: ZASTRONAUT_KEY, name: "Zastronaut", rate: STORY_ZOMBIE_DROP_RATES[ALIENS_RAID_ID] },
  [CIRCUS_RAID_ID]: { key: ZOMBOZO_KEY, name: "Zombozo", rate: STORY_ZOMBIE_DROP_RATES[CIRCUS_RAID_ID] },
  [VIDEO_GAMES_RAID_ID]: { key: VIDEO_GAME_ZOMBIE_KEY, name: "Video Game Zombie", rate: STORY_ZOMBIE_DROP_RATES[VIDEO_GAMES_RAID_ID] },
  [SPRING_BREAK_RAID_ID]: {
    key: DIVER_ZOMBIE_KEY,
    name: DIVER_ZOMBIE_NAME,
    rate: EVENT_ZOMBIE_DROP_RATE,
  },
  [TREE_WORLD_RAID_ID]: {
    key: FOREST_ZOMBIE_KEY,
    name: FOREST_ZOMBIE_NAME,
    rate: EVENT_ZOMBIE_DROP_RATE,
  },
  [VALENTINES_DAY_RAID_ID]: {
    key: TEDDY_ZOMBIE_KEY,
    name: TEDDY_ZOMBIE_NAME,
    rate: EVENT_ZOMBIE_DROP_RATE,
  },
};

/** The EXTRA prize an elite win can pay, for the raids that promote one. It is rolled
 *  alongside the ordinary prize, not instead of it (see rollRaidZombieDrop), and takes
 *  precedence when both land. A raid absent here has only its ordinary prize, paid on
 *  elite fights at elite luck. */
export const RAID_ELITE_ZOMBIE_DROPS: Readonly<Record<number, RaidZombieDrop>> = {
  [LAWYERS_RAID_ID]: { key: SHERIFF_ZOMBIE_KEY, name: "Sheriff Zombie", rate: elitePrizeRate(LAWYERS_RAID_ID) },
  [PIRATES_RAID_ID]: { key: POSEIDON_ZOMBIE_KEY, name: "Poseidon Zombie", rate: elitePrizeRate(PIRATES_RAID_ID) },
  [NINJAS_RAID_ID]: { key: MASTER_NINJOMBIE_KEY, name: "Master Ninjombie", rate: elitePrizeRate(NINJAS_RAID_ID) },
  [ROBOTS_RAID_ID]: { key: OMEGA_ZOMBIE_BOT_KEY, name: "Omega Zombie Bot", rate: elitePrizeRate(ROBOTS_RAID_ID) },
  [ALIENS_RAID_ID]: { key: ZOSMONAUT_KEY, name: "Cozmonaut", rate: elitePrizeRate(ALIENS_RAID_ID) },
  [VIDEO_GAMES_RAID_ID]: { key: FINAL_BOSS_ZOMBIE_KEY, name: "Boss Zombie", rate: elitePrizeRate(VIDEO_GAMES_RAID_ID) },
};

/** The prize a win of `raidId` is CHARACTERISED by: the promoted one when this was an
 *  elite fight of a raid that promotes, the ordinary one otherwise. This is the prize the
 *  fight's pity streak guarantees (raidZombieDryKey) and the one the raid card names for
 *  the elite half — an elite fight also rolls the ordinary prize, which rollRaidZombieDrop
 *  handles. Null for a raid with no rare zombie. */
export function raidZombieDropFor(raidId: number, elite = false): RaidZombieDrop | null {
  return (elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined) ?? RAID_ZOMBIE_DROPS[raidId] ?? null;
}

/** Every rare invasion zombie with where it comes from — ordinary and elite prizes alike. */
export interface RaidZombieSource { raidId: number; elite: boolean; drop: RaidZombieDrop }
export const RAID_ZOMBIE_SOURCES: readonly RaidZombieSource[] = [
  ...Object.entries(RAID_ZOMBIE_DROPS).map(([id, drop]) => ({ raidId: Number(id), elite: false, drop })),
  ...Object.entries(RAID_ELITE_ZOMBIE_DROPS).map(([id, drop]) => ({ raidId: Number(id), elite: true, drop })),
];

/** The pity-streak key for the prize `elite` names. A raid whose elite fight adds a promoted
 *  zombie keeps two streaks, one per prize, so the ordinary floor guarantees the deputy — not a
 *  sheriff on the first ticket. A raid with one prize keeps the one streak it always had, under
 *  the same bare raid-id key, elite fights included.
 *
 *  Note the two are fed differently: an elite fight of a paired raid rolls BOTH prizes, so it
 *  moves BOTH streaks — this key's promoted one and the ordinary one under `String(raidId)`.
 *  Only an elite fight can move the promoted streak. settleRaidZombieDrop does both. */
export function raidZombieDryKey(raidId: number, elite = false): string {
  return elite && RAID_ELITE_ZOMBIE_DROPS[raidId] ? `${raidId}:elite` : String(raidId);
}

/** The generic identity every rare invasion zombie ALSO answers to for quests.
 *
 *  It exists so one achievement can ask for "a rare zombie from an invasion" without
 *  naming which of the four. A blank subject cannot express that — blank is the quest
 *  format's wildcard, and the drop is announced as ordinary loot, so a wildcard would
 *  count Bonus Gold and every boost bundle too. */
export const RARE_INVASION_ZOMBIE_SUBJECT = "Rare Invasion Zombie";

const RARE_ZOMBIE_NAMES = new Set(
  RAID_ZOMBIE_SOURCES.map(({ drop }) => drop.name.trim().toLowerCase())
);

/** Whether a loot name is one of the rare invasion zombies (and so should carry the
 *  generic alias above). */
export function isRareInvasionZombieName(name: string): boolean {
  return RARE_ZOMBIE_NAMES.has(name.trim().toLowerCase());
}

/** Extra rare-zombie chance per Golden Die spent on the fight, as a multiple of the raid's
 *  base rate: one die doubles it, two dice triple it, and so on. Golden Dice already shift
 *  the ITEM loot roll toward its rare tiers (`LootTable.rollLootTier`), and their own
 *  description promises "the drop rate of rare items in a single fight" — the rare zombie is
 *  the rarest thing an invasion can pay, so it rides along.
 *
 *  Old McZombie 1% → 2/3/…/6% at the five dice a raid can take; the event zombies 0.8% →
 *  1.6/2.4/…/4.8%. */
export const ZOMBIE_LUCK_PER_DIE = 1;

/** Defensive ceiling on the dice a single roll may count, mirroring the clamp `/raid/start`
 *  puts on the requested count. Play caps lower still: `maxLuckTiers` allows one die per
 *  loot tier beyond the first (five on a full six-tier table). */
export const ZOMBIE_LUCK_DICE_CAP = 10;

/** This raid's rare-zombie chance with `dice` Golden Dice spent — 0 for a raid that has no
 *  rare zombie. `luck` is the flat elite multiplier (ELITE_BRAIN_LUCK on a Brain Ticket
 *  run, 1 otherwise); it stacks on top of the dice the same way it does for brains.
 *
 *  `elite` says which PRIZE's rate is wanted, not which fight: with it set on a raid that
 *  promotes (RAID_ELITE_ZOMBIE_DROPS) this is the PROMOTED zombie's own rate, and `luck` is
 *  not applied — the promoted rate already is the elite premium, and stacking the 4x on top
 *  would make the sheriff ten times as common as the deputy. Passing `elite` false gives the
 *  ordinary prize at `luck` times its rate, which is what an elite fight rolls that prize at
 *  as well. A raid with a single prize answers the same either way. Never exceeds 1. */
export function raidZombieDropRate(raidId: number, dice = 0, luck = 1, elite = false): number {
  const promoted = elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined;
  const drop = promoted ?? RAID_ZOMBIE_DROPS[raidId];
  if (drop == null) return 0;
  const spent = Math.max(0, Math.min(ZOMBIE_LUCK_DICE_CAP, Math.trunc(Number(dice) || 0)));
  const multiplier = promoted ? 1 : Math.max(0, Number(luck) || 0);
  return Math.min(1, drop.rate * (1 + ZOMBIE_LUCK_PER_DIE * spent) * multiplier);
}

/** Whether a draw landed inside a rate. A draw outside [0, 1) — NaN, negative, a stray
 *  1 used as a guaranteed miss — never wins. */
const hits = (draw: number, rate: number): boolean =>
  Number.isFinite(draw) && draw >= 0 && draw < rate;

/** A successful configured invasion independently rolls for its rare zombie reward. `dice`
 *  is the Golden Dice spent on the fight (server-pinned online, spent locally offline);
 *  `luck` is the elite multiplier and `elite` whether this was an elite fight (see
 *  raidZombieDropRate for how the two interact).
 *
 *  An elite fight of a raid that promotes its prize rolls for BOTH, independently: `roll`
 *  draws the promoted zombie at its own rate, and `baseRoll` — a SECOND, independent draw —
 *  the ordinary zombie at `luck` times its rung, exactly the 4x a single-prize raid's ticket
 *  has always paid. A win still hands over at most one zombie: the promoted prize takes
 *  precedence when both land, which costs the ordinary one its rate times the promoted
 *  prize's miss (a Lawyers ticket pays the Deputy 4.8% x 97% = 4.66% of wins).
 *
 *  Every other case reads `roll` alone, and `baseRoll` defaults to it. A caller settling a
 *  real fight must pass a genuinely separate draw — sharing one would correlate the two
 *  prizes into a single window and quietly shrink the ordinary one. */
export function rollRaidZombieDrop(
  raidId: number,
  won: boolean,
  roll: number,
  dice = 0,
  luck = 1,
  elite = false,
  baseRoll = roll
): RaidZombieDrop | null {
  if (!won) return null;
  const promoted = elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined;
  if (promoted != null && hits(roll, raidZombieDropRate(raidId, dice, luck, true))) return promoted;
  const ordinary = RAID_ZOMBIE_DROPS[raidId];
  if (ordinary == null) return null;
  // The ordinary prize's own draw — the second one when a promoted prize just missed on the
  // first, and `roll` itself everywhere else. Its rate is the `elite` false one either way:
  // that IS `luck` times the rung, which is what an elite fight pays it at.
  return hits(promoted != null ? baseRoll : roll, raidZombieDropRate(raidId, dice, luck, false))
    ? ordinary
    : null;
}

/** Compatibility helper for callers/tests concerned only with Old McZombie. */
export function dropsOldMcZombie(raidId: number, won: boolean, roll: number, dice = 0): boolean {
  return rollRaidZombieDrop(raidId, won, roll, dice)?.key === OLD_MC_ZOMBIE_KEY;
}

/** Wins of ONE raid, without that raid's ORDINARY rare zombie, before the next win is
 *  guaranteed to hand it over. At 1-2% a grinder can clear a raid hundreds of times and still
 *  never see it; this puts a ceiling on that.
 *
 *  The streak is PER PRIZE — clearing Tree World does nothing for Old McDonnell's, and the
 *  Lawyers' ordinary and promoted prizes count separately (raidZombieDryKey) — and it counts
 *  that prize's own dry wins, so a player who has already collected one starts over rather
 *  than being handed a second immediately.
 *
 *  This floor is SPLIT ACROSS BOTH KINDS OF FIGHT: every win rolls the ordinary prize, a Brain
 *  Ticket fight included, so every win feeds these fifty. A player who farms the Lawyers only
 *  on tickets still walks towards their Deputy; before elite fights could pay the ordinary
 *  prize this counter would have stood still for them forever.
 *
 *  DELIBERATELY INVISIBLE, like the brain floor in brainDrops.ts: nothing in the UI counts
 *  wins towards it, and a guaranteed zombie arrives through the same result-panel reward row
 *  as a lucky one. Keep it that way. */
export const RAID_ZOMBIE_PITY_WINS = 50;

/** The same floor for a PROMOTED prize. Lower than the ordinary one because only an ELITE win
 *  can pay a promoted zombie or move its streak, and Brain Tickets are the scarce thing —
 *  forty ticketed wins of one invasion is already far more grinding than fifty mixed ones. */
export const RAID_ELITE_ZOMBIE_PITY_WINS = 40;

/** The dry-win floor guarding the prize `elite` names — the promoted prize's shorter one on an
 *  elite fight of a paired raid, the ordinary one everywhere else. Reads the same condition as
 *  raidZombieDryKey, so a key and its floor always agree. */
export function raidZombiePityWins(raidId: number, elite = false): number {
  return elite && RAID_ELITE_ZOMBIE_DROPS[raidId]
    ? RAID_ELITE_ZOMBIE_PITY_WINS
    : RAID_ZOMBIE_PITY_WINS;
}

/** Roll a win's rare-zombie reward with the dry-win floors applied. `dryWins` is how many
 *  times the prize `elite` names has been missed since it last landed (see raidZombieDryKey);
 *  `dice` is the Golden Dice spent and `luck` the elite multiplier, both of which widen the
 *  natural roll; `baseRoll` is the fight's second draw (see rollRaidZombieDrop) and
 *  `baseDryWins` the ORDINARY prize's own streak, which an elite fight of a paired raid
 *  carries alongside the promoted one.
 *
 *  A natural roll always wins; a floor only fills in a miss. The promoted floor is checked
 *  first, matching the roll's own precedence — one win never hands over two zombies. Like the
 *  draws, `baseDryWins` defaults to `dryWins`, which is right for every fight that has only
 *  one streak and wrong for a paired elite one: settleRaidZombieDrop passes both. */
export function rollRaidZombieDropWithPity(
  raidId: number,
  won: boolean,
  roll: number,
  dryWins: number,
  dice = 0,
  luck = 1,
  elite = false,
  baseRoll = roll,
  baseDryWins = dryWins
): RaidZombieDrop | null {
  const rolled = rollRaidZombieDrop(raidId, won, roll, dice, luck, elite, baseRoll);
  if (rolled) return rolled;
  if (!won) return null;
  const own = raidZombieDropFor(raidId, elite);
  if (own != null && dryWins >= raidZombiePityWins(raidId, elite)) return own;
  // The ordinary prize's own floor, which a paired elite fight carries too. `own` already WAS
  // the ordinary prize on every other fight, so this only ever adds the paired-elite case.
  const promoted = elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined;
  const ordinary = RAID_ZOMBIE_DROPS[raidId];
  return promoted != null && ordinary != null && baseDryWins >= RAID_ZOMBIE_PITY_WINS
    ? ordinary
    : null;
}

/** Whether a settled win's `dropped` prize is the one that fight's dry-win streak
 *  (raidZombieDryKey) exists to guarantee — the only thing that may reset it.
 *
 *  An elite fight of a paired raid can also pay the ORDINARY zombie, and that must not push
 *  the promoted prize's guarantee back to zero: the streaks are per prize, not per win. A
 *  ticket that hands over a Deputy leaves the Sheriff's forty-win floor exactly where it
 *  was. */
export function resetsRaidZombieDry(
  raidId: number,
  elite: boolean,
  dropped: RaidZombieDrop | null
): boolean {
  return dropped != null && dropped.key === raidZombieDropFor(raidId, elite)?.key;
}

/** Advance one prize's dry-win streak for a settled WIN that rolled for it. Receiving that
 *  prize resets it; a dry win adds to it, clamped at `floor` so the stored number stays
 *  bounded — pass that streak's own floor (raidZombiePityWins), or an old save's leftover
 *  hundred would sit above a shorter one forever.
 *
 *  Only call this for a raid that actually has a rare zombie (RAID_ZOMBIE_DROPS) and only on
 *  a win: a loss is not a completion, and a raid without a prize has nothing to guarantee. */
export function nextRaidZombieDryWins(
  dryWins: number,
  dropped: boolean,
  floor = RAID_ZOMBIE_PITY_WINS
): number {
  if (dropped) return 0;
  return Math.min(Math.max(0, Math.trunc(dryWins)) + 1, floor);
}

/** Whether a raid has a rare zombie at all — i.e. whether its dry-win streak means anything. */
export function hasRaidZombieDrop(raidId: number): boolean {
  return RAID_ZOMBIE_DROPS[raidId] != null;
}

/** The two independent draws one settled win needs (see rollRaidZombieDrop), plus what the
 *  fight was carrying. Both callers pass `Math.random()` twice. */
export interface RaidZombieRolls {
  /** The promoted prize's draw on a paired elite fight; the only draw on every other one. */
  roll: number;
  /** The ordinary prize's draw, consulted only on a paired elite fight. */
  baseRoll: number;
  /** Golden Dice spent on the fight — server-pinned online, spent locally offline. */
  dice?: number;
  /** The elite multiplier: ELITE_BRAIN_LUCK on a Brain Ticket run, 1 otherwise. */
  luck?: number;
}

export interface RaidZombieSettlement {
  /** The zombie this win hands over, or null. Never more than one. */
  drop: RaidZombieDrop | null;
  /** The dry-win map to store, with every streak this win touched already advanced. */
  dry: Record<string, number>;
}

/** Settle one WIN's rare zombie: roll both prizes, apply both floors, and advance every streak
 *  the fight fed — all of it in one place, because the client settles offline wins and the
 *  Worker settles online ones and the two must not drift.
 *
 *  `dry` is the stored streak map (`GameState.zombieDryWins` / `raid_state_v3.zombie_dry_json`),
 *  keyed by raidZombieDryKey; a copy is returned rather than mutated. A paired ELITE fight
 *  rolled BOTH prizes, so it advances BOTH streaks — the promoted one under `"<id>:elite"` and
 *  the ordinary one under `"<id>"` — and each resets only on its own prize. Every other fight
 *  has the single streak it always had.
 *
 *  Call only for a settled win. A loss is not a completion, and a raid with no rare zombie
 *  never gets a key. */
export function settleRaidZombieDrop(
  raidId: number,
  elite: boolean,
  dry: Readonly<Record<string, number>>,
  rolls: RaidZombieRolls
): RaidZombieSettlement {
  const next: Record<string, number> = { ...dry };
  if (!hasRaidZombieDrop(raidId)) return { drop: null, dry: next };

  const ownKey = raidZombieDryKey(raidId, elite);
  const baseKey = raidZombieDryKey(raidId, false);
  const drop = rollRaidZombieDropWithPity(
    raidId, true, rolls.roll, dry[ownKey] ?? 0, rolls.dice ?? 0, rolls.luck ?? 1, elite,
    rolls.baseRoll, dry[baseKey] ?? 0
  );

  next[ownKey] = nextRaidZombieDryWins(
    dry[ownKey] ?? 0, resetsRaidZombieDry(raidId, elite, drop), raidZombiePityWins(raidId, elite)
  );
  // The ordinary prize's streak, when the fight kept a separate one for the promoted prize.
  // It is the same key otherwise, and the line above has already settled it.
  if (ownKey !== baseKey) {
    next[baseKey] = nextRaidZombieDryWins(
      dry[baseKey] ?? 0, resetsRaidZombieDry(raidId, false, drop), RAID_ZOMBIE_PITY_WINS
    );
  }
  return { drop, dry: next };
}
