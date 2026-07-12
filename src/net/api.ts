// Client for the game server (Cloudflare Worker). Owns the session token and every
// endpoint call. Everything here is OPTIONAL: if VITE_API_URL is unset, isConfigured()
// is false and callers skip the network entirely (offline-only mode).
//
// Layering: this is the low level. auth.ts (Google Sign-In) sits on top and calls
// authenticate(); SaveManager/main call the data methods. No import of auth here, so
// there's no cycle.
import type { SaveGame } from "../save/schema";
import type { Friend } from "../social/friends";

const API = import.meta.env.VITE_API_URL?.replace(/\/$/, "");
const SESSION_KEY = "zf2r.session.v1";

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
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!session) throw new ApiError(401, "no_session");
    headers["Authorization"] = `Bearer ${session.token}`;
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

export const getFriends = () => req<FriendView[]>("GET", "/friends");

/** Fetch a friend's farm as a READ-ONLY projection (server strips currency,
 *  progression, and their social block — see projectFriendSave). Powers the
 *  "visit a friend's farm" view. Throws ApiError(403, "not_friends") if the
 *  friendship no longer exists, or (404, "no_save") if they've never saved. */
export const getFriendSave = (accountId: string) =>
  req<{ save: SaveGame }>("GET", `/friends/${encodeURIComponent(accountId)}/save`);

export const addFriend = (code: string) =>
  req<{ friend: FriendView }>("POST", "/friends/add", { code });

/** Send a brain. Throws ApiError(429) if the daily limit is hit. */
export const sendGift = (toAccountId: string) =>
  req<{ ok: true }>("POST", "/gifts", { toAccountId });

export const getInbox = () => req<InboxGift[]>("GET", "/gifts/inbox");

/** Claim a gift; returns the freshly-credited save + rev. */
export const claimGift = (giftId: string) =>
  req<{ save: SaveGame | null; rev: number; alreadyClaimed?: boolean }>(
    "POST",
    "/gifts/claim",
    { giftId }
  );

// A server friend rendered into the client's Friend shape (for the HUD cache).
export function toFriend(f: FriendView): Friend {
  return { id: f.accountId, name: f.name, addedAt: 0, giftsSent: 0, friendCode: f.friendCode };
}
