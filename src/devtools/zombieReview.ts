// Zombie Review — a dev-only review harness for every assembled zombie rig.
// =========================================================================
// Served at /zombie-review.html by the dev server; not part of the production build.
//
// The point of this tool is FIDELITY, so it deliberately reuses the game's own code
// rather than reimplementing it (which is what tools/rig_studio.html has to do
// to stay double-clickable):
//
//   • loadAssets()  — the real atlas slicing, the real mutations.json, the real
//                     special-zombie model merge.
//   • RaidActor     — the same rig ZombieUnit assembles on the farm (same part
//                     composition, mutation replacement, back-arm mirroring, brute
//                     eyeballs, special head FX), plus the animation timelines
//                     recovered from ZFAnims/ZFAttackAnims.
//   • mutations.ts  — slot legality, the headless restriction, catalog masks.
//   • prefs         — displayedAppearance runs inside the rig, so the two display
//                     prefs change what you see here exactly as they do in game.
//
// If a zombie looks wrong here, it looks wrong in game.
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Text, type Ticker } from "pixi.js";
import { loadAssets, type GameAssets } from "../assets";
import { RaidActor } from "../raid/RaidActor";
import {
  MUTATION_LIST, SLOTS, SLOT_MASK, applyBodyTypeRestriction, bitAllowed,
  mutationBonus, statEffectsOf, type MutationDef, type Slot,
} from "../zombie/mutations";
import { maskHas, maskUnion, maskWithout } from "../zombie/mutationMask";
import { MUTATION_VARIANTS, mutationLabelFor } from "../zombie/mutationDisplay";
import { classify, CLASS_COLOR, type ZClass } from "../zombie/taxonomy";
import { zombieFarmScale, zombieRaidHeightScale } from "../zombie/displayScale";
import {
  getShowZombieMutations, setShowZombieMutations,
  getZombieBodyColorMode, setZombieBodyColorMode,
} from "../prefs";

// ---------------------------------------------------------------------------
// Constants mirrored from RaidScene, so raid sizing and the smash/heal timelines
// read the same here as they do mid-invasion.
// ---------------------------------------------------------------------------
const ZOMBIE_H = 91; // RaidScene's contain-fit target height
const RAID_MODEL_BASE = 0.95; // RaidActor's MODEL_BASE — the rig's own root scale
const SMASH_GROW = 0.4;
const SMASH_SLAM_S = 0.18;
const SMASH_CHARGE_S = 1.0;
const SMASH_REST_S = 0.5;
const HEAL_POSE_S = 0.7;
const HEAL_CYCLE_S = 1.6;
const WINDUP_CYCLE_S = 2.0;
const ATTACK_CYCLE_S = 1.2; // stands in for the sim's per-unit cooldownMs
const CELL_W = 148;
const CELL_H = 186;

type View = "single" | "sheet";
type Sizing = "farm" | "raid" | "native";
type Anim = "idle" | "walk" | "bite" | "scratch" | "windup" | "heal" | "smash" | "death";

const ANIMS: { id: Anim; label: string; title: string }[] = [
  { id: "idle", label: "Idle", title: "Waiting: head tilt, arms at ARM_REST" },
  { id: "walk", label: "Walk", title: "Advancing: leg step + arms forward with sway" },
  { id: "bite", label: "Bite", title: "ZombieBite (anim 8) — head/jaw/eyes/arms" },
  { id: "scratch", label: "Scratch", title: "ZombieScratch (anim 9) — asymmetric claw flail" },
  { id: "windup", label: "Wind-up", title: "Activated-move wind-up: arms overhead" },
  { id: "heal", label: "Heal", title: "Garden healer: rest → forward → overhead" },
  { id: "smash", label: "Smash", title: "Bash family: loom up while charging, slam on release" },
  { id: "death", label: "Death", title: "Head pops off and tumbles backward" },
];

/** One reviewable rig. Everything in zombies.json, plus any model in models.json the
 *  catalog doesn't list (those exist — reference rigs, unshipped variants — and a
 *  review tool that hid them would be lying about what the build can assemble). */
interface Entry {
  key: string;
  name: string;
  group: string;
  className: string;
  category: string;
  /** The mask this species carries in the catalog (Market mutants have one). */
  catalogMask: number;
  listed: boolean;
  headless: boolean;
}

/** A built rig on the stage. */
interface Cell {
  entry: Entry;
  actor: RaidActor;
  root: Container;
  /** Rig scale from the sizing mode, before the view zoom. */
  rigScale: number;
  /** Feet-on-origin offset for the final (rigScale × viewScale) size. */
  baseY: number;
  finalScale: number;
  /** Height in stage pixels at rigScale — what the sizing mode says it measures. */
  sizedHeight: number;
}

