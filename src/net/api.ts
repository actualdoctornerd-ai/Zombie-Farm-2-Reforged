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
import { BUILD_TAG } from "../version";
import { crumb } from "../breadcrumbs";
import type { RaidOutcome } from "../raid/types";
import type { PvpFightConfig } from "../raid/pvp";
import {
  CLIENT_INTEGRITY_VERSION,
  GAMEPLAY_PROTOCOL,
  type BootstrapResponse,
  type CommandBatchRequest,
  type CommandBatchResponse,
  type BlackMarketCollectResponse,
  type BlackMarketCurrency,
  type BlackMarketFulfillmentsResponse,
  type BlackMarketHistoryResponse,
  type BlackMarketListResponse,
  type BlackMarketMutationResponse,
  type BlackMarketOrderKind,
  type BlackMarketSummary,
  type FriendActivity,
  type GiftReward,
  type PeriodicQuestProjection,
  type PresentationProjection,
  type PresentationRequest,
} from "./protocol";
export type { GiftReward } from "./protocol";
import { purgeRetiredOnlineStorage } from "./storageCleanup";
export type { RaidReplayInput } from "../raid/replay";

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const SESSION_KEY = "zf2r.v3.session";
const DEVICE_KEY = "zf2r.v3.device";
const CLIENT_KEY = "zf2r.v4.writer-client";
const WRITER_KEY = "zf2r.v4.writer";

// v3 is an intentional clean break for old ONLINE credentials and mutation
// queues. The cleanup is explicit so importing the optional API client can never
// erase Local Farm saves, profile metadata, preferences, or current online queues.
purgeRetiredOnlineStorage();

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

/** This browser profile's writer identity. Deliberately in localStorage, not
 *  sessionStorage: the server can silently re-issue a lease to the same
 *  client+session presenting a fresh token, but a per-tab id makes every reopen
 *  look like a new client and forces the "Farm active elsewhere" takeover gate.
 *  It is an availability key, never a credential on its own — the lease is still
 *  fenced by writer_session_id and the hashed writer token. */
