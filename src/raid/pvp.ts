// Friend invasions (PvP) — the shared half.
//
// A friend invasion fights the ATTACKER's chosen eight against a SNAPSHOT of the
// DEFENDER's deployed zombies, on Old McDonnell's stage. Nobody loses anything:
// the defender is only ever a snapshot pinned at /raid/pvp/start, and the finish
// path never touches either roster. Rewards are boosts, priced from the DIFFICULTY
// of the opposing army rather than anyone's level.
//
// Everything here is imported by BOTH the client and the Worker (like repeatXp.ts),
// so the pinned fight config and the reward maths have exactly one definition.
// The fight itself runs the ordinary BattleSim under the ordinary replay ruleset:
// the server returns the complete pinned config from /raid/pvp/start and the client
// ADOPTS it wholesale, so there is no per-side derivation to keep in sync and no
// ruleset bump — a defender zombie is just an enemy-team CombatUnit.
import type { BossThrowConfig, CombatUnit, RaidDef, WaveCadence } from "./types";
import { POWER_PER_STR } from "./combatStats";

/** CLIENT KILL SWITCH — normally leave this true: the Invasions surfaces already
 *  follow the WORKER's capability flag (`PVP_ENABLED` in wrangler.toml, surfaced to
 *  the client via the bootstrap's `pvpEnabled`), so the feature launches and parks
 *  with that one Worker var and no client redeploy. This constant exists for the
 *  emergency where the client side itself must be hidden regardless of the server —
 *  set false and redeploy the client (see docs/FRIEND_INVASIONS.md). */
export const PVP_UI_ENABLED = true;

/** Synthetic raid id for friend invasions. Negative like the Epic Boss's -101, so no
 *  catalog rule (stage ladders, alien/video-game specials, McDonnell pacing) matches. */
export const PVP_RAID_ID = -2;

/** An attacking lineup is exactly eight zombies — no more, no fewer. */
export const PVP_ARMY_SIZE = 8;

/** How many defenders a defense fields: the strongest N of the deployed (non-crypt)
 *  roster, or up to N of an AUTHORED line-up. Six is also exactly the number of
 *  zombie classes, which is what lets "formation" mode give every class its own job.
 *  There is no upgrade path past it — a defense is worth the zombies in it. */
export const PVP_DEFENSE_CAP = 6;

// ---------------------------------------------------------------------------
// DEFENSE MODES. Two ways a farm can defend itself, and exactly one is live at a
// time — the Worker picks it (PVP_DEFENSE_MODE) and AUTHORS the pinned config to
// match, so the client simply fights whatever it is handed. There are deliberately
// no defense upgrades in either mode: a defense is worth exactly the zombies
// standing in it (owner's ruling — see docs/PVP_DEFENSE_FORMATION.md).
//
//   "classic"   — the shipped behaviour. An ordered line-up (or the auto strongest
//                 pick) walks out of the barn doorway under PVP_WAVE_CADENCE, three
//                 on the field at a time, with every ability stripped.
//   "formation" — one zombie per class, each with an authored job and station: a
//                 Headless tank holding the front, a Garden healer at the back that
//                 ACTUALLY heals, a Large brute and Small mini mid-depth, and the
//                 Regular/Girl line arriving as reinforcements.
export type PvpDefenseMode = "classic" | "formation";
export const PVP_DEFENSE_MODES: readonly PvpDefenseMode[] = ["classic", "formation"];
export const PVP_DEFENSE_MODE_DEFAULT: PvpDefenseMode = "classic";
export const isPvpDefenseMode = (value: unknown): value is PvpDefenseMode =>
  typeof value === "string" && (PVP_DEFENSE_MODES as readonly string[]).includes(value);

