import { describe, expect, it } from "vitest";
import { marketPageSize } from "./marketPageSize";

describe("Market page sizing", () => {
  it("keeps desktop pages at two rows of five", () => {
    expect(marketPageSize({
      mobile: false, columns: 5, rowHeight: 122, gap: 9, availableHeight: 400,
    })).toBe(10);
  });

  it("retains responsive sizing on compact layouts", () => {
    expect(marketPageSize({
      mobile: true, columns: 3, rowHeight: 116, gap: 9, availableHeight: 250,
    })).toBe(6);
    expect(marketPageSize({
      mobile: true, columns: 2, rowHeight: 116, gap: 9, availableHeight: 250,
    })).toBe(8);
  });
});
