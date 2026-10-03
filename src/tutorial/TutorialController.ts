// The Tim Buckwheat guided tutorial — a first-run presentation layer that leads the
// player through the core loop: plant a zombie and a carrot beside it, grow them (Tim
// spends the two Insta-Grows a new farm starts with), harvest the mutated zombie, re-plow
// its hole, win the first invasion, buy a Daisy, learn Life Force, and tour the side buttons. It COEXISTS
// with the quest engine: it subscribes to the same QuestBus and polls live state, and
// never mutates gameplay systems — the one thing it does for the player is the
// Insta-Grow, which goes through the same path as a tap on the tool.
//
// Faithful in spirit to the original iOS binary's TutorialManager (slide-up Tim popups
// + a pulsing arrow + input gating). See steps.ts for the dialogue and the flow.
import { BASE } from "../base";
import { GameState } from "../GameState";
import { Field } from "../Field";
import { ZombieField } from "../zombie/ZombieField";
import { Hud } from "../hud";
import { QuestBus, QuestEvent } from "../quest/events";
import { TutorialSave } from "../save/schema";
import { TUTORIAL_CARROT_PLOT, TUTORIAL_ZOMBIE_PLOT, type TutorialPlot } from "./freshFarm";
import {
  migrateTutorialSave, nextTutorialStep, recoverTutorialCropStep, STEPS, StepDef, TutStep,
  TUTORIAL_CARROT_KEY, TUTORIAL_FLOWER_KEY, TUTORIAL_LOST_TIP, TUTORIAL_ZOMBIE_KEY,
  tutorialInvadeLost, tutorialPlotFor, type TutorialFarmView,
} from "./steps";

const ARROW_SIZE = 27;
const ARROW_GAP = 6;
const ARROW_PLOT_GAP = 24;

/** The right-hand menu buttons the tour walks down, top to bottom. */
const SIDE_BUTTONS = ["Zombies", "Boosts", "Storage", "Market", "Social", "Guide"];

/** A press counts as a tap if it is this quick and moves less than this. */
const TAP_MAX_MS = 500;
const TAP_MAX_MOVE_PX = 10;
/** Things a tap on must not also advance Tim: the skip button, his own bubble (which
 *  advances itself) and the popups a beat can trigger (Quest Complete, Level Up, ...). */
const TAP_IGNORED = ".tut-skip, .tut-bubble, .qc-bg, .lvl-bg, .game-confirm-bg, .info-bg, .tim-notice-bg";

const SKIP_LABEL = "Skip tutorial";
const SKIP_CONFIRM_LABEL = "Tap again to skip";
const SKIP_CONFIRM_MS = 4000;

/** Tim's word when the farm cannot give him two Insta-Grows to spend. */
const SLOW_GROWERS_TIP =
  "Looks like these two are slow growers.\nGive 'em a few minutes, then harvest 'em yerself!";

export interface TutorialDeps {
  hud: Hud;
  state: GameState;
  field: Field;
  zombies: ZombieField;
  questBus: QuestBus;
  /** Screen-pixel center of a plot origin (world → global projection). */
  plotScreenPos: (col: number, row: number) => { x: number; y: number };
  /** Whether a live raid currently owns the screen (hide the overlay then). */
  isRaidActive: () => boolean;
  /** Apply the visible bonus and, online, enqueue its one-time semantic grant. */
  grantCompletionBonus?: () => void;
  /** Confirm the planted crops before the Insta-Grows that depend on them. */
  settlePlant?: () => Promise<void>;
  /** Spend one Insta-Grow on the crop at this plot, exactly as tapping it would.
   *  Returns false when there was nothing to grow or nothing to spend. */
  speedUpPlot: (oc: number, or: number) => boolean;
}

export class TutorialController {
  private d: TutorialDeps;
  active = false;
  private current: TutStep = TutStep.Welcome;
  private unsubBus: (() => void) | null = null;
  private raf = 0;
  /** Grow beat: Tim is mid-way through speeding the crops up (awaiting the plant sync). */
  private growing = false;
  // DOM
  private layer!: HTMLDivElement;
  private tim!: HTMLDivElement;
  private timSprite!: HTMLImageElement;
  private bubble!: HTMLDivElement;
  private arrow!: HTMLImageElement;
  private skip!: HTMLButtonElement;
  /** Removes the narrative beat's tap listeners. */
  private stopTapListener: (() => void) | null = null;
  /** The skip button asks once before it ends the run. */
  private skipArmed = false;
  private skipDisarm = 0;