/** The six jobs a formation defense fills — ONE PER ZOMBIE CLASS, which is why the
 *  defense cap and the class count are the same number.
 *
 *  Normal and Girl are two jobs even though they do the same work, stand in the same
 *  place and arrive on the same beat (owner's ruling, 2026-08-25). They were one shared
 *  "line" job with two holders, and that one-to-many gap was a bug generator rather
 *  than a wording nicety: anything enforcing "one of each" that keyed off the job
 *  merged the two line classes into a single slot and left the sixth permanently
 *  unfillable — a full defense read 5/6. With a job per class the count of jobs IS the
 *  cap, so keying off the job is now always right. Anything that needs "does the same
 *  work" rather than "is the same job" asks `isLineRole`, never `=== "line"`. */
export type PvpDefenseRole = "tank" | "support" | "brute" | "mini" | "line" | "girl";

/** Which class fills which job. `group` is the zombie's body type (types.ts). One
 *  class in, one job out — the map is a bijection and every rule below leans on it. */
export const PVP_ROLE_BY_GROUP: Readonly<Record<string, PvpDefenseRole>> = {
  Headless: "tank",
  Garden: "support",
  Large: "brute",
  Small: "mini",
  Regular: "line",
  Female: "girl",
};

/** Every job a formation defense can fill, front to back. Exactly PVP_DEFENSE_CAP of
 *  them, pinned by test — the picker counts these, the auto snapshot fills these. */
export const PVP_DEFENSE_ROLES: readonly PvpDefenseRole[] = [
  "tank", "brute", "mini", "line", "girl", "support",
];

/** The two REINFORCEMENT jobs: Normal and Girl. Separate jobs, identical work — both
 *  stand at DEF_LINE_X and both arrive on the drip. Every mechanical rule about "the
 *  line" reads this, so adding a third line class later is one entry, not a hunt. */
export const PVP_LINE_ROLES: readonly PvpDefenseRole[] = ["line", "girl"];

/** Does this job arrive as a reinforcement rather than standing at the opening bell? */
export const isLineRole = (role: PvpDefenseRole | null | undefined): boolean =>
  !!role && (PVP_LINE_ROLES as readonly string[]).includes(role);

/** Stations, in sim x (FIELD_W 1000). The defense holds at the barn doorway (940)
 *  today with 60px of stage behind it — no room for a formation — so the tank is
 *  pulled FORWARD of the barn and the rest fill in behind it. */
export const DEF_TANK_X = 770; // out in front of the barn, clear of the line behind it
export const DEF_LINE_X = 890; // brute, mini, and the line reinforcements
export const DEF_SUPPORT_X = 950; // healer, in the doorway, out of the combat band

export const PVP_STATION_BY_ROLE: Readonly<Record<PvpDefenseRole, number>> = {
  tank: DEF_TANK_X,
  brute: DEF_LINE_X,
  mini: DEF_LINE_X,
  line: DEF_LINE_X,
  girl: DEF_LINE_X, // the same station as Normal: a separate JOB, not a separate place
  support: DEF_SUPPORT_X,
};

/** Reinforcement cadence: the line arrives on this beat, so an attacker who clears
 *  fast gets ahead and one who does not gets buried. The primary balance dial, and
 *  measurably the strongest one — see the sweep in pvp.test.ts.
 *
 *  Was 15 s, which had two problems. A typical fight lasted ~33 s, so the SECOND
 *  reinforcement (at 2x the beat) arrived at 30 s and barely swung a sword — half the
 *  line was decorative. And the tanky-attacker case (eight Headless) sat at 1.97x and
 *  would not respond to throw damage, because those armies out-LAST a defense rather
 *  than out-damage it; only more defenders on the ground sooner touches that. At 5 s
 *  both reinforcements are in early, the spread across attacker compositions nearly
 *  halves (1.13-1.97 -> 0.97-1.45), and the fight runs ~45 s with the brute coming
 *  down late, as a finish rather than a mid-fight event. */
export const PVP_DEFENSE_DRIP_MS = 5_000;

/** How often the perched brute lobs the mini. */
export const PVP_THROW_INTERVAL_MS = 6_000;

