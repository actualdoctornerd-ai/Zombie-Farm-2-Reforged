// Zombie Farm API — Cloudflare Worker (Hono + D1).
//
// Identity: Google Sign-In verified once (auth.ts), then our own session JWT.
// Ground truth: the save blob (rev-guarded), the friend graph, and the once/day
// gift limit all live server-side. The blob is opaque to the server except
// player.brains, which a gift claim credits (the one documented coupling).
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { Bindings, Vars, SaveGame } from "./env";
import {
  verifyGoogleIdToken,
  mintSession,
  verifySession,
  type GoogleIdentity,
} from "./auth";
import * as db from "./db";
import {
  canSendGift,
  isStaleWrite,
  normalizeFriendCode,
  normalizeUsername,
  projectFriendSave,
} from "./logic";

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

// ---- CORS ---------------------------------------------------------------
// Bearer-token auth (no cookies), so a simple origin allowlist is enough.
app.use("*", (c, next) =>
  cors({
    origin: [c.env.ALLOWED_ORIGIN, "http://localhost:5173", "http://localhost:4173"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  })(c, next)
);

app.get("/", (c) => c.json({ ok: true, service: "zombiefarm" }));

// ---- POST /auth: Google (or dev) sign-in -> our session token -----------
app.post("/auth", async (c) => {
  const body = await c.req.json<{
    idToken?: string;
    devSub?: string;
    devName?: string;
  }>().catch(() => ({}) as Record<string, never>);

  let who: GoogleIdentity;
  if (c.env.DEV_AUTH === "1" && body.devSub) {
    // Local/dev only: skip Google so the flow can be automated end-to-end.
    who = { sub: `dev:${body.devSub}` };
  } else if (body.idToken) {
    try {
      who = await verifyGoogleIdToken(body.idToken, c.env.GOOGLE_CLIENT_ID);
    } catch {
      return c.json({ error: "invalid_google_token" }, 401);
    }
  } else {
    return c.json({ error: "missing_id_token" }, 400);
  }

  const now = Date.now();
  const acct = await db.upsertAccount(c.env.DB, who, now);
  const token = await mintSession(acct.id, c.env.SESSION_SECRET);
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
const requireAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (
  c,
  next
) => {
  const hdr = c.req.header("Authorization") ?? "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const accountId = token ? await verifySession(token, c.env.SESSION_SECRET) : null;
  if (!accountId) return c.json({ error: "unauthorized" }, 401);
  c.set("accountId", accountId);
  await next();
};

app.use("/me", requireAuth);
app.use("/username", requireAuth);
app.use("/save", requireAuth);
app.use("/friends", requireAuth);
app.use("/friends/*", requireAuth);
app.use("/gifts", requireAuth);
app.use("/gifts/*", requireAuth);

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

// ---- GET /save ----------------------------------------------------------
app.get("/save", async (c) => {
  const row = await db.getSave(c.env.DB, c.get("accountId"));
  if (!row) return c.json({ save: null, rev: 0 });
  return c.json({ save: JSON.parse(row.blob) as SaveGame, rev: row.rev });
});

// ---- PUT /save: optimistic-concurrency write ----------------------------
app.put("/save", async (c) => {
  const { save, baseRev } = await c.req.json<{ save: SaveGame; baseRev: number }>();
  if (save == null || typeof baseRev !== "number") {
    return c.json({ error: "bad_request" }, 400);
  }
  const accountId = c.get("accountId");
  const cur = await db.getSave(c.env.DB, accountId);
  const currentRev = cur?.rev ?? 0;
  if (isStaleWrite(baseRev, currentRev)) {
    // Another device wrote in between: hand back the server copy to reconcile.
    return c.json(
      { error: "conflict", rev: currentRev, save: cur ? JSON.parse(cur.blob) : null },
      409
    );
  }
  const rev = currentRev + 1;
  await db.writeSave(c.env.DB, accountId, JSON.stringify(save), rev, Date.now());
  return c.json({ rev });
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

// ---- GET /friends/:id/save: read-only peek at a friend's farm -----------
// Powers "visit a friend's farm". Only a confirmed friend may read, and only a
// stripped projection is returned (projectFriendSave) — never the caller's own
// route, never a writable path. The visitor client renders this in a throwaway
// context with no autosave, so there is no way for a visit to mutate anything.
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

// ---- POST /friends/add: connect by friend code --------------------------
app.post("/friends/add", async (c) => {
  const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));
  const norm = normalizeFriendCode(code ?? "");
  if (!norm) return c.json({ error: "bad_code" }, 400);
  const me = c.get("accountId");
  const other = await db.accountByFriendCode(c.env.DB, norm);
  if (!other) return c.json({ error: "not_found" }, 404);
  if (other.id === me) return c.json({ error: "cannot_add_self" }, 400);
  await db.addFriendship(c.env.DB, me, other.id, Date.now());
  return c.json({
    friend: {
      accountId: other.id,
      name: other.username ?? "Player",
      friendCode: other.friend_code,
    },
  });
});

// ---- POST /gifts: send a brain (once/day per recipient) -----------------
app.post("/gifts", async (c) => {
  const { toAccountId } = await c.req
    .json<{ toAccountId: string }>()
    .catch(() => ({ toAccountId: "" }));
  const me = c.get("accountId");
  if (!toAccountId || toAccountId === me) return c.json({ error: "bad_request" }, 400);
  if (!(await db.areFriends(c.env.DB, me, toAccountId))) {
    return c.json({ error: "not_friends" }, 403);
  }
  const last = await db.lastGiftAt(c.env.DB, me, toAccountId);
  if (!canSendGift(last, Date.now())) {
    return c.json({ error: "already_gifted_today" }, 429);
  }
  await db.insertGift(c.env.DB, me, toAccountId, Date.now());
  return c.json({ ok: true });
});

// ---- GET /gifts/inbox ---------------------------------------------------
app.get("/gifts/inbox", async (c) => {
  const gifts = await db.inbox(c.env.DB, c.get("accountId"));
  return c.json(gifts);
});

// ---- POST /gifts/claim: credit one brain into my save -------------------
app.post("/gifts/claim", async (c) => {
  const { giftId } = await c.req.json<{ giftId: string }>().catch(() => ({ giftId: "" }));
  const me = c.get("accountId");
  const now = Date.now();

  const gift = await db.claimableGift(c.env.DB, giftId, me);
  if (!gift) {
    // Already claimed / not mine / unknown — idempotent: return current save.
    const cur = await db.getSave(c.env.DB, me);
    return c.json({
      save: cur ? (JSON.parse(cur.blob) as SaveGame) : null,
      rev: cur?.rev ?? 0,
      alreadyClaimed: true,
    });
  }
  const cur = await db.getSave(c.env.DB, me);
  if (!cur) {
    // No save to credit into yet (brand-new account). Ask the client to save
    // first; leave the gift unclaimed so no brain is lost.
    return c.json({ error: "save_first" }, 409);
  }

  const save = JSON.parse(cur.blob) as SaveGame;
  save.player.brains = (save.player.brains ?? 0) + 1;
  const rev = cur.rev + 1;

  // Mark claimed + write the credited save atomically. claimed_at guard makes a
  // concurrent double-claim a no-op on the second batch.
  await c.env.DB.batch([
    c.env.DB
      .prepare("UPDATE gifts SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
      .bind(now, gift.id),
    c.env.DB
      .prepare("UPDATE saves SET blob = ?, rev = ?, updated_at = ? WHERE account_id = ?")
      .bind(JSON.stringify(save), rev, now, me),
  ]);

  return c.json({ save, rev });
});

export default app;
