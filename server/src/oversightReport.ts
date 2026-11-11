// Weekly oversight report: Black Market abuse signals + bot-like play.
//
// READ-ONLY and report-only (owner, 2026-11-11): nothing here acts on an account. It
// exists because two round-the-clock accounts were found supplying most of the market's
// rare zombies and moving millions of gold between themselves through junk-zombie sales;
// the owner wants to SEE that shape every week before deciding on any rule.
//
// Four sections, all over the 7 days before `now`:
//   1. Special zombies sold far below their going price (dumping / rarity damage).
//   2. Large transfers — big prices, flagged when the zombie is cheap for the price
//      (value moved through a junk sale) or a party is a young account; plus pairs of
//      accounts whose trades add up to a lot.
//   3. Top sellers and what they earned.
//   4. Bot-like play: 6h+ of continuous fighting, or 18h+ of fighting in any 24h.
//
// The cron in index.ts runs it weekly and emails it when the REPORT_EMAIL binding and
// REPORT_EMAIL_TO/REPORT_EMAIL_FROM vars exist; otherwise it only logs the counts.
//
// D1 cost: raid_sessions_v3 has no started_at index, so the activity query full-scans it
// (~90k rows, it is pruned to 30 days by the daily cleanup). It selects three integer
// columns only — json_extract or the result blobs over that scan is what blows D1's CPU
// limit (see prod D1 notes) — and every other table read here is small.

import zombieRows from "../../public/assets/zombies.json";
import { levelForXp } from "./levels";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REPORT_WINDOW_MS = 7 * DAY;
/** How far back the "going price" of a species is measured. */
export const PRICE_REFERENCE_MS = 90 * DAY;

// ---- thresholds (tune here; the email states each one) --------------------------------
export const THRESHOLDS = {
  /** A special sold at or below this fraction of its species' median price. */
  lowPriceFraction: 0.1,
  /** ...or at/below this gold price regardless of the median (catches 1-gold giveaways of
   *  species with no median yet). Brains have no absolute floor: specials routinely
   *  trade at 1-2 brains, so a floor there flagged ordinary trades (first prod run). */
  lowPriceGold: 100,
  /** Medians need at least this many trades of the species in that currency. */
  medianMinTrades: 3,
  /** A single trade at or above this is a "large transfer". */
  largeGold: 250_000,
  largeBrains: 50,
  /** Paying this multiple of the species' median marks the zombie as cheap for the price. */
  overpayMultiple: 10,
  /** Accounts younger than this at trade time are flagged. */
  youngAccountMs: 14 * DAY,
  /** A seller->buyer pair is listed when its week adds up to this, or this many trades. */
  pairGold: 500_000,
  pairBrains: 100,
  pairTrades: 10,
  /** Bot-like: breaks up to this long do not end a stretch of play. */
  breakToleranceMs: 15 * 60_000,
  /** One fight never counts for longer than this (an abandoned session can sit open for hours). */
  maxFightMs: 15 * 60_000,
  /** Flag a stretch this long... */
  stretchMs: 6 * HOUR,
  /** ...or this much play inside any 24 hours. */
  dailyMs: 18 * HOUR,
  topSellers: 10,
} as const;

const SPECIAL_ZOMBIES: ReadonlySet<string> = new Set(
  (zombieRows as Array<{ key: string; category?: string }>)
    .filter((zombie) => zombie.category === "special")
    .map((zombie) => zombie.key)
);

export function isSpecialZombie(key: string): boolean {
  return SPECIAL_ZOMBIES.has(key);
}

// ---- raw rows -----------------------------------------------------------------------

export interface TradeRow {
  id: string;
  kind: "BUY_ZOMBIE" | "SELL_ZOMBIE";
  zombie_key: string;
  price: number;
  currency: "GOLD" | "BRAINS";
  closed_at: number;
  creator_account_id: string;
  fulfilled_by_account_id: string | null;
  delivered_mutation: number | null;
}

export interface ActivityRow {
  account_id: string;
  started_at: number;
  finished_at: number | null;
}

export interface AccountRow {
  id: string;
  username: string | null;
  created_at: number;
  xp: number | null;
}