export function writerClientId(): string {
  try {
    const current = localStorage.getItem(CLIENT_KEY);
    if (current) return current;
    const created = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, created);
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
let writerConfirmedHandler: (() => void) | null = null;
let sessionRejectedHandler: (() => void) | null = null;

// A server credential belongs to one live document at a time. Web Locks are scoped
// to the origin and released automatically when a document unloads OR crashes,
// which is what makes them a trustworthy "is another tab of this game alive right
// now?" probe. The name is scoped to the ACCOUNT, not to this document's clientId:
// a per-client name means two independent tabs request different locks and never
// contend, so the lock could only ever fence a duplicated tab. Account scoping is
// what distinguishes a genuine second tab (lock held -> read-only) from a reopen
// after close (lock free -> claim it silently). A losing document never deletes the
// persisted credential.
const supportsWriterLocks = typeof navigator !== "undefined" && !!navigator.locks;
let localWriterLockHeld = !supportsWriterLocks;
let writerLockRequest: Promise<boolean> | null = null;
let writerLockAccountId: string | null = null;

// Deferred until the account is known — unlike the old per-client name, this one
// cannot be built at module load, and prepareWriterAccess() already runs after auth.
function requestWriterLock(accountId: string): Promise<boolean> {
  if (writerLockRequest && writerLockAccountId === accountId) return writerLockRequest;
  writerLockAccountId = accountId;
  writerLockRequest = new Promise<boolean>((resolve) => {
    let settle: ((held: boolean) => void) | null = resolve;
    const grant = () => {
      localWriterLockHeld = true;
      // A contending document suppresses its in-memory copy while it waits. Restore
      // that copy only after the browser grants this document exclusive ownership.
      writerCredential ??= readWriterCredential();
      settle?.(true);
      settle = null;
    };
    void navigator.locks.request(`zf2r.v4.writer:${accountId}`, async () => {
      grant();
      await new Promise<void>(() => { /* held for this document's lifetime */ });
    }).catch(() => {
      // Web Locks are an availability guard, not the server security boundary. If a
      // browser advertises the API but it fails, preserve the existing server fence.
      grant();
    });
  });
  return writerLockRequest;
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
  // Offline-only mode and the signed-out path have no account to contend over, so
  // there is nothing to fence; grant immediately as the pre-account-scoped lock did.
  if (!API || !session) {
    localWriterLockHeld = true;
    return true;
  }
  const acquired = await Promise.race([
    requestWriterLock(session.accountId),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
  ]);
  if (!acquired) writerCredential = null; // suppress locally; never erase sessionStorage
  // A timeout here is not an error and produces no log, but it decides whether this
  // document may write for the rest of its life — and reads later only as the `nolock`
  // fragment of `unavailableReason`, with nothing to say when or why. Crumb the answer.
  crumb("writer:lock", acquired ? "granted" : `not granted (another tab held it ${waitMs}ms)`);
  return acquired;
}

/** The clientId the server fences this document's writes against. A command batch
 *  MUST stamp this rather than re-reading `writerClientId()`: `POST /commands` answers
 *  400 `bad_writer_command` when the body's deviceId disagrees with the X-Writer-Client
 *  header, and the batch CAS additionally requires it to equal the stored
 *  `writer_device_id`. The two drift apart whenever the localStorage client key is
 *  rebuilt while the sessionStorage credential survives — an evicted key on iOS, a
 *  site-data clear with the tab still open, or an envelope persisted by a client
 *  released before the v4 writer id. Because a rejected batch is retried verbatim
 *  forever, that drift is what strands a player on "Gameplay paused — reconnect to
 *  continue" with a perfectly good connection. */
export const writerRequestClientId = (): string => {
  // Mirrors the condition req() attaches X-Writer-Client under, so body and header
  // are always drawn from the same credential or neither is.
  const fenced = writerCredential && writerCredential.accountId === session?.accountId;
  if (fenced) noteWriterIdentity(writerCredential!.clientId);
  return fenced ? writerCredential!.clientId : writerClientId();
};

/** Whether the credential this document writes under still agrees with the client key on
 *  disk — "match", "DRIFTED", or "" when there is nothing to compare. Read by the
 *  diagnostics report; see `noteWriterIdentity` for why it is worth a line of its own. */
export const writerIdentityState = (): string => identityState;
let identityState = "";

/** THE drift described above, made visible.
 *
 *  When the localStorage client key is rebuilt while the sessionStorage credential
 *  survives — an evicted key on iOS, a site-data clear with the tab still open — the two
 *  disagree, `POST /commands` answers 400 `bad_writer_command`, and because a rejected
 *  batch is retried verbatim the player is stranded on "Gameplay paused — reconnect to
 *  continue" on a perfectly good connection, permanently. Nothing said so: the batch is
 *  correctly fenced, the lease is live, and every symptom points at the network.
 *
 *  Only a MISMATCH is crumbed. A healthy session says nothing, which is what keeps this
 *  useful on a hot path — and makes the crumb's presence meaningful on its own. */
function noteWriterIdentity(credentialClientId: string): void {
  const stored = (() => {
    try { return localStorage.getItem(CLIENT_KEY); } catch { return null; }
  })();
  // No stored key at all is not drift: `writerClientId()` mints one on demand, and this
  // document is already writing under the credential's id either way.
  if (stored === null) return;
  const next = stored === credentialClientId ? "match" : "DRIFTED";
  if (next === identityState) return;
  identityState = next;
  if (next === "DRIFTED") {
    crumb("writer:identity", "client key no longer matches the lease — batches will be refused");
  }
}

export const hasLocalWriterLock = (): boolean => localWriterLockHeld;
export const hasWriterCredential = (): boolean => localWriterLockHeld &&
  !!writerCredential && writerCredential.accountId === session?.accountId;
export const clearWriterCredential = (): void => persistWriter(null);
export const setWriterRejectedHandler = (handler: (() => void) | null): void => { writerRejectedHandler = handler; };
/** Successful writer-protected requests prove that this document still owns the
 * server lease. Higher layers use that proof to postpone otherwise-idle polling. */
export const setWriterConfirmedHandler = (handler: (() => void) | null): void => { writerConfirmedHandler = handler; };
export const setSessionRejectedHandler = (handler: (() => void) | null): void => { sessionRejectedHandler = handler; };

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

/** The configured Worker origin, or null in an offline build. Exposed so the
 *  pre-sign-in service probe (serviceStatus.ts) can reach `GET /` without going
 *  through the authenticated request helper. */
export function baseUrl(): string | null {
  return API || null;
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
const writerProtectedRequest = (method: string, path: string): boolean => {
  if (method === "PUT" && (path === "/presentation" || path === "/save")) return true;
  if (method !== "POST") return false;
  return path === "/commands" || path === "/gifts" ||
    path.startsWith("/raid/") || path.startsWith("/epic-boss/") || path.startsWith("/black-market/");
};

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true
): Promise<T> {
  if (!API) throw new ApiError(0, "not_configured");
  const headers: Record<string, string> = {};
  let writerCredentialAttached = false;
  headers["X-Integrity-Version"] = String(CLIENT_INTEGRITY_VERSION);
  headers["X-Client-Build"] = BUILD_TAG;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!session) throw new ApiError(401, "no_session");
    headers["Authorization"] = `Bearer ${session.token}`;
    if (localWriterLockHeld && writerCredential?.accountId === session.accountId) {
      headers["X-Writer-Client"] = writerCredential.clientId;
      headers["X-Writer-Generation"] = String(writerCredential.generation);
      headers["X-Writer-Token"] = writerCredential.token;
      writerCredentialAttached = true;
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
    if (res.status === 401) {
      const wasSignedIn = !!session;
      clearSession(); // stale/invalid/revoked token → sign out
      if (wasSignedIn) sessionRejectedHandler?.();
    }
    if (res.status === 423 && code === "writer_replaced") {
      crumb("writer:replaced", "another device took the lease");
      clearWriterCredential();
      writerRejectedHandler?.();
    }
    throw new ApiError(res.status, code, data);
  }
  if (writerCredentialAttached && writerProtectedRequest(method, path)) writerConfirmedHandler?.();
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
export interface FriendView {
  accountId: string;
  name: string;
  friendCode: string;
  level?: number;
  /** The Farmer head they're wearing, so their row can show their face. Absent from
   *  an older Worker, and for an account with no materialized farm yet. */
  headId?: number;
  giftOnCooldown?: boolean;
  /** Blocked specifically because they still hold an unopened gift from me (as
   *  opposed to simply having been gifted today). */
  giftPending?: boolean;
  /** Lifetime gifts this friend has sent me. */
  giftsReceived?: number;
  /** How recently they played, at the only resolution the server discloses. */
  activity?: FriendActivity;
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
  // Generation is a small counter, not an identifier — see the crumb contract in
  // SECURITY.md. The clientId and token never appear here and must not.
  crumb("writer:acquired", `generation ${result.writerGeneration}${takeover ? " (takeover)" : ""}`);
  bootstrapPromise = null;
}

export async function releaseWriter(): Promise<void> {
  if (!hasWriterCredential()) return;
  crumb("writer:released");
  try { await req<{ ok: true }>("POST", "/writer/release"); }
  finally { clearWriterCredential(); }
}

// Hand the lease back on a clean teardown so the next launch finds it free instead
// of meeting the takeover gate. sendBeacon cannot carry the X-Writer-* headers the
// endpoint authenticates on, so this is a keepalive fetch: same headers as req(),
// but allowed to outlive the document. Fire-and-forget — the response is unreadable
// by then, and the stable clientId (silent re-acquire) plus the server-side idle
// expiry remain the nets for the paths this cannot cover, like a crash or force-quit.
const releaseWriterOnUnload = (event: PageTransitionEvent): void => {
  // A bfcache freeze can be restored into a live document that still believes it
  // owns the lease. Only release when the page is genuinely going away.
  if (event.persisted) return;
  if (!API || !session || !hasWriterCredential() || !writerCredential) return;
  try {
    void fetch(`${API}/writer/release`, {
      method: "POST",
      keepalive: true,
      headers: {
        "X-Integrity-Version": String(CLIENT_INTEGRITY_VERSION),
        "X-Client-Build": BUILD_TAG,
        "Authorization": `Bearer ${session.token}`,
        "X-Writer-Client": writerCredential.clientId,
        "X-Writer-Generation": String(writerCredential.generation),
        "X-Writer-Token": writerCredential.token,
      },
    }).catch(() => { /* unload is best-effort */ });
  } catch { /* unload is best-effort */ }
};

/** The friend invasion this document is holding open, if any. A live PvP session is a
 *  one-at-a-time lock exactly like the writer lease, and a tab closed mid-battle used
 *  to strand it for the full 15-minute TTL. Set on launch, cleared on settle. */
let liveInvasionSession: string | null = null;
export const setLiveInvasionSession = (sessionId: string | null): void => {
  liveInvasionSession = sessionId;
};

const releaseInvasionOnUnload = (event: PageTransitionEvent): void => {
  if (event.persisted) return; // bfcache freeze — the fight may still be resumed
  if (!API || !session || !liveInvasionSession) return;
  try {
    // Same keepalive-fetch reasoning as the writer lease above: this needs the bearer
    // header, so sendBeacon is out. Best-effort; the TTL is still the backstop.
    void fetch(`${API}/raid/pvp/abandon`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-Integrity-Version": String(CLIENT_INTEGRITY_VERSION),
        "X-Client-Build": BUILD_TAG,
        "Authorization": `Bearer ${session.token}`,
      },
      body: JSON.stringify({ sessionId: liveInvasionSession }),
    }).catch(() => { /* unload is best-effort */ });
  } catch { /* unload is best-effort */ }
};

