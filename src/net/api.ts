// Client for the game server (Cloudflare Worker). Owns the session token and every
// endpoint call. Everything here is OPTIONAL: if VITE_API_URL is unset, isConfigured()
// is false and callers skip the network entirely (offline-only mode).
//
// Layering: this is the low level. auth.ts (Google Sign-In) sits on top and calls
// authenticate(); SaveManager/main call the data methods. No import of auth here, so
// there's no cycle.
import type { SaveGame } from "../save/schema";
import type { Friend } from "../social/friends";
import { RAID_RULESET_VERSION, type RaidReplayInput } from "../raid/replay";
import type { RaidOutcome } from "../raid/types";
import {
  CLIENT_INTEGRITY_VERSION,
  GAMEPLAY_PROTOCOL,
  type BootstrapResponse,
  type CommandBatchRequest,
  type CommandBatchResponse,
  type BlackMarketListResponse,
  type BlackMarketMutationResponse,
  type BlackMarketOrderKind,
  type BlackMarketSummary,
  type PresentationProjection,
  type PresentationRequest,
} from "./protocol";
export type { RaidReplayInput } from "../raid/replay";

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const SESSION_KEY = "zf2r.v3.session";
const DEVICE_KEY = "zf2r.v3.device";
const CLIENT_KEY = "zf2r.v4.writer-client";
const WRITER_KEY = "zf2r.v4.writer";

// v3 is an intentional clean break. Never replay a v1/v2 save or outbox into a
// newly-created authoritative account.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && (key.startsWith("zf2r.") || key.startsWith("zombiefarm.")) && !key.startsWith("zf2r.v3.")) {
      localStorage.removeItem(key);
    }
  }
} catch {
  /* storage may be unavailable in privacy mode */
}

