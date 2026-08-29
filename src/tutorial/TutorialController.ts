// The Tim Buckwheat guided tutorial — a first-run presentation layer
// that leads the player through the core farm loop (plow → plant → speed up →
// harvest → invade). It COEXISTS with the quest engine: it subscribes
// to the same QuestBus and polls live state, and never mutates gameplay systems.
//
// Faithful to the original iOS binary's TutorialManager (a gflags state machine
// with slide-up Tim popups + a pulsing arrow + input gating). See steps.ts for the
// decoded dialogue and the tutorial-ground-truth memory for the RE provenance.
import { BASE } from "../base";
import { GameState } from "../GameState";
import { Field } from "../Field";
import { ZombieField } from "../zombie/ZombieField";
import { Hud } from "../hud";
import { QuestBus, QuestEvent } from "../quest/events";
import { TutorialSave } from "../save/schema";
import {
  nextTutorialStep, recoverTutorialCropStep, recoverTutorialInvadeStep, STEPS, StepDef,
  TutStep, TUTORIAL_GROW_BOOST_KEY, tutorialBoostPurchaseAllowed, tutorialStepNeedsTarget,
} from "./steps";

const ARROW_SIZE = 27;
const ARROW_MENU_GAP = 6;
const ARROW_PLOT_GAP = 24;

const SKIP_LABEL = "Skip tutorial";
const SKIP_CONFIRM_LABEL = "Tap again to skip";
const SKIP_CONFIRM_MS = 4000;

/** The Insta-Grow boost key (mirrors GROW_BOOST_KEY in main.ts). */
const GROW_BOOST_KEY = TUTORIAL_GROW_BOOST_KEY;

export interface TutorialDeps {
  hud: Hud;
  state: GameState;
  field: Field;
  zombies: ZombieField;
  questBus: QuestBus;
  /** Screen-pixel center of a plot origin (world → global projection). */
  plotScreenPos: (col: number, row: number) => { x: number; y: number };
  /** Find a suitable tutorial plot without mutating the field. */
  findTutorialPlot: (preferExisting?: boolean) => { col: number; row: number } | null;
  /** Whether a live raid currently owns the screen (hide the overlay then). */
  isRaidActive: () => boolean;
  /** Apply the visible bonus and, online, enqueue its one-time semantic grant. */
  grantCompletionBonus?: () => void;
  /** Confirm the planted tutorial zombie before exposing a dependent power use. */
  settlePlant?: () => Promise<void>;
}

export class TutorialController {
  private d: TutorialDeps;
  active = false;
  private current: TutStep = TutStep.Welcome;
  /** The plot targeted by the plow/plant/ripen/harvest beats (plot origin). */
  private plotTarget: { col: number; row: number } | null = null;
  private unsubBus: (() => void) | null = null;
  private raf = 0;
  private settlingPlant = false;
  /** OpenGuide beat: the player has had the Farmer's Guide open this beat. The
   *  beat completes when the guide CLOSES again, so Tim's farewell (and the gold)
   *  waits until they are back on the farm rather than popping over the pages. */
  private guideSeen = false;