if (typeof addEventListener === "function") {
  addEventListener("pagehide", releaseWriterOnUnload);
  addEventListener("pagehide", releaseInvasionOnUnload);
}

export const writerStatus = () =>
  req<{ status: "free" | "mine" | "other"; generation: number; lastActivityAt: number }>(
    "GET", "/writer/status"
  );

export const sendCommandBatch = (batch: CommandBatchRequest) =>
  req<CommandBatchResponse>("POST", "/commands", batch);

export const putPresentationV3 = (payload: PresentationRequest) =>
  req<PresentationProjection>("PUT", "/presentation", payload);

export const blackMarketOrders = (query: {
  kind: BlackMarketOrderKind;
  /** Colour class — the toolbar's "category" (Green/Blue/Red/Silver/Special). */
  zombieClass?: string;
  /** Body family — the toolbar's "class" (Regular/Female/Large/Garden/Headless/Small). */
  zombieGroup?: string;
  /** Narrow the board to posts priced in one currency; the price sorts only compare
   *  within one. Omitted means both. */
  currency?: BlackMarketCurrency;
  sort?: "newest" | "price_asc" | "price_desc";
  mine?: boolean;
  cursor?: string;
}) => {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.zombieClass) params.set("zombieClass", query.zombieClass);
  if (query.zombieGroup) params.set("zombieGroup", query.zombieGroup);
  if (query.currency) params.set("currency", query.currency);
  if (query.sort) params.set("sort", query.sort);
  if (query.mine) params.set("mine", "true");
  if (query.cursor) params.set("cursor", query.cursor);
  return req<BlackMarketListResponse>("GET", `/black-market/orders?${params}`);
};

