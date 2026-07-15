// The live battle simulation (Phase 3+): a pure, RNG-free, real-time stepping
// model that the RaidScene renders. No Pixi, no DOM — positions, health, focus
// charge, ballistic boss projectiles, and attack clocks over a 1D combat lane.
// This is the AUTHORITY for a raid's outcome — the game ALWAYS plays it out; there is
// no instant/auto-resolve (CombatEngine.resolveRaid is retained only for the ZF.runRaid
// dev hook + headless tests).
//
// Cadence (both sides "one at a time"):
//   Zombies mill in a GROUP on the LEFT. One at a time the front zombie steps out
//   to its lane and charges a FOCUS bar; when full it is released to advance right
//   and fight, and the next steps up. Only one charges at a time.
//   Normal enemies EMERGE one at a time and hold just outside the entrance at the
//   RIGHT edge; zombies stop at a front line to their LEFT and never pass them.
//   The BOSS perches on its structure (top-right) and TOSSES projectiles in an arc
//   at the zombies (preferring Garden zombies). Throws are ballistic and use lazy
//   circle collision — a fast/small zombie can be missed. Once the minions are
//   cleared the boss descends and fights as a ground unit.
//
// Now implemented: focus-bar distractions (butterfly/brain bubbles, with
// Concentration bypass), activated abilities (windup/cooldown/stun/knockback),
// boss specials, and ballistic projectiles. Still deferred/disabled: boss
// summon/wall spawning (templates are built but the scheduler doesn't spawn them
// yet) and ground-crossing environmental hazards (RaidManager.hazardOf returns
// null pending better visual integration).
//
// Combat numbers are the GROUND-TRUTH fight-data model (combatStats.ts, recovered from
// the binary): maxHp = con*100 and cadence = attackCooldownMs (2s zombie / 1s enemy ÷ dex)
// arrive on the CombatUnit; per-swing damage = finalPower(str*10) * mult * 0.7.
import type { BossSpecial, BossThrowConfig, CombatUnit, HazardConfig, RaidOutcome } from "./types";
import { ACTIVATED_ABILITY, activatedKeyFor, teamAbilitiesIn } from "../zombie/abilities";
import { deriveHitDamage, POWER_PER_STR } from "./combatStats";
import { ENEMY_DAMAGE_MULT, PROJECTILE_DAMAGE_MULT } from "./balance";

/** Logical field the sim runs in; RaidScene scales this to the viewport. */
export const FIELD_W = 1000;
export const FIELD_H = 560;

const CHARGE_X = 220; // staging slot the front zombie steps into to focus
const ENEMY_HOLD_X = 915; // enemies hold in the structure's doorway (not the far edge),
// ~2/3 of a sprite forward of the entrance so they stand IN the open door
export const ENEMY_SPAWN_X = 1120; // off the right edge (hidden) before emerging
// Boss perch field-x. Chosen so RaidScene.mapX() lands it on the silo perch
// (PERCH_FX), which is also where thrown projectiles originate.
export const BOSS_STRUCT_X = 848;
/** Boss perch height in sim space (negative = up); RaidScene reads it to place
 *  the boss on the barn and lerp its descent. */
export const BOSS_STRUCT_Y = -150;
const BAND_TOP = 90;
const BAND_BOT = FIELD_H - 70;
const CENTER_Y = FIELD_H / 2;
const ENGAGE = 60; // x-distance at which two units trade blows

const CHARGE_MS = 3600; // focus-bar fill (zombies take a while to get out)
// Focus-bubble minigame thresholds: the fill pauses at 1/4, 2/4, 3/4 (a butterfly
// distraction) and again at full (a brain, gating the release). Popping a bubble
// resumes instantly; if the player never taps, it auto-resolves after these
// generous timeouts so the battle can't soft-lock.
const CHARGE_STEPS = [0.25, 0.5, 0.75, 1];
const BUTTERFLY_AUTO_MS = 4200; // distraction auto-refocuses if not popped
const BRAIN_AUTO_MS = 3200; // full bar auto-advances if not popped
const STEP_SPEED = 260; // zombie stepping out to its lane (px/s)
const EMERGE_SPEED = 210; // enemy walking in from the right (px/s)
const ENEMY_EMERGE_GAP_MS = 450; // beat before the next enemy emerges
const MAX_ACTIVE_ENEMIES = 1; // enemies fight one at a time (raise for a line)
const MAX_SIM_MS = 4 * 60 * 1000; // hard safety cap (min-damage 1 avoids stalls)

// Front formation: released zombies form up in up to MAX_ROWS rows, filling into
// depth columns behind. Only the front column (at the line) reaches the enemy, so
// at most MAX_ROWS zombies fight at once. Headless zombies take front slots.
const MAX_ROWS = 4;
const ROW_GAP = 46; // vertical spacing between rows
const COL_GAP = 52; // depth spacing between columns
const FRONT_X = ENEMY_HOLD_X - ENGAGE;
const SUPPORT_X = CHARGE_X + (FRONT_X - CHARGE_X) * 0.5;

// Mini Buddy: a waiting Small zombie mounts a Large zombie, rides to the line at
// double speed, then dismounts as both join combat and the arrival stuns the enemy.
const MINI_MOUNT_MS = 500;
const MINI_ARRIVAL_STUN_MS = 1000;

// Garden support cadence. These values are deliberately modest: support gives up
// its normal frontline attacks while it stands back and heals.
const HEAL_SINGLE_MS = 4000;
const HEAL_AOE_MS = 7000;
const HEAL_SINGLE_FRAC = 0.12;
const HEAL_AOE_FRAC = 0.08;

// Ballistic throws.
const GRAVITY = 820; // sim px/s^2 pulling projectiles down
const GROUND_Y = BAND_BOT + 24; // a throw that reaches here has missed (fizzles)
const ZOMBIE_HIT_R = 30; // zombie collision radius in sim units
const PROJ_HIT_FACTOR = 0.4; // projectile radius = spriteSize * this
// Predictive lead: throws aim where the target WILL be after the flight time, but the
// lead speed is CAPPED here — a target moving faster than this is led only as much as a
// "lowish speed" zombie would be, so the throw lands behind it and a fast zombie outruns
// the shot. Normal/slow zombies (≤ cap) are led accurately and get hit. Chosen against
// advanceSpeed(dex) (90–260): ~dex 1–4 (≤178) are led enough to connect; dex 5+ (≥200)
// under-lead into a miss on the longer lobs to the back of the lane.
const PREDICT_SPEED_CAP = 150; // sim px/s — never lead a target faster than this
// Above this per-step displacement, a unit was teleported (knockback re-slot, boss
// perch↔ground) rather than walking — its measured velocity is discarded (max real
// step is moveSpeed≤260 × dt≤0.05s ≈ 13 px).
export const TELEPORT_PX = 40;
// Raw bossActions throw damage (6/12/18) has no melee-comparable scale in the data, so
// it's a tuned chip value. Scaled to sit alongside the ground-truth melee/HP numbers
// (a basic zombie is now ~14 dmg/hit vs con×100 HP): raw 6/12/18 × 1.75 = ~10/21/32,
// i.e. a throw ≈ a couple of melee hits. (Kept proportional to the ×7 melee-damage
// increase from the fight-data correction; NOT ground truth — tune with playtesting.)
const PROJ_DMG_SCALE = 1.75;

// ---- Round timer + enrage (ZFFightMan updateTimer:/showEnrageTimer) ----
// The fight is a countdown; when it expires the boss ENRAGES. The reference build
// shows a 3:00 round. On enrage the boss throws twice as fast, recovers its special
// actions faster, and hits ~1.5× harder (chip → threat if you stall).
const DEFAULT_ROUND_MS = 3 * 60 * 1000; // 3:00
const ENRAGE_THROW_MULT = 0.5; // throw interval halves
const ENRAGE_SPECIAL_MULT = 0.6; // special cooldowns shorten
const ENRAGE_DMG_MULT = 1.5; // boss melee damage grows