export function deviceId(): string {
  try {
    const current = localStorage.getItem(DEVICE_KEY);
    if (current) return current;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function writerClientId(): string {
  try {
    const current = sessionStorage.getItem(CLIENT_KEY);
    if (current) return current;
    const created = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

interface WriterCredential {
  accountId: string;
  clientId: string;
  generation: number;
  token: string;
}

const readWriterCredential = (): WriterCredential | null => {
  try { return JSON.parse(sessionStorage.getItem(WRITER_KEY) ?? "null") as WriterCredential | null; }
  catch { return null; }
};

let writerCredential: WriterCredential | null = readWriterCredential();
let writerRejectedHandler: (() => void) | null = null;

// A server credential belongs to one live document at a time. Web Locks are scoped
// to the origin and released automatically when a document unloads, which makes a
// reload a clean handoff while still fencing a duplicated tab that inherited this
// tab's sessionStorage. A losing document never deletes the persisted credential.
const supportsWriterLocks = typeof navigator !== "undefined" && !!navigator.locks;
let localWriterLockHeld = !supportsWriterLocks;
let resolveWriterLock: ((held: boolean) => void) | null = null;
const writerLockAcquired = new Promise<boolean>((resolve) => { resolveWriterLock = resolve; });

if (supportsWriterLocks) {
  void navigator.locks.request(`zf2r.v4.writer:${writerClientId()}`, async () => {
    localWriterLockHeld = true;
    // A contending document suppresses its in-memory copy while it waits. Restore
    // that copy only after the browser grants this document exclusive ownership.
    writerCredential ??= readWriterCredential();
    resolveWriterLock?.(true);
    resolveWriterLock = null;
    await new Promise<void>(() => { /* held for this document's lifetime */ });
  }).catch(() => {
    // Web Locks are an availability guard, not the server security boundary. If a
    // browser advertises the API but it fails, preserve the existing server fence.
    localWriterLockHeld = true;
    writerCredential ??= readWriterCredential();
    resolveWriterLock?.(true);
    resolveWriterLock = null;
  });
}

const persistWriter = (value: WriterCredential | null): void => {
  writerCredential = value;
  try {
    if (value) sessionStorage.setItem(WRITER_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(WRITER_KEY);
  } catch { /* storage is optional */ }
};

export async function prepareWriterAccess(waitMs = 1_500): Promise<boolean> {
  if (localWriterLockHeld) return true;
  const acquired = await Promise.race([
    writerLockAcquired,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
  ]);
  if (!acquired) writerCredential = null; // suppress locally; never erase sessionStorage
  return acquired;
}

export const hasLocalWriterLock = (): boolean => localWriterLockHeld;
export const hasWriterCredential = (): boolean => localWriterLockHeld &&
  !!writerCredential && writerCredential.accountId === session?.accountId;
export const clearWriterCredential = (): void => persistWriter(null);
export const setWriterRejectedHandler = (handler: (() => void) | null): void => { writerRejectedHandler = handler; };

export interface Session {
  token: string;
  accountId: string;
  /** Player-chosen display name; null until picked on first sign-in. */
  username: string | null;
  friendCode: string;
}

/** The name to show for this account: the chosen username (no personal data is
 *  stored, so there's no real-name fallback). */
export function displayName(s: Session): string {
  return s.username ?? "Player";
}

/** A typed transport error. `status` 0 = network/offline (fall back to local). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** For a 409 on PUT /save, the server's current copy to reconcile against. */
    public body?: unknown
  ) {
    super(`${code} (${status})`);
  }
}

/** Whether an online server is configured at all. */
export function isConfigured(): boolean {
  return !!API;
}

// ---- session persistence ------------------------------------------------
let session: Session | null = readSession();

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
export function getSession(): Session | null {
  return session;
}
function setSession(s: Session) {
  session = s;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
export function clearSession() {
  session = null;
  clearWriterCredential();
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ---- core request -------------------------------------------------------
async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true
): Promise<T> {
  if (!API) throw new ApiError(0, "not_configured");
  const headers: Record<string, string> = {};
  headers["X-Integrity-Version"] = String(CLIENT_INTEGRITY_VERSION);
  headers["X-Client-Build"] = import.meta.env.VITE_BUILD_ID ?? "dev";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!session) throw new ApiError(401, "no_session");
    headers["Authorization"] = `Bearer ${session.token}`;
    if (localWriterLockHeld && writerCredential?.accountId === session.accountId) {
      headers["X-Writer-Client"] = writerCredential.clientId;
      headers["X-Writer-Generation"] = String(writerCredential.generation);
      headers["X-Writer-Token"] = writerCredential.token;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // DNS/CORS/network failure — treat as offline so callers can fall back.
    throw new ApiError(0, "offline");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const code = (data as { error?: string })?.error ?? `http_${res.status}`;
    if (res.status === 401) clearSession(); // stale/invalid token → sign out
    if (res.status === 423 && code === "writer_replaced") {
      clearWriterCredential();
      writerRejectedHandler?.();
    }
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

// ---- auth (called by auth.ts) -------------------------------------------
/** Exchange a Google ID token (or a dev sub) for our session. Stores + returns it. */
export async function authenticate(
  cred: { idToken: string } | { devSub: string; devName?: string }
): Promise<Session> {
  const s = await req<Session>("POST", "/auth", cred, false);
  setSession(s);
  return s;
}

// ---- data methods -------------------------------------------------------
export interface SavePayload {
  save: SaveGame | null;
  rev: number;
}
export interface FriendView {
  accountId: string;
  name: string;
  friendCode: string;
  giftOnCooldown?: boolean;
}
export interface InboxGift {
  id: string;
  type: string;
  created_at: number;
  fromName: string;
}

export const me = () =>
  req<{ accountId: string; name: string; username: string | null; friendCode: string }>(
    "GET",
    "/me"
  );

// ---- protocol v3 -------------------------------------------------------
let bootstrapPromise: Promise<BootstrapResponse> | null = null;
export const bootstrap = (force = false) => {
  if (force) bootstrapPromise = null;
  bootstrapPromise ??= req<BootstrapResponse>("POST", "/bootstrap", {
    protocolVersion: GAMEPLAY_PROTOCOL,
    deviceId: deviceId(),
    clientId: writerClientId(),
  }).catch((error) => {
    bootstrapPromise = null;
    throw error;
  });
  return bootstrapPromise;
};

export async function acquireWriter(observedGeneration: number, takeover: boolean): Promise<void> {
  if (!session) throw new ApiError(401, "no_session");
  const clientId = writerClientId();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const result = await req<{ ok: true; writerGeneration: number; accountVersion: number }>(
    "POST", "/writer/acquire", { clientId, token, observedGeneration, takeover }
  );
  persistWriter({ accountId: session.accountId, clientId, generation: result.writerGeneration, token });
  bootstrapPromise = null;
}

export async function releaseWriter(): Promise<void> {
  if (!hasWriterCredential()) return;
  try { await req<{ ok: true }>("POST", "/writer/release"); }
  finally { clearWriterCredential(); }
}

export const sendCommandBatch = (batch: CommandBatchRequest) =>
  req<CommandBatchResponse>("POST", "/commands", batch);

export const putPresentationV3 = (payload: PresentationRequest) =>
  req<PresentationProjection>("PUT", "/presentation", payload);

export const blackMarketOrders = (query: {
  kind: BlackMarketOrderKind;
  zombieKey?: string;
  mutated?: boolean;
  sort?: "newest" | "price_asc" | "price_desc";
  mine?: boolean;
  cursor?: string;
}) => {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.zombieKey) params.set("zombieKey", query.zombieKey);
  if (query.mutated !== undefined) params.set("mutated", String(query.mutated));
  if (query.sort) params.set("sort", query.sort);
  if (query.mine) params.set("mine", "true");
  if (query.cursor) params.set("cursor", query.cursor);
  return req<BlackMarketListResponse>("GET", `/black-market/orders?${params}`);
};

export const blackMarketSummary = () => req<BlackMarketSummary>("GET", "/black-market/summary");

export const createBlackMarketOrder = (body:
  | { operationId: string; expectedAccountVersion: number; kind: "SELL_ZOMBIE"; unitId: string; priceBrains: number }
  | { operationId: string; expectedAccountVersion: number; kind: "BUY_ZOMBIE"; zombieKey: string; mutated: boolean; priceBrains: number }
) => req<BlackMarketMutationResponse>("POST", "/black-market/orders", body);

export const cancelBlackMarketOrder = (id: string, operationId: string, expectedAccountVersion: number) =>
  req<BlackMarketMutationResponse>("POST", `/black-market/orders/${encodeURIComponent(id)}/cancel`, {
    operationId, expectedAccountVersion,
  });

export const fulfillBlackMarketOrder = (
  id: string, operationId: string, expectedAccountVersion: number, unitId?: string
) => req<BlackMarketMutationResponse>("POST", `/black-market/orders/${encodeURIComponent(id)}/fulfill`, {
  operationId, expectedAccountVersion, ...(unitId ? { unitId } : {}),
});

/** Set this account's chosen display name. Updates the stored session, returns the
 *  normalized value. Throws ApiError(400, "bad_username") if it doesn't validate. */
export async function setUsername(name: string): Promise<string> {
  const r = await req<{ username: string }>("POST", "/username", { username: name });
  if (session) setSession({ ...session, username: r.username });
  return r.username;
}

export const getSave = () => req<SavePayload>("GET", "/save");

/** PUT the save. Resolves to the new rev, or throws ApiError(409) whose `.body`
 *  carries `{ rev, save }` for reconciliation. */
export const putSave = (save: SaveGame, baseRev: number) =>
  req<{ rev: number }>("PUT", "/save", { save, baseRev });

/** Renew the access token for the current (still-live) session. Called
 *  opportunistically on startup so a long-lived tab keeps a fresh token without a
 *  Google round-trip. A revoked session yields 401 → clears the local session. */
export async function refreshSession(): Promise<void> {
  if (!session) return;
  const r = await req<{ token: string }>("POST", "/session/refresh");
  setSession({ ...session, token: r.token });
}

/** Revoke this device's session server-side, then drop the local copy. */
export async function logout(): Promise<void> {
  try {
    await releaseWriter();
    await req<{ ok: true }>("POST", "/logout");
  } catch {
    /* even if the server call fails, clear locally below */
  }
  clearSession();
}

/** Revoke every session for this account (sign out everywhere). */
export const logoutEverywhere = () => req<{ ok: true }>("POST", "/session/logout-all");

/** A live device/session for the Account menu's device list. `current` marks the
 *  session this browser is using (can't be revoked from here — use Sign out). */
export interface SessionInfo {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  label: string | null;
  current: boolean;
}

/** This account's live devices, most-recently used first. */
export const listSessions = () =>
  req<{ sessions: SessionInfo[] }>("GET", "/session/list").then((r) => r.sessions);

/** Revoke one OTHER device by id (sign it out remotely). The server rejects revoking
 *  the current session or one you don't own. */
export const revokeSession = (sessionId: string) =>
  req<{ ok: true }>("POST", "/session/revoke", { sessionId });

export const getFriends = () => req<FriendView[]>("GET", "/friends");

/** Pending incoming friend requests (people who asked to befriend me). */
export interface FriendRequestView {
  fromAccountId: string;
  name: string;
  friendCode: string;
  created_at: number;
}
export const getFriendRequests = () =>
  req<FriendRequestView[]>("GET", "/friends/requests");

/** Accept a pending request. Returns the new friend (or null). */
export const acceptFriend = (fromAccountId: string) =>
  req<{ friend: FriendView | null }>("POST", "/friends/accept", { fromAccountId });

/** Reject / withdraw a pending request. */
export const rejectFriend = (accountId: string) =>
  req<{ ok: true }>("POST", "/friends/reject", { accountId });

/** Unfriend an existing friend. */
export const removeFriendOnline = (accountId: string) =>
  req<{ ok: true }>("POST", "/friends/remove", { accountId });

/** Block an account (also tears down any edge/request both ways). */
export const blockFriend = (accountId: string) =>
  req<{ ok: true }>("POST", "/friends/block", { accountId });

/** Get a fresh friend code (rotation). Updates the stored session. */
export async function rotateFriendCode(): Promise<string> {
  const r = await req<{ friendCode: string }>("POST", "/friends/code/rotate");
  if (session) setSession({ ...session, friendCode: r.friendCode });
  return r.friendCode;
}

/** Fetch a friend's farm as a READ-ONLY projection (server strips currency,
 *  progression, and their social block — see projectFriendSave). Powers the
 *  "visit a friend's farm" view. Throws ApiError(403, "not_friends") if the
 *  friendship no longer exists, or (404, "no_save") if they've never saved. */
export const getFriendSave = (accountId: string) =>
  req<{ save: SaveGame }>("GET", `/friends/${encodeURIComponent(accountId)}/save`);

/** Ask to befriend the owner of `code`. Consent-based: this files a request that
 *  the recipient must accept — no friendship exists yet. The server responds the
 *  same way whether or not the code is real (non-oracle), so this always resolves
 *  to { ok: true } on a well-formed call. */
export const addFriend = (code: string) =>
  req<{ ok: true }>("POST", "/friends/add", { code });

/** Send a brain. Throws ApiError(429) if the daily limit is hit. */
export const sendGift = (toAccountId: string) =>
  req<{ ok: true }>("POST", "/gifts", { toAccountId });

export const getInbox = () => req<InboxGift[]>("GET", "/gifts/inbox");

/** Claim a gift. The response includes the authoritative balance after settlement so
 *  the client can display the brain immediately without a second bootstrap round trip. */
export const claimGift = (giftId: string) =>
  req<{ balance: Balance; accountVersion: number; alreadyClaimed: boolean; credited: boolean }>(
    "POST",
    "/gifts/claim",
    { giftId }
  );

// ---- economy (server-authoritative balances) ----------------------------
export type Currency = "gold" | "brains" | "xp";
export interface Balance {
  gold: number;
  brains: number;
  xp: number;
}
export interface EconomyEvent {
  id: string;
  currency: Currency;
  delta: number;
  reason: string;
  queuedAt?: number;
}
export interface EconomyResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
}

/** Read the authoritative balance, seeding it once from `seed` (the client's current
 *  currency) if the server has no balance row yet. Server-owned thereafter — `seed`
 *  is ignored once seeded, so this also serves as a plain refresh. */
export const syncEconomy = (seed: Balance) =>
  req<Balance>("POST", "/economy/sync", { seed });

/** Submit a batch of currency events; returns the new authoritative balance and a
 *  per-event verdict (applied / duplicate / rejected). Idempotent by event id. */
export const applyEconomy = (events: EconomyEvent[]) =>
  req<{ balance: Balance; results: EconomyResult[] }>("POST", "/economy/apply", { events });

// ---- quests (server-authoritative, bounded-once rewards) ----------------
export interface QuestCompleteResult {
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  balance: Balance;
  /** What was actually credited this call (0s on duplicate; item/zombie deferred). */
  granted: { gold: number; brains: number; xp: number };
  /** True when the reward is an item/zombie the server records but can't grant yet. */
  deferred: boolean;
}

export interface AuthoritativeState {
  integrityVersion: 2;
  balance: Balance;
  level: number;
  zombieMax: number;
  inventory: Record<string, number>;
  objectCounts: Record<string, number>;
  objects: NonNullable<SaveGame["objects"]>;
  roster: NonNullable<SaveGame["ownedZombies"]>;
  farm: { size: number; plots: SaveGame["farm"]["plots"] };
  shop: ShopState;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  raids: { progress: Record<string, number>; lastRaidAt: number };
  quests: QuestStateResult;
}

export const getState = () => req<AuthoritativeState>("GET", "/state");

export interface QuestChange {
  questId: string;
  counts: number[];
  completed: boolean;
}

export interface QuestStateResult {
  completed: string[];
  progress: { questId: string; counts: number[] }[];
  questChanges: QuestChange[];
}

export const questState = () => req<QuestStateResult>("GET", "/quest/state");

/** Complete a quest server-side: grants its SERVER-catalog reward (currency + any
 *  level-up it triggers) at most once per quest. Idempotent by (account, quest) — a
 *  retry returns status "duplicate" and credits nothing. */
export const completeQuest = (questId: string) =>
  req<QuestCompleteResult>("POST", "/quest/complete", { questId });

// ---- farm actions (exact per-action economics) --------------------------
export type FarmAction =
  | { id: string; type: "plant"; oc: number; or: number; cropKey: string; fertilized?: boolean }
  // `unitId` is sent only when harvesting a ZOMBIE crop: the owned unit id the harvest
  // yields, which the server records as a verified roster unit.
  | { id: string; type: "harvest"; oc: number; or: number; unitId?: string }
  // Till a plot. The server owns the plow cost (free with a Plowing Monolith) and
  // records the soil, which a later plant requires.
  | { id: string; type: "plow"; oc: number; or: number };
export interface FarmResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  gold?: number;
  xp?: number;
  fertilized?: boolean; // plant only: the SERVER's fertilize decision
}

export interface FarmState {
  plowed: { oc: number; pr: number }[];
  crops: {
    oc: number;
    pr: number;
    crop_key: string;
    planted_at: number;
    grow_ms: number;
    fertilized: number;
  }[];
}

/** Submit farm actions (plow/plant/harvest). The server computes exact economics and
 *  gates harvest by server time; returns the new authoritative balance + verdicts. */
export const applyFarm = (actions: FarmAction[]) =>
  req<{ balance: Balance; results: FarmResult[]; farm: FarmState; questChanges: QuestChange[] }>("POST", "/farm/actions", { actions });

/** One-time import of a migrating save's already-PLOWED soil, so plants there aren't
 *  rejected as `not_plowed`. Ignored (and merely read back) once the account is seeded
 *  or past the migration cutoff. Returns the authoritative plowed set. */
export const syncFarm = (plowed: { oc: number; or: number }[]) =>
  req<{ plowed: { oc: number; pr: number }[] }>("POST", "/farm/sync", { plowed });

// ---- inventory (server-owned consumable boosts) -------------------------
export type InventoryAction =
  | { id: string; type: "buy"; key: string }
  // `unitId`: gift vouchers only — the zombie the redeem grants is filed under this id.
  | { id: string; type: "use"; key: string; qty?: number; unitId?: string; oc?: number; or?: number }
  | { id: string; type: "grant"; key: string; qty?: number };

export interface InventoryResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
}

/** Seed the server boost inventory from the save (one-time; INSERT OR IGNORE) and read
 *  back the authoritative counts. Also used as a plain "read current inventory". */
export const syncInventory = (counts: Record<string, number>) =>
  req<{ inventory: Record<string, number> }>("POST", "/inventory/sync", { counts });

/** Apply boost buy/use/grant actions; returns the resulting balance + full inventory. */
export const applyInventory = (actions: InventoryAction[]) =>
  req<{ balance: Balance; inventory: Record<string, number>; results: InventoryResult[]; farm: FarmState; questChanges: QuestChange[] }>(
    "POST",
    "/inventory/actions",
    { actions }
  );

// ---- objects (server-owned placeable ownership) -------------------------
export type ObjectAction =
  | { id: string; type: "buy"; key: string }
  | { id: string; type: "refund"; key: string }
  // In-place swap at the new object's full price (the shed upgrade).
  | { id: string; type: "upgrade"; fromKey: string; toKey: string };

export interface ObjectResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
}

