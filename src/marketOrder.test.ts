import { describe, expect, it } from "vitest";
import { compareCropMarketOrder } from "./marketOrder";

describe("crop market ordering", () => {
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