const state = {
  view: "single" as View,
  sizing: "farm" as Sizing,
  anim: "idle" as Anim,
  focus: false,
  faceRight: true,
  paused: false,
  speed: 1,
  // A pure VIEW multiplier — it never changes the relative sizes the sizing mode
  // reports, so a Small next to a Large still reads true at any zoom.
  zoomSingle: 3,
  zoomSheet: 1,
  mask: 0,
  /** Off = the contact sheet shows each species' own catalog mask instead. */
  sheetOverride: true,
  tintMode: "species" as "species" | "custom",
  tint: [0x8f, 0xbf, 0x6a] as [number, number, number],
  backdrop: "dark",
  guides: true,
  selected: "",
  filterText: "",
  filterGroup: "",
  filterClass: "",
};

let assets: GameAssets;
let app: Application;
let entries: Entry[] = [];
let cells: Cell[] = [];
let clock = 0;
/** Height of a plain Regular rig — raid sizing measures Headless against it. */
let regularNativeHeight = 1;
/** Contact-sheet scroll offset (≤ 0). The sheet is taller than any window. */
let scrollY = 0;

const world = new Container();
const backdropG = new Graphics();
const guidesG = new Graphics();
const stageEl = document.getElementById("stage") as HTMLDivElement;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
void (async function main() {
  app = new Application();
  await app.init({
    background: "#14171c",
    resizeTo: stageEl,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  app.ticker.maxFPS = 60;
  stageEl.appendChild(app.canvas);

  assets = await loadAssets();
  document.getElementById("boot")?.remove();

  entries = buildRoster();
  state.selected = entries[0]?.key ?? "";
  state.mask = entries[0]?.catalogMask ?? 0;
  regularNativeHeight = new RaidActor(assets, "ZombieActorRegularTier1", 0, "Regular")
    .getNativeSizingHeight();

  // backdropG is added to `world` by rebuild() — it scrolls with the sheet.
  app.stage.addChild(world, guidesG);
  wireControls();
  renderRoster();
  renderMutations();
  rebuild();
  drawBackdrop();

  app.ticker.add(tick);

  // Console handle. This page is a workbench, so give it the same reach the UI has:
  // poke a mask, force a rebuild, or read what a rig actually assembled to.
  (window as unknown as { zfReview: unknown }).zfReview = {
    app, assets, state, entries,
    cells: () => cells,
    rebuild,
    select,
    setMask: (mask: number) => { state.mask = mask; renderMutations(); rebuild(); },
    capture,
  };
})();

/** zombies.json first (that is the roster a player sees), then any model key the
 *  catalog doesn't mention, so nothing assemblable is invisible here. */
function buildRoster(): Entry[] {
  const listed: Entry[] = assets.zombies.map((z) => ({
    key: z.key,
    name: z.name,
    group: z.group,
    className: z.className,
    category: z.category,
    catalogMask: z.mutation ?? 0,
    listed: true,
    headless: z.group === "Headless",
  }));
  const seen = new Set(listed.map((e) => e.key));
  const extra: Entry[] = Object.keys(assets.zombieModels)
    .filter((key) => !seen.has(key))
    .map((key) => {
      const taxon = classify(key);
      return {
        key,
        name: assets.zombieModels[key].name || key.replace(/^ZombieActor/, ""),
        group: taxon.group,
        className: taxon.className,
        category: "unlisted",
        catalogMask: 0,
        listed: false,
        headless: taxon.group === "Headless",
      };
    });
  return [...listed, ...extra];
}

const entryOf = (key: string): Entry | undefined => entries.find((e) => e.key === key);

function visibleEntries(): Entry[] {
  const q = state.filterText.trim().toLowerCase();
  return entries.filter((e) =>
    (!q || e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q))
    && (!state.filterGroup || e.group === state.filterGroup)
    && (!state.filterClass || e.className === state.filterClass)
  );
}

// ---------------------------------------------------------------------------
// Rig construction
// ---------------------------------------------------------------------------

/** The mask a given entry should be BUILT with. Illegal bits are dropped through the
 *  game's own restriction so a headless zombie in the sheet never shows a head it
 *  cannot wear — the same call the Pot and the crop roll make. */
function maskFor(entry: Entry): number {
  const wanted = state.view === "sheet" && !state.sheetOverride
    ? entry.catalogMask
    : state.mask;
  return applyBodyTypeRestriction(wanted, entry.headless);
}

function colorFor(): [number, number, number] | undefined {
  // undefined = "no inherited tint", which is exactly what the model's catalog colour
  // is for. A custom tint stands in for a Zombie Pot child's mixed body colour.
  return state.tintMode === "custom" ? state.tint : undefined;
}

/** Rig scale for the current sizing mode.
 *
 *  RaidActor always builds itself at MODEL_BASE × model.scale, so "farm" divides that
 *  back out and re-applies zombieFarmScale — the farm rig's actual root scale — giving
 *  a true side-by-side of how big these things are on the farm. "raid" reproduces
 *  RaidScene's contain-fit, including the Headless height ratio. */
function rigScaleFor(entry: Entry, bounds: { height: number }, nativeHeight: number): number {
  const model = assets.zombieModels[entry.key];
  const built = RAID_MODEL_BASE * (model?.scale ?? 1);
  if (state.sizing === "native") return 1;
  if (state.sizing === "farm") {
    return zombieFarmScale(entry.group, entry.className, entry.key) / Math.max(0.001, built);
  }
  const heightScale = zombieRaidHeightScale(
    entry.group, entry.className, entry.key, nativeHeight, regularNativeHeight,
  );
  return (ZOMBIE_H * heightScale) / Math.max(1, bounds.height);
}

function makeCell(entry: Entry): Cell {
  const actor = new RaidActor(assets, entry.key, maskFor(entry), entry.group, colorFor());
  if (state.anim === "death") actor.markDead();
  const bounds = actor.getSizingBounds();
  const rigScale = rigScaleFor(entry, bounds, actor.getNativeSizingHeight());
  const root = new Container();
  root.addChild(actor.container);
  world.addChild(root);
  return {
    entry, actor, root, rigScale,
    baseY: -(bounds.y + bounds.height) * rigScale,
    finalScale: rigScale,
    sizedHeight: bounds.height * rigScale,
  };
}

/** Tear down and re-assemble every rig on the stage. Cheap (a rig is a few dozen
 *  sprites over shared atlas textures) and it is the only way to change a mask, a
 *  tint, or to un-kill a zombie — RaidActor bakes all three at construction. */
function rebuild() {
  for (const cell of cells) cell.root.destroy({ children: true });
  cells = [];
  world.removeChildren();
  // The backdrop rides INSIDE the scrolling world and spans the whole contact sheet,
  // not just the viewport — otherwise "Export PNG" (which frames the stage's full
  // bounds) would hand back a sheet that is dark for one screenful and transparent
  // for the remaining three thousand pixels.
  world.addChild(backdropG);

  if (state.view === "single") {
    const entry = entryOf(state.selected);
    if (entry) cells.push(makeCell(entry));
  } else {
    for (const entry of visibleEntries()) {
      const cell = makeCell(entry);
      const label = new Text({
        text: entry.name,
        style: { fontFamily: "system-ui, sans-serif", fontSize: 11, fill: 0x8b98a5 },
      });
      label.anchor.set(0.5, 0);
      label.y = 8;
      cell.root.addChild(label);
      cells.push(cell);
    }
  }
  layout();
  drawBackdrop();
  renderStatus();
}

/** Place the cells and pick the view scale. The contact sheet uses ONE scale for every
 *  rig (auto-fit to the tallest) so the grid stays an honest size comparison. */
function layout() {
  const w = app.renderer.width / app.renderer.resolution;
  const h = app.renderer.height / app.renderer.resolution;

  if (state.view === "single") {
    const cell = cells[0];
    if (!cell) return;
    scrollY = 0;
    world.position.set(0, 0);
    cell.finalScale = cell.rigScale * state.zoomSingle;
    cell.actor.container.scale.set(cell.finalScale);
    cell.actor.container.y = cell.baseY * state.zoomSingle;
    cell.root.position.set(w / 2, h * 0.72);
    return;
  }

  const cols = Math.max(1, Math.floor(w / CELL_W));
  const tallest = cells.reduce((max, c) => Math.max(max, c.sizedHeight), 1);
  const fit = ((CELL_H - 52) / tallest) * state.zoomSheet;
  cells.forEach((cell, i) => {
    cell.finalScale = cell.rigScale * fit;
    cell.actor.container.scale.set(cell.finalScale);
    cell.actor.container.y = cell.baseY * fit;
    const col = i % cols;
    const row = Math.floor(i / cols);
    cell.root.position.set(col * CELL_W + CELL_W / 2, row * CELL_H + CELL_H - 26);
  });
  clampScroll();
}

/** Sheet columns for the current canvas width — the one place the grid is derived,
 *  so layout, the guides and the click hit-test cannot disagree. */
function sheetColumns(): number {
  return Math.max(1, Math.floor((app.renderer.width / app.renderer.resolution) / CELL_W));
}

function clampScroll() {
  const viewH = app.renderer.height / app.renderer.resolution;
  const rows = Math.ceil(cells.length / sheetColumns());
  const content = rows * CELL_H;
  scrollY = clamp(scrollY, Math.min(0, viewH - content), 0);
  world.y = state.view === "sheet" ? scrollY : 0;
}

// ---------------------------------------------------------------------------
// Animation driver — the same inputs RaidScene feeds the actor each frame.
// ---------------------------------------------------------------------------
function tick(ticker: Ticker) {
  const dt = Math.min(0.05, ticker.deltaMS / 1000) * (state.paused ? 0 : state.speed);
  clock += dt;

  const w = app.renderer.width / app.renderer.resolution;
  const h = app.renderer.height / app.renderer.resolution;
  if (w !== lastW || h !== lastH) {
    lastW = w;
    lastH = h;
    layout();
    drawBackdrop();
  }

  const a = state.anim;
  const moving = a === "walk";
  const attacking = a === "bite" || a === "scratch";
  const attackName = a === "scratch" ? "ZombieScratch" : "ZombieBite";
  const atkProg = (clock % ATTACK_CYCLE_S) / ATTACK_CYCLE_S;

  // Wind-up rides a smooth 0→1→0 so the overhead pose can be read at every angle.
  const windup = a === "windup"
    ? 0.5 - 0.5 * Math.cos((2 * Math.PI * clock) / WINDUP_CYCLE_S)
    : 0;

  // Heal reproduces RaidScene's countdown: a 0.14s raise, a hold, then a 0.16s drop.
  let healRaise = 0;
  if (a === "heal") {
    const u = clock % HEAL_CYCLE_S;
    const healPose = u < HEAL_POSE_S ? HEAL_POSE_S - u : 0;
    const elapsed = HEAL_POSE_S - healPose;
    healRaise = healPose <= 0 ? 0
      : elapsed < 0.14 ? elapsed / 0.14
      : healPose < 0.16 ? healPose / 0.16
      : 1;
  }

  // Smash: charge (arms rise, body looms to 1.4×), release (slam + shrink), rest.
  let slamProg = -1;
  let smashWindup = 0;
  let grow = 1;
  if (a === "smash") {
    const u = clock % (SMASH_CHARGE_S + SMASH_SLAM_S + SMASH_REST_S);
    if (u < SMASH_CHARGE_S) {
      smashWindup = u / SMASH_CHARGE_S;
      grow = 1 + SMASH_GROW * smashWindup;
    } else if (u < SMASH_CHARGE_S + SMASH_SLAM_S) {
      slamProg = 1 - (u - SMASH_CHARGE_S) / SMASH_SLAM_S;
      grow = 1 + SMASH_GROW * slamProg;
    }
  }

  for (const cell of cells) {
    cell.actor.setFacingFromDelta(state.faceRight ? 1 : -1);
    // update() re-seats the head parts from their base positions; poseArms() then adds
    // its per-frame deltas on top. Same order as RaidScene — swapping them would make
    // the bite/scratch head thrust accumulate.
    cell.actor.update(dt, moving, state.focus);
    cell.actor.poseArms(
      Math.max(windup, smashWindup), attacking, moving, atkProg, 0, slamProg,
      healRaise, attackName,
    );
    // Feet-anchored grow, exactly as the raid does it.
    cell.actor.container.scale.set(cell.finalScale * grow);
    cell.actor.container.y = (cell.baseY * (cell.finalScale / cell.rigScale)) * grow;
  }

  // Guides track the rig's live bounds, so they alone are re-drawn per frame; the
  // backdrop only changes on a resize or a menu pick.
  drawGuides();
}

// ---------------------------------------------------------------------------
// Backdrop + guides
// ---------------------------------------------------------------------------
let lastW = 0;
let lastH = 0;

function drawBackdrop() {
  const w = app.renderer.width / app.renderer.resolution;
  const view = app.renderer.height / app.renderer.resolution;
  // Cover the whole sheet, not just what fits on screen (see rebuild()).
  const h = state.view === "sheet"
    ? Math.max(view, Math.ceil(cells.length / sheetColumns()) * CELL_H)
    : view;
  backdropG.clear();
  if (state.backdrop === "checker") {
    const s = 16;
    backdropG.rect(0, 0, w, h).fill(0x2a2f37);
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        if (((x / s) + (y / s)) % 2 === 0) backdropG.rect(x, y, s, s).fill(0x343a44);
      }
    }
    return;
  }
  const fill = state.backdrop === "light" ? 0xdfe6ee
    : state.backdrop === "grass" ? 0x67bb4e
    : 0x14171c;
  backdropG.rect(0, 0, w, h).fill(fill);
}