export interface ReportData {
  trades: TradeRow[];
  activity: ActivityRow[];
  accounts: AccountRow[];
}

/** The SQL, exported so the same text can be run by hand against prod when checking. */
export const TRADES_SQL = `SELECT id, kind, zombie_key, price_brains AS price, currency, closed_at,
  creator_account_id, fulfilled_by_account_id, delivered_mutation
  FROM black_market_orders WHERE status = 'FULFILLED' AND closed_at >= ?`;
export const ACTIVITY_SQL = `SELECT account_id, started_at, finished_at FROM raid_sessions_v3 WHERE started_at >= ?
  UNION ALL
  SELECT account_id, started_at, finished_at FROM epic_boss_sessions_v3 WHERE started_at >= ?`;
export const ACCOUNTS_SQL = `SELECT a.id, a.username, a.created_at, b.xp
  FROM accounts a LEFT JOIN balances b ON b.account_id = a.id`;

export async function loadReportData(db: D1Database, now: number): Promise<ReportData> {
  const since = now - REPORT_WINDOW_MS;
  const [trades, activity, accounts] = await Promise.all([
    db.prepare(TRADES_SQL).bind(now - PRICE_REFERENCE_MS).all<TradeRow>(),
    db.prepare(ACTIVITY_SQL).bind(since, since).all<ActivityRow>(),
    db.prepare(ACCOUNTS_SQL).all<AccountRow>(),
  ]);
  return {
    trades: trades.results ?? [],
    activity: activity.results ?? [],
    accounts: accounts.results ?? [],
  };
}

// ---- report shape -------------------------------------------------------------------

export interface Party {
  id: string;
  name: string;
  level: number | null;
  ageDays: number | null;
}

export interface TradeLine {
  orderId: string;
  at: number;
  seller: Party;
  buyer: Party;
  zombie: string;
  special: boolean;
  mutations: number;
  price: number;
  currency: "GOLD" | "BRAINS";
  /** The species' median price in this currency over the reference window, if known. */
  median: number | null;
  /** price / median. */
  ratio: number | null;
  reasons: string[];
}

export interface PairLine {
  seller: Party;
  buyer: Party;
  currency: "GOLD" | "BRAINS";
  trades: number;
  total: number;
}

export interface SellerLine {
  seller: Party;
  gold: number;
  brains: number;
  trades: number;
  buyers: number;
  goldShare: number;
}

export interface BotLine {
  account: Party;
  fights: number;
  longestStretchMs: number;
  longestStretchStart: number;
  longestStretchEnd: number;
  stretchesOverLimit: number;
  busiest24hMs: number;
  busiest24hStart: number;
  /** Distinct clock hours with a fight, out of the 168 in the week. */
  hoursActive: number;
}

export interface OversightReport {
  generatedAt: number;
  since: number;
  until: number;
  market: { trades: number; gold: number; brains: number; sellers: number };
  lowPriceSpecials: TradeLine[];
  largeTransfers: TradeLine[];
  heavyPairs: PairLine[];
  topSellers: SellerLine[];
  botLike: BotLine[];
}

// ---- analysis (pure) ----------------------------------------------------------------

