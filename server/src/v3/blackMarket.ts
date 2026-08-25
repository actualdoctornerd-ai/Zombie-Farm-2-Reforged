import type {
  BlackMarketBestSale,
  BlackMarketCollectResponse,
  BlackMarketCurrency,
  BlackMarketFulfillmentsResponse,
  BlackMarketFulfillmentView,
  BlackMarketHistoryEntry,
  BlackMarketHistoryResponse,
  BlackMarketListResponse,
  BlackMarketMutationResponse,
  BlackMarketOrderKind,
  BlackMarketOrderView,
  BlackMarketSummary,
  BlackMarketTradeStats,
  ClaimedUnit,
} from "../../../src/net/protocol";
import objectRows from "../../../public/assets/placeables.json";
import { SLOTS, SLOT_MASK } from "../../../src/zombie/mutations";
import { maskIntersect, maskWithout } from "../../../src/zombie/mutationMask";
import {
  BLACK_MARKET_MIN_LEVEL, REQUESTABLE_MUTATION_MASK,
} from "../../../src/blackMarketRules";
import { levelForXp, XP_THRESHOLDS } from "../levels";
import {
  blackMarketFilterKeys,
  blackMarketPurchaseRequirement,
  isTradableZombie,
  type BlackMarketPurchaseRequirement,
} from "../rosterCatalog";
import { parseRosterColor, serializeRosterColor } from "./rosterColor";

const ACTIVE_LIMIT = 10 as const;
const DAILY_LIMIT = 50 as const;
const MAX_PRICE = 10_000_000;
const PAGE_SIZE = 30;

/** How long an OPEN post stays on the board. Past this it is off every board
 *  immediately (see the freshness clause in `list`) and the next time its creator
 *  touches the market it is closed and its escrow handed back (`expireStalePosts`).
 *  Nothing here ever deletes a listing behind a player's back: the zombie or the
 *  payment always comes home, exactly as a manual cancel would return it. */
export const POST_LIFETIME_MS = 3 * 86_400_000; // 3 days
/** How long a post must have sat before its creator may bump it back to the top of
 *  "newest" (which also restarts its lifetime). Long enough that reposting is
 *  housekeeping rather than a way to hold the front page. */
export const REPOST_COOLDOWN_MS = 6 * 3_600_000; // 6 hours
/** Posts older than this are expired. */
const freshAfter = (now: number): number => now - POST_LIFETIME_MS;
/** How many stale posts one sweep closes. A player cannot hold more than
 *  ACTIVE_LIMIT open at a time, so this covers every case with room to spare. */
const SWEEP_LIMIT = 16;

/** The `balances` column a post's currency is paid out of and into. Every currency-aware
 *  statement interpolates this rather than binding it: a column name cannot be a bound
 *  parameter, so the value must come from the closed union — never from request text.
 *  `parseCurrency` is the only way an outside string becomes one. */
const BALANCE_COLUMN: Record<BlackMarketCurrency, "brains" | "gold"> = {
  BRAINS: "brains",
  GOLD: "gold",
};
/** The error a caller gets when they cannot afford a post, named for what they lack. */
const INSUFFICIENT: Record<BlackMarketCurrency, string> = {
  BRAINS: "insufficient_brains",
  GOLD: "insufficient_gold",
};
/** An omitted currency is BRAINS: that is what every post predating gold pricing was,
 *  and what a client cached from before it still sends. Anything else is a 400 rather
 *  than a silent fallback — a typo'd currency must not quietly charge the wrong wallet. */
const parseCurrency = (value: unknown): BlackMarketCurrency | null =>
  value === undefined || value === "BRAINS" ? "BRAINS" : value === "GOLD" ? "GOLD" : null;
const currencyOf = (row: { currency?: string | null }): BlackMarketCurrency =>
  row.currency === "GOLD" ? "GOLD" : "BRAINS";

const placedObjectCases = (field: "armyMax" | "zombieSlots") =>
  (objectRows as Array<{ key: string; armyMax?: number; zombieSlots?: number }>)
    .filter((object) => Number.isSafeInteger(object[field]) && (object[field] ?? 0) > 0)
    .map((object) => `WHEN '${object.key.replaceAll("'", "''")}' THEN ${object[field]}`)
    .join(" ");

const placedObjects = `FROM object_documents_v3 documents, json_each(documents.current_json) entry
  WHERE documents.account_id=? AND json_extract(entry.value,'$.status')='placed'`;

/** Deployed units the army cap limits. A unit reserved in a Zombie Pot is already
 *  `stored`, so it never counts here. */
const ACTIVE_UNITS = "(SELECT COUNT(*) FROM roster_v3 WHERE account_id=? AND stored=0)";
/** Mausoleum occupants. Pot reservations are deliberately excluded: they are flagged
 *  `stored` purely to free their army slot, the client hides them, and counting them
 *  would make the crypt read full to the server and roomy to the player (see the
 *  `reservedInPot` note in engine.ts). */
const CRYPT_UNITS = `(SELECT COUNT(*) FROM roster_v3 WHERE account_id=? AND stored=1
  AND (locked_by_raid IS NULL OR locked_by_raid NOT LIKE 'pot:%'))`;
/** zombieMax plus every placed object that raises it (Zombie Monolith). */
const ARMY_CAP = `(COALESCE((SELECT CAST(json_extract(current_json,'$.zombieMax') AS INTEGER)
    FROM gameplay_documents_v3 WHERE account_id=?),16) +
  COALESCE((SELECT SUM(CASE json_extract(entry.value,'$.catalogKey')
    ${placedObjectCases("armyMax")} ELSE 0 END) ${placedObjects}),0))`;
/** Storage slots of the placed Mausoleum, by tier. ZERO with none placed — the case
 *  that made a purchase disappear into a crypt the player does not own. */
const CRYPT_CAP = `COALESCE((SELECT MAX(CASE json_extract(entry.value,'$.catalogKey')
    ${placedObjectCases("zombieSlots")} ELSE 0 END) ${placedObjects}),0)`;

/** Where a claimed zombie lands: the army first, the Mausoleum once it is full.
 *  Binds: active-count, zombieMax, army-objects. */
const claimDestinationSql = `CASE WHEN ${ACTIVE_UNITS} >= ${ARMY_CAP} THEN 1 ELSE 0 END`;
const claimDestinationBinds = (accountId: string) => [accountId, accountId, accountId];

/** True while EITHER destination has a free slot. Evaluated inside the mutating batch
 *  so two simultaneous deliveries observe occupancy in transaction order instead of
 *  both claiming the same last slot. Binds: active, zombieMax, army-objects, crypt
 *  count, crypt objects. */
const hasRoomSql = `(${ACTIVE_UNITS} < ${ARMY_CAP} OR ${CRYPT_UNITS} < ${CRYPT_CAP})`;
const hasRoomBinds = (accountId: string) =>
  [accountId, accountId, accountId, accountId, accountId];

interface OrderRow {
  id: string;
  creator_account_id: string;
  creator_name: string | null;
  kind: BlackMarketOrderKind;
  zombie_key: string;
  mutated_required: number;
  mutation_required: number | null;
  /** The price, in `currency` — the column name is historical (see schema.sql). */
  price_brains: number;
  currency: string;
  status: "OPEN" | "FULFILLED" | "CANCELLED";
  created_at: number;
  escrow_mutation: number | null;
  escrow_invasions: number | null;
  /** The escrowed zombie's body tint, JSON "[r,g,b]" (migration 0041). NULL is the
   *  normal case: no inherited tint, render the species' catalog colour. */
  escrow_color?: string | null;
  // Present on every `SELECT o.*`; the traded unit as stamped at settlement, and
  // whether the recipient has taken delivery of it yet (migrations 0033 / 0040).
  delivered_mutation?: number | null;
  delivered_invasions?: number | null;
  delivered_color?: string | null;
  claimed_at?: number | null;
  /** When the earner was credited (migration 0043). NULL on a FULFILLED sale means
   *  the market is still holding the brains for its creator to collect. */
  payout_at?: number | null;
}

