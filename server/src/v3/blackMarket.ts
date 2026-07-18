import type {
  BlackMarketListResponse,
  BlackMarketMutationResponse,
  BlackMarketOrderKind,
  BlackMarketOrderView,
  BlackMarketSummary,
} from "../../../src/net/protocol";
import objectRows from "../../../public/assets/placeables.json";
import { isTradableZombie } from "../rosterCatalog";

const ACTIVE_LIMIT = 2 as const;
const DAILY_LIMIT = 10 as const;
const MAX_PRICE = 1_000_000;
const PAGE_SIZE = 30;

const objectArmyCapacityCases = (objectRows as Array<{ key: string; armyMax?: number }>)
  .filter((object) => Number.isSafeInteger(object.armyMax) && (object.armyMax ?? 0) > 0)
  .map((object) => `WHEN '${object.key.replaceAll("'", "''")}' THEN ${object.armyMax}`)
  .join(" ");

/** SQL expression used while inserting a traded zombie. Keeping this decision inside
 * the fulfillment batch makes two simultaneous deliveries observe authoritative roster
 * occupancy in transaction order instead of both claiming the final active slot. */
const recipientStoredSql = `CASE WHEN
  (SELECT COUNT(*) FROM roster_v3 WHERE account_id=? AND stored=0) >=
  (COALESCE((SELECT CAST(json_extract(current_json,'$.zombieMax') AS INTEGER)
    FROM gameplay_documents_v3 WHERE account_id=?),16) +
   COALESCE((SELECT SUM(CASE json_extract(entry.value,'$.catalogKey')
     ${objectArmyCapacityCases} ELSE 0 END)
    FROM object_documents_v3 documents, json_each(documents.current_json) entry
    WHERE documents.account_id=? AND json_extract(entry.value,'$.status')='placed'),0))
  THEN 1 ELSE 0 END`;

interface OrderRow {
  id: string;
  creator_account_id: string;
  creator_name: string | null;
  kind: BlackMarketOrderKind;
  zombie_key: string;
  mutated_required: number;
  price_brains: number;
  status: "OPEN" | "FULFILLED" | "CANCELLED";
  created_at: number;
  escrow_mutation: number | null;
  escrow_invasions: number | null;
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

const toView = (row: OrderRow, accountId: string): BlackMarketOrderView => ({
  id: row.id,
  kind: row.kind,
  zombieKey: row.zombie_key,
  mutated: !!row.mutated_required,
  ...(row.kind === "SELL_ZOMBIE" && row.escrow_mutation !== null
    ? { mutation: row.escrow_mutation, invasions: row.escrow_invasions ?? 0 }
    : {}),
  priceBrains: row.price_brains,
  status: row.status,
  createdAt: row.created_at,
  creatorName: row.creator_name ?? "Player",
  mine: row.creator_account_id === accountId,
});

async function orderRow(db: D1Database, id: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT o.*, a.username AS creator_name FROM black_market_orders o
    JOIN accounts a ON a.id=o.creator_account_id WHERE o.id=?`).bind(id).first<OrderRow>();
}

export async function summary(db: D1Database, accountId: string, now: number): Promise<BlackMarketSummary> {
  const [active, daily] = await Promise.all([
    db.prepare("SELECT COUNT(*) n FROM black_market_orders WHERE creator_account_id=? AND status='OPEN'")
      .bind(accountId).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) n FROM black_market_orders WHERE creator_account_id=? AND created_day=?")
      .bind(accountId, dayBucket(now)).first<{ n: number }>(),
  ]);
  return {
    activePosts: active?.n ?? 0,
    postsToday: daily?.n ?? 0,
    activeLimit: ACTIVE_LIMIT,
    dailyLimit: DAILY_LIMIT,
    serverTime: now,
  };
}

export async function list(
  db: D1Database,
  accountId: string,
  query: { kind?: string; zombieKey?: string; mutated?: string; sort?: string; mine?: string; cursor?: string },
  now: number
): Promise<BlackMarketListResponse> {
  const kind: BlackMarketOrderKind = query.kind === "BUY_ZOMBIE" ? "BUY_ZOMBIE" : "SELL_ZOMBIE";
  const where = ["o.status='OPEN'", "o.kind=?"];
  const binds: unknown[] = [kind];
  if (query.zombieKey && isTradableZombie(query.zombieKey)) {
    where.push("o.zombie_key=?"); binds.push(query.zombieKey);
  }
  if (query.mutated === "true" || query.mutated === "false") {
    where.push("o.mutated_required=?"); binds.push(query.mutated === "true" ? 1 : 0);
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
  if (!validId(operationId) || !Number.isSafeInteger(expectedVersion) ||
      (kind !== "BUY_ZOMBIE" && kind !== "SELL_ZOMBIE") || !validPrice(body.priceBrains)) {
    return { status: 400, error: "bad_market_order" };
  }
  const input = kind === "SELL_ZOMBIE"
    ? { kind, unitId: body.unitId, priceBrains: body.priceBrains }
    : { kind, zombieKey: body.zombieKey, mutated: body.mutated, priceBrains: body.priceBrains };
  const fp = fingerprint("CREATE", input);
  const prior = await replay(db, accountId, operationId, fp, now);
  if (prior) return prior;

  const runtime = await db.prepare("SELECT account_version,active_batch_id FROM account_runtime_v3 WHERE account_id=?")
    .bind(accountId).first<RuntimeRow>();
  if (!runtime || runtime.account_version !== expectedVersion) return { status: 409, error: "state_conflict" };
  if (!runtime.active_batch_id) return { status: 409, error: "operation_in_progress" };
  const counts = await summary(db, accountId, now);
  if (counts.activePosts >= ACTIVE_LIMIT) return { status: 409, error: "active_post_limit" };
  if (counts.postsToday >= DAILY_LIMIT) return { status: 409, error: "daily_post_limit" };

  let zombieKey: string;
  let mutated = 0;
  let mutation: number | null = null;
  let invasions: number | null = null;
  let unitId: string | null = null;
  if (kind === "SELL_ZOMBIE") {
    if (!validId(body.unitId)) return { status: 400, error: "bad_unit" };
    const unit = await db.prepare(`SELECT zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(accountId, body.unitId)
      .first<{ zombie_key: string; mutation: number; invasions: number }>();
    if (!unit) return { status: 409, error: "zombie_unavailable" };
    if (!isTradableZombie(unit.zombie_key)) return { status: 403, error: "zombie_not_tradable" };
    zombieKey = unit.zombie_key; mutation = unit.mutation; invasions = unit.invasions;
    mutated = unit.mutation !== 0 ? 1 : 0; unitId = body.unitId;
  } else {
    if (typeof body.zombieKey !== "string" || typeof body.mutated !== "boolean" ||
        !isTradableZombie(body.zombieKey)) return { status: 400, error: "bad_zombie_request" };
    zombieKey = body.zombieKey; mutated = body.mutated ? 1 : 0;
    const balance = await db.prepare("SELECT brains FROM balances WHERE account_id=?")
      .bind(accountId).first<{ brains: number }>();
    if (!balance || balance.brains < Number(body.priceBrains)) return { status: 409, error: "insufficient_brains" };
  }