function drawGuides() {
  guidesG.clear();
  if (!state.guides) return;
  const line = state.backdrop === "light" ? 0x0f1720 : 0x58a6ff;

  if (state.view === "single") {
    const cell = cells[0];
    if (!cell) return;
    const w = app.renderer.width / app.renderer.resolution;
    const { x, y } = cell.root.position;
    guidesG.moveTo(0, y).lineTo(w, y).stroke({ width: 1, color: line, alpha: 0.35 });
    guidesG.moveTo(x, y - 12).lineTo(x, y + 12).stroke({ width: 1, color: line, alpha: 0.35 });
    const b = cell.actor.container.getBounds();
    guidesG.rect(b.x, b.y, b.width, b.height)
      .stroke({ width: 1, color: line, alpha: 0.28 });
    return;
  }
  // Sheet: a baseline per row and a box around the selection.
  const cols = sheetColumns();
  cells.forEach((cell, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * CELL_W;
    const y = row * CELL_H + scrollY;
    guidesG.moveTo(x + 12, y + CELL_H - 26).lineTo(x + CELL_W - 12, y + CELL_H - 26)
      .stroke({ width: 1, color: line, alpha: 0.16 });
    if (cell.entry.key === state.selected) {
      guidesG.rect(x + 2, y + 2, CELL_W - 4, CELL_H - 4)
        .stroke({ width: 1, color: 0x58a6ff, alpha: 0.8 });
    }
  });
}