/** Number of mutations in a mask. Masks run to 53 bits, so no 32-bit bitwise ops. */
export function mutationCount(mask: number | null): number {
  if (!mask || mask < 0) return 0;
  let count = 0;
  for (const digit of Math.trunc(mask).toString(2)) if (digit === "1") count++;
  return count;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A SELL post is paid by its fulfiller; a BUY request pays whoever fills it. */
function sellerOf(t: TradeRow): string | null {
  return t.kind === "SELL_ZOMBIE" ? t.creator_account_id : t.fulfilled_by_account_id;
}
function buyerOf(t: TradeRow): string | null {
  return t.kind === "SELL_ZOMBIE" ? t.fulfilled_by_account_id : t.creator_account_id;
}

export function buildReport(data: ReportData, now: number): OversightReport {
  const since = now - REPORT_WINDOW_MS;
  const T = THRESHOLDS;
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const party = (id: string | null, at: number): Party => {
    const a = id ? accounts.get(id) : undefined;
    return {
      id: id ?? "",
      name: a?.username || (id ? `(${id.slice(0, 8)})` : "(deleted)"),
      level: a?.xp == null ? null : levelForXp(a.xp),
      ageDays: a ? Math.floor((at - a.created_at) / DAY) : null,
    };
  };

  // Going price per species and currency, over the whole reference window.
  const pricesByKind = new Map<string, number[]>();
  for (const t of data.trades) {
    const k = `${t.zombie_key}|${t.currency}`;
    const list = pricesByKind.get(k) ?? [];
    list.push(t.price);
    pricesByKind.set(k, list);
  }
  const medians = new Map<string, number>();
  for (const [k, list] of pricesByKind) {
    if (list.length >= T.medianMinTrades) medians.set(k, median(list));
  }

  const week = data.trades.filter((t) => t.closed_at >= since && t.closed_at < now);
  const line = (t: TradeRow, reasons: string[]): TradeLine => {
    const med = medians.get(`${t.zombie_key}|${t.currency}`) ?? null;
    return {
      orderId: t.id,
      at: t.closed_at,
      seller: party(sellerOf(t), t.closed_at),
      buyer: party(buyerOf(t), t.closed_at),
      zombie: t.zombie_key.replace(/^ZombieActor/, ""),
      special: isSpecialZombie(t.zombie_key),
      mutations: mutationCount(t.delivered_mutation),
      price: t.price,
      currency: t.currency,
      median: med,
      ratio: med ? t.price / med : null,
      reasons,
    };
  };
  const isYoung = (p: Party) => p.ageDays != null && p.ageDays * DAY < T.youngAccountMs;

  // 1. Specials far below their going price.
  const lowPriceSpecials: TradeLine[] = [];
  for (const t of week) {
    if (!isSpecialZombie(t.zombie_key)) continue;
    const med = medians.get(`${t.zombie_key}|${t.currency}`);
    const reasons: string[] = [];
    if (t.currency === "GOLD" && t.price <= T.lowPriceGold) reasons.push(`at or below ${T.lowPriceGold} gold`);
    if (med && t.price <= med * T.lowPriceFraction) reasons.push(`${Math.round((t.price / med) * 100)}% of median`);
    if (reasons.length) lowPriceSpecials.push(line(t, reasons));
  }
  lowPriceSpecials.sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0) || a.at - b.at);

  // 2. Large single transfers.
  const largeTransfers: TradeLine[] = [];
  for (const t of week) {
    const big = t.currency === "GOLD" ? t.price >= T.largeGold : t.price >= T.largeBrains;
    if (!big) continue;
    const l = line(t, []);
    if (l.ratio != null && l.ratio >= T.overpayMultiple) l.reasons.push(`${Math.round(l.ratio)}x the median`);
    if (!l.special && l.mutations === 0) l.reasons.push("plain non-special zombie");
    if (isYoung(l.seller)) l.reasons.push(`seller ${l.seller.ageDays}d old`);
    if (isYoung(l.buyer)) l.reasons.push(`buyer ${l.buyer.ageDays}d old`);
    largeTransfers.push(l);
  }
  // Suspicious ones first, then by size.
  largeTransfers.sort((a, b) => b.reasons.length - a.reasons.length || b.price - a.price);

  // 2b. Pairs that add up.
  const pairs = new Map<string, { s: string | null; b: string | null; currency: "GOLD" | "BRAINS"; trades: number; total: number; last: number }>();
  for (const t of week) {
    const s = sellerOf(t);
    const b = buyerOf(t);
    const k = `${s}|${b}|${t.currency}`;
    const p = pairs.get(k) ?? { s, b, currency: t.currency, trades: 0, total: 0, last: 0 };
    p.trades++;
    p.total += t.price;
    p.last = Math.max(p.last, t.closed_at);
    pairs.set(k, p);
  }
  const heavyPairs: PairLine[] = [...pairs.values()]
    .filter((p) => p.trades >= T.pairTrades || p.total >= (p.currency === "GOLD" ? T.pairGold : T.pairBrains))
    .map((p) => ({ seller: party(p.s, p.last), buyer: party(p.b, p.last), currency: p.currency, trades: p.trades, total: p.total }))
    .sort((a, b) => (a.currency === b.currency ? b.total - a.total : a.currency === "GOLD" ? -1 : 1));

  // 3. Top sellers.
  const sellers = new Map<string, { gold: number; brains: number; trades: number; buyers: Set<string> }>();
  let weekGold = 0;
  let weekBrains = 0;
  for (const t of week) {
    if (t.currency === "GOLD") weekGold += t.price;
    else weekBrains += t.price;
    const s = sellerOf(t);
    if (!s) continue;
    const e = sellers.get(s) ?? { gold: 0, brains: 0, trades: 0, buyers: new Set<string>() };
    if (t.currency === "GOLD") e.gold += t.price;
    else e.brains += t.price;
    e.trades++;
    const b = buyerOf(t);
    if (b) e.buyers.add(b);
    sellers.set(s, e);
  }
  const topSellers: SellerLine[] = [...sellers.entries()]
    .map(([id, e]) => ({
      seller: party(id, now), gold: e.gold, brains: e.brains, trades: e.trades,
      buyers: e.buyers.size, goldShare: weekGold ? e.gold / weekGold : 0,
    }))
    .sort((a, b) => b.gold - a.gold || b.brains - a.brains)
    .slice(0, T.topSellers);

  return {
    generatedAt: now,
    since,
    until: now,
    market: { trades: week.length, gold: weekGold, brains: weekBrains, sellers: sellers.size },
    lowPriceSpecials,
    largeTransfers,
    heavyPairs,
    topSellers,
    botLike: findBotLike(data.activity, since, now, party),
  };
}

