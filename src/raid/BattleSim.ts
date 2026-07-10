// The live battle simulation (Phase 3+): a pure, RNG-free, real-time stepping
// model that the RaidScene renders. No Pixi, no DOM — positions, health, focus
// charge, ballistic boss projectiles, and attack clocks over a 1D combat lane.
// This is the AUTHORITY for a raid's outcome (instant CombatEngine.resolveRaid
// stays only as "Quick Resolve").
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
// Deferred: focus-bar distractions (Phase 4), ability effects (Phase 5).
//
// Combat numbers reuse the instant-resolve model:
//   maxHp = con*10, damage = max(1, round(str*mult)), cadence = attackCooldownMs.
import type { BossSpecial, BossThrowConfig, CombatUnit, HazardConfig, RaidOutcome } from "./types";
import { ACTIVATED_ABILITY, activatedKeyFor, teamAbilitiesIn } from "../zombie/abilities";

/** Logical field the sim runs in; RaidScene scales this to the viewport. */
export const FIELD_W = 1000;
export const FIELD_H = 560;

const CHARGE_X = 220; // staging slot the front zombie steps into to focus
const ENEMY_HOLD_X = 990; // enemies stand just outside the entrance (near right edge)
const ENEMY_SPAWN_X = 1120; // off the right edge (hidden) before emerging
// Boss perch field-x. Chosen so RaidScene.mapX() lands it on the silo perch
// (PERCH_FX), which is also where thrown projectiles originate.
const BOSS_STRUCT_X = 848;
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

// Ballistic throws.
const GRAVITY = 820; // sim px/s^2 pulling projectiles down
const GROUND_Y = BAND_BOT + 24; // a throw that reaches here has missed (fizzles)
const ZOMBIE_HIT_R = 30; // zombie collision radius in sim units
const PROJ_HIT_FACTOR = 0.4; // projectile radius = spriteSize * this
// Raw bossActions throw damage (6/12/18) is on a much bigger scale than melee
// (~2/hit) and would two-shot a 20-HP basic zombie. Scale it down so throws chip
// rather than delete zombies (bucket 18→~5, chicken 12→3, tomato 6→~2).
const PROJ_DMG_SCALE = 0.25;

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
const SPECIAL_DMG_SCALE = 0.25; // same chip-scaling as thrown projectiles

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
  // ---- focus-bubble minigame (zombies, while charging) ----
  distracted: boolean; // butterfly bubble showing — fill paused until popped
  awaitRelease: boolean; // brain bubble showing — full, gated until popped
  distractStep: number; // how many CHARGE_STEPS have fired (0..4)
  bubbleMs: number; // ms until the current bubble auto-resolves
  struckThisTick: boolean;
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
  stunMs: number; // ms of stun left — can't act while > 0 (enemies AND zombies)
  // ---- enemy attack effects inflicted on a struck zombie ----
  knockBack: boolean; // this enemy's attack shoves the zombie back down the lane
  stunInflictMs: number; // stun this enemy applies to a zombie on hit (ms)
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

