// Zombie Farm API — Cloudflare Worker (Hono + D1).
//
// Identity: Google Sign-In verified once (auth.ts), then our own revocable session
// (a sessions row + a signed access-token JWT carrying its id).
// Ground truth: the save blob (rev-guarded via an atomic compare-and-swap), the
// friend graph (consent-based: requests -> accept), and the once/day gift limit
// (a UNIQUE index, not a read-then-insert). The blob is opaque to the server
// except player.brains, which a gift claim credits through an idempotent grant.
//
// Hardening added in the Track-A security pass (see SECURITY.md):
//   • runtime save validation + size limit at PUT /save (validate.ts);
//   • per-account / per-IP rate limiting on sensitive routes;
//   • consent friendships with accept / remove / block, non-oracle add, long codes;
//   • atomic gift send + idempotent, grant-backed claim;
//   • server-revocable sessions with logout / logout-all.
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { Bindings, Vars, SaveGame, RateLimiter } from "./env";
import {
  verifyGoogleIdToken,
  mintSession,
  verifySession,
  type GoogleIdentity,
} from "./auth";
import * as db from "./db";
import {
  dayBucket,
  deviceLabel,
  normalizeFriendCode,
  normalizeUsername,
  projectFriendSave,
} from "./logic";
import { validateSave, MAX_SAVE_BYTES } from "./validate";
import type { EconomyEvent } from "./economy";
import type { FarmAction } from "./farm";
import { raidEcon } from "./raidCatalog";
import type { InventoryAction } from "./inventory";
import type { RosterAction } from "./roster";

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

// ---- abuse caps ---------------------------------------------------------
const MAX_FRIENDS = 1000; // graph size cap per account
const MAX_PENDING_REQUESTS = 200; // incoming requests we'll hold for a recipient
const MAX_INBOX = 200; // unclaimed gifts we'll hold / return

/** Severity for a security log line, so an alerting rule can filter cheaply on the
 *  `lvl` field. info = routine/operational; warn = a rejected/abnormal request worth
 *  a rate/threshold alert; alert = a strong signal that should page a human. Which
 *  event is which — and the alert thresholds — are documented in docs/RUNBOOK.md. */
type SecLvl = "info" | "warn" | "alert";

/** One structured security-relevant log line (Cloudflare captures stdout). Kept
 *  free of PII — ids only — so logs are safe to retain and alert on. The stable
 *  shape is `{ sec: <event>, lvl: <severity>, ... }`; alerts key off sec + lvl. */
function slog(event: string, detail: Record<string, unknown> = {}, lvl: SecLvl = "warn"): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ sec: event, lvl, ...detail }));
}