// ---- Boss special actions (non-throw bossActions) ----
// alienLaser fires a fast straight bolt; pixelFire is an AoE burst; turnZombie
// removes your front zombie (it's turned against you); telekinesis is a heavy
// single hit. summonBoss/wall need spawned entities and are DEFERRED (the scheduler
// ticks them so timing stays faithful, but they land no effect yet).
const LASER_SPEED = 900; // straight-bolt speed (sim px/s)
const DEFAULT_SPECIAL_DMG = 8; // data carries no damage for most specials
const SPECIAL_DMG_SCALE = 1.75; // same chip-scaling as thrown projectiles (see PROJ_DMG_SCALE)

// ---- Knockback (Actor knockBackBy:force:) ----
// A knockback attack interrupts the struck zombie and, in the source, calls
// `setZombieToLastIndex` — it's sent to the BACK of the line. Here it's shoved back
// down the lane and re-slotted last, so it must charge to the front again.
const KNOCKBACK_PX = 150; // how far back the zombie is shoved (sim units)

// ---- Grab hazards (Lawyers cars / Circus trapeze `grabZombie`) ----
// A grab seizes the zombie and drops it at the back — modeled as a long stun plus a
// knockback to the rear of the line.
const GRAB_STUN_MS = 2500;

// ---- Boss summon / wall specials ----
const SUMMON_CAP = 3; // most extra minions a boss can summon in one fight

// ---- Environmental obstacle hazards (spawnObstacle:) ----
const OBSTACLE_SPEED = 190; // obstacle crossing speed (sim px/s), right→left

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Deterministic 0..1 hash (no RNG — keeps the sim replayable). */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

/** Zombie advance speed scales with DEX (quicker zombies reach the front sooner). */
function advanceSpeed(dex: number): number {
  return clamp(90 + dex * 22, 90, 260);
}

/** A loose 2D spot in the left-side waiting group. */
function clusterHome(i: number): { x: number; y: number } {
  const cols = 3;
  const bx = 45 + (i % cols) * 32;
  const by = BAND_TOP + 40 + Math.floor(i / cols) * 42;
  const jx = (hash(i * 2 + 1) - 0.5) * 26;
  const jy = (hash(i * 2 + 7) - 0.5) * 26;
  return { x: clamp(bx + jx, 26, 158), y: clamp(by + jy, BAND_TOP, BAND_BOT) };
}

export type UnitState =
  | "waiting" // zombie milling in the back group
  | "charging" // zombie stepping out + focusing
  | "advance" // released, moving to the front line
  | "fight" // trading blows
  | "carried" // Small zombie riding a Large zombie via Mini Buddy
  | "queued" // enemy off-screen, not yet emerged
  | "descending" // boss coming down off the structure + exiting out the back
  | "emerging" // enemy walking to its holding spot (or boss re-entering)
  | "structure" // boss perched on its structure, throwing
  | "hold" // enemy standing, no target in range
  | "dead";

/** A combatant with spatial + charge state, consumed by the renderer each frame. */
export interface SimUnit {
  id: string;
  sourceKey: string;
  mutation: number;
  team: "player" | "enemy";
  name: string;
  isBoss: boolean;
  isGarden: boolean;
  isHeadless: boolean;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  state: UnitState;
  charge: number; // 0..1 focus fill (zombies only)
  focus: number; // 0..100 focus stat: distraction resistance (ground truth Help.json)
  // ---- focus-bubble minigame (zombies, while charging) ----
  distracted: boolean; // butterfly bubble showing — fill paused until popped
  awaitRelease: boolean; // brain bubble showing — full, gated until popped
  distractStep: number; // how many CHARGE_STEPS have fired (0..4)
  distractSeed: number; // per-unit seed for the deterministic distraction roll
  bubbleMs: number; // ms until the current bubble auto-resolves
  struckThisTick: boolean;
  vx: number; // measured velocity over the last step (sim px/s) — drives throw lead
  vy: number;
  prevX: number; // position at the start of the current step (velocity bookkeeping)
  prevY: number;
  damage: number;
  cooldownMs: number;
  timerMs: number;
  moveSpeed: number;
  homeX: number; // waiting-group spot (zombies)
  homeY: number;
  mill: number; // per-unit wander phase
  formOrder: number; // release order (formation priority tiebreak)
  slotX: number; // assigned formation position
  slotY: number;
  // ---- abilities ----
  abilities: string[]; // this unit's unlocked ability keys (players only)
  activatedKey: string | null; // the ONE activated move it performs (or null)
  windupKey: string | null; // the activated move currently charging (null = none)
  windupMs: number; // ms left in the current wind-up
  windupTotal: number; // full wind-up duration (for the charge bar)
  abilityCdMs: number; // cooldown before this unit can be activated again
  buddyId: string | null; // Small zombie currently carried by this Large zombie
  buddyCarrierId: string | null; // Large zombie carrying this Small zombie
  buddyMountMs: number; // jump-to-carrier animation time remaining
  healTimerMs: number; // Garden support heal cadence
  healFxSeq: number; // increments when this unit receives a heal (renderer trigger)
  healCastSeq: number; // increments when this Garden zombie performs a heal
  stunMs: number; // ms of stun left — can't act while > 0 (enemies AND zombies)
  // ---- enemy attack effects inflicted on a struck zombie ----
  knockBack: boolean; // this enemy's attack shoves the zombie back down the lane
  stunInflictMs: number; // stun this enemy applies to a zombie on hit (ms)
  attackDamageTiming: number; // 0..1 fraction of the swing when it connects (enemy anim)
}

/** A boss projectile in flight, consumed by the renderer. Ballistic throws use the
 *  default gravity; straight-line hazards (alien laser, crossing obstacles) set
 *  `gravity: 0`. `crossing` hazards traverse the lane and expire off the left edge
 *  instead of fizzling when they reach the ground. `hazard` tags obstacle actors so
 *  the spawner can honour the raid's concurrent-obstacle limit. */
export interface SimProjectile {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rotSpeed: number;
  damage: number;
  sprite: string;
  spriteSize: number;
  done: boolean;
  gravity: number;
  crossing: boolean;
  hazard: boolean;
  grab: boolean; // grab hazard (car/trapeze): seizes the zombie instead of damaging it
}

/** Compact, JSON-safe verifier state used by the server's 15-second replay checkpoints. */
export interface BattleSimSnapshot {
  units: SimUnit[];
  projectiles: SimProjectile[];
  bossId: string | null;
  throwTimer: number;
  throwCount: number;
  releaseSeq: number;
  projSeq: number;
  elapsed: number;
  emergeCooldown: number;
  attacksLanded: number;
  playerDamage: number;
  roundLeft: number;
  enraged: boolean;
  specialCd: number;
  specialCast: number;
  pendingSpecial: BossSpecial | null;
  obstacleTimer: number;
  summonsLeft: number;
  spawnSeq: number;
  activatedKeys: string[];
}