function toSim(u: CombatUnit, i: number): SimUnit {
  const mult = u.attacks[0]?.mult ?? 1;
  const isPlayer = u.team === "player";
  const home = isPlayer ? clusterHome(i) : { x: ENEMY_SPAWN_X, y: CENTER_Y };
  const abilities = isPlayer ? u.abilities ?? [] : [];
  return {
    id: u.id,
    sourceKey: u.sourceKey,
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
    distracted: false,
    awaitRelease: false,
    distractStep: 0,
    bubbleMs: 0,
    struckThisTick: false,
    damage: Math.max(1, Math.round(u.str * mult)),
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
    stunMs: 0,
    knockBack: !isPlayer && !!u.knockBack,
    stunInflictMs: isPlayer ? 0 : u.stunMs ?? 0,
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

    this.activatedKeys = [
      ...new Set(this.players.map((p) => p.activatedKey).filter((k): k is string => !!k)),
    ];
    this.teamKeys = [...new Set(this.players.flatMap((p) => teamAbilitiesIn(p.abilities)))];
  }

  // ---- activated abilities (player-triggered from the battle strip) ----

  /** A player unit is READY for an activated move when it's alive, in the thick of
   *  the fight, off cooldown, and not already charging one. */
  private readyToActivate(p: SimUnit, key: string): boolean {
    return (
      p.alive &&
      p.team === "player" &&
      p.activatedKey === key &&
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

  /** Nearest player within striking range of an enemy. */
  private playerInRange(e: SimUnit): SimUnit | null {
    let best: SimUnit | null = null;
    let bestD = ENGAGE + 0.001;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.abs(p.x - e.x);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Whom the boss aims at: prefer Garden zombies; else the most-forward zombie. */
  private throwTarget(): SimUnit | null {
    const alive = this.players.filter((p) => p.alive);
    if (!alive.length) return null;
    const gardens = alive.filter((p) => p.isGarden);
    const pool = gardens.length ? gardens : alive;
    return pool.reduce((a, b) => (b.x > a.x ? b : a));
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
      if (next >= 1) { p.awaitRelease = true; p.bubbleMs = BRAIN_AUTO_MS; }
      else { p.distracted = true; p.bubbleMs = BUTTERFLY_AUTO_MS; }
    }
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

  /** Assign formation slots to the committed (released) zombies: up to MAX_ROWS
   *  rows, then filling into depth columns behind. Headless zombies take priority
   *  for the front, then oldest-released first. Only the front column reaches the
   *  enemy, so at most MAX_ROWS zombies fight at once. */
  private assignFormation() {
    const committed = this.players.filter(
      (p) => p.alive && (p.state === "advance" || p.state === "fight")
    );
    committed.sort(
      (a, b) => Number(b.isHeadless) - Number(a.isHeadless) || a.formOrder - b.formOrder
    );
    const frontX = ENEMY_HOLD_X - ENGAGE;
    // Center on the number of rows actually used so columns align into shared rows.
    const rowsUsed = Math.min(MAX_ROWS, committed.length);
    committed.forEach((p, i) => {
      const col = Math.floor(i / MAX_ROWS);
      const rowInCol = i % MAX_ROWS;
      p.slotX = frontX - col * COL_GAP;
      p.slotY = CENTER_Y + (rowInCol - (rowsUsed - 1) / 2) * ROW_GAP;
    });
  }

  /** Advance the sim by `dtMs`. Returns false once the battle is over. */
  step(dtMs: number): boolean {
    if (this.finished) return false;
    this.elapsed += dtMs;
    for (const u of this.units) u.struckThisTick = false;

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
    const frontX = ENEMY_HOLD_X - ENGAGE;

    // Zombies.
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.abilityCdMs > 0) p.abilityCdMs -= dtMs; // activated-move recharge
      switch (p.state) {
        case "waiting": {
          // Pace back and forth on the spot (a slow walk that flips their facing),
          // not a vertical hover. Each zombie has its own speed/phase.
          const freq = 0.0012 + (p.mill / (Math.PI * 2)) * 0.0007;
          p.x = p.homeX + Math.sin(this.elapsed * freq + p.mill) * 26;
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
          const stepd = (p.moveSpeed * dtMs) / 1000;
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
        // Boss climbs down off the silo and heads out the back (off the right
        // edge, through the entrance) — then re-enters as a normal ground enemy.
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        const dy = CENTER_Y - e.y;
        e.y += Math.sign(dy) * Math.min(Math.abs(dy), sx); // ease down to the ground
        e.x = Math.min(ENEMY_SPAWN_X, e.x + sx); // walk out to the hidden spawn
        e.timerMs = e.cooldownMs;
        if (e.x >= ENEMY_SPAWN_X && Math.abs(dy) < 2) {
          e.x = ENEMY_SPAWN_X;
          e.y = CENTER_Y;
          e.state = "emerging"; // now walk back in from the entrance
        }
        continue;
      }
      if (e.state === "emerging") {
        const sx = (EMERGE_SPEED * dtMs) / 1000;
        e.x = Math.max(ENEMY_HOLD_X, e.x - sx);
        const dy = CENTER_Y - e.y; // boss eases down from the structure
        e.y += Math.sign(dy) * Math.min(Math.abs(dy), sx);
        e.timerMs = e.cooldownMs;
        if (e.x <= ENEMY_HOLD_X && Math.abs(CENTER_Y - e.y) < 2) {
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

    if (!this.anyAlive(this.players) || !this.anyAlive(this.enemies) || this.elapsed >= MAX_SIM_MS) {
      this.finished = true;
    }
    return !this.finished;
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
            this.dealDamage(p, dmg, false);
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
          this.dealDamage(victim, dmg * 2, false);
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
      if (!best || p.x > best.x) best = p;
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
      damage: this.hazard.damage,
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

  /** Launch a ballistic throw aimed at the target zombie's current position. */
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

  /** Launch a projectile at a target. Ballistic by default (a lobbed throw); pass
   *  `straight` for a fast flat bolt (alien laser). */
  private launchProjectile(
    target: SimUnit,
    damage: number,
    sprite: string,
    spriteSize: number,
    opts: { straight?: boolean } = {}
  ) {
    const x0 = BOSS_STRUCT_X;
    const y0 = BOSS_STRUCT_Y;
    let vx: number;
    let vy: number;
    const grav = opts.straight ? 0 : GRAVITY;
    if (opts.straight) {
      const dx = target.x - x0;
      const dy = target.y - y0;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * LASER_SPEED;
      vy = (dy / d) * LASER_SPEED;
    } else {
      const dxAbs = Math.abs(target.x - x0);
      const T = clamp(dxAbs / 520 + 0.7, 0.85, 1.7); // flight time → a nice lob
      vx = (target.x - x0) / T;
      vy = (target.y - y0) / T - 0.5 * GRAVITY * T; // ballistic solve
    }
    this.projectiles.push({
      id: `proj${this.projSeq++}`,
      x: x0,
      y: y0,
      vx,
      vy,
      rot: 0,
      rotSpeed: (vx < 0 ? -1 : 1) * 7,
      damage,
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