/** Where the brute perches. The shared BOSS_STRUCT_X/Y is tuned for an enemy boss
 *  SPRITE; a zombie is drawn from its paper-doll rig with a different anchor, so it
 *  reads as sitting low and left of the silo. These are the PvP-only numbers, applied
 *  through the brute's station and cleared the moment it climbs down. */
export const PVP_PERCH_X = 895;
export const PVP_PERCH_Y = -250;

/** Marker prefix for a projectile drawn as a ZOMBIE rather than a raid image. The
 *  renderer resolves `zombie:<key>` through the per-species portrait; anything else
 *  still resolves through the raid image folder. */
export const PVP_ZOMBIE_SPRITE_PREFIX = "zombie:";

/** Abilities a DEFENDER keeps. These run themselves — nobody has to tap them, so
 *  "nobody is home" was never a reason to strip them. Everything else (bash,
 *  explode, Mini Buddy) is a tap and stays stripped: a defender cannot tap.
 *
 *  The WALKING LASER is here for the same reason as heal: nobody has to tap it. It needed
 *  a trigger of its own, though — an attacker's beam fires while the firer walks, and a
 *  defender stands on a station and never does. BattleSim.stepDefenderLaser takes the
 *  mirror on the other side of the same moment: a defender fires while the ATTACKERS are
 *  walking in. Without it the beam was the one ability a buff could only ever hand to the
 *  attacking side, which is why every player-side damage change used to tilt the mode.
 *
 *  `ressurect` is deliberately NOT here yet. Reviving reads the player-side corpse
 *  backlog (BattleSim.fallen), so a defending Garden would need a backlog of its own
 *  — its own piece of work, and one that interacts with the win condition, so it is
 *  left for later rather than half-done. A defending healer HEALS, which is the job
 *  the design gives it. */
export const PVP_DEFENSE_PASSIVE_ABILITIES: readonly string[] = ["heal", "healAOE", "laserBeam", "zomBeam"];

/** Both sides of a friend invasion must be past the opening arc of the game: level 7
 *  keeps brand-new farms out of the matchmaking pool in either role. */
export const PVP_MIN_LEVEL = 7;

/** Daily income caps, one per role. Fights beyond these still HAPPEN (any number per
 *  day — they are recorded, replayable, and count in the stats), but only the first N
 *  verified wins per UTC day pay the attacker, and only the first N held defenses per
 *  UTC day park a reward for the defender. Capping the income rather than the fights
 *  is what keeps a zero-risk mode from becoming a grind treadmill — and it caps what
 *  collusion can farm, which is why the per-pair attack cap below could relax into a
 *  plain spam guard. */
export const PVP_DAILY_REWARDED_WINS = 3;
export const PVP_DAILY_REWARDED_DEFENSES = 3;

/** How many finished fights keep their pinned config + transcript (per role, per
 *  account) for the replay viewer. Older rows keep their RESULT and reward forever —
 *  someone returning after a month sees and claims everything — but the heavy replay
 *  payload is swept, which is most of a session row's weight. */
export const PVP_REPLAYS_KEPT = 10;

/** Defense wave cadence: a mild swarm (up to 3 on the field, one more every 5 s), so a
 *  16-zombie defense doesn't fight one-at-a-time into the 4-minute sim cap. Pinned into
 *  the config like the alien stage's cadence, so both simulations agree by construction. */
export const PVP_WAVE_CADENCE: WaveCadence = { maxActive: 3, dripMs: 5000 };

/** Attacks one account may open against the SAME friend per UTC day. Income is capped
 *  by PVP_DAILY_REWARDED_WINS / _DEFENSES above, so this is only a spam guard now —
 *  it keeps one pair from generating unbounded session rows, not from farming. */
export const PVP_DAILY_ATTACKS_PER_PAIR = 10;