/** Merge each account's fights into stretches of play (breaks up to the tolerance do
 *  not split a stretch), then flag 6h+ stretches and 18h+ inside any 24 hours. */
export function findBotLike(
  activity: ActivityRow[],
  since: number,
  now: number,
  party: (id: string, at: number) => Party
): BotLine[] {
  const T = THRESHOLDS;
  const byAccount = new Map<string, Array<[number, number]>>();
  for (const row of activity) {
    if (row.started_at < since || row.started_at >= now) continue;
    const end = Math.min(Math.max(row.finished_at ?? row.started_at, row.started_at), row.started_at + T.maxFightMs);
    const list = byAccount.get(row.account_id) ?? [];
    list.push([row.started_at, end]);
    byAccount.set(row.account_id, list);
  }
  const out: BotLine[] = [];
  for (const [id, fights] of byAccount) {
    fights.sort((a, b) => a[0] - b[0]);
    const stretches: Array<[number, number]> = [];
    for (const [s, e] of fights) {
      const last = stretches[stretches.length - 1];
      if (last && s - last[1] <= T.breakToleranceMs) last[1] = Math.max(last[1], e);
      else stretches.push([s, e]);
    }
    let longest: [number, number] = stretches[0];
    let over = 0;
    for (const st of stretches) {
      if (st[1] - st[0] > longest[1] - longest[0]) longest = st;
      if (st[1] - st[0] >= T.stretchMs) over++;
    }
    // Busiest 24h: windows starting at each stretch start are enough (the sum only
    // changes where a stretch begins).
    let busiest = 0;
    let busiestStart = stretches[0][0];
    for (const [ws] of stretches) {
      const we = ws + DAY;
      let total = 0;
      for (const [s, e] of stretches) {
        if (s >= we) break;
        total += Math.max(0, Math.min(e, we) - Math.max(s, ws));
      }
      if (total > busiest) { busiest = total; busiestStart = ws; }
    }
    const longestMs = longest[1] - longest[0];
    if (longestMs < T.stretchMs && busiest < T.dailyMs) continue;
    const hours = new Set(fights.map(([s]) => Math.floor(s / HOUR)));
    out.push({
      account: party(id, now),
      fights: fights.length,
      longestStretchMs: longestMs,
      longestStretchStart: longest[0],
      longestStretchEnd: longest[1],
      stretchesOverLimit: over,
      busiest24hMs: busiest,
      busiest24hStart: busiestStart,
      hoursActive: hours.size,
    });
  }
  return out.sort((a, b) => b.busiest24hMs - a.busiest24hMs || b.longestStretchMs - a.longestStretchMs);
}