function toSim(u: CombatUnit, i: number): SimUnit {
  const mult = u.attacks[0]?.mult ?? 1;
  const isPlayer = u.team === "player";
  const home = isPlayer ? clusterHome(i) : { x: ENEMY_SPAWN_X, y: CENTER_Y };
  const abilities = isPlayer ? u.abilities ?? [] : [];
  return {
    id: u.id,
    sourceKey: u.sourceKey,
    mutation: u.mutation ?? 0,
    team: u.team,
    name: u.name,
    isBoss: u.isBoss,
    isGarden: u.isGarden,
    isHeadless: u.isHeadless,
    x: home.x,
    y: home.y,
    hp: u.maxHp,
    maxHp: u.maxHp,
    alive: true,
    state: isPlayer ? "waiting" : "queued",
    charge: 0,
    focus: u.focus ?? 0,
    distracted: false,
    awaitRelease: false,
    distractStep: 0,
    distractSeed: i,
    bubbleMs: 0,
    struckThisTick: false,
    vx: 0,
    vy: 0,
    prevX: home.x,
    prevY: home.y,
    // Ground-truth per-swing damage: finalPower(str×10) × attackMult × K(0.7).
    damage: Math.max(1, Math.round(
      deriveHitDamage(u.str * POWER_PER_STR, mult) * (isPlayer ? 1 : ENEMY_DAMAGE_MULT)
    )),
    cooldownMs: u.attackCooldownMs,
    timerMs: u.attackCooldownMs,
    moveSpeed: isPlayer ? advanceSpeed(u.dex) : EMERGE_SPEED,
    homeX: home.x,
    homeY: home.y,
    mill: hash(i * 3 + 2) * Math.PI * 2,
    formOrder: 0,
    slotX: home.x,
    slotY: home.y,
    abilities,
    activatedKey: isPlayer ? activatedKeyFor(abilities) : null,
    windupKey: null,
    windupMs: 0,
    windupTotal: 0,
    abilityCdMs: 0,
    buddyId: null,
    buddyCarrierId: null,
    buddyMountMs: 0,
    healTimerMs: 0,
    healFxSeq: 0,
    healCastSeq: 0,
    stunMs: 0,
    knockBack: !isPlayer && !!u.knockBack,
    stunInflictMs: isPlayer ? 0 : u.stunMs ?? 0,
    attackDamageTiming: u.attackDamageTiming ?? 0.5,
  };
}

export class BattleSim {
  readonly units: SimUnit[];
  readonly projectiles: SimProjectile[] = [];
  private players: SimUnit[];
  private enemies: SimUnit[];
  private boss: SimUnit | null;
  private bossThrow: BossThrowConfig | null;
  private throwTimer: number;
  private throwCount = 0;
  private releaseSeq = 0;
  private projSeq = 0;
  private elapsed = 0;
  private emergeCooldown = 0;
  private attacksLanded = 0;
  private playerDamage = 0;
  finished = false;
  // ---- round timer + enrage ----
  private roundLeft: number;
  private _enraged = false;
  // ---- boss special actions ----
  private specials: BossSpecial[];
  private specialCd = 0; // recovery until the next special can start
  private specialCast = 0; // wind-up left on the pending special
  private pendingSpecial: BossSpecial | null = null;
  // ---- environmental obstacle hazards ----
  private hazard: HazardConfig | null;
  private obstacleTimer = 0;
  // ---- summon / wall specials ----
  private summonTemplate: CombatUnit | null;
  private wallTemplate: CombatUnit | null;
  private summonsLeft: number;
  private spawnSeq = 0;
  /** Distinct ACTIVATED moves present in the army (fixed) — the tappable strip. */
  readonly activatedKeys: string[];
  /** Distinct TEAM-passive abilities present (fixed) — the strip's info icons. */
  readonly teamKeys: string[];

  constructor(
    playerUnits: CombatUnit[],
    enemyUnits: CombatUnit[],
    bossThrow: BossThrowConfig | null = null,
    /** Concentration boost spent: skip the focus-bubble minigame (no distractions,
     *  auto-release at full), matching the boost's "fight at full focus" effect. */
    private concentration = false,
    /** Boss special (non-throw) actions to schedule. */
    bossSpecials: BossSpecial[] = [],
    /** Environmental obstacle hazards for this raid (null = none). */
    hazard: HazardConfig | null = null,
    /** Round length before the boss enrages (ms). */
    roundMs: number = DEFAULT_ROUND_MS,
    /** Unit the boss's `summonBoss` action spawns (null = don't summon). */
    summonTemplate: CombatUnit | null = null,
    /** Blocker the boss's `wall` action spawns (null = don't). */
    wallTemplate: CombatUnit | null = null
  ) {
    // Boss always resolves last, after the normal enemies.
    const ordered = [...enemyUnits].sort((a, b) => Number(a.isBoss) - Number(b.isBoss));
    this.players = playerUnits.map((u, i) => toSim(u, i));
    this.enemies = ordered.map((u, i) => toSim(u, i));
    this.units = [...this.players, ...this.enemies];

    this.boss = this.enemies.find((e) => e.isBoss) ?? null;
    if (this.boss) {
      this.boss.state = "structure";
      this.boss.x = BOSS_STRUCT_X;
      this.boss.y = BOSS_STRUCT_Y;
    }
    this.bossThrow = bossThrow;
    this.throwTimer = bossThrow?.intervalMs ?? 0;
    this.specials = this.boss ? bossSpecials : [];
    this.hazard = hazard;
    this.roundLeft = roundMs;
    this.summonTemplate = this.boss ? summonTemplate : null;
    this.wallTemplate = this.boss ? wallTemplate : null;
    this.summonsLeft = SUMMON_CAP;
    // A raid whose obstacle actor spawns one at the start (e.g. the beach Crab)
    // drops its first obstacle immediately.
    if (hazard?.initial) this.spawnObstacle();

    // Keep every activated move represented. In particular, Mini Buddy remains
    // available on a veteran Large zombie even when it also owns Bash/Smash.
    this.activatedKeys = [
      ...new Set(this.players.flatMap((p) => p.abilities.filter((k) => !!ACTIVATED_ABILITY[k]))),
    ];
    this.teamKeys = [...new Set(this.players.flatMap((p) => teamAbilitiesIn(p.abilities)))];
  }

  snapshot(): BattleSimSnapshot {
    return {
      units: this.units.map((u) => ({ ...u, abilities: [...u.abilities] })),
      projectiles: this.projectiles.map((p) => ({ ...p })),
      bossId: this.boss?.id ?? null,
      throwTimer: this.throwTimer,
      throwCount: this.throwCount,
      releaseSeq: this.releaseSeq,
      projSeq: this.projSeq,
      elapsed: this.elapsed,
      emergeCooldown: this.emergeCooldown,
      attacksLanded: this.attacksLanded,
      playerDamage: this.playerDamage,
      roundLeft: this.roundLeft,
      enraged: this._enraged,
      specialCd: this.specialCd,
      specialCast: this.specialCast,
      pendingSpecial: this.pendingSpecial ? { ...this.pendingSpecial } : null,
      obstacleTimer: this.obstacleTimer,
      summonsLeft: this.summonsLeft,
      spawnSeq: this.spawnSeq,
      activatedKeys: [...this.activatedKeys],
    };
  }

  restore(snapshot: BattleSimSnapshot): void {
    this.units.splice(0, this.units.length, ...snapshot.units.map((u) => ({
      ...u,
      abilities: [...u.abilities],
      healCastSeq: u.healCastSeq ?? 0,
    })));
    this.players = this.units.filter((u) => u.team === "player");
    this.enemies = this.units.filter((u) => u.team === "enemy");
    this.boss = snapshot.bossId ? this.units.find((u) => u.id === snapshot.bossId) ?? null : null;
    this.projectiles.splice(0, this.projectiles.length, ...snapshot.projectiles.map((p) => ({ ...p })));
    this.throwTimer = snapshot.throwTimer;
    this.throwCount = snapshot.throwCount;
    this.releaseSeq = snapshot.releaseSeq;
    this.projSeq = snapshot.projSeq;
    this.elapsed = snapshot.elapsed;
    this.emergeCooldown = snapshot.emergeCooldown;
    this.attacksLanded = snapshot.attacksLanded;
    this.playerDamage = snapshot.playerDamage;
    this.roundLeft = snapshot.roundLeft;
    this._enraged = snapshot.enraged;
    this.specialCd = snapshot.specialCd;
    this.specialCast = snapshot.specialCast;
    this.pendingSpecial = snapshot.pendingSpecial ? { ...snapshot.pendingSpecial } : null;
    this.obstacleTimer = snapshot.obstacleTimer;
    this.summonsLeft = snapshot.summonsLeft;
    this.spawnSeq = snapshot.spawnSeq;
    this.activatedKeys.splice(0, this.activatedKeys.length, ...snapshot.activatedKeys);
  }