  constructor(deps: TutorialDeps) {
    this.d = deps;
    this.buildDom();
  }

  // ---- lifecycle ----

  /** Begin the tutorial on a brand-new farm. */
  start() {
    if (this.active) return;
    // The farm starts with the four plowed plots. A farm that somehow has not got them
    // (an account made before the starting plots existed) cannot run these beats, and a
    // frozen overlay is worse than no tutorial — so it is closed out, once.
    const view = this.farmView();
    if (!view.zombie.canPlant || !view.carrot.canPlant) { this.endQuietly(); return; }
    // Persist immediately so the tutorial survives a reload mid-Welcome: only a saved
    // {done:false} record (not an absent one) tells restore() to resume vs. stay inert.
    this.persist(TutStep.Welcome, false);
    this.begin(TutStep.Welcome);
  }

  /** Restore from a save: stay inert if done, else re-enter the saved beat. */
  restore(save: TutorialSave | undefined) {
    const migrated = migrateTutorialSave(save);
    // A save from the previous tutorial is closed out rather than resumed (see
    // migrateTutorialSave); the closed record is written back so it stays closed.
    if (migrated !== save && migrated) this.persist(migrated.step as TutStep, migrated.done);
    if (!migrated || migrated.done) return; // never started or finished
    let step = migrated.step as TutStep;
    if (!STEPS[step]) step = TutStep.Welcome;
    const recovered = recoverTutorialCropStep(step, this.farmView());
    if (recovered === null) { this.endQuietly(); return; }
    this.persist(recovered, false);
    this.begin(recovered);
  }

  private begin(step: TutStep) {
    this.active = true;
    this.d.hud.mountTutorial(this.layer);
    this.d.hud.setTutorialGating(true);
    this.layer.style.display = "block";
    // One bus subscription for the whole run; the handler dispatches on the step.
    this.unsubBus = this.d.questBus.subscribe((nid, object) => this.onEvent(nid, object));
    this.enterStep(step);
    this.tick(); // start the reposition/poll loop
  }

  /** Grant the completion bonus and finish. */
  private finish() {
    if (this.d.grantCompletionBonus) this.d.grantCompletionBonus();
    else this.d.state.addGold(200);
    this.persist(TutStep.Done, true);
    this.dispose();
  }

  /** Reconcile an already-rewarded tutorial without granting the bonus again. This
   * can arrive after restore when a pre-reload completion command finishes. */
  completeFromAuthority() {
    this.persist(TutStep.Done, true);
    if (this.active) this.dispose();
  }

  /** End the run without the bonus (the reward is for finishing it) and hand the farm
   *  back. Used whenever the tutorial cannot continue and must not leave a frozen game. */
  private endQuietly() {
    this.persist(TutStep.Done, true);
    if (this.active) this.dispose();
  }

  private dispose() {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.disarmSkip();
    this.unsubBus?.();
    this.unsubBus = null;
    this.removeBlocker();
    this.d.hud.setTutorialGating(false);
    this.layer.remove();
  }

  private persist(step: TutStep, done: boolean) {
    this.d.state.setTutorial({ done, step });
  }

  // ---- dev hooks (window.ZF.tut) ----

  /** Clear persisted state and replay from the top. */
  restart() {
    if (this.active) this.dispose();
    this.d.state.setTutorial(undefined);
    this.start();
  }
  /** Jump the overlay to a given beat (loose — doesn't force game preconditions). */
  jumpTo(step: TutStep) {
    if (!this.active) { this.begin(step); return; }
    this.advanceTo(step);
  }
  /** Wipe persisted tutorial progress (so a reload replays it). */
  clearPersisted() {
    if (this.active) this.dispose();
    this.d.state.setTutorial(undefined);
  }

  // ---- world input gate (consulted by main's pointerdown handler) ----