// ---- rendering ----------------------------------------------------------------------

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtHours = (ms: number) => `${(ms / HOUR).toFixed(1)}h`;
const fmtWhen = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
const fmtDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const fmtPrice = (n: number, currency: "GOLD" | "BRAINS") => `${fmtNum(n)} ${currency === "GOLD" ? "gold" : "brains"}`;
const fmtParty = (p: Party) => `${p.name}${p.level != null ? ` (L${p.level})` : ""}`;

export function reportSubject(r: OversightReport): string {
  return `Zombie Farm weekly report ${fmtDay(r.since)} to ${fmtDay(r.until)}: `
    + `${r.botLike.length} bot-like, ${r.lowPriceSpecials.length} cheap specials, `
    + `${r.largeTransfers.filter((t) => t.reasons.length).length} flagged transfers`;
}

interface Table { title: string; note: string; head: string[]; rows: string[][]; empty: string }

function tables(r: OversightReport): Table[] {
  const T = THRESHOLDS;
  const tradeRow = (t: TradeLine) => [
    fmtWhen(t.at), fmtParty(t.seller), fmtParty(t.buyer),
    `${t.zombie}${t.special ? " *" : ""}${t.mutations ? ` +${t.mutations} mut` : ""}`,
    fmtPrice(t.price, t.currency), t.median != null ? fmtPrice(t.median, t.currency) : "-",
    t.reasons.join("; ") || "-",
  ];
  const tradeHead = ["When (UTC)", "Seller", "Buyer", "Zombie", "Price", "Median", "Why"];
  return [
    {
      title: "Bot-like play",
      note: `Accounts with ${fmtHours(T.stretchMs)}+ of fighting with no break over ${T.breakToleranceMs / 60_000} min, or ${fmtHours(T.dailyMs)}+ of fighting inside any 24 hours. Counts invasions and Epic Boss fights.`,
      head: ["Account", "Fights", "Longest stretch", "Stretches 6h+", "Busiest 24h", "Hours active / 168"],
      rows: r.botLike.map((b) => [
        fmtParty(b.account), fmtNum(b.fights),
        `${fmtHours(b.longestStretchMs)} (${fmtWhen(b.longestStretchStart)} to ${fmtWhen(b.longestStretchEnd)})`,
        String(b.stretchesOverLimit), `${fmtHours(b.busiest24hMs)} from ${fmtWhen(b.busiest24hStart)}`, String(b.hoursActive),
      ]),
      empty: "No account crossed either line this week.",
    },
    {
      title: "Special zombies sold cheaply",
      note: `Specials (*) sold at or below ${Math.round(T.lowPriceFraction * 100)}% of the species' ${PRICE_REFERENCE_MS / DAY}-day median, or for ${fmtNum(T.lowPriceGold)} gold or less.`,
      head: tradeHead,
      rows: r.lowPriceSpecials.map(tradeRow),
      empty: "None this week.",
    },
    {
      title: "Large transfers",
      note: `Single trades of ${fmtNum(T.largeGold)}+ gold or ${T.largeBrains}+ brains. Flagged when the price is ${T.overpayMultiple}x+ the species' median, the zombie is a plain non-special, or an account is under ${T.youngAccountMs / DAY} days old.`,
      head: tradeHead,
      rows: r.largeTransfers.map(tradeRow),
      empty: "None this week.",
    },
    {
      title: "Account pairs trading heavily",
      note: `Seller to buyer pairs whose week totals ${fmtNum(T.pairGold)}+ gold, ${T.pairBrains}+ brains, or ${T.pairTrades}+ trades.`,
      head: ["Seller", "Buyer", "Trades", "Total"],
      rows: r.heavyPairs.map((p) => [fmtParty(p.seller), fmtParty(p.buyer), String(p.trades), fmtPrice(p.total, p.currency)]),
      empty: "None this week.",
    },
    {
      title: "Top sellers",
      note: `Market this week: ${fmtNum(r.market.trades)} trades, ${fmtNum(r.market.gold)} gold and ${fmtNum(r.market.brains)} brains, ${r.market.sellers} sellers.`,
      head: ["Seller", "Gold earned", "Share of gold", "Brains earned", "Trades", "Buyers"],
      rows: r.topSellers.map((s) => [
        fmtParty(s.seller), fmtNum(s.gold), `${Math.round(s.goldShare * 100)}%`, fmtNum(s.brains), String(s.trades), String(s.buyers),
      ]),
      empty: "No trades this week.",
    },
  ];
}