  // ---- activated abilities (player-triggered from the battle strip) ----

  private isLarge(p: SimUnit): boolean {
    return /^ZombieActorLarge/i.test(p.sourceKey);
  }

  private isSmall(p: SimUnit): boolean {
    return /^ZombieActorSmall/i.test(p.sourceKey);
  }

  private isHealer(p: SimUnit): boolean {
    return p.isGarden && (p.abilities.includes("heal") || p.abilities.includes("healAOE"));
  }

  private availableMini(): SimUnit | null {
    return this.players.find(
      (p) => p.alive && this.isSmall(p) && !p.buddyCarrierId &&
        (p.state === "waiting" || p.state === "charging")
    ) ?? null;
  }

  /** A player unit is READY for an activated move when it's alive, in the thick of
   *  the fight, off cooldown, and not already charging one. */
  private readyToActivate(p: SimUnit, key: string): boolean {
    if (key === "attachMini") {
      return (
        p.alive && this.isLarge(p) && p.abilities.includes(key) && !p.buddyId &&
        (p.state === "waiting" || p.state === "charging") && !!this.availableMini()
      );
    }
    return (
      p.alive &&
      p.team === "player" &&
      p.abilities.includes(key) &&
      p.state === "fight" &&
      !p.windupKey &&
      p.abilityCdMs <= 0
    );
  }

  /** Ready-count per activated move, for the strip's badges. */
  activatedStatus(): { key: string; ready: number }[] {
    return this.activatedKeys.map((key) => ({
      key,
      ready: this.players.filter((p) => this.readyToActivate(p, key)).length,
    }));
  }

  /** Trigger an activated move on ONE eligible zombie (the front-most). Returns
   *  false if none is ready. Starts the wind-up; the payoff lands when it fills. */
  activate(key: string): boolean {
    const ab = ACTIVATED_ABILITY[key];
    if (!ab) return false;
    let pick: SimUnit | null = null;
    for (const p of this.players) {
      if (!this.readyToActivate(p, key)) continue;
      if (!pick || p.x > pick.x) pick = p; // front-most (nearest the enemy)
    }
    if (!pick) return false;
    if (key === "attachMini") {
      const mini = this.availableMini();
      if (!mini) return false;
      pick.buddyId = mini.id;
      mini.buddyCarrierId = pick.id;
      mini.buddyMountMs = MINI_MOUNT_MS;
      mini.state = "carried";
      mini.distracted = false;
      mini.awaitRelease = false;
      return true;
    }
    pick.windupKey = key;
    pick.windupMs = ab.windupMs;
    pick.windupTotal = ab.windupMs;
    return true;
  }

  /** Advance a charging zombie; on completion deliver the payoff blow. While it
   *  charges it makes no normal attacks (the wind-up is the trade-off). */
  private stepWindup(p: SimUnit, foe: SimUnit, dtMs: number) {
    p.windupMs -= dtMs;
    if (p.windupMs > 0) return;
    const key = p.windupKey!;
    const ab = ACTIVATED_ABILITY[key]!;
    const dmg = Math.max(1, Math.round(p.damage * ab.damageFactor));
    if (ab.aoe) {
      for (const e of this.enemies) {
        if (!e.alive || e.state === "queued" || e.state === "structure" || e.state === "descending") continue;
        this.dealDamage(e, dmg, true);
        if (ab.stunMs) e.stunMs = Math.max(e.stunMs, ab.stunMs);
        this.playerDamage += dmg;
      }
    } else {
      this.dealDamage(foe, dmg, true);
      if (ab.stunMs) foe.stunMs = Math.max(foe.stunMs, ab.stunMs);
      this.playerDamage += dmg;
    }
    p.struckThisTick = true;
    this.attacksLanded++;
    p.windupKey = null;
    p.windupMs = 0;
    p.abilityCdMs = ab.cooldownMs;
    p.timerMs = p.cooldownMs; // resume normal attacks after a beat
  }

  /** Dismount a Mini Buddy at the line. Both units remain alive and committed;
   *  the arrival briefly stuns the current enemy before normal attacks resume. */
  private deployMiniBuddy(carrier: SimUnit, foe: SimUnit | null) {
    if (!carrier.buddyId) return;
    const mini = this.players.find((p) => p.id === carrier.buddyId);
    carrier.buddyId = null;
    carrier.abilityCdMs = ACTIVATED_ABILITY.attachMini.cooldownMs;
    if (foe) foe.stunMs = Math.max(foe.stunMs, MINI_ARRIVAL_STUN_MS);
    if (!mini || !mini.alive) return;
    mini.buddyCarrierId = null;
    mini.buddyMountMs = 0;
    mini.x = carrier.x - 10;
    mini.y = carrier.y;
    mini.prevX = mini.x;
    mini.prevY = mini.y;
    mini.charge = 1;
    mini.formOrder = carrier.formOrder + 0.25;
    mini.state = "advance";
    mini.timerMs = mini.cooldownMs;
  }

  /** Garden support heals from its rear position. Heal targets the most injured
   *  deployed ally; Heal All restores every damaged deployed ally. */
  private stepHealing(dtMs: number) {
    const deployed = this.players.filter(
      (p) => p.alive && (p.state === "advance" || p.state === "fight")
    );
    for (const healer of deployed) {
      if (!this.isHealer(healer)) continue;
      healer.healTimerMs -= dtMs;
      if (healer.healTimerMs > 0) continue;

      const aoe = healer.abilities.includes("healAOE");
      const damaged = deployed.filter((p) => p.hp < p.maxHp && (aoe || p.id !== healer.id));
      if (!damaged.length) {
        healer.healTimerMs = 250; // check again soon without banking many instant heals
        continue;
      }

      const targets = aoe
        ? damaged
        : [damaged.reduce((a, b) => b.hp / b.maxHp < a.hp / a.maxHp ? b : a)];
      const frac = aoe ? HEAL_AOE_FRAC : HEAL_SINGLE_FRAC;
      for (const target of targets) {
        const amount = Math.max(1, Math.round(target.maxHp * frac));
        target.hp = Math.min(target.maxHp, target.hp + amount);
        target.healFxSeq++;
      }
      healer.healCastSeq++;
      healer.healTimerMs = aoe ? HEAL_AOE_MS : HEAL_SINGLE_MS;
    }
  }