/** The body tint to escrow with a zombie that is about to change hands.
 *
 *  A trade always mints a NEW unit id (a cancel hands the zombie back as a fresh
 *  row, a fulfilment delivers one to the recipient), and a tint that only lives in
 *  the owner's presentation blob is keyed by the OLD id — so it stopped resolving
 *  and the zombie silently reverted to its species' catalog colour. Reading it here,
 *  once, at the moment the unit leaves its owner, is what lets the escrow carry it
 *  across that id change like the mutation and veterancy already do.
 *
 *  The authoritative column wins when it has one (the unit was traded before); the
 *  owner's presentation hint covers every unit that has only ever been theirs.
 *  Either way an unrecognised value degrades to NULL — "no inherited tint" — which
 *  is the correct answer for all but a Zombie Pot child. */
async function escrowedColor(
  db: D1Database, accountId: string, unitId: string
): Promise<string | null> {
  const [row, presentation] = await Promise.all([
    db.prepare("SELECT color FROM roster_v3 WHERE account_id=? AND unit_id=?")
      .bind(accountId, unitId).first<{ color: string | null }>(),
    db.prepare("SELECT current_json FROM presentations_v3 WHERE account_id=?")
      .bind(accountId).first<{ current_json: string }>(),
  ]);
  const authoritative = parseRosterColor(row?.color);
  if (authoritative) return serializeRosterColor(authoritative);
  try {
    const data = JSON.parse(presentation?.current_json ?? "{}") as {
      rosterLayout?: { id?: unknown; color?: unknown }[];
    };
    const hint = (data.rosterLayout ?? []).find((entry) => entry?.id === unitId);
    return serializeRosterColor(hint?.color);
  } catch {
    return null;
  }
}

interface ReceiptRow { request_fingerprint: string; order_id: string }
interface RuntimeRow { account_version: number; active_batch_id: string | null }

export type MarketFailure = {
  status: 400 | 403 | 404 | 409;
  error: string;
};

const dayBucket = (now: number): number => Math.floor(now / 86_400_000);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const validPrice = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_PRICE;
// REQUESTABLE_MUTATION_MASK is shared with the compose form (see blackMarketRules) and
// is now the whole catalog: since migration 0044 the stored column only CHECKs `> 0`,
// so THIS is the exact legal set and a request naming an unknown bit is a clean 400.
// Adding a mutation needs no schema change — the bound widens with the catalog.
const validMutationRequirement = (value: unknown): value is number | undefined =>
  value === undefined || (Number.isSafeInteger(value) && Number(value) > 0 &&
    maskWithout(Number(value), REQUESTABLE_MUTATION_MASK) === 0);
export const matchesMutationRequirement = (
  mutation: number,
  mutated: number,
  mutationRequired: number | null
): boolean => {
  if (mutationRequired === null) return (mutation !== 0) === !!mutated;
  return SLOTS.every((slot) => {
    const requestedInSlot = maskIntersect(mutationRequired, SLOT_MASK[slot]);
    return requestedInSlot === 0 || maskIntersect(mutation, requestedInSlot) !== 0;
  });
};
// SQLite's `&` is 64-bit, unlike JavaScript's — these predicates stay correct for
// every bit the mask can hold, so only the JS-side arithmetic above had to change.
const mutationRequirementSql = (mutationRequired: number | null): {
  sql: string;
  binds: number[];
} => {
  if (mutationRequired === null) return { sql: "(mutation!=0)=?", binds: [] };
  const slotMasks = SLOTS
    .map((slot) => maskIntersect(mutationRequired, SLOT_MASK[slot]))
    .filter((mask) => mask !== 0);
  return {
    sql: slotMasks.map(() => "(mutation & ?) != 0").join(" AND "),
    binds: slotMasks,
  };
};

/** The market's own level floor, checked before anything moves. The client hides the
 *  Black Market below BLACK_MARKET_MIN_LEVEL, but hiding a button is not a rule — this
 *  is, and it costs one indexed read on the two calls that create obligations (a post
 *  and a trade). Browsing is deliberately not gated: a client that got a board back
 *  still cannot act on it, and reads are the cheap half. */
async function marketLevelFailure(
  db: D1Database,
  accountId: string
): Promise<MarketFailure | null> {
  const balance = await db.prepare("SELECT xp FROM balances WHERE account_id=?")
    .bind(accountId).first<{ xp: number }>();
  if (balance && levelForXp(balance.xp) >= BLACK_MARKET_MIN_LEVEL) return null;
  return { status: 403, error: "black_market_locked" };
}

async function purchaseRequirementFailure(
  db: D1Database,
  accountId: string,
  zombieKey: string
): Promise<MarketFailure | null> {
  const requirement = blackMarketPurchaseRequirement(zombieKey);
  if (!requirement) return { status: 400, error: "bad_zombie_request" };
  if (requirement.minLevel) {
    const balance = await db.prepare("SELECT xp FROM balances WHERE account_id=?")
      .bind(accountId).first<{ xp: number }>();
    if (!balance || levelForXp(balance.xp) < requirement.minLevel) {
      return { status: 403, error: "black_market_level_locked" };
    }
  }
  return null;
}

function purchaseRequirementGuard(
  accountId: string,
  requirement: BlackMarketPurchaseRequirement
): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (requirement.minLevel) {
    clauses.push("EXISTS(SELECT 1 FROM balances WHERE account_id=? AND xp>=?)");
    binds.push(accountId, XP_THRESHOLDS[requirement.minLevel - 1] ?? Number.MAX_SAFE_INTEGER);
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", binds };
}

const toView = (row: OrderRow, accountId: string): BlackMarketOrderView => ({
  id: row.id,
  kind: row.kind,
  zombieKey: row.zombie_key,
  mutated: !!row.mutated_required,
  ...(row.kind === "BUY_ZOMBIE" && row.mutation_required !== null
    ? { mutationRequired: row.mutation_required }
    : {}),
  ...(row.kind === "SELL_ZOMBIE" && row.escrow_mutation !== null
    ? { mutation: row.escrow_mutation, invasions: row.escrow_invasions ?? 0 }
    : {}),
  ...(row.kind === "SELL_ZOMBIE" && parseRosterColor(row.escrow_color)
    ? { color: parseRosterColor(row.escrow_color)! }
    : {}),
  price: row.price_brains,
  currency: currencyOf(row),
  priceBrains: row.price_brains,
  status: row.status,
  createdAt: row.created_at,
  // Both are pure functions of `created_at`, which a repost resets — so the card can
  // count down to "expires" and to "can be bumped again" without a second round-trip.
  expiresAt: row.created_at + POST_LIFETIME_MS,
  repostableAt: row.created_at + REPOST_COOLDOWN_MS,
  creatorName: row.creator_name ?? "Player",
  mine: row.creator_account_id === accountId,
});

async function orderRow(db: D1Database, id: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT o.*, a.username AS creator_name FROM black_market_orders o
    JOIN accounts a ON a.id=o.creator_account_id WHERE o.id=?`).bind(id).first<OrderRow>();
}

export async function summary(db: D1Database, accountId: string, now: number): Promise<BlackMarketSummary> {
  const [active, daily, held] = await Promise.all([
    // Only posts still on the board count against the active limit. A stale one is
    // already invisible to every other player and is closed by the next sweep, so
    // holding a slot for it would lock the player out of the market for three days.
    db.prepare(`SELECT COUNT(*) n FROM black_market_orders
      WHERE creator_account_id=? AND status='OPEN' AND created_at>?`)
      .bind(accountId, freshAfter(now)).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) n FROM black_market_orders WHERE creator_account_id=? AND created_day=?")
      .bind(accountId, dayBucket(now)).first<{ n: number }>(),
    // What the market is holding for this account: every sale of theirs that has
    // settled but not been collected (migration 0043), split by the currency it was
    // priced in — the two are different wallets and never sum.
    db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN currency='GOLD' THEN 0 ELSE price_brains END),0) brains,
        COALESCE(SUM(CASE WHEN currency='GOLD' THEN price_brains ELSE 0 END),0) gold
      FROM black_market_orders
      WHERE creator_account_id=? AND status='FULFILLED' AND kind='SELL_ZOMBIE' AND payout_at IS NULL`)
      .bind(accountId).first<{ brains: number; gold: number }>(),
  ]);
  return {
    activePosts: active?.n ?? 0,
    postsToday: daily?.n ?? 0,
    activeLimit: ACTIVE_LIMIT,
    dailyLimit: DAILY_LIMIT,
    heldBrains: held?.brains ?? 0,
    heldGold: held?.gold ?? 0,
    serverTime: now,
  };
}

