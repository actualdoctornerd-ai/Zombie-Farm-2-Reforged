// The shed appearance picker is raised from INSIDE the Storage panel, and the
// Storage panel lifts itself above the shared modal layer — so a picker inheriting
// `.panelbg` mounts underneath the panel that opened it. It renders perfectly and is
// never seen: the button appears to do nothing at all.
//
// Exactly the failure the Brain Ticket hit from the Army screen (invasionLayering),
// and the reason that test exists. Same shape, same fix, same guard.
//
// Read from the stylesheet, like its neighbours: nothing about the panel logic is
// wrong, the bug is entirely in the paint order.
import { describe, expect, it } from "vitest";
// The stylesheet has to be read as text: vitest stubs every CSS import to an empty
// module (including `?raw`), and the app has no @types/node to declare this built-in.
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

describe("shed appearance picker stacking order", () => {
  const shared = zIndexOf("#hud .panelbg");
  const storage = zIndexOf("#hud .st-bg");
  const picker = zIndexOf("#hud .shed-skin-bg");

  it("puts the picker above the Storage panel that raises it", () => {
    expect(picker).toBeGreaterThan(storage);
  });

  it("does not leave the picker on the shared modal layer", () => {
    expect(picker).toBeGreaterThan(shared);
  });

  it("stays below the confirms and interruptions that must outrank a panel", () => {
    expect(picker).toBeLessThan(zIndexOf("#hud .game-confirm-bg"));
    expect(picker).toBeLessThan(zIndexOf("#hud .writer-lock-bg"));
    expect(picker).toBeLessThan(zIndexOf("#hud .fullscreen-prompt-bg"));
  });
});