  /** Nearest enemy a zombie can reach (on the ground, not queued/perched). */
  private targetEnemy(u: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.state === "queued" || e.state === "structure" || e.state === "descending") continue;
      const d = Math.abs(e.x - u.x);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** The FRONT-MOST player within an enemy's striking range — the single zombie
   *  nearest the enemy down the lane, NOT the whole front row. Enemies commit all
   *  their damage to this one target (a big/slow hit knocks it back or drops it
   *  rather than chipping the entire line), so losses are more focused. Among the
    *  front column (zombies sharing the lead x) the tiebreak picks the visually
    *  front-most unit (largest y), matching the renderer's depth order. */
  private playerInRange(e: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (Math.abs(p.x - e.x) > ENGAGE) continue; // out of melee lane range
      if (
        !best ||
        p.x > best.x + 0.5 || // more forward (nearer the enemy) wins
        (Math.abs(p.x - best.x) <= 0.5 && p.y > best.y)
      ) {
        best = p;
      }
    }
    return best;
  }

  /** Whom the boss aims at: the FARTHEST-BACK deployed zombie (min x), so lobbed
   *  throws arc over the frontline tanks and land on the support/healers massed
   *  behind them. "Deployed" = released from the focus bar (brain popped) and now
   *  advancing/fighting on the lane; zombies still waiting or charging are off-limits.
   *  Returns null when nothing is deployed — so the boss doesn't throw at an empty
   *  lane. The lead (see leadVelocity) is applied at launch. */
  private throwTarget(): SimUnit | null {
    const deployed = this.players.filter(
      (p) => p.alive && (p.state === "advance" || p.state === "fight")
    );
    if (!deployed.length) return null;
    return deployed.reduce((a, b) => (b.x < a.x ? b : a));
  }

  /** The velocity a throw leads a target by: its MEASURED velocity (how it actually
   *  moved last step), CLAMPED to PREDICT_SPEED_CAP. So a slow/normal zombie is led by
   *  its true speed (and gets hit), while a fast one is led only as if it were "lowish
   *  speed" — the shot lands behind it and it outruns the throw. Zero when it's not
   *  moving (parked at its slot, fighting), so a stationary target is aimed at directly. */
  private leadVelocity(u: SimUnit): { vx: number; vy: number } {
    const spd = Math.hypot(u.vx, u.vy);
    if (spd < 1) return { vx: 0, vy: 0 };
    const k = Math.min(1, PREDICT_SPEED_CAP / spd);
    return { vx: u.vx * k, vy: u.vy * k };
  }

  private anyAlive(side: SimUnit[]): boolean {
    return side.some((u) => u.alive);
  }

  /** Land a hit from `u` on `foe` when its clock is ready; else re-arm. An enemy
   *  hit can also knock the zombie back (to the back of the line) and/or stun it. */
  private tryAttack(u: SimUnit, foe: SimUnit, dtMs: number) {
    u.timerMs -= dtMs;
    if (u.timerMs > 0) return;
    u.timerMs += u.cooldownMs;
    this.dealDamage(foe, u.damage, u.team === "player");
    u.struckThisTick = true;
    this.attacksLanded++;
    if (u.team === "player") {
      this.playerDamage += u.damage;
    } else if (foe.alive && foe.team === "player") {
      // Enemy attack effects on the struck zombie.
      if (u.stunInflictMs > 0) foe.stunMs = Math.max(foe.stunMs, u.stunInflictMs);
      if (u.knockBack) this.knockBackZombie(foe);
    }
  }

  /** Knock a zombie back: interrupt its attack/wind-up, shove it down the lane, and
   *  send it to the BACK of the formation (source `setZombieToLastIndex`), so it has
   *  to advance to the front again. */
  private knockBackZombie(p: SimUnit) {
    p.windupKey = null;
    p.windupMs = 0;
    p.x = Math.max(CHARGE_X, p.x - KNOCKBACK_PX);
    p.formOrder = this.releaseSeq++; // last in the formation → back column
    p.state = "advance";
    p.timerMs = p.cooldownMs;
  }

  private dealDamage(foe: SimUnit, dmg: number, fromPlayer: boolean) {
    foe.hp -= dmg;
    if (foe.hp > 0) return;
    foe.hp = 0;
    foe.alive = false;
    foe.state = "dead";
    if (foe.buddyId) this.deployMiniBuddy(foe, null);
    if (foe.buddyCarrierId) {
      const carrier = this.players.find((p) => p.id === foe.buddyCarrierId);
      if (carrier) carrier.buddyId = null;
      foe.buddyCarrierId = null;
    }
    // A downed enemy opens the gate for the next to emerge after a beat.
    if (fromPlayer && foe.team === "enemy") this.emergeCooldown = ENEMY_EMERGE_GAP_MS;
  }

  /** Advance the charging zombie's focus bar, running the bubble minigame unless
   *  Concentration is active. See CHARGE_STEPS: the fill clamps to the next
   *  threshold so a big frame can't skip a distraction. */
  private stepCharge(p: SimUnit, dtMs: number) {
    if (this.concentration) {
      p.charge = Math.min(1, p.charge + dtMs / CHARGE_MS);
      if (p.charge >= 1) this.releaseCharger(p);
      return;
    }
    if (p.distracted) {
      p.bubbleMs -= dtMs;
      if (p.bubbleMs <= 0) p.distracted = false; // auto-refocus
      return;
    }
    if (p.awaitRelease) {
      p.bubbleMs -= dtMs;
      if (p.bubbleMs <= 0) this.releaseCharger(p); // auto-advance
      return;
    }
    const next = CHARGE_STEPS[p.distractStep] ?? 1;
    p.charge = Math.min(next, p.charge + dtMs / CHARGE_MS);
    if (p.charge >= next) {
      p.distractStep++;
      if (next >= 1) {
        // Full bar: gate the release (brain bubble). This is a release prompt, not
        // a focus roll, so it always shows (Concentration path above skips it).
        p.awaitRelease = true;
        p.bubbleMs = BRAIN_AUTO_MS;
      } else if (this.rollDistract(p)) {
        // Passing a 0.25 segment: distract only if the focus roll fails. Miss the
        // roll and the meter keeps filling toward the next segment uninterrupted.
        p.distracted = true;
        p.bubbleMs = BUTTERFLY_AUTO_MS;
      }
    }
  }

  /** Deterministic per-segment distraction roll. GROUND TRUTH (`-[FightFocusBar
   *  update:]`): at each 0.25 charge segment a zombie is distracted iff
   *  `rand01 > focus/100` — so focus 100 (premium) is NEVER distracted, and a
   *  focus-40 starter is distracted ~60% of the time per segment. Uses the
   *  replayable `hash` (keyed by the unit's seed + which segment) instead of an RNG
   *  so the sim stays deterministic/replayable. */
  private rollDistract(p: SimUnit): boolean {
    const r = hash(p.distractSeed * 16.7 + p.distractStep * 3.1);
    return r > clamp(p.focus, 0, 100) / 100;
  }

  /** Release a fully-charged zombie to advance to the front line. */
  private releaseCharger(p: SimUnit) {
    p.state = "advance";
    p.formOrder = this.releaseSeq++; // claim a formation slot on release
    p.distracted = false;
    p.awaitRelease = false;
  }

  /** Player tapped the focus bubble over the charging zombie: a butterfly
   *  (distraction) pop resumes the fill; a brain (full) pop sends it forward.
   *  Returns true if a bubble was actually popped (drives tap feedback). */
  popBubble(id: string): boolean {
    const p = this.players.find((u) => u.id === id);
    if (!p || !p.alive || p.state !== "charging") return false;
    if (p.awaitRelease) { this.releaseCharger(p); return true; }
    if (p.distracted) { p.distracted = false; return true; }
    return false;
  }

  /** The charging zombie showing a focus bubble right now (or null). Only one
   *  zombie charges at a time, so at most one bubble is ever live. */
  chargingBubble(): { id: string; kind: "butterfly" | "brain" } | null {
    const p = this.players.find(
      (u) => u.alive && u.state === "charging" && (u.distracted || u.awaitRelease)
    );
    return p ? { id: p.id, kind: p.awaitRelease ? "brain" : "butterfly" } : null;
  }

  /** Promote the zombie charge queue + the enemy emerge queue (one at a time). */
  private promote(dtMs: number) {
    this.emergeCooldown -= dtMs;

    const charging = this.players.some((p) => p.alive && p.state === "charging");
    if (!charging) {
      const next = this.players.find((p) => p.alive && p.state === "waiting");
      if (next) next.state = "charging";
    }

    if (this.emergeCooldown > 0) return;

    const activeMelee = this.enemies.filter(
      (e) => e.alive && !e.isBoss && e.state !== "queued"
    ).length;
    const normalsLeft = this.enemies.some((e) => !e.isBoss && e.alive);

    if (activeMelee < MAX_ACTIVE_ENEMIES) {
      const next = this.enemies.find((e) => e.alive && !e.isBoss && e.state === "queued");
      if (next) next.state = "emerging";
    }

    if (this.boss && this.boss.alive && this.boss.state === "structure" && !normalsLeft && activeMelee === 0) {
      this.boss.state = "descending"; // climb down, exit out the back, then re-enter
    }
  }

  /** Assign formation slots back-to-front within each depth column. The first
   *  combat-priority unit occupies the visually front-most (largest-y) row, and the
   *  enemy uses that same ordering when choosing a target. Garden healers hold at
   *  SUPPORT_X while any non-healer remains to maintain the frontline. */
  private assignFormation() {
    const committed = this.players.filter(
      (p) => p.alive && (p.state === "advance" || p.state === "fight")
    );
    const front = committed.filter((p) => !this.isHealer(p));
    const support = committed.filter((p) => this.isHealer(p));
    const frontline = front.length ? front : committed;
    const rear = front.length ? support : [];

    frontline.sort(
      (a, b) => Number(b.isHeadless) - Number(a.isHeadless) || a.formOrder - b.formOrder
    );
    rear.sort((a, b) => a.formOrder - b.formOrder);

    const place = (units: SimUnit[], baseX: number) => {
      const rowsUsed = Math.min(MAX_ROWS, units.length);
      units.forEach((p, i) => {
        const col = Math.floor(i / MAX_ROWS);
        const rowInCol = i % MAX_ROWS;
        const frontToBackRow = rowsUsed - 1 - rowInCol;
        p.slotX = baseX - col * COL_GAP;
        p.slotY = CENTER_Y + (frontToBackRow - (rowsUsed - 1) / 2) * ROW_GAP;
      });
    };
    place(frontline, FRONT_X);
    place(rear, SUPPORT_X);
  }

  /** Advance the sim by `dtMs`. Returns false once the battle is over. */
  step(dtMs: number): boolean {
    if (this.finished) return false;
    this.elapsed += dtMs;
    for (const u of this.units) {
      u.struckThisTick = false;
      u.prevX = u.x; // snapshot for this step's velocity measurement (see below)
      u.prevY = u.y;
    }

    this.promote(dtMs);
    this.stepEnrage(dtMs);

    // Boss throwing (only while perched and minions remain to cover for it).
    if (this.bossThrow && this.boss && this.boss.alive && this.boss.state === "structure") {
      this.throwTimer -= dtMs;
      if (this.throwTimer <= 0) {
        const target = this.throwTarget();
        if (target) {
          this.launchThrow(target);
          this.throwTimer += this.bossThrow.intervalMs;
        } else {
          this.throwTimer = 0;
        }
      }
    }
    this.stepBossSpecials(dtMs);
    this.stepObstacles(dtMs);
    this.stepProjectiles(dtMs);

    this.assignFormation();
    this.stepHealing(dtMs);
    const frontX = FRONT_X;

    // Zombies.
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.abilityCdMs > 0) p.abilityCdMs -= dtMs; // activated-move recharge
      switch (p.state) {
        case "waiting": {
          // Idle in the back group: stand STILL most of the time, with only an
          // occasional brief shuffle to a nearby spot — so the crowd looks alive
          // without the old constant pacing. Deterministic (cycle-indexed hash, no
          // RNG): each zombie holds a spot for ~85% of its cycle, then eases a few
          // px to the next spot in the last ~15%. No vertical hover.
          const off = p.mill / (Math.PI * 2); // 0..1 per-unit phase
          const period = 2600 + off * 2200; // 2.6-4.8s per shuffle cycle
          const raw = this.elapsed / period + off;
          const cyc = Math.floor(raw);
          const ph = raw - cyc; // 0..1 within the cycle
          const MOVE_FRAC = 0.12; // only the last 12% of the cycle is a shuffle
          const AMP = 14; // shuffle reach in sim px (was a ±26 constant pace) — big
          // enough that the brief shuffle clears the walk-anim threshold (a real
          // step, not a glide), while the long still stretch keeps them planted
          const spot = (c: number) => (hash(c * 1.73 + p.mill) - 0.5) * 2 * AMP;
          const from = spot(cyc);
          let d = from;
          if (ph > 1 - MOVE_FRAC) {
            const t = (ph - (1 - MOVE_FRAC)) / MOVE_FRAC; // 0..1 across the shuffle
            const e = t * t * (3 - 2 * t); // smoothstep ease
            d = from + (spot(cyc + 1) - from) * e;
          }
          p.x = p.homeX + d;
          p.y = p.homeY;
          break;
        }
        case "charging": {
          // Step out to the staging slot (in front of the group) and focus.
          const dx = CHARGE_X - p.x;
          const dy = CENTER_Y - p.y;
          const d = Math.hypot(dx, dy);
          const stepd = (STEP_SPEED * dtMs) / 1000;
          if (d > 2) {
            p.x += (dx / d) * Math.min(stepd, d);
            p.y += (dy / d) * Math.min(stepd, d);
            p.timerMs = p.cooldownMs;
          } else {
            this.stepCharge(p, dtMs);
          }
          break;
        }
        case "carried": {
          p.buddyMountMs = Math.max(0, p.buddyMountMs - dtMs);
          p.timerMs = p.cooldownMs;
          break;
        }
        default: {
          // Stunned by an enemy hit — can't move or attack until it wears off.
          if (p.stunMs > 0) {
            p.stunMs -= dtMs;
            p.timerMs = p.cooldownMs;
            break;
          }
          // Move to the assigned formation slot (never past the enemy).
          const mdx = p.slotX - p.x;
          const mdy = p.slotY - p.y;
          const md = Math.hypot(mdx, mdy);
          const stepd = (p.moveSpeed * (p.buddyId ? 2 : 1) * dtMs) / 1000;
          if (md > stepd) {
            p.x += (mdx / md) * stepd;
            p.y += (mdy / md) * stepd;
          } else {
            p.x = p.slotX;
            p.y = p.slotY;
          }
          // The formation is only for spacing / projectile hitboxes — EVERY zombie
          // that has reached the combat zone attacks the enemy once it has arrived
          // (not just the front row). The enemy still only strikes those in melee
          // range (the front), so front-row / headless zombies take the hits.
          const foe = this.targetEnemy(p);
          const enemyArrived = !!foe && (foe.state === "hold" || foe.state === "fight");
          const inCombatZone = p.x >= frontX - MAX_ROWS * COL_GAP - 12;
          const atSlot = Math.hypot(p.slotX - p.x, p.slotY - p.y) <= 2;
          if (p.buddyId && enemyArrived && atSlot) this.deployMiniBuddy(p, foe);
          if (foe && enemyArrived && inCombatZone) {
            p.state = "fight";
            // A charging zombie makes no normal attacks — it's winding up the big
            // hit; deliver the payoff when the wind-up fills. Otherwise attack.
            if (p.windupKey) this.stepWindup(p, foe, dtMs);
            else this.tryAttack(p, foe, dtMs);
          } else {
            p.state = "advance";
            p.timerMs = p.cooldownMs;
          }
        }
      }
    }

    // Enemies (emerge / boss descends, then stand and strike; never move otherwise).
    for (const e of this.enemies) {
      if (!e.alive || e.state === "queued" || e.state === "structure") continue;
      if (e.state === "descending") {
        // Leave the perch by heading OUT THE RIGHT SIDE (through the entrance),
        // staying up at structure height; the renderer slides it off-screen behind
        // the structure. Only once fully off-screen does it drop to the ground and
        // re-enter — no floating diagonally toward the middle.
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        e.x = Math.min(ENEMY_SPAWN_X, e.x + sx); // walk out to the hidden spawn
        e.timerMs = e.cooldownMs;
        if (e.x >= ENEMY_SPAWN_X) {
          e.x = ENEMY_SPAWN_X;
          e.y = CENTER_Y; // now a ground unit, hidden off the right edge
          e.state = "emerging"; // walk back in from the entrance, facing the zombies
        }
        continue;
      }
      if (e.state === "emerging") {
        // Re-enter from the right at ground level and walk left to the hold spot —
        // exactly where the normal enemies attack from.
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        e.x = Math.max(ENEMY_HOLD_X, e.x - sx);
        e.y = CENTER_Y;
        e.timerMs = e.cooldownMs;
        if (e.x <= ENEMY_HOLD_X) {
          e.x = ENEMY_HOLD_X;
          e.y = CENTER_Y;
          e.state = "hold";
        }
        continue;
      }
      // Stunned (by an Explode) — can't act; hold its attack clock.
      if (e.stunMs > 0) {
        e.stunMs -= dtMs;
        e.timerMs = e.cooldownMs;
        continue;
      }
      const foe = this.playerInRange(e);
      if (foe) {
        e.state = "fight";
        this.tryAttack(e, foe, dtMs);
      } else {
        e.state = "hold";
        e.timerMs = e.cooldownMs;
      }
    }

    // Measure each unit's velocity from this step's movement (for boss-throw lead).
    // A big jump is a teleport (knockback re-slot, boss perch↔ground) not real motion —
    // zero it so a throw doesn't lead a phantom high-speed vector.
    const dtSec = dtMs / 1000;
    if (dtSec > 0) {
      for (const u of this.units) {
        const ddx = u.x - u.prevX;
        const ddy = u.y - u.prevY;
        if (Math.hypot(ddx, ddy) > TELEPORT_PX) {
          u.vx = 0;
          u.vy = 0;
        } else {
          u.vx = ddx / dtSec;
          u.vy = ddy / dtSec;
        }
      }
    }

    if (!this.anyAlive(this.players) || !this.anyAlive(this.enemies) || this.elapsed >= MAX_SIM_MS) {
      this.finished = true;
    }
    return !this.finished;
  }

  /** Throw wind-up for the renderer's perched-boss throw animation: 0..1 filling over
   *  the last `windowMs` before the next throw releases (the arm cocks and swings), or
   *  null when the boss isn't perched-and-throwing / has no target. The projectile
   *  launches as this reaches 1, so the renderer can time the arm to the release. */
  bossThrowSwing(windowMs = 550, visualLeadMs = 0): number | null {
    if (!this.bossThrow || !this.boss || !this.boss.alive || this.boss.state !== "structure") {
      return null;
    }
    if (!this.throwTarget()) return null; // empty lane → arm rests
    const visualTimer = Math.max(0, this.throwTimer - visualLeadMs);
    if (visualTimer > windowMs) return 0;
    return clamp(1 - visualTimer / windowMs, 0, 1);
  }

  /** Whether the boss is "active" (able to throw / cast specials): alive and either
   *  perched on its structure or fighting on the ground (not descending/queued). */
  private bossActive(): boolean {
    const b = this.boss;
    return !!b && b.alive && (b.state === "structure" || b.state === "hold" || b.state === "fight");
  }

  /** Round countdown → enrage. When the timer expires the boss enrages once: throws
   *  come faster, specials recover faster, and its melee hits harder. */
  private stepEnrage(dtMs: number) {
    if (this._enraged || !this.boss || !this.boss.alive) return;
    this.roundLeft -= dtMs;
    if (this.roundLeft > 0) return;
    this._enraged = true;
    if (this.bossThrow) this.bossThrow.intervalMs *= ENRAGE_THROW_MULT;
    this.boss.damage = Math.max(1, Math.round(this.boss.damage * ENRAGE_DMG_MULT));
  }

  /** Boss special-action scheduler. Picks a weighted special, winds up for its
   *  castMs, then lands the effect and recovers for cooldownMs. Enrage shortens the
   *  recovery. Only runs while the boss is active and zombies are present. */
  private stepBossSpecials(dtMs: number) {
    if (!this.specials.length || !this.bossActive() || !this.anyAlive(this.players)) return;
    if (this.pendingSpecial) {
      this.specialCast -= dtMs;
      if (this.specialCast <= 0) {
        this.runSpecial(this.pendingSpecial);
        const cd = this.pendingSpecial.cooldownMs * (this._enraged ? ENRAGE_SPECIAL_MULT : 1);
        this.specialCd = Math.max(300, cd);
        this.pendingSpecial = null;
      }
      return;
    }
    this.specialCd -= dtMs;
    if (this.specialCd > 0) return;
    const pick = this.pickSpecial();
    if (!pick) return;
    this.pendingSpecial = pick;
    this.specialCast = Math.max(0, pick.castMs);
  }

  /** Weighted pick among the boss's specials (deterministic round-robin by count —
   *  the sim stays RNG-free). Returns null if none. */
  private pickSpecial(): BossSpecial | null {
    if (!this.specials.length) return null;
    return this.specials[this.throwCount % this.specials.length] ?? this.specials[0];
  }

  /** Land a boss special. Effects that need spawned entities (summonBoss, wall) are
   *  deferred — they still consume their cast/cooldown so timing is faithful. */
  private runSpecial(sp: BossSpecial) {
    const dmg = Math.max(1, Math.round((sp.damage || DEFAULT_SPECIAL_DMG) * SPECIAL_DMG_SCALE));
    switch (sp.name) {
      case "alienLaser": {
        const target = this.throwTarget();
        if (target) this.launchProjectile(target, dmg, "", 20, { straight: true });
        break;
      }
      case "pixelFire": {
        // AoE burst: chip every zombie that has moved out to fight.
        for (const p of this.players) {
          if (p.alive && (p.state === "advance" || p.state === "fight")) {
            this.dealDamage(p, dmg * ENEMY_DAMAGE_MULT, false);
            p.struckThisTick = true;
          }
        }
        break;
      }
      case "turnZombie": {
        // Zedzox turns a zombie against you — model as losing your front unit.
        const victim = this.frontFighter();
        if (victim) {
          this.dealDamage(victim, victim.hp, false);
          victim.struckThisTick = true;
        }
        break;
      }
      case "telekinesis": {
        // A heavy single-target lift+slam.
        const victim = this.frontFighter() ?? this.throwTarget();
        if (victim) {
          this.dealDamage(victim, dmg * 2 * ENEMY_DAMAGE_MULT, false);
          victim.struckThisTick = true;
        }
        break;
      }
      case "summonBoss": {
        // Reinforce with a fresh minion (capped so the fight still resolves). It
        // emerges through the normal queue, keeping the boss perched behind it.
        if (this.summonTemplate && this.summonsLeft > 0) {
          this.summonsLeft--;
          this.spawnEnemy(this.summonTemplate);
        }
        break;
      }
      case "wall": {
        // A high-HP blocker in the lane — spawn one only if none is standing.
        const wt = this.wallTemplate;
        if (wt && !this.enemies.some((e) => e.alive && e.sourceKey === wt.sourceKey)) {
          this.spawnEnemy(wt);
        }
        break;
      }
      // telekinesis handled above; anything else is a no-op.
      default:
        break;
    }
  }

  /** Spawn a new enemy from a template mid-fight (summoned minion / wall). It joins
   *  the enemy roster + the shared units array (so the renderer picks it up) and
   *  emerges through the normal one-at-a-time queue. */
  private spawnEnemy(template: CombatUnit): SimUnit {
    const su = toSim({ ...template, id: `spawn${this.spawnSeq++}` }, this.enemies.length);
    su.state = "queued";
    su.hp = su.maxHp;
    su.alive = true;
    this.enemies.push(su);
    this.units.push(su);
    return su;
  }

  /** Front-most fighting player zombie (nearest the enemy), or null. */
  private frontFighter(): SimUnit | null {
    let best: SimUnit | null = null;
    for (const p of this.players) {
      if (!p.alive || (p.state !== "fight" && p.state !== "advance")) continue;
      if (!best || p.x > best.x + 0.5 || (Math.abs(p.x - best.x) <= 0.5 && p.y > best.y)) best = p;
    }
    return best;
  }

  /** Spawn one crossing obstacle hazard from the right edge (honours the limit). */
  private spawnObstacle() {
    if (!this.hazard) return;
    const active = this.projectiles.filter((p) => p.hazard && !p.done).length;
    if (active >= this.hazard.limit) return;
    // Cross at the combat band (where zombies advance/fight), not the back of the
    // field — otherwise the hazard sweeps past below everyone and never connects.
    const y = CENTER_Y;
    this.projectiles.push({
      id: `haz${this.projSeq++}`,
      x: ENEMY_HOLD_X,
      y,
      vx: -OBSTACLE_SPEED,
      vy: 0,
      rot: 0,
      rotSpeed: -4,
      damage: this.hazard.damage
        ? Math.max(1, Math.round(this.hazard.damage * PROJECTILE_DAMAGE_MULT))
        : 0,
      sprite: this.hazard.sprite,
      spriteSize: 40,
      done: false,
      gravity: 0,
      crossing: true,
      hazard: true,
      grab: !!this.hazard.grab,
    });
  }

  /** Obstacle spawn cadence: drop a new obstacle every spawnMs, up to the limit. */
  private stepObstacles(dtMs: number) {
    if (!this.hazard || !this.anyAlive(this.players)) return;
    this.obstacleTimer -= dtMs;
    if (this.obstacleTimer > 0) return;
    this.obstacleTimer = this.hazard.spawnMs;
    this.spawnObstacle();
  }

  /** Launch a ballistic throw at the target zombie, leading its (capped) motion. */
  private launchThrow(target: SimUnit) {
    const opts = this.bossThrow!.options;
    const opt = opts[this.throwCount % opts.length]; // deterministic round-robin
    this.throwCount++;
    this.launchProjectile(
      target,
      Math.max(1, Math.round(opt.damage * PROJ_DMG_SCALE)),
      opt.sprite,
      opt.spriteSize
    );
  }

  /** Launch a projectile at a target, LEADING its (capped) motion so it connects with
   *  advancing zombies. Ballistic by default (a lobbed throw); pass `straight` for a
   *  fast flat bolt (alien laser). */
  private launchProjectile(
    target: SimUnit,
    damage: number,
    sprite: string,
    spriteSize: number,
    opts: { straight?: boolean } = {}
  ) {
    const x0 = BOSS_STRUCT_X;
    const y0 = BOSS_STRUCT_Y;
    const grav = opts.straight ? 0 : GRAVITY;
    // Flight time: a straight bolt is range/speed; a ballistic lob scales with range.
    const T = opts.straight
      ? (Math.hypot(target.x - x0, target.y - y0) || 1) / LASER_SPEED
      : clamp(Math.abs(target.x - x0) / 520 + 0.7, 0.85, 1.7);
    // Aim where the target will be after T, using its speed-capped lead velocity.
    const { vx: lvx, vy: lvy } = this.leadVelocity(target);
    const tx = target.x + lvx * T;
    const ty = target.y + lvy * T;
    let vx: number;
    let vy: number;
    if (opts.straight) {
      const dx = tx - x0;
      const dy = ty - y0;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * LASER_SPEED;
      vy = (dy / d) * LASER_SPEED;
    } else {
      vx = (tx - x0) / T;
      vy = (ty - y0) / T - 0.5 * GRAVITY * T; // ballistic solve to the lead point
    }
    this.projectiles.push({
      id: `proj${this.projSeq++}`,
      x: x0,
      y: y0,
      vx,
      vy,
      rot: 0,
      rotSpeed: (vx < 0 ? -1 : 1) * 7,
      damage: Math.max(1, Math.round(damage * PROJECTILE_DAMAGE_MULT)),
      sprite,
      spriteSize,
      done: false,
      gravity: grav,
      crossing: false,
      hazard: false,
      grab: false,
    });
  }

  /** Integrate each throw under gravity; lazy circle collision vs zombies; a throw
   *  that reaches the ground has missed. Fast/small zombies can be missed. */
  private stepProjectiles(dtMs: number) {
    const dt = dtMs / 1000;
    for (const pr of this.projectiles) {
      if (pr.done) continue;
      pr.vy += pr.gravity * dt; // gravity 0 for straight bolts / crossing hazards
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.rot += pr.rotSpeed * dt;
      const hitR = ZOMBIE_HIT_R + pr.spriteSize * PROJ_HIT_FACTOR;
      for (const p of this.players) {
        // A thrown item / hazard can only strike zombies that have moved out to
        // fight — ones still waiting in the group or charging up are safe.
        if (!p.alive || (p.state !== "advance" && p.state !== "fight")) continue;
        const dx = p.x - pr.x;
        const dy = p.y - pr.y;
        if (dx * dx + dy * dy <= hitR * hitR) {
          if (pr.grab) {
            // Seized (car/trapeze): held out of the fight and dropped at the back.
            p.stunMs = Math.max(p.stunMs, GRAB_STUN_MS);
            this.knockBackZombie(p);
          } else {
            this.dealDamage(p, pr.damage, false);
          }
          p.struckThisTick = true;
          pr.done = true;
          break;
        }
      }
      if (pr.done) continue;
      // Crossing hazards run the length of the lane and expire off the left edge;
      // ballistic throws fizzle (miss) once they reach the ground.
      if (pr.crossing) {
        if (pr.x <= -60) pr.done = true;
      } else if (pr.y >= GROUND_Y) {
        pr.done = true;
      }
    }
    // Compact in place (keep the readonly array reference stable).
    let w = 0;
    for (let r = 0; r < this.projectiles.length; r++) {
      if (!this.projectiles[r].done) this.projectiles[w++] = this.projectiles[r];
    }
    this.projectiles.length = w;
  }

  /** Whether the player side won (all enemies dead). Meaningful once finished. */
  get playerWon(): boolean {
    return !this.anyAlive(this.enemies);
  }

  /** Ms left before the boss enrages (0 once enraged / no boss). For the HUD timer. */
  roundRemainingMs(): number {
    return this.boss ? Math.max(0, this.roundLeft) : 0;
  }

  /** Has the boss enraged (round timer expired)? Drives the HUD's ENRAGED banner. */
  get enraged(): boolean {
    return this._enraged;
  }

  /** Snapshot the result in the shape the reward pipeline expects. */
  outcome(): RaidOutcome {
    return {
      win: this.playerWon,
      rounds: this.attacksLanded,
      survivors: this.players.filter((u) => u.alive).map((u) => u.id),
      losses: this.players.filter((u) => !u.alive).map((u) => u.id),
      enemiesBeaten: this.enemies.filter((e) => !e.alive).length,
      playerDamage: this.playerDamage,
    };
  }
}
