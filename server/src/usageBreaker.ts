// Usage breaker: the spending cap Cloudflare does not offer.
//
// Workers Paid has no hard spend limit, and Cloudflare's budget alerts only email, a
// day late. This runs on the hourly cron, asks Cloudflare's GraphQL analytics for the
// WHOLE account's billable usage (every Worker and every D1 database — staging bills
// to the same account), estimates this billing cycle's overage in dollars, and checks
// the last hour for a write spike.
//
// Modes (USAGE_BREAKER_MODE):
//   "off"      — does nothing.
//   "observe"  — (the deployed default) logs the estimate every run, and an `alert`
//                line when a limit is crossed. Never touches the game.
//   "enforce"  — on a crossed limit, flips service_state to `export_only`: players can
//                still sign in and load their farm, but every gameplay write stops,
//                which is where the money is. It only ever TIGHTENS (never touches
//                `export_only`/`closed`) and never reopens — the operator does that.
//
// Needs USAGE_BREAKER_TOKEN (a Worker secret: an API token with Account Analytics:Read
// only) and CF_ACCOUNT_ID. Without them it logs `usage_breaker_unconfigured` and stops.
// Analytics failures are FAIL OPEN, like serviceState: a broken analytics API must
// never close the game.

import type { Bindings } from "./env";
import { readServiceState, resetServiceStateCache } from "./serviceState";

/** Workers Paid allowances and overage prices, per billing cycle (2026 list prices). */
export const PRICING = {
  requests: { included: 10_000_000, usdPerMillion: 0.30 },
  cpuMs: { included: 30_000_000, usdPerMillion: 0.02 },
  d1RowsRead: { included: 25_000_000_000, usdPerMillion: 0.001 },
  d1RowsWritten: { included: 50_000_000, usdPerMillion: 1.00 },
} as const;

/** Defaults when the vars are unset. Beta ran at ~$0 overage and ~16k rows written an
 *  hour, so both sit far above normal play. */
export const DEFAULT_MONTHLY_USD = 50;
export const DEFAULT_HOURLY_ROWS_WRITTEN = 1_000_000;

export interface UsageTotals {
  requests: number;
  cpuMs: number;
  d1RowsRead: number;
  d1RowsWritten: number;
}

export interface BreakerConfig {
  mode: "off" | "observe" | "enforce";
  monthlyUsd: number;
  hourlyRowsWritten: number;
  cycleDay: number;
}

export function breakerConfig(env: Partial<Bindings>): BreakerConfig {
  const mode = env.USAGE_BREAKER_MODE === "enforce" || env.USAGE_BREAKER_MODE === "observe"
    ? env.USAGE_BREAKER_MODE : "off";
  const positive = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const day = Math.floor(Number(env.USAGE_BREAKER_CYCLE_DAY));
  return {
    mode,
    monthlyUsd: positive(env.USAGE_BREAKER_MONTHLY_USD, DEFAULT_MONTHLY_USD),
    hourlyRowsWritten: positive(env.USAGE_BREAKER_HOURLY_ROWS_WRITTEN, DEFAULT_HOURLY_ROWS_WRITTEN),
    cycleDay: day >= 1 && day <= 28 ? day : 1,
  };
}

/** Estimated usage charges above the plan's included amounts, in dollars. */
export function estimateOverageUsd(t: UsageTotals): number {
  let usd = 0;
  for (const key of Object.keys(PRICING) as (keyof UsageTotals)[]) {
    const { included, usdPerMillion } = PRICING[key];
    usd += Math.max(0, t[key] - included) / 1e6 * usdPerMillion;
  }
  return usd;
}

/** Start of the current billing cycle (UTC midnight on `cycleDay`). */
export function cycleStart(now: number, cycleDay: number): Date {
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (d.getUTCDate() < cycleDay) m -= 1;
  if (m < 0) { m = 11; y -= 1; }
  return new Date(Date.UTC(y, m, cycleDay));
}

export interface BreakerDecision {
  trip: boolean;
  reasons: string[];
  overageUsd: number;
}

export function decide(cycle: UsageTotals, lastHourRowsWritten: number, cfg: BreakerConfig): BreakerDecision {
  const overageUsd = estimateOverageUsd(cycle);
  const reasons: string[] = [];
  if (overageUsd >= cfg.monthlyUsd) {
    reasons.push(`cycle overage ~$${overageUsd.toFixed(2)} >= $${cfg.monthlyUsd}`);
  }
  if (lastHourRowsWritten >= cfg.hourlyRowsWritten) {
    reasons.push(`${lastHourRowsWritten} D1 rows written in an hour >= ${cfg.hourlyRowsWritten}`);
  }
  return { trip: reasons.length > 0, reasons, overageUsd };
}

type Fetch = typeof fetch;