// ---------------------------------------------------------------------------
// DOM: roster list
// ---------------------------------------------------------------------------
function renderRoster() {
  const list = document.getElementById("list")!;
  const shown = visibleEntries();
  list.innerHTML = "";
  for (const entry of shown) {
    const row = document.createElement("div");
    row.className = "item" + (entry.key === state.selected ? " sel" : "");
    const color = CLASS_COLOR[entry.className as ZClass] ?? "#8b98a5";
    row.innerHTML =
      `<span class="dot" style="background:${color}"></span>` +
      `<span class="nm">${escapeHtml(entry.name)}</span>` +
      (entry.catalogMask ? `<span class="tag">mut</span>` : "") +
      (entry.listed ? "" : `<span class="tag">unlisted</span>`);
    row.title = entry.key;
    row.onclick = () => select(entry.key);
    list.appendChild(row);
  }
  document.getElementById("listCount")!.textContent =
    `${shown.length} of ${entries.length} rigs`;
}

/** Show `key`. In single view the species' catalog mask is adopted, so a Market mutant
 *  opens as itself rather than as whatever the last selection wore. In the sheet it is
 *  NOT: the working mask is the thing the whole sheet is being reviewed under, and
 *  moving the cursor must not rewrite it. */
function select(key: string) {
  state.selected = key;
  const entry = entryOf(key);
  if (entry && state.view === "single") {
    state.mask = applyBodyTypeRestriction(entry.catalogMask, entry.headless);
  }
  renderRoster();
  renderMutations();
  if (state.view === "single") rebuild();
  else scrollToSelected();
}

