import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FARM_BACKGROUND,
  getDayNightMode,
  getFarmBackground,
  getRightClickMode,
  hasSeenHazardTip,
  isLocalNight,
  setDayNightMode,
  setPrefStorageErrorHandler,
  setRightClickMode,
  setShowZombieMutations,
  setZombieBodyColorMode,
  zombieAppearancePrefs,
} from "./prefs";

describe("environment preferences", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
  beforeEach(() => values.clear());

  it("defaults day/night to local-clock auto mode", () => {
    expect(getDayNightMode()).toBe("auto");
    setDayNightMode("night");
    expect(getDayNightMode()).toBe("night");
  });

  it("defaults right-click to the Select tool, with the tool menu opt-in", () => {
    expect(getRightClickMode()).toBe("select");
    setRightClickMode("menu");
    expect(getRightClickMode()).toBe("menu");
    setRightClickMode("select");
    expect(getRightClickMode()).toBe("select");
  });

  it("defaults zombies to their inherited colours with mutations shown", () => {
    expect(zombieAppearancePrefs()).toEqual({ bodyColor: "inherited", showMutations: true });
    setZombieBodyColorMode("species");
    setShowZombieMutations(false);
    expect(zombieAppearancePrefs()).toEqual({ bodyColor: "species", showMutations: false });
    setZombieBodyColorMode("inherited");
    setShowZombieMutations(true);
    expect(zombieAppearancePrefs()).toEqual({ bodyColor: "inherited", showMutations: true });
  });

  it("uses the device-local 7pm to 7am night window", () => {
    expect(isLocalNight(new Date(2026, 6, 26, 6, 59))).toBe(true);
    expect(isLocalNight(new Date(2026, 6, 26, 7, 0))).toBe(false);
    expect(isLocalNight(new Date(2026, 6, 26, 18, 59))).toBe(false);
    expect(isLocalNight(new Date(2026, 6, 26, 19, 0))).toBe(true);
  });
});

describe("a device that cannot keep a preference says so", () => {
  // The silent version of this is the reported bug: the toggle moves, the setting
  // applies for the session, and it is gone at the next launch with nothing anywhere
  // to explain it. One warning, not one per write — a full quota fails every time.
  it("reports the first refused write and then stays quiet", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
    });
    const warnings: string[] = [];
    setPrefStorageErrorHandler((message) => warnings.push(message));
    try {
      setDayNightMode("night");
      setShowZombieMutations(false);
      setZombieBodyColorMode("species");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/reset when you come back/);
    } finally {
      setPrefStorageErrorHandler(null);
      vi.unstubAllGlobals();
    }
  });

  it("reads defaults instead of throwing when storage is blocked outright", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
    });
    try {
      // getFarmBackground is read at module scope during boot: a throw here took the
      // whole launch, which is why every accessor goes through the guarded helpers.
      expect(getFarmBackground()).toBe(DEFAULT_FARM_BACKGROUND);
      expect(getDayNightMode()).toBe("auto");
      expect(hasSeenHazardTip()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
