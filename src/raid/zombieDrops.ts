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
//   rec 36  Aliens            Zastronaut        2.0%   (Zosmonaut 4.5%, capped)
//
// The promoted prizes run 3-4.5%: ELITE_PRIZE_RATE_MULTIPLIER x their raid's rung, held
// under ELITE_PRIZE_RATE_CAP — which is only ever the Aliens' 5% brought back to 4.5%.
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
// the ordinary fight pays the base zombie, and an ELITE (Brain Ticket) fight pays the
// promoted one in its place — the sheriff outranks the deputy the way the elite
// invasion outranks the ordinary one.
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
 *  special like the other prizes; an elite promoted version is planned. */
export const VIDEO_GAMES_RAID_ID = 9;
export const VIDEO_GAME_ZOMBIE_KEY = "ZombieActorRegularVideoGame";

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

/** What an ELITE win pays INSTEAD of the ordinary prize, for the raids that promote it.
 *  A raid absent here pays its ordinary prize on elite fights too (at elite luck). */
export const RAID_ELITE_ZOMBIE_DROPS: Readonly<Record<number, RaidZombieDrop>> = {
  [LAWYERS_RAID_ID]: { key: SHERIFF_ZOMBIE_KEY, name: "Sheriff Zombie", rate: elitePrizeRate(LAWYERS_RAID_ID) },
  [PIRATES_RAID_ID]: { key: POSEIDON_ZOMBIE_KEY, name: "Poseidon Zombie", rate: elitePrizeRate(PIRATES_RAID_ID) },
  [NINJAS_RAID_ID]: { key: MASTER_NINJOMBIE_KEY, name: "Master Ninjombie", rate: elitePrizeRate(NINJAS_RAID_ID) },
  [ROBOTS_RAID_ID]: { key: OMEGA_ZOMBIE_BOT_KEY, name: "Omega Zombie Bot", rate: elitePrizeRate(ROBOTS_RAID_ID) },
  [ALIENS_RAID_ID]: { key: ZOSMONAUT_KEY, name: "Zosmonaut", rate: elitePrizeRate(ALIENS_RAID_ID) },
};

/** The prize a win of `raidId` rolls for: the elite one when this was an elite fight and
 *  the raid promotes its prize, the ordinary one otherwise. Null for a raid with none. */
export function raidZombieDropFor(raidId: number, elite = false): RaidZombieDrop | null {
  return (elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined) ?? RAID_ZOMBIE_DROPS[raidId] ?? null;
}

/** Every rare invasion zombie with where it comes from — ordinary and elite prizes alike. */
export interface RaidZombieSource { raidId: number; elite: boolean; drop: RaidZombieDrop }
export const RAID_ZOMBIE_SOURCES: readonly RaidZombieSource[] = [
  ...Object.entries(RAID_ZOMBIE_DROPS).map(([id, drop]) => ({ raidId: Number(id), elite: false, drop })),
  ...Object.entries(RAID_ELITE_ZOMBIE_DROPS).map(([id, drop]) => ({ raidId: Number(id), elite: true, drop })),
];

/** The pity-streak key for one prize. A raid whose elite fight pays a DIFFERENT zombie keeps
 *  two streaks, one per prize, so a hundred dry ordinary wins guarantee the deputy — not a
 *  sheriff on the first ticket. A raid with one prize keeps the one streak it always had,
 *  under the same bare raid-id key, elite fights included. */
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
 *  `elite` says which PRIZE is being rolled for. On a raid that promotes its prize
 *  (RAID_ELITE_ZOMBIE_DROPS) an elite fight rolls for the promoted zombie at that zombie's
 *  OWN rate and `luck` is not applied: the promoted rate already is the elite premium, and
 *  stacking the 4x on top would make the sheriff ten times as common as the deputy. A
 *  raid with a single prize keeps the old behaviour — the same zombie, at `luck` times the
 *  rate. Never exceeds 1. */