/** Seed the server object counts from the save (one-time) and read them back. */
export const syncObjects = (counts: Record<string, number>) =>
  req<{ objects: Record<string, number> }>("POST", "/object/sync", { counts });

/** Apply object buy/refund actions; returns the resulting balance + object counts. */
export const applyObjects = (actions: ObjectAction[]) =>
  req<{ balance: Balance; objects: Record<string, number>; results: ObjectResult[]; questChanges: QuestChange[] }>(
    "POST",
    "/object/actions",
    { actions }
  );

// ---- roster (server-owned zombie units) ---------------------------------
export type RosterAction =
  | { id: string; type: "sell"; unitId: string }
  | { id: string; type: "grant"; unitId: string; key: string; mutation?: number; invasions?: number }
  | { id: string; type: "veteran"; unitIds: string[] }
  | { id: string; type: "casualty"; unitIds: string[] }
  | { id: string; type: "combineStart"; parentAId: string; parentBId: string }
  | { id: string; type: "combineCollect"; unitId: string; key: string; mutation?: number };

export interface RosterResult {
  id: string;
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  gold?: number; // sell payout
}

export interface RosterSeedUnit {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
}

/** Seed the server roster shadow from the save's units (one-time; INSERT OR IGNORE). */
export const syncRoster = (units: RosterSeedUnit[]) =>
  req<{ count: number }>("POST", "/roster/sync", { units });

