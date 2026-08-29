import { describe, expect, it } from "vitest";
import {
  compareCropMarketOrder, compareItemMarketOrder, cropAvailableInMarket,
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