export const blackMarketSummary = () => req<BlackMarketSummary>("GET", "/black-market/summary");

// `price` is denominated in `currency`; the Worker defaults an omitted currency to
// BRAINS, which is what every post created before gold pricing was.
export const createBlackMarketOrder = (body:
  | { operationId: string; expectedAccountVersion: number; kind: "SELL_ZOMBIE"; unitId: string;
      price: number; currency: BlackMarketCurrency }
  | { operationId: string; expectedAccountVersion: number; kind: "BUY_ZOMBIE"; zombieKey: string;
      mutated: boolean; mutationRequired?: number; price: number; currency: BlackMarketCurrency }
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

/** Bump one of your own open posts back to the top of "newest" and restart the three
 *  days before it expires. Rate-limited server-side by how long the post has sat, so
 *  no CAS version is needed: nothing about the account's economy changes. */
export const repostBlackMarketOrder = (id: string) =>
  req<BlackMarketMutationResponse>("POST", `/black-market/orders/${encodeURIComponent(id)}/repost`, {});

export const blackMarketFulfillments = () =>
  req<BlackMarketFulfillmentsResponse>("GET", "/black-market/fulfillments");

export const collectBlackMarketOrder = (id: string) =>
  req<BlackMarketCollectResponse>("POST", `/black-market/orders/${encodeURIComponent(id)}/collect`, {});

export const blackMarketHistory = () =>
  req<BlackMarketHistoryResponse>("GET", "/black-market/history");

/** Set this account's chosen display name. Updates the stored session, returns the
 *  normalized value. Throws ApiError(400, "bad_username") if it doesn't validate. */
export async function setUsername(name: string): Promise<string> {
  const r = await req<{ username: string }>("POST", "/username", { username: name });
  if (session) setSession({ ...session, username: r.username });
  return r.username;
}

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

/** Delete this account and everything attached to it, permanently, then drop the
 *  local session so the tab cannot keep using a token whose row no longer exists.
 *
 *  `confirm: "DELETE"` is required by the route. The UI asks the player twice
 *  before calling this; the token is a second lock so the destructive route cannot
 *  be reached by a bare replayed POST.
 *
 *  The server does NOT leave a blanked account behind — the row goes, which frees
 *  the Google id, so signing in again creates a genuinely new account rather than
 *  restoring this one. Throws ApiError(409) with `market_unsettled` when a trade is
 *  still in flight; the caller shows that as its own message.
 *
 *  THE LEASE IS NOT RELEASED FIRST, which is deliberate. This route REFUSES on paths
 *  the design expects a player to reach — an open Black Market post, a batch still
 *  settling, a closedown window — and releasing up front clears the local credential
 *  before finding that out. Nothing re-acquires it: `checkOwnership` returns early
 *  when there is no credential, so the document is left unable to write and the next
 *  gameplay action raises the "Farm active elsewhere" takeover gate at a player whose
 *  farm is fine and whose deletion never happened.
 *
 *  Releasing first buys nothing either way. The lease lives in `account_runtime_v3`,
 *  which the purge deletes with every other row, so a SUCCESSFUL deletion frees it
 *  regardless — and the local credential is dropped here afterwards without a
 *  request, because the row it names is already gone. */
export async function deleteAccount(): Promise<void> {
  await req<{ ok: true }>("POST", "/account/delete", { confirm: "DELETE" });
  clearWriterCredential(); // local only — the server row went with the account
  clearSession();
}

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

/** The lifetime-tally counters the server projects onto the friend leaderboard —
 *  a fixed subset of the Statistics panel's tally (src/stats.ts), with the bulky
 *  per-crop harvest map already summed. Mirrors server logic.ts LeaderboardStats. */
export interface FriendLeaderboardStats {
  harvested: number;
  planted: number;
  plowed: number;
  treesHarvested: number;
  goldEarned: number;
  brainsEarned: number;
  zombiesGrown: number;
  zombiesCombined: number;
  raidsWon: number;
  raidsLost: number;
}

/** One farmer on the friend leaderboard: the caller (`self`) or an accepted friend. */
export interface FriendLeaderboardEntry {
  accountId: string;
  name: string;
  /** Present (true) only on the caller's own row. */
  self?: boolean;
  /** The Farmer head they're wearing, same as the friends list row. */
  headId?: number;
  /** Server-derived level (from server-owned XP) — the one authoritative column. */
  level: number;
  /** Null when they've never published a tally (older client, or never synced) —
   *  shown as "no stats yet", never scored as a farm of zeroes. */
  stats: FriendLeaderboardStats | null;
}

/** You + your accepted friends, with the numbers the leaderboard ranks. Unordered:
 *  rank depends on which stat is ranked, so sorting is the caller's job
 *  (social/leaderboard.ts rankLeaderboard). */
export const getFriendLeaderboard = () =>
  req<{ entries: FriendLeaderboardEntry[] }>("GET", "/leaderboard/friends")
    .then((r) => r.entries);

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

/** Send a gift. The first two daily sends are free; later sends cost 100 gold, with
 * no ceiling on how many friends you can reach. Throws ApiError(409) without enough
 * gold or when they still hold an unopened gift (`gift_pending`), and ApiError(429)
 * if they were already gifted today. */
export const sendGift = (toAccountId: string) =>
  req<{ ok: true; xpAwarded?: number; giftsSentToday?: number; balance?: Balance; accountVersion?: number; lastRaidAt?: number; serverTime?: number }>(
    "POST", "/gifts", { toAccountId }
  );

export const getInbox = () => req<InboxGift[]>("GET", "/gifts/inbox");

/** Claim a gift. The response includes the authoritative balance after settlement so
 *  the client can display the reward immediately without a second bootstrap round trip.
 *  `reward` is null on an already-claimed gift (there is nothing new to reveal). */
export const claimGift = (giftId: string) =>
  req<{
    balance: Balance;
    accountVersion: number;
    alreadyClaimed: boolean;
    credited: boolean;
    reward: GiftReward | null;
  }>(
    "POST",
    "/gifts/claim",
    { giftId }
  );

// ---- shared value types --------------------------------------------------
// The protocol-v2 read/sync/action wrappers that used to live here (/economy/*,
// /quest/*, /farm/*, /inventory/*, /object/*, /roster/*, /shop/*, /raid/state,
// /raid/sync, /storage/sync) are gone with the routes; the Worker answers 410 on
// those paths. Only the value types the v3 economy client still speaks remain.
export type Currency = "gold" | "brains" | "xp";
export interface Balance {
  gold: number;
  brains: number;
  xp: number;
}

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

export interface FarmState {
  plowed: { oc: number; pr: number }[];
  /** Harvested plots remain owned soil: zombie holes versus ordinary crop dirt. */
  spent?: { oc: number; pr: number; zombie: boolean }[];
  crops: {
    oc: number;
    pr: number;
    crop_key: string;
    planted_at: number;
    grow_ms: number;
    fertilized: number;
  }[];
}

export interface RosterSeedUnit {
  id: string;
  key: string;
  mutation: number;
  invasions: number;
}

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
  dice = 0,
  brainTicket = false
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
    /** Server-pinned 1/3/5 brain award. It is visualized during combat but is
     * credited only if raidFinish verifies a boss-defeating win. */
    brainDrop?: number;
    concentration?: boolean;
    /** Whether the server actually charged a Brain Ticket and pinned this session as an
     *  ELITE invasion. The client MUST adopt this rather than its own request: the pinned
     *  enemy wave is scaled to match, and disagreeing desyncs the replay from tick 0. */
    elite?: boolean;
    inventory?: Record<string, number>;
    /** Authoritative time at which this accepted invasion started its cooldown. */
    lastRaidAt?: number;
    serverTime?: number;
    /** Earliest server time at which a non-retreat result may be settled. */
    earliestFinishAt?: number;
    /** Server time at which this session dies. A finish posted after it is answered
     *  200 with `expired` and zero rewards, WITHOUT replaying the fight — so the
     *  client has to watch this itself: the battle runs on the ticker, which stops
     *  while the page is hidden, and the TTL does not. */
    expiresAt?: number;
  }>("POST", "/raid/start", {
    useVoucher,
    raidId,
    orderedUnitIds,
    concentration,
    dice,
    brainTicket,
    rulesetVersion: RAID_RULESET_VERSION,
  });