/** Per-hit damage exactly as BattleSim.toSim derives it (finalPower × attackMult). */
function unitHitDamage(u: CombatUnit): number {
  const mult = u.attacks[0]?.mult ?? 1;
  return Math.max(1, Math.round(u.str * POWER_PER_STR * mult));
}

/** One unit's contribution to an army's FIGHT difficulty: staying power × sustained
 *  output (hp × dps over the built, level-scaled stats). Also the base of the reward
 *  tier — unitTierPoints folds Protect's damage reduction in on top (see below) —
 *  and on its own it ranks the auto defense pick and fills the score columns. */
export function unitScore(u: CombatUnit): number {
  const dps = unitHitDamage(u) * (1000 / Math.max(1, u.attackCooldownMs));
  return u.maxHp * dps;
}

/** Fight-difficulty score of a whole army (rounded for stable pinning/printing). */
export function armyScore(units: CombatUnit[]): number {
  return Math.round(units.reduce((sum, u) => sum + unitScore(u), 0));
}

/** The per-unit flip both defense builders share:
 *
 *  - team flips to "enemy"; abilities are cleared (nobody is home to tap them) and
 *    `teamAuraStats` is dropped so the sim never re-derives the aura from "deployed
 *    carriers" (defenders are all home — they keep the FULL-team aura already folded
 *    into their public stats). Protect's damageReduction survives the same way.
 *  - `attackCooldownMs` is kept as built (the player-side 2 s/dex clock), so a zombie
 *    is exactly as fast defending as it is attacking — slotting it onto the enemy
 *    side must not halve its swing interval.
 *  - ids are re-minted `d0..dN` like a wave's so nothing downstream confuses them
 *    with the attacker's roster ids.
 */
function toEnemyCopy(u: CombatUnit, i: number, keepPassives = false): CombatUnit {
  const copy: CombatUnit = {
    ...u,
    id: `d${i}`,
    team: "enemy",
    // Classic mode strips every ability. Formation mode keeps the ones that run
    // themselves, which is what lets a defending healer actually heal.
    abilities: keepPassives
      ? u.abilities.filter((key) => PVP_DEFENSE_PASSIVE_ABILITIES.includes(key))
      : [],
  };
  delete copy.teamAuraStats;
  delete copy.walkingSpeedMult;
  return copy;
}

/** The AUTO pick (no authored defense): the strongest PVP_DEFENSE_CAP by fight
 *  score, ordered WEAKEST FIRST so the wave ramps up the way an authored stage
 *  does. Returns the units UNCONVERTED (original ids) so the caller can also read
 *  which roster members were fielded — the tier calc needs their pre-level stats. */
export function selectAutoDefense(units: CombatUnit[]): CombatUnit[] {
  return units
    .map((u) => ({ u, score: unitScore(u) }))
    .sort((a, b) => b.score - a.score || a.u.id.localeCompare(b.u.id))
    .slice(0, PVP_DEFENSE_CAP)
    .reverse()
    .map(({ u }) => u);
}

/** Convert an already-selected, already-ordered defense line into the enemy side. */
export function enemyCopies(selected: CombatUnit[]): CombatUnit[] {
  return selected.map((u, i) => toEnemyCopy(u, i));
}

/** The AUTO snapshot in one step (selection + conversion). */
export function toDefenseUnits(units: CombatUnit[]): CombatUnit[] {
  return enemyCopies(selectAutoDefense(units));
}

/** An AUTHORED defense: the defender's saved order IS the emergence order — slot 1
 *  walks out first. Capped at PVP_DEFENSE_CAP; the caller has already filtered the
 *  loadout to still-owned zombies. */
export function orderedDefenseUnits(units: CombatUnit[]): CombatUnit[] {
  return enemyCopies(units.slice(0, PVP_DEFENSE_CAP));
}