export async function list(
  db: D1Database,
  accountId: string,
  query: {
    kind?: string; zombieClass?: string; zombieGroup?: string; currency?: string;
    zombieKey?: string; mutated?: string; sort?: string; mine?: string; cursor?: string;
  },
  now: number
): Promise<BlackMarketListResponse> {
  const kind: BlackMarketOrderKind = query.kind === "BUY_ZOMBIE" ? "BUY_ZOMBIE" : "SELL_ZOMBIE";
  // The freshness clause is what actually clears the board: a post past its lifetime
  // stops being listed for EVERYONE the moment it ages out, whether or not its
  // creator has been back to trigger the sweep that closes it.
  //
  // ...with one exception: the creator's OWN "My posts" view. The sweep normally
  // closes a stale post before this query runs, so the only OPEN stale rows that can
  // still show up here are the ones it could not finish — a sale whose owner has no
  // room for the zombie coming back. Hiding those would leave the seller with a
  // zombie that is in no roster, on no board, and behind no button: an invisible
  // post they cannot cancel and a unit that reads as lost. They stay listed for
  // their owner (flagged `expired`) so Cancel Post is still reachable.
  const mineOnly = query.mine === "true";
  const where = ["o.status='OPEN'", "o.kind=?"];
  const binds: unknown[] = [kind];
  if (!mineOnly) { where.push("o.created_at>?"); binds.push(freshAfter(now)); }
  // The toolbar's two dropdowns. A bucket can span dozens of keys, so the list is
  // inlined rather than bound — D1 caps bound parameters per query, and these are
  // catalog constants, never request text (blackMarketFilterKeys resolves a bucket
  // NAME, and the guard below re-checks the shape of what it returned).
  const filterKeys = blackMarketFilterKeys(query.zombieClass, query.zombieGroup);
  if (filterKeys) {
    const safe = filterKeys.filter((key) => /^[A-Za-z0-9_]+$/.test(key));
    where.push(safe.length ? `o.zombie_key IN (${safe.map((key) => `'${key}'`).join(",")})` : "0=1");
  }
  // Retained for clients still on the older per-type / mutated-yes-no toolbar.
  if (query.zombieKey && isTradableZombie(query.zombieKey)) {
    where.push("o.zombie_key=?"); binds.push(query.zombieKey);
  }
  if (query.mutated === "true" || query.mutated === "false") {
    where.push("o.mutated_required=?"); binds.push(query.mutated === "true" ? 1 : 0);
  }
  // Prices in different currencies do not compare, so the price sorts below only mean
  // something within one of them — hence a currency filter rather than a merged board.
  // An unrecognised value is ignored, the same as every other optional filter here.
  if (query.currency === "BRAINS" || query.currency === "GOLD") {
    where.push("o.currency=?"); binds.push(query.currency);
  }
  if (query.mine === "true") { where.push("o.creator_account_id=?"); binds.push(accountId); }
  const offset = Math.max(0, Math.min(10_000, Number.parseInt(query.cursor ?? "0", 10) || 0));
  const order = query.sort === "price_asc" ? "o.price_brains ASC, o.created_at DESC, o.id" :
    query.sort === "price_desc" ? "o.price_brains DESC, o.created_at DESC, o.id" :
      "o.created_at DESC, o.id";
  const result = await db.prepare(`SELECT o.*, a.username AS creator_name FROM black_market_orders o
    JOIN accounts a ON a.id=o.creator_account_id WHERE ${where.join(" AND ")}
    ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, PAGE_SIZE + 1, offset).all<OrderRow>();
  const rows = result.results ?? [];
  return {
    orders: rows.slice(0, PAGE_SIZE).map((row) => toView(row, accountId)),
    nextCursor: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    summary: await summary(db, accountId, now),
  };
}

const FULFILLMENT_PAGE = 50;

interface FulfillmentRow {
  id: string;
  kind: BlackMarketOrderKind;
  zombie_key: string;
  mutated_required: number;
  price_brains: number;
  currency: string;
  created_at: number;
  closed_at: number;
  escrow_mutation: number | null;
  escrow_invasions: number | null;
  delivered_mutation: number | null;
  delivered_invasions: number | null;
  escrow_color: string | null;
  delivered_color: string | null;
  creator_account_id: string;
  claimed_at: number | null;
  payout_at: number | null;
  fulfilled_by_name: string | null;
  creator_name: string | null;
}

/** The caller's settled-but-uncollected orders, newest first. Settlement has already
 * happened for all of these; they exist so each side finally hears about it — and, for
 * whoever the trade owes a zombie, so they have somewhere to take delivery.
 *
 * Both sides of a sale can hold a card for the same order at once: the seller's says
 * the brains arrived (`acknowledged_at`), the buyer's still owes them the zombie
 * (`claimed_at`). The two flags are independent, so one collecting never hides the
 * other's card. */
export async function fulfillments(
  db: D1Database,
  accountId: string
): Promise<BlackMarketFulfillmentsResponse> {
  const result = await db.prepare(`SELECT o.id,o.kind,o.zombie_key,o.mutated_required,o.price_brains,
      o.currency,o.created_at,o.closed_at,o.escrow_mutation,o.escrow_invasions,
      o.delivered_mutation,o.delivered_invasions,o.escrow_color,o.delivered_color,
      o.creator_account_id,o.claimed_at,o.payout_at,
      a.username AS fulfilled_by_name, ca.username AS creator_name
    FROM black_market_orders o
    LEFT JOIN accounts a ON a.id=o.fulfilled_by_account_id
    JOIN accounts ca ON ca.id=o.creator_account_id
    WHERE o.status='FULFILLED' AND (
      -- A card the creator has not dismissed, OR one still holding their brains: as
      -- long as the market owes something there is a card to collect it from, so an
      -- acknowledgment that somehow outran its payout cannot strand the money.
      (o.creator_account_id=?1 AND (o.acknowledged_at IS NULL
        OR (o.kind='SELL_ZOMBIE' AND o.payout_at IS NULL)))
      OR (o.claimed_at IS NULL AND ?1 = CASE o.kind
            WHEN 'SELL_ZOMBIE' THEN o.fulfilled_by_account_id ELSE o.creator_account_id END))
    ORDER BY o.closed_at DESC LIMIT ?2`).bind(accountId, FULFILLMENT_PAGE).all<FulfillmentRow>();
  const views: BlackMarketFulfillmentView[] = (result.results ?? []).map((row) => {
    // The traded unit, whichever direction it moved: a sale's escrowed zombie or the
    // unit the fulfiller handed over for a request. Both are stamped on the order at
    // settlement (migration 0033); the escrow fallback covers sales fulfilled before
    // that column existed, and a request that old simply has no unit to describe.
    const mutation = row.delivered_mutation ??
      (row.kind === "SELL_ZOMBIE" ? row.escrow_mutation : null);
    const invasions = row.delivered_invasions ??
      (row.kind === "SELL_ZOMBIE" ? row.escrow_invasions : null);
    const color = parseRosterColor(row.delivered_color ?? row.escrow_color);
    const mine = row.creator_account_id === accountId;
    // A sale's buyer is its fulfiller, so "who completed the trade" is the wrong name
    // to show them — every card names the player on the OTHER side.
    const counterparty = (mine ? row.fulfilled_by_name : row.creator_name) ?? "Player";
    return {
      id: row.id,
      kind: row.kind,
      zombieKey: row.zombie_key,
      mutated: !!row.mutated_required,
      ...(mutation !== null ? { mutation, invasions: invasions ?? 0 } : {}),
      ...(color ? { color } : {}),
      price: row.price_brains,
      currency: currencyOf(row),
      priceBrains: row.price_brains,
      createdAt: row.created_at,
      fulfilledAt: row.closed_at,
      fulfilledBy: counterparty,
      ...(row.claimed_at === null && (row.kind === "SELL_ZOMBIE") !== mine
        ? { awaitingClaim: true }
        : {}),
      // The market is holding this sale's payment for its creator until they collect.
      ...(mine && row.kind === "SELL_ZOMBIE" && row.payout_at === null
        ? { awaitingPayout: true }
        : {}),
    };
  });
  return { fulfillments: views };
}

/** Who the traded zombie belongs to once the order settles: the fulfiller bought it
 *  on a sale, the creator requested it on a buy. */
const recipientOf = (row: Pick<OrderRow, "kind" | "creator_account_id"> & {
  fulfilled_by_account_id?: string | null;
}): string | null =>
  row.kind === "SELL_ZOMBIE" ? row.fulfilled_by_account_id ?? null : row.creator_account_id;

/** Does this account have a free army slot or a free Mausoleum slot? Read outside the
 *  mutating batch to turn "nowhere to put it" into a precise error; the same condition
 *  is re-asserted inside the batch (`hasRoomSql`) so the answer cannot go stale. */
async function hasDeliveryRoom(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT ${hasRoomSql} AS room`)
    .bind(...hasRoomBinds(accountId)).first<{ room: number }>();
  return !!row?.room;
}

