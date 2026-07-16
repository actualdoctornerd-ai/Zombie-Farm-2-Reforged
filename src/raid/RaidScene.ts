// The live raid battle scene (Phase 1). A full-screen Pixi layer that renders a
// BattleSim: a cover-fit stage background, a token per combatant (zombie
// portrait / enemy icon / boss portrait) with a health bar, and top-corner team
// bars (total HP + unit count). Zombies march in, the fight plays out live, and
// survivors march off on a win — then onFinish(outcome) hands the result back to
// RaidManager.finishRaid for rewards.
//
// Scope note: the boss is a plain fighter here; its structure, thrown
// projectiles, phase-2 re-entry, charge bars, distractions, and ability effects
// are later phases (see IMPLEMENTATION_RAIDS_PLAN.md). Tokens are placeholder
// portraits, not side-view stage actors.
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { GameAssets, raidImage, zombiePortrait } from "../assets";
import { BattleSim, BOSS_STRUCT_X, BOSS_STRUCT_Y, ENEMY_SPAWN_X, FIELD_H, FIELD_W, SimUnit, TELEPORT_PX } from "./BattleSim";
import { RaidActor } from "./RaidActor";
import { EnemyActor } from "./EnemyActor";
import { ParticleField, ParticleConfig } from "./Particles";
import { ABILITY_POOL } from "../zombie/traits";
import { BossSpecial, BossThrowConfig, CombatUnit, HazardConfig, RaidDef, RaidLevelAsset, RaidOutcome } from "./types";
import { RAID_TICK_MS, type RaidReplayInput } from "./replay";
import { extrapolatePosition, interpolatePosition, visualCountdown } from "./renderInterpolation";

type RaidInputDraft =
  | { type: "bubble"; unitId: string }
  | { type: "ability"; abilityKey: string }
  | { type: "retreat" };
import { BASE } from "../base";

export interface RaidSceneParams {
  raid: RaidDef;
  assets: GameAssets; // for the per-type zombie models + enemy sprites
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  bossThrow: BossThrowConfig | null;
  /** Boss special (non-throw) actions to schedule during the fight. */
  bossSpecials?: BossSpecial[];
  /** Environmental obstacle hazards for this raid (null/omitted = none). */
  hazard?: HazardConfig | null;
  /** Minion the boss's summonBoss action spawns (null/omitted = none). */
  summonTemplate?: CombatUnit | null;
  /** Blocker the boss's wall action spawns (null/omitted = none). */
  wallTemplate?: CombatUnit | null;
  /** Concentration boost spent — skip the focus-bubble minigame this fight. */
  concentration?: boolean;
  onCheckpoint?: (finalTick: number, inputs: RaidReplayInput[]) => Promise<void>;
  onFinish: (outcome: RaidOutcome, finalTick: number, inputs: RaidReplayInput[]) => void;
}

// Smash (bash / bashV2) tell: while charging, the zombie GROWS to 1+SMASH_GROW as it
// raises its arms; when the raise completes (damage lands) it rapidly slams the arms
// back down and shrinks over SMASH_SLAM_S. Grow is anchored at the feet so it looms
// upward in place. Only the bash family smashes (explode/mini keep the plain raise).
const SMASH_KEYS = new Set(["bash", "bashV2"]);
const SMASH_GROW = 0.4;
const SMASH_SLAM_S = 0.18;
const INTRO_MS = 700; // zombies slide in
const END_PAUSE_MS = 650; // beat after the last blow before we move on
// On a win, survivors stroll off to the right at a normal walking pace (not the old
// victory sprint), and the results/loot panel holds off for this long before sliding
// in — so the army has a moment to walk away first.
const OUTRO_WALK_SPEED = 230; // sim px/s — a normal march (cf. enemy EMERGE_SPEED 210)
const OUTRO_RESULT_DELAY_MS = 1500; // beat before the loot panel comes in from the right
const RETREAT_RESULT_DELAY_MS = 1500; // let survivors walk off left before the loss panel
const DEATH_FADE = 0.45; // seconds for a fallen unit to poof + fade out
const HEAL_POSE_S = 0.7; // Garden healer raises, holds, then lowers both arms
const PLAYER_COLOR = 0x8bc34a;
const ENEMY_COLOR = 0xef5350;
const BOSS_COLOR = 0xffc107;
// On-screen heights (px) the unit sprites are scaled to. Enemies + boss read bigger
// than the zombies in the real game (a lumberjack towers over a grunt, McDonnell is
// huge on the silo), so they carry a larger target height.
// These are the target heights (px) AT the reference stage scale below. Because the
// stage is contain-fit (it scales with the window), units are drawn at H * (current
// stage scale / SIZE_REF_SCALE) so they track the background instead of being a fixed
// pixel size (which turned them into giants on a small window / specks on a big one).
const ZOMBIE_H = 91;
const ENEMY_H = 130;
const BOSS_H = 195;
// Per-boss height multipliers (by enemy source key) for bosses that read wrong at the
// shared BOSS_H. Old McDonnell is a chunky sprite that looms too large on his silo —
// scaled down 20% to sit better on the structure.
const BOSS_H_SCALE: Record<string, number> = {
  FarmStageActorBoss: 0.8, // Old McDonnell — 20% smaller
};
// The contain-fit scale at which the *_H heights above render 1:1. Raise this to make
// all units smaller across the board, lower it to make them bigger.
const SIZE_REF_SCALE = 1.6;
// Background layout. The bg is CONTAIN-fit (whole scene visible, no bottom crop);
// the ground line the characters stand on sits GROUND_FY down the image, and the
// boss perches on the silo at PERCH_F*. Letterbox areas fill with sky/grass.
const GROUND_FY = 0.9;
// Units sit below the bg's painted ground line. The second offset is shared by all
// ground combatants so enemy feet use the same baseline as zombie feet.
const GROUND_NUDGE = ZOMBIE_H * 0.2;
const UNIT_GROUND_NUDGE = ZOMBIE_H * 0.22;
// Default boss perch (fraction of the stage rect) for raids with no right-side
// structure — the boss hovers up-right like a UFO (Aliens) rather than standing.
const PERCH_FX = 0.82;
const PERCH_FY = 0.2;
// How far to sink the boss BELOW the perch structure's top edge (fraction of the
// structure height), so it stands behind the roof/silo with its legs occluded by the
// structure — the boss renders in a layer BEHIND the perch art (see bossBackLayer).
const PERCH_SINK_F = 0.14;
// Where a perched boss's THROWS leave from — its hand, in unit-space offsets from the
// boss token origin (feet at the perch). Without this the projectile spawned at the
// raw sim origin (mapped separately from the boss token) appeared down-left of him.
const BOSS_HAND_DX = -4; // slightly toward the zombies (screen-left) of centre
const BOSS_HAND_FY = 0.58; // up the boss sprite (fraction of its rendered height)
// Where along the perch structure (fraction from its LEFT edge) the boss stands.
// 0.5 = dead centre (a big boss then clips the screen's right edge); lower = farther
// left, over the building.
const PERCH_BIAS_FX = 0.22;
// Per-raid perch nudge (screen-rect fractions; +dx = right, +dy = DOWN). Corrects the
// computed/default perch where a specific boss reads wrong vs. the real game — eyeballed.
// Applies to BOTH structure perches (sinks the boss lower behind the building) and sky
// perches (moves the hovering boss). Keyed by raid id.
const PERCH_TWEAK: Record<number, { dx?: number; dy?: number }> = {
  2: { dy: 0.13 }, // Lawyers: boss sat too high on the front building
  4: { dy: 0.12 }, // Ninjas: too high on the structure
  5: { dy: 0.16 }, // Robots (sky perch): hovering too high
  6: { dx: -0.03, dy: 0.2 }, // Aliens (sky perch): too high; rides a UFO
  7: { dx: -0.18, dy: 0.13 }, // Summer Break (sky perch): squid boss too far right
  8: { dx: -0.14 }, // Circus: boss too far right on the car
};
// Alien boss rides a UFO (AlienStageElements bossShip/bossShipBack): the saucer + glass
// dome sit IN FRONT of the alien (its transparent centre shows the pilot), the small back
// dome behind. Sizes/offsets in unit-px (scaled with the boss token). Eyeballed.
const ALIEN_BOSS_KEY = "AlienStageActorBoss";
const UFO_FRONT_H = 156; // saucer rendered height (unit px)
const UFO_FRONT_DY = -8; // saucer base ~at the boss's feet, so its legs sit inside
const UFO_BACK_H = 30; // back dome height
const UFO_BACK_DY = -120; // back dome up behind the pilot
const UFO_BACK_DX = 6;
// Letterbox fill behind the contain-fit stage image (visible only where the screen
// shape leaves bars around the 480x320 art). Kept DARK so it reads as an inset stage
// rather than fake sky/grass that never matched the real background art. (The stage
// backgrounds themselves still need proper work — this is the interim treatment.)
const LETTERBOX_TOP = 0x1b1e24;
const LETTERBOX_BOT = 0x101216;
// Horizontal inset of the combat lane inside the stage rect: units used to run right
// to ~4% of the edges and spill past the ground area of the art. Pull them in.
const FIELD_INSET_FX = 0.1;
const CENTER_Y = FIELD_H / 2; // sim y that sits on the ground line
// Source fight-stage design space: level assets are authored 1:1 in 480x320 points
// (verified: every fightBG*_bg is 480x320; structures like the barn are positioned
// within it), with cocos2d Y-UP anchors/positions. The whole stage is CONTAIN-fit.
const DESIGN_W = 480;
const DESIGN_H = 320;

