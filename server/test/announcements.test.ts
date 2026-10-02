import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_LIMIT, BODY_MAX, TITLE_MAX, announcementFromRow, readAnnouncements, resetAnnouncementsCache,
} from "../src/announcements";

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, title: "Hello", body: "World", published_at: 1_000, expires_at: null, min_ruleset: null, ...over,
}) as Parameters<typeof announcementFromRow>[0];

/** A D1 stand-in that records the bound parameters and returns canned rows. */
function fakeDb(rows: unknown[], seen?: { sql?: string; binds?: unknown[] }) {
  return {
    prepare(sql: string) {
      if (seen) seen.sql = sql;
      return {
        bind(...binds: unknown[]) {
          if (seen) seen.binds = binds;
          return this;
        },
        async all() {
          return { results: rows };
        },
      };
    },
  } as unknown as D1Database;
}

describe("announcements", () => {
  beforeEach(() => resetAnnouncementsCache());

  it("serves a well-formed row as the client shape", () => {
    expect(announcementFromRow(row({ expires_at: 9_000, min_ruleset: 70 }))).toEqual({
      id: 1, title: "Hello", body: "World", publishedAt: 1_000, expiresAt: 9_000, minRuleset: 70,
    });
  });

  it("drops a row with no usable text, id or publish time", () => {
    expect(announcementFromRow(row({ title: "   " }))).toBeNull();
    expect(announcementFromRow(row({ body: "" }))).toBeNull();
    expect(announcementFromRow(row({ id: null }))).toBeNull();
    expect(announcementFromRow(row({ published_at: null }))).toBeNull();
  });

  it("trims overlong text rather than refusing it", () => {
    const made = announcementFromRow(row({ title: "t".repeat(500), body: "b".repeat(9_000) }))!;
    expect(made.title).toHaveLength(TITLE_MAX);
    expect(made.body).toHaveLength(BODY_MAX);
  });

  it("asks D1 only for live rows: active, already published, not expired, newest first, capped", async () => {
    const seen: { sql?: string; binds?: unknown[] } = {};
    await readAnnouncements(fakeDb([], seen), 5_000);
    expect(seen.sql).toContain("active = 1");
    expect(seen.sql).toContain("published_at <= ?1");
    expect(seen.sql).toContain("expires_at IS NULL OR expires_at > ?1");
    expect(seen.sql).toContain("ORDER BY published_at DESC");
    expect(seen.binds).toEqual([5_000, ACTIVE_LIMIT]);
  });

  it("returns the rows it was given, skipping unusable ones", async () => {
    const list = await readAnnouncements(fakeDb([row({ id: 2 }), row({ id: 3, title: "" })]), 1);
    expect(list.map((a) => a.id)).toEqual([2]);
  });

  it("fails open to an empty list when the table is missing or D1 errors", async () => {
    const broken = { prepare() { throw new Error("no such table: announcements"); } } as unknown as D1Database;
    expect(await readAnnouncements(broken, 1)).toEqual([]);
  });

  it("reads D1 once per minute, not once per request", async () => {
    let reads = 0;
    const db = {
      prepare() {
        reads++;
        return { bind() { return this; }, async all() { return { results: [row()] }; } };
      },
    } as unknown as D1Database;
    await readAnnouncements(db, 1_000);
    await readAnnouncements(db, 30_000);
    expect(reads).toBe(1);
    await readAnnouncements(db, 61_001);
    expect(reads).toBe(2);
  });
});