/** Apply roster sell/grant/veteran/casualty actions; returns the resulting balance. */
export const applyRoster = (actions: RosterAction[]) =>
  req<{ balance: Balance; results: RosterResult[]; questChanges: QuestChange[] }>("POST", "/roster/actions", { actions });

// ---- shop (server-owned farm size + climate skins) ----------------------
export interface ShopState {
  size: number;
  climates: string[];
}
export interface ShopResult extends ShopState {
  ok: boolean;
  error?: string;
  balance: Balance;
}

/** Seed + read the server-owned farm size + climate set (from the save on first call). */
export const shopState = (size: number, climates: string[]) =>
  req<ShopState>("POST", "/shop/state", { size, climates });

/** Buy the next farm-size tier for the exact price. Returns the authoritative state. */
export const shopSize = (actionId: string, size: number, currency: "gold" | "brains") =>
  req<ShopResult>("POST", "/shop/size", { actionId, size, currency });

/** Buy a ground/climate skin for its exact price. Returns the authoritative state. */
export const shopClimate = (actionId: string, terrain: string) =>
  req<ShopResult>("POST", "/shop/climate", { actionId, terrain });

// ---- raids (server-owned cooldown + progress) ----------------------------
/** Authoritative raid cooldown clock + progress (lifetime wins per raid id, which drive
 *  ability unlocks). The client seeds its display and its unlocks from this. */
