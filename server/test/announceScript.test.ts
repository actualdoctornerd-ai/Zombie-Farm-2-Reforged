import { describe, expect, it } from "vitest";
// The CLI is plain Node (.mjs); its pure helpers are exported so the SQL it writes is tested.
// @ts-ignore
import { buildInsert, parseArgs, parseWhen, parseWranglerJson } from "../scripts/announce.mjs";

describe("announce.mjs helpers", () => {
  it("parses flags, bare flags and positionals", () => {
    const { flags, positional } = parseArgs(["post", "--title", "Hi there", "--prod", "--yes", "--min-ruleset", "70"]);
    expect(positional).toEqual(["post"]);
    expect(flags).toEqual({ title: "Hi there", prod: true, yes: true, "min-ruleset": "70" });
  });

  it("reads relative and absolute times", () => {
    expect(parseWhen("now", 1_000)).toBe(1_000);
    expect(parseWhen("30m", 0)).toBe(1_800_000);
    expect(parseWhen("12h", 0)).toBe(43_200_000);
    expect(parseWhen("7d", 0)).toBe(604_800_000);
    expect(parseWhen("2026-10-03T18:00:00Z")).toBe(Date.parse("2026-10-03T18:00:00Z"));
    expect(() => parseWhen("next tuesday")).toThrow(/can't read/);
  });

  it("writes an INSERT with the text quoted safely", () => {
    const sql = buildInsert({ title: "Don't panic", body: "It's 'fine'", now: 5_000 });
    expect(sql).toBe(
      "INSERT INTO announcements (title, body, published_at, expires_at, min_ruleset, active, created_at) VALUES " +
      "('Don''t panic', 'It''s ''fine''', 5000, NULL, NULL, 1, 5000);"
    );
  });

  it("carries a schedule, an expiry and a minimum ruleset", () => {
    const sql = buildInsert({ title: "T", body: "B", publishAt: 100, expiresAt: 900, minRuleset: 70, now: 5 });
    expect(sql).toContain("100, 900, 70, 1, 5");
  });

  it("reads wrangler's JSON even with warnings and colour codes in front of it", () => {
    const out = "\u001b[33m\u25b2 [WARNING] Processing wrangler.toml\u001b[0m\n\n    - \"unsafe\" fields\n\n" +
      JSON.stringify([{ results: [{ id: 1, title: "T" }], success: true }], null, 2) + "\n";
    expect(parseWranglerJson(out)).toEqual([{ results: [{ id: 1, title: "T" }], success: true }]);
    expect(parseWranglerJson("no json here")).toBe("no json here");
  });

  it("refuses what the Worker would drop or mangle", () => {
    expect(() => buildInsert({ title: " ", body: "b" })).toThrow(/title/);
    expect(() => buildInsert({ title: "t", body: "" })).toThrow(/body/);
    expect(() => buildInsert({ title: "t".repeat(81), body: "b" })).toThrow(/limit is 80/);
    expect(() => buildInsert({ title: "t", body: "b".repeat(2001) })).toThrow(/limit is 2000/);
    expect(() => buildInsert({ title: "t", body: "b", publishAt: 500, expiresAt: 400 })).toThrow(/after the publish/);
    expect(() => buildInsert({ title: "t", body: "b", minRuleset: 7.5 })).toThrow(/whole number/);
  });
});