  // DOM
  private layer!: HTMLDivElement;
  private tim!: HTMLDivElement;
  private timSprite!: HTMLImageElement;
  private bubble!: HTMLDivElement;
  private arrow!: HTMLImageElement;
  private skip!: HTMLButtonElement;
  private blocker: HTMLDivElement | null = null;
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
    this.plotTarget = this.d.findTutorialPlot();
    // Persist immediately so the tutorial survives a reload mid-Welcome: once a
    // save exists, load() reports restored=true, and only a saved {done:false}
    // record (not an absent one) tells restore() to resume vs. stay inert.
    this.persist(TutStep.Welcome, false);
    this.begin(TutStep.Welcome);
  }

  /** Restore from a save: stay inert if done, else re-enter the saved beat. */
  restore(save: TutorialSave | undefined) {
    if (!save || save.done) return; // never started or finished
    this.plotTarget = save.target ?? this.d.findTutorialPlot(
      save.step !== TutStep.Welcome && save.step !== TutStep.Plow
    );
    // Saves from the previous tutorial used 6/7 for post-raid narrative beats.
    // Resume those at the final message. Older saves did not persist a target; if
    // their client-only starter soil vanished during server reconciliation, restart
    // at the real plow step rather than leaving the player stuck on bare ground.
    let step = save.step === 6 || save.step === 7 ? TutStep.Done : save.step as TutStep;
    // A step this build does not know (a save from a future/edited build) would crash
    // enterStep on an undefined beat. Start over rather than mount a broken overlay.
    if (!STEPS[step]) step = TutStep.Welcome;
    // A beat that needs a target but has none can reach nothing; Plow needs none, so
    // land there instead of mounting the overlay on a frozen screen.
    if (!this.plotTarget && tutorialStepNeedsTarget(step)) step = TutStep.Plow;
    if (step === TutStep.PlantZombie && this.plotTarget &&
        !this.d.field.canPlant(this.plotTarget.col, this.plotTarget.row)) {
      step = TutStep.Plow;
    } else if (this.plotTarget) {
      step = recoverTutorialCropStep(
        step,
        this.d.field.hasCrop(this.plotTarget.col, this.plotTarget.row),
        this.d.field.canPlant(this.plotTarget.col, this.plotTarget.row),
        this.d.field.isRipe(this.plotTarget.col, this.plotTarget.row)
      );
    }
    this.persist(step, false);
    this.begin(step);
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
    this.d.state.setTutorial({ done, step, target: this.plotTarget ?? undefined });
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
    if (!this.active) { this.plotTarget = this.d.findTutorialPlot(); this.begin(step); return; }
    this.advanceTo(step);
  }
  /** Wipe persisted tutorial progress (so a reload replays it). */
  clearPersisted() {
    if (this.active) this.dispose();
    this.d.state.setTutorial(undefined);
  }

  // ---- world input gate (consulted by main's pointerdown handler) ----

  /** True when farm taps on (col,row) should be allowed. Only the current beat's
   *  target plot is tappable; every other farm tap (and all taps during menu /
   *  narrative beats) is frozen. */
  allowsTile(col: number, row: number): boolean {
    if (!this.active) return false;
    const def = STEPS[this.current];
    if (def.kind !== "plot") return false;
    if (this.current === TutStep.Plow) {
      return this.d.field.resolveTill(col, row).valid;
    }
    if (!this.plotTarget) return false;
    const at = this.d.field.plotOriginAt(col, row);
    return !!at && at.oc === this.plotTarget.col && at.or === this.plotTarget.row;
  }

  /** True when a plant tap here should open the Zombie-locked plant menu. */
  wantsLockedPlant(col: number, row: number): boolean {
    return this.active && this.current === TutStep.PlantZombie && this.allowsTile(col, row);
  }

  /** The JobSystem supplies the exact freely chosen origin after a successful plow. */
  onPlotPlowed(oc: number, or: number) {
    if (!this.active || this.current !== TutStep.Plow) return;
    this.plotTarget = { col: oc, row: or };
    this.advance();
  }

  allowsBoostPurchase(key: string): boolean {
    return tutorialBoostPurchaseAllowed(this.active, this.current, key);
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
    this.guideSeen = false;
    this.layer.classList.toggle("invade-step", step === TutStep.Invade);
    // Only a narrative beat wants a clickable bubble; on every other beat Tim floats
    // above the boost market and must not intercept taps meant for it.
    this.layer.classList.toggle("narrative-step", def.kind === "narrative");
    this.layer.classList.remove("invasion-menu-open");
    // The boost market deliberately has no close button, so leaving its beat for ANY
    // reason — including recoverTutorialCropStep's skip when the crop ripened on its
    // own — has to take the panel with it, or the player is left holding a panel
    // nothing can dismiss.
    if (step !== TutStep.BuyInstaGrow) this.d.hud.closeMarket();
    this.d.hud.setTutorialMenuTarget(def.kind === "menu" ? (def.menuLabel ?? null) : null);

    // Menu beats need the (mobile) menu column visible to anchor the arrow —
    // except Invade, whose target is the fixed bottom-left shortcut, not a menu
    // button, so expanding buys nothing (and used to leave portrait phones in the
    // chrome-expanded state that hid that very shortcut).
    if (def.kind === "menu" && def.menuLabel !== "Invade" && this.d.hud.isCollapsed) {
      this.d.hud.expand();
    }
    // Each plot beat equips the tool its target expects.
    if (step === TutStep.Plow && this.d.hud.mode !== "till") this.d.hud.setMode("till");
    if (step === TutStep.PlantZombie && this.d.hud.mode !== "walk") this.d.hud.setMode("walk");
    if (step === TutStep.RipenCrop) this.equipInstaGrow();
    if (step === TutStep.Harvest) this.d.hud.setMode("walk");

    this.showBubble(def);
    this.arrow.style.display = (def.kind === "plot" && step !== TutStep.Plow) || def.kind === "menu" ? "block" : "none";

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

  private equipInstaGrow() {
    // setMode toggles; only switch in if not already equipped.
    if (this.d.hud.mode !== "instagrow") this.d.hud.setMode("instagrow");
  }

  // ---- event-driven advancement (single lifetime subscription) ----

  private onEvent(nid: string, object: string) {
    if (!this.active) return;
    switch (this.current) {
      case TutStep.Plow:
        // JobSystem.onPlotPlowed owns this transition because it carries the freely
        // chosen coordinates needed by the following planting step.
        break;
      case TutStep.PlantZombie:
        if (nid === QuestEvent.CropPlanted && object.toLowerCase() === "zombie")
          this.confirmPlantThenAdvance();
        break;
      case TutStep.Harvest:
        if (nid === QuestEvent.ZombieHarvested) this.advance();
        break;
      case TutStep.Invade:
        if (nid === QuestEvent.InvasionSuccessful) this.advance();
        break;
      default:
        break;
    }
  }

  /** A power use depends on the planted crop already existing server-side. Await
   * the shared ordered command lane before letting the tutorial buy/use the power,
   * otherwise an earlier plant projection can overwrite the optimistic ripening. */
  private confirmPlantThenAdvance() {
    if (this.settlingPlant) return;
    const settle = this.d.settlePlant;
    if (!settle) { this.advance(); return; }
    this.settlingPlant = true;
    void settle()
      .then(() => {
        if (this.active && this.current === TutStep.PlantZombie) this.advance();
      })
      .catch(() => { /* the economy client surfaces its own unavailable state */ })
      .finally(() => { this.settlingPlant = false; });
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
    // Likewise, the open Farmer's Guide owns the screen: Tim steps aside while
    // the player reads (the arrow already hides itself behind any .panelbg).
    const guideOpen =
      this.current === TutStep.OpenGuide && !!document.querySelector("#hud .guide-bg");
    this.layer.classList.toggle("guide-open", guideOpen);

    // A plot beat with no target reaches NOTHING: allowsTile() refuses every tile and
    // a plot beat highlights no menu, so the overlay would sit there with the whole
    // game frozen behind it (and the freeze is persisted, so a reload does not help).
    if (!this.ensurePlotTarget()) return;
    // Losing the army during the invasion beat is the other dead end — every farm tap
    // is gated, so the player could never grow a replacement zombie to invade with.
    const afterInvade = recoverTutorialInvadeStep(this.current, this.hasArmy(), this.canPlantTarget());
    if (afterInvade !== this.current) { this.advanceTo(afterInvade); return; }

    // If an old client-only tutorial plot disappears when authoritative farm state
    // arrives, rewind to the earliest real action the surviving state supports.
    if (!this.settlingPlant && this.plotTarget && this.current === TutStep.PlantZombie &&
        !this.d.field.canPlant(this.plotTarget.col, this.plotTarget.row)) {
      this.advanceTo(TutStep.Plow);
      return;
    }
    if (this.plotTarget) {
      const recovered = recoverTutorialCropStep(
        this.current,
        this.d.field.hasCrop(this.plotTarget.col, this.plotTarget.row),
        this.d.field.canPlant(this.plotTarget.col, this.plotTarget.row),
        this.d.field.isRipe(this.plotTarget.col, this.plotTarget.row)
      );
      if (recovered !== this.current) { this.advanceTo(recovered); return; }
    }

    // Poll the beats that have no game event to listen to.
    switch (this.current) {
      case TutStep.BuyInstaGrow:
        if (this.d.state.boostCount(GROW_BOOST_KEY) >= 1) {
          this.d.hud.closeMarket();
          this.advance();
          return;
        }
        break;
      case TutStep.RipenCrop:
        if (this.plotTarget && this.d.field.isRipe(this.plotTarget.col, this.plotTarget.row)) {
          this.advance(); return;
        }
        break;
      case TutStep.OpenGuide:
        // Complete once the guide has been opened AND closed again, so the
        // farewell (and its gold) greets the player back on the farm instead of
        // popping up over the pages they were sent to read.
        if (guideOpen) {
          // The highlighted Guide button sits at z 41, above the guide's own
          // backdrop (20) — drop the glow while the panel is open. No restore
          // needed: closing the guide is what completes the beat.
          if (!this.guideSeen) this.d.hud.setTutorialMenuTarget(null);
          this.guideSeen = true;
        } else if (this.guideSeen) { this.advance(); return; }
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

  private canPlantTarget(): boolean {
    return !!this.plotTarget && this.d.field.canPlant(this.plotTarget.col, this.plotTarget.row);
  }

  /**
   * Guarantee the current beat has something to point at. Returns false when it
   * rewound (the caller should stop this frame).
   *
   * Plow is exempt: it accepts any tillable ground, so it is the safe landing spot
   * whenever no target can be found at all.
   */
  private ensurePlotTarget(): boolean {
    if (!tutorialStepNeedsTarget(this.current) || this.plotTarget) return true;
    this.plotTarget = this.d.findTutorialPlot(true);
    if (this.plotTarget) {
      this.persist(this.current, false);
      return true;
    }
    this.advanceTo(TutStep.Plow);
    return false;
  }

  private positionArrow() {
    const def = STEPS[this.current];
    if (this.current === TutStep.Plow) { this.arrow.style.display = "none"; return; }
    const menuLabel = def.kind === "menu" ? def.menuLabel : undefined;
    if (def.kind !== "plot" && !menuLabel) { this.arrow.style.display = "none"; return; }
    // A large panel (market/storage/plant/raid) is open: the arrow's target is
    // behind it, so hide the arrow rather than let it float over the panel.
    if (document.querySelector("#hud .mkt-bg, #hud .st-bg, #hud .pm-bg, #hud .panelbg")) {
      this.arrow.style.display = "none";
      return;
    }
    this.arrow.style.display = "block";
    if (menuLabel) {
      const btn = this.d.hud.tutorialTarget(menuLabel);
      if (!btn) { this.arrow.style.display = "none"; return; }
      const r = btn.getBoundingClientRect();
      if (r.left >= ARROW_SIZE + ARROW_MENU_GAP) {
        // Sit just left of the button, pointing right (arrow_right.png is 0°).
        this.arrow.style.left = `${r.left - ARROW_SIZE - ARROW_MENU_GAP}px`;
        this.arrow.style.top = `${r.top + r.height / 2 - ARROW_SIZE / 2}px`;
        this.arrow.style.transform = "rotate(0deg)";
      } else {
        // No room on the left — the Invade shortcut hugs the screen edge, which
        // used to push this arrow off-screen entirely. Sit above, pointing down.
        this.arrow.style.left = `${r.left + r.width / 2 - ARROW_SIZE / 2}px`;
        this.arrow.style.top = `${r.top - ARROW_SIZE - ARROW_MENU_GAP}px`;
        this.arrow.style.transform = "rotate(90deg)";
      }
    } else if (def.kind === "plot" && this.plotTarget) {
      const p = this.d.plotScreenPos(this.plotTarget.col, this.plotTarget.row);
      // Sit above the plot, pointing down (rotate the right-arrow 90°).
      this.arrow.style.left = `${p.x - ARROW_SIZE / 2}px`;
      this.arrow.style.top = `${p.y - ARROW_SIZE - ARROW_PLOT_GAP}px`;
      this.arrow.style.transform = "rotate(90deg)";
    }
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
    this.persist(TutStep.Done, true);
    this.dispose();
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

  // ---- input blocker (narrative beats) ----

  private addBlocker(def: StepDef) {
    this.removeBlocker();
    const b = document.createElement("div");
    b.className = "tut-blocker";
    // Narrative beats advance on any tap.
    if (def.kind === "narrative") b.onclick = () => this.advance();
    // Insert the blocker BELOW Tim so the bubble/buttons stay clickable.
    this.layer.insertBefore(b, this.tim);
    this.blocker = b;
    // The bubble itself also advances narrative beats when tapped.
    if (def.kind === "narrative") this.bubble.onclick = () => this.advance();
    else this.bubble.onclick = null;
  }

  private removeBlocker() {
    this.blocker?.remove();
    this.blocker = null;
    this.bubble.onclick = null;
  }
}