// ---------------------------------------------------------------------------
// FORMATION MODE. One zombie per class, each with a job, a station and an arrival
// time. The line (Regular/Girl) reinforces on PVP_DEFENSE_DRIP_MS; everyone else is
// already in place when the fight opens — the tank walks out to meet the attacker,
// which it can afford to do because a Headless carries the game's lowest dex on its
// highest con: a wall that barely bites, so the attacker's one-at-a-time trickle has
// time to build up. See docs/PVP_DEFENSE_FORMATION.md.

/** The job a zombie of this class holds, or null if its class fills no job. */
export function roleForGroup(group: string | undefined): PvpDefenseRole | null {
  return (group && PVP_ROLE_BY_GROUP[group]) || null;
}

/** Pick at most one zombie per JOB, strongest first within each. Deterministic.
 *
 *  There is no second key to get wrong here any more: one class holds one job, so a
 *  second Regular loses to the first Regular and never to the Girl. */
export function selectFormationDefense(units: CombatUnit[]): CombatUnit[] {
  const best = new Map<PvpDefenseRole, CombatUnit>();
  const ranked = [...units].sort(
    (a, b) => unitScore(b) - unitScore(a) || a.id.localeCompare(b.id)
  );
  for (const unit of ranked) {
    const role = roleForGroup(unit.group);
    if (!role) continue;
    if (!best.has(role)) best.set(role, unit);
  }
  return [...best.values()].slice(0, PVP_DEFENSE_CAP);
}

/** Convert a selected formation into the enemy side, authoring each unit's job,
 *  station and arrival. Order is front-to-back so the tank is index 0.
 *
 *  The BRUTE takes the boss's perch. Marking it `isBoss` is not a cosmetic label: it
 *  is what hands it the whole perched-boss machinery the sim already has — it starts
 *  on the structure instead of walking in, it throws on the boss action clock, it is
 *  off the wave budget, and it climbs down to fight once the rest of the defense is
 *  gone. The farm's heavy hitter IS the boss of the farm. */
export function formationDefenseUnits(selected: CombatUnit[]): CombatUnit[] {
  // Front-to-back RANK, which is not the job list: Normal and Girl are two jobs doing
  // one job's work, so they share a rank and still settle between themselves on id.
  // Giving Girl its own rank would have made the Normal always arrive first, and which
  // of the two lands on the 5 s beat and which on the 10 s is transcript-visible — a
  // ruleset change, which this deliberately is not.
  const ROLE_RANK: Readonly<Record<PvpDefenseRole, number>> = {
    tank: 0, brute: 1, mini: 2, line: 3, girl: 3, support: 4,
  };
  const rankOf = (u: CombatUnit) => ROLE_RANK[roleForGroup(u.group) ?? "line"];
  const ordered = [...selected].sort(
    (a, b) => rankOf(a) - rankOf(b) || a.id.localeCompare(b.id)
  );
  // Only a defense that actually has a brute can hold its mini back as ammunition —
  // with no thrower there is nothing to reload, and a mini left waiting for a descent
  // that never comes would stand the fight up until the time cap.
  const hasBrute = ordered.some((u) => roleForGroup(u.group) === "brute");
  let lineBeat = 0;
  return ordered.map((unit, i) => {
    const role = roleForGroup(unit.group) ?? "line";
    const copy = toEnemyCopy(unit, i, true);
    copy.defenseRole = role;
    if (role === "brute") {
      // The sim parks a non-falling boss on the structure; the station here only
      // moves it to the PvP perch (a zombie rig sits differently from a boss sprite)
      // and is CLEARED when it climbs down, so it never anchors the army's line or
      // drags a ground walk up into the air. refreshFrontLine skips it regardless.
      copy.isBoss = true;
      copy.deployAtMs = 0;
      copy.stationX = PVP_PERCH_X;
      copy.stationY = PVP_PERCH_Y;
      return copy;
    }
    copy.stationX = PVP_STATION_BY_ROLE[role];
    if (role === "mini" && hasBrute) {
      // The mini IS the projectile. It lives in the barn, gets lobbed, runs back, and
      // is lobbed again — so it must not also stand in the line being hit. It takes
      // the field only when the brute climbs down and brings it along. No deployAtMs:
      // a descent is an event, not a time, so the sim releases it rather than a clock.
      copy.deployWithBoss = true;
      return copy;
    }
    // The line arrives as reinforcements, one per beat; everyone else is in place
    // when the fight opens (the tank walks out from there to its station). BOTH line
    // jobs drip, and off the SAME counter — two jobs, one queue.
    copy.deployAtMs = isLineRole(role) ? PVP_DEFENSE_DRIP_MS * ++lineBeat : 0;
    return copy;
  });
}