/** Parse a source "{x,y}" vector string into [x, y]. */
function parseVec(s: string): [number, number] {
  const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(s || "");
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
}
/** Composited static enemy sprite (from tools/prep_enemies.py), if one exists. */
const enemySprite = (key: string) => `${BASE}assets/raids/enemies/${key}.png`;
/** Packed part strip for an enemy's animated rig (raids/enemies/parts/<key>.png). */
const enemyStripUrl = (key: string) => `${BASE}assets/raids/enemies/parts/${key}.png`;
// Source-game focus thought-bubbles (misc/thoughtBubble*.png), shown over the
// charging zombie. Butterfly = distracted; brain = fully focused / ready.
const BUBBLE_BUTTERFLY = BASE + "assets/ui/thoughtBubbleButterfly.png";
const BUBBLE_BRAIN = BASE + "assets/ui/thoughtBubbleBrains.png";
const BUBBLE_SCALE = 0.91; // the source art is 64x62 (1.3 enlarged, then scaled ~30% down)
const BUBBLE_DX = 74; // shift the (mirrored) bubble right of the charging zombie (~one bubble width: 16 + 64*0.91)

type Phase = "intro" | "fight" | "outro" | "retreat" | "defeat" | "done";

interface Token {
  root: Container;
  actor?: RaidActor; // player zombie rig (walk animation)
  enemyActor?: EnemyActor; // enemy rig (idle bob / walk / limb animation)
  hp: Graphics;
  charge: Graphics; // focus bar (zombies, while charging)
  base: number; // half-width for the bars
  topY: number; // y of the sprite top (negative), for the hp bar
  pulse: number; // hit lunge, decays to 0
  atkCount: number; // basic hits landed (parity drives the arm-wave switch)
  deathAnim: number; // seconds since death (-1 while alive); drives the fade+poof
  emerged: boolean; // has this token appeared on-field yet (for the spawn puff)
  // Smash grow/slam (bash family). smashSlam counts down the post-release slam (-1 =
  // inactive); wasSmashWindup is last frame's smash charge (0..1) to detect release.
  smashSlam: number;
  wasSmashWindup: number;
  actorBaseScale: number; // the zombie rig's normal container scale (for the feet-anchored grow)
  actorBaseY: number; // and its normal container y (feet at the token origin)
  healFxSeq: number; // last heal event rendered for this unit
  healCastSeq: number; // last heal cast rendered for this Garden zombie
  healPose: number; // seconds remaining in the arms-overhead healing pose
}

async function loadTex(url: string): Promise<Texture | null> {
  try {
    return (await Assets.load(url)) as Texture;
  } catch {
    return null;
  }
}

/** Fetch a cocos2d particle config (raids/particles/<name>.json); null on failure. */
async function loadParticle(name: string): Promise<ParticleConfig | null> {
  try {
    return (await (await fetch(`${BASE}assets/raids/particles/${name}.json`)).json()) as ParticleConfig;
  } catch {
    return null;
  }
}

export class RaidScene {
  readonly container = new Container();
  private sim: BattleSim;
  private raid: RaidDef;
  private onFinish: (o: RaidOutcome, finalTick: number, inputs: RaidReplayInput[]) => void;
  private onCheckpoint: ((finalTick: number, inputs: RaidReplayInput[]) => Promise<void>) | null;
  private lastCheckpointTick = 0;
  private checkpointing = false;
  private checkpointRetryAt = 0;

  private assets: GameAssets;
  private backdrop = new Graphics(); // sky/grass fill behind the (letterboxed) stage
  private stageLayer = new Container(); // parallax level-asset layers (behind everyone)
  private stageLayers: { sp: Sprite; asset: RaidLevelAsset }[] = [];
  // The perch STRUCTURE (barn/silo/…) is split into its own layer drawn in FRONT of
  // the boss, so a boss standing on it has its legs occluded by the roof, while
  // ground units (enemies in the doorway) still render in front of the structure.
  private stageFrontLayer = new Container();
  private bossBackLayer = new Container(); // boss token, BEHIND the perch structure
  private perchLayer: { sp: Sprite; asset: RaidLevelAsset } | null = null;
  private perchFX = PERCH_FX; // boss perch, computed from the stage's structure
  private perchFY = PERCH_FY;
  private tokenLayer = new Container();
  private tokens = new Map<string, Token>();
  private texByUnit = new Map<string, Texture | null>(); // fallback portrait tokens
  private enemyTex = new Map<string, Texture | null>(); // composited enemy sprites
  private enemyStrip = new Map<string, Texture | null>(); // packed part strips (animated rigs)
  private playerScale = 0; // common px-per-rig-unit for player zombies (see refPlayerScale)
  private ufoBackTex: Texture | null = null; // alien boss UFO (back dome)
  private ufoFrontTex: Texture | null = null; // alien boss UFO (saucer + glass dome)

  // Boss projectiles.
  private bossThrow: BossThrowConfig | null;
  private hazardSprite = ""; // this raid's obstacle/grab art, preloaded for syncProjectiles
  private wallTemplate: CombatUnit | null; // preloaded so a spawned wall renders as a sprite
  private projLayer = new Container();
  private projTex = new Map<string, Texture | null>();
  private projSprites = new Map<string, Sprite>();
  // Screen position of the perched boss's throwing hand (updated in layout), so
  // projectiles visually leave his hand rather than a separately-mapped sim origin.
  private bossHandX = 0;
  private bossHandY = 0;
  private dotTex: Texture | null = null; // round placeholder for sprite-less hazards
  private fxLayer = new Container(); // transient effects (death poofs) above the field
  private fx: { g: Graphics; t: number; life: number; color: number }[] = [];
  private particles = new ParticleField(); // melee-impact dust + victory confetti
  private bashCfg: ParticleConfig | null = null;
  private confettiCfg: ParticleConfig | null = null;
  private smokeCfg: ParticleConfig | null = null; // enemy death poof (source: playDeathEffect → smoke.plist)
  private healCfg: ParticleConfig | null = null;
  private confettiFired = false;

  // Top HUD backing + team bars. The backing visually separates the health/stats
  // row from busy raid backgrounds while remaining translucent over the scene.
  private topHudBack = new Graphics();
  private pFill = new Graphics();
  private eFill = new Graphics();
  private pLabel!: Text;
  private eLabel!: Text;
  private roundLabel!: Text; // top-center countdown → "ENRAGED" when it expires
  private pFace = new Container(); // zombie face badge, left of the player bar
  private eFace = new Container(); // basic-enemy face badge, right of the enemy bar
  private maxPlayerHp = 1;
  private maxEnemyHp = 1;
  private retreatBtn = new Container();
  private retreatRequested = false;
  private retreated = false;
  private simAccumulatorMs = 0;
  private simTick = 0;
  private inputSeq = 0;
  private replayInputs: RaidReplayInput[] = [];

  private recordInput(input: RaidInputDraft): void {
    this.replayInputs.push({ ...input, seq: ++this.inputSeq, tick: this.simTick } as RaidReplayInput);
  }

  // Top-left ability strip: tappable activated moves (Bash/Smash/Explode/Mini) with
  // ready-count badges, plus static team-passive icons (Heal/Protect/Chivalry/…).
  private abilityStrip = new Container();
  private abilityCells: { key: string; cell: Container; badge?: Text; activated: boolean }[] = [];

  // Focus bubble hovering over the charging zombie: the source game's own thought-
  // bubble art — a butterfly while distracted (tap to refocus) or a brain when the
  // bar is full (tap to send it forward).
  private bubble = new Container();
  private bubbleSprite = new Sprite();
  private bubbleTexButterfly: Texture | null = null;
  private bubbleTexBrain: Texture | null = null;
  private bubbleUnitId: string | null = null;

  private phase: Phase = "intro";
  private phaseT = 0;
  private resultFired = false;