  const orderId = crypto.randomUUID();
  const guard = `EXISTS (SELECT 1 FROM account_runtime_v3 r WHERE r.account_id=?
    AND r.account_version=? AND r.active_batch_id IS NOT NULL)`;
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO black_market_orders
    (id,creator_account_id,kind,zombie_key,mutated_required,price_brains,status,created_day,created_at,
     source_unit_id,escrow_mutation,escrow_invasions,escrow_brains)
    SELECT ?,?,?,?,?,?,'OPEN',?,?,?,?,?,? WHERE ${guard}
      AND (SELECT COUNT(*) FROM black_market_orders WHERE creator_account_id=? AND status='OPEN')<?
      AND (SELECT COUNT(*) FROM black_market_orders WHERE creator_account_id=? AND created_day=?)<?`)
    .bind(orderId, accountId, kind, zombieKey, mutated, body.priceBrains, dayBucket(now), now,
      unitId, mutation, invasions, kind === "BUY_ZOMBIE" ? body.priceBrains : 0,
      accountId, expectedVersion, accountId, ACTIVE_LIMIT, accountId, dayBucket(now), DAILY_LIMIT)];
  if (kind === "SELL_ZOMBIE") {
    statements.push(db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL
      AND EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`).bind(accountId, unitId, orderId));
  } else {
    statements.push(db.prepare(`UPDATE balances SET brains=brains-? WHERE account_id=? AND brains>=?
      AND EXISTS(SELECT 1 FROM black_market_orders WHERE id=?)`)
      .bind(body.priceBrains, accountId, body.priceBrains, orderId));
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
      .bind(`${accountId}:market:${operationId}`, accountId, JSON.stringify({ orderId, kind, zombieKey, mutated: !!mutated, priceBrains: body.priceBrains }), now, orderId)
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
  const restoredId = crypto.randomUUID();
  const claim = db.prepare(`UPDATE black_market_orders SET status='CANCELLED',closed_at=?,closed_operation_id=?
    WHERE id=? AND creator_account_id=? AND status='OPEN' AND EXISTS(SELECT 1 FROM account_runtime_v3
      WHERE account_id=? AND account_version=? AND active_batch_id IS NOT NULL)`)
    .bind(now, operationId, orderId, accountId, accountId, expectedVersion);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND status='CANCELLED' AND closed_operation_id=?)";
  const statements: D1PreparedStatement[] = [claim];
  if (row.kind === "SELL_ZOMBIE") statements.push(db.prepare(`INSERT INTO roster_v3
    (account_id,unit_id,zombie_key,mutation,invasions,stored,created_at)
    SELECT ?,?,?,?,?,${recipientStoredSql},? WHERE ${guard}`).bind(accountId, restoredId, row.zombie_key,
      row.escrow_mutation ?? 0, row.escrow_invasions ?? 0,
      accountId, accountId, accountId, now, orderId, operationId));
  else statements.push(db.prepare(`UPDATE balances SET brains=brains+? WHERE account_id=? AND ${guard}`)
    .bind(row.price_brains, accountId, orderId, operationId));
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
  const row = await orderRow(db, orderId);
  if (!row) return { status: 404, error: "order_not_found" };
  if (row.creator_account_id === accountId) return { status: 403, error: "self_trade" };
  if (row.status !== "OPEN") return { status: 409, error: "order_closed" };

  let offered: { unitId: string; mutation: number; invasions: number } | null = null;
  if (row.kind === "BUY_ZOMBIE") {
    if (!validId(body.unitId)) return { status: 400, error: "bad_unit" };
    const unit = await db.prepare(`SELECT unit_id,zombie_key,mutation,invasions FROM roster_v3
      WHERE account_id=? AND unit_id=? AND locked_by_raid IS NULL`).bind(accountId, body.unitId)
      .first<{ unit_id: string; zombie_key: string; mutation: number; invasions: number }>();
    if (!unit || unit.zombie_key !== row.zombie_key || (unit.mutation !== 0) !== !!row.mutated_required)
      return { status: 409, error: "zombie_mismatch" };
    if (!isTradableZombie(unit.zombie_key)) return { status: 403, error: "zombie_not_tradable" };
    offered = { unitId: unit.unit_id, mutation: unit.mutation, invasions: unit.invasions };
  } else {
    const balance = await db.prepare("SELECT brains FROM balances WHERE account_id=?").bind(accountId)
      .first<{ brains: number }>();
    if (!balance || balance.brains < row.price_brains) return { status: 409, error: "insufficient_brains" };
  }
  const creatorRuntime = await db.prepare("SELECT active_batch_id,active_batch_expires_at FROM account_runtime_v3 WHERE account_id=?")
    .bind(row.creator_account_id).first<{ active_batch_id: string | null; active_batch_expires_at: number }>();
  if (creatorRuntime?.active_batch_id && creatorRuntime.active_batch_expires_at > now)
    return { status: 409, error: "counterparty_busy" };

  const recipientUnitId = crypto.randomUUID();
  const actorAsset = row.kind === "SELL_ZOMBIE"
    ? "EXISTS(SELECT 1 FROM balances WHERE account_id=? AND brains>=?)"
    : `EXISTS(SELECT 1 FROM roster_v3 WHERE account_id=? AND unit_id=? AND zombie_key=?
        AND (mutation!=0)=? AND locked_by_raid IS NULL)`;
  const actorAssetBinds = row.kind === "SELL_ZOMBIE"
    ? [accountId, row.price_brains]
    : [accountId, offered!.unitId, row.zombie_key, row.mutated_required];
  const claim = db.prepare(`UPDATE black_market_orders SET status='FULFILLED',closed_at=?,
      closed_operation_id=?,fulfilled_by_account_id=? WHERE id=? AND status='OPEN'
      AND creator_account_id!=? AND ${actorAsset}
      AND EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=? AND account_version=? AND active_batch_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM account_runtime_v3 WHERE account_id=black_market_orders.creator_account_id
        AND active_batch_id IS NOT NULL AND active_batch_expires_at>?)`)
    .bind(now, operationId, accountId, orderId, accountId, ...actorAssetBinds,
      accountId, expectedVersion, now);
  const guard = "EXISTS(SELECT 1 FROM black_market_orders WHERE id=? AND status='FULFILLED' AND closed_operation_id=?)";
  const statements: D1PreparedStatement[] = [claim];
  if (row.kind === "SELL_ZOMBIE") {
    statements.push(
      db.prepare(`UPDATE balances SET brains=brains-? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, accountId, orderId, operationId),
      db.prepare(`UPDATE balances SET brains=brains+? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, row.creator_account_id, orderId, operationId),
      db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,mutation,invasions,stored,created_at)
        SELECT ?,?,?,?,?,${recipientStoredSql},? WHERE ${guard}`).bind(accountId, recipientUnitId, row.zombie_key,
          row.escrow_mutation ?? 0, row.escrow_invasions ?? 0,
          accountId, accountId, accountId, now, orderId, operationId)
    );
  } else {
    statements.push(
      db.prepare(`DELETE FROM roster_v3 WHERE account_id=? AND unit_id=? AND ${guard}`)
        .bind(accountId, offered!.unitId, orderId, operationId),
      db.prepare(`UPDATE balances SET brains=brains+? WHERE account_id=? AND ${guard}`)
        .bind(row.price_brains, accountId, orderId, operationId),
      db.prepare(`INSERT INTO roster_v3(account_id,unit_id,zombie_key,mutation,invasions,stored,created_at)
        SELECT ?,?,?,?,?,${recipientStoredSql},? WHERE ${guard}`).bind(row.creator_account_id, recipientUnitId,
          row.zombie_key, offered!.mutation, offered!.invasions,
          row.creator_account_id, row.creator_account_id, row.creator_account_id,
          now, orderId, operationId)
    );
  }
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
        zombieKey: row.zombie_key, priceBrains: row.price_brains, recipientUnitId }), now, orderId, operationId)
  );
  const committed = await db.batch(statements);
  if ((committed[0]?.meta.changes ?? 0) !== 1) return { status: 409, error: "state_conflict" };
  return response(db, accountId, orderId, now);
}
