import { describe, it, expect } from "vitest";
import {
  DAY_MS,
  FRIEND_CODE_LEN,
  friendCodeFromBytes,
  dayBucket,
  idFromBytes,
  canSendGift,
  isStaleWrite,
  importEligible,
  deviceLabel,
  normalizeFriendCode,
  normalizeUsername,
  projectFriendSave,
} from "../src/logic";
import type { SaveGame } from "../src/env";

describe("importEligible — save-import cutoff gate", () => {
  const CUT = 1_000_000;
  it("allows an account created strictly before a positive cutoff", () => {
    expect(importEligible(CUT - 1, CUT)).toBe(true);
    expect(importEligible(0, CUT)).toBe(true);
  });
  it("refuses an account created at or after the cutoff (new accounts get defaults)", () => {
    expect(importEligible(CUT, CUT)).toBe(false);
    expect(importEligible(CUT + 1, CUT)).toBe(false);
  });
  it("refuses everyone when the cutoff is unset/0/negative (imports closed)", () => {
    expect(importEligible(0, 0)).toBe(false);
    expect(importEligible(-1, 0)).toBe(false);
    expect(importEligible(100, -5)).toBe(false);
  });
  it("refuses non-finite inputs (cutoff must be a real instant)", () => {
    expect(importEligible(NaN, CUT)).toBe(false);
    expect(importEligible(CUT - 1, NaN)).toBe(false);
    expect(importEligible(CUT - 1, Infinity)).toBe(false); // non-finite cutoff rejected
  });
});

describe("friendCodeFromBytes", () => {
  it("produces a ZF- prefixed code of the default (long) length", () => {
    const code = friendCodeFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(code).toMatch(new RegExp(`^ZF-[0-9A-Z]{${FRIEND_CODE_LEN}}$`));
  });
  it("honours an explicit length", () => {
    const code = friendCodeFromBytes(new Uint8Array([0, 1, 2, 3]), 4);
    expect(code).toMatch(/^ZF-[0-9A-Z]{4}$/);
  });
  it("defaults to a hard-to-enumerate length (>= 10)", () => {
    expect(FRIEND_CODE_LEN).toBeGreaterThanOrEqual(10);
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

describe("dayBucket — once/day gift window key", () => {
  const start = 12000 * DAY_MS; // a day-aligned instant
  it("is stable within a day", () => {
    expect(dayBucket(start)).toBe(dayBucket(start + DAY_MS - 1));
  });
  it("advances across a day boundary", () => {
    expect(dayBucket(start + DAY_MS)).toBe(dayBucket(start) + 1);
  });
});

describe("normalizeUsername — non-unique display name", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeUsername("  Zombie   Zoe  ")).toBe("Zombie Zoe");
  });
  it("accepts letters, numbers, and _ - . '", () => {
    expect(normalizeUsername("O'Brien_92-x.y")).toBe("O'Brien_92-x.y");
  });
  it("accepts unicode letters", () => {
    expect(normalizeUsername("Zoë")).toBe("Zoë");
  });
  it("rejects too short / too long", () => {
    expect(normalizeUsername("a")).toBeNull();
    expect(normalizeUsername("x".repeat(21))).toBeNull();
  });
  it("rejects empty / whitespace-only", () => {
    expect(normalizeUsername("   ")).toBeNull();
  });
  it("rejects disallowed characters", () => {
    expect(normalizeUsername("bad<name>")).toBeNull();
    expect(normalizeUsername("no@symbols")).toBeNull();
  });
});

describe("projectFriendSave — read-only visitor projection", () => {
  // A save carrying every private field a visitor must NOT receive.
  const full = {
    version: 1,
    savedAt: 123,
    player: {
      name: "Neighbor",
      gold: 99999,
      brains: 42,
      xp: 7777,
      zombieMax: 12,
      zombieCount: 5,
      farmer: { col: 3, row: 4 },
      unlockedAbilities: ["boom"],
    },
    farm: { fieldId: "default", w: 20, h: 20, climate: "snow", background: "deep-forest", plots: [] },
    objects: [{ id: "o1", key: "tree", oc: 1, or: 1 }],
    ownedZombies: [{ id: "z1", key: "regular" }],
    zombiePot: {
      keyA: "a",
      keyB: "b",
      maskA: 0,
      maskB: 0,
      startedAt: 1,
      finishAt: 2,
    },
    storage: { itemCap: 8, items: [], received: [] },
    boosts: [{ key: "fert", count: 3 }],
    quests: { active: [], completed: ["q1"] },
    raids: { completed: { "1": 3 } },
    social: { friends: [{ id: "f1", name: "Secret", addedAt: 0, giftsSent: 0 }] },
  } as unknown as SaveGame;

  it("keeps the renderable farm + zombies", () => {
    const p = projectFriendSave(full);
    expect(p.farm).toEqual(full.farm);
    expect(p.farm.climate).toBe("snow");
    expect(p.farm.background).toBe("deep-forest");
    expect(p.objects).toEqual(full.objects);
    expect(p.ownedZombies).toEqual(full.ownedZombies);
    expect(p.zombiePot).toEqual(full.zombiePot);
    expect(p.savedAt).toBe(123); // drives offline-growth math
    expect(p.player.name).toBe("Neighbor");
    expect(p.player.zombieMax).toBe(12);
  });

  it("zeroes private balances/progression", () => {
    const p = projectFriendSave(full);
    expect(p.player.gold).toBe(0);
    expect(p.player.brains).toBe(0);
    expect(p.player.xp).toBe(0);
    expect(p.player.unlockedAbilities).toBeUndefined();
  });

  it("drops storage, boosts, quests, raids, and the social block entirely", () => {
    const p = projectFriendSave(full);
    expect(p.storage).toBeUndefined();
    expect(p.boosts).toBeUndefined();
    expect(p.quests).toBeUndefined();
    expect(p.raids).toBeUndefined();
    expect(p.social).toBeUndefined();
    // Nothing in the serialized projection leaks the friends list.
    expect(JSON.stringify(p)).not.toContain("Secret");
  });
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

describe("deviceLabel — coarse UA → device string", () => {
  it("classifies common browser/OS pairs", () => {
    expect(deviceLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )).toBe("Chrome on Windows");
    expect(deviceLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    )).toBe("Safari on iPhone");
    expect(deviceLabel(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0"
    )).toBe("Edge on macOS");
    expect(deviceLabel(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
    )).toBe("Chrome on Android");
  });
  it("disambiguates Chrome-impersonators (Edge) and iPad Safari", () => {
    // Edge/Opera advertise Chrome in their UA — must be matched first.
    expect(deviceLabel(
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 OPR/106"
    )).toBe("Opera on Windows");
    // iPadOS reports "Macintosh" — the iPad token must win the OS classification.
    expect(deviceLabel(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1"
    )).toBe("Safari on iPad");
  });
  it("returns null for a missing/blank UA (shown as Unknown device)", () => {
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel("   ")).toBeNull();
  });
});
