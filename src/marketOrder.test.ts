import { describe, expect, it } from "vitest";
import plants from "../public/assets/plants.json";
import { ACTIVE_THEMES } from "./decorThemes";
import {
  compareCropMarketOrder, compareItemMarketOrder, cropAvailableInMarket, SEASONAL_CROP_THEMES,
} from "./marketOrder";

describe("crop market ordering", () => {
  it("temporarily removes seasonal crops from purchase surfaces", () => {
    const rows = [
      { name: "Carrot", level: 1 },
      { name: "Candy Corn", level: 13, seasonal: true },
      { name: "Potato", level: 10 },
    ];
    expect(rows.filter(cropAvailableInMarket).map((row) => row.name))
      .toEqual(["Carrot", "Potato"]);
  });

  it("sells a seasonal seed while its holiday's theme is on, and only that one", () => {
    const rows = plants as { key: string; seasonal?: boolean; prize?: boolean }[];
    const sold = rows.filter((row) => row.seasonal && cropAvailableInMarket(row)).map((row) => row.key);
    const expected = Object.entries(SEASONAL_CROP_THEMES)
      .filter(([, theme]) => ACTIVE_THEMES.includes(theme)).map(([key]) => key);
    expect(sold.sort()).toEqual(expected.sort());
    // Halloween is on: Candy Corn is in the market, the year's other holiday seeds are not.
    expect(sold).toContain("candy_corn");
    expect(sold).not.toContain("marigold");
    // Every themed seed is a real seasonal row, so a typo cannot silently sell nothing.
    for (const key of Object.keys(SEASONAL_CROP_THEMES)) {
      expect(rows.find((row) => row.key === key)?.seasonal, key).toBe(true);
    }
  });

  it("puts regular crops before holiday crops regardless of unlock level", () => {
    const entries = [
      { name: "Holiday L1", level: 1, seasonal: true },
      { name: "Regular L20", level: 20 },
      { name: "Regular L1", level: 1 },
      { name: "Holiday L5", level: 5, seasonal: true },
    ];
    expect(entries.sort(compareCropMarketOrder).map((entry) => entry.name)).toEqual([
      "Regular L1", "Regular L20", "Holiday L1", "Holiday L5",
    ]);
  });
});

describe("item market ordering", () => {
  it("puts normal decor before seasonal decor regardless of unlock level", () => {
    const entries = [
      { name: "Seasonal L0", level: 0, seasonal: true },
      { name: "Normal L20", level: 20 },
      { name: "Normal L2", level: 2 },
      { name: "Seasonal L10", level: 10, seasonal: true },
    ];
    expect(entries.sort(compareItemMarketOrder).map((entry) => entry.name)).toEqual([
      "Normal L2", "Normal L20", "Seasonal L0", "Seasonal L10",
    ]);
  });
});
