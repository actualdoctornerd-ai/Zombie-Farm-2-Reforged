import { describe, expect, it } from "vitest";
import placeables from "../public/assets/placeables.json";
import type { PlaceableDef } from "./assets";
import {
  ACTIVE_THEMES, DECOR_THEMES, EVERGREEN, decorAvailable, themeAvailable,
  themeLabel, themeOf,
} from "./decorThemes";

const catalog = placeables as PlaceableDef[];

describe("themeOf", () => {
  it("treats a missing label as evergreen", () => {
    expect(themeOf({})).toBe(EVERGREEN);
    expect(themeOf(undefined)).toBe(EVERGREEN);
    expect(themeOf({ theme: "" })).toBe(EVERGREEN);
    expect(themeOf({ theme: "christmas" })).toBe("christmas");
  });
});

describe("the market allow-list", () => {
  it("always sells evergreen decor", () => {
    expect(themeAvailable(EVERGREEN)).toBe(true);
    expect(themeAvailable("")).toBe(true);
    expect(decorAvailable({})).toBe(true);
  });

  it("withholds a theme that is not running", () => {
    const off = DECOR_THEMES.filter((theme) => !ACTIVE_THEMES.includes(theme));
    expect(off.length).toBeGreaterThan(0);
    for (const theme of off) expect(themeAvailable(theme)).toBe(false);
  });

  it("sells a theme the moment it joins the list", () => {
    // The gating action is editing ACTIVE_THEMES; nothing else has to change.
    expect(themeAvailable("christmas")).toBe(ACTIVE_THEMES.includes("christmas"));
    const pretend = [...ACTIVE_THEMES, "christmas"];
    expect(pretend.includes("christmas")).toBe(true);
  });
});

describe("the shipped catalog's labels", () => {
  it("only uses labels the module knows", () => {
    const known = new Set<string>([...DECOR_THEMES, EVERGREEN]);
    const unknown = [...new Set(
      catalog.map((entry) => themeOf(entry)).filter((theme) => !known.has(theme))
    )];
    expect(unknown).toEqual([]);
  });

  it("labels every theme the module lists (no dead labels)", () => {
    const used = new Set(catalog.map((entry) => themeOf(entry)));
    const dead = DECOR_THEMES.filter((theme) => !used.has(theme));
    expect(dead).toEqual([]);
  });

  it("keeps `seasonal` in step with the label it is derived from", () => {
    const mismatched = catalog
      .filter((entry) => !!entry.seasonal !== (themeOf(entry) !== EVERGREEN))
      .map((entry) => entry.key);
    expect(mismatched).toEqual([]);
  });

  it("gives a recolour family one label, so a variant cannot outlive its base", () => {
    const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
    const split = catalog
      .filter((entry) => entry.variantOf)
      .filter((entry) => themeOf(entry) !== themeOf(byKey.get(entry.variantOf!)))
      .map((entry) => entry.key);
    expect(split).toEqual([]);
  });

  it("leaves plenty of decor buyable with only evergreen active", () => {
    const buyable = catalog.filter(
      (entry) => entry.category === "decor" && decorAvailable(entry));
    expect(buyable.length).toBeGreaterThan(150);
  });

  it("names every label for the card badge", () => {
    for (const theme of DECOR_THEMES) expect(themeLabel(theme)).not.toBe(theme);
    expect(themeLabel(EVERGREEN)).toBe("");
    expect(themeLabel("")).toBe("");
  });
});

describe("Halloween is over (owner, 2026-11-10)", () => {
  it("takes its decor, its seed and its invasion off sale together", async () => {
    const { ACTIVE_THEMES, invasionInSeason, themeAvailable } = await import("./decorThemes");
    const { cropAvailableInMarket } = await import("./marketOrder");
    expect(ACTIVE_THEMES).not.toContain("halloween");
    expect(themeAvailable("halloween")).toBe(false);
    expect(cropAvailableInMarket({ key: "candy_corn", seasonal: true } as never)).toBe(false);
    expect(invasionInSeason(16)).toBe(false);
    // Every other invasion is untouched.
    expect(invasionInSeason(1)).toBe(true);
    expect(invasionInSeason(14)).toBe(true);
  });
});