/** Mint a settled trade's zombie into the recipient's roster, army slot first and
 *  Mausoleum second. Idempotent on `claimed_at`, and refused outright when neither
 *  destination has room — the unit keeps waiting on the order instead of being flagged
 *  `stored` into a crypt the player may not own. */
async function claimDelivery(
  db: D1Database,
  accountId: string,
  row: OrderRow & { fulfilled_by_account_id: string | null },
  now: number
): Promise<{ unit: ClaimedUnit } | MarketFailure> {
  if (!await hasDeliveryRoom(db, accountId)) return { status: 409, error: "no_room" };
  const unitId = crypto.randomUUID();
  const mutation = row.delivered_mutation ?? row.escrow_mutation ?? 0;
  const invasions = row.delivered_invasions ?? row.escrow_invasions ?? 0;
  // Trades settled before migration 0041 recorded no tint; those units keep the
  // catalog colour, which is all the server can honestly say about them.
  const color = row.delivered_color ?? row.escrow_color ?? null;
  // The `/black-market/*` writer middleware opens this caller's operation lease for
  // the life of the request, so requiring it here is what fences the claim against a
  // second device — the same guard every other market mutation uses.
  const claim = db.prepare(`UPDATE black_market_orders SET claimed_at=?,delivered_unit_id=?
    WHERE id=? AND status='FULFILLED' AND claimed_at IS NULL AND ${hasRoomSql}
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND active_batch_id IS NOT NULL)`)
    .bind(now, unitId, row.id, ...hasRoomBinds(accountId), accountId);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND delivered_unit_id=?)";
  const committed = await db.batch([
    claim,
    db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,mutation,invasions,stored,created_at,color)
      SELECT ?,?,?,?,?,${claimDestinationSql},?,? WHERE ${guard}`)
      .bind(accountId, unitId, row.zombie_key, mutation, invasions,
        ...claimDestinationBinds(accountId), now, color, row.id, unitId),
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=?
      WHERE account_id=? AND ${guard}`).bind(now, accountId, row.id, unitId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?,?,'black_market_claim',?,? WHERE ${guard}`)
      .bind(`${accountId}:claim:${unitId}`, accountId,
        JSON.stringify({ orderId: row.id, zombieKey: row.zombie_key, unitId }), now, row.id, unitId),
  ]);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "claim_conflict" };
  const stored = await db.prepare("SELECT stored FROM roster_v3 WHERE account_id=? AND unit_id=?")
    .bind(accountId, unitId).first<{ stored: number }>();
  return { unit: { unitId, zombieKey: row.zombie_key, mutation, invasions, stored: !!stored?.stored } };
}

/** Pay out a sale the market is still holding payment for, into whichever wallet the
 *  post was priced in. Idempotent on `payout_at`: the timestamp is claimed first and
 *  every other statement is guarded on it having landed, so a double-tapped Collect (or
 *  a retry) credits exactly once. Returns the amount actually credited — 0 when another
 *  request got there first. */
async function payOutSale(
  db: D1Database,
  accountId: string,
  row: OrderRow,
  now: number
): Promise<number> {
  const currency = currencyOf(row);
  const wallet = BALANCE_COLUMN[currency];
  const paid = db.prepare(`UPDATE black_market_orders SET payout_at=?
    WHERE id=? AND creator_account_id=? AND status='FULFILLED' AND payout_at IS NULL
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND active_batch_id IS NOT NULL)`)
    .bind(now, row.id, accountId, accountId);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND payout_at=?)";
  const committed = await db.batch([
    paid,
    db.prepare(`UPDATE balances SET ${wallet}=${wallet}+? WHERE account_id=? AND ${guard}`)
      .bind(row.price_brains, accountId, row.id, now),
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=?
      WHERE account_id=? AND ${guard}`).bind(now, accountId, row.id, now),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?,?,'black_market_payout',?,? WHERE ${guard}`)
      .bind(`${accountId}:payout:${row.id}`, accountId,
        JSON.stringify({ orderId: row.id, amount: row.price_brains, currency }), now, row.id, now),
  ]);
  return (committed[0]?.meta.changes ?? 0) === 1 ? row.price_brains : 0;
}

/** Collect one settled order: take delivery of the zombie it owes this account (if
 * any) and the payment the market is holding for it, then acknowledge it so it stops
 * surfacing as uncollected.
 *
 * The claim runs FIRST and its failure aborts the whole thing — acknowledging an order
 * whose zombie could not land would dismiss the only card that can still deliver it.
 *
 * It also echoes the current balance, which is what a seller's collect is FOR: a sale's
 * payment waits on the order until this call pays it out (migration 0043). A filled
 * request's payment went to its fulfiller at settlement instead, so for that card the
 * echo is still just news the client never saw. Reading the balance here costs one extra
 * SELECT and saves the client a whole second round-trip. */
export async function collect(
  db: D1Database,
  accountId: string,
  orderId: string,
  now: number
): Promise<BlackMarketCollectResponse | MarketFailure> {
  if (!validId(orderId)) return { status: 400, error: "bad_market_collect" };
  const row = await db.prepare(`SELECT o.*, a.username AS creator_name FROM black_market_orders o
    JOIN accounts a ON a.id=o.creator_account_id WHERE o.id=?`).bind(orderId)
    .first<OrderRow & { fulfilled_by_account_id: string | null; claimed_at: number | null }>();
  if (!row) return { status: 404, error: "order_not_found" };
  const isCreator = row.creator_account_id === accountId;
  const owedZombie = recipientOf(row) === accountId && row.claimed_at === null;
  if (!isCreator && !owedZombie) return { status: 403, error: "not_order_owner" };
  if (row.status !== "FULFILLED") return { status: 409, error: "order_not_fulfilled" };

  let claimed: ClaimedUnit | undefined;
  if (owedZombie) {
    const result = await claimDelivery(db, accountId, row, now);
    if (!("unit" in result)) return result;
    claimed = result.unit;
  }
  // Only a SALE holds payment for its creator; a request's went to its fulfiller at
  // settlement. The payout is deliberately independent of the acknowledgment below —
  // it has its own idempotency marker, so money can never ride on a notice flag.
  const owedPayment = isCreator && row.kind === "SELL_ZOMBIE" && row.payout_at == null;
  const paid = owedPayment ? await payOutSale(db, accountId, row, now) : 0;
  // Like the claim above: a payout that did not land must NOT be acknowledged away.
  // The usual cause is a concurrent collect that already paid — the retry then sees
  // `payout_at` set, skips the payout, and dismisses the card normally.
  if (owedPayment && !paid) return { status: 409, error: "payout_conflict" };
  const paidGold = currencyOf(row) === "GOLD";
  const acknowledged = isCreator
    ? await db.prepare(`UPDATE black_market_orders SET acknowledged_at=?
        WHERE id=? AND creator_account_id=? AND status='FULFILLED' AND acknowledged_at IS NULL`)
      .bind(now, orderId, accountId).run()
    : null;
  return {
    ok: true,
    // "Already collected" only describes the acknowledgment. A claim or a payout that
    // just landed is news either way, so neither reports as a repeat.
    alreadyCollected: !claimed && !paid && (acknowledged?.meta.changes ?? 0) !== 1,
    ...(claimed ? { claimed } : {}),
    ...(paid ? (paidGold ? { goldPaid: paid } : { brainsPaid: paid }) : {}),
    ...await balanceEcho(db, accountId),
  };
}

/** `{ balance }` for the account, or `{}` if the row is somehow missing — an absent
 *  balance is the same "older Worker" shape the client already tolerates. */
async function balanceEcho(
  db: D1Database,
  accountId: string
): Promise<{ balance?: { gold: number; brains: number; xp: number } }> {
  const balance = await db.prepare("SELECT gold, brains, xp FROM balances WHERE account_id=?")
    .bind(accountId).first<{ gold: number; brains: number; xp: number }>();
  return balance ? { balance } : {};
}

const HISTORY_PAGE = 100;

// A completed trade always has one earning side and one spending side. Which account
// sits on which side depends on the order kind: a sale's creator earns and its
// fulfiller spends; a request's creator spends and its fulfiller earns.
const EARNED_SIDE_SQL = `status='FULFILLED' AND
  ((kind='SELL_ZOMBIE' AND creator_account_id=?1) OR (kind='BUY_ZOMBIE' AND fulfilled_by_account_id=?1))`;
const SPENT_SIDE_SQL = `status='FULFILLED' AND
  ((kind='SELL_ZOMBIE' AND fulfilled_by_account_id=?1) OR (kind='BUY_ZOMBIE' AND creator_account_id=?1))`;

/** Sums the earned/spent side of a set of trades, split by currency — the two never
 *  add up, so every aggregate here reports both. */
const CURRENCY_TOTALS = `COUNT(*) n,
  COALESCE(SUM(CASE WHEN currency='GOLD' THEN 0 ELSE price_brains END),0) brains,
  COALESCE(SUM(CASE WHEN currency='GOLD' THEN price_brains ELSE 0 END),0) gold`;

const bestSale = (
  row: { zombie_key: string; price_brains: number; delivered_mutation: number | null } | null,
  currency: BlackMarketCurrency
): BlackMarketBestSale | null => row
  ? {
      zombieKey: row.zombie_key,
      price: row.price_brains,
      currency,
      priceBrains: row.price_brains,
      mutation: row.delivered_mutation,
    }
  : null;

interface HistoryRow {
  id: string;
  kind: BlackMarketOrderKind;
  zombie_key: string;
  price_brains: number;
  currency: string;
  closed_at: number;
  delivered_mutation: number | null;
  delivered_invasions: number | null;
  delivered_color: string | null;
  creator_account_id: string;
  creator_name: string | null;
  fulfiller_name: string | null;
}

/** The caller's completed trades (both roles), newest first, plus lifetime
 * aggregates computed over the full set — not just the returned page. */
export async function history(
  db: D1Database,
  accountId: string
): Promise<BlackMarketHistoryResponse> {
  const [entries, earnedTotals, bestBrains, bestGold, spentTotals, mostTraded] = await Promise.all([
    db.prepare(`SELECT o.id,o.kind,o.zombie_key,o.price_brains,o.currency,o.closed_at,
        o.delivered_mutation,o.delivered_invasions,o.delivered_color,o.creator_account_id,
        ca.username AS creator_name, fa.username AS fulfiller_name
      FROM black_market_orders o
      JOIN accounts ca ON ca.id=o.creator_account_id
      LEFT JOIN accounts fa ON fa.id=o.fulfilled_by_account_id
      WHERE o.status='FULFILLED' AND (o.creator_account_id=?1 OR o.fulfilled_by_account_id=?1)
      ORDER BY o.closed_at DESC, o.id LIMIT ${HISTORY_PAGE}`)
      .bind(accountId).all<HistoryRow>(),
    db.prepare(`SELECT ${CURRENCY_TOTALS}
      FROM black_market_orders WHERE ${EARNED_SIDE_SQL}`)
      .bind(accountId).first<{ n: number; brains: number; gold: number }>(),
    db.prepare(`SELECT zombie_key, price_brains, delivered_mutation
      FROM black_market_orders WHERE ${EARNED_SIDE_SQL} AND currency!='GOLD'
      ORDER BY price_brains DESC, closed_at DESC LIMIT 1`)
      .bind(accountId).first<{ zombie_key: string; price_brains: number; delivered_mutation: number | null }>(),
    db.prepare(`SELECT zombie_key, price_brains, delivered_mutation
      FROM black_market_orders WHERE ${EARNED_SIDE_SQL} AND currency='GOLD'
      ORDER BY price_brains DESC, closed_at DESC LIMIT 1`)
      .bind(accountId).first<{ zombie_key: string; price_brains: number; delivered_mutation: number | null }>(),
    db.prepare(`SELECT ${CURRENCY_TOTALS}
      FROM black_market_orders WHERE ${SPENT_SIDE_SQL}`)
      .bind(accountId).first<{ n: number; brains: number; gold: number }>(),
    db.prepare(`SELECT zombie_key, COUNT(*) n FROM black_market_orders
      WHERE status='FULFILLED' AND (creator_account_id=?1 OR fulfilled_by_account_id=?1)
      GROUP BY zombie_key ORDER BY n DESC, zombie_key LIMIT 1`)
      .bind(accountId).first<{ zombie_key: string; n: number }>(),
  ]);
  const stats: BlackMarketTradeStats = {
    sold: {
      count: earnedTotals?.n ?? 0,
      brains: earnedTotals?.brains ?? 0,
      gold: earnedTotals?.gold ?? 0,
      best: bestSale(bestBrains, "BRAINS"),
      bestGold: bestSale(bestGold, "GOLD"),
    },
    bought: {
      count: spentTotals?.n ?? 0,
      brains: spentTotals?.brains ?? 0,
      gold: spentTotals?.gold ?? 0,
    },
    mostTraded: mostTraded ? { zombieKey: mostTraded.zombie_key, count: mostTraded.n } : null,
  };
  const views: BlackMarketHistoryEntry[] = (entries.results ?? []).map((row) => {
    const mine = row.creator_account_id === accountId;
    return {
      id: row.id,
      kind: row.kind,
      mine,
      earned: (row.kind === "SELL_ZOMBIE") === mine,
      zombieKey: row.zombie_key,
      mutation: row.delivered_mutation,
      invasions: row.delivered_invasions ?? 0,
      ...(parseRosterColor(row.delivered_color) ? { color: parseRosterColor(row.delivered_color)! } : {}),
      price: row.price_brains,
      currency: currencyOf(row),
      priceBrains: row.price_brains,
      counterparty: (mine ? row.fulfiller_name : row.creator_name) ?? "Player",
      fulfilledAt: row.closed_at,
    };
  });
  return { stats, entries: views };
}

const fingerprint = (action: string, input: Record<string, unknown>): string =>
  JSON.stringify([action, Object.entries(input).sort(([a], [b]) => a.localeCompare(b))]);

async function replay(
  db: D1Database,
  accountId: string,
  operationId: string,
  expectedFingerprint: string,
  now: number
): Promise<BlackMarketMutationResponse | MarketFailure | null> {
  const receipt = await db.prepare("SELECT request_fingerprint,order_id FROM black_market_receipts WHERE operation_id=? AND account_id=?")
    .bind(operationId, accountId).first<ReceiptRow>();
  if (!receipt) return null;
  if (receipt.request_fingerprint !== expectedFingerprint) return { status: 409, error: "operation_mismatch" };
  const row = await orderRow(db, receipt.order_id);
  if (!row) return { status: 404, error: "order_not_found" };
  return { ok: true, order: toView(row, accountId), summary: await summary(db, accountId, now) };
}

const response = async (db: D1Database, accountId: string, id: string, now: number): Promise<BlackMarketMutationResponse> => {
  const row = await orderRow(db, id);
  if (!row) throw new Error("black_market_order_missing_after_commit");
  return { ok: true, order: toView(row, accountId), summary: await summary(db, accountId, now) };
};

export async function create(
  db: D1Database,
  accountId: string,
  body: Record<string, unknown>,
  now: number
): Promise<BlackMarketMutationResponse | MarketFailure> {
  const operationId = body.operationId;
  const expectedVersion = body.expectedAccountVersion;
  const kind = body.kind;
  // `priceBrains` is the pre-gold field name, still accepted so a client cached from
  // before this change keeps posting (as BRAINS, which is what it meant).
  const price = body.price ?? body.priceBrains;
  const currency = parseCurrency(body.currency);
  if (!validId(operationId) || !Number.isSafeInteger(expectedVersion) ||
      (kind !== "BUY_ZOMBIE" && kind !== "SELL_ZOMBIE") || !currency || !validPrice(price)) {
    return { status: 400, error: "bad_market_order" };
  }
  const input = kind === "SELL_ZOMBIE"
    ? { kind, unitId: body.unitId, price, currency }
    : {
        kind,
        zombieKey: body.zombieKey,
        mutated: body.mutated,
        mutationRequired: body.mutationRequired ?? null,
        price,
        currency,
      };
  const fp = fingerprint("CREATE", input);
  const prior = await replay(db, accountId, operationId, fp, now);
  if (prior) return prior;

  const levelFailure = await marketLevelFailure(db, accountId);
  if (levelFailure) return levelFailure;

  const runtime = await db.prepare("SELECT account_version,active_batch_id FROM account_runtime_v3 WHERE account_id=?")
    .bind(accountId).first<RuntimeRow>();
  if (!runtime || runtime.account_version !== expectedVersion) return { status: 409, error: "state_conflict" };
  if (!runtime.active_batch_id) return { status: 409, error: "operation_in_progress" };
  const counts = await summary(db, accountId, now);
  if (counts.activePosts >= ACTIVE_LIMIT) return { status: 409, error: "active_post_limit" };
  if (counts.postsToday >= DAILY_LIMIT) return { status: 409, error: "daily_post_limit" };

  let zombieKey: string;
  let mutated = 0;
  let mutationRequired: number | null = null;
  let mutation: number | null = null;
  let invasions: number | null = null;
  let unitId: string | null = null;
  let escrowColor: string | null = null;
  if (kind === "SELL_ZOMBIE") {
    if (!validId(body.unitId)) return { status: 400, error: "bad_unit" };
    const unit = await db.prepare(`SELECT zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(accountId, body.unitId)
      .first<{ zombie_key: string; mutation: number; invasions: number }>();
    if (!unit) return { status: 409, error: "zombie_unavailable" };
    if (!isTradableZombie(unit.zombie_key)) return { status: 403, error: "zombie_not_tradable" };
    zombieKey = unit.zombie_key; mutation = unit.mutation; invasions = unit.invasions;
    mutated = unit.mutation !== 0 ? 1 : 0; unitId = body.unitId;
    // Escrow the tint alongside the mutation/veterancy it travels with, so a cancel
    // hands back the same-looking zombie and a buyer receives the one they saw.
    escrowColor = await escrowedColor(db, accountId, body.unitId);
  } else {
    if (typeof body.zombieKey !== "string" || typeof body.mutated !== "boolean" ||
        !validMutationRequirement(body.mutationRequired) ||
        (body.mutationRequired !== undefined && body.mutated !== true) ||
        !isTradableZombie(body.zombieKey)) return { status: 400, error: "bad_zombie_request" };
    zombieKey = body.zombieKey; mutated = body.mutated ? 1 : 0;
    mutationRequired = body.mutationRequired ?? null;
    const requirementFailure = await purchaseRequirementFailure(db, accountId, zombieKey);
    if (requirementFailure) return requirementFailure;
    const wallet = BALANCE_COLUMN[currency];
    const balance = await db.prepare(`SELECT ${wallet} AS funds FROM balances WHERE account_id=?`)
      .bind(accountId).first<{ funds: number }>();
    if (!balance || balance.funds < Number(price)) {
      return { status: 409, error: INSUFFICIENT[currency] };
    }
  }

  const orderId = crypto.randomUUID();
  const guard = `EXISTS (SELECT 1 FROM account_runtime_v3 r WHERE r.account_id=?
    AND r.account_version=? AND r.active_batch_id IS NOT NULL)`;
  const wallet = BALANCE_COLUMN[currency];
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO black_market_orders
    (id,creator_account_id,kind,zombie_key,mutated_required,mutation_required,price_brains,currency,status,created_day,created_at,
     source_unit_id,escrow_mutation,escrow_invasions,escrow_brains,escrow_color)
    SELECT ?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,? WHERE ${guard}
      AND (SELECT COUNT(*) FROM black_market_orders
        WHERE creator_account_id=? AND status='OPEN' AND created_at>?)<?
      AND (SELECT COUNT(*) FROM black_market_orders WHERE creator_account_id=? AND created_day=?)<?`)
    .bind(orderId, accountId, kind, zombieKey, mutated, mutationRequired, price, currency, dayBucket(now), now,
      unitId, mutation, invasions, kind === "BUY_ZOMBIE" ? price : 0, escrowColor,
      accountId, expectedVersion, accountId, freshAfter(now), ACTIVE_LIMIT,
      accountId, dayBucket(now), DAILY_LIMIT)];
  if (kind === "SELL_ZOMBIE") {
    statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL
      AND EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`).bind(accountId, unitId, orderId));
  } else {
    statements.push(db.prepare(`UPDATE balances SET ${wallet}=${wallet}-? WHERE account_id=? AND ${wallet}>=?
      AND EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`)
      .bind(price, accountId, price, orderId));
  }
  statements.push(
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=?
      WHERE account_id=? AND account_version=? AND EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`)
      .bind(now, accountId, expectedVersion, orderId),
    db.prepare(`INSERT INTO black_market_receipts(operation_id,account_id,action,request_fingerprint,order_id,created_at)
      SELECT ?,?,'CREATE',?,?,? WHERE EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`)
      .bind(operationId, accountId, fp, orderId, now, orderId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?,?,'black_market_create',?,? WHERE EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`)
      .bind(`${accountId}:market:${operationId}`, accountId, JSON.stringify({
        orderId, kind, zombieKey, mutated: !!mutated, mutationRequired, price, currency,
      }), now, orderId)
  );
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1 || (committed[1]?.meta.changes ?? 0) !== 1) {
    return { status: 409, error: "state_conflict" };
  }
  return response(db, accountId, orderId, now);
}