export const raidState = () =>
  req<{
    lastRaidAt: number;
    cooldownMs: number;
    cooldownRemaining: number;
    progress: Record<string, number>;
  }>("GET", "/raid/state");

/** One-time import of this save's lifetime raid wins, so a migrating veteran isn't seen
 *  as having cleared nothing (which would re-grant every first-clear XP award and drop
 *  their ability unlocks). Ignored once seeded or past the migration cutoff. */
export const raidSync = (completed: Record<string, number>) =>
  req<{ progress: Record<string, number> }>("POST", "/raid/sync", { completed });

/** Server-owned item storage: the Received bucket (raid loot awaiting claim) and the
 *  shed. Imports this save's items ONCE (cutoff-gated), then just reads them back. Raid
 *  loot lands in `received` server-side, and the loot roll reads these to decide whether
 *  a unique may still drop. */
export const storageSync = (received: string[], stored: { key: string; count: number }[]) =>
  req<{ received: Record<string, number>; stored: Record<string, number> }>("POST", "/storage/sync", {
    received,
    stored,
  });

/** Ask the server to authorize a raid on `raidId`. `ok:false` with `cooldownRemaining`
 *  means the server cooldown is still active (and no voucher bypass was requested).
 *  `error:"locked"` means the account's server-derived level hasn't unlocked this raid;
 *  `error:"raid_in_progress"` means another raid is already open (one at a time).
 *  `bypassed:true` means a cooldown was skipped via `bypass` (the server consumed the
 *  voucher). `sessionId` pairs with raidFinish and pins the raid the reward is priced
 *  from. */