/** RFC 3339 without milliseconds, the form the analytics API documents. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/.d{3}Z$/, "Z");

interface GraphqlAccount {
  workersInvocationsAdaptive: { sum: { requests: number; cpuTimeUs: number } }[];
  cycleD1: { sum: { rowsRead: number; rowsWritten: number } }[];
  hourD1: { dimensions: { datetimeHour: string }; sum: { rowsWritten: number } }[];
}

/** One GraphQL round trip: cycle-to-date totals for the whole account, plus D1 rows
 *  written per hour over the last two hours (the latest is usually still ingesting,
 *  so the larger of the two is used — an undercount only ever delays a trip). */
export async function fetchUsage(
  accountId: string, token: string, now: number, cycleDay: number, fetchFn: Fetch = fetch
): Promise<{ cycle: UsageTotals; lastHourRowsWritten: number }> {
  const from = iso(cycleStart(now, cycleDay).getTime());
  const to = iso(now);
  const hourFrom = iso(Math.floor(now / 3_600_000) * 3_600_000 - 2 * 3_600_000);
  const query = `query { viewer { accounts(filter: {accountTag: "${accountId}"}) {
    workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${from}", datetime_lt: "${to}" }) {
      sum { requests cpuTimeUs } }
    cycleD1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetimeHour_geq: "${from}", datetimeHour_lt: "${to}" }) {
      sum { rowsRead rowsWritten } }
    hourD1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { datetimeHour_geq: "${hourFrom}", datetimeHour_lt: "${to}" }) {
      dimensions { datetimeHour } sum { rowsWritten } }
  } } }`;
  const res = await fetchFn("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json() as {
    data?: { viewer?: { accounts?: GraphqlAccount[] } };
    errors?: { message: string }[] | null;
  };
  if (!res.ok || body.errors?.length) {
    throw new Error(body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`);
  }
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error("no account in analytics response");
  const cycle: UsageTotals = { requests: 0, cpuMs: 0, d1RowsRead: 0, d1RowsWritten: 0 };
  for (const row of account.workersInvocationsAdaptive) {
    cycle.requests += row.sum.requests;
    cycle.cpuMs += row.sum.cpuTimeUs / 1000;
  }
  for (const row of account.cycleD1) {
    cycle.d1RowsRead += row.sum.rowsRead;
    cycle.d1RowsWritten += row.sum.rowsWritten;
  }
  const perHour = new Map<string, number>();
  for (const row of account.hourD1) {
    const h = row.dimensions.datetimeHour;
    perHour.set(h, (perHour.get(h) ?? 0) + row.sum.rowsWritten);
  }
  return { cycle, lastHourRowsWritten: Math.max(0, ...perHour.values()) };
}

export const BREAKER_NOTICE =
  "Online Farm is paused for maintenance. Your farm is safe — check back soon.";

type Log = (event: string, detail: Record<string, unknown>, lvl: "info" | "warn" | "alert") => void;

/** The hourly run. Returns what it did, for the log line and the tests. */
export async function runUsageBreaker(
  env: Bindings, now: number, log: Log, fetchFn: Fetch = fetch
): Promise<"off" | "unconfigured" | "error" | "ok" | "would_trip" | "tripped" | "already_restricted"> {
  const cfg = breakerConfig(env);
  if (cfg.mode === "off") return "off";
  if (!env.USAGE_BREAKER_TOKEN || !env.CF_ACCOUNT_ID) {
    log("usage_breaker_unconfigured", { mode: cfg.mode }, "warn");
    return "unconfigured";
  }
  let usage;
  try {
    usage = await fetchUsage(env.CF_ACCOUNT_ID, env.USAGE_BREAKER_TOKEN, now, cfg.cycleDay, fetchFn);
  } catch (err) {
    log("usage_breaker_error", { message: String((err as Error)?.message ?? err).slice(0, 200) }, "warn");
    return "error";
  }
  const d = decide(usage.cycle, usage.lastHourRowsWritten, cfg);
  const detail = {
    mode: cfg.mode,
    overageUsd: Math.round(d.overageUsd * 100) / 100,
    limitUsd: cfg.monthlyUsd,
    lastHourRowsWritten: usage.lastHourRowsWritten,
    limitHourlyRows: cfg.hourlyRowsWritten,
    ...usage.cycle,
  };
  if (!d.trip) {
    log("usage_breaker", detail, "info");
    return "ok";
  }
  if (cfg.mode === "observe") {
    log("usage_breaker_would_trip", { ...detail, reasons: d.reasons }, "alert");
    return "would_trip";
  }
  resetServiceStateCache();
  const state = await readServiceState(env.DB, now);
  if (state.mode === "export_only" || state.mode === "closed") {
    log("usage_breaker_tripped", { ...detail, reasons: d.reasons, already: state.mode }, "alert");
    return "already_restricted";
  }
  // Conditional on the mode we just read, so an operator's concurrent change wins.
  await env.DB.prepare(
    "UPDATE service_state SET mode = 'export_only', notice = ?, updated_at = ? WHERE id = 1 AND mode = ?"
  ).bind(BREAKER_NOTICE, now, state.mode).run();
  log("usage_breaker_tripped", { ...detail, reasons: d.reasons, from: state.mode }, "alert");
  return "tripped";
}