export async function cancel(
  db: D1Database, accountId: string, orderId: string, body: Record<string, unknown>, now: number
): Promise<BlackMarketMutationResponse | MarketFailure> {
  const operationId = body.operationId;
  const expectedVersion = body.expectedAccountVersion;
  if (!validId(orderId) || !validId(operationId) || !Number.isSafeInteger(expectedVersion))
    return { status: 400, error: "bad_market_cancel" };
  const fp = fingerprint("CANCEL", { orderId });
  const prior = await replay(db, accountId, operationId, fp, now);
  if (prior) return prior;
  const row = await orderRow(db, orderId);
  if (!row) return { status: 404, error: "order_not_found" };
  if (row.creator_account_id !== accountId) return { status: 403, error: "not_order_owner" };
  if (row.status !== "OPEN") return { status: 409, error: "order_closed" };
  // Taking a listing down hands the escrowed zombie straight back, so it needs
  // somewhere to land. With the farm AND the Mausoleum full the cancel is refused
  // outright rather than restoring a unit into a crypt that may not even exist —
  // the listing stays open and the player can retry once they free a slot.
  if (row.kind === "SELL_ZOMBIE" && !await hasDeliveryRoom(db, accountId))
    return { status: 409, error: "no_room" };
  const restoredId = crypto.randomUUID();
  const roomGuard = row.kind === "SELL_ZOMBIE"
    ? { sql: ` AND ${hasRoomSql}`, binds: hasRoomBinds(accountId) }
    : { sql: "", binds: [] };
  const claim = db.prepare(`UPDATE black_market_orders SET status='CANCELLED',closed_at=?,closed_operation_id=?
    WHERE id=? AND creator_account_id=? AND status='OPEN' AND EXISTS(SELECT 1 FROM account_runtime_v3
      WHERE account_id=? AND account_version=? AND active_batch_id IS NOT NULL)${roomGuard.sql}`)
    .bind(now, operationId, orderId, accountId, accountId, expectedVersion, ...roomGuard.binds);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND status='CANCELLED' AND closed_operation_id=?)";
  const statements: D1PreparedStatement[] = [claim];
  // from_escrow=1: this is the seller's own zombie coming home, not an acquisition.
  // Without the mark the client sees an unfamiliar unit id and credits the Zombie
  // Almanac, so list/cancel cycles inflated that species' lifetime count.
  // The restored row carries the escrowed tint too: it is the same zombie coming
  // home, and it arrives under a new unit id that the owner's presentation hint
  // cannot describe.
  if (row.kind === "SELL_ZOMBIE") statements.push(db.prepare(`INSERT INTO roster_v3
    (account_id,unit_id,zombie_key,mutation,invasions,stored,from_escrow,created_at,color)
    SELECT ?,?,?,?,?,${claimDestinationSql},1,?,? WHERE ${guard}`).bind(accountId, restoredId, row.zombie_key,
      row.escrow_mutation ?? 0, row.escrow_invasions ?? 0,
      ...claimDestinationBinds(accountId), now, row.escrow_color ?? null, orderId, operationId));
  else {
    // The escrowed offer comes back to the wallet it left (`currency` is fixed for the
    // life of a post, so this is the same column create debited).
    const wallet = BALANCE_COLUMN[currencyOf(row)];
    statements.push(db.prepare(`UPDATE balances SET ${wallet}=${wallet}+? WHERE account_id=? AND ${guard}`)
      .bind(row.price_brains, accountId, orderId, operationId));
  }
  statements.push(
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=? WHERE account_id=?
      AND account_version=? AND ${guard}`).bind(now, accountId, expectedVersion, orderId, operationId),
    db.prepare(`INSERT INTO black_market_receipts(operation_id,account_id,action,request_fingerprint,order_id,created_at)
      SELECT ?,?,'CANCEL',?,?,? WHERE ${guard}`)
      .bind(operationId, accountId, fp, orderId, now, orderId, operationId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?,?,'black_market_cancel',?,? WHERE ${guard}`)
      .bind(`${accountId}:market:${operationId}`, accountId, JSON.stringify({ orderId,
        restoredId: row.kind === "SELL_ZOMBIE" ? restoredId : null }), now, orderId, operationId)
  );
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
  return response(db, accountId, orderId, now);
}