export const raidStart = (
  useVoucher: boolean,
  raidId: number,
  orderedUnitIds: string[],
  concentration = false,
  dice = 0
) =>
  req<{
    ok: boolean;
    sessionId?: string;
    bypassed?: boolean;
    cooldownRemaining?: number;
    error?: string;
    unlockLevel?: number;
    /** Golden Dice the server actually consumed + pinned to the session (may be fewer
     *  than asked if the stock ran short). Its loot roll uses this number. */
    dice?: number;
    concentration?: boolean;
    inventory?: Record<string, number>;
    /** Authoritative time at which this accepted invasion started its cooldown. */
    lastRaidAt?: number;
    /** Earliest server time at which a non-retreat result may be settled. */
    earliestFinishAt?: number;
  }>("POST", "/raid/start", {
    useVoucher,
    raidId,
    orderedUnitIds,
    concentration,
    dice,
    rulesetVersion: RAID_RULESET_VERSION,
  });

/** The server's authoritative raid-finish result: the cooldown clock, the resulting
 *  balance, and the amounts CREDITED this call (0 on a loss / idempotent replay). */
export interface RaidFinishResult {
  lastRaidAt: number;
  balance: Balance;
  gold: number;
  xp: number;
  firstClear: boolean;
  /** The session had already expired (not settled within its TTL) — nothing credited. */
  expired?: boolean;
  /** The SERVER's loot roll for this win (the client no longer rolls its own online):
   *  the drop's name + what it became. Null when nothing dropped, on a loss, or on a
   *  replayed finish. */
  loot?: { name: string; kind: "gold" | "boost" | "item" } | null;
  outcome?: RaidOutcome;
  questChanges?: QuestChange[];
  inventory?: Record<string, number>;
  storage?: { received: Record<string, number>; stored: Record<string, number> };
  raidProgress?: Record<string, number>;
  rulesetVersion?: number;
  revival?: {
    sessionId: string;
    zombies: { id: string; key: string; mutation: number; invasions: number; stored: boolean }[];
    costPerZombie: 1;
  } | null;
}