// ---- CORS ---------------------------------------------------------------
// Bearer-token auth (no cookies), so a simple origin allowlist is enough. NOTE:
// CORS is a browser-origin policy, NOT an anti-cheat or anti-bot control — a custom
// client can still call with a valid token, which is why the real controls are
// validation + rate limits + server ownership.
app.use("*", (c, next) =>
  cors({
    origin: [c.env.ALLOWED_ORIGIN, "http://localhost:5173", "http://localhost:4173"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  })(c, next)
);

app.get("/", (c) => c.json({ ok: true, service: "zombiefarm" }));

// Hard body ceiling on EVERY route, applied before any handler parses. Just above
// the 512 KiB save cap so saves pass (PUT /save then applies the precise limit);
// everything else has tiny bodies. Blocks multi-MB payloads as a cheap DoS guard.
app.use("*", bodyLimit({ maxSize: 550 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));

// ---- rate limiting ------------------------------------------------------
type RLTier = "RL_AUTH" | "RL_WRITE" | "RL_READ";

/** Rate-limit middleware. Prefers the Cloudflare Rate Limiting binding for the
 *  given tier (no D1 write — cheapest on the free tier); falls back to a D1
 *  fixed-window counter when the binding isn't configured (local dev / offline).
 *  Keys by the authenticated account when available, else the caller IP — so place
 *  AFTER requireAuth on protected routes, or standalone (pre-auth, IP-keyed) on
 *  /auth. `fallbackMax`/`windowMs` only shape the D1 fallback; the binding's own
 *  limit/period come from wrangler.toml.
 *
 *  NOTE: rate limiting is a throttle, never a correctness control — security
 *  invariants (gift uniqueness, grants, save CAS) stay enforced by D1 constraints. */
function rateLimit(
  tier: RLTier,
  name: string,
  fallbackMax: number,
  windowMs: number
): MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> {
  return async (c, next) => {
    const who = c.get("accountId") || `ip:${c.req.header("cf-connecting-ip") ?? "?"}`;
    const key = `${name}:${who}`;
    // Per-tier limit override (e.g. RL_AUTH_MAX), set ONLY in .dev.vars for local/test.
    // When present it FORCES the D1-counter path with that cap, bypassing the CF binding
    // — `wrangler dev` simulates the binding at the wrangler.toml limit, so overriding
    // only the fallback wouldn't take effect. This lets the integration suite's many
    // isolated sign-ins from one IP run un-throttled. Prod never sets these vars, so prod
    // always uses the binding below and the real limits are untouched.
    const override = c.env[`${tier}_MAX` as keyof typeof c.env] as string | undefined;
    const binding = override ? undefined : (c.env[tier] as RateLimiter | undefined);
    let ok: boolean;
    if (binding) {
      ok = (await binding.limit({ key })).success;
    } else {
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const max = override ? Number(override) : fallbackMax;
      ok = (await db.bumpRateLimit(c.env.DB, key, windowStart)) <= max;
    }
    if (!ok) {
      slog("rate_limited", { route: name, who });
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  };
}

// ---- POST /auth: Google (or dev) sign-in -> our session token -----------
// 60/min/IP (kept in step with the RL_AUTH binding in wrangler.toml, which governs
// in prod — this number only shapes the D1 fallback used in local/degraded mode).
// Tolerates a shared NAT/CGNAT egress; Google-token verification is the real gate;
// dev sign-in is off in prod (DEV_AUTH unset).
app.post("/auth", rateLimit("RL_AUTH", "auth", 60, 60_000), async (c) => {
  const body = await c.req.json<{
    idToken?: string;
    devSub?: string;
    devName?: string;
  }>().catch(() => ({}) as Record<string, never>);

  let who: GoogleIdentity;
  if (body.idToken) {
    try {
      who = await verifyGoogleIdToken(body.idToken, c.env.GOOGLE_CLIENT_ID);
    } catch {
      slog("auth_token_invalid", {}); // rejected Google ID token — warn (rate-alert)
      return c.json({ error: "invalid_google_token" }, 401);
    }
  } else if (c.env.DEV_AUTH === "1" && body.devSub) {
    // Local/dev only: skip Google so the flow can be automated end-to-end. The
    // server is the gate — a prod Worker has DEV_AUTH unset, so this is unreachable
    // regardless of what any client sends.
    who = { sub: `dev:${body.devSub}` };
  } else if (body.devSub) {
    // A devSub sent to a non-dev server = someone probing the dev bypass. High signal.
    slog("dev_auth_rejected", {}, "alert");
    return c.json({ error: "missing_id_token" }, 400);
  } else {
    return c.json({ error: "missing_id_token" }, 400);
  }

  const now = Date.now();
  const acct = await db.upsertAccount(c.env.DB, who, now);
  const label = deviceLabel(c.req.header("User-Agent"));
  const sessionId = await db.createSession(c.env.DB, acct.id, now, label);
  const token = await mintSession(acct.id, sessionId, c.env.SESSION_SECRET);
  return c.json({
    token,
    accountId: acct.id,
    // `username` is null until the player picks one (client shows the picker then).
    // No name/email is ever returned — the system stores no personal data.
    username: acct.username,
    friendCode: acct.friend_code,
  });
});

// ---- Auth middleware for everything below -------------------------------
// Verifies the JWT signature/expiry AND that the session is still live (not
// revoked) — the second check is what makes sign-out / logout-all effective before
// the token would naturally expire.
const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (
  c,
  next
) => {
  const hdr = c.req.header("Authorization") ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const claims = token ? await verifySession(token, c.env.SESSION_SECRET) : null;
  if (!claims) {
    slog("auth_denied", { stage: "token" }, "info"); // bad/expired/absent JWT — routine
    return c.json({ error: "unauthorized" }, 401);
  }
  const accountId = await db.sessionAccount(c.env.DB, claims.sessionId, Date.now());
  if (!accountId || accountId !== claims.accountId) {
    // A validly-signed token whose session is gone: revoked, idle-expired, or a
    // mismatch. A spike here can mean a leaked-token replay after a revoke.
    slog("auth_denied", { stage: "session" }, "info");
    return c.json({ error: "unauthorized" }, 401); // revoked / unknown session
  }
  c.set("accountId", accountId);
  c.set("sessionId", claims.sessionId);
  await next();
};

app.use("/me", requireAuth);
app.use("/username", requireAuth);
app.use("/save", requireAuth);
app.use("/session/*", requireAuth);
app.use("/logout", requireAuth);
app.use("/friends", requireAuth);
app.use("/friends/*", requireAuth);
app.use("/gifts", requireAuth);
app.use("/gifts/*", requireAuth);
app.use("/raid/*", requireAuth);
app.use("/economy/*", requireAuth);
app.use("/farm/*", requireAuth);
app.use("/inventory/*", requireAuth);
app.use("/roster/*", requireAuth);
app.use("/shop/*", requireAuth);

// Per-account rate limits (run after requireAuth so they key on the account).
// Writes → RL_WRITE tier; reads/polling → RL_READ tier (looser). Coverage now
// includes authenticated READS and refresh, not just writes, so a valid bot can't
// exhaust the free tier through "harmless" polling. Security invariants remain on
// D1 constraints regardless of the throttle.
app.use("/save", rateLimit("RL_WRITE", "save", 120, 60_000)); // GET + PUT
app.use("/username", rateLimit("RL_WRITE", "username", 10, 60_000));
app.use("/friends/add", rateLimit("RL_WRITE", "friend_add", 20, 60_000));
app.use("/friends/accept", rateLimit("RL_WRITE", "friend_accept", 60, 60_000));
app.use("/friends/reject", rateLimit("RL_WRITE", "friend_reject", 60, 60_000));
app.use("/friends/remove", rateLimit("RL_WRITE", "friend_remove", 60, 60_000));
app.use("/friends/block", rateLimit("RL_WRITE", "friend_block", 60, 60_000));
app.use("/friends/code/rotate", rateLimit("RL_WRITE", "code_rotate", 5, 60_000));
app.use("/gifts", rateLimit("RL_WRITE", "gift_send", 60, 60_000));
app.use("/gifts/claim", rateLimit("RL_WRITE", "gift_claim", 120, 60_000));
app.use("/raid/start", rateLimit("RL_WRITE", "raid_start", 60, 60_000));
app.use("/raid/finish", rateLimit("RL_WRITE", "raid_finish", 60, 60_000));
app.use("/raid/state", rateLimit("RL_READ", "raid_state", 300, 60_000));
app.use("/economy/apply", rateLimit("RL_WRITE", "economy_apply", 120, 60_000));
app.use("/economy/sync", rateLimit("RL_READ", "economy_sync", 300, 60_000));
app.use("/farm/actions", rateLimit("RL_WRITE", "farm_actions", 120, 60_000));
app.use("/inventory/actions", rateLimit("RL_WRITE", "inventory_actions", 120, 60_000));
app.use("/inventory/sync", rateLimit("RL_READ", "inventory_sync", 300, 60_000));
app.use("/roster/actions", rateLimit("RL_WRITE", "roster_actions", 120, 60_000));
app.use("/roster/sync", rateLimit("RL_READ", "roster_sync", 300, 60_000));
app.use("/shop/size", rateLimit("RL_WRITE", "shop_size", 30, 60_000));
app.use("/shop/climate", rateLimit("RL_WRITE", "shop_climate", 30, 60_000));
app.use("/shop/state", rateLimit("RL_READ", "shop_state", 300, 60_000));
app.use("/logout", rateLimit("RL_WRITE", "logout", 30, 60_000));
app.use("/session/logout-all", rateLimit("RL_WRITE", "logout_all", 10, 60_000));
app.use("/session/revoke", rateLimit("RL_WRITE", "session_revoke", 30, 60_000));
app.use("/session/list", rateLimit("RL_READ", "session_list", 120, 60_000));
// Reads + refresh (RL_READ): /me, GET /save shares the /save write limiter above,
// friend lists, a friend's farm, requests, inbox, token refresh.
app.use("/me", rateLimit("RL_READ", "me", 300, 60_000));
app.use("/friends", rateLimit("RL_READ", "friends_list", 300, 60_000));
app.use("/friends/requests", rateLimit("RL_READ", "friends_reqs", 300, 60_000));
app.use("/friends/:id/save", rateLimit("RL_READ", "friend_farm", 120, 60_000));
app.use("/gifts/inbox", rateLimit("RL_READ", "inbox", 300, 60_000));
app.use("/session/refresh", rateLimit("RL_READ", "refresh", 60, 60_000));

// ---- GET /me ------------------------------------------------------------
app.get("/me", async (c) => {
  const acct = await db.accountById(c.env.DB, c.get("accountId"));
  if (!acct) return c.json({ error: "not_found" }, 404);
  return c.json({
    accountId: acct.id,
    username: acct.username,
    name: acct.username ?? "Player", // effective display name (never from Google)
    friendCode: acct.friend_code,
  });
});

// ---- POST /username: set the player-chosen display name -----------------
app.post("/username", async (c) => {
  const { username } = await c.req
    .json<{ username: string }>()
    .catch(() => ({ username: "" }));
  const name = normalizeUsername(username ?? "");
  if (!name) return c.json({ error: "bad_username" }, 400);
  await db.setUsername(c.env.DB, c.get("accountId"), name);
  return c.json({ username: name });
});

// ---- session management -------------------------------------------------
// Renew a live session's access token (rotates expiry without a fresh Google
// round-trip). The session row is unchanged, so revocation still applies.
app.post("/session/refresh", async (c) => {
  const token = await mintSession(c.get("accountId"), c.get("sessionId"), c.env.SESSION_SECRET);
  return c.json({ token });
});

// Sign out this device (revoke just this session).
app.post("/logout", async (c) => {
  await db.revokeSession(c.env.DB, c.get("sessionId"), Date.now());
  return c.json({ ok: true });
});

// Sign out everywhere (revoke every session for the account) — emergency control.
app.post("/session/logout-all", async (c) => {
  await db.revokeAllSessions(c.env.DB, c.get("accountId"), Date.now());
  slog("logout_all", { account: c.get("accountId") }, "info");
  return c.json({ ok: true });
});

// List this account's live devices/sessions for the Account menu. Marks which row
// is the CURRENT session so the UI can label it and refuse to self-revoke.
app.get("/session/list", async (c) => {
  const sessions = await db.listSessions(c.env.DB, c.get("accountId"), Date.now());
  const current = c.get("sessionId");
  return c.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
      label: s.label,
      current: s.id === current,
    })),
  });
});