export function renderText(r: OversightReport): string {
  const out = [
    `Zombie Farm weekly report, ${fmtWhen(r.since)} to ${fmtWhen(r.until)} UTC`,
    "Report only: nothing here has been acted on.",
    "",
  ];
  for (const t of tables(r)) {
    out.push(`== ${t.title} (${t.rows.length}) ==`, t.note);
    if (!t.rows.length) out.push(t.empty);
    else {
      out.push(t.head.join(" | "));
      for (const row of t.rows) out.push(row.join(" | "));
    }
    out.push("");
  }
  return out.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderHtml(r: OversightReport): string {
  const cell = "border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top;font-size:13px";
  const parts = [
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#222">`,
    `<h2 style="margin:0 0 4px">Zombie Farm weekly report</h2>`,
    `<p style="margin:0 0 16px;color:#555">${esc(fmtWhen(r.since))} to ${esc(fmtWhen(r.until))} UTC. Report only: nothing here has been acted on.</p>`,
  ];
  for (const t of tables(r)) {
    parts.push(`<h3 style="margin:20px 0 4px">${esc(t.title)} (${t.rows.length})</h3>`, `<p style="margin:0 0 6px;color:#555;font-size:13px">${esc(t.note)}</p>`);
    if (!t.rows.length) { parts.push(`<p style="font-size:13px">${esc(t.empty)}</p>`); continue; }
    parts.push(`<table style="border-collapse:collapse"><tr>${t.head.map((h) => `<th style="${cell};background:#f2f2f2">${esc(h)}</th>`).join("")}</tr>`);
    for (const row of t.rows) parts.push(`<tr>${row.map((c) => `<td style="${cell}">${esc(c)}</td>`).join("")}</tr>`);
    parts.push("</table>");
  }
  parts.push("</div>");
  return parts.join("\n");
}

// ---- cron entry ---------------------------------------------------------------------

export interface ReportEnv {
  DB: D1Database;
  REPORT_EMAIL?: SendEmail;
  REPORT_EMAIL_TO?: string;
  REPORT_EMAIL_FROM?: string;
}

type Logger = (event: string, detail: Record<string, unknown>, lvl?: "info" | "warn" | "alert") => void;

export async function runOversightReport(env: ReportEnv, now: number, log: Logger): Promise<OversightReport | null> {
  try {
    const report = buildReport(await loadReportData(env.DB, now), now);
    const counts = {
      botLike: report.botLike.length,
      lowPriceSpecials: report.lowPriceSpecials.length,
      largeTransfers: report.largeTransfers.length,
      heavyPairs: report.heavyPairs.length,
      trades: report.market.trades,
    };
    if (!env.REPORT_EMAIL || !env.REPORT_EMAIL_TO || !env.REPORT_EMAIL_FROM) {
      log("oversight_report_unsent", { ...counts, reason: "email_not_configured" }, "warn");
      return report;
    }
    const sent = await env.REPORT_EMAIL.send({
      to: env.REPORT_EMAIL_TO,
      from: { email: env.REPORT_EMAIL_FROM, name: "Zombie Farm reports" },
      subject: reportSubject(report),
      text: renderText(report),
      html: renderHtml(report),
    });
    log("oversight_report_sent", { ...counts, messageId: sent.messageId }, "info");
    return report;
  } catch (err) {
    log("oversight_report_failed", { error: String(err) }, "alert");
    return null;
  }
}
