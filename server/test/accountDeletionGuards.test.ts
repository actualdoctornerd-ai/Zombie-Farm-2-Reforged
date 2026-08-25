// The two refusals that stand in front of the purge.
//
// `accountDeletion.test.ts` proves the purge clears the RIGHT rows. This file proves
// it does not run at the wrong TIME, which is the half that can destroy somebody
// else's property rather than merely leaving litter behind.
//
// `unsettledMarketOrders` is the load-bearing one. Deleting an account cascades its
// Black Market orders away, so a settled trade whose zombie has not been collected
// yet would take the counterparty's owed unit with it. That guard is one SQL
// predicate over four columns and had no test at all — a silent `0` from a typo, a
// renamed status or a column that stopped meaning what it meant would open exactly
// the hole the feature goes to such lengths to describe.
//
// Run against a REAL SQLite database loaded from `schema.sql`, not a stub, because
// the predicate is the thing under test: a hand-rolled fake would agree with whatever
// the query happened to say. The adapter below is the smallest shim that makes
// node:sqlite answer to the two D1 methods these functions call.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { operationInProgress, unsettledMarketOrders } from "../src/accountDeletion";

/** D1 accepts NUMBERED placeholders (`?1` reused for both sides of an OR, which is
 *  exactly what `unsettledMarketOrders` does); node:sqlite refuses to bind those
 *  positionally and throws "column index out of range". Rewriting them to repeated
 *  anonymous `?`s — and repeating the argument to match — is what lets the REAL query
 *  string run here unmodified, which is the entire value of this file. */
function toAnonymousPlaceholders(sql: string, params: unknown[]): [string, unknown[]] {
  const expanded: unknown[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, index: string) => {
    expanded.push(params[Number(index) - 1]);
    return "?";
  });
  return rewritten === sql ? [sql, params] : [rewritten, expanded];
}

/** node:sqlite behind the slice of the D1 interface these two functions use. */
function openSchemaDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          const [text, bound] = toAnonymousPlaceholders(sql, params);
          return raw.prepare(text).get(...bound) ?? null;
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, raw };
}

const NOW = 1_700_000_000_000;
const ME = "acct-leaver";
const THEM = "acct-counterparty";

function seedAccounts(raw: DatabaseSync): void {
  for (const [id, sub, code] of [[ME, "sub-me", "AAAA1111"], [THEM, "sub-them", "BBBB2222"]]) {
    raw.prepare(`INSERT INTO accounts (id, google_sub, username, friend_code, created_at, last_online_at)
      VALUES (?, ?, NULL, ?, ?, ?)`).run(id, sub, code, NOW, NOW);
  }
}

/** One Black Market order, defaulting to a healthy settled-and-collected SALE — the
 *  shape that must NOT block a deletion. Each test overrides only what it is about. */