  private constructor(private app: Application, params: RaidSceneParams) {
    this.raid = params.raid;
    this.assets = params.assets;
    this.onFinish = params.onFinish;
    this.onCheckpoint = params.onCheckpoint ?? null;
    this.bossThrow = params.bossThrow;
    this.hazardSprite = params.hazard?.sprite ?? "";
    this.wallTemplate = params.wallTemplate ?? null;
    this.sim = new BattleSim(
      params.playerUnits,
      params.enemyUnits,
      params.bossThrow,
      !!params.concentration,
      params.bossSpecials ?? [],
      params.hazard ?? null,
      undefined, // roundMs → default 3:00
      params.summonTemplate ?? null,
      params.wallTemplate ?? null
    );
    this.maxPlayerHp = Math.max(1, sumMax(params.playerUnits));
    this.maxEnemyHp = Math.max(1, sumMax(params.enemyUnits));
  }

  /** Build a ready-to-add scene, preloading all textures first. */
  static async create(app: Application, params: RaidSceneParams): Promise<RaidScene> {
    const scene = new RaidScene(app, params);
    await scene.build();
    return scene;
  }

  private async build() {
    // Stage: render EVERY level asset as its own parallax layer, positioned in the
    // source 480x320 design space and z-sorted, so multi-layer raids (Pirate's
    // sky/water/mid/front, City's front building, Circus's car) compose correctly —
    // not just the single lowest-z layer.
    this.stageLayer.sortableChildren = true;
    this.container.addChild(this.backdrop, this.stageLayer);
    for (const asset of this.raid.levelAssets) {
      const tex = await loadTex(raidImage(asset.sprite));
      if (!tex) continue;
      const sp = new Sprite(tex);
      sp.zIndex = asset.z;
      this.stageLayers.push({ sp, asset });
      this.stageLayer.addChild(sp);
    }
    this.computePerch();
    // Move the perch structure into a FRONT layer, with the boss layer just behind
    // it: render order becomes backdrop → stage (bg) → boss → perch structure →
    // ground tokens. So the boss stands behind the barn/silo (legs hidden by the
    // roof) while enemies in the doorway still draw in front of the structure.
    if (this.perchLayer) {
      this.stageLayer.removeChild(this.perchLayer.sp);
      this.stageFrontLayer.addChild(this.perchLayer.sp);
    }
    this.container.addChild(this.bossBackLayer, this.stageFrontLayer);

    // Enemy sprites: one composited actor per enemy type (farmhand/boss/…). Fall
    // back to the raid's flat enemy icon / boss portrait for types without one.
    const enemyKeys = [...new Set(this.sim.units.filter((u) => u.team === "enemy").map((u) => u.sourceKey))];
    await Promise.all(
      enemyKeys.map(async (k) => {
        // Prefer the animated rig (part strip) when a model exists; else the flat
        // composite; else the token falls back to the raid's icon / boss portrait.
        if (this.assets.enemyModels[k]) {
          this.enemyStrip.set(k, await loadTex(enemyStripUrl(k)));
        } else {
          this.enemyTex.set(k, await loadTex(enemySprite(k)));
        }
      })
    );
    const enemyUrl = this.raid.enemyIcon ? raidImage(this.raid.enemyIcon) : "";
    const bossUrl = this.raid.bossPortrait ? raidImage(this.raid.bossPortrait) : "";
    const fallbackUrls = new Map<string, string>();
    for (const u of this.sim.units) {
      if (u.team !== "enemy") continue;
      if (this.enemyTex.get(u.sourceKey) || this.enemyStrip.get(u.sourceKey)) continue;
      fallbackUrls.set(u.id, u.isBoss ? bossUrl : enemyUrl);
    }
    const uniq = [...new Set([...fallbackUrls.values()].filter(Boolean))];
    const texCache = new Map<string, Texture | null>();
    await Promise.all(uniq.map(async (url) => texCache.set(url, await loadTex(url))));
    for (const [id, url] of fallbackUrls) this.texByUnit.set(id, texCache.get(url) ?? null);

    // A spawned wall (Ninja carrotWall) uses its own bossAction sprite. Preload it
    // under its source key so the lazily-built token draws it, not a fallback circle.
    if (this.wallTemplate) {
      this.enemyTex.set(this.wallTemplate.sourceKey, await loadTex(raidImage("carrotWall.png")));
    }

    // Alien boss rides a UFO — preload its two ship sprites so makeToken can build it.
    if (this.sim.units.some((u) => u.isBoss && u.sourceKey === ALIEN_BOSS_KEY)) {
      [this.ufoBackTex, this.ufoFrontTex] = await Promise.all([
        loadTex(raidImage("ufo_bossShipBack.png")),
        loadTex(raidImage("ufo_bossShip.png")),
      ]);
    }

    this.container.addChild(this.tokenLayer);
    for (const u of this.sim.units) this.tokens.set(u.id, this.makeToken(u));

    // Preload boss projectile sprites (chicken/bucket/debris).
    this.container.addChild(this.projLayer);
    this.container.addChild(this.fxLayer); // death poofs draw above everything
    this.container.addChild(this.particles.container); // impact dust / confetti on top
    [this.bashCfg, this.confettiCfg, this.smokeCfg, this.healCfg] = await Promise.all([
      loadParticle("bash"),
      loadParticle("confetti"),
      loadParticle("smoke"),
      loadParticle("healSingle"),
    ]);
    for (const opt of this.bossThrow?.options ?? []) {
      if (this.projTex.has(opt.sprite)) continue;
      this.projTex.set(opt.sprite, await loadTex(raidImage(opt.sprite)));
    }
    // Environmental hazard art (falling obstacle / grab), so it isn't a warning dot.
    if (this.hazardSprite && !this.projTex.has(this.hazardSprite)) {
      this.projTex.set(this.hazardSprite, await loadTex(raidImage(this.hazardSprite)));
    }

    // Team-bar face badges: a representative party zombie on the left, the raid's
    // basic enemy on the right.
    const zKey =
      this.sim.units.find((u) => u.team === "player" && !u.isBoss && !u.isHeadless)?.sourceKey ??
      this.sim.units.find((u) => u.team === "player")?.sourceKey ??
      "ZombieActorRegularTier1";
    const [zFace, eFace] = await Promise.all([
      loadTex(zombiePortrait(zKey)),
      this.raid.enemyIcon ? loadTex(raidImage(this.raid.enemyIcon)) : Promise.resolve(null),
    ]);

    this.buildTeamBars();
    this.fillFaceBadge(this.pFace, zFace, 0x8bc34a);
    this.fillFaceBadge(this.eFace, eFace, 0xef5350);
    await this.buildAbilityStrip();
    [this.bubbleTexButterfly, this.bubbleTexBrain] = await Promise.all([
      loadTex(BUBBLE_BUTTERFLY),
      loadTex(BUBBLE_BRAIN),
    ]);
    this.buildBubble();
    this.layout();
  }

  /** The focus bubble (one, reused): the source game's thought-bubble sprite,
   *  tappable to pop the charging zombie's distraction / release it forward. Its
   *  texture is swapped each frame (butterfly vs brain) in layout(). */
  private buildBubble() {
    const s = this.bubbleSprite;
    s.anchor.set(0.5, 1); // bottom-center: the bubble's tail hangs just over the zombie
    s.scale.set(-BUBBLE_SCALE, BUBBLE_SCALE); // mirror over the vertical axis (tail to the left)
    if (this.bubbleTexButterfly) s.texture = this.bubbleTexButterfly;
    this.bubble.addChild(s);
    this.bubble.visible = false;
    this.bubble.eventMode = "static";
    this.bubble.cursor = "pointer";
    this.bubble.on("pointertap", () => {
      if (this.bubbleUnitId && this.sim.popBubble(this.bubbleUnitId)) {
        this.recordInput({ type: "bubble", unitId: this.bubbleUnitId });
        this.bubble.scale.set(0.8); // tap feedback, eased back in layout
      }
    });
    this.container.addChild(this.bubble); // above tokens so it's tappable
  }

  /** Build the top-left ability strip from the army's abilities: one tappable cell
   *  per distinct ACTIVATED move (badge = zombies ready to perform it) and one
   *  static cell per TEAM-passive ability in play. Self-buffs aren't shown. */
  private async buildAbilityStrip() {
    const keys = [
      ...this.sim.activatedKeys.map((key) => ({ key, activated: true })),
      ...this.sim.teamKeys.map((key) => ({ key, activated: false })),
    ];
    const icons = new Map<string, Texture | null>();
    await Promise.all(
      keys.map(async ({ key }) => {
        const icon = ABILITY_POOL[key]?.icon;
        icons.set(key, icon ? await loadTex(icon) : null);
      })
    );
    for (const { key, activated } of keys) {
      const cell = this.makeAbilityCell(key, icons.get(key) ?? null, activated);
      this.abilityStrip.addChild(cell.cell);
      this.abilityCells.push({ key, ...cell, activated });
    }
    this.container.addChild(this.abilityStrip);
  }

