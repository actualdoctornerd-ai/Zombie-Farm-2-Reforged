import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import {
  BODY_MAX, TITLE_MAX, loadSeen, markSeen, parseAnnouncements, pendingAnnouncements,
  startAnnouncementWatcher, type Announcement,
} from "./announcements";

const make = (over: Partial<Announcement> = {}): Announcement => ({
  id: 1, title: "T", body: "B", publishedAt: 100, expiresAt: null, minRuleset: null, ...over,
});

/** In-memory Storage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("parseAnnouncements", () => {
  it("returns well-formed announcements oldest first", () => {
    const list = parseAnnouncements({ announcements: [
      { id: 2, title: "New", body: "b", publishedAt: 200, expiresAt: null, minRuleset: 70 },
      { id: 1, title: "Old", body: "b", publishedAt: 100, expiresAt: 900, minRuleset: null },
    ] });
    expect(list.map((a) => a.id)).toEqual([1, 2]);
    expect(list[1].minRuleset).toBe(70);
    expect(list[0].expiresAt).toBe(900);
  });

  it("drops anything malformed, duplicated or textless, and never throws", () => {
    expect(parseAnnouncements(null)).toEqual([]);
    expect(parseAnnouncements({})).toEqual([]);
    expect(parseAnnouncements({ announcements: "nope" })).toEqual([]);
    const list = parseAnnouncements({ announcements: [
      null, 7, { id: "x", title: "t", body: "b", publishedAt: 1 },
      { id: 1, title: "", body: "b", publishedAt: 1 },
      { id: 1, title: "ok", body: "b", publishedAt: 1 },
      { id: 1, title: "dupe", body: "b", publishedAt: 2 },
    ] });
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("ok");
  });

  it("trims overlong text", () => {
    const [a] = parseAnnouncements({ announcements: [
      { id: 1, title: "t".repeat(999), body: "b".repeat(99_999), publishedAt: 1 },
    ] });
    expect(a.title).toHaveLength(TITLE_MAX);
    expect(a.body).toHaveLength(BODY_MAX);
  });
});

describe("seen tracking", () => {
  it("remembers ids across loads, and tolerates garbage or missing storage", () => {
    const storage = memoryStorage();
    markSeen(3, storage);
    markSeen(5, storage);
    expect([...loadSeen(storage)]).toEqual([3, 5]);
    expect(loadSeen(memoryStorage({ "zf2r.announcements.seen.v1": "{not json" })).size).toBe(0);
    expect(loadSeen(null).size).toBe(0);
    expect(() => markSeen(1, null)).not.toThrow();
  });

  it("keeps only the newest 200 ids", () => {
    const storage = memoryStorage();
    for (let i = 1; i <= 230; i++) markSeen(i, storage);
    const seen = loadSeen(storage);
    expect(seen.size).toBe(200);
    expect(seen.has(230)).toBe(true);
    expect(seen.has(30)).toBe(false);
  });
});

describe("pendingAnnouncements", () => {
  it("skips seen ones and ones meant for a newer client", () => {
    const list = [make({ id: 1 }), make({ id: 2 }), make({ id: 3, minRuleset: 71 }), make({ id: 4, minRuleset: 70 })];
    expect(pendingAnnouncements(list, new Set([2]), 70).map((a) => a.id)).toEqual([1, 4]);
    expect(pendingAnnouncements(list, new Set(), 71).map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("startAnnouncementWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The watcher asks api.baseUrl(), which is null in the unit-test build.
    vi.spyOn(api, "baseUrl").mockReturnValue("https://example.test");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const reply = (items: unknown[]) =>
    (async () => ({ ok: true, json: async () => ({ announcements: items }) })) as unknown as typeof fetch;

  it("shows each unseen announcement once, in order, then marks it seen", async () => {
    const storage = memoryStorage();
    const shown: [number, number, number][] = [];
    const watcher = startAnnouncementWatcher({
      fetcher: reply([
        { id: 2, title: "Second", body: "b", publishedAt: 200 },
        { id: 1, title: "First", body: "b", publishedAt: 100 },
      ]),
      storage, rulesetVersion: 70, isBusy: () => false,
      show: async (a, i, n) => void shown.push([a.id, i, n]),
    });
    await watcher.check();
    expect(shown).toEqual([[1, 0, 2], [2, 1, 2]]);
    await watcher.check();
    expect(shown).toHaveLength(2); // nothing new the second time
    watcher.stop();
  });

  it("waits while the player is busy rather than covering what they are doing", async () => {
    let busy = true;
    const shown: number[] = [];
    const watcher = startAnnouncementWatcher({
      fetcher: reply([{ id: 1, title: "t", body: "b", publishedAt: 1 }]),
      storage: memoryStorage(), isBusy: () => busy, busyRetryMs: 1000,
      show: async (a) => void shown.push(a.id),
    });
    const done = watcher.check();
    await vi.advanceTimersByTimeAsync(3500);
    expect(shown).toEqual([]);
    busy = false;
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(shown).toEqual([1]);
    watcher.stop();
  });

  it("shows nothing when the Worker is unreachable, and offers an empty history", async () => {
    const shown: number[] = [];
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const watcher = startAnnouncementWatcher({
      fetcher: down, storage: memoryStorage(), isBusy: () => false,
      show: async (a) => void shown.push(a.id),
    });
    await watcher.check();
    expect(shown).toEqual([]);
    expect(await watcher.refresh()).toEqual([]);
    watcher.stop();
  });

  it("does not show an announcement addressed to a newer client than this one", async () => {
    const shown: number[] = [];
    const watcher = startAnnouncementWatcher({
      fetcher: reply([
        { id: 1, title: "now", body: "b", publishedAt: 1 },
        { id: 2, title: "after you update", body: "b", publishedAt: 2, minRuleset: 99 },
      ]),
      storage: memoryStorage(), rulesetVersion: 70, isBusy: () => false,
      show: async (a) => void shown.push(a.id),
    });
    await watcher.check();
    expect(shown).toEqual([1]);
    watcher.stop();
  });
});