/** Bring the selected cell fully into view (arrow-key navigation in the sheet). */
function scrollToSelected() {
  const index = cells.findIndex((cell) => cell.entry.key === state.selected);
  if (index < 0) return;
  const top = Math.floor(index / sheetColumns()) * CELL_H;
  const viewH = app.renderer.height / app.renderer.resolution;
  if (top + scrollY < 0) scrollY = -top;
  else if (top + CELL_H + scrollY > viewH) scrollY = viewH - top - CELL_H;
  clampScroll();
}

// ---------------------------------------------------------------------------
// DOM: mutation panel
// ---------------------------------------------------------------------------
const SLOT_LABEL: Record<Slot, string> = {
  head: "Head", hair_eye: "Hair / Eyes", arm: "Arms", body: "Body", neck: "Neck",
};

function renderMutations() {
  const host = document.getElementById("muts")!;
  const entry = entryOf(state.selected);
  const headless = entry?.headless ?? false;
  host.innerHTML = "";

  for (const slot of SLOTS) {
    const head = document.createElement("div");
    head.className = "slot";
    head.textContent = SLOT_LABEL[slot];
    host.appendChild(head);
    for (const def of MUTATION_LIST.filter((m) => m.slot === slot)) {
      host.appendChild(mutationRow(def, headless, entry?.key ?? ""));
    }
  }
  if (headless) {
    const note = document.createElement("div");
    note.className = "note";
    note.style.marginTop = "8px";
    note.textContent =
      "Headless: head and hair/eye mutations are refused — except Pumpking, the head " +
      "this family never had.";
    host.appendChild(note);
  }
  renderPrefWarning();
  renderStatus();
}

function mutationRow(def: MutationDef, headless: boolean, speciesKey: string): HTMLElement {
  const allowed = bitAllowed(def.bit, headless);
  const on = maskHas(state.mask, def.bit);
  const row = document.createElement("div");
  row.className = "mut" + (on ? " on" : "") + (allowed ? "" : " off");
  const stats = statEffectsOf(def)
    .map((e) => `${e.amount > 0 ? "+" : ""}${e.amount} ${e.stat.toUpperCase()}`)
    .join(" ");
  // Eyebiscus and Heartichoke are catalogued mutations of their own, so this table only
  // still matters for a LEGACY unit that has yet to shed the lower tier's bit it used
  // to ride (see variantMutations). While it holds one, listing the shared catalog name
  // would call a Heartichoke's body "Cauli-hair" — the name of neither the art on
  // screen nor the thing the game's own cards print.
  const variant = MUTATION_VARIANTS[speciesKey]?.[def.key];
  row.innerHTML =
    `<span class="box"></span><span class="nm">${escapeHtml(variant?.name ?? def.name)}</span>` +
    `<span class="st">${stats}</span>`;
  row.title = !allowed ? "this body type cannot wear it"
    : variant ? `bit ${def.bit} · ${def.key} — this species' variant of ${def.name}`
    : `bit ${def.bit} · ${def.key}`;
  if (allowed) {
    row.onclick = () => {
      // One mutation per slot: taking a new one evicts the slot's current occupant,
      // which is the same rule combineMasks enforces (just without the tier contest).
      state.mask = on
        ? maskWithout(state.mask, def.bit)
        : maskUnion(maskWithout(state.mask, SLOT_MASK[def.slot]), def.bit);
      renderMutations();
      rebuild();
    };
  }
  return row;
}

