import { describe, it, expect } from "vitest";
import {
  DAY_MS,
  friendCodeFromBytes,
  idFromBytes,
  canSendGift,
  isStaleWrite,
  normalizeFriendCode,
} from "../src/logic";

describe("friendCodeFromBytes", () => {
  it("produces a ZF- prefixed code of the requested length", () => {
    const code = friendCodeFromBytes(new Uint8Array([0, 1, 2, 3]));
    expect(code).toMatch(/^ZF-[0-9A-Z]{4}$/);
  });
  it("is deterministic in its bytes", () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    expect(friendCodeFromBytes(bytes)).toBe(friendCodeFromBytes(bytes));
  });
  it("never emits ambiguous glyphs (0/O/1/I/L)", () => {
    // Every byte value maps into the safe alphabet.
    const all = Array.from({ length: 256 }, (_, i) => i);
    const code = friendCodeFromBytes(new Uint8Array(all), 40);
    expect(code.slice(3)).not.toMatch(/[01OIL]/);
  });
});

describe("idFromBytes", () => {
  it("is lowercase hex of the requested length", () => {
    const id = idFromBytes(new Uint8Array([0xab, 0xcd, 0xef, 0x01]), 6);
    expect(id).toBe("abcdef");
  });
});

describe("canSendGift — once per rolling 24h", () => {
  const now = 1_000_000_000_000;
  it("allows the first-ever gift (no prior)", () => {
    expect(canSendGift(null, now)).toBe(true);
  });
  it("blocks a second gift within the window", () => {
    expect(canSendGift(now, now + DAY_MS - 1)).toBe(false);
  });
  it("allows again once the window elapses", () => {
    expect(canSendGift(now, now + DAY_MS)).toBe(true);
  });
});

describe("isStaleWrite", () => {
  it("accepts a matching base rev", () => expect(isStaleWrite(3, 3)).toBe(false));
  it("rejects a stale base rev", () => expect(isStaleWrite(2, 3)).toBe(true));
});

describe("normalizeFriendCode", () => {
  it("upper-cases and adds the ZF- prefix", () => {
    expect(normalizeFriendCode("ab2c")).toBe("ZF-AB2C");
  });
  it("tolerates an existing prefix and spaces", () => {
    expect(normalizeFriendCode("  zf-ab2c ")).toBe("ZF-AB2C");
    expect(normalizeFriendCode("ZFAB2C")).toBe("ZF-AB2C");
  });
  it("rejects junk", () => {
    expect(normalizeFriendCode("")).toBeNull();
    expect(normalizeFriendCode("!!")).toBeNull();
    expect(normalizeFriendCode("zf-")).toBeNull();
  });
});