/** Report a finished raid. The server starts the cooldown (idempotent) AND credits
 *  the server-computed base win gold + first-clear XP for the session's pinned raid,
 *  returning the authoritative balance to reconcile. `win`/`survivalFrac` are the
 *  client's outcome assertion; the server owns the reward number. */
export const raidFinish = (sessionId: string, finalTick: number, inputs: RaidReplayInput[], outcome?: RaidOutcome) =>
  req<RaidFinishResult>("POST", "/raid/finish", {
    sessionId,
    finalTick,
    retreated: inputs.some((input) => input.type === "retreat"),
    // v3 trusts combat quality/casualty claims, but the server validates this as a
    // partition of the roster locked at start and prices every reward itself.
    win: outcome?.win ?? false,
    survivors: outcome?.survivors ?? [],
    losses: outcome?.losses ?? [],
  });

export interface RaidReviveResult {
  ok: true;
  revivedIds: string[];
  balance: Balance;
}

/** Resolve a raid's one-time casualty offer. Any casualty omitted from reviveIds is
 * permanently abandoned; each accepted id costs one brain. */
export const raidRevive = (sessionId: string, reviveIds: string[]) =>
  req<RaidReviveResult>("POST", "/raid/revive", { sessionId, reviveIds });

export const raidCheckpoint = (sessionId: string, finalTick: number, inputs: RaidReplayInput[]) =>
  req<{ ok: boolean; finalTick: number; lastSeq: number; finished: boolean; replayCpuMs: number }>(
    "POST",
    "/raid/checkpoint",
    { sessionId, finalTick, inputs }
  );