// Revoke ONE other device by id. Account-scoped in the query (can't revoke a session
// you don't own → 404), and refuses the current session (use /logout for that, so the
// client can also clear its local token). 404 on unknown/foreign/already-revoked.
app.post("/session/revoke", async (c) => {
  const { sessionId } = await c.req
    .json<{ sessionId: string }>()
    .catch(() => ({ sessionId: "" }));
  if (typeof sessionId !== "string" || !sessionId) return c.json({ error: "bad_session" }, 400);
  if (sessionId === c.get("sessionId")) return c.json({ error: "is_current" }, 400);
  const ok = await db.revokeSessionForAccount(c.env.DB, sessionId, c.get("accountId"), Date.now());
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ---- GET /save ----------------------------------------------------------
app.get("/save", async (c) => {
  const accountId = c.get("accountId");
  const row = await db.getSave(c.env.DB, accountId);
  const save = row ? (JSON.parse(row.blob) as SaveGame) : null;
  // Credit any owed-but-deferred gift brains (crash-window recovery) into the
  // server balance. `seed` lazily creates the balance row from the save's currency
  // if it doesn't exist yet. No-op / one cheap indexed read when nothing is pending.
  const seed = {
    gold: save?.player?.gold ?? 0,
    brains: save?.player?.brains ?? 0,
    xp: save?.player?.xp ?? 0,
  };
  const applied = await db.reconcilePendingGrants(c.env.DB, accountId, Date.now(), seed);
  if (applied) slog("grants_reconciled", { account: accountId, applied }, "info");
  if (!save) return c.json({ save: null, rev: 0 });
  return c.json({ save, rev: row!.rev });
});

// ---- PUT /save: validated, atomic optimistic-concurrency write ----------
app.put("/save", async (c) => {
  // Size guard first — reject an oversized body before parsing/validating it.
  const raw = await c.req.text();
  if (raw.length > MAX_SAVE_BYTES) {
    slog("save_too_large", { account: c.get("accountId"), bytes: raw.length });
    return c.json({ error: "save_too_large" }, 413);
  }
  let parsed: { save: unknown; baseRev: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const { save, baseRev } = parsed;
  if (save == null || typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 0) {
    return c.json({ error: "bad_request" }, 400);
  }
  // Structural + bounds validation. A malformed/oversized/insane save is rejected
  // here, which also protects visitors (they only ever render a *stored* save).
  const v = validateSave(save);
  if (!v.ok) {
    slog("save_invalid", { account: c.get("accountId"), reason: v.error });
    return c.json({ error: "invalid_save", reason: v.error }, 422);
  }

  const accountId = c.get("accountId");
  const now = Date.now();
  const newRev = await db.casWriteSave(c.env.DB, accountId, JSON.stringify(save), baseRev, now);
  if (newRev === null) {
    // Rev mismatch (another device wrote in between): hand back the server copy.
    const cur = await db.getSave(c.env.DB, accountId);
    slog("save_conflict", { account: accountId }, "info"); // normal optimistic-concurrency loser
    return c.json(
      { error: "conflict", rev: cur?.rev ?? 0, save: cur ? JSON.parse(cur.blob) : null },
      409
    );
  }
  return c.json({ rev: newRev });
});

// ---- GET /friends -------------------------------------------------------
app.get("/friends", async (c) => {
  const friends = await db.listFriends(c.env.DB, c.get("accountId"));
  return c.json(
    friends.map((f) => ({
      accountId: f.id,
      name: f.username ?? "Player", // chosen display name only (no PII)
      friendCode: f.friend_code,
    }))
  );
});

// ---- GET /friends/requests: pending incoming friend requests ------------
app.get("/friends/requests", async (c) => {
  const reqs = await db.incomingRequests(c.env.DB, c.get("accountId"), MAX_PENDING_REQUESTS);
  return c.json(reqs);
});

// ---- GET /friends/:id/save: read-only peek at a friend's farm -----------
// Powers "visit a friend's farm". Only a confirmed friend may read, and only a
// stripped projection is returned (projectFriendSave). The stored save was
// bounds-validated on write, so the projection can't carry an allocation bomb; the
// visitor client re-checks dimensions before hydrating as defense in depth.
app.get("/friends/:id/save", async (c) => {
  const me = c.get("accountId");
  const target = c.req.param("id");
  if (!target || target === me) return c.json({ error: "bad_request" }, 400);
  if (!(await db.areFriends(c.env.DB, me, target))) {
    return c.json({ error: "not_friends" }, 403);
  }
  const row = await db.getSave(c.env.DB, target);
  if (!row) return c.json({ error: "no_save" }, 404);
  const save = projectFriendSave(JSON.parse(row.blob) as SaveGame);
  return c.json({ save });
});

// ---- POST /friends/add: REQUEST a friendship by code --------------------
// Consent-based: this files a pending request; the recipient must accept before any
// edge exists. Deliberately a NON-ORACLE — it returns the same generic { ok: true }
// whether or not the code maps to an account (and for blocked/self/duplicate),
// so it can't be used to enumerate accounts or confirm a code. Combined with the
// long codes and rate limiting, discovery-by-code is no longer practical.
app.post("/friends/add", async (c) => {
  const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));
  const norm = normalizeFriendCode(code ?? "");
  const me = c.get("accountId");
  const generic = c.json({ ok: true });
  if (!norm) return generic;
  const other = await db.accountByFriendCode(c.env.DB, norm);
  if (!other || other.id === me) return generic;
  if (await db.blockedEitherWay(c.env.DB, me, other.id)) return generic;
  if (await db.areFriends(c.env.DB, me, other.id)) return generic;
  // If they already asked me, accept immediately (mutual intent). Otherwise cap
  // their pending inbox and file the request.
  if (await db.requestExists(c.env.DB, other.id, me)) {
    await db.acceptRequest(c.env.DB, me, other.id, Date.now());
    return generic;
  }
  const pending = await db.countIncomingRequests(c.env.DB, other.id);
  if (pending >= MAX_PENDING_REQUESTS) return generic; // silently drop; don't leak
  await db.createFriendRequest(c.env.DB, me, other.id, Date.now());
  return generic;
});

// ---- POST /friends/accept: accept a pending request ---------------------
app.post("/friends/accept", async (c) => {
  const { fromAccountId } = await c.req
    .json<{ fromAccountId: string }>()
    .catch(() => ({ fromAccountId: "" }));
  const me = c.get("accountId");
  if (!fromAccountId || fromAccountId === me) return c.json({ error: "bad_request" }, 400);
  if ((await db.countFriends(c.env.DB, me)) >= MAX_FRIENDS) {
    return c.json({ error: "friends_full" }, 409);
  }
  const ok = await db.acceptRequest(c.env.DB, me, fromAccountId, Date.now());
  if (!ok) return c.json({ error: "no_request" }, 404);
  const other = await db.accountById(c.env.DB, fromAccountId);
  return c.json({
    friend: other
      ? { accountId: other.id, name: other.username ?? "Player", friendCode: other.friend_code }
      : null,
  });
});

// ---- POST /friends/reject: decline / withdraw a pending request ---------
app.post("/friends/reject", async (c) => {
  const { accountId } = await c.req.json<{ accountId: string }>().catch(() => ({ accountId: "" }));
  const me = c.get("accountId");
  if (!accountId) return c.json({ error: "bad_request" }, 400);
  await db.deleteRequest(c.env.DB, me, accountId);
  return c.json({ ok: true });
});

// ---- POST /friends/remove: unfriend -------------------------------------
app.post("/friends/remove", async (c) => {
  const { accountId } = await c.req.json<{ accountId: string }>().catch(() => ({ accountId: "" }));
  const me = c.get("accountId");
  if (!accountId) return c.json({ error: "bad_request" }, 400);
  await db.removeFriendship(c.env.DB, me, accountId);
  return c.json({ ok: true });
});

// ---- POST /friends/block: block an account ------------------------------
app.post("/friends/block", async (c) => {
  const { accountId } = await c.req.json<{ accountId: string }>().catch(() => ({ accountId: "" }));
  const me = c.get("accountId");
  if (!accountId || accountId === me) return c.json({ error: "bad_request" }, 400);
  await db.addBlock(c.env.DB, me, accountId, Date.now());
  return c.json({ ok: true });
});

// ---- POST /friends/code/rotate: get a fresh friend code -----------------
app.post("/friends/code/rotate", async (c) => {
  const code = await db.rotateFriendCode(c.env.DB, c.get("accountId"));
  return c.json({ friendCode: code });
});

// ---- POST /gifts: send a brain (once/day per recipient, atomically) -----
app.post("/gifts", async (c) => {
  const { toAccountId } = await c.req
    .json<{ toAccountId: string }>()
    .catch(() => ({ toAccountId: "" }));
  const me = c.get("accountId");
  if (!toAccountId || toAccountId === me) return c.json({ error: "bad_request" }, 400);
  if (!(await db.areFriends(c.env.DB, me, toAccountId))) {
    return c.json({ error: "not_friends" }, 403);
  }
  if (await db.blockedEitherWay(c.env.DB, me, toAccountId)) {
    return c.json({ error: "not_friends" }, 403);
  }
  if ((await db.countUnclaimedTo(c.env.DB, toAccountId)) >= MAX_INBOX) {
    return c.json({ error: "recipient_inbox_full" }, 409);
  }
  const now = Date.now();
  const sent = await db.insertGiftOnce(c.env.DB, me, toAccountId, dayBucket(now), now);
  if (!sent) return c.json({ error: "already_gifted_today" }, 429);
  return c.json({ ok: true });
});

// ---- GET /gifts/inbox ---------------------------------------------------
app.get("/gifts/inbox", async (c) => {
  const gifts = await db.inbox(c.env.DB, c.get("accountId"), MAX_INBOX);
  return c.json(gifts);
});

// ---- POST /gifts/claim: credit one brain into my save (idempotent) ------
// The grant (UNIQUE on source_gift_id) is the serialization point: exactly one
// caller inserts it and is responsible for the +1 credit, so concurrent or retried
// claims can never double-credit. settleGrant applies the +1 via a rev CAS.
//
// `credited` tells the client whether the +1 is reflected server-side RIGHT NOW.
// It optimistically mirrors the brain in memory ONLY when credited === true. If the
// apply was deferred by save churn (credited === false, alreadyClaimed === false),
// the grant stays pending and the GET /save reconciler lands it on the next load —
// the client must NOT also add it, or the two paths would double-credit.
app.post("/gifts/claim", async (c) => {
  const { giftId } = await c.req.json<{ giftId: string }>().catch(() => ({ giftId: "" }));
  const me = c.get("accountId");
  const now = Date.now();

  const gift = await db.claimableGift(c.env.DB, giftId, me);
  const respond = async (alreadyClaimed: boolean, credited: boolean) => {
    const cur = await db.getSave(c.env.DB, me);
    return c.json({
      save: cur ? (JSON.parse(cur.blob) as SaveGame) : null,
      rev: cur?.rev ?? 0,
      alreadyClaimed,
      credited,
    });
  };
  if (!gift) return respond(true, false); // already claimed / not mine / unknown

  const cur = await db.getSave(c.env.DB, me);
  if (!cur) {
    // No save to credit into yet (brand-new account). Ask the client to save first;
    // leave the gift unclaimed so no brain is lost.
    return c.json({ error: "save_first" }, 409);
  }
  const p = (JSON.parse(cur.blob) as SaveGame).player;
  const seed = { gold: p?.gold ?? 0, brains: p?.brains ?? 0, xp: p?.xp ?? 0 };

  // Record the grant (idempotent on gift id). If we didn't win it, someone already
  // credited this gift.
  const grantId = crypto.randomUUID();
  const won = await db.insertGrantIfAbsent(c.env.DB, grantId, me, "brain", 1, gift.id, now);
  if (!won) return respond(true, false);
  await db.markGiftClaimed(c.env.DB, gift.id, now);

  // Credit the brain into the server BALANCE (atomic increment — no save churn). The
  // client picks it up on its next economy sync; `credited` is just for the toast.
  const settled = await db.settleGrant(c.env.DB, grantId, 1, me, now, seed);
  if (!settled) slog("gift_credit_deferred", { account: me, gift: gift.id });
  return respond(false, settled);
});

// ---- raids: server-owned cooldown + one-use sessions --------------------
// The between-raids cooldown is decided HERE, not by the client-authored save, so
// editing the save can't reset it. Rewards/wins are still client-adjudicated (real
// server authority needs deterministic replay — a later phase); the session opened
// here is the seam that replay will hang on.
const RAID_COOLDOWN_DEFAULT_MS = 2 * 60 * 60 * 1000; // 2h
const RAID_SESSION_TTL_MS = 30 * 60 * 1000; // a raid must finish within 30 min
function raidCooldownMs(env: Bindings): number {
  const n = Number(env.RAID_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : RAID_COOLDOWN_DEFAULT_MS;
}

// GET /raid/state — the client syncs its cooldown display from this authoritative
// clock (on load and after a raid).
app.get("/raid/state", async (c) => {
  const lastRaidAt = await db.raidLastAt(c.env.DB, c.get("accountId"));
  const cooldownMs = raidCooldownMs(c.env);
  const remaining = Math.max(0, cooldownMs - (Date.now() - lastRaidAt));
  return c.json({ lastRaidAt, cooldownMs, cooldownRemaining: remaining });
});

// POST /raid/start — gate on the server cooldown, then open a one-use session that
// PINS the raid being fought (raidId), so /raid/finish can price the reward from the
// server catalog. `bypass` (a voucher use) is trusted for now because voucher
// inventory still lives in the client save; it becomes server-validated when
// inventory moves server-side. `bypassed` tells the client whether a cooldown was
// actually skipped (so it should consume the voucher).
app.post("/raid/start", async (c) => {
  const { bypass, raidId } = await c.req
    .json<{ bypass?: boolean; raidId?: number }>()
    .catch(() => ({ bypass: false, raidId: undefined }));
  // Pin a KNOWN raid so finish can price it; reject an unknown id up front.
  if (typeof raidId !== "number" || !raidEcon(raidId)) {
    return c.json({ ok: false, error: "bad_raid" }, 400);
  }
  const me = c.get("accountId");
  const now = Date.now();
  const cooldownMs = raidCooldownMs(c.env);
  const lastRaidAt = await db.raidLastAt(c.env.DB, me);
  const remaining = Math.max(0, cooldownMs - (now - lastRaidAt));
  const onCooldown = remaining > 0;
  // On cooldown: only a voucher gets through, and it's consumed SERVER-SIDE (the count
  // is server-owned now), so a modified client can't bypass for free. No voucher held
  // → treated as still on cooldown.
  let bypassed = false;
  if (onCooldown) {
    if (!bypass) return c.json({ ok: false, cooldownRemaining: remaining });
    const consumed = await db.consumeVoucher(c.env.DB, me);
    if (!consumed) return c.json({ ok: false, cooldownRemaining: remaining, error: "no_voucher" });
    bypassed = true;
  }
  const sessionId = crypto.randomUUID();
  await db.openRaidSession(c.env.DB, sessionId, me, raidId, now, now + RAID_SESSION_TTL_MS);
  return c.json({ ok: true, sessionId, bypassed });
});

// POST /raid/finish — consume the session once, start the cooldown, and credit the
// SERVER-COMPUTED reward for the session's pinned raid (base win gold + first-clear
// XP). Idempotent: a retry credits nothing and echoes the current balance/cooldown.
// `win`/`survivalFrac` are client-asserted (deferred: input replay), but the server
// owns the reward number, so a fabricated win can't exceed that raid's real payout.
app.post("/raid/finish", async (c) => {
  const { sessionId, win, survivalFrac } = await c.req
    .json<{ sessionId: string; win?: boolean; survivalFrac?: number }>()
    .catch(() => ({ sessionId: "", win: false, survivalFrac: 0 }));
  const me = c.get("accountId");
  if (!sessionId) return c.json({ error: "bad_request" }, 400);
  const r = await db.settleRaid(
    c.env.DB,
    sessionId,
    me,
    !!win,
    typeof survivalFrac === "number" ? survivalFrac : 0,
    Date.now()
  );
  return c.json({
    lastRaidAt: r.lastRaidAt,
    balance: r.balance,
    gold: r.gold,
    xp: r.xp,
    firstClear: r.firstClear,
  });
});

// ---- economy: server-authoritative balances (gold/brains/xp) ------------
// The server owns the balance via an idempotent ledger. GET seeds it once from the
// player's save so migration keeps their progress; thereafter the balance is
// authoritative and the client reconciles to it. Earn amounts are still
// client-computed but bounded (economy.ts) — exact per-action economics need the
// server to own farm/roster state (a later layer).
// POST /economy/sync — read the authoritative balance, seeding it (once) from the
// client's current currency if no balance row exists yet. The client always sends
// its local gold/brains/xp; the server uses them ONLY on first seed (clampSeed
// bounds abuse) and ignores them afterward, so this doubles as a plain refresh.
// Seeding from the client (not the save) correctly handles a brand-new account
// whose starting currency isn't on the server yet.
app.post("/economy/sync", async (c) => {
  const body = await c.req
    .json<{ seed?: { gold?: number; brains?: number; xp?: number } }>()
    .catch(() => ({ seed: undefined }));
  const s = body.seed ?? {};
  const seed = { gold: s.gold ?? 0, brains: s.brains ?? 0, xp: s.xp ?? 0 };
  const balance = await db.getOrSeedBalance(c.env.DB, c.get("accountId"), seed);
  return c.json(balance);
});

app.post("/economy/apply", async (c) => {
  const body = await c.req
    .json<{ events?: unknown }>()
    .catch(() => ({ events: [] }));
  const raw = Array.isArray(body.events) ? body.events : [];
  if (raw.length > 256) return c.json({ error: "too_many_events" }, 413);
  // Coerce to the event shape; economy.validateEvent rejects anything malformed.
  const events = raw as EconomyEvent[];
  const { balance, results } = await db.applyEvents(c.env.DB, c.get("accountId"), events);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("economy_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, results });
});

// ---- farm: exact per-action economics -----------------------------------
// Plant/harvest with SERVER-computed economics and server-time grow gating. Unlike
// /economy/apply (which bounds-validates a client-claimed delta), the server here
// computes the seed cost, harvest value, and xp from its own catalog + crop plot
// records — so crop gold can't be fabricated and crops can't be fast-harvested by
// editing the client clock. Returns the new balance so the client reconciles.
app.post("/farm/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 256) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as FarmAction[];
  const { balance, results } = await db.applyFarmActions(c.env.DB, c.get("accountId"), actions, Date.now());
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("farm_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, results });
});

// ---- inventory: server-owned consumable boosts --------------------------
// Boost COUNTS are server-authoritative. Seed once from the save, then buy/use/grant
// go through the server: a buy debits the EXACT catalog price + grants, so a client
// can't underpay or fabricate a boost in the blob. Returns the full boost inventory so
// the client reconciles (the blob's boost list becomes an ignored cache).
app.post("/inventory/sync", async (c) => {
  const body = await c.req
    .json<{ counts?: Record<string, unknown> }>()
    .catch(() => ({ counts: {} }));
  const counts: Record<string, unknown> =
    body.counts && typeof body.counts === "object" ? (body.counts as Record<string, unknown>) : {};
  const inventory = await db.seedInventory(c.env.DB, c.get("accountId"), counts);
  return c.json({ inventory });
});

app.post("/inventory/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 256) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as InventoryAction[];
  const { balance, inventory, results } = await db.applyInventoryActions(
    c.env.DB,
    c.get("accountId"),
    actions,
    Date.now()
  );
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("inventory_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, inventory, results });
});

// ---- shop: server-owned farm size + climate skins -----------------------
// Non-boost purchases the server now owns. Size upgrades are sequential (only the
// immediate next tier is buyable) and priced exactly; climate skins are an owned set.
// Both seed once from the save, then the server is authoritative (an edited save can't
// fabricate a bigger farm or free skins). NOT covered: placeable objects (their
// ownership is farm-layout placement — client-authored; see shopCatalog.ts).
app.post("/shop/state", async (c) => {
  const body = await c.req
    .json<{ size?: number; climates?: unknown }>()
    .catch(() => ({ size: undefined, climates: undefined }));
  const state = await db.getOrSeedShopState(
    c.env.DB,
    c.get("accountId"),
    typeof body.size === "number" ? body.size : 30,
    body.climates
  );
  return c.json(state);
});

app.post("/shop/size", async (c) => {
  const body = await c.req.json<{ size?: number; currency?: string }>().catch(() => ({ size: undefined, currency: "gold" }));
  const currency = body.currency === "brains" ? "brains" : "gold";
  if (typeof body.size !== "number") return c.json({ error: "bad_size" }, 400);
  const r = await db.buySize(c.env.DB, c.get("accountId"), body.size, currency, Date.now());
  if (!r.ok) slog("shop_rejected", { account: c.get("accountId"), kind: "size", error: r.error });
  return c.json(r);
});

app.post("/shop/climate", async (c) => {
  const body = await c.req.json<{ terrain?: string }>().catch(() => ({ terrain: "" }));
  if (typeof body.terrain !== "string" || !body.terrain) return c.json({ error: "bad_climate" }, 400);
  const r = await db.buyClimate(c.env.DB, c.get("accountId"), body.terrain, Date.now());
  if (!r.ok) slog("shop_rejected", { account: c.get("accountId"), kind: "climate", error: r.error });
  return c.json(r);
});

// ---- roster: server-owned zombie units ----------------------------------
// The server keeps a validation + money shadow of the player's units. A SELL is
// priced + credited here (so a fabricated unit can't be sold for gold); grants (crop
// harvest, gift redeem, combine result), veterancy, and casualties keep it accurate.
// The roster isn't mirrored back to overwrite the client's units (it drives money +
// future raid-roster validation), so combine result computation stays client-side for
// now, bounded to a real catalog key.
app.post("/roster/sync", async (c) => {
  const body = await c.req.json<{ units?: unknown }>().catch(() => ({ units: [] }));
  const count = await db.seedRoster(c.env.DB, c.get("accountId"), body.units);
  return c.json({ count });
});

app.post("/roster/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 256) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as RosterAction[];
  const { balance, results } = await db.applyRosterActions(c.env.DB, c.get("accountId"), actions, Date.now());
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("roster_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, results });
});

// ---- scheduled cleanup (cron; see wrangler.toml [triggers]) -------------
const DAY = 24 * 60 * 60 * 1000;
async function runCleanup(env: Bindings, now: number): Promise<void> {
  const sessions = await db.purgeDeadSessions(env.DB, now - DAY, now - 8 * DAY);
  const buckets = await db.purgeOldRateBuckets(env.DB, now - 60 * 60 * 1000);
  const requests = await db.purgeOldFriendRequests(env.DB, now - 30 * DAY);
  const raidSessions = await db.purgeOldRaidSessions(env.DB, now - DAY);
  const ledger = await db.purgeOldLedger(env.DB, now - 30 * DAY);
  const farmActions = await db.purgeOldFarmActions(env.DB, now - 7 * DAY);
  const invActions = await db.purgeOldInventoryActions(env.DB, now - 7 * DAY);
  const rosterActions = await db.purgeOldRosterActions(env.DB, now - 7 * DAY);
  const combineJobs = await db.purgeOldCombineJobs(env.DB, now - 30 * DAY);
  slog("cleanup", { sessions, buckets, requests, raidSessions, ledger, farmActions, invActions, rosterActions, combineJobs }, "info");
}

// Export both the HTTP handler and the cron handler. Cloudflare calls `scheduled`
// on the wrangler.toml cron; everything else is the Hono app.
export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(runCleanup(env, Date.now()));
  },
};
