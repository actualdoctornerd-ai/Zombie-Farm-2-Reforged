// The guided tutorial's boost market is a full-viewport backdrop with no close
// button, no backdrop dismiss and no Escape (see TutorialController / hud.openMarket):
// whatever it covers is unreachable, and the beat is persisted, so a reload lands the
// player right back on it. That made a pure stacking mistake fatal — the purchase
// confirm mounted UNDER the panel, so the Buy button could be neither seen nor
// tapped, and the tutorial layer sat under it too, burying the "Skip tutorial"
// escape hatch. Every new player hit it at the Insta-Grow step.
//
// These are the stacking invariants that keep that beat completable. They are read
// from the stylesheet because the bug was invisible to the step-logic tests: nothing
// about the state machine was wrong.
import { describe, expect, it } from "vitest";
// The stylesheet has to be read as text: vitest stubs every CSS import to an empty
// module (including `?raw`), and the app has no @types/node to declare this built-in
// — it only ever runs in a browser. The node test environment provides it at runtime.
// @ts-ignore
import { readFileSync } from "node:fs";

const css: string = readFileSync(new URL("./hud.css", import.meta.url), "utf8");

/** The z-index declared by the rule whose selector list matches `selector` exactly. */
function zIndexOf(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (!rule) throw new Error(`no rule found for selector: ${selector}`);
  const z = /z-index:\s*(-?\d+)/.exec(rule[2]);
  if (!z) throw new Error(`rule has no z-index: ${selector}`);
  return Number(z[1]);
}

describe("tutorial stacking order", () => {
  const market = zIndexOf("#hud.tutorial .mkt-bg.tut-market");
  const layer = zIndexOf("#hud .tut-layer");
  const dialogs = zIndexOf("#hud.tutorial .game-confirm-bg, #hud.tutorial .info-bg");

  // Tapping the Insta-Grow card opens a "Buy Insta-Grow?" confirm. Underneath the
  // panel it is unclickable, so the purchase — the beat's only exit — can never
  // complete.
  it("puts the purchase confirm above the boost market", () => {
    expect(dialogs).toBeGreaterThan(market);
  });

  // The skip button's own z-index (43) is ordered INSIDE the layer's stacking
  // context, so only the layer's value can lift it clear of the panel.
  it("keeps the tutorial layer (Tim, arrow, skip hatch) above the boost market", () => {
    expect(layer).toBeGreaterThan(market);
  });

  // Tim is bottom-left and the confirm is centered, but on a small screen they
  // overlap: the dialog must win, or its buttons are covered in turn.
  it("puts the confirm above Tim as well", () => {
    expect(dialogs).toBeGreaterThan(layer);
  });

  // The layer is pointer-events:none and its children opt in. Tim opts in only on
  // narrative beats now that he floats over the panel — otherwise he would swallow
  // taps aimed at the card behind him.
  it("only makes Tim's bubble clickable on narrative beats", () => {
    expect(/#hud \.tut-tim \{[^}]*pointer-events:\s*none/m.test(css)).toBe(true);
    expect(css).toContain("#hud .tut-layer.narrative-step .tut-bubble { pointer-events: auto; }");
  });

  // `.tutorial` stays on #hud through the tutorial's own Invade raid. The rule that
  // shows the compact tool button during the tutorial ties the raid hide-list on
  // specificity and comes later in the file, so without the `:not(.raiding)` guard it
  // wins and paints the button over the battle scene's Retreat button (same corner
  // on phones). Pinned as text because the cascade is the whole bug.
  it("hides the tutorial's tool button once the tutorial raid is on screen", () => {
    expect(css).toContain("#hud.tutorial:not(.raiding) .fab { display: block !important; }");
    expect(css).not.toMatch(/^#hud\.tutorial \.fab \{ display: block/m);
  });
});