/** What the perched brute lobs: the defense's Small zombie, drawn from its own
 *  portrait, hitting for the BRUTE's swing plus the MINI's — both zombies are in the
 *  blow, one supplying the arm and the other the teeth (owner's ruling).
 *
 *  That sum is also what makes the perch phase mean anything. Paying the mini's hit
 *  alone, the throw was worth 0.007x of the fight's break-even — five lobs of a Small
 *  zombie's melee against eight attackers is noise — so the defense's heaviest hitter
 *  spent the whole opening contributing nothing, and the fight only improved for the
 *  defender once it climbed down. Adding the brute's swing puts its strength to work
 *  from the perch, which is what standing up there is for.
 *
 *  The throw-and-return "reload" flight is still presentation to come; mechanically
 *  this is a boss throw with a zombie's face on it. */
export function pvpBossThrow(defense: CombatUnit[]): BossThrowConfig | null {
  const brute = defense.find((u) => u.defenseRole === "brute");
  if (!brute) return null;
  const mini = defense.find((u) => u.defenseRole === "mini");
  if (!mini) return null;
  return {
    intervalMs: PVP_THROW_INTERVAL_MS,
    options: [{
      damage: unitHitDamage(brute) + unitHitDamage(mini),
      weight: 1,
      sprite: `${PVP_ZOMBIE_SPRITE_PREFIX}${mini.sourceKey}`,
      spriteSize: 40,
    }],
  };
}

// ---------------------------------------------------------------------------
// Tiers. A group's tier is hp × dps — staying power times sustained output — over
// the ACTUAL fight stats: the built units, with the player-level ramp, veterancy,
// mutations, team auras, farmer heads, and Protect's damage reduction (which
// multiplies effective staying power) all counted. The level ramp normalizes each
// species to its own band, so an outleveled lawn of greens DEFLATES rather than
// inflates — greens never buy their way up a tier ladder they've outgrown. FOCUS
// never enters (unitScore reads str/dex/con-derived numbers only — owner's ruling:
// a distraction stat, not fighting strength). Rewards are priced from the OPPOSING
// group's tier.
//
// GROUP SIZE matters, sub-linearly: the score is Σ points / √(count × baseSize)
// (defense base PVP_DEFENSE_CAP, attack base PVP_ARMY_SIZE). At count = base that
// is exactly the per-slot average; more zombies raise it by √count — a bigger army
// IS stronger, a little — while one powerful zombie (kept at 1/√base of its full
// points) still out-scores a shuffle of weaklings walking out one by one.
//
// Calibration (measured through the real buildPlayerUnits — see pvp.test.ts pins):
// L7 starter greens 29k · L15 mid normals 31k · L20 tier-3 normals 75k · the
// THEORETICAL max 5-slot mutation set on greens 253k (tier 3 starts above it) ·
// tier-4 normals 327k (556k well-mutated) · plain tier-5/shop specials 457k–1.38M,
// and 2.02M once well-mutated — SPECIALS MAY BE MUTATED (only the Almanac's EPIC
// page may not: those are refused as Pot parents and stripped by every trusted
// write, see server rosterCatalog.legalMutation) · a lone top epic 1.28M · the
// epic shelf 3.75M, and still 2.55M fielding TWO healers. Tier 5 sits at 1.5M so
// a five-star defense can afford its support slots — high-tier healers score
// almost nothing on hp×dps but make the fight harder, so the top tier must not
// punish fielding them (a mutated shop shelf keeps five stars at 1.93M with one
// healer, 1.63M with two) — while the strongest possible lone zombie (1.28M)
// still can't solo into five stars. Pinned: plain greens tier 1 at any count,
// max-mutated greens tier 2 (never 3), a top epic group tier 5 even with two
// healers in the line.
export const PVP_TIER_POINT_THRESHOLDS: ReadonlyArray<number> = [
  60_000, // below: tier 1 (starter farms, outleveled lawns)
  300_000, // below: tier 2 (mid/late normals; mutation-maxed greens top out at 253k)
  700_000, // below: tier 3 (tier-4 normals, heavy mutants, plain tier-5 commons)
  1_500_000, // below: tier 4 (top shop specials, lone epics); at/above: tier 5 (epic shelf)
];