/** The server's authoritative raid-finish result: the cooldown clock, the resulting
 *  balance, and the amounts CREDITED this call (0 on a loss / idempotent replay).
 *
 *  NOT every field survives every branch. An EXPIRED session is answered with a body
 *  of five keys — `{expired, gold, xp, firstClear, loot}` — and nothing else, because
 *  the server zeroes it without replaying the fight or touching the ledger. The
 *  optionality below is that branch: this interface used to promise `lastRaidAt` and
 *  `balance` unconditionally, which is precisely why the settlement path adopted
 *  `undefined` into the balance and pushed NaN through the cooldown clock. */
export interface RaidFinishResult {
  /** Absent on an expired settlement, which starts no cooldown. */
  lastRaidAt?: number;
  serverTime?: number;
  /** Absent on an expired settlement, which credits nothing. */
  balance?: Balance;
  gold: number;
  /** Invasion brains credited by this verified boss win. */
  brains?: number;
  xp: number;
  firstClear: boolean;
  /** The session had already expired (not settled within its TTL) — nothing credited.
   *  The rest of this body is the zeroed shell described above. */
  expired?: boolean;
  /** The SERVER's loot roll for this win (the client no longer rolls its own online):
   *  the drop's name + what it became, plus `qty` for a bundled boost drop (Insta-Grow
   *  pays ten). Null when nothing dropped, on a loss, or on a replayed finish. */
  loot?: { name: string; kind: "gold" | "boost" | "item"; qty?: number } | null;
  /** Extremely rare roster reward, placed on the farm or protected in the Mausoleum. */
  newZombie?: { id: string; key: string; stored: boolean; received?: boolean } | null;
  outcome?: RaidOutcome;
  questChanges?: QuestChange[];
  inventory?: Record<string, number>;
  storage?: { received: Record<string, number>; stored: Record<string, number> };
  raidProgress?: Record<string, number>;
  /** Daily/weekly quest state after this settlement — an invasion win advances it, and
   *  /raid/finish is the only path a win travels. Absent on a Worker predating them. */
  periodicQuests?: PeriodicQuestProjection | null;
  rulesetVersion?: number;
  revival?: {
    sessionId: string;
    zombies: { id: string; key: string; mutation: number; invasions: number; stored: boolean }[];
    costPerZombie: 1;
  } | null;
}