function insertOrder(raw: DatabaseSync, over: Record<string, unknown> = {}): void {
  const row = {
    id: `order-${Math.abs(JSON.stringify(over).length)}-${JSON.stringify(over).slice(0, 24)}`,
    creator_account_id: ME,
    kind: "SELL_ZOMBIE",
    zombie_key: "ZombieActorRegularTier1",
    mutated_required: 0,
    price_brains: 25,
    currency: "BRAINS",
    status: "FULFILLED",
    created_day: 1,
    created_at: NOW,
    fulfilled_by_account_id: THEM,
    source_unit_id: "unit-1",
    escrow_mutation: 0,
    escrow_invasions: 0,
    escrow_brains: 0,
    claimed_at: NOW,
    payout_at: NOW,
    ...over,
  } as Record<string, unknown>;
  const cols = Object.keys(row);
  raw.prepare(
    `INSERT INTO black_market_orders (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  ).run(...cols.map((c) => row[c]));
}

describe("unsettledMarketOrders — what blocks a deletion", () => {
  it("counts nothing for an account with no market history at all", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    expect(await unsettledMarketOrders(db, ME)).toBe(0);
  });

  it("blocks on an OPEN order the account created, which is holding its own escrow", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, {
      kind: "BUY_ZOMBIE", status: "OPEN", source_unit_id: null, escrow_mutation: null,
      escrow_invasions: null, escrow_brains: 25, fulfilled_by_account_id: null,
      claimed_at: null, payout_at: null,
    });
    expect(await unsettledMarketOrders(db, ME)).toBe(1);
  });

  // THE CASE THE GUARD EXISTS FOR. The order row cascades with its creator, so
  // deleting here would delete the zombie the counterparty has bought and not yet
  // collected — someone else's property, destroyed by this player leaving.
  it("blocks on a FULFILLED sale whose zombie the buyer has not collected", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, { claimed_at: null });
    expect(await unsettledMarketOrders(db, ME)).toBe(1);
  });

  it("blocks the FULFILLER too, not only the creator", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, { creator_account_id: THEM, fulfilled_by_account_id: ME, claimed_at: null });
    expect(await unsettledMarketOrders(db, ME)).toBe(1);
  });

  it("lets a finished trade go — settled AND collected strands nobody", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw); // the healthy default: FULFILLED, claimed, paid out
    expect(await unsettledMarketOrders(db, ME)).toBe(0);
  });

  // Deliberate, and stated in `accountDeletion.ts`: forfeiting money owed to YOU is
  // your own choice and costs nobody else anything. Pinned so that "be safe" cannot
  // quietly widen the predicate into refusing a player who simply wants to leave.
  it("does NOT block on a payout this account has not collected — that is theirs to forfeit", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, { payout_at: null, acknowledged_at: null });
    expect(await unsettledMarketOrders(db, ME)).toBe(0);
  });

  it("ignores a CANCELLED order, whose escrow already went home", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, {
      kind: "BUY_ZOMBIE", status: "CANCELLED", source_unit_id: null, escrow_mutation: null,
      escrow_invasions: null, escrow_brains: 25, fulfilled_by_account_id: null,
      claimed_at: null, payout_at: null,
    });
    expect(await unsettledMarketOrders(db, ME)).toBe(0);
  });

  it("ignores somebody else's unsettled trade entirely", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    insertOrder(raw, { creator_account_id: THEM, fulfilled_by_account_id: null, claimed_at: null });
    expect(await unsettledMarketOrders(db, ME)).toBe(0);
  });
});

describe("operationInProgress — the batch marker, honoured with its expiry", () => {
  const seedRuntime = (raw: DatabaseSync, over: Record<string, unknown>) => {
    raw.prepare(`INSERT INTO account_runtime_v3
      (account_id, active_batch_id, active_batch_expires_at, updated_at)
      VALUES (?, ?, ?, ?)`)
      .run(ME, (over.active_batch_id ?? null) as string | null,
        (over.active_batch_expires_at ?? 0) as number, NOW);
  };

  it("is false for an account that has never run one", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    seedRuntime(raw, {});
    expect(await operationInProgress(db, ME, NOW)).toBe(false);
  });

  it("is true while a batch is genuinely live", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    seedRuntime(raw, { active_batch_id: "batch-1", active_batch_expires_at: NOW + 5_000 });
    expect(await operationInProgress(db, ME, NOW)).toBe(true);
  });

  // `active_batch_id` is never swept, so a marker left by a crashed request stays set
  // for ever. A reader that tested the id alone would lock the account out of ever
  // deleting itself — the one refusal with no way for a player to clear it.
  it("is false for an EXPIRED marker, which nothing ever sweeps", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    seedRuntime(raw, { active_batch_id: "batch-orphan", active_batch_expires_at: NOW - 1 });
    expect(await operationInProgress(db, ME, NOW)).toBe(false);
  });

  it("is false when the account has no runtime row yet", async () => {
    const { db, raw } = openSchemaDb();
    seedAccounts(raw);
    expect(await operationInProgress(db, ME, NOW)).toBe(false);
  });
});
