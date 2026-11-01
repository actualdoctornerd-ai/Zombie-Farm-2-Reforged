import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREAKER_NOTICE,
  breakerConfig,
  cycleStart,
  decide,
  estimateOverageUsd,
  runUsageBreaker,
} from "../src/usageBreaker";
import { resetServiceStateCache } from "../src/serviceState";
import type { Bindings } from "../src/env";

const NOW = Date.parse("2026-10-20T12:30:00Z");
const quiet = { requests: 2_000_000, cpuMs: 20_000_000, d1RowsRead: 1e9, d1RowsWritten: 10_000_000 };

/** A service_state row in `mode`, recording every UPDATE it is sent. */
function fakeDb(mode: string) {
  const updates: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) { args = a; return this; },
        async first() { return { mode, notice: null, updated_at: 0 }; },
        async run() {
          if (sql.startsWith("UPDATE")) updates.push(args);
          return { meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, updates };
}

function analytics(cycle: typeof quiet, hourRows: number[]) {
  return vi.fn(async () => new Response(JSON.stringify({
    data: { viewer: { accounts: [{
      workersInvocationsAdaptive: [{ sum: { requests: cycle.requests, cpuTimeUs: cycle.cpuMs * 1000 } }],
      cycleD1: [{ sum: { rowsRead: cycle.d1RowsRead, rowsWritten: cycle.d1RowsWritten } }],
      hourD1: hourRows.map((rowsWritten, i) => ({
        dimensions: { datetimeHour: `2026-10-20T1${i}:00:00Z` }, sum: { rowsWritten },
      })),
    }] } },
    errors: null,
  }))) as unknown as typeof fetch;
}

function env(mode: string, db: D1Database, extra: Partial<Bindings> = {}): Bindings {
  return {
    DB: db, USAGE_BREAKER_MODE: mode, USAGE_BREAKER_TOKEN: "t", CF_ACCOUNT_ID: "acct", ...extra,
  } as unknown as Bindings;
}

beforeEach(() => resetServiceStateCache());

describe("usage breaker maths", () => {
  it("charges nothing inside the plan allowances", () => {
    expect(estimateOverageUsd(quiet)).toBe(0);
  });

  it("prices each overage at the list rate", () => {
    // 10M rows written over the 50M allowance at $1/M, plus 10M requests at $0.30/M.
    expect(estimateOverageUsd({ ...quiet, d1RowsWritten: 60_000_000, requests: 20_000_000 }))
      .toBeCloseTo(13, 5);
  });

  it("finds the start of the billing cycle", () => {
    expect(cycleStart(NOW, 1).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(cycleStart(NOW, 25).toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(cycleStart(Date.parse("2026-01-03T00:00:00Z"), 5).toISOString()).toBe("2025-12-05T00:00:00.000Z");
  });

  it("is off unless a mode is set, and ignores nonsense limits", () => {
    expect(breakerConfig({}).mode).toBe("off");
    expect(breakerConfig({ USAGE_BREAKER_MODE: "panic" }).mode).toBe("off");
    const cfg = breakerConfig({ USAGE_BREAKER_MODE: "observe", USAGE_BREAKER_MONTHLY_USD: "-3", USAGE_BREAKER_CYCLE_DAY: "31" });
    expect(cfg).toMatchObject({ mode: "observe", monthlyUsd: 50, cycleDay: 1 });
  });

  it("trips on either the dollar estimate or an hourly write spike", () => {
    const cfg = breakerConfig({ USAGE_BREAKER_MODE: "enforce" });
    expect(decide(quiet, 20_000, cfg).trip).toBe(false);
    expect(decide({ ...quiet, d1RowsWritten: 100_000_000 }, 0, cfg).trip).toBe(true);
    expect(decide(quiet, 1_000_000, cfg).trip).toBe(true);
  });
});

describe("runUsageBreaker", () => {
  const log = vi.fn();
  beforeEach(() => log.mockReset());

  it("does nothing at all when off", async () => {
    const { db, updates } = fakeDb("open");
    const fetchFn = analytics(quiet, [5_000_000]);
    expect(await runUsageBreaker(env("off", db), NOW, log, fetchFn)).toBe("off");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("logs and stops when the token is missing", async () => {
    const { db } = fakeDb("open");
    const e = env("enforce", db, { USAGE_BREAKER_TOKEN: undefined });
    expect(await runUsageBreaker(e, NOW, log, analytics(quiet, []))).toBe("unconfigured");
  });

  it("fails OPEN when the analytics API errors", async () => {
    const { db, updates } = fakeDb("open");
    const broken = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 400 })) as unknown as typeof fetch;
    expect(await runUsageBreaker(env("enforce", db), NOW, log, broken)).toBe("error");
    expect(updates).toEqual([]);
  });

  it("observe never touches the game, even over the limit", async () => {
    const { db, updates } = fakeDb("open");
    expect(await runUsageBreaker(env("observe", db), NOW, log, analytics(quiet, [3_000_000]))).toBe("would_trip");
    expect(updates).toEqual([]);
    expect(log).toHaveBeenCalledWith("usage_breaker_would_trip", expect.anything(), "alert");
  });

  it("enforce leaves a quiet account alone", async () => {
    const { db, updates } = fakeDb("open");
    expect(await runUsageBreaker(env("enforce", db), NOW, log, analytics(quiet, [10_000, 20_000]))).toBe("ok");
    expect(updates).toEqual([]);
  });

  it("enforce flips open -> export_only on a spike, conditional on the mode it read", async () => {
    const { db, updates } = fakeDb("open");
    expect(await runUsageBreaker(env("enforce", db), NOW, log, analytics(quiet, [10_000, 2_000_000]))).toBe("tripped");
    expect(updates).toEqual([[BREAKER_NOTICE, NOW, "open"]]);
  });

  it("never loosens a mode the operator already tightened", async () => {
    for (const mode of ["export_only", "closed"]) {
      resetServiceStateCache();
      const { db, updates } = fakeDb(mode);
      expect(await runUsageBreaker(env("enforce", db), NOW, log, analytics(quiet, [5_000_000]))).toBe("already_restricted");
      expect(updates).toEqual([]);
    }
  });
});

describe("cron wiring", () => {
  it("the cleanup cron string in index.ts is one of the crons in both environments", () => {
    const cron = /const CLEANUP_CRON = "([^"]+)"/.exec(readFileSync("src/index.ts", "utf8"))?.[1];
    expect(cron).toBeTruthy();
    const lists = [...readFileSync("wrangler.toml", "utf8").matchAll(/^crons = \[(.*)\]$/gm)].map((m) => m[1]);
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toContain(`"${cron}"`);
  });
});
