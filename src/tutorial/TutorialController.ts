// The Tim Buckwheat guided tutorial — a first-run presentation layer
// that leads the player through the core farm loop (plant → speed up → harvest →
// invade → veteran → combiner). It COEXISTS with the quest engine: it subscribes
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
import { veterancyLevel } from "../zombie/traits";
import { TutorialSave } from "../save/schema";
import { STEPS, StepDef, TutStep } from "./steps";

/** The Insta-Grow boost key (mirrors GROW_BOOST_KEY in main.ts). */
const GROW_BOOST_KEY = "insta_grow";

export interface TutorialDeps {
  hud: Hud;
  state: GameState;
  field: Field;
  zombies: ZombieField;
  questBus: QuestBus;
  /** Screen-pixel center of a plot origin (world → global projection). */
  plotScreenPos: (col: number, row: number) => { x: number; y: number };
  /** Pre-plow the tutorial's target plot near the farmer; returns its origin. */
  plowTutorialPlot: () => { col: number; row: number } | null;
  /** Whether a live raid currently owns the screen (hide the overlay then). */
  isRaidActive: () => boolean;
  /** Gift a free Zombie Pot (the combiner is 500g + level 3, unattainable in a
   *  fresh run, so the tutorial's "Yes" choice gives one as a reward). */
  grantZombiePot: () => void;
}

export class TutorialController {
  private d: TutorialDeps;
  active = false;
  private current: TutStep = TutStep.Welcome;
  /** The pre-plowed plot the plant/ripen/harvest beats target (plot origin). */
  private plotTarget: { col: number; row: number } | null = null;
  private unsubBus: (() => void) | null = null;
  private raf = 0;

  // DOM
  private layer!: HTMLDivElement;
  private tim!: HTMLDivElement;
  private timSprite!: HTMLImageElement;
  private bubble!: HTMLDivElement;
  private arrow!: HTMLImageElement;
  private blocker: HTMLDivElement | null = null;

  constructor(deps: TutorialDeps) {
    this.d = deps;
    this.buildDom();
  }

  // ---- lifecycle ----

  /** Begin the tutorial on a brand-new farm. */
  start() {
    if (this.active) return;
    this.plotTarget = this.d.plowTutorialPlot();
    // Persist immediately so the tutorial survives a reload mid-Welcome: once a
    // save exists, load() reports restored=true, and only a saved {done:false}
    // record (not an absent one) tells restore() to resume vs. stay inert.
    this.persist(TutStep.Welcome, false);
    this.begin(TutStep.Welcome);
  }

  /** Restore from a save: stay inert if done, else re-enter the saved beat. */
  restore(save: TutorialSave | undefined) {
    if (!save || save.done) return; // never started or finished
    // Re-establish the target plot for the mid-tutorial plant/ripen/harvest beats.
    this.plotTarget = this.d.plowTutorialPlot();
    this.begin(save.step as TutStep);
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
    this.d.state.addGold(200);
    this.persist(TutStep.Done, true);
    this.dispose();
  }

  private dispose() {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
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
    if (!this.active) { this.plotTarget = this.d.plowTutorialPlot(); this.begin(step); return; }
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
    if (!this.active || !this.plotTarget) return false;
    const def = STEPS[this.current];
    if (def.kind !== "plot") return false;
    const at = this.d.field.plotOriginAt(col, row);
    return !!at && at.oc === this.plotTarget.col && at.or === this.plotTarget.row;
  }

  /** True when a plant tap here should open the Zombie-locked plant menu. */
  wantsLockedPlant(col: number, row: number): boolean {
    return this.active && this.current === TutStep.PlantZombie && this.allowsTile(col, row);
  }

  /** Called by main right after a raid resolves back on the farm — the Invade beat
   *  advances on the InvasionSuccessful event, but this is a belt-and-braces nudge
   *  in case the roster confirms veterancy without the event matching. */
  onRaidResolved() {
    if (this.active && this.current === TutStep.Invade && this.anyVeteran()) {
      this.advanceTo(TutStep.Veteran);
    }
  }

  // ---- step entry ----

