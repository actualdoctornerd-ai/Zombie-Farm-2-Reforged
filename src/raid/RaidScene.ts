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
import { BattleSim, BOSS_STRUCT_Y, FIELD_H, FIELD_W, SimUnit } from "./BattleSim";
import { RaidActor } from "./RaidActor";
import { ABILITY_POOL } from "../zombie/traits";
import { BossSpecial, BossThrowConfig, CombatUnit, HazardConfig, RaidDef, RaidLevelAsset, RaidOutcome } from "./types";
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
  onFinish: (outcome: RaidOutcome) => void;
}

const INTRO_MS = 700; // zombies slide in
const END_PAUSE_MS = 650; // beat after the last blow before we move on
const PLAYER_COLOR = 0x8bc34a;
const ENEMY_COLOR = 0xef5350;
const BOSS_COLOR = 0xffc107;
// On-screen heights (px) the unit sprites are scaled to.
const ZOMBIE_H = 91;
const ENEMY_H = 109;
const BOSS_H = 156;
// Background layout. The bg is CONTAIN-fit (whole scene visible, no bottom crop);
// the ground line the characters stand on sits GROUND_FY down the image, and the
// boss perches on the silo at PERCH_F*. Letterbox areas fill with sky/grass.
const GROUND_FY = 0.9;
// Units sit a touch below the bg's ground line (they were reading a bit high) —
// about 20% of a zombie's on-screen height. Zombies sit a little lower still.
const GROUND_NUDGE = ZOMBIE_H * 0.2;
const PLAYER_NUDGE = ZOMBIE_H * 0.22;
// Default boss perch (fraction of the stage rect) for raids with no right-side
// structure — the boss hovers up-right like a UFO (Aliens) rather than standing.
const PERCH_FX = 0.82;
const PERCH_FY = 0.2;
const SKY_COLOR = 0x9fd4ef;
const GRASS_COLOR = 0x74a63a;
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
// Source-game focus thought-bubbles (misc/thoughtBubble*.png), shown over the
// charging zombie. Butterfly = distracted; brain = fully focused / ready.
const BUBBLE_BUTTERFLY = BASE + "assets/ui/thoughtBubbleButterfly.png";
const BUBBLE_BRAIN = BASE + "assets/ui/thoughtBubbleBrains.png";
const BUBBLE_SCALE = 0.91; // the source art is 64x62 (1.3 enlarged, then scaled ~30% down)
const BUBBLE_DX = 74; // shift the (mirrored) bubble right of the charging zombie (~one bubble width: 16 + 64*0.91)

type Phase = "intro" | "fight" | "outro" | "defeat" | "done";

interface Token {
  root: Container;
  actor?: RaidActor; // player zombie rig (walk animation)
  hp: Graphics;
  charge: Graphics; // focus bar (zombies, while charging)
  base: number; // half-width for the bars
  topY: number; // y of the sprite top (negative), for the hp bar
  pulse: number; // hit lunge, decays to 0
  lastX: number; // previous screen pos (for the moving flag)
  lastY: number;
}

async function loadTex(url: string): Promise<Texture | null> {
  try {
    return (await Assets.load(url)) as Texture;
  } catch {
    return null;
  }
}

export class RaidScene {
  readonly container = new Container();
  private sim: BattleSim;
  private raid: RaidDef;
  private onFinish: (o: RaidOutcome) => void;

  private assets: GameAssets;
  private backdrop = new Graphics(); // sky/grass fill behind the (letterboxed) stage
  private stageLayer = new Container(); // all parallax level-asset layers, z-sorted
  private stageLayers: { sp: Sprite; asset: RaidLevelAsset }[] = [];
  private perchFX = PERCH_FX; // boss perch, computed from the stage's structure
  private perchFY = PERCH_FY;
  private tokenLayer = new Container();
  private tokens = new Map<string, Token>();
  private texByUnit = new Map<string, Texture | null>(); // fallback portrait tokens
  private enemyTex = new Map<string, Texture | null>(); // composited enemy sprites

  // Boss projectiles.
  private bossThrow: BossThrowConfig | null;
  private wallTemplate: CombatUnit | null; // preloaded so a spawned wall renders as a sprite
  private projLayer = new Container();
  private projTex = new Map<string, Texture | null>();
  private projSprites = new Map<string, Sprite>();

  // team bars
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
    this.bossThrow = params.bossThrow;
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

