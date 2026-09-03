import { describe, expect, it } from "vitest";
import {
  assertMaskBitIndex, bitValue, isMaskBit, MAX_MASK_BITS, maskBits,
  maskHas, maskIntersect, maskUnion, maskWithout, newMutationBits,
} from "./mutationMask";

// The whole reason this module exists: `&`, `|` and `~` coerce to 32-BIT SIGNED, so
// the obvious implementation silently corrupts any mask that reaches bit 31. These
// tests pin the widths where that used to happen, and the boundary where the current
// representation genuinely does run out.

const BIT_30 = 2 ** 30;
const BIT_31 = 2 ** 31; // where JS bitwise goes NEGATIVE
const BIT_32 = 2 ** 32; // where JS bitwise wraps to 0
const BIT_52 = 2 ** 52; // the last bit an exact JS number can carry

describe("wide mask arithmetic", () => {
  it("agrees with the bitwise operators everywhere they are still correct", () => {
    for (const a of [0, 1, 5, 8191, 0xffff, BIT_30 - 1]) {
      for (const b of [0, 1, 4096, 8192, 0xff00, BIT_30 - 1]) {
        expect(maskUnion(a, b)).toBe(a | b);
        expect(maskIntersect(a, b)).toBe(a & b);
        expect(maskWithout(a, b)).toBe(a & ~b);
      }
    }
  });

  it("stays exact at the bits where the bitwise operators break", () => {
    // These are the assertions the old implementation could not make: `BIT_31 | 1`
    // is negative and `BIT_32 | 1` is 1.
    expect(BIT_31 | 1).toBeLessThan(0);
    expect(BIT_32 | 1).toBe(1);

    expect(maskUnion(BIT_31, 1)).toBe(BIT_31 + 1);
    expect(maskUnion(BIT_32, 1)).toBe(BIT_32 + 1);
    expect(maskUnion(BIT_52, BIT_31)).toBe(BIT_52 + BIT_31);
    expect(maskIntersect(BIT_52 + BIT_31 + 4, BIT_31 + 4)).toBe(BIT_31 + 4);
    expect(maskWithout(BIT_52 + BIT_31 + 4, BIT_31)).toBe(BIT_52 + 4);
  });

  it("tests membership at every bit the representation holds", () => {
    for (let index = 0; index < MAX_MASK_BITS; index++) {
      const bit = bitValue(index);
      expect(maskHas(bit, bit)).toBe(true);
      expect(maskHas(maskUnion(bit, 1), bit)).toBe(true);
      expect(maskHas(maskWithout(maskUnion(bit, 1), bit), bit)).toBe(false);
    }
  });

  it("round-trips a mask through its bit list", () => {
    const bits = [1, 4, BIT_30, BIT_31, BIT_52];
    const mask = bits.reduce(maskUnion, 0);
    expect(maskBits(mask)).toEqual(bits);
    expect(maskBits(0)).toEqual([]);
  });

  it("is idempotent and commutative, so a repeated add cannot double-count", () => {
    const mask = maskUnion(BIT_52, 8);
    expect(maskUnion(mask, BIT_52)).toBe(mask);
    expect(maskUnion(8, BIT_52)).toBe(mask);
    expect(maskWithout(mask, 0)).toBe(mask);
  });

  it("ignores negatives and fractions rather than propagating them", () => {
    expect(maskUnion(-8, 1)).toBe(1);
    expect(maskIntersect(-8, 7)).toBe(0);
    expect(maskBits(-1)).toEqual([]);
  });
});

describe("bit indices", () => {
  it("assigns bit 2^index and refuses anything the mask cannot hold exactly", () => {
    expect(bitValue(0)).toBe(1);
    expect(bitValue(13)).toBe(8192);
    expect(bitValue(MAX_MASK_BITS - 1)).toBe(2 ** 52);
    // 2^53 is where integers stop being exact, so this is a real wall, not a taste
    // limit — the error names the representation change it would need.
    expect(() => assertMaskBitIndex(MAX_MASK_BITS)).toThrow(/BigInt/);
    expect(() => bitValue(-1)).toThrow(RangeError);
    expect(() => bitValue(1.5)).toThrow(RangeError);
  });

  it("recognises single bits and rejects compound or unrepresentable values", () => {
    expect(isMaskBit(1)).toBe(true);
    expect(isMaskBit(BIT_52)).toBe(true);
    expect(isMaskBit(3)).toBe(false); // two bits
    expect(isMaskBit(0)).toBe(false);
    expect(isMaskBit(-2)).toBe(false);
    expect(isMaskBit(2 ** 53)).toBe(false); // past the exact-integer boundary
  });
});

describe("newMutationBits", () => {
  // What the Mutation Almanac credits when a server mask lands on a unit the client
  // spawned with none: the bits gained, and only those.
  it("hands back the bits gained and none the unit already wore", () => {
    expect(newMutationBits(0, 5)).toBe(5);
    expect(newMutationBits(1, 5)).toBe(4);
    expect(newMutationBits(5, 5)).toBe(0);
    expect(newMutationBits(5, 1)).toBe(0); // a dropped bit is not a discovery
  });

  it("is exact for a tier-4 variant bit", () => {
    // 32768 is bit 15, one of the two tier-4 variant bits; together with bit 31 and
    // beyond it is where the bitwise version of this would have started to lie.
    expect(newMutationBits(1, 1 + 32768)).toBe(32768);
    expect(newMutationBits(32768, 32768 + BIT_31 + BIT_32)).toBe(BIT_31 + BIT_32);
  });
});