function renderPrefWarning() {
  const host = document.getElementById("prefWarn")!;
  host.innerHTML = "";
  if (getShowZombieMutations()) return;
  const box = document.createElement("div");
  box.className = "warn";
  box.innerHTML =
    "<b>Show mutations is OFF</b> in the game prefs, so every rig here draws unmutated " +
    "— displayedAppearance() zeroes the mask inside the actor.";
  const fix = document.createElement("button");
  fix.className = "mini";
  fix.textContent = "Turn it on";
  fix.onclick = () => {
    setShowZombieMutations(true);
    syncPrefButtons();
    renderMutations();
    rebuild();
  };
  box.appendChild(fix);
  host.appendChild(box);
}

// ---------------------------------------------------------------------------
// DOM: status line
// ---------------------------------------------------------------------------
function renderStatus() {
  const entry = entryOf(state.selected);
  const host = document.getElementById("status")!;
  if (!entry) { host.textContent = ""; return; }
  const model = assets.zombieModels[entry.key];
  const cell = cells.find((c) => c.entry.key === entry.key);
  const mask = maskFor(entry);
  const label = mutationLabelFor(entry.key, mask) || "none";
  const bonus = mutationBonus(mask, entry.key);
  const bonusText = `${bonus.str >= 0 ? "+" : ""}${bonus.str} str  ` +
    `${bonus.dex >= 0 ? "+" : ""}${bonus.dex} dex  ${bonus.con >= 0 ? "+" : ""}${bonus.con} con`;
  const parts = model ? model.parts.length : 0;
  const color = model
    ? `#${model.color.map((c) => c.toString(16).padStart(2, "0")).join("")}`
    : "—";
  host.innerHTML =
    `<b>${escapeHtml(entry.name)}</b>  ${entry.key}  · ${entry.group} / ${entry.className}` +
    ` / ${entry.category}${entry.listed ? "" : " (not in zombies.json)"}\n` +
    `mask ${mask}  <b>${escapeHtml(label)}</b>  [${bonusText}]\n` +
    `${parts} base parts · model.scale ${model?.scale ?? "—"} · species colour ${color}` +
    (cell
      ? ` · ${state.sizing} height ${cell.sizedHeight.toFixed(1)}px` +
        ` · drawn ×${cell.finalScale.toFixed(3)}`
      : "");
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function wireControls() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  // --- roster filters -------------------------------------------------------
  const search = $<HTMLInputElement>("search");
  search.oninput = () => { state.filterText = search.value; renderRoster(); if (state.view === "sheet") rebuild(); };

  const groupSel = $<HTMLSelectElement>("fGroup");
  const classSel = $<HTMLSelectElement>("fClass");
  fillSelect(groupSel, "All groups", unique(entries.map((e) => e.group)));
  fillSelect(classSel, "All classes", unique(entries.map((e) => e.className)));
  groupSel.onchange = () => { state.filterGroup = groupSel.value; renderRoster(); if (state.view === "sheet") rebuild(); };
  classSel.onchange = () => { state.filterClass = classSel.value; renderRoster(); if (state.view === "sheet") rebuild(); };

  // --- view -----------------------------------------------------------------
  const vSingle = $<HTMLButtonElement>("vSingle");
  const vSheet = $<HTMLButtonElement>("vSheet");
  const setView = (view: View) => {
    state.view = view;
    vSingle.classList.toggle("on", view === "single");
    vSheet.classList.toggle("on", view === "sheet");
    syncZoomSlider();
    rebuild();
  };
  vSingle.onclick = () => setView("single");
  vSheet.onclick = () => setView("sheet");
  setView("single");

  // --- animation ------------------------------------------------------------
  const anims = $<HTMLSpanElement>("anims");
  for (const a of ANIMS) {
    const button = document.createElement("button");
    button.className = "mini" + (a.id === state.anim ? " on" : "");
    button.textContent = a.label;
    button.title = a.title;
    button.onclick = () => {
      const wasDeath = state.anim === "death";
      state.anim = a.id;
      clock = 0;
      for (const child of anims.children) child.classList.remove("on");
      button.classList.add("on");
      // Rebuild rather than markAlive(): leaving death should show the rig as it
      // is BUILT, not as a revive restores it, since this board reviews the build.
      if (wasDeath || a.id === "death") rebuild();
    };
    anims.appendChild(button);
  }

  const focusBtn = $<HTMLButtonElement>("focus");
  focusBtn.onclick = () => {
    state.focus = !state.focus;
    focusBtn.classList.toggle("on", state.focus);
  };

  const flip = $<HTMLButtonElement>("flip");
  flip.onclick = () => {
    state.faceRight = !state.faceRight;
    flip.textContent = state.faceRight ? "Face ►" : "◄ Face";
  };

  const pause = $<HTMLButtonElement>("pause");
  pause.onclick = () => {
    state.paused = !state.paused;
    pause.classList.toggle("on", state.paused);
    pause.textContent = state.paused ? "Play" : "Pause";
  };

  $<HTMLButtonElement>("replay").onclick = () => { clock = 0; rebuild(); };

  $<HTMLButtonElement>("png").onclick = () => { void exportPng(); };

  // --- mutation buttons -----------------------------------------------------
  const headlessNow = () => entryOf(state.selected)?.headless ?? false;
  const afterMask = () => { renderMutations(); rebuild(); };
  $<HTMLButtonElement>("mClear").onclick = () => { state.mask = 0; afterMask(); };
  $<HTMLButtonElement>("mFill").onclick = () => {
    // Highest bit per slot = the best mutation the slot pays, because CATALOG is
    // append-only in tier order (see combineMasks).
    let mask = 0;
    for (const slot of SLOTS) {
      const best = [...MUTATION_LIST].reverse()
        .find((m) => m.slot === slot && bitAllowed(m.bit, headlessNow()));
      if (best) mask = maskUnion(mask, best.bit);
    }
    state.mask = mask;
    afterMask();
  };
  $<HTMLButtonElement>("mRandom").onclick = () => {
    let mask = 0;
    for (const slot of SLOTS) {
      const pool = MUTATION_LIST.filter((m) => m.slot === slot && bitAllowed(m.bit, headlessNow()));
      if (pool.length && Math.random() < 0.7) {
        mask = maskUnion(mask, pool[Math.floor(Math.random() * pool.length)].bit);
      }
    }
    state.mask = mask;
    afterMask();
  };
  $<HTMLButtonElement>("mReset").onclick = () => {
    const entry = entryOf(state.selected);
    state.mask = entry ? applyBodyTypeRestriction(entry.catalogMask, entry.headless) : 0;
    afterMask();
  };

  // --- display --------------------------------------------------------------
  const sizing = $<HTMLSelectElement>("sizing");
  sizing.value = state.sizing;
  sizing.onchange = () => { state.sizing = sizing.value as Sizing; rebuild(); };

  const zoom = $<HTMLInputElement>("zoom");
  zoom.oninput = () => {
    const value = Number(zoom.value);
    if (state.view === "single") state.zoomSingle = value; else state.zoomSheet = value;
    $<HTMLSpanElement>("zoomV").textContent = value.toFixed(2);
    layout();
    renderStatus();
  };

  const speed = $<HTMLInputElement>("speed");
  speed.oninput = () => {
    state.speed = Number(speed.value);
    $<HTMLSpanElement>("speedV").textContent = state.speed.toFixed(2);
  };

  const tintMode = $<HTMLSelectElement>("tintMode");
  const tint = $<HTMLInputElement>("tint");
  tintMode.onchange = () => { state.tintMode = tintMode.value as "species" | "custom"; rebuild(); };
  tint.oninput = () => {
    const hex = parseInt(tint.value.slice(1), 16);
    state.tint = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    if (state.tintMode === "custom") rebuild();
  };

  const backdrop = $<HTMLSelectElement>("backdrop");
  backdrop.onchange = () => { state.backdrop = backdrop.value; drawBackdrop(); };

  const guides = $<HTMLButtonElement>("guides");
  guides.onclick = () => {
    state.guides = !state.guides;
    guides.classList.toggle("on", state.guides);
  };

  // --- game prefs -----------------------------------------------------------
  $<HTMLButtonElement>("pMut").onclick = () => {
    setShowZombieMutations(!getShowZombieMutations());
    syncPrefButtons();
    renderMutations();
    rebuild();
  };
  $<HTMLButtonElement>("pColor").onclick = () => {
    setZombieBodyColorMode(getZombieBodyColorMode() === "species" ? "inherited" : "species");
    syncPrefButtons();
    rebuild();
  };
  syncPrefButtons();

  // --- stage interaction ----------------------------------------------------
  // Wheel: the sheet is ~3500px tall, so a bare wheel SCROLLS it and only a modified
  // wheel zooms. In single view there is nothing to scroll, so the wheel zooms.
  app.canvas.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    if (state.view === "sheet" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      scrollY -= e.deltaY;
      clampScroll();
      return;
    }
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (state.view === "single") {
      state.zoomSingle = clamp(state.zoomSingle * factor, 0.4, 6);
    } else {
      state.zoomSheet = clamp(state.zoomSheet * factor, 0.4, 6);
    }
    syncZoomSlider();
    layout();
    renderStatus();
  }, { passive: false });

  // Drag to scroll the sheet; a drag that barely moved is a click on a cell.
  let dragFrom: { y: number; scroll: number; moved: number } | null = null;
  app.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
    if (state.view !== "sheet") return;
    dragFrom = { y: e.clientY, scroll: scrollY, moved: 0 };
    app.canvas.setPointerCapture(e.pointerId);
  });
  app.canvas.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragFrom) return;
    const dy = e.clientY - dragFrom.y;
    dragFrom.moved = Math.max(dragFrom.moved, Math.abs(dy));
    scrollY = dragFrom.scroll + dy;
    clampScroll();
  });
  app.canvas.addEventListener("pointerup", (e: PointerEvent) => {
    if (!dragFrom) return;
    const dragged = dragFrom.moved > 4;
    dragFrom = null;
    if (dragged) return;
    const rect = app.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top - scrollY;
    const index = Math.floor(y / CELL_H) * sheetColumns() + Math.floor(x / CELL_W);
    const cell = x < sheetColumns() * CELL_W ? cells[index] : undefined;
    if (cell) {
      // Selecting inside the sheet must NOT adopt the species' catalog mask — that
      // would silently rewrite the mask the whole sheet is being reviewed under.
      state.selected = cell.entry.key;
      renderRoster();
      renderMutations();
    }
  });

  // Sheet-only toggle for whether the working mask applies to every rig.
  const sheetToggle = document.createElement("button");
  sheetToggle.className = "mini on";
  sheetToggle.textContent = "Mask → sheet";
  sheetToggle.title =
    "On: every rig in the contact sheet wears the mask above (minus what its body " +
    "cannot hold). Off: each wears its own catalog mask.";
  sheetToggle.onclick = () => {
    state.sheetOverride = !state.sheetOverride;
    sheetToggle.classList.toggle("on", state.sheetOverride);
    if (state.view === "sheet") rebuild();
  };
  document.querySelector("#app .col.right .pad .wrap")!.appendChild(sheetToggle);

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const shown = visibleEntries();
    const at = shown.findIndex((entry) => entry.key === state.selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = shown[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) select(next.key);
    } else if (e.key === " ") {
      e.preventDefault();
      pause.click();
    }
  });

  syncZoomSlider();
}