    // Enemy sprites: one composited actor per enemy type (farmhand/boss/…). Fall
    // back to the raid's flat enemy icon / boss portrait for types without one.
    const enemyKeys = [...new Set(this.sim.units.filter((u) => u.team === "enemy").map((u) => u.sourceKey))];
    await Promise.all(
      enemyKeys.map(async (k) => this.enemyTex.set(k, await loadTex(enemySprite(k))))
    );
    const enemyUrl = this.raid.enemyIcon ? raidImage(this.raid.enemyIcon) : "";
    const bossUrl = this.raid.bossPortrait ? raidImage(this.raid.bossPortrait) : "";
    const fallbackUrls = new Map<string, string>();
    for (const u of this.sim.units) {
      if (u.team !== "enemy" || this.enemyTex.get(u.sourceKey)) continue;
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

    this.container.addChild(this.tokenLayer);
    for (const u of this.sim.units) this.tokens.set(u.id, this.makeToken(u));

    // Preload boss projectile sprites (chicken/bucket/debris).
    this.container.addChild(this.projLayer);
    for (const opt of this.bossThrow?.options ?? []) {
      if (this.projTex.has(opt.sprite)) continue;
      this.projTex.set(opt.sprite, await loadTex(raidImage(opt.sprite)));
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
        if (this.sim.activate(key)) cell.scale.set(0.86); // tap feedback (eased back in layout)
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

  private makeToken(u: SimUnit): Token {
    const root = new Container();
    let actor: RaidActor | undefined;
    let base = 22;
    let topY = -60;

    if (u.team === "player") {
      // Real farm-style zombie rig (with the walk animation), scaled to fit.
      actor = new RaidActor(this.assets, u.sourceKey);
      const b = actor.container.getLocalBounds();
      const s = ZOMBIE_H / Math.max(1, b.height);
      actor.container.scale.set(s);
      actor.container.y = -(b.y + b.height) * s; // stand its feet at the origin
      root.addChild(actor.container);
      base = Math.max(14, (b.width * s) / 2);
      topY = -ZOMBIE_H;
    } else {
      const targetH = u.isBoss ? BOSS_H : ENEMY_H;
      const tex = this.enemyTex.get(u.sourceKey) ?? null;
      if (tex) {
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

    // Health bar sits ABOVE the head (enemies red, players green — set in layout).
    const hp = new Graphics();
    hp.y = topY - 8;
    root.addChild(hp);

    // Focus/charge bar sits below the feet; only shown while a zombie charges.
    const charge = new Graphics();
    charge.y = 8;
    root.addChild(charge);

    this.tokenLayer.addChild(root);
    return { root, actor, hp, charge, base, topY, pulse: 0, lastX: 0, lastY: 0 };
  }

  private buildTeamBars() {
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

  /** A "Retreat" button (top-left under the health bar) that ends the raid as a
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
      this.retreatRequested = true; // handled on the next update (safe teardown)
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
    if (!best) return;
    const [ax, ay] = parseVec(best.asset.anchor);
    const [px, py] = parseVec(best.asset.position);
    const tw = best.sp.texture.width;
    const th = best.sp.texture.height;
    const centerX = px - ax * tw + tw / 2; // structure center (design x)
    const topY = py + (1 - ay) * th; // structure top edge (design y, Y-up)
    this.perchFX = centerX / DESIGN_W;
    this.perchFY = (DESIGN_H - topY) / DESIGN_H; // screen fraction from the top
  }

  // Sim→screen mapping, anchored to the background rect + its ground line.
  private mapX(sx: number): number {
    const r = this.bgRect();
    const mx = r.w * 0.04;
    return r.left + mx + (sx / FIELD_W) * (r.w - 2 * mx);
  }
  private mapY(sy: number): number {
    const r = this.bgRect();
    // Shallow vertical band around the ground line (rows give a little depth).
    return r.groundY + GROUND_NUDGE + (sy - CENTER_Y) * (r.h * 0.00028);
  }
  /** Vertical mapping for boss projectiles: unlike mapY's shallow ground band,
   *  this spans the full drop so a throw leaves the boss's perch and lands at the
   *  ground line (the boss is rendered up on the silo, out of mapY's range). */
  private mapProjY(sy: number): number {
    const r = this.bgRect();
    const perchY = r.top + this.perchFY * r.h;
    const groundLineY = r.groundY + GROUND_NUDGE;
    const t = (sy - BOSS_STRUCT_Y) / (CENTER_Y - BOSS_STRUCT_Y);
    return perchY + t * (groundLineY - perchY);
  }
  /** Horizontal sim→screen scale, for sizing projectiles in field units. */
  private scaleX(): number {
    const r = this.bgRect();
    return (r.w - r.w * 0.08) / FIELD_W;
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
      .rect(0, 0, W, r.groundY).fill(SKY_COLOR)
      .rect(0, r.groundY, W, Math.max(0, H - r.groundY)).fill(GRASS_COLOR);

    const toX = (sx: number) => this.mapX(sx);
    const toY = (sy: number) => this.mapY(sy);
    // Boss perch on the structure (computed), and its descent lerp back to the ground.
    const perchX = r.left + this.perchFX * r.w;
    const perchY = r.top + this.perchFY * r.h;
    const bossPos = (u: SimUnit): [number, number] => {
      if (u.state === "structure") return [perchX, perchY];
      const t = Math.max(0, Math.min(1, (BOSS_STRUCT_Y - u.y) / (BOSS_STRUCT_Y - CENTER_Y)));
      return [perchX + (toX(u.x) - perchX) * t, perchY + (toY(u.y) - perchY) * t];
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

      const slide = u.team === "player" ? -introSlide : 0;
      const drop = u.team === "player" ? PLAYER_NUDGE : 0; // zombies sit lower
      const [sx, sy] = u.isBoss ? bossPos(u) : [toX(u.x) + slide, toY(u.y) + drop];
      tok.root.position.set(sx, sy);
      tok.root.scale.set(1 + 0.16 * tok.pulse);
      tok.root.alpha = u.alive ? 1 : 0.18;
      tok.root.zIndex = u.isBoss ? 3 : u.alive ? 2 : 1;

      // Zombie rig: play the walk animation whenever it's actually moving, and
      // turn to face the way it's pacing (so waiting zombies mill back and forth).
      const windup = u.windupKey ? 1 - u.windupMs / Math.max(1, u.windupTotal) : 0;
      if (tok.actor) {
        const dxm = sx - tok.lastX;
        const moved = Math.hypot(dxm, sy - tok.lastY);
        if (Math.abs(dxm) > 0.5) tok.actor.setFacingFromDelta(dxm);
        tok.actor.update(dtSec, u.alive && moved > 0.3);
        tok.actor.setWindup(windup); // raises the arms while charging an activated move
      }
      tok.lastX = sx;
      tok.lastY = sy;

      const frac = Math.max(0, u.hp / u.maxHp);
      tok.hp.clear();
      if (u.alive) {
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
      const bob = Math.sin(this.phaseT / 260) * 3;
      this.bubble.position.set(bubTok.root.x + BUBBLE_DX, bubTok.root.y - (bubTok.base + 34) + bob);
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

    // Retreat button, top-left under the zombie health bar.
    this.retreatBtn.position.set(mx, H * 0.05 + barH + 10);

    // Ability strip, stacked under the retreat button. Activated badges show how
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
  private syncProjectiles() {
    const live = new Set<string>();
    const s = this.scaleX();
    for (const pr of this.sim.projectiles) {
      live.add(pr.id);
      let sp = this.projSprites.get(pr.id);
      if (!sp) {
        const tex = this.projTex.get(pr.sprite) ?? null;
        sp = new Sprite(tex ?? Texture.WHITE);
        sp.anchor.set(0.5);
        if (!tex) sp.tint = 0xffe08a; // fallback dot for a missing sprite
        this.projLayer.addChild(sp);
        this.projSprites.set(pr.id, sp);
      }
      const size = Math.max(10, pr.spriteSize * s * 1.2);
      sp.width = size;
      sp.height = size;
      sp.rotation = pr.rot;
      sp.position.set(this.mapX(pr.x), this.mapProjY(pr.y));
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
    bar.clear().roundRect(0, 0, w, h, 4).fill({ color: 0x000000, alpha: 0.5 });
    fill.clear();
    if (f > 0) fill.roundRect(0, 0, w * f, h, 4).fill(color);
  }

  /** Drive the scene forward. Called from the app ticker with seconds. */
  update(dtSec: number) {
    const dtMs = Math.min(dtSec * 1000, 50);
    this.phaseT += dtMs;
    for (const t of this.tokens.values()) t.pulse = Math.max(0, t.pulse - dtSec * 6);

    // Retreat is handled here (not in the tap handler) so nothing runs mid
    // event-dispatch on the button that triggered it.
    if (this.retreatRequested && !this.resultFired) {
      this.retreated = true;
      this.fireResult();
      this.phase = "done";
    }

    switch (this.phase) {
      case "intro":
        if (this.phaseT >= INTRO_MS) this.setPhase("fight");
        break;
      case "fight": {
        this.sim.step(dtMs);
        for (const u of this.sim.units) {
          if (u.struckThisTick) {
            const t = this.tokens.get(u.id);
            if (t) t.pulse = 1;
          }
        }
        if (this.sim.finished && this.phaseT >= END_PAUSE_MS) {
          this.setPhase(this.sim.playerWon ? "outro" : "defeat");
        } else if (!this.sim.finished) {
          this.phaseT = 0; // keep the end-pause clock fresh until the sim ends
        }
        break;
      }
      case "outro": {
        // Survivors march off to the right; the results panel slides in meanwhile.
        this.fireResult();
        for (const u of this.sim.units) {
          if (u.team === "player" && u.alive) u.x += (600 * dtMs) / 1000;
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
    this.onFinish(outcome);
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}

function sumMax(units: CombatUnit[]): number {
  return units.reduce((s, u) => s + u.maxHp, 0);
}