/** Bump one of the caller's own posts back to the top of "newest" and restart its
 *  three-day life.
 *
 *  `created_at` IS the bump time — every ordering, the expiry cutoff and this
 *  cooldown all read that one column — so a repost is a single guarded UPDATE and
 *  needs no schema of its own. The same guard is what rate-limits it: a post must
 *  have sat for REPOST_COOLDOWN_MS, so a listing can be kept alive by tending it,
 *  never by hammering the button.
 *
 *  Deliberately does NOT touch `created_day`: the daily post allowance is about how
 *  many listings a player CREATES in a day, and re-dating an old post into today's
 *  bucket would spend an allowance they never used.
 *
 *  Nothing moves between accounts here — no escrow, no balance, no roster — so this
 *  is also the one market mutation that leaves `account_version` alone. */
export async function repost(
  db: D1Database, accountId: string, orderId: string, now: number
): Promise<BlackMarketMutationResponse | MarketFailure> {
  if (!validId(orderId)) return { status: 400, error: "bad_market_repost" };
  const row = await orderRow(db, orderId);
  if (!row) return { status: 404, error: "order_not_found" };
  if (row.creator_account_id !== accountId) return { status: 403, error: "not_order_owner" };
  if (row.status !== "OPEN") return { status: 409, error: "order_closed" };
  // An already-stale post is not bumped back to life: it belongs to the sweep, which
  // is about to hand its escrow back. Reposting it would resurrect a listing the
  // board stopped showing days ago.
  if (row.created_at <= freshAfter(now)) return { status: 409, error: "order_expired" };
  if (now - row.created_at < REPOST_COOLDOWN_MS) return { status: 409, error: "repost_cooldown" };
  const bumped = await db.prepare(`UPDATE black_market_orders SET created_at=?
    WHERE id=? AND creator_account_id=? AND status='OPEN' AND created_at<=? AND created_at>?`)
    .bind(now, orderId, accountId, now - REPOST_COOLDOWN_MS, freshAfter(now)).run();
  // Losing the race means another device bumped it (or it just closed); either way the
  // caller's view is stale, so say so rather than reporting a bump that did not happen.
  if ((bumped.meta.changes ?? 0) !== 1) return { status: 409, error: "repost_cooldown" };
  await db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
    VALUES (?,?,'black_market_repost',?,?)`)
    .bind(`${accountId}:repost:${orderId}:${now}`, accountId,
      JSON.stringify({ orderId, previousCreatedAt: row.created_at }), now)
    .run();
  return response(db, accountId, orderId, now);
}

/** Close the caller's OPEN posts that have outlived POST_LIFETIME_MS and hand their
 *  escrow back — the zombie to the roster, the offered payment to the wallet. This is
 *  exactly what `cancel` does, performed for the player instead of by them, so a post
 *  that ages out costs them nothing.
 *
 *  Lazy rather than scheduled: it runs whenever the owner touches the market. Other
 *  players never see a stale post either way (`list` filters by age), so the only
 *  thing waiting on this pass is the owner getting their own escrow back — and they
 *  have to be here to receive it.
 *
 *  A sale whose owner has NO room for the zombie is skipped, not force-delivered: the
 *  post stays open (invisible, and not counting against their active limit) until a
 *  later sweep finds them a slot. Same rule as a manual cancel, which is refused
 *  outright in that state.
 *
 *  Every statement is guarded on the CLAIM landing, so two concurrent sweeps — two
 *  devices, or a list and a create at once — can never return the same escrow twice.
 *  Returns how many posts were actually closed. */
export async function expireStalePosts(
  db: D1Database, accountId: string, now: number
): Promise<number> {
  const stale = await db.prepare(`SELECT * FROM black_market_orders
    WHERE creator_account_id=? AND status='OPEN' AND created_at<=?
    ORDER BY created_at LIMIT ?`)
    .bind(accountId, freshAfter(now), SWEEP_LIMIT).all<OrderRow>();
  const rows = stale.results ?? [];
  if (!rows.length) return 0;
  let closed = 0;
  for (const row of rows) {
    // A distinct, deterministic marker per post: it doubles as this expiry's operation
    // id, so the guard below matches only the statement that actually closed it.
    const operationId = `expire:${row.id}`;
    const restoredId = crypto.randomUUID();
    const roomGuard = row.kind === "SELL_ZOMBIE"
      ? { sql: ` AND ${hasRoomSql}`, binds: hasRoomBinds(accountId) }
      : { sql: "", binds: [] as unknown[] };
    const claim = db.prepare(`UPDATE black_market_orders SET status='CANCELLED',closed_at=?,closed_operation_id=?
      WHERE id=? AND creator_account_id=? AND status='OPEN'${roomGuard.sql}`)
      .bind(now, operationId, row.id, accountId, ...roomGuard.binds);
    const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND status='CANCELLED' AND closed_operation_id=?)";
    const statements: D1PreparedStatement[] = [claim];
    if (row.kind === "SELL_ZOMBIE") {
      // from_escrow=1 for the same reason a cancel sets it: this is the seller's own
      // zombie coming home under a new id, not a species they just acquired.
      statements.push(db.prepare(`INSERT INTO roster_v3
        (account_id,unit_id,zombie_key,mutation,invasions,stored,from_escrow,created_at,color)
        SELECT ?,?,?,?,?,${claimDestinationSql},1,?,? WHERE ${guard}`)
        .bind(accountId, restoredId, row.zombie_key, row.escrow_mutation ?? 0,
          row.escrow_invasions ?? 0, ...claimDestinationBinds(accountId), now,
          row.escrow_color ?? null, row.id, operationId));
    } else {
      const wallet = BALANCE_COLUMN[currencyOf(row)];
      statements.push(db.prepare(`UPDATE balances SET ${wallet}=${wallet}+? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, accountId, row.id, operationId));
    }
    statements.push(
      db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=?
        WHERE account_id=? AND ${guard}`).bind(now, accountId, row.id, operationId),
      db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
        SELECT ?,?,'black_market_expire',?,? WHERE ${guard}`)
        .bind(`${accountId}:expire:${row.id}`, accountId, JSON.stringify({
          orderId: row.id, kind: row.kind, zombieKey: row.zombie_key,
          restoredId: row.kind === "SELL_ZOMBIE" ? restoredId : null,
          refunded: row.kind === "BUY_ZOMBIE" ? row.price_brains : 0,
          currency: currencyOf(row),
        }), now, row.id, operationId)
    );
    const committed = await db.batch(statements);
    if ((committed[0]?.meta.changes ?? 0) === 1) closed++;
  }
  return closed;
}