/** One zombie's tier points: its built hp × dps, with Protect's damage reduction
 *  folded in as effective staying power. Focus never enters. */
export function unitTierPoints(u: CombatUnit): number {
  return unitScore(u) / Math.max(0.05, 1 - (u.damageReduction ?? 0));
}

// SUPPORT CREDIT (owner's ruling: a healer is worth what a fighter is worth).
//
// hp × dps scores a healer at almost nothing — the Garden class carries the smallest
// stats in the game — yet a working healer makes a fight materially harder. Crediting
// it with its OWN throughput does not fix that: heal restores HEAL_POWER_MULT of the
// healer's power per cast, which is about half its attack dps, so it would score ~1.5x
// of very little. The value is that it multiplies the WHOLE line's staying power, so
// that is where the credit goes: healing over a nominal fight becomes effective HP for
// the group.
//
// A healer only earns this where it can actually heal — the credit keys off the ability
// surviving on the unit, which happens in formation mode and never in classic mode,
// where every ability is stripped. So the tier always describes the fight the mode
// really produces, with no mode plumbing needed here.
const HEAL_POWER_MULT = 0.5; // mirrors BattleSim's constant
/** Nominal fight length the healing credit is integrated over. Measured PvP fights
 *  ran 35-75 s; 60 is the middle. Tuned so a six-role defense fielding a healer scores
 *  about what six fighters would — which is the whole point of the ruling. */
const HEAL_CREDIT_SECS = 60;

/** Hit points a unit restores per second, or 0 if it cannot heal. */
export function unitHealPerSec(u: CombatUnit): number {
  if (!u.abilities.some((key) => key === "heal" || key === "healAOE")) return 0;
  const power = u.str * POWER_PER_STR;
  return power * HEAL_POWER_MULT * (1000 / Math.max(1, u.attackCooldownMs));
}

/** A group's tier score: Σ points / √(count × baseSize) — the per-slot average at
 *  base size, rising √count above it, diluting below it — then lifted by whatever
 *  healing the group sustains, as a share of its own hit points. */
export function groupTierPoints(
  units: ReadonlyArray<CombatUnit>,
  baseSize: number
): number {
  const total = units.reduce((sum, u) => sum + unitTierPoints(u), 0);
  const base = total / Math.sqrt(Math.max(units.length, 1) * Math.max(baseSize, 1));
  const teamHp = units.reduce((sum, u) => sum + u.maxHp, 0);
  if (teamHp <= 0) return base;
  const healed = units.reduce((sum, u) => sum + unitHealPerSec(u), 0) * HEAL_CREDIT_SECS;
  return base * (1 + healed / teamHp);
}

export function pvpTierForPoints(points: number): number {
  let tier = 1;
  for (const limit of PVP_TIER_POINT_THRESHOLDS) {
    if (points >= limit) tier += 1;
  }
  return tier;
}

export interface PvpReward {
  key: string;
  qty: number;
}