  /** One ability cell: a framed icon. Activated cells are tappable (fire the move
   *  on one ready zombie) and carry a ready-count badge; team cells are static. */
  private makeAbilityCell(key: string, tex: Texture | null, activated: boolean) {
    const R = 22;
    const cell = new Container();
    const frame = new Graphics()
      .roundRect(-R, -R, 2 * R, 2 * R, 7)
      .fill({ color: 0x14140f, alpha: 0.82 })
      .stroke({ width: 2, color: activated ? 0xe6b23a : 0x6f9a52 });
    cell.addChild(frame);
    if (tex) {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set((2 * R * 0.78) / Math.max(tex.width, tex.height, 1));
      cell.addChild(sp);
    }
    let badge: Text | undefined;
    if (activated) {
      const dot = new Graphics().circle(R - 4, -R + 4, 9).fill(0xc0392b);
      badge = new Text({
        text: "0",
        style: { fontFamily: "sans-serif", fontSize: 12, fontWeight: "800", fill: 0xffffff },
      });
      badge.anchor.set(0.5);
      badge.position.set(R - 4, -R + 4);
      cell.addChild(dot, badge);
      cell.eventMode = "static";
      cell.cursor = "pointer";
      cell.on("pointertap", () => {
        if (this.sim.activate(key)) {
          this.recordInput({ type: "ability", abilityKey: key });
          cell.scale.set(0.86); // tap feedback (eased back in layout)
        }
      });
    }
    return { cell, badge };
  }