/** Report a finished raid. The server deterministically replays the pinned combat,
 * starts the cooldown idempotently, and returns its authoritative outcome/reward. */
/** Settle a raid. The server REPLAYS the transcript and prices the reward from its own
 *  outcome — the client cannot claim a win or keep a zombie the replay killed. `clientWin`
 *  and `clientLosses` are the two exceptions and both are strictly CONCESSIONS: the server
 *  ANDs the win and UNIONS the deaths, so each can only ever make the result worse. When a
 *  client-only hazard ends the live fight before the optimistic server replay, an explicit
 *  loss concession also lets the server close that unfinished replay with zero rewards.
 *  This exists because hazards (the Beach crab, the Circus trapeze) are deliberately absent
 *  from server simulation, so the player's real, worse result must still settle. */
export const raidFinish = (sessionId: string, finalTick: number, inputs: RaidReplayInput[], outcome?: RaidOutcome) =>
  req<RaidFinishResult>("POST", "/raid/finish", {
    sessionId,
    finalTick,
    inputs,
    ...(outcome ? { clientWin: outcome.win, clientLosses: outcome.losses } : {}),
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

// ---- friend invasions (PvP) ---------------------------------------------

/** Open a friend invasion: the server pins the WHOLE fight config — the attacker's
 *  eight, a snapshot of the defender's deployed zombies as the enemy team, scores and
 *  reward tiers — and returns it. The client ADOPTS this config wholesale (it builds
 *  its BattleSim from these exact units), so the verified replay cannot diverge. */
export const pvpStart = (defenderId: string, orderedUnitIds: string[]) =>
  req<{
    ok: boolean;
    sessionId?: string;
    error?: string;
    config?: PvpFightConfig;
    expiresAt?: number;
    earliestFinishAt?: number;
    serverTime?: number;
    /** Present on a `pair_limit` refusal. */
    limit?: number;
  }>("POST", "/raid/pvp/start", {
    defenderId,
    orderedUnitIds,
    rulesetVersion: RAID_RULESET_VERSION,
  });

export interface PvpFinishResult {
  settlementId?: string;
  win: boolean;
  outcome?: RaidOutcome;
  /** Boost bundles credited on a win ([] on a loss OR a win past the daily cap). */
  rewards: { key: string; qty: number }[];
  /** False on a win that fell past the daily rewarded-wins cap: it counts in the
   *  stats and the history, it just doesn't pay. */
  rewarded?: boolean;
  rewardTier: number | null;
  attackScore: number;
  defenseScore: number;
  defenderName?: string;
  inventory?: Record<string, number>;
  serverTime?: number;
}

/** Settle a friend invasion. Same contract as /raid/finish — the server replays the
 *  transcript and decides; `clientWin` is a pure concession — but nothing is risked:
 *  no roster changes, no cooldown, only boost rewards on a verified win. */
export const pvpFinish = (sessionId: string, finalTick: number, inputs: RaidReplayInput[], outcome?: RaidOutcome) =>
  req<PvpFinishResult>("POST", "/raid/pvp/finish", {
    sessionId,
    finalTick,
    inputs,
    ...(outcome ? { clientWin: outcome.win } : {}),
  });

/** Give back the one-live-invasion slot after a fight ends without a verdict — a scene
 *  that failed to load, a settle the verifier refused, a tab closed mid-battle. Settles
 *  nothing (no win, no loss, no reward) and does NOT refund the attempt against that
 *  friend. Safe to call twice; safe to call after a successful finish. */
export const pvpAbandon = (sessionId: string) =>
  req<{ ok: boolean; released?: boolean }>("POST", "/raid/pvp/abandon", { sessionId });

export interface PvpHistoryEntry {
  sessionId: string;
  otherName: string;
  finishedAt: number;
  attackerWon: boolean;
  attackScore: number;
  defenseScore: number;
  /** Whether this row paid (win inside the daily cap / defense that parked a reward). */
  rewarded: boolean;
  /** Set when this row is a still-unclaimed rewarded defense of YOURS. */
  claimableTier?: number;
  /** The stored recording still exists and matches the live ruleset. */
  replayAvailable?: boolean;
}

export interface PvpStatLine {
  attackWins: number;
  attackLosses: number;
  defenseWins: number;
  defenseLosses: number;
}

export interface PvpOverview {
  ok: boolean;
  /** Newest-first, capped at the replay window (10 per role). */
  attacks: PvpHistoryEntry[];
  defenses: PvpHistoryEntry[];
  stats: { lifetime: PvpStatLine; week: PvpStatLine };
  /** The whole outstanding defense-reward backlog, however old. */
  claim: { count: number; rewards: { key: string; qty: number }[]; more?: boolean };
  rewardedWinsToday: number;
  rewardedDefensesToday: number;
  rewardedWinsPerDay: number;
  rewardedDefensesPerDay: number;
}

export const pvpHistory = () => req<PvpOverview>("GET", "/raid/pvp/history");

/** Claim a successful defense's reward (one time, defender only). */
export const pvpCollect = (sessionId: string) =>
  req<{ ok: boolean; rewards: { key: string; qty: number }[]; tier: number; inventory?: Record<string, number>; serverTime?: number }>(
    "POST", "/raid/pvp/collect", { sessionId }
  );

/** Claim every outstanding defense reward at once. `remaining: true` = call again. */
export const pvpCollectAll = () =>
  req<{ ok: boolean; error?: string; claimed: number; rewards: { key: string; qty: number }[]; remaining?: boolean; inventory?: Record<string, number>; serverTime?: number }>(
    "POST", "/raid/pvp/collect-all", {}
  );

export interface PvpDefenderPreview {
  key: string;
  name: string;
  mutation?: number;
  color?: [number, number, number];
  /** Formation mode only: the job this defender holds in the farm's defense. */
  role?: string;
}

export interface PvpDefenseView {
  score: number;
  /** The reward tier an attacker earns by beating this defense. */
  tier: number;
  defenders: PvpDefenderPreview[];
  authored: boolean;
}

/** The caller's own defense line-up + how an attacker would meet it. `mode` says which
 *  defense the deployed Worker fields — exactly one is live at a time. */
export const pvpDefenseGet = () =>
  req<{
    ok: boolean;
    mode?: string;
    unitIds: string[];
    defense: PvpDefenseView | null;
    error?: string;
  }>("GET", "/raid/pvp/defense");

/** Save (or clear, with []) the authored defense order. */
export const pvpDefenseSet = (unitIds: string[]) =>
  req<{ ok: boolean; error?: string; unitIds: string[] }>("POST", "/raid/pvp/defense", { unitIds });

/** Scout a friend's defense before attacking. */
export const pvpPreview = (defenderId: string) =>
  req<{
    ok: boolean;
    error?: string;
    defenderName?: string;
    defenseScore?: number;
    attackerTier?: number;
    defenders?: PvpDefenderPreview[];
    authored?: boolean;
    pairAttacksToday?: number;
    pairAttackLimit?: number;
  }>("POST", "/raid/pvp/preview", { defenderId });

/** Fetch one fight's stored recording for the playback viewer. */
export const pvpReplay = (sessionId: string) =>
  req<{
    ok: boolean;
    error?: string;
    config?: PvpFightConfig;
    finalTick?: number;
    inputs?: RaidReplayInput[];
    attackerWon?: boolean;
    attackerName?: string;
    role?: "attacker" | "defender";
  }>("GET", `/raid/pvp/replay/${encodeURIComponent(sessionId)}`);

export interface EpicBossFinishResult {
  serverTime?: number;
  event: import("./protocol").EpicBossProjection;
  defeatedLevel: number | null;
  escaped: boolean;
  /** Present when an XP quest reward leveled the player and reset raid cooldown. */
  lastRaidAt?: number;
  /** The FIRST decor drop, kept so a result_json written before multi-drop still reads
   *  correctly when a duplicate finish replays it. New code should read `drops`. */
  loot: { name: string; tile?: string; stageActor?: string; sprite: string } | null;
  /** Every decor drop from this clear (EPIC_LOOT_ROLLS rolls). Absent on results stored
   *  before the field existed — fall back to `loot`. */
  drops?: { name: string; tile?: string; stageActor?: string; sprite: string }[];
  /** 1 when the rung also dropped a Brain Ticket (1.5% per rung). */
  brainTicket?: number;
  /** What this clear actually paid. The brain half is an 8% ROLL the server owns, so the
   *  result panel has to print this rather than re-deriving it — a second roll on the
   *  client would disagree with the balance most of the time. Optional so a response
   *  from a Worker predating the field still parses. */
  currency?: { brains: number; gold: number };
  balance: Balance;
  inventory: Record<string, number>;
  storage: { received: Record<string, number>; stored: Record<string, number> };
  ownedPets: string[];
  survivors: string[];
  losses: string[];
  quests: import("./protocol").QuestProjection;
  questChanges: QuestChange[];
  newZombies: { id: string; key: string; stored: boolean; received?: boolean }[];
}

export const epicBossActivate = (activationId: string, bossId: string) => req<{
  event: import("./protocol").EpicBossProjection;
  balance: Balance;
  /** Present only when activating re-opened quests this boss had already finished,
   *  so a repeat run can pay its prizes again. */
  quests?: import("./protocol").QuestProjection;
  serverTime?: number;
}>("POST", "/epic-boss/activate", { activationId, bossId });

export const epicBossEnd = (runId: string) => req<{
  event: import("./protocol").EpicBossProjection;
  serverTime?: number;
}>("POST", "/epic-boss/end", { runId });

/** `rulesetVersion` is the same handshake `startRaid` sends: an epic fight is replayed by
 *  the Worker, and v28/v29 put the attempt window and the damage curve inside the rules, so
 *  a bundle that disagrees with the deployed Worker must be refused BEFORE it pays for an
 *  attempt it would then lose at verification. */
export const epicBossStart = (orderedUnitIds: string[], payment: import("../epicBoss/tokens").EpicBossPayment) => req<{
  ok: true;
  sessionId: string;
  event: import("./protocol").EpicBossProjection;
  balance: Balance;
  expiresAt: number;
  serverTime?: number;
}>("POST", "/epic-boss/start", { orderedUnitIds, payment, rulesetVersion: RAID_RULESET_VERSION });

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
    level: f.level,
    headId: f.headId,
    addedAt: 0,
    giftsSent: 0,
    friendCode: f.friendCode,
    giftOnCooldown: f.giftOnCooldown ?? false,
    giftPending: f.giftPending ?? false,
    giftsReceived: f.giftsReceived ?? 0,
    activity: f.activity,
  };
}