export interface EpicBossFinishResult {
  event: import("./protocol").EpicBossProjection;
  defeatedLevel: number | null;
  escaped: boolean;
  loot: { name: string; tile?: string; stageActor?: string; sprite: string } | null;
  balance: Balance;
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  ownedPets: string[];
  survivors: string[];
  losses: string[];
  quests: import("./protocol").QuestProjection;
  questChanges: QuestChange[];
  newZombies: { id: string; key: string; stored: boolean }[];
}

export const epicBossActivate = (activationId: string, bossId: string) => req<{
  event: import("./protocol").EpicBossProjection;
  balance: Balance;
}>("POST", "/epic-boss/activate", { activationId, bossId });

export const epicBossEnd = (runId: string) => req<{
  event: import("./protocol").EpicBossProjection;
}>("POST", "/epic-boss/end", { runId });

export const epicBossStart = (orderedUnitIds: string[], payment: import("../epicBoss/tokens").EpicBossPayment) => req<{
  ok: true;
  sessionId: string;
  event: import("./protocol").EpicBossProjection;
  balance: Balance;
  expiresAt: number;
}>("POST", "/epic-boss/start", { orderedUnitIds, payment });

export const epicBossFinish = (
  sessionId: string,
  finalTick: number,
  inputs: RaidReplayInput[],
) => req<EpicBossFinishResult>("POST", "/epic-boss/finish", {
  sessionId,
  finalTick,
  inputs,
});

// A server friend rendered into the client's Friend shape (for the HUD cache).
export function toFriend(f: FriendView): Friend {
  return {
    id: f.accountId,
    name: f.name,
    addedAt: 0,
    giftsSent: 0,
    friendCode: f.friendCode,
    giftOnCooldown: f.giftOnCooldown ?? false,
  };
}