function syncZoomSlider() {
  const zoom = document.getElementById("zoom") as HTMLInputElement;
  const value = state.view === "single" ? state.zoomSingle : state.zoomSheet;
  zoom.value = String(value);
  document.getElementById("zoomV")!.textContent = value.toFixed(2);
}

function syncPrefButtons() {
  const mut = document.getElementById("pMut") as HTMLButtonElement;
  const color = document.getElementById("pColor") as HTMLButtonElement;
  const showing = getShowZombieMutations();
  mut.classList.toggle("on", showing);
  mut.textContent = showing ? "Mutations: on" : "Mutations: off";
  const mode = getZombieBodyColorMode();
  color.classList.toggle("on", mode === "inherited");
  color.textContent = mode === "inherited" ? "Colour: inherited" : "Colour: species";
  color.title = mode === "species"
    ? "Species mode ignores a custom tint — every zombie wears its own species colour."
    : "Inherited mode honours the custom tint (a Zombie Pot child's mixed body colour).";
}

/**
 * Write a tight shot of one rig (or the whole stage) to tmp/review-shots/<name>.png via
 * the dev server's /__capture endpoint — no download dialog, so an art pass can take
 * fifty before/after shots without fifty save prompts. Console-only, dev-only.
 */
async function capture(name?: string, key?: string): Promise<string> {
  const cell = key ? cells.find((c) => c.entry.key === key) : cells[0];
  const target = state.view === "single" && cell ? cell.actor.container : app.stage;
  const dataUrl = await app.renderer.extract.base64({ target, format: "png" });
  const response = await fetch("/__capture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name ?? cell?.entry.key ?? "stage", dataUrl }),
  });
  const result = await response.json() as { ok: boolean; file?: string; error?: string };
  if (!result.ok) throw new Error(result.error);
  return result.file ?? "";
}

async function exportPng() {
  const source = await app.renderer.extract.base64({ target: app.stage, format: "png" });
  const link = document.createElement("a");
  link.href = source;
  link.download = state.view === "sheet"
    ? "zombie-contact-sheet.png"
    : `${state.selected || "zombie"}-${state.mask}.png`;
  link.click();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function fillSelect(select: HTMLSelectElement, allLabel: string, values: string[]) {
  select.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

const unique = (values: string[]): string[] => [...new Set(values)].sort();

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
}