  /** True when farm taps on (col,row) should be allowed. Only the current beat's
   *  target plot is tappable (and, while the Daisy is armed, any open ground); every
   *  other farm tap — and all taps during menu / narrative beats — is frozen. */
  allowsTile(col: number, row: number): boolean {
    if (!this.active) return false;
    const def = STEPS[this.current];
    if (def.kind === "place") return this.d.hud.placing?.key === TUTORIAL_FLOWER_KEY;
    if (def.kind !== "plot") return false;
    const target = tutorialPlotFor(this.current);
    if (!target) return false;
    const at = this.d.field.plotOriginAt(col, row);
    return !!at && at.oc === target.oc && at.or === target.or;
  }

  /** The one plantable the plant menu may offer on this tap, or null for an ordinary
   *  (unlocked) menu. Both plant beats lock the picker to their own target. */
  lockedPlantKey(col: number, row: number): string | null {
    if (!this.active || !this.allowsTile(col, row)) return null;
    if (this.current === TutStep.PlantZombie) return TUTORIAL_ZOMBIE_KEY;
    if (this.current === TutStep.PlantCarrot) return TUTORIAL_CARROT_KEY;
    return null;
  }

  /** On the tutorial's Invade beat, i.e. the player is about to fight the first fight. */
  get inFirstFight(): boolean {
    return this.active && this.current === TutStep.Invade;
  }

  /** Whether the zombie being harvested right now is the tutorial's, which always takes
   *  the mutation of the crop beside it. OFFLINE only: online the Worker owns the roll
   *  (v3/engine rewardHarvest) and grants the same guarantee. */
  guaranteesMutation(): boolean {
    return this.active && this.current === TutStep.Harvest;
  }

  /** No boost can be bought while the tutorial runs: the Market it opens is scripted. */
  allowsBoostPurchase(): boolean {
    return !this.active;
  }

  /** Called by main right after a raid resolves back on the farm. */
  onRaidResolved() {
    if (this.active && this.current === TutStep.Invade &&
        this.d.zombies.roster().some((z) => z.invasions >= 1)) {
      this.advance();
    }
  }

  // ---- step entry ----

  private enterStep(step: TutStep) {
    this.current = step;
    const def = STEPS[step];
    this.removeBlocker();
    this.disarmSkip(); // a half-tapped skip must not carry into the next beat
    this.growing = false;
    this.layer.classList.toggle("invade-step", step === TutStep.Invade);
    // Only a narrative beat wants a clickable bubble; on every other beat Tim floats
    // above the market and must not intercept taps meant for it.
    this.layer.classList.toggle("narrative-step", def.kind === "narrative");
    this.layer.classList.remove("invasion-menu-open");
    // The scripted Market has no close button, so leaving its beat for ANY reason has
    // to take the panel with it, or the player is left holding one nothing can dismiss.
    if (step !== TutStep.Market) this.d.hud.closeMarket();
    // A beat that is not placing must not leave the Daisy armed.
    if (step !== TutStep.PlaceFlower && this.d.hud.placing?.key === TUTORIAL_FLOWER_KEY) {
      this.d.hud.setPlacing(null);
    }
    this.d.hud.setTutorialMenuTarget(def.kind === "menu" ? (def.pointAt ?? null) : null);
    // A tour stop for a button this build does not have (Social, offline) is skipped.
    if (def.pointAt && SIDE_BUTTONS.includes(def.pointAt) && !this.d.hud.tutorialTarget(def.pointAt)) {
      this.advance();
      return;
    }

    // Menu beats need the (mobile) menu column visible to anchor the arrow — except
    // Invade, whose target is the fixed bottom-left shortcut, not a menu button, so
    // expanding buys nothing (and used to leave portrait phones in the chrome-expanded
    // state that hid that very shortcut).
    if ((def.kind === "menu" || (def.pointAt && SIDE_BUTTONS.includes(def.pointAt))) &&
        def.pointAt !== "Invade" && this.d.hud.isCollapsed) {
      this.d.hud.expand();
    }
    // The tools tuck into the corner button; a beat that points at it needs it showing.
    if (def.pointAt === "Tools" && !this.d.hud.isCollapsed) this.d.hud.collapse();
    // Each plot beat equips the tool its target expects: the select tool opens the plant
    // picker, and a leftover "keep planting" mode would plant the wrong crop outright.
    if ((step === TutStep.PlantZombie || step === TutStep.PlantCarrot || step === TutStep.Grow ||
         step === TutStep.Harvest || step === TutStep.Plow) && this.d.hud.mode !== "walk") {
      this.d.hud.setMode("walk");
    }

    this.showBubble(def);
    this.arrow.style.display = def.kind === "plot" || def.pointAt ? "block" : "none";

    if (def.kind === "narrative") this.addBlocker(def);
  }