  private enterStep(step: TutStep) {
    this.current = step;
    const def = STEPS[step];
    this.removeBlocker();

    // Menu beats need the (mobile) menu column visible to anchor the arrow.
    if (def.kind === "menu" && this.d.hud.isCollapsed) this.d.hud.expand();
    // The harvest beat needs the plain select tool so a tap harvests the crop;
    // the ripen beat equips the Insta-Grow tool so a tap ripens it.
    if (step === TutStep.RipenCrop) this.equipInstaGrow();
    if (step === TutStep.Harvest) this.d.hud.setMode("walk");

    this.showBubble(def);
    this.arrow.style.display = def.kind === "plot" || def.kind === "menu" ? "block" : "none";

    // Narrative + choice beats gate everything behind a tap blocker.
    if (def.kind === "narrative" || def.kind === "choice") this.addBlocker(def);
  }

  private advanceTo(step: TutStep) {
    this.persist(step, false);
    this.enterStep(step);
  }

  private advance() {
    const next = (this.current + 1) as TutStep;
    if (next > TutStep.Done) { this.finish(); return; }
    if (this.current === TutStep.Done) { this.finish(); return; }
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
      case TutStep.PlantZombie:
        if (nid === QuestEvent.CropPlanted && object.toLowerCase() === "zombie") this.advance();
        break;
      case TutStep.Harvest:
        if (nid === QuestEvent.ZombieHarvested) this.advance();
        break;
      case TutStep.Invade:
        if (nid === QuestEvent.InvasionSuccessful) this.advanceTo(TutStep.Veteran);
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

    // Poll the beats that have no game event to listen to.
    switch (this.current) {
      case TutStep.BuyInstaGrow:
        if (this.d.state.boostCount(GROW_BOOST_KEY) >= 1) { this.advance(); return; }
        break;
      case TutStep.RipenCrop:
        if (this.plotTarget && this.d.field.isRipe(this.plotTarget.col, this.plotTarget.row)) {
          this.advance(); return;
        }
        break;
      default:
        break;
    }
    this.positionArrow();
  };

  private positionArrow() {
    const def = STEPS[this.current];
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
      const btn = this.d.hud.menuButton(menuLabel);
      if (!btn) { this.arrow.style.display = "none"; return; }
      const r = btn.getBoundingClientRect();
      // Sit just left of the button, pointing right (arrow_right.png is 0°).
      this.arrow.style.left = `${r.left - 60}px`;
      this.arrow.style.top = `${r.top + r.height / 2 - 27}px`;
      this.arrow.style.transform = "rotate(0deg)";
    } else if (def.kind === "plot" && this.plotTarget) {
      const p = this.d.plotScreenPos(this.plotTarget.col, this.plotTarget.row);
      // Sit above the plot, pointing down (rotate the right-arrow 90°).
      this.arrow.style.left = `${p.x - 27}px`;
      this.arrow.style.top = `${p.y - 78}px`;
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

    layer.append(tim, arrow);
    this.layer = layer;
    this.tim = tim;
    this.timSprite = sprite;
    this.bubble = bubble;
    this.arrow = arrow;
  }

  private showBubble(def: StepDef) {
    this.timSprite.src = `${BASE}assets/tutorial/${def.art === "veteran" ? "veteran" : "farmer"}.png`;
    this.bubble.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = def.say;
    this.bubble.appendChild(text);

    if (def.kind === "choice" && def.choices) {
      const row = document.createElement("div");
      row.className = "tut-choice";
      const yes = document.createElement("button");
      yes.className = "tc-yes";
      yes.textContent = def.choices[0];
      yes.onclick = (e) => { e.stopPropagation(); this.onChoosePot(true); };
      const no = document.createElement("button");
      no.className = "tc-no";
      no.textContent = def.choices[1];
      no.onclick = (e) => { e.stopPropagation(); this.onChoosePot(false); };
      row.append(yes, no);
      this.bubble.appendChild(row);
    } else if (def.hint) {
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

  private onChoosePot(yes: boolean) {
    // "Yes" gifts a free Zombie Pot (it's 500g + level 3 — unattainable in a
    // fresh run, so we reward it rather than gate completion on a purchase).
    // Either choice then finishes the tutorial.
    if (yes) this.d.grantZombiePot();
    this.advance(); // -> Done
  }

  // ---- input blocker (narrative/choice beats) ----

  private addBlocker(def: StepDef) {
    this.removeBlocker();
    const b = document.createElement("div");
    b.className = "tut-blocker";
    // Narrative beats advance on any tap; choice beats wait for a button.
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

  // ---- helpers ----

  private anyVeteran(): boolean {
    return this.d.zombies.roster().some((z) => veterancyLevel(z.invasions) >= 1);
  }
}
