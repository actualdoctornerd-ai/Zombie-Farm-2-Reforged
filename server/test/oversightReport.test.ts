// Weekly oversight report: the real SQL against a real schema.sql database, then the
// four sections against hand-built cases that each sit just inside or just outside a
// threshold. The shapes mirror what prod showed on 2026-11-11 (a seller dumping
// Mummies at 1 gold, 1M gold paid for a plain Headless to a 1-day-old account, a
// round-the-clock account fighting every ~80 s).
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  THRESHOLDS,
  buildReport,
  findBotLike,
  loadReportData,
  mutationCount,
  renderHtml,
  renderText,
  reportSubject,
  runOversightReport,
  type Party,
} from "../src/oversightReport";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-16T06:07:00Z");

/** node:sqlite behind the slice of D1 the loader uses (`prepare().bind().all()` and
 *  `prepare().all()`). */
function openSchemaDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: raw.prepare(sql).all(...(params as never[])) }),
  });
  return { db: { prepare: (sql: string) => stmt(sql) } as unknown as D1Database, raw };
}

function seedAccount(raw: DatabaseSync, id: string, name: string, createdAt: number, xp = 1_000_000) {
  raw.prepare("INSERT INTO accounts (id, google_sub, username, friend_code, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, `sub-${id}`, name, `fc-${id}`, createdAt);
  raw.prepare("INSERT INTO balances (account_id, xp) VALUES (?, ?)").run(id, xp);
}

let orderSeq = 0;
/** A settled trade. SELL: creator sells, fulfiller buys. BUY: creator buys, fulfiller sells. */
function seedTrade(raw: DatabaseSync, o: {
  kind?: "SELL_ZOMBIE" | "BUY_ZOMBIE"; creator: string; fulfiller: string; key: string;
  price: number; currency?: "GOLD" | "BRAINS"; at: number; mutation?: number;
}) {
  const kind = o.kind ?? "SELL_ZOMBIE";
  const sell = kind === "SELL_ZOMBIE";
  raw.prepare(`INSERT INTO black_market_orders (id, creator_account_id, kind, zombie_key, mutated_required,
      price_brains, currency, status, created_day, created_at, closed_at, fulfilled_by_account_id,
      source_unit_id, escrow_mutation, escrow_invasions, escrow_brains, delivered_mutation)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'FULFILLED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `o${++orderSeq}`, o.creator, kind, o.key, o.price, o.currency ?? "GOLD",
    Math.floor(o.at / DAY), o.at - 60_000, o.at, o.fulfiller,
    sell ? `u${orderSeq}` : null, sell ? (o.mutation ?? 0) : null, sell ? 0 : null,
    sell ? 0 : o.price, o.mutation ?? 0,
  );
}

function seedFights(raw: DatabaseSync, account: string, from: number, count: number, everyMs: number, lengthMs = 75_000) {
  const insert = raw.prepare(`INSERT INTO raid_sessions_v3 (id, account_id, raid_id, roster_json, started_at,
    earliest_finish_at, expires_at, finished_at) VALUES (?, ?, '16', '[]', ?, ?, ?, ?)`);
  for (let i = 0; i < count; i++) {
    const s = from + i * everyMs;
    insert.run(`r-${account}-${s}`, account, s, s, s + HOUR, s + lengthMs);
  }
}

const p = (id: string): Party => ({ id, name: id, level: null, ageDays: null });

describe("weekly oversight report", () => {
  it("flags each section from real SQL over schema.sql", async () => {
    const { db, raw } = openSchemaDb();
    seedAccount(raw, "dumper", "Dumper", NOW - 200 * DAY);
    seedAccount(raw, "main", "MainAcct", NOW - 60 * DAY);
    seedAccount(raw, "alt", "AltAcct", NOW - 3 * DAY);
    seedAccount(raw, "fan", "Fan", NOW - 100 * DAY);
    seedAccount(raw, "human", "Human", NOW - 100 * DAY);

    // Going prices from the last 90 days: Mummy ~100k gold, RegularTier1 ~20k gold.
    for (let i = 0; i < 4; i++) {
      seedTrade(raw, { creator: "human", fulfiller: "fan", key: "ZombieActorMummy", price: 100_000, at: NOW - 30 * DAY - i * HOUR });
      seedTrade(raw, { creator: "human", fulfiller: "fan", key: "ZombieActorHeadlessTier1", price: 20_000, at: NOW - 30 * DAY - i * HOUR });
    }
    // This week: a Mummy at 1 gold (dump), a Mummy at 95k (normal, not flagged).
    seedTrade(raw, { creator: "dumper", fulfiller: "fan", key: "ZombieActorMummy", price: 1, at: NOW - 2 * DAY });
    seedTrade(raw, { creator: "dumper", fulfiller: "fan", key: "ZombieActorMummy", price: 95_000, at: NOW - 2 * DAY });
    // 1M gold for a plain Headless, from the main account to a 3-day-old alt.
    seedTrade(raw, { creator: "alt", fulfiller: "main", key: "ZombieActorHeadlessTier1", price: 1_000_000, at: NOW - DAY });
    // A BUY request: "main" asks for a Zombug, the alt fills it, so the alt is the seller.
    seedTrade(raw, { kind: "BUY_ZOMBIE", creator: "main", fulfiller: "alt", key: "ZombieActorZombug", price: 60, currency: "BRAINS", at: NOW - DAY });
    // Outside the week: ignored for every section.
    seedTrade(raw, { creator: "alt", fulfiller: "main", key: "ZombieActorHeadlessTier1", price: 2_000_000, at: NOW - 8 * DAY });

    // Bot: a fight every 80 s for 7 h. Human: 3 h sessions with long breaks.
    seedFights(raw, "main", NOW - 3 * DAY, Math.ceil((7 * HOUR) / 80_000), 80_000);
    seedFights(raw, "human", NOW - 3 * DAY, Math.ceil((3 * HOUR) / 80_000), 80_000);
    seedFights(raw, "human", NOW - 3 * DAY + 5 * HOUR, Math.ceil((3 * HOUR) / 80_000), 80_000);

    const report = buildReport(await loadReportData(db, NOW), NOW);

    expect(report.lowPriceSpecials.map((t) => [t.seller.name, t.zombie, t.price])).toEqual([["Dumper", "Mummy", 1]]);
    expect(report.lowPriceSpecials[0].median).toBe(100_000);

    const large = report.largeTransfers.map((t) => [t.seller.name, t.buyer.name, t.price, t.currency]);
    expect(large).toEqual([["AltAcct", "MainAcct", 1_000_000, "GOLD"], ["AltAcct", "MainAcct", 60, "BRAINS"]]);
    expect(report.largeTransfers[0].reasons).toEqual(["50x the median", "plain non-special zombie", "seller 2d old"]);

    expect(report.heavyPairs.map((x) => [x.seller.name, x.buyer.name, x.total])).toEqual([["AltAcct", "MainAcct", 1_000_000]]);

    expect(report.topSellers[0]).toMatchObject({ gold: 1_000_000, brains: 60, trades: 2, buyers: 1 });
    expect(report.topSellers[0].seller.name).toBe("AltAcct");
    expect(report.market).toEqual({ trades: 4, gold: 1_095_001, brains: 60, sellers: 2 });

    expect(report.botLike.map((b) => b.account.name)).toEqual(["MainAcct"]);
    expect(report.botLike[0].longestStretchMs).toBeGreaterThanOrEqual(7 * HOUR - 80_000);
  });

  it("splits stretches on a break longer than the tolerance and caps an abandoned fight", () => {
    const since = NOW - 7 * DAY;
    const tol = THRESHOLDS.breakToleranceMs;
    // Two 4h blocks with a gap just over the tolerance: neither line is crossed.
    const rows = [] as Array<{ account_id: string; started_at: number; finished_at: number | null }>;
    for (let t = since; t < since + 4 * HOUR; t += 60_000) rows.push({ account_id: "a", started_at: t, finished_at: t + 60_000 });
    const second = since + 4 * HOUR + tol + 60_000;
    for (let t = second; t < second + 4 * HOUR; t += 60_000) rows.push({ account_id: "a", started_at: t, finished_at: t + 60_000 });
    // One session left open for 10 hours counts for at most 15 minutes.
    rows.push({ account_id: "b", started_at: since + DAY, finished_at: since + DAY + 10 * HOUR });
    expect(findBotLike(rows, since, NOW, p)).toEqual([]);

    // Same blocks with a gap just under the tolerance: one 8h stretch.
    const joined = rows.filter((r) => r.account_id === "a").map((r) =>
      r.started_at >= second ? { ...r, started_at: r.started_at - 120_000, finished_at: r.finished_at! - 120_000 } : r);
    const [hit] = findBotLike(joined, since, NOW, p);
    expect(hit.longestStretchMs).toBeGreaterThan(8 * HOUR - 5 * 60_000);
  });

  it("flags 18h of play inside 24h even when no single stretch reaches 6h", () => {
    const since = NOW - 7 * DAY;
    const rows = [] as Array<{ account_id: string; started_at: number; finished_at: number | null }>;
    // Five 4h blocks separated by 30-minute breaks: 20h of play in 22h.
    for (let block = 0; block < 5; block++) {
      const start = since + block * (4.5 * HOUR);
      for (let t = start; t < start + 4 * HOUR; t += 60_000) rows.push({ account_id: "a", started_at: t, finished_at: t + 60_000 });
    }
    const [hit] = findBotLike(rows, since, NOW, p);
    expect(hit.longestStretchMs).toBeLessThan(THRESHOLDS.stretchMs);
    expect(hit.busiest24hMs).toBeGreaterThanOrEqual(THRESHOLDS.dailyMs);
  });

  it("counts mutations in masks past 32 bits", () => {
    expect(mutationCount(55_328)).toBe(5);
    expect(mutationCount(2 ** 40 + 1)).toBe(2);
    expect(mutationCount(null)).toBe(0);
  });

  it("escapes player names in the HTML and only emails when fully configured", async () => {
    const { db, raw } = openSchemaDb();
    seedAccount(raw, "x", "<b>evil</b>", NOW - 100 * DAY);
    seedAccount(raw, "y", "Buyer", NOW - 100 * DAY);
    seedTrade(raw, { creator: "x", fulfiller: "y", key: "ZombieActorMummy", price: 1, at: NOW - DAY });

    const log = vi.fn();
    const unsent = await runOversightReport({ DB: db }, NOW, log);
    expect(log).toHaveBeenCalledWith("oversight_report_unsent", expect.objectContaining({ lowPriceSpecials: 1 }), "warn");
    expect(renderHtml(unsent!)).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(renderHtml(unsent!)).not.toContain("<b>evil");
    expect(renderText(unsent!)).toContain("Special zombies sold cheaply (1)");

    const send = vi.fn(async () => ({ messageId: "m1" }));
    await runOversightReport(
      { DB: db, REPORT_EMAIL: { send } as unknown as SendEmail, REPORT_EMAIL_TO: "owner@example.test", REPORT_EMAIL_FROM: "reports@example.test" },
      NOW, log
    );
    expect(send).toHaveBeenCalledTimes(1);
    const msg = (send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string; html: string }])[0];
    expect(msg.to).toBe("owner@example.test");
    expect(msg.subject).toBe(reportSubject(unsent!));
    expect(msg.text.length).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith("oversight_report_sent", expect.objectContaining({ messageId: "m1" }), "info");
  });
});