  private advanceTo(step: TutStep) {
    this.persist(step, false);
    this.enterStep(step);
  }

  private advance() {
    const next = nextTutorialStep(this.current);
    if (next === null) { this.finish(); return; }
    this.advanceTo(next);
  }

  // ---- the Grow beat ----

  /** A tap on a narrative beat. Every one just continues, except Grow, where the tap is
   *  Tim's cue to spend the Insta-Grows. */
  private onNarrativeTap() {
    if (this.current === TutStep.Grow) void this.runGrow();
    else this.advance();
  }

  /** Tim speeds both crops up. The planted crops must exist server-side first, or an
   *  earlier plant projection can overwrite the optimistic ripening — so wait for the
   *  shared command lane to settle, then spend one Insta-Grow per crop. */
  private async runGrow() {
    if (this.growing) return;
    this.growing = true;
    try { await this.d.settlePlant?.(); } catch { /* the economy client surfaces its own state */ }
    if (!this.active || this.current !== TutStep.Grow) { this.growing = false; return; }
    for (const plot of [TUTORIAL_ZOMBIE_PLOT, TUTORIAL_CARROT_PLOT]) {
      if (!this.d.field.isRipe(plot.oc, plot.or)) this.d.speedUpPlot(plot.oc, plot.or);
    }
    this.growing = false;
    const view = this.farmView();
    if (view.zombie.ripe && view.carrot.ripe) { this.advance(); return; }
    // Nothing left to spend (or the crops were refused): say so and let them play.
    void this.d.hud.timSays(SLOW_GROWERS_TIP);
    this.endQuietly();
  }

  // ---- event-driven advancement (single lifetime subscription) ----

  private onEvent(nid: string, object: string) {
    if (!this.active) return;
    const name = object.toLowerCase();
    switch (this.current) {
      case TutStep.PlantZombie:
        if (nid === QuestEvent.CropPlanted && name === "zombie") this.advance();
        break;
      case TutStep.PlantCarrot:
        if (nid === QuestEvent.CropPlanted && name === "carrot") this.advance();
        break;
      case TutStep.Harvest:
        if (nid === QuestEvent.ZombieHarvested) this.advance();
        break;
      case TutStep.Invade:
        if (nid === QuestEvent.InvasionSuccessful) this.advance();
        break;
      case TutStep.PlaceFlower:
        if (nid === QuestEvent.ItemBought && name === "daisy") this.advance();
        break;
      default:
        break;
    }
  }

  // ---- poll-driven advancement + arrow reposition (rAF loop) ----

  private tick = () => {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this.tick);
    // Hide the whole overlay while a live raid owns the screen.
    if (this.d.isRaidActive()) { this.layer.style.display = "none"; return; }
    if (this.layer.style.display === "none") this.layer.style.display = "block";
    // Tim moves aside to expose the farm's Invade shortcut, but once that shortcut
    // opens raid select (and later army select), the panel owns the instructions
    // and Tim must not cover its Start Invasion control.
    this.layer.classList.toggle(
      "invasion-menu-open",
      this.current === TutStep.Invade &&
        !!document.querySelector("#hud .raid-bg, #hud .army-bg")
    );
    // Keep the crop beats honest against the live farm: a crop the server refused, a
    // ripening it has not confirmed, a plot that is gone. Null means the tutorial has
    // lost something it cannot continue without — hand the farm back.
    const recovered = recoverTutorialCropStep(this.current, this.farmView());
    if (recovered === null) { this.endQuietly(); return; }
    if (recovered !== this.current && !this.growing) { this.advanceTo(recovered); return; }

    // The fight is the one beat that cannot be retried: lose the only zombie and every
    // farm tap and menu but Invade is gated, so there would be nothing left to do.
    if (tutorialInvadeLost(this.current, this.hasArmy())) {
      void this.d.hud.timSays(TUTORIAL_LOST_TIP);
      this.endQuietly();
      return;
    }