export async function fulfill(
  db: D1Database, accountId: string, orderId: string, body: Record<string, unknown>, now: number
): Promise<BlackMarketMutationResponse | MarketFailure> {
  const operationId = body.operationId;
  const expectedVersion = body.expectedAccountVersion;
  if (!validId(orderId) || !validId(operationId) || !Number.isSafeInteger(expectedVersion))
    return { status: 400, error: "bad_market_fulfillment" };
  const fp = fingerprint("FULFILL", { orderId, unitId: body.unitId ?? null });
  const prior = await replay(db, accountId, operationId, fp, now);
  if (prior) return prior;
  const levelFailure = await marketLevelFailure(db, accountId);
  if (levelFailure) return levelFailure;
  const row = await orderRow(db, orderId);
  if (!row) return { status: 404, error: "order_not_found" };
  if (row.creator_account_id === accountId) return { status: 403, error: "self_trade" };
  if (row.status !== "OPEN") return { status: 409, error: "order_closed" };
  // The post's own currency decides which wallet moves, on both sides of the trade. It
  // is read from the stored row, never from the fulfiller's request.
  const currency = currencyOf(row);
  const wallet = BALANCE_COLUMN[currency];

  const recipientAccountId = row.kind === "SELL_ZOMBIE" ? accountId : row.creator_account_id;
  const requirementFailure = await purchaseRequirementFailure(db, recipientAccountId, row.zombie_key);
  if (requirementFailure) return requirementFailure;
  const recipientRequirement = purchaseRequirementGuard(
    recipientAccountId,
    blackMarketPurchaseRequirement(row.zombie_key) ?? {}
  );

  let offered: { unitId: string; mutation: number; invasions: number; color: string | null } | null = null;
  if (row.kind === "BUY_ZOMBIE") {
    if (!validId(body.unitId)) return { status: 400, error: "bad_unit" };
    const unit = await db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(accountId, body.unitId)
      .first<{ unit_id: string; zombie_key: string; mutation: number; invasions: number }>();
    const mutationMatches = !!unit && matchesMutationRequirement(
      unit.mutation,
      row.mutated_required,
      row.mutation_required
    );
    if (!unit || unit.zombie_key !== row.zombie_key || !mutationMatches)
      return { status: 409, error: "zombie_mismatch" };
    if (!isTradableZombie(unit.zombie_key)) return { status: 403, error: "zombie_not_tradable" };
    offered = {
      unitId: unit.unit_id, mutation: unit.mutation, invasions: unit.invasions,
      color: await escrowedColor(db, accountId, unit.unit_id),
    };
  } else {
    const balance = await db.prepare(`SELECT ${wallet} AS funds FROM balances WHERE account_id=?`)
      .bind(accountId).first<{ funds: number }>();
    if (!balance || balance.funds < row.price_brains) {
      return { status: 409, error: INSUFFICIENT[currency] };
    }
  }
  const creatorRuntime = await db.prepare("SELECT active_batch_id,active_batch_expires_at FROM account_runtime_v3 WHERE account_id=?")
    .bind(row.creator_account_id).first<{ active_batch_id: string | null; active_batch_expires_at: number }>();
  if (creatorRuntime?.active_batch_id && creatorRuntime.active_batch_expires_at > now)
    return { status: 409, error: "counterparty_busy" };

  const mutationAsset = mutationRequirementSql(row.mutation_required);
  const actorAsset = row.kind === "SELL_ZOMBIE"
    ? `EXISTS(SELECT 1 FROM balances WHERE account_id=? AND ${wallet}>=?)`
    : `EXISTS(SELECT 1 FROM roster_v3 WHERE account_id=? AND unit_id=? AND zombie_key=?
        AND ${mutationAsset.sql}
        AND locked_by_raid IS NULL)`;
  const actorAssetBinds = row.kind === "SELL_ZOMBIE"
    ? [accountId, row.price_brains]
    : [
        accountId,
        offered!.unitId,
        row.zombie_key,
        ...(row.mutation_required === null ? [row.mutated_required] : mutationAsset.binds),
      ];
  // Stamp the actually-traded unit on the order so trade history can show it —
  // a request's escrow columns hold brains, so the offered unit has nowhere
  // else to live once the fulfiller's roster row is deleted.
  const delivered = row.kind === "SELL_ZOMBIE"
    ? { mutation: row.escrow_mutation ?? 0, invasions: row.escrow_invasions ?? 0,
      color: row.escrow_color ?? null }
    : { mutation: offered!.mutation, invasions: offered!.invasions, color: offered!.color };
  // A filled REQUEST pays its fulfiller in this batch (they are here, with the panel
  // open, and hold no card to collect from), so it is stamped paid. A SALE's payment
  // stays with the market until its creator collects — `payout_at` NULL — because the
  // seller is typically offline right now and would otherwise find the payout already
  // in their balance with nothing left for Collect to do.
  const payoutAt = row.kind === "SELL_ZOMBIE" ? null : now;
  const claim = db.prepare(`UPDATE black_market_orders SET status='FULFILLED',closed_at=?,
      closed_operation_id=?,fulfilled_by_account_id=?,delivered_mutation=?,delivered_invasions=?,
      delivered_color=?,payout_at=?
      WHERE id=? AND status='OPEN'
      AND creator_account_id!=? AND ${actorAsset}
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND account_version=? AND active_batch_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=black_market_orders.creator_account_id
        AND active_batch_id IS NOT NULL AND active_batch_expires_at>?)
      AND ${recipientRequirement.sql}`)
    .bind(now, operationId, accountId, delivered.mutation, delivered.invasions, delivered.color,
      payoutAt, orderId, accountId, ...actorAssetBinds,
      accountId, expectedVersion, now, ...recipientRequirement.binds);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND status='FULFILLED' AND closed_operation_id=?)";
  const statements: D1PreparedStatement[] = [claim];
  if (row.kind === "SELL_ZOMBIE") {
    // The buyer pays now; the seller is paid by their own collect (see `payoutAt`).
    statements.push(
      db.prepare(`UPDATE balances SET ${wallet}=${wallet}-? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, accountId, orderId, operationId)
    );
  } else {
    statements.push(
      db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND ${guard}`)
        .bind(accountId, offered!.unitId, orderId, operationId),
      db.prepare(`UPDATE balances SET ${wallet}=${wallet}+? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, accountId, orderId, operationId)
    );
  }
  // The traded zombie is NOT minted here. It waits on the order (its species and
  // stats are stamped in `delivered_*` above) until the recipient claims it, so a
  // recipient with no free army slot and no Mausoleum cannot be handed a unit that
  // has nowhere to exist. See `claimDelivery`.
  statements.push(
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=? WHERE account_id=?
      AND account_version=? AND ${guard}`).bind(now, accountId, expectedVersion, orderId, operationId),
    db.prepare(`UPDATE account_runtime_v3 SET account_version=account_version+1,updated_at=? WHERE account_id=? AND ${guard}`)
      .bind(now, row.creator_account_id, orderId, operationId),
    db.prepare(`INSERT INTO black_market_receipts(operation_id,account_id,action,request_fingerprint,order_id,created_at)
      SELECT ?,?,'FULFILL',?,?,? WHERE ${guard}`)
      .bind(operationId, accountId, fp, orderId, now, orderId, operationId),
    db.prepare(`INSERT INTO audit_events_v3(id,account_id,kind,detail_json,created_at)
      SELECT ?,?,'black_market_fulfill',?,? WHERE ${guard}`)
      .bind(`${accountId}:market:${operationId}`, accountId, JSON.stringify({ orderId, creatorAccountId: row.creator_account_id,
        zombieKey: row.zombie_key, price: row.price_brains, currency,
        recipientAccountId }), now, orderId, operationId)
  );
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
  return response(db, accountId, orderId, now);
}