  /** A circular framed portrait badge for a team bar (feet-agnostic head-ish crop). */
  private fillFaceBadge(badge: Container, tex: Texture | null, ring: number) {
    const R = 26;
    badge.removeChildren();
    badge.addChild(new Graphics().circle(0, 0, R).fill(0x1c1c1c));
    if (tex) {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5, 0.5);
      // Fill the circle from the TOP of the portrait (the face), not the middle.
      const s = (R * 2 * 1.15) / Math.max(1, tex.width);
      sp.scale.set(s);
      sp.y = -tex.height * s * 0.28;
      const mask = new Graphics().circle(0, 0, R).fill(0xffffff);
      badge.addChild(mask, sp);
      sp.mask = mask;
    }
    badge.addChild(new Graphics().circle(0, 0, R).stroke({ width: 3, color: ring, alpha: 0.95 }));
    this.container.addChild(badge);
  }

  // px-per-rig-unit shared by all player zombies. Calibrated ONCE so a baseline
  // Regular zombie renders at ZOMBIE_H; every other type then scales by the same
  // factor, preserving the authentic relative sizes baked into each model's group
  // scale (Large 1.15, Small 0.60, …) instead of squashing them all to one height.
  private refPlayerScale(): number {
    if (this.playerScale) return this.playerScale;
    const ref = new RaidActor(this.assets, "ZombieActorRegularTier1");
    const h = Math.max(1, ref.container.getLocalBounds().height);
    ref.container.destroy({ children: true });
    this.playerScale = ZOMBIE_H / h;
    return this.playerScale;
  }

  private makeToken(u: SimUnit): Token {
    const root = new Container();
    let actor: RaidActor | undefined;
    let enemyActor: EnemyActor | undefined;
    let base = 22;
    let topY = -60;
    let actorBaseScale = 1;
    let actorBaseY = 0;

    if (u.team === "player") {
      // Real farm-style zombie rig (with the walk animation). A COMMON scale is
      // applied to every player zombie (not a per-unit fit-to-height), so the
      // authentic per-group sizes carry through — a Large brute towers over a Small
      // gnome instead of all zombies rendering at one height.
      actor = new RaidActor(this.assets, u.sourceKey, u.mutation);
      const b = actor.container.getLocalBounds();
      const s = this.refPlayerScale();
      actor.container.scale.set(s);
      actor.container.y = -(b.y + b.height) * s; // stand its feet at the origin
      root.addChild(actor.container);
      base = Math.max(14, (b.width * s) / 2);
      topY = -(b.height * s); // this unit's actual rendered height
      // Remember the base transform so the Smash grow can scale the rig about its
      // FEET (container.y scales with the same factor) without moving the HP bar.
      actorBaseScale = s;
      actorBaseY = actor.container.y;
    } else {
      const targetH = (u.isBoss ? BOSS_H : ENEMY_H) * (u.isBoss ? BOSS_H_SCALE[u.sourceKey] ?? 1 : 1);
      const strip = this.enemyStrip.get(u.sourceKey) ?? null;
      const model = this.assets.enemyModels[u.sourceKey];
      const tex = this.enemyTex.get(u.sourceKey) ?? null;
      if (strip && model) {
        // Animated rig: assemble from the part strip and fit to the role height.
        const ea = new EnemyActor(strip, model);
        const b = ea.container.getLocalBounds();
        const s = targetH / Math.max(1, b.height);
        ea.container.scale.set(s);
        ea.container.y = -(b.y + b.height) * s; // stand its feet at the origin
        root.addChild(ea.container);
        base = Math.max(16, (b.width * s) / 2);
        topY = -(b.height * s);
        enemyActor = ea;
      } else if (tex) {
        const sp = new Sprite(tex);
        sp.anchor.set(0.5, 1); // feet at the origin
        const s = targetH / Math.max(1, tex.height);
        sp.scale.set(s); // composites already face LEFT toward the zombies — no mirror
        root.addChild(sp);
        base = Math.max(16, (tex.width * s) / 2);
        topY = -targetH;
      } else {
        // Fallback: the old portrait circle token.
        const R = u.isBoss ? 34 : 22;
        const color = u.isBoss ? BOSS_COLOR : ENEMY_COLOR;
        const t = this.texByUnit.get(u.id) ?? null;
        root.addChild(new Graphics().circle(0, 0, R).fill(t ? 0x161616 : color));
        if (t) {
          const body = new Sprite(t);
          body.anchor.set(0.5);
          body.scale.set((R * 2 * 1.06) / Math.max(t.width, t.height, 1));
          const mask = new Graphics().circle(0, 0, R).fill(0xffffff);
          root.addChild(mask, body);
          body.mask = mask;
        }
        root.addChild(new Graphics().circle(0, 0, R).stroke({ width: 3, color, alpha: 0.95 }));
        base = R;
        topY = -(R + 9);
      }
    }

    // Alien boss rides a UFO: the small back dome BEHIND the pilot, the saucer + glass
    // dome IN FRONT (its transparent centre shows the alien through the canopy).
    if (this.ufoFrontTex && u.isBoss && u.sourceKey === ALIEN_BOSS_KEY) {
      if (this.ufoBackTex) {
        const back = new Sprite(this.ufoBackTex);
        back.anchor.set(0.5, 0.5);
        back.scale.set(UFO_BACK_H / back.texture.height);
        back.position.set(UFO_BACK_DX, UFO_BACK_DY);
        root.addChildAt(back, 0); // behind the pilot rig
      }
      const front = new Sprite(this.ufoFrontTex);
      front.anchor.set(0.5, 0.78); // near the saucer base
      front.scale.set(UFO_FRONT_H / front.texture.height);
      front.position.set(0, UFO_FRONT_DY);
      root.addChild(front); // in front of the pilot, below the bars added next
    }

    // Weapon reach should not dictate health-bar width. Enemy bars use compact,
    // role-based caps while player bars retain their body-relative sizing.
    if (u.team === "enemy") base = Math.min(base, u.isBoss ? 55 : 42);
    // Health bar sits ABOVE the head (enemies red, players green — set in layout).
    const hp = new Graphics();
    hp.y = topY - 8;
    root.addChild(hp);

    // Focus/charge bar sits below the feet; only shown while a zombie charges.
    const charge = new Graphics();
    charge.y = 8;
    root.addChild(charge);

    // A boss on a perch structure renders BEHIND it (legs occluded by the roof);
    // everyone else, including a boss with no structure (sky-perch UFO), is in front.
    const layer = u.isBoss && this.perchLayer ? this.bossBackLayer : this.tokenLayer;
    layer.addChild(root);
    return {
      root, actor, enemyActor, hp, charge, base, topY, pulse: 0, atkCount: 0,
      deathAnim: -1, emerged: false,
      smashSlam: -1, wasSmashWindup: 0, actorBaseScale, actorBaseY,
      healFxSeq: 0, healCastSeq: 0, healPose: 0,
    };
  }

  private buildTeamBars() {
    // Added after the battlefield layers but before every top-HUD child, keeping it
    // behind the bars, portraits, counts, timer, retreat button, and abilities.
    this.container.addChild(this.topHudBack);
    const mk = (fill: Graphics) => {
      const wrap = new Container();
      const bar = new Graphics();
      wrap.addChild(bar, fill);
      const label = new Text({
        text: "",
        style: { fontFamily: "sans-serif", fontSize: 18, fontWeight: "700", fill: 0xffffff },
      });
      label.y = 26;
      wrap.addChild(label);
      this.container.addChild(wrap);
      return { wrap, bar, label };
    };
    const p = mk(this.pFill);
    const e = mk(this.eFill);
    this.pLabel = p.label;
    this.eLabel = e.label;
    this.pWrap = p.wrap;
    this.eWrap = e.wrap;
    this.pBar = p.bar;
    this.eBar = e.bar;
    // Round countdown (top-center) → turns red "ENRAGED" when the boss enrages.
    this.roundLabel = new Text({
      text: "",
      style: { fontFamily: "sans-serif", fontSize: 20, fontWeight: "800", fill: 0xffffff },
    });
    this.roundLabel.anchor.set(0.5, 0);
    this.container.addChild(this.roundLabel);
    this.buildRetreatButton();
  }

  /** A "Retreat" button (bottom-left) that ends the raid as a
   *  loss — the army flees, so no rewards and no veterancy credit. */
  private buildRetreatButton() {
    const label = new Text({
      text: "⚑ Retreat",
      style: { fontFamily: "sans-serif", fontSize: 14, fontWeight: "700", fill: 0xffffff },
    });
    label.position.set(12, 6);
    const bg = new Graphics()
      .roundRect(0, 0, label.width + 24, label.height + 12, 6)
      .fill({ color: 0x8c2a2a, alpha: 0.92 })
      .stroke({ width: 2, color: 0x3a0d0d });
    this.retreatBtn.addChild(bg, label);
    this.retreatBtn.eventMode = "static";
    this.retreatBtn.cursor = "pointer";
    this.retreatBtn.on("pointertap", () => {
      if (this.retreatRequested || this.resultFired || this.sim.finished) return;
      if (!globalThis.confirm("Retreat from this raid? This will count as a loss.")) return;
      this.recordInput({ type: "retreat" });
      this.retreatRequested = true; // handled on the next update (safe phase change)
    });
    this.container.addChild(this.retreatBtn);
  }
  private pWrap!: Container;
  private eWrap!: Container;
  private pBar!: Graphics;
  private eBar!: Graphics;

  // The contain-fit stage rectangle (the 480x320 design space) + ground line,
  // recomputed live so the sim→screen mapping and unit placement track resizes.
  private bgRect() {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const scale = Math.min(W / DESIGN_W, H / DESIGN_H); // CONTAIN — whole scene visible
    const w = DESIGN_W * scale;
    const h = DESIGN_H * scale;
    const left = (W - w) / 2;
    const top = (H - h) / 2;
    return { left, top, w, h, scale, groundY: top + GROUND_FY * h };
  }

  // Stand the boss on top of the tallest RIGHT-SIDE structure (barn/silo/front
  // building/circus car) — the piece enemies emerge from. Raids without one (Aliens,
  // Beach, Tree World) keep the default up-right sky perch, so their boss hovers
  // (the Alien "UFO" reads as floating). Perch is stored as a fraction of the stage
  // rect so it survives resizes.
  private computePerch() {
    let best: { sp: Sprite; asset: RaidLevelAsset } | null = null;
    for (const layer of this.stageLayers) {
      const [ax] = parseVec(layer.asset.anchor);
      if (ax >= 0.9 && layer.asset.z >= 3 && (!best || layer.asset.z > best.asset.z)) {
        best = layer;
      }
    }
    if (!best) {
      this.applyPerchTweak(); // sky-perch raids still take their per-raid nudge
      return;
    }
    this.perchLayer = best; // this layer gets drawn in front of the boss (leg occlusion)
    const [ax, ay] = parseVec(best.asset.anchor);
    const [px, py] = parseVec(best.asset.position);
    const tw = best.sp.texture.width;
    const th = best.sp.texture.height;
    // Perch LEFT-of-centre on the structure. Structures are right-edge anchored, so a
    // big boss centred on the structure hangs off the screen's right edge; biasing it
    // toward the structure's left keeps it on-screen and over the building (not the
    // silo tip). tw*0.5 = centre; tw*PERCH_BIAS_FX pulls it left.
    const centerX = px - ax * tw + tw * PERCH_BIAS_FX;
    // Sink the perch BELOW the structure's top edge so the boss stands down behind
    // the roof (its legs hidden by the structure it renders behind), not floating on
    // the peak. topY is the top edge (design y, Y-up); subtract to move the feet down.
    const topY = py + (1 - ay) * th - PERCH_SINK_F * th;
    this.perchFX = centerX / DESIGN_W;
    this.perchFY = (DESIGN_H - topY) / DESIGN_H; // screen fraction from the top
    this.applyPerchTweak();
  }

  /** Nudge the computed perch by this raid's per-raid tuning override (if any). */
  private applyPerchTweak() {
    const tw = PERCH_TWEAK[this.raid.id];
    if (!tw) return;
    this.perchFX += tw.dx ?? 0;
    this.perchFY += tw.dy ?? 0;
  }

  // Sim→screen mapping, anchored to the background rect + its ground line.
  private mapX(sx: number): number {
    const r = this.bgRect();
    const mx = r.w * FIELD_INSET_FX;
    return r.left + mx + (sx / FIELD_W) * (r.w - 2 * mx);
  }
  /** How much to scale unit-space sizes/offsets so they track the contain-fit stage
   *  (1 at SIZE_REF_SCALE). Everything measured in "unit px" — heights, ground nudges,
   *  poof offsets — multiplies by this so it grows/shrinks with the window. */
  private sizeScale(): number {
    return this.bgRect().scale / SIZE_REF_SCALE;
  }
  private mapY(sy: number): number {
    const r = this.bgRect();
    // Shallow vertical band around the ground line (rows give a little depth).
    return r.groundY + GROUND_NUDGE * this.sizeScale() + (sy - CENTER_Y) * (r.h * 0.00028);
  }
  /** Vertical mapping for boss projectiles: unlike mapY's shallow ground band,
   *  this spans the full drop so a throw leaves the boss's perch and lands at the
   *  ground line (the boss is rendered up on the silo, out of mapY's range). */
  private mapProjY(sy: number): number {
    const r = this.bgRect();
    const perchY = r.top + this.perchFY * r.h;
    const groundLineY = r.groundY + (GROUND_NUDGE + UNIT_GROUND_NUDGE) * this.sizeScale();
    const t = (sy - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y);
    return perchY + t * (groundLineY - perchY);
  }
  /** Horizontal sim→screen scale, for sizing projectiles in field units. */
  private scaleX(): number {
    const r = this.bgRect();
    return (r.w * (1 - 2 * FIELD_INSET_FX)) / FIELD_W;
  }

  /** Recompute all screen positions from the current viewport + sim state.
   *  `dtSec` drives the zombie walk animation (0 for a static re-layout). */
  private layout(dtSec = 0) {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const r = this.bgRect();
    const mx = W * 0.05; // screen margin for the top HUD bars

    // Position every stage layer in the 480x320 design space (cocos2d Y-up anchors),
    // contain-fit into the viewport, so the whole scene (backgrounds + structure)
    // stays visible. Fill the letterbox with sky above the ground line, grass below.
    for (const { sp, asset } of this.stageLayers) {
      const [ax, ay] = parseVec(asset.anchor);
      const [px, py] = parseVec(asset.position);
      sp.anchor.set(ax, 1 - ay); // cocos Y-up anchor → Pixi Y-down
      sp.scale.set(r.scale);
      sp.position.set(r.left + px * r.scale, r.top + (DESIGN_H - py) * r.scale);
    }
    this.backdrop
      .clear()
      .rect(0, 0, W, r.groundY).fill(LETTERBOX_TOP)
      .rect(0, r.groundY, W, Math.max(0, H - r.groundY)).fill(LETTERBOX_BOT);

    const toX = (sx: number) => this.mapX(sx);
    const toY = (sy: number) => this.mapY(sy);
    const renderPos = (u: SimUnit) => this.phase === "fight"
      ? interpolatePosition(
          { x: u.prevX, y: u.prevY },
          { x: u.x, y: u.y },
          this.simAccumulatorMs,
          RAID_TICK_MS,
          TELEPORT_PX
        )
      : { x: u.x, y: u.y };
    const visualLeadMs = this.phase === "fight" ? Math.min(this.simAccumulatorMs, RAID_TICK_MS) : 0;
    // Boss perch on the structure (computed), and its descent lerp back to the ground.
    const perchX = r.left + this.perchFX * r.w;
    const perchY = r.top + this.perchFY * r.h;
    const bossPos = (u: SimUnit, x: number, y: number): [number, number] => {
      // Perched: on the structure. Descending: slide right off-screen at perch height
      // (behind the structure — reads as exiting through the entrance). Emerging/hold/
      // fight: a normal ground unit, walking in from the right to the attack spot.
      if (u.state === "structure") return [perchX, perchY];
      if (u.state === "descending") {
        const t = Math.max(0, Math.min(1, (x - BOSS_STRUCT_X) / (ENEMY_SPAWN_X - BOSS_STRUCT_X)));
        return [perchX + t * (r.left + r.w + 140 - perchX), perchY];
      }
      return [toX(x), toY(y)];
    };

    const introSlide = this.phase === "intro" ? (1 - this.phaseT / INTRO_MS) * (r.w * 0.28) : 0;

    let pHp = 0;
    let eHp = 0;
    let pAlive = 0;
    let eAlive = 0;
    for (const u of this.sim.units) {
      // Units spawned mid-fight (summoned minions, walls) get their token on first
      // sight — the renderer only holds tokens for the initial roster otherwise.
      let tok = this.tokens.get(u.id);
      if (!tok) {
        tok = this.makeToken(u);
        this.tokens.set(u.id, tok);
      }

      // Remaining-team totals count every living unit, including a zombie still
      // waiting to charge and an enemy still queued off-screen.
      if (u.team === "player") {
        pHp += Math.max(0, u.hp);
        if (u.alive) pAlive++;
      } else {
        eHp += Math.max(0, u.hp);
        if (u.alive) eAlive++;
      }

      // Queued enemies haven't emerged yet — keep them hidden off the field.
      if (u.state === "queued") {
        tok.root.visible = false;
        continue;
      }
      tok.root.visible = true;

      // Boss layering: perched or exiting right, it renders BEHIND the structure
      // (legs/exit occluded by the roof); once it re-enters as a ground unit it's a
      // normal front-layer token that walks in front of the building.
      if (u.isBoss && this.perchLayer) {
        const wantLayer =
          u.state === "structure" || u.state === "descending" ? this.bossBackLayer : this.tokenLayer;
        if (tok.root.parent !== wantLayer) wantLayer.addChild(tok.root);
      }

      // Units track the stage size: their whole token (rig + bars) is scaled by szs,
      // so a smaller window shrinks them with the background instead of leaving them
      // fixed-pixel giants. szs also scales unit-space offsets (drop, poof, settle).
      const szs = this.sizeScale();
      const slide = u.team === "player" ? -introSlide : 0;
      const groundDrop = UNIT_GROUND_NUDGE * szs;
      const pos = renderPos(u);
      let [sx, sy] = u.isBoss ? bossPos(u, pos.x, pos.y) : [toX(pos.x) + slide, toY(pos.y) + groundDrop];
      // Perched/exiting bosses use their structure baseline; after re-entering the
      // lane they stand on the same lowered ground baseline as every other unit.
      if (u.isBoss && u.state !== "structure" && u.state !== "descending") sy += groundDrop;
      // Mini Buddy jumps from its waiting spot onto the Large zombie, then rides
      // near the carrier's shoulder until the pair reaches the frontline.
      if (u.state === "carried" && u.buddyCarrierId) {
        const carrier = this.sim.units.find((p) => p.id === u.buddyCarrierId);
        const carrierTok = carrier ? this.tokens.get(carrier.id) : undefined;
        if (carrier && carrierTok) {
          const carrierPos = renderPos(carrier);
          const tx = toX(carrierPos.x) - 8 * szs;
          const ty = toY(carrierPos.y) + UNIT_GROUND_NUDGE * szs + carrierTok.topY * 0.58 * szs;
          const mountMs = visualCountdown(u.buddyMountMs, visualLeadMs, RAID_TICK_MS);
          const t = Math.max(0, Math.min(1, 1 - mountMs / 500));
          sx += (tx - sx) * t;
          sy += (ty - sy) * t - Math.sin(Math.PI * t) * 30 * szs;
        }
      }
      tok.root.position.set(sx, sy);
      tok.root.zIndex = u.isBoss ? 100000 : u.alive ? Math.round(sy * 10) : 0;

      // Track the perched boss's throwing hand so projectiles leave from it (his upper
      // body), not the raw sim origin mapped independently (which read down-left of him).
      if (u.isBoss && u.state === "structure") {
        this.bossHandX = sx + BOSS_HAND_DX * szs;
        this.bossHandY = sy + tok.topY * BOSS_HAND_FY * szs;
      }

      // Spawn puff the first time a unit reaches the field mid-fight (queued enemies
      // emerging, summoned minions) — the intro roster slides in and doesn't puff.
      if (!tok.emerged) {
        tok.emerged = true;
        if (this.phase !== "intro" && u.alive) this.spawnPoof(sx, sy + tok.topY * 0.5 * szs, 0xe6d6b0);
      }

      if (u.alive) {
        // Normal zombies stay at a stable size; only enemies retain the compact hit
        // pulse. Smash still scales the actor rig itself below as part of the move.
        const pulseScale = u.team === "enemy" ? 1 + 0.16 * tok.pulse : 1;
        tok.root.scale.set(pulseScale * szs);
        tok.root.alpha = 1;
      } else {
        // On death: puff a dust cloud once, then fade + settle out over DEATH_FADE
        // (was a lingering 18%-alpha ghost).
        if (tok.deathAnim < 0) {
          tok.deathAnim = 0;
          const midY = sy + tok.topY * 0.5 * szs;
          if (u.team === "enemy" && this.smokeCfg) {
            // Enemy death: the source game's own poof — CivilianActorFight
            // playDeathEffect fetches the "smoke" particle (swirlCloudFX) at the
            // actor's position, so a slain enemy vanishes in a rising smoke burst.
            this.particles.burst(this.smokeCfg, sx, midY, 1);
          } else {
            // Zombie death (or if the smoke config failed to load): the dust puff.
            this.spawnPoof(sx, midY, u.team === "player" ? 0xbfe39a : 0xe6d6b0);
          }
          tok.actor?.markDead(); // zombie: pop the head off, tumbling backward
        }
        tok.deathAnim += dtSec;
        const k = Math.min(1, tok.deathAnim / DEATH_FADE);
        const pulseScale = u.team === "enemy" ? 1 + 0.16 * tok.pulse : 1;
        tok.root.scale.set(pulseScale * (1 - 0.28 * k) * szs);
        tok.root.alpha = 1 - k;
        tok.root.y = sy + k * 7 * szs; // slight settle downward
      }

      if (u.healFxSeq > tok.healFxSeq) {
        tok.healFxSeq = u.healFxSeq;
        if (this.healCfg) this.particles.burst(this.healCfg, sx, sy + tok.topY * 0.45 * szs, 0.55);
      }
      if (u.healCastSeq > tok.healCastSeq) {
        tok.healCastSeq = u.healCastSeq;
        tok.healPose = HEAL_POSE_S;
      }
      if (tok.healPose > 0) tok.healPose = Math.max(0, tok.healPose - dtSec);

      // Zombie rig: play the walk animation whenever it's actually moving, and
      // turn to face the way it's pacing (so waiting zombies mill back and forth).
      const visualWindupMs = visualCountdown(u.windupMs, visualLeadMs, RAID_TICK_MS);
      const visualAttackMs = visualCountdown(u.timerMs, visualLeadMs, RAID_TICK_MS);
      const windup = u.windupKey ? 1 - visualWindupMs / Math.max(1, u.windupTotal) : 0;
      // The simulation advances at a fixed 50 ms cadence while rendering can run
      // faster. Use the velocity retained by the last simulation tick, rather than
      // comparing positions each render frame: the latter alternated moving/stopped
      // between ticks and made walking rigs twitch rapidly.
      const simMoving = Math.hypot(u.vx, u.vy) > 6;
      const introMarch = this.phase === "intro"; // zombies slide in during the intro
      const retreatMarch = this.phase === "retreat" && u.team === "player" && u.alive;
      if (tok.actor) {
        if (retreatMarch) tok.actor.setFacingFromDelta(-1);
        else if (Math.abs(u.vx) > 6) tok.actor.setFacingFromDelta(u.vx);
        const moving = u.alive && (simMoving || introMarch || retreatMarch);
        tok.actor.update(dtSec, moving);

        // Garden heal: lift both arms overhead, hold through the healing burst, then
        // lower them. This pose is visual only; healing remains simulation-owned.
        const healElapsed = HEAL_POSE_S - tok.healPose;
        const healRaise = tok.healPose <= 0 ? 0
          : healElapsed < 0.14 ? healElapsed / 0.14
          : tok.healPose < 0.16 ? tok.healPose / 0.16
          : 1;

        // Smash (bash family): grow to 1+SMASH_GROW while charging (tracks the arm
        // raise), then a rapid slam+shrink on release. Detect release by the smash
        // charge dropping to 0 (windupKey clears once the payoff blow lands).
        const smashing = !!u.windupKey && SMASH_KEYS.has(u.windupKey);
        if (tok.wasSmashWindup > 0 && !smashing && tok.smashSlam < 0) {
          tok.smashSlam = SMASH_SLAM_S; // just released — begin the slam
        }
        tok.wasSmashWindup = smashing ? windup : 0;
        let grow = 1;
        let slamProg = -1;
        if (smashing) {
          grow = 1 + SMASH_GROW * windup; // loom up as the arms rise
        } else if (tok.smashSlam >= 0) {
          tok.smashSlam -= dtSec;
          slamProg = Math.max(0, tok.smashSlam) / SMASH_SLAM_S; // 1 → 0
          grow = 1 + SMASH_GROW * slamProg; // shrink 1.4 → 1
          if (tok.smashSlam <= 0) tok.smashSlam = -1;
        }
        // Feet-anchored grow: scale the rig container (and its feet offset) — NOT the
        // whole token — so the HP bar doesn't balloon with it.
        tok.actor.container.scale.set(tok.actorBaseScale * grow);
        tok.actor.container.y = tok.actorBaseY * grow;

        // Arms: smash slam > wind-up (activated) > attack (forward + wave) > walking
        // (forward) > waiting (sides). The attack wave is locked to the sim's attack
        // clock — a full switch per cooldown — kept continuous per hit by atkCount.
        const fighting = this.phase === "fight" && u.state === "fight" && !u.windupKey && u.alive;
        const atkProg = Math.max(0, Math.min(1, 1 - visualAttackMs / Math.max(1, u.cooldownMs)));
        tok.actor.poseArms(Math.max(windup, healRaise), fighting, moving, atkProg, tok.atkCount, slamProg);
      }
      // Enemy rig: idle bob when holding position, walk cycle while advancing, and a
      // forward strike lunge while trading blows — the lunge peaks at the attack's
      // damageTiming so its reach lands with the sim's hit (see EnemyActor).
      if (tok.enemyActor) {
        if (Math.abs(u.vx) > 6) tok.enemyActor.setFacingFromDelta(u.vx);
        const enemyFighting = u.state === "fight" && u.alive;
        const atkProg = Math.max(0, Math.min(1, 1 - visualAttackMs / Math.max(1, u.cooldownMs)));
        let attack = enemyFighting ? { atkProg, damageTiming: u.attackDamageTiming } : null;
        // Perched boss: a simple throw swing — the arm cocks and swings forward as the
        // throw winds up, releasing (peak reach) as the projectile launches. Map the
        // sim's 0..1 wind-up onto the attack envelope's active window (past its rest
        // lead-in) so the arm animates over the whole wind-up.
        if (u.isBoss && u.state === "structure") {
          const sw = this.sim.bossThrowSwing(550, visualLeadMs);
          attack = sw === null ? null : { atkProg: 0.28 + 0.72 * sw, damageTiming: 0.9 };
        }
        tok.enemyActor.update(dtSec, u.alive && simMoving, attack);
      }

      const frac = Math.max(0, u.hp / u.maxHp);
      tok.hp.clear();
      if (u.alive && u.state !== "carried") {
        const w = tok.base * 2;
        const fill = u.team === "enemy" ? ENEMY_COLOR : PLAYER_COLOR; // enemies red
        tok.hp
          .rect(-tok.base, 0, w, 5).fill({ color: 0x000000, alpha: 0.55 })
          .rect(-tok.base, 0, w * frac, 5).fill(fill);
      }

      // Focus bar while charging (golden), or the activated-move wind-up (orange).
      tok.charge.clear();
      if (u.state === "charging") {
        const w = tok.base * 2;
        tok.charge
          .rect(-tok.base, 0, w, 4).fill(0x2a2410)
          .rect(-tok.base, 0, w * Math.max(0, Math.min(1, u.charge)), 4).fill(0xffcf5a);
      } else if (u.windupKey) {
        const w = tok.base * 2;
        tok.charge
          .rect(-tok.base, 0, w, 4).fill(0x3a1408)
          .rect(-tok.base, 0, w * windup, 4).fill(0xff6a2a);
      }
    }
    this.tokenLayer.sortableChildren = true;

    // Focus bubble: hover it over the charging zombie while it's distracted (butterfly)
    // or fully charged and awaiting release (brain); hide it otherwise.
    const bub = this.sim.chargingBubble();
    const bubTok = bub ? this.tokens.get(bub.id) : undefined;
    if (bub && bubTok) {
      this.bubbleUnitId = bub.id;
      this.bubble.visible = true;
      const tex = bub.kind === "brain" ? this.bubbleTexBrain : this.bubbleTexButterfly;
      if (tex) this.bubbleSprite.texture = tex;
      const szs = this.sizeScale();
      this.bubbleSprite.scale.set(-BUBBLE_SCALE * szs, BUBBLE_SCALE * szs); // track unit size
      const bob = Math.sin(this.phaseT / 260) * 3 * szs;
      this.bubble.position.set(
        bubTok.root.x + BUBBLE_DX * szs,
        bubTok.root.y - (bubTok.base + 34) * szs + bob
      );
      const s = this.bubble.scale.x;
      this.bubble.scale.set(s + (1 - s) * Math.min(1, dtSec * 14)); // ease tap-feedback back
    } else {
      this.bubble.visible = false;
      this.bubble.scale.set(1);
      this.bubbleUnitId = null;
    }

    // Team bars, top corners.
    const barW = Math.min(W * 0.34, 380);
    const barH = 20;
    const topHudH = Math.max(72, H * 0.05 + barH + 34);
    this.topHudBack.clear()
      .rect(0, 0, W, topHudH).fill({ color: 0x15130f, alpha: 0.78 })
      .rect(0, topHudH - 4, W, 4).fill({ color: 0x090a08, alpha: 0.5 })
      .moveTo(0, topHudH - 1).lineTo(W, topHudH - 1)
      .stroke({ width: 2, color: 0xc7b78b, alpha: 0.48 });
    this.pWrap.position.set(mx, H * 0.05);
    this.eWrap.position.set(W - mx - barW, H * 0.05);
    // Face badges just outside each bar (clamped on-screen): zombie left, enemy right.
    const faceY = H * 0.05 + barH / 2;
    this.pFace.position.set(Math.max(28, mx - 30), faceY);
    this.eFace.position.set(Math.min(W - 28, W - mx + 30), faceY);
    // Both team bars read green when full (drain as the team loses HP).
    this.drawTeamBar(this.pBar, this.pFill, barW, barH, pHp / this.maxPlayerHp, PLAYER_COLOR);
    this.drawTeamBar(this.eBar, this.eFill, barW, barH, eHp / this.maxEnemyHp, PLAYER_COLOR);
    this.pLabel.text = `Zombies  ${pAlive}`;
    this.eLabel.text = `${this.raid.bossName || "Enemies"}  ${eAlive}`;
    this.eLabel.x = barW - this.eLabel.width;

    // Round countdown → ENRAGED. Only meaningful for a raid with a boss timer.
    const remMs = this.sim.roundRemainingMs();
    if (this.sim.enraged) {
      this.roundLabel.text = "⚠ ENRAGED";
      this.roundLabel.style.fill = 0xff5a3c;
    } else if (remMs > 0) {
      const s = Math.ceil(remMs / 1000);
      this.roundLabel.text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      this.roundLabel.style.fill = s <= 15 ? 0xffcc33 : 0xffffff;
    } else {
      this.roundLabel.text = "";
    }
    this.roundLabel.position.set(W / 2, H * 0.05);

    // Retreat stays out of the combat HUD at the bottom-left of the viewport.
    this.retreatBtn.visible = (this.phase === "intro" || this.phase === "fight")
      && !this.sim.finished && !this.retreatRequested;
    this.retreatBtn.position.set(mx, H - this.retreatBtn.height - 18);

    // Ability strip remains below the top-left health bar. Activated badges show how
    // many zombies are ready right now; dim a move when none can perform it.
    const CELL = 52;
    this.abilityStrip.position.set(mx + 24, H * 0.05 + barH + 54 + 24);
    const status = new Map(this.sim.activatedStatus().map((s) => [s.key, s.ready]));
    this.abilityCells.forEach((c, i) => {
      c.cell.y = i * CELL;
      if (c.cell.scale.x < 1) c.cell.scale.set(Math.min(1, c.cell.scale.x + dtSec * 4)); // ease tap-press back
      if (c.activated) {
        const ready = status.get(c.key) ?? 0;
        if (c.badge) c.badge.text = String(ready);
        c.cell.alpha = ready > 0 ? 1 : 0.5;
      }
    });

    this.syncProjectiles();
  }

  /** Mirror the sim's live projectiles into pooled sprites. */
  /** A dust puff at (x,y): a soft expanding disc that fades over ~0.45s. Zombies
   *  poof a pale green, enemies a neutral dust. Replaces the old lingering ghost. */
  private spawnPoof(x: number, y: number, color: number) {
    const g = new Graphics();
    g.position.set(x, y);
    this.fxLayer.addChild(g);
    this.fx.push({ g, t: 0, life: 0.45, color });
  }

  private stepFx(dtSec: number) {
    for (const e of this.fx) {
      e.t += dtSec;
      const k = Math.min(1, e.t / e.life);
      const r = 7 + 24 * k;
      const a = (1 - k) * 0.5;
      e.g.clear()
        .circle(0, -6 * k, r).fill({ color: e.color, alpha: a })
        .circle(7 * (1 - k), -20 * k, r * 0.55).fill({ color: e.color, alpha: a * 0.8 });
    }
    if (this.fx.some((e) => e.t >= e.life)) {
      for (const e of this.fx) if (e.t >= e.life) e.g.destroy();
      this.fx = this.fx.filter((e) => e.t < e.life);
    }
  }

  /** A round white texture (tinted at use) for hazards that ship no projectile art. */
  private hazardDotTex(): Texture {
    if (!this.dotTex) {
      const g = new Graphics().circle(16, 16, 15).fill(0xffffff);
      this.dotTex = this.app.renderer.generateTexture(g);
      g.destroy();
    }
    return this.dotTex;
  }

  private syncProjectiles() {
    const live = new Set<string>();
    const s = this.scaleX();
    for (const pr of this.sim.projectiles) {
      live.add(pr.id);
      let sp = this.projSprites.get(pr.id);
      if (!sp) {
        const tex = this.projTex.get(pr.sprite) ?? null;
        // Hazards with no preloaded sprite (falling obstacles / grabs) render as a
        // round warning dot — NOT Texture.WHITE, which read as a spinning square.
        sp = new Sprite(tex ?? this.hazardDotTex());
        sp.anchor.set(0.5);
        if (!tex) sp.tint = 0xff7a3c;
        this.projLayer.addChild(sp);
        this.projSprites.set(pr.id, sp);
      }
      // Rendered ~2× the old size (the collision radius in BattleSim is unchanged —
      // this is a visual-legibility bump so thrown items read clearly).
      const size = Math.max(20, pr.spriteSize * s * 2.4);
      sp.width = size;
      sp.height = size;
      sp.rotation = pr.rot;
      const visual = extrapolatePosition(pr.x, pr.y, pr.vx, pr.vy, this.simAccumulatorMs, RAID_TICK_MS);
      let px = this.mapX(visual.x);
      let py = this.mapProjY(visual.y);
      if (!pr.hazard && !pr.crossing) {
        // Boss throw/laser: re-anchor the ORIGIN to the boss's hand, fading the shift
        // to zero as the projectile nears the ground so the LANDING still tracks the
        // target zombie. (The raw sim origin maps to a point down-left of the boss.)
        const t = Math.max(0, Math.min(1, (visual.y - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y)));
        const fade = 1 - t;
        px += (this.bossHandX - this.mapX(BOSS_STRUCT_X)) * fade;
        py += (this.bossHandY - this.mapProjY(BOSS_STRUCT_Y)) * fade;
      }
      sp.position.set(px, py);
    }
    // Drop sprites whose projectile has landed.
    for (const [id, sp] of this.projSprites) {
      if (!live.has(id)) {
        sp.destroy();
        this.projSprites.delete(id);
      }
    }
  }

  private drawTeamBar(bar: Graphics, fill: Graphics, w: number, h: number, frac: number, color: number) {
    const f = Math.max(0, Math.min(1, frac));
    bar.clear()
      .roundRect(-5, -5, w + 10, h + 10, 7).fill({ color: 0x11130f, alpha: 0.94 })
      .roundRect(0, 0, w, h, 4).fill({ color: 0x050505, alpha: 0.82 })
      .roundRect(-5, -5, w + 10, h + 10, 7).stroke({ width: 2, color: 0xd9e2c4, alpha: 0.8 });
    fill.clear();
    if (f > 0) fill.roundRect(0, 0, w * f, h, 4).fill(color);
  }

  /** Drive the scene forward. Called from the app ticker with seconds. */
  update(dtSec: number) {
    const dtMs = Math.min(dtSec * 1000, 250);
    this.phaseT += dtMs;
    for (const t of this.tokens.values()) t.pulse = Math.max(0, t.pulse - dtSec * 6);
    this.stepFx(dtSec);
    this.particles.update(dtSec);

    // Retreat is handled here (not in the tap handler) so nothing runs mid
    // event-dispatch on the button that triggered it.
    if (this.retreatRequested && !this.resultFired) {
      this.retreated = true;
      this.retreatRequested = false;
      this.retreatBtn.visible = false;
      this.abilityStrip.interactiveChildren = false;
      this.bubble.visible = false;
      this.setPhase("retreat");
    }

    switch (this.phase) {
      case "intro":
        if (this.phaseT >= INTRO_MS) this.setPhase("fight");
        break;
      case "fight": {
        if (this.onCheckpoint && !this.sim.finished && this.simTick - this.lastCheckpointTick >= 300) {
          if (!this.checkpointing && performance.now() >= this.checkpointRetryAt) {
            this.checkpointing = true;
            // Checkpoints are transport work, not a simulation gate.  Pausing here
            // made a slow/failed request freeze combat at the 15-second boundary
            // while Pixi, particles, and music continued to animate.  Keep each
            // segment pinned to exactly 300 ticks so a retry remains valid even
            // though the local simulation has continued past the boundary.
            const tick = this.lastCheckpointTick + 300;
            const segment = this.replayInputs.filter((input) => input.tick > this.lastCheckpointTick && input.tick <= tick);
            void this.onCheckpoint(tick, segment).then(() => {
              this.lastCheckpointTick = tick;
              this.replayInputs = this.replayInputs.filter((input) => input.tick > tick);
            }).catch(() => {
              this.checkpointRetryAt = performance.now() + 1000;
            }).finally(() => { this.checkpointing = false; });
          }
        }
        this.simAccumulatorMs += dtMs;
        // Combat advances only in fixed ticks. Rendering remains free to interpolate
        // at the display cadence, but it can no longer change the outcome.
        let catchup = 0;
        let stepped = false;
        while (this.simAccumulatorMs >= RAID_TICK_MS && !this.sim.finished && catchup++ < 5) {
          this.sim.step(RAID_TICK_MS);
          this.simAccumulatorMs -= RAID_TICK_MS;
          this.simTick++;
          stepped = true;
        }
        // `struckThisTick` remains set until the NEXT simulation step resets it. Only
        // consume it on a frame that actually advanced the sim; otherwise a 60/120 Hz
        // renderer would replay one strike several times, resetting the pulse and
        // flipping the attack-arm parity every display frame.
        if (stepped) {
          for (const u of this.sim.units) {
            if (u.struckThisTick) {
              const t = this.tokens.get(u.id);
              if (t) {
                t.pulse = 1;
                t.atkCount++; // completes an arm-wave switch (the attacker just hit)
                // A small dust burst at the point of impact (victim's mid-body).
                if (this.bashCfg && u.alive) {
                  this.particles.burst(this.bashCfg, t.root.x, t.root.y + t.topY * 0.5, 0.28);
                }
              }
            }
          }
        }
        // Confetti pops the moment the players win (across the top of the field).
        if (this.sim.finished && this.sim.playerWon && !this.confettiFired && this.confettiCfg) {
          this.confettiFired = true;
          const r = this.bgRect();
          this.particles.burst(this.confettiCfg, r.left + r.w / 2, r.top + r.h * 0.12, 1.4, true);
        }
        if (this.sim.finished && this.phaseT >= END_PAUSE_MS) {
          this.setPhase(this.sim.playerWon ? "outro" : "defeat");
        } else if (!this.sim.finished) {
          this.phaseT = 0; // keep the end-pause clock fresh until the sim ends
        }
        break;
      }
      case "outro": {
        // Survivors stroll off to the right at a normal walking pace (was a 600px/s
        // sprint). After a short beat the results/loot panel slides in from the
        // right — giving the army a moment to walk away before it appears.
        for (const u of this.sim.units) {
          if (u.team === "player" && u.alive) u.x += (OUTRO_WALK_SPEED * dtMs) / 1000;
        }
        if (this.phaseT >= OUTRO_RESULT_DELAY_MS) this.fireResult();
        break;
      }
      case "retreat": {
        // Living zombies turn around and walk off the left edge. Combat is frozen;
        // after the same kind of visual beat used by victory, show the loss panel.
        for (const u of this.sim.units) {
          if (u.team === "player" && u.alive) u.x -= (OUTRO_WALK_SPEED * dtMs) / 1000;
        }
        if (this.phaseT >= RETREAT_RESULT_DELAY_MS) {
          this.fireResult();
          this.phase = "done";
        }
        break;
      }
      case "defeat":
        if (this.phaseT >= END_PAUSE_MS) {
          this.fireResult();
          this.phase = "done";
        }
        break;
      case "done":
        break; // hold; the panel's finish button tears the scene down (via main)
    }

    this.layout(dtSec);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  /** Emit the outcome once (the reward pipeline + results panel run in main).
   *  The scene keeps rendering behind the panel until main tears it down. */
  private fireResult() {
    if (this.resultFired) return;
    this.resultFired = true;
    const o = this.sim.outcome();
    // A retreat is a clean flee: survivors aren't credited (no veterancy), but the
    // tally still reflects what happened up to the retreat.
    const outcome = this.retreated ? { ...o, win: false, survivors: [] } : o;
    this.onFinish(outcome, this.simTick, this.replayInputs.slice());
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}

function sumMax(units: CombatUnit[]): number {
  return units.reduce((s, u) => s + u.maxHp, 0);
}