/** Boost bundles per tier. Keys are the boost catalog's; quantities echo the raid
 *  loot bundles (Insta-Grow travels in stacks). Tier 5 is where the Brain Ticket
 *  lives — repelling or beating a top-shelf army is the only PvP path to one. */
export const PVP_TIER_REWARDS: ReadonlyArray<ReadonlyArray<PvpReward>> = [
  [{ key: "insta_grow", qty: 3 }],
  [{ key: "insta_grow", qty: 5 }, { key: "insta_harvest", qty: 2 }],
  [{ key: "insta_grow", qty: 10 }, { key: "golden_dice", qty: 1 }],
  [
    { key: "insta_grow", qty: 10 },
    { key: "invasion_voucher", qty: 1 },
    { key: "concentration", qty: 1 },
  ],
  [
    { key: "brain_ticket", qty: 1 },
    { key: "insta_grow", qty: 10 },
    { key: "golden_dice", qty: 2 },
  ],
];

export function pvpRewardsForTier(tier: number): PvpReward[] {
  const idx = Math.min(PVP_TIER_REWARDS.length, Math.max(1, Math.round(tier))) - 1;
  return PVP_TIER_REWARDS[idx].map((reward) => ({ ...reward }));
}

// ---------------------------------------------------------------------------
// The pinned fight config, as the client consumes it. Structurally a subset of the
// server's PinnedRaidConfig (raidVerifier.ts) plus the `pvp` block — the server
// stores one object that satisfies both, and verifyRaid/createPinnedSim read it
// exactly like a normal raid's.
export interface PvpConfigInfo {
  defenderId: string;
  defenderName: string;
  attackScore: number;
  defenseScore: number;
  /** Reward tier the ATTACKER is paid on a win — the DEFENSE group's raw-stat tier. */
  attackerTier: number;
  /** Reward tier the DEFENDER may claim on a held defense — the ATTACK group's tier. */
  defenderTier: number;
}

/** Synthetic RaidDef for the battle scene: a friend invasion is fought on Old
 *  McDonnell's stage (its backdrop + barn + music), borrowed from the catalog entry
 *  the caller passes in — same trick as the Epic Boss's id -101 def. */
export function buildPvpRaidDef(
  info: { raidName: string; defenderName: string },
  mcdonnell: RaidDef | undefined
): RaidDef {
  return {
    id: PVP_RAID_ID,
    name: info.raidName,
    bossName: info.defenderName,
    bossPortrait: "",
    enemyIcon: "",
    unlockLevel: 0,
    recommendedLevel: 0,
    introText: `${info.defenderName}'s zombies shamble out to defend their turf.`,
    successText: "The farm is yours — for bragging rights, anyway.",
    failureText: "The defense holds. Nobody was hurt (much).",
    xp: 0,
    goldReward: 0,
    bonusGold: 0,
    throwSpeed: 0,
    music: mcdonnell?.music ?? "farmStageBGM.mp3",
    seasonal: true,
    playable: true,
    levelAssets: mcdonnell?.levelAssets ?? [],
    stages: [{ enemyKeys: [] }],
    loot: [],
    obstacleLimit: 0,
    obstacleSpawnSecs: 0,
    obstacleActors: [],
    initialSpawnClass: "",
    hasGrab: false,
  };
}

export interface PvpFightConfig {
  raidId: number;
  raidName: string;
  rosterIds: string[];
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  /** Formation mode: the perched brute's throw. The client MUST adopt this — the
   *  verifier replays with it, so dropping it desynchronises the two simulations
   *  from the brute's first throw. Null in classic mode. */
  bossThrow: BossThrowConfig | null;
  waveCadence: WaveCadence;
  /** Always true for friend invasions: the focus-bubble minigame is skipped on both
   *  simulations, and both sides' units are built at full focus. */
  concentration: boolean;
  pvp: PvpConfigInfo;
}