export function raidZombieDropRate(raidId: number, dice = 0, luck = 1, elite = false): number {
  const promoted = elite ? RAID_ELITE_ZOMBIE_DROPS[raidId] : undefined;
  const drop = promoted ?? RAID_ZOMBIE_DROPS[raidId];
  if (drop == null) return 0;
  const spent = Math.max(0, Math.min(ZOMBIE_LUCK_DICE_CAP, Math.trunc(Number(dice) || 0)));
  const multiplier = promoted ? 1 : Math.max(0, Number(luck) || 0);
  return Math.min(1, drop.rate * (1 + ZOMBIE_LUCK_PER_DIE * spent) * multiplier);
}

/** A successful configured invasion independently rolls for its rare zombie reward. `dice`
 *  is the Golden Dice spent on the fight (server-pinned online, spent locally offline);
 *  `luck` is the elite multiplier and `elite` whether this was an elite fight (see
 *  raidZombieDropRate for how the two interact). */
export function rollRaidZombieDrop(
  raidId: number,
  won: boolean,
  roll: number,
  dice = 0,
  luck = 1,
  elite = false
): RaidZombieDrop | null {
  const drop = raidZombieDropFor(raidId, elite);
  return won &&
    drop != null &&
    Number.isFinite(roll) &&
    roll >= 0 &&
    roll < raidZombieDropRate(raidId, dice, luck, elite)
    ? drop
    : null;
}

/** Compatibility helper for callers/tests concerned only with Old McZombie. */
export function dropsOldMcZombie(raidId: number, won: boolean, roll: number, dice = 0): boolean {
  return rollRaidZombieDrop(raidId, won, roll, dice)?.key === OLD_MC_ZOMBIE_KEY;
}

/** Wins of ONE raid, without that raid's rare zombie, before the next win is guaranteed to
 *  hand it over. At 1% (Old McZombie) / 0.8% (the event zombies) a grinder can clear a raid
 *  hundreds of times and still never see it; this puts a ceiling on that.
 *
 *  The streak is PER PRIZE — clearing Tree World does nothing for Old McDonnell's, and the
 *  Lawyers' ordinary and elite prizes count separately (raidZombieDryKey) — and it counts
 *  that prize's own dry wins, so a player who has already collected one starts over rather
 *  than being handed a second immediately.
 *
 *  DELIBERATELY INVISIBLE, like the brain floor in brainDrops.ts: nothing in the UI counts
 *  wins towards it, and a guaranteed zombie arrives through the same result-panel reward row
 *  as a lucky one. Keep it that way. */
export const RAID_ZOMBIE_PITY_WINS = 100;

/** Roll a win's rare-zombie reward with the per-prize dry-win floor applied. `dryWins` is how
 *  many times this raid's PRIZE has been missed since it last landed (see nextRaidZombieDryWins
 *  and raidZombieDryKey); `dice` is the Golden Dice spent and `luck` the elite multiplier,
 *  both of which widen the natural roll; `elite` picks the prize. A natural roll always
 *  wins — the floor only fills in a miss. */
export function rollRaidZombieDropWithPity(
  raidId: number,
  won: boolean,
  roll: number,
  dryWins: number,
  dice = 0,
  luck = 1,
  elite = false
): RaidZombieDrop | null {
  const rolled = rollRaidZombieDrop(raidId, won, roll, dice, luck, elite);
  if (rolled) return rolled;
  const drop = raidZombieDropFor(raidId, elite);
  return won && drop != null && dryWins >= RAID_ZOMBIE_PITY_WINS ? drop : null;
}

/** Advance one prize's dry-win streak for a settled WIN that rolled for it. Receiving the
 *  zombie resets it; a dry win adds to it, clamped so the stored number stays bounded.
 *
 *  Only call this for a raid that actually has a rare zombie (RAID_ZOMBIE_DROPS) and only on
 *  a win: a loss is not a completion, and a raid without a prize has nothing to guarantee. */
export function nextRaidZombieDryWins(dryWins: number, dropped: boolean): number {
  if (dropped) return 0;
  return Math.min(Math.max(0, Math.trunc(dryWins)) + 1, RAID_ZOMBIE_PITY_WINS);
}

/** Whether a raid has a rare zombie at all — i.e. whether its dry-win streak means anything. */
export function hasRaidZombieDrop(raidId: number): boolean {
  return RAID_ZOMBIE_DROPS[raidId] != null;
}
