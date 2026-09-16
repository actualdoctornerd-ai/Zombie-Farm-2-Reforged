// A notification dot is absolutely positioned, so it lands relative to the nearest
// POSITIONED ancestor — and if its host isn't one, it silently flies off to the
// corner of whatever is (here: the fixed `#hud`, i.e. the corner of the screen). The
// dot still renders, nothing throws, and it is simply in the wrong place; that is the
// only way this feature can break, and it breaks by being added to a new host.
//
// So the rule is read out of the stylesheet, the way the layering tests next door
// read theirs: every element setBadge is called on must anchor its own dot.
import { describe, expect, it } from "vitest";
// The stylesheet has to be read as text: vitest stubs every CSS import to an empty
// module (including `?raw`), and the app has no @types/node to declare this built-in.
// @ts-ignore
import { readFileSync } from "node:fs";

const css: string = readFileSync(new URL("./hud.css", import.meta.url), "utf8");
const hud: string = readFileSync(new URL("../hud.ts", import.meta.url), "utf8");
const invasions: string = readFileSync(
  new URL("./panels/invasions.ts", import.meta.url), "utf8",
);

/** Every class that hud.css gives its own positioning context, media queries and
 *  comments flattened away (a dot anchors the same either way). */
function positionedClasses(): Set<string> {
  const out = new Set<string>();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  for (const chunk of source.split("}")) {
    const [selector, body] = chunk.split("{");
    if (!body || !/position\s*:\s*(relative|absolute|fixed|sticky)/.test(body)) continue;
    for (const one of selector.split(",")) {
      const last = one.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? "";
      for (const cls of last.match(/\.[\w-]+/g) ?? []) out.add(cls.slice(1));
    }
  }
  return out;
}

/** Where a dot is hung, by class. Kept by hand BECAUSE adding a host is the moment
 *  this can break: a new entry here without a matching rule in the sheet fails, and a
 *  new setBadge call with no entry here fails the count check below. */
const HOSTS = [
  "mbtn",          // the Social button in the menu dock
  "fab",           // the phone's collapsed dock, which swallows that button whole
  "social-choice", // the Social hub's Friends / Invasions tiles
  "mkt-tab",       // the Invasions panel's History tab
];

describe("notification dots anchor to their host", () => {
  it("positions every element a dot is hung on", () => {
    const positioned = positionedClasses();
    expect(HOSTS.filter((h) => !positioned.has(h))).toEqual([]);
  });

  it("draws the dot itself out of flow, in the host's corner", () => {
    expect(positionedClasses().has("ui-badge")).toBe(true);
  });

  it("keeps the dot's label off the screen and on the accessibility tree", () => {
    // The label is real text inside the circle: visible, it would blow the dot open
    // to the width of a sentence. `display: none` would take it off the tree with it,
    // which defeats the point — so it must be clipped, not hidden.
    const text = css.split("}").find((c) => c.includes(".ui-badge-text")) ?? "";
    expect(text).toMatch(/clip-path\s*:\s*inset\(50%\)/);
    expect(text).not.toMatch(/display\s*:\s*none/);
    expect(text).not.toMatch(/visibility\s*:\s*hidden/);
  });

  it("has an entry in HOSTS for every place a dot is actually hung", () => {
    // Counts the call sites rather than trying to infer their classes: if this trips,
    // a dot was added somewhere new and its host needs listing (and positioning).
    const calls = [...hud.matchAll(/setBadge\(/g), ...invasions.matchAll(/setBadge\(/g)];
    // hud.ts: the dock button, the fab, and the data-badge sweep over the hub's tiles
    // (one call for both, and it clears as well as sets). invasions.ts: History.
    expect(calls.length).toBe(4);
  });
});
