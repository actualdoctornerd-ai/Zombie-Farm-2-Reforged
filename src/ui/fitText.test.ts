import { afterEach, describe, expect, it, vi } from "vitest";
import { fitRow, fitTexts } from "./fitText";

/** A stand-in element: text is `chars` wide per px of font, in a box `box` px wide. */
function fake(chars: number, box: number, base = 12) {
  const el = {
    style: { fontSize: "" },
    get clientWidth() { return box; },
    get scrollWidth() { return Math.max(box, chars * (parseFloat(el.style.fontSize) || base) * 0.6); },
  };
  return el as unknown as HTMLElement;
}

afterEach(() => vi.unstubAllGlobals());
const stubBase = (px = 12) => vi.stubGlobal("getComputedStyle", () => ({ fontSize: `${px}px` }));

describe("fitTexts", () => {
  it("leaves text that already fits at the stylesheet size", () => {
    stubBase();
    const el = fake(3, 40);
    fitTexts([el]);
    expect(el.style.fontSize).toBe("");
  });

  it("shrinks overflowing text until it fits", () => {
    stubBase();
    const el = fake(7, 40);
    fitTexts([el]);
    const size = parseFloat(el.style.fontSize);
    expect(size).toBeLessThan(12);
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
  });

  it("stops at the floor rather than vanishing", () => {
    stubBase();
    const el = fake(50, 10);
    fitTexts([el], 8);
    expect(el.style.fontSize).toBe("8px");
  });

  it("clears an earlier size when there is room again", () => {
    stubBase();
    const el = fake(3, 40);
    el.style.fontSize = "9px";
    fitTexts([el]);
    expect(el.style.fontSize).toBe("");
  });

  it("skips hidden elements", () => {
    stubBase();
    const el = fake(9, 0);
    fitTexts([el]);
    expect(el.style.fontSize).toBe("");
  });
});

describe("fitRow", () => {
  it("shrinks every value together until the row fits", () => {
    stubBase();
    const a = fake(1, 0), b = fake(1, 0);
    const last = {
      getBoundingClientRect: () => ({ right: Math.max(100, 10 * (parseFloat(a.style.fontSize) || 12)) }),
    };
    const row = {
      clientWidth: 100,
      lastElementChild: last,
      getBoundingClientRect: () => ({ right: 100 }),
    } as unknown as HTMLElement;
    fitRow(row, [a, b]);
    expect(a.style.fontSize).toBe(b.style.fontSize);
    expect(parseFloat(a.style.fontSize)).toBeLessThan(12);
    expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(100.5);
  });

  it("ignores overflow that is not a child running past the edge", () => {
    stubBase();
    const a = fake(1, 0);
    const row = {
      clientWidth: 100,
      scrollWidth: 400, // e.g. a hidden absolute tooltip
      lastElementChild: { getBoundingClientRect: () => ({ right: 100 }) },
      getBoundingClientRect: () => ({ right: 100 }),
    } as unknown as HTMLElement;
    fitRow(row, [a]);
    expect(a.style.fontSize).toBe("");
  });
});