    // Poll the beats that have no game event to listen to.
    switch (this.current) {
      case TutStep.Market:
        // The Daisy card arms placement and closes the Market: that is the buy.
        if (this.d.hud.placing?.key === TUTORIAL_FLOWER_KEY) { this.advance(); return; }
        break;
      case TutStep.PlaceFlower:
        // Placement was cancelled (Escape / right click) before the Daisy went down:
        // back to the Market so there is a way to arm it again.
        if (this.d.hud.placing?.key !== TUTORIAL_FLOWER_KEY) { this.advanceTo(TutStep.Market); return; }
        break;
      default:
        break;
    }
    this.positionArrow();
  };

  /** Whether the player holds a zombie that could actually be sent on an invasion.
   *  A stored (Mausoleum) unit does not count — deploying it needs the Zombies menu,
   *  which the invasion beat's input gate keeps out of reach. */
  private hasArmy(): boolean {
    return this.d.zombies.roster().some((zombie) => !zombie.stored);
  }

  /** What the farm shows about the two tutorial plots. */
  private farmView(): TutorialFarmView {
    const view = (p: TutorialPlot) => {
      const exists = !!this.d.field.plotOriginAt(p.oc, p.or);
      return {
        exists,
        canPlant: exists && this.d.field.canPlant(p.oc, p.or),
        hasCrop: exists && this.d.field.hasCrop(p.oc, p.or),
        ripe: exists && this.d.field.isRipe(p.oc, p.or),
      };
    };
    return { zombie: view(TUTORIAL_ZOMBIE_PLOT), carrot: view(TUTORIAL_CARROT_PLOT) };
  }

  // ---- arrow ----

  private positionArrow() {
    const def = STEPS[this.current];
    const label = def.pointAt;
    if (def.kind !== "plot" && !label) { this.arrow.style.display = "none"; return; }
    // A large panel (market/storage/plant/raid) is open: the arrow's target is
    // behind it, so hide the arrow rather than let it float over the panel.
    if (document.querySelector("#hud .mkt-bg, #hud .st-bg, #hud .pm-bg, #hud .panelbg")) {
      this.arrow.style.display = "none";
      return;
    }
    this.arrow.style.display = "block";
    if (label) {
      const target = this.d.hud.tutorialTarget(label);
      if (!target || target.getClientRects().length === 0) { this.arrow.style.display = "none"; return; }
      const r = target.getBoundingClientRect();
      if (def.arrowSide === "below") {
        // Sit under the target, pointing up (the top bar has no room above it).
        this.placeArrow(r.left + r.width / 2 - ARROW_SIZE / 2, r.bottom + ARROW_GAP, -90);
      } else if (def.arrowSide === "above") {
        this.placeArrow(r.left + r.width / 2 - ARROW_SIZE / 2, r.top - ARROW_SIZE - ARROW_GAP, 90);
      } else if (r.left >= ARROW_SIZE + ARROW_GAP) {
        // Just left of the target, pointing right (arrow_right.png is 0°).
        this.placeArrow(r.left - ARROW_SIZE - ARROW_GAP, r.top + r.height / 2 - ARROW_SIZE / 2, 0);
      } else {
        // No room on the left — the Invade shortcut hugs the screen edge, which used to
        // push this arrow off-screen entirely. Sit above, pointing down.
        this.placeArrow(r.left + r.width / 2 - ARROW_SIZE / 2, r.top - ARROW_SIZE - ARROW_GAP, 90);
      }
      return;
    }
    const plot = tutorialPlotFor(this.current);
    if (plot) {
      const p = this.d.plotScreenPos(plot.oc, plot.or);
      // Sit above the plot, pointing down (rotate the right-arrow 90°).
      this.placeArrow(p.x - ARROW_SIZE / 2, p.y - ARROW_SIZE - ARROW_PLOT_GAP, 90);
    }
  }

  private placeArrow(left: number, top: number, degrees: number) {
    this.arrow.style.left = `${left}px`;
    this.arrow.style.top = `${top}px`;
    this.arrow.style.transform = `rotate(${degrees}deg)`;
  }

  // ---- DOM construction ----

  private buildDom() {
    const layer = document.createElement("div");
    layer.className = "tut-layer";
    layer.style.display = "none";

    const tim = document.createElement("div");
    tim.className = "tut-tim";
    const sprite = document.createElement("img");
    sprite.className = "tut-tim-sprite";
    const bubble = document.createElement("div");
    bubble.className = "tut-bubble";
    tim.append(sprite, bubble);

    const arrow = document.createElement("img");
    arrow.className = "tut-arrow";
    arrow.src = `${BASE}assets/ui/market/arrow_right.png`;
    arrow.style.display = "none";

    // The escape hatch. Every beat gates all farm input down to one target, so any
    // state the beat cannot detect leaves the player with a frozen game and no way
    // out — and the beat is persisted, so reloading does not clear it. Two taps
    // (the second confirms) end the run. Skipping forfeits the completion bonus,
    // which is why it is not one tap.
    const skip = document.createElement("button");
    skip.className = "tut-skip";
    skip.type = "button";
    skip.textContent = SKIP_LABEL;
    skip.onclick = (e) => { e.stopPropagation(); this.onSkipTapped(); };

    layer.append(tim, arrow, skip);
    this.layer = layer;
    this.tim = tim;
    this.timSprite = sprite;
    this.bubble = bubble;
    this.arrow = arrow;
    this.skip = skip;
  }

  /** First tap arms and re-labels; a second within the window ends the tutorial. */
  private onSkipTapped() {
    if (this.skipDisarm) { clearTimeout(this.skipDisarm); this.skipDisarm = 0; }
    if (!this.skipArmed) {
      this.skipArmed = true;
      this.skip.textContent = SKIP_CONFIRM_LABEL;
      this.skip.classList.add("armed");
      this.skipDisarm = window.setTimeout(() => this.disarmSkip(), SKIP_CONFIRM_MS);
      return;
    }
    this.disarmSkip();
    // Persist as done WITHOUT the completion bonus: the bonus is the reward for
    // finishing, and a one-tap 200 gold would be an exploit. dispose() releases the
    // input gate, so the farm is fully playable again immediately.
    this.endQuietly();
  }

  private disarmSkip() {
    if (this.skipDisarm) { clearTimeout(this.skipDisarm); this.skipDisarm = 0; }
    this.skipArmed = false;
    this.skip.textContent = SKIP_LABEL;
    this.skip.classList.remove("armed");
  }

  private showBubble(def: StepDef) {
    this.timSprite.src = `${BASE}assets/tutorial/farmer.png`;
    this.bubble.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = def.say;
    this.bubble.appendChild(text);

    if (def.hint) {
      const hint = document.createElement("span");
      hint.className = "tut-hint";
      hint.textContent = def.hint;
      this.bubble.appendChild(hint);
    }

    // Slide up (retrigger the transition on each step).
    this.tim.classList.remove("in");
    // Force reflow so the transition replays, then add .in on the next frame.
    void this.tim.offsetWidth;
    requestAnimationFrame(() => this.tim.classList.add("in"));
  }

  // ---- tap to continue (narrative beats) ----

  /** Narrative beats continue on any tap. This used to be a full-screen overlay that
   *  swallowed every pointer event, which also stopped the player moving the camera. It is
   *  now a listener: a quick press that barely moved counts as a tap, while a drag falls
   *  through to the farm and pans it (the farm's own input gate freezes everything else). */
  private addBlocker(def: StepDef) {
    this.removeBlocker();
    // The bubble itself also advances narrative beats when tapped.
    if (def.kind !== "narrative") { this.bubble.onclick = null; return; }
    this.bubble.onclick = () => this.onNarrativeTap();
    let down: { id: number; x: number; y: number; at: number } | null = null;
    const ignored = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest(TAP_IGNORED);
    const onDown = (e: PointerEvent) => {
      down = ignored(e.target) ? null : { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
    };
    const onUp = (e: PointerEvent) => {
      const press = down;
      down = null;
      if (!press || press.id !== e.pointerId || ignored(e.target)) return;
      const quick = e.timeStamp - press.at < TAP_MAX_MS;
      const still = Math.hypot(e.clientX - press.x, e.clientY - press.y) < TAP_MAX_MOVE_PX;
      if (quick && still) this.onNarrativeTap();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    this.stopTapListener = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
    };
  }

  private removeBlocker() {
    this.stopTapListener?.();
    this.stopTapListener = null;
    this.bubble.onclick = null;
  }
}
