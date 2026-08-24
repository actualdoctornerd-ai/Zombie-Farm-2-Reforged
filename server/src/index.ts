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
import { Hono, type Context, type MiddlewareHandler } from "hono";
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
  mutationsAllowed,
  readServiceState,
  signInAllowed,
  signupsAllowed,
} from "./serviceState";
import {
  dayBucket,
  deviceLabel,
  importEligible,
  normalizeFriendCode,
  normalizeUsername,
  friendActivity,
  type GiftReward,
} from "./logic";
import { validateSave, MAX_SAVE_BYTES } from "./validate";
import type { EconomyEvent } from "./economy";
import type { FarmAction } from "./farm";
import { raidEcon, raidUnlocked } from "./raidCatalog";
import type { StorageAction } from "./storage";
import { levelForXp } from "./levels";
import type { InventoryAction } from "./inventory";
import type { ObjectAction } from "./objects";
import type { RosterAction } from "./roster";
import {
  buildPinnedRaid,
  verifyRaidSegment,
  RAID_RULESET_VERSION,
  type PinnedRaidConfig,
  type RaidReplayInput,
} from "./raidVerifier";
import { MAX_FUNCTIONAL_OBJECTS } from "./v3/engine";
import type { BattleSimSnapshot } from "../../src/raid/BattleSim";
import plantCatalog from "../../public/assets/plants.json";
import zombieCatalog from "../../public/assets/zombies.json";
import boostCatalog from "../../public/assets/boosts.json";
import objectCatalog from "../../public/assets/placeables.json";
import { CLIENT_INTEGRITY_VERSION, COMMAND_BATCH_LIMIT, EPIC_BOSS_TOKEN_GRANT_LIMIT, FARM_BULK_LIMIT, GAMEPLAY_PROTOCOL, type CommandBatchRequest, type GameplayCommand, type PresentationRequest } from "../../src/net/protocol";
import * as v3 from "./v3/db";
import * as v3Raid from "./v3/raid";
import * as v3EpicBoss from "./v3/epicBoss";
import * as v3Pvp from "./v3/pvp";
import {
  PVP_DEFENSE_MODE_DEFAULT, isPvpDefenseMode, type PvpDefenseMode,
} from "../../src/raid/pvp";
import * as writer from "./v3/writer";
import * as blackMarket from "./v3/blackMarket";

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();

// ---- abuse caps ---------------------------------------------------------
const MAX_FRIENDS = db.MAX_FRIENDS; // graph size cap per account (bounds accepting, not receiving)
const MAX_PENDING_REQUESTS = 200; // incoming requests we'll hold for a recipient
const MAX_INBOX = 200; // unclaimed gifts we'll hold / return

// ---- new-account server defaults ----------------------------------------
// The fixed starting state a NEW account (or any account when save-import is closed)
// receives. A client can never declare its own starting balance — that was the
// self-seed exploit. Mirrors the client's fresh-game values (GameState defaults) so a
// legitimately new player starts identically; farm size / roster / boosts default to
// the base (empty) via their own tables.
// The tutorial spends the fresh player's one brain on Insta-Grow.
// KEEP IN SYNC with GameState.brains and v3/engine.freshGameplayState.
const STARTER_BALANCE = { gold: 400, brains: 1, xp: 0 } as const;
const DEFAULT_FARM_SIZE = 30; // BASE_FARM_SIZE (shopCatalog)
const DEFAULT_ARMY_SIZE = 16;

function presentationOnlySave(save: SaveGame): SaveGame {
  return {
    version: save.version,
    savedAt: save.savedAt,
    player: {
      name: save.player?.name ?? "Zombie Farmer",
      gold: 0,
      brains: 0,
      xp: 0,
      zombieMax: DEFAULT_ARMY_SIZE,
      zombieCount: 0,
      farmer: save.player?.farmer,
    },
    farm: {
      fieldId: save.farm?.fieldId ?? "default",
      w: save.farm?.w ?? DEFAULT_FARM_SIZE,
      h: save.farm?.h ?? DEFAULT_FARM_SIZE,
      climate: save.farm?.climate ?? "grass",
      background: save.farm?.background,
      plots: (save.farm?.plots ?? []).filter((p) => p.state === "dirt" || p.state === "hole").map((p) => ({
        oc: p.oc,
        or: p.or,
        state: p.state,
      })),
    },
    // Identity/key entries are retained only as layout hints. GET /state and visitor
    // projection intersect them with authoritative ownership before returning them.
    objects: save.objects ?? [],
    ownedZombies: (save.ownedZombies ?? []).map((z) => ({
      id: z.id,
      key: z.key,
      name: z.name,
      pos: z.pos,
      stored: z.stored,
      color: z.color,
    })),
    raids: { completed: {}, attackOrder: save.raids?.attackOrder ?? [] },
    tutorial: save.tutorial,
  };
}

const catalogName = (rows: unknown, key: string): string => {
  if (!Array.isArray(rows)) return "";
  const row = rows.find((x) => x && typeof x === "object" && (x as { key?: unknown }).key === key) as
    | { name?: unknown }
    | undefined;
  return typeof row?.name === "string" ? row.name : "";
};

const farmQuestEvents = (actions: FarmAction[], results: db.FarmResult[]): db.TrustedGameEvent[] => {
  const byId = new Map(actions.map((a) => [a?.id, a]));
  const out: db.TrustedGameEvent[] = [];
  for (const result of results) {
    if (result.status !== "applied") continue;
    const a = byId.get(result.id);
    if (!a) continue;
    if (a.type === "plow") {
      out.push(
        { id: `farm:${a.id}:plow`, type: "kSoilPlowedNotification", subject: "Plow" },
        { id: `farm:${a.id}:new-plow`, type: "kNewSoilPlowedNotification", subject: "Plow" }
      );
    } else if (a.type === "plant") {
      const subject = catalogName(zombieCatalog, a.cropKey) || catalogName(plantCatalog, a.cropKey);
      out.push({ id: `farm:${a.id}:plant`, type: "kCropPlantedNotification", subject });
    } else if (a.type === "harvest") {
      // The action does not carry the planted key. applyFarmActions returns the
      // authoritative catalog subject for this exact reason.
      if (result.subject) {
        out.push({
          id: `farm:${a.id}:harvest`,
          type: result.zombie ? "kCropHarvestedZombieNotification" : "kCropHarvestedNotification",
          subject: result.subject,
        });
      }
    }
  }
  return out;
};

/** The save-import cutoff (epoch ms), or 0 when unset/invalid (imports closed). */
function migrationCutoffMs(env: Bindings): number {
  const n = Number(env.MIGRATION_CUTOFF_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether `accountId` may still import its pre-existing save into server-owned state:
 *  the account must have been created before the migration cutoff. When the cutoff is
 *  unset/0, or the account is newer than it, NO client-supplied seed is honored and the
 *  account gets fixed server defaults instead. This is what stops a fresh account from
 *  self-declaring 100M gold / a full roster (SECURITY.md own-account plan, item 2/5). */
async function seedAllowed(env: Bindings, accountId: string): Promise<boolean> {
  const cut = migrationCutoffMs(env);
  if (!cut) return false; // fast path: imports closed → skip the account read
  const acct = await db.accountById(env.DB, accountId);
  return !!acct && importEligible(acct.created_at, cut);
}

/** The currency seed to use when a NON-sync path must lazily create the balances row
 *  (gift claim, grant reconcile). Uses the SAME cutoff rule as the sync endpoints: a
 *  migration-eligible account may seed from its declared save currency, everyone else
 *  gets fixed server defaults. Without this, a gift claim would create the balances row
 *  straight from the (editable) save blob, letting a fresh account self-seed an inflated
 *  balance past the cutoff — the gate the sync endpoints already close. */
async function balanceSeed(
  env: Bindings,
  accountId: string,
  player: { gold?: number; brains?: number; xp?: number } | null | undefined
): Promise<{ gold: number; brains: number; xp: number }> {
  if (await seedAllowed(env, accountId)) {
    return { gold: player?.gold ?? 0, brains: player?.brains ?? 0, xp: player?.xp ?? 0 };
  }
  return { ...STARTER_BALANCE };
}

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

async function commandVolumeAllowed(env: Bindings, accountId: string, amount: number, now: number): Promise<boolean> {
  if (amount <= 0) return true;
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const hourly = await db.bumpCommandVolume(env.DB, accountId, "hour", hourStart, amount);
  const daily = await db.bumpCommandVolume(env.DB, accountId, "day", dayStart, amount);
  if (hourly >= 1_000 && hourly - amount < 1_000) {
    slog("account_command_volume", { account: accountId, hourly, daily }, "warn");
  }
  const allowed = hourly <= 2_000 && daily <= 10_000;
  if (!allowed) slog("account_command_rejected", { account: accountId, hourly, daily }, "alert");
  return allowed;
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
    allowHeaders: ["Authorization", "Content-Type", "X-Integrity-Version", "X-Client-Build",
      "X-Writer-Client", "X-Writer-Generation", "X-Writer-Token"],
    maxAge: 86400,
  })(c, next)
);

// Unauthenticated health probe. `raidRulesetVersion` is published here so the client
// deploy can refuse to publish a bundle whose raid ruleset the live Worker doesn't serve
// yet — see the preflight step in .github/workflows/deploy.yml.
// Unauthenticated health probe, and the one status surface the game's START SCREEN
// can read before anyone signs in — that is what lets it say "Online Farm is closed"
// instead of failing at the Google button. `service` keeps its literal string value:
// the admin console's uptime probe matches on it.
app.get("/", async (c) => {
  const state = await readServiceState(c.env.DB);
  return c.json({
    ok: true,
    service: "zombiefarm",
    protocolVersion: GAMEPLAY_PROTOCOL,
    raidRulesetVersion: RAID_RULESET_VERSION,
    serviceMode: state.mode,
    serviceNotice: state.notice,
  });
});

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
export function rateLimit(
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
    let retryAfterMs = windowMs;
    if (binding) {
      ok = (await binding.limit({ key })).success;
    } else {
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const max = override ? Number(override) : fallbackMax;
      ok = (await db.bumpRateLimit(c.env.DB, key, windowStart)) <= max;
      retryAfterMs = Math.max(1, windowStart + windowMs - Date.now());
    }
    if (!ok) {
      slog("rate_limited", { route: name, who });
      c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return c.json({ error: "rate_limited", retryAfterMs }, 429);
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
  // Closedown gate. `closed` shuts the door on everyone; the two middle modes keep it
  // open for the existing player base (they still need to read their farm to move it
  // to Local Farm) while refusing to register anyone new.
  const service = await readServiceState(c.env.DB, now);
  if (!signInAllowed(service)) {
    return c.json({ error: "service_closed", notice: service.notice }, 503);
  }
  const acct = await db.upsertAccount(c.env.DB, who, now, signupsAllowed(service));
  if (!acct) {
    slog("signup_refused", { mode: service.mode }, "info");
    return c.json({ error: "signups_closed", notice: service.notice }, 403);
  }
  const label = deviceLabel(c.req.header("User-Agent"));
  const sessionId = await db.createSession(c.env.DB, acct.id, now, label);
  const token = await mintSession(acct.id, sessionId, c.env.SESSION_SECRET);
  return c.json({
    token,
    accountId: acct.id,
    serviceMode: service.mode,
    serviceNotice: service.notice,
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
app.use("/state", requireAuth);
app.use("/session/*", requireAuth);
app.use("/logout", requireAuth);
app.use("/friends", requireAuth);
app.use("/friends/*", requireAuth);
app.use("/gifts", requireAuth);
app.use("/gifts/*", requireAuth);
app.use("/raid/*", requireAuth);
app.use("/epic-boss/*", requireAuth);
app.use("/storage/*", requireAuth);
app.use("/economy/*", requireAuth);
app.use("/quest/*", requireAuth);
app.use("/farm/*", requireAuth);
app.use("/inventory/*", requireAuth);
app.use("/object/*", requireAuth);
app.use("/roster/*", requireAuth);
app.use("/shop/*", requireAuth);
app.use("/bootstrap", requireAuth);
app.use("/commands", requireAuth);
app.use("/presentation", requireAuth);
app.use("/writer/*", requireAuth);
app.use("/black-market", requireAuth);
app.use("/black-market/*", requireAuth);

/** Every `/dev/*` route in one gate, registered BEFORE any of them so it runs first.
 *
 *  These fixtures set balances to 100M gold and mint arbitrary rosters — a production
 *  Worker must not expose one. Each route used to carry its own copy of this check as
 *  its first line: eight identical lines, all correct, and nothing at all stopping the
 *  ninth route from being added without one. The gate belongs to the PREFIX, not to
 *  each handler, so omission stops being possible.
 *
 *  Ahead of the route-level `requireAuth` too, deliberately: with DEV_AUTH off these
 *  paths should be indistinguishable from any other unrouted URL, rather than
 *  answering 401 and confirming something is there. Covered by devRoutes.test.ts.
 *
 *  NOTE for anything added near here: this module is the Worker ENTRY, so workerd
 *  treats every named export as a handler and refuses to boot on one it cannot call
 *  ("Incorrect type for map entry ... not of type 'function or ExportedHandler'").
 *  Exporting a plain constant from this file kills the Worker at startup — which is
 *  invisible to the unit suite and caught only by the integration harness. */
app.use("/dev/*", async (c, next) => {
  if (c.env.DEV_AUTH !== "1") return c.json({ error: "not_found" }, 404);
  await next();
});

// Local integration fixture. This route is inert in production (DEV_AUTH=0) and
// exists so tests can establish trusted authoritative state without reopening the
// permanently-closed client import endpoints.
app.post("/dev/fixture/roster", requireAuth, async (c) => {
  const body = await c.req.json<{ units?: unknown; remove?: unknown }>()
    .catch(() => ({ units: [], remove: [] }));
  // `remove` deletes roster rows outright — the fixture stand-in for a zombie lost,
  // sold, or perished elsewhere, so tests can exercise a defense whose members are
  // gone (or go missing MID-invasion) without staging the raid that kills them.
  const remove = Array.isArray(body.remove)
    ? body.remove.filter((id): id is string => typeof id === "string" && !!id).slice(0, 200)
    : [];
  if (remove.length) {
    const placeholders = remove.map(() => "?").join(",");
    await c.env.DB.prepare(
      `DELETE FROM roster_v3 WHERE account_id = ? AND unit_id IN (${placeholders})`)
      .bind(c.get("accountId"), ...remove).run();
  }
  const count = await db.grantRosterFixture(c.env.DB, c.get("accountId"), body.units);
  return c.json({ count });
});

// Bury zombies directly. The only production path into fallen_v3 is losing a raid,
// which needs a full verified replay that actually kills someone — far more moving
// parts than the memorial behaviour under test.
app.post("/dev/fixture/fallen", requireAuth, async (c) => {
  const body = await c.req.json<{ units?: unknown }>().catch(() => ({ units: [] }));
  const units = Array.isArray(body.units) ? body.units.slice(0, 200) : [];
  const accountId = c.get("accountId");
  let count = 0;
  for (const entry of units) {
    const unit = entry as Record<string, unknown>;
    if (typeof unit.id !== "string" || typeof unit.key !== "string") continue;
    await c.env.DB.prepare(`INSERT INTO fallen_v3
      (account_id, unit_id, zombie_key, name, mutation, invasions, color, died_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, unit_id) DO UPDATE SET name = excluded.name`)
      .bind(accountId, unit.id, unit.key, typeof unit.name === "string" ? unit.name : null,
        Number(unit.mutation ?? 0), Number(unit.invasions ?? 0), null,
        Number(unit.diedAt ?? Date.now())).run();
    count++;
  }
  return c.json({ count });
});

app.post("/dev/fixture/balance", requireAuth, async (c) => {
  const body = await c.req.json<{ gold?: number; brains?: number; xp?: number }>()
    .catch((): { gold?: number; brains?: number; xp?: number } => ({}));
  const gold = Math.max(0, Math.min(100_000_000, Math.floor(Number(body.gold ?? 400))));
  const brains = Math.max(0, Math.min(10_000_000, Math.floor(Number(body.brains ?? 20))));
  const xp = Math.max(0, Math.min(10_000_000, Math.floor(Number(body.xp ?? 0))));
  if (![gold, brains, xp].every(Number.isSafeInteger)) return c.json({ error: "bad_fixture_balance" }, 400);
  await c.env.DB.prepare(`UPDATE balances SET gold=?, brains=?, xp=?, claimed_level=? WHERE account_id=?`)
    .bind(gold, brains, xp, levelForXp(xp), c.get("accountId")).run();
  return c.json({ gold, brains, xp });
});

app.post("/dev/fixture/orphan-gift-grant", requireAuth, async (c) => {
  const body = await c.req.json<{ giftId?: string; settled?: boolean }>()
    .catch((): { giftId?: string; settled?: boolean } => ({}));
  const accountId = c.get("accountId");
  const gift = typeof body.giftId === "string"
    ? await db.claimableGift(c.env.DB, body.giftId, accountId) : null;
  if (!gift) return c.json({ error: "gift_not_found" }, 404);
  const grantId = crypto.randomUUID();
  const now = Date.now();
  const statements = [c.env.DB.prepare(`INSERT OR IGNORE INTO grants
    (id,account_id,kind,amount,source_gift_id,created_at,settled_at)
    VALUES (?,?,'brain',1,?,?,?)`).bind(
      grantId, accountId, gift.id, now, body.settled ? now : null
    )];
  if (body.settled) {
    statements.push(c.env.DB.prepare(`UPDATE balances SET brains=brains+1 WHERE account_id=?
      AND EXISTS(SELECT 1 FROM grants WHERE id=?)`).bind(accountId, grantId));
  }
  const result = await c.env.DB.batch(statements);
  return c.json({ inserted: (result[0]?.meta.changes ?? 0) === 1, settled: !!body.settled });
});

// Fill MY friends list with placeholder friends so the suite can sit an account
// exactly at the friend cap without signing in fifty of them. friendships.b_id is a
// foreign key, so each edge needs a real accounts row behind it — they are created
// here alongside it. The edge is written ONE WAY (me -> placeholder): only
// countFriends(me) needs to move, and a one-way row keeps the placeholders themselves
// at zero friends so they never perturb the other side of a cap check. Dev-only:
// absent when DEV_AUTH="0" (the deployed value).
app.post("/dev/fixture/friends-fill", requireAuth, async (c) => {
  const body = await c.req.json<{ count?: number }>().catch((): { count?: number } => ({}));
  const me = c.get("accountId");
  const want = Number.isFinite(body.count) ? Math.max(0, Math.floor(body.count as number)) : 0;
  const now = Date.now();
  const stmts = Array.from({ length: Math.min(want, 500) }, (_, i) => {
    const id = `fixture-friend-${me}-${i}`;
    return [
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO accounts (id, google_sub, username, friend_code, created_at, last_online_at)
         VALUES (?, ?, 'Placeholder', ?, ?, ?)`
      ).bind(id, `sub-${id}`, `ZF-FIXT${i.toString(36).toUpperCase().padStart(5, "0")}${me.slice(0, 4)}`, now, now),
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)"
      ).bind(me, id, now),
    ];
  }).flat();
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: await db.countFriends(c.env.DB, me) });
});

// Backdate an unopened gift I SENT into an earlier day bucket, so the suite can clear
// the once-a-day rule without waiting for midnight and check that the unopened-gift
// rule still holds on its own. Dev-only: absent when DEV_AUTH="0" (the deployed value).
app.post("/dev/fixture/gift-backdate", requireAuth, async (c) => {
  const body = await c.req.json<{ toAccountId?: string; days?: number }>()
    .catch((): { toAccountId?: string; days?: number } => ({}));
  const accountId = c.get("accountId");
  if (typeof body.toAccountId !== "string") return c.json({ error: "bad_request" }, 400);
  const days = Number.isFinite(body.days) ? Math.max(1, Math.floor(body.days as number)) : 1;
  const shift = days * 86_400_000;
  const res = await c.env.DB.prepare(
    `UPDATE gifts SET day_bucket = day_bucket - ?, created_at = created_at - ?
     WHERE from_id = ? AND to_id = ? AND claimed_at IS NULL`
  ).bind(days, shift, accountId, body.toAccountId).run();
  return c.json({ ok: true, moved: res.meta.changes ?? 0, days });
});

// Age one of MY OWN open Black Market posts, so the suite can exercise the three-day
// expiry and the repost cooldown without waiting for them. `created_at` is the single
// column both rules read, which is exactly why this fixture is one UPDATE. Dev-only:
// with DEV_AUTH="0" (the deployed value) this route does not exist.
app.post("/dev/fixture/market-backdate", requireAuth, async (c) => {
  const body = await c.req.json<{ orderId?: string; ageMs?: number }>()
    .catch((): { orderId?: string; ageMs?: number } => ({}));
  if (typeof body.orderId !== "string") return c.json({ error: "bad_request" }, 400);
  const ageMs = Math.max(0, Math.floor(Number(body.ageMs ?? 0)));
  if (!Number.isSafeInteger(ageMs)) return c.json({ error: "bad_request" }, 400);
  const res = await c.env.DB.prepare(
    `UPDATE black_market_orders SET created_at = ? WHERE id = ? AND creator_account_id = ?`
  ).bind(Date.now() - ageMs, body.orderId, c.get("accountId")).run();
  return c.json({ ok: true, moved: res.meta.changes ?? 0 });
});

// Overwrite the contents a gift in MY inbox was sent with, so the integration suite can
// exercise a known payout instead of whatever the send-time roll produced. Dev-only:
// with DEV_AUTH="0" (the deployed value) this route does not exist.
app.post("/dev/fixture/gift-reward", requireAuth, async (c) => {
  const body = await c.req.json<{ giftId?: string; kind?: string; amount?: number }>()
    .catch((): { giftId?: string; kind?: string; amount?: number } => ({}));
  const accountId = c.get("accountId");
  const kind = body.kind === "gold" ? "gold" : "brain";
  const amount = Number.isFinite(body.amount) ? Math.max(0, Math.floor(body.amount as number)) : 1;
  const gift = typeof body.giftId === "string"
    ? await db.claimableGift(c.env.DB, body.giftId, accountId) : null;
  if (!gift) return c.json({ error: "gift_not_found" }, 404);
  await c.env.DB.prepare(
    "UPDATE gifts SET reward_kind=?, reward_amount=? WHERE id=? AND to_id=? AND claimed_at IS NULL"
  ).bind(kind, amount, gift.id, accountId).run();
  return c.json({ ok: true, kind, amount });
});

app.use("*", async (c, next) => {
  const enforceAt = Number(c.env.INTEGRITY_V2_ENFORCE_AFTER_MS);
  const mutation = c.req.method !== "GET" && !c.req.path.startsWith("/session/") && c.req.path !== "/logout";
  if (
    mutation &&
    Number.isFinite(enforceAt) &&
    enforceAt > 0 &&
    Date.now() >= enforceAt &&
    !["2", "3", String(CLIENT_INTEGRITY_VERSION)].includes(c.req.header("X-Integrity-Version") ?? "")
  ) {
    return c.json({ error: "client_upgrade_required", integrityVersion: 2 }, 426);
  }
  await next();
});

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
app.use("/raid/pvp/start", rateLimit("RL_WRITE", "pvp_start", 30, 60_000));
app.use("/raid/pvp/finish", rateLimit("RL_WRITE", "pvp_finish", 30, 60_000));
app.use("/raid/pvp/collect", rateLimit("RL_WRITE", "pvp_collect", 60, 60_000));
app.use("/raid/pvp/collect-all", rateLimit("RL_WRITE", "pvp_collect_all", 30, 60_000));
app.use("/raid/pvp/history", rateLimit("RL_READ", "pvp_history", 120, 60_000));
app.use("/raid/pvp/replay/*", rateLimit("RL_READ", "pvp_replay", 60, 60_000));
app.use("/raid/pvp/defense", rateLimit("RL_WRITE", "pvp_defense", 60, 60_000));
// Preview builds a full defense snapshot from D1 — read-only but not free.
app.use("/raid/pvp/preview", rateLimit("RL_READ", "pvp_preview", 60, 60_000));
app.use("/raid/checkpoint", rateLimit("RL_WRITE", "raid_checkpoint", 30, 60_000));
app.use("/raid/finish", rateLimit("RL_WRITE", "raid_finish", 60, 60_000));
app.use("/raid/revive", rateLimit("RL_WRITE", "raid_revive", 60, 60_000));
app.use("/epic-boss/*", rateLimit("RL_WRITE", "epic_boss", 60, 60_000));
app.use("/raid/state", rateLimit("RL_READ", "raid_state", 300, 60_000));
app.use("/economy/apply", rateLimit("RL_WRITE", "economy_apply", 120, 60_000));
app.use("/economy/sync", rateLimit("RL_READ", "economy_sync", 300, 60_000));
app.use("/quest/complete", rateLimit("RL_WRITE", "quest_complete", 120, 60_000));
app.use("/quest/state", rateLimit("RL_READ", "quest_state", 300, 60_000));
app.use("/farm/actions", rateLimit("RL_WRITE", "farm_actions", 120, 60_000));
app.use("/farm/sync", rateLimit("RL_READ", "farm_sync", 300, 60_000));
app.use("/raid/sync", rateLimit("RL_READ", "raid_sync", 300, 60_000));
app.use("/storage/sync", rateLimit("RL_READ", "storage_sync", 300, 60_000));
app.use("/storage/actions", rateLimit("RL_WRITE", "storage_actions", 120, 60_000));
app.use("/inventory/actions", rateLimit("RL_WRITE", "inventory_actions", 120, 60_000));
app.use("/inventory/sync", rateLimit("RL_READ", "inventory_sync", 300, 60_000));
app.use("/object/actions", rateLimit("RL_WRITE", "object_actions", 120, 60_000));
app.use("/object/sync", rateLimit("RL_READ", "object_sync", 300, 60_000));
app.use("/roster/actions", rateLimit("RL_WRITE", "roster_actions", 120, 60_000));
app.use("/roster/sync", rateLimit("RL_READ", "roster_sync", 300, 60_000));
app.use("/shop/size", rateLimit("RL_WRITE", "shop_size", 30, 60_000));
app.use("/shop/climate", rateLimit("RL_WRITE", "shop_climate", 30, 60_000));
app.use("/shop/state", rateLimit("RL_READ", "shop_state", 300, 60_000));
app.use("/logout", rateLimit("RL_WRITE", "logout", 30, 60_000));
app.use("/session/logout-all", rateLimit("RL_WRITE", "logout_all", 10, 60_000));
app.use("/session/revoke", rateLimit("RL_WRITE", "session_revoke", 30, 60_000));
app.use("/session/list", rateLimit("RL_READ", "session_list", 120, 60_000));
app.use("/bootstrap", rateLimit("RL_READ", "bootstrap_v3", 30, 60_000));
app.use("/writer/status", rateLimit("RL_READ", "writer_status", 60, 60_000));
app.use("/commands", rateLimit("RL_WRITE", "commands_v3", 30, 60_000));
app.use("/presentation", rateLimit("RL_WRITE", "presentation_v3", 4, 60_000));
app.use("/writer/*", rateLimit("RL_WRITE", "writer_v3", 20, 60_000));
const blackMarketReadLimit = rateLimit("RL_READ", "black_market_read", 180, 60_000);
const blackMarketWriteLimit = rateLimit("RL_WRITE", "black_market_write", 60, 60_000);
app.use("/black-market/*", (c, next) =>
  (c.req.method === "GET" ? blackMarketReadLimit : blackMarketWriteLimit)(c, next));
// Reads + refresh (RL_READ): /me, GET /save shares the /save write limiter above,
// friend lists, a friend's farm, requests, inbox, token refresh.
app.use("/me", rateLimit("RL_READ", "me", 300, 60_000));
app.use("/state", rateLimit("RL_READ", "state", 300, 60_000));
app.use("/friends", rateLimit("RL_READ", "friends_list", 300, 60_000));
app.use("/friends/requests", rateLimit("RL_READ", "friends_reqs", 300, 60_000));
app.use("/friends/:id/save", rateLimit("RL_READ", "friend_farm", 120, 60_000));
app.use("/gifts/inbox", rateLimit("RL_READ", "inbox", 300, 60_000));
app.use("/session/refresh", rateLimit("RL_READ", "refresh", 60, 60_000));

/** How many fallen zombies one account may park in its presentation blob. Mirrors
 *  MAX_REMEMBERED_FALLEN on the client. The blob is capped at 128 KB in total, so
 *  the graveyard gets a hard ceiling of its own rather than being allowed to crowd
 *  out object positions and roster names. */
const MAX_PRESENTATION_FALLEN = 60;

/** One entry of a LEGACY client's graveyard.
 *
 *  The graveyard is server-owned now (fallen_v3, migration 0047): current clients
 *  read it from the bootstrap and never write it here. This check survives only so
 *  a client built before that table — which still puts `fallen` and
 *  `objectLayout[].memorial` in its presentation blob — is not rejected wholesale,
 *  which would stop its object positions and zombie names from saving too. The
 *  contents are ignored on read; only shape and size are enforced. */
function validFallenEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  const num = (v: unknown, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(row.id ?? "")) &&
    /^[A-Za-z0-9_-]{1,80}$/.test(String(row.key ?? "")) &&
    (row.name === undefined || str(row.name, 24)) &&
    (row.color === undefined || (Array.isArray(row.color) && row.color.length === 3 &&
      row.color.every((channel) => num(channel, 255)))) &&
    num(row.mutation, Number.MAX_SAFE_INTEGER) && num(row.invasions, 1e9) &&
    num(row.diedAt, Number.MAX_SAFE_INTEGER);
}

/** The client's saved farm line-ups (`ui.teams`): a name plus the account's own
 *  zombie ids. Cosmetic and client-authored — assembling a team only issues the
 *  ordinary roster.status commands this Worker validates one by one, so there is
 *  nothing here to check against. Bounded like every other client-authored shape
 *  purely so it cannot crowd out the rest of a 128 KB blob. Absent, or written by
 *  a client that predates teams, is fine. */
function validTeamList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 16) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as { id?: unknown; name?: unknown; members?: unknown };
    return typeof row.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(row.id) &&
      typeof row.name === "string" && [...row.name].length <= 24 &&
      !/[\u0000-\u001f\u007f]/.test(row.name) &&
      Array.isArray(row.members) && row.members.length <= 64 &&
      row.members.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id));
  });
}

/** The client's lifetime statistics tally (see the client's src/stats.ts). Cosmetic
 *  and client-authored like the Almanac: nothing on the server reads it back, and no
 *  price, gate or reward consults it. Bounded here for the same reason the Almanac is
 *  — a presentation blob must not be a place to park unbounded data. */
export function validStatsBlob(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  const counter = (n: unknown) =>
    n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
  for (const [key, entry] of Object.entries(stats)) {
    if (key === "harvested") continue;
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) || !counter(entry)) return false;
  }
  const harvested = stats.harvested;
  if (harvested === undefined) return true;
  if (!harvested || typeof harvested !== "object" || Array.isArray(harvested)) return false;
  const crops = Object.entries(harvested as Record<string, unknown>);
  return crops.length <= 512 && crops.every(([key, n]) =>
    /^[A-Za-z0-9_.-]{1,80}$/.test(key) &&
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
}

/**
 * The lifetime tally to splice into an incoming presentation write, or undefined to
 * store the write as it stands.
 *
 * The blob is stored WHOLESALE, and a client built before the tally existed sends a
 * `ui` object with no `stats` in it. That write is otherwise perfectly good and must
 * keep being accepted — but taken verbatim it erases the account's counters, and the
 * next updated client to sign in reads the silence as a farm that has never harvested
 * anything. So a write that says nothing about the tally leaves the stored one alone,
 * rather than deleting it. A client that DOES send one is authoritative over it (the
 * counters are client-authored; see the client's src/stats.ts).
 *
 * Only "no opinion" is protected. Nothing here can raise a counter, and nothing reads
 * these numbers back as truth.
 */
export function statsToCarryForward(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | null
): unknown {
  const sent = (incoming.ui as { stats?: unknown } | undefined)?.stats;
  if (sent !== undefined) return undefined;
  return (stored?.ui as { stats?: unknown } | undefined)?.stats;
}

function validFallenList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) &&
    value.length <= MAX_PRESENTATION_FALLEN && value.every(validFallenEntry));
}

const minProtocolVersion = (env: Bindings): number => {
  const value = Number(env.MIN_PROTOCOL_VERSION ?? GAMEPLAY_PROTOCOL);
  return Number.isInteger(value) && value > 0 ? value : GAMEPLAY_PROTOCOL;
};

const writerCredential = (c: Parameters<MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }>>[0]): writer.WriterCredential | null => {
  const clientId = c.req.header("X-Writer-Client") ?? "";
  const token = c.req.header("X-Writer-Token") ?? "";
  const generation = Number(c.req.header("X-Writer-Generation"));
  return clientId.length >= 8 && clientId.length <= 128 && token.length >= 32 && token.length <= 256 &&
    Number.isSafeInteger(generation) && generation >= 0 ? { clientId, token, generation } : null;
};

app.post("/writer/acquire", async (c) => {
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  if (typeof body.clientId !== "string" || body.clientId.length < 8 || body.clientId.length > 128 ||
      typeof body.token !== "string" || body.token.length < 32 || body.token.length > 256 ||
      !Number.isSafeInteger(body.observedGeneration) || typeof body.takeover !== "boolean") {
    return c.json({ error: "bad_writer_request" }, 400);
  }
  const result = await writer.acquire(c.env.DB, c.get("accountId"), c.get("sessionId"), {
    clientId: body.clientId,
    token: body.token,
    observedGeneration: Number(body.observedGeneration),
    takeover: body.takeover,
  }, Date.now());
  if (result.status !== 200) return c.json({ error: result.error, writerGeneration: result.generation }, result.status);
  return c.json({ ok: true, writerGeneration: result.generation, accountVersion: result.accountVersion });
});

app.post("/writer/release", async (c) => {
  const released = await writer.release(
    c.env.DB, c.get("accountId"), c.get("sessionId"), writerCredential(c), Date.now()
  );
  return c.json({ ok: true, released });
});

app.get("/writer/status", async (c) => c.json(await writer.projection(
  c.env.DB, c.get("accountId"), c.get("sessionId"), writerCredential(c), Date.now()
)));

const writerProtectedMutation = (method: string, path: string): boolean => {
  if (method === "PUT" && (path === "/presentation" || path === "/save")) return true;
  if (method !== "POST") return false;
  return path === "/commands" || path === "/gifts" ||
    path.startsWith("/raid/") || path.startsWith("/epic-boss/") || path.startsWith("/black-market/");
};

// Activity-triggered exclusive writer fencing. Legacy clients remain usable only
// during the short observe rollout; upgraded clients are always fenced.
app.use("*", async (c, next) => {
  if (!writerProtectedMutation(c.req.method, c.req.path)) return next();
  const upgraded = c.req.header("X-Integrity-Version") === String(CLIENT_INTEGRITY_VERSION);
  if (!upgraded) {
    if (c.env.WRITER_LEASE_MODE === "enforce") {
      return c.json({ error: "client_upgrade_required", integrityVersion: CLIENT_INTEGRITY_VERSION }, 426);
    }
    return next();
  }
  const credential = writerCredential(c);
  if (c.req.path === "/commands") {
    if (!await writer.validate(c.env.DB, c.get("accountId"), c.get("sessionId"), credential, Date.now())) {
      return c.json({ error: "writer_replaced" }, 423);
    }
    return next();
  }
  const operationId = crypto.randomUUID();
  const began = await writer.beginOperation(
    c.env.DB, c.get("accountId"), c.get("sessionId"), credential, operationId, Date.now()
  );
  if (began === "writer_replaced") return c.json({ error: "writer_replaced" }, 423);
  if (began === "operation_in_progress") {
    slog("writer_operation_rejected", {
      account: accountHash(c.get("accountId")),
      path: c.req.path,
      reason: began,
    }, "warn");
    return c.json({ error: "operation_in_progress", retryAfterMs: 250 }, 409);
  }
  try {
    await next();
  } finally {
    await writer.endOperation(c.env.DB, c.get("accountId"), operationId, Date.now());
  }
});

const accountHash = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const metric = (route: string, accountId: string, started: number, detail: Record<string, unknown> = {}): void => {
  // Successful routine metrics can be sampled by the log pipeline; errors retain
  // their full security lines through slog(). No raw account id is emitted.
  console.log(JSON.stringify({
    metric: "gameplay_request",
    route,
    calls: 1,
    build: "v3",
    accountHash: accountHash(accountId),
    cpuMs: Math.max(0, performance.now() - started),
    ...detail,
  }));
};

const commandString = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const commandInt = (value: unknown): value is number => Number.isSafeInteger(value);
/** The door every gameplay command must pass before the engine sees it. A type
 *  missing here is refused as `bad_command_batch`, which kills the WHOLE batch —
 *  so an omission doesn't degrade one action, it pauses the player's farm for good
 *  (the outbox persists, and the rebuilt batch carries the same command). Exported
 *  so a test can hold it against the client's GameplayCommand union; engine tests
 *  call the engine directly and cannot catch a gap here. */
export const validGameplayCommand = (value: unknown): value is GameplayCommand => {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "writer.claim": return true;
    case "farm.plow": case "farm.harvest": case "farm.remove":
      return commandInt(command.oc) && commandInt(command.or);
    case "farm.move":
      return commandInt(command.oc) && commandInt(command.or) &&
        commandInt(command.toOc) && commandInt(command.toOr);
    case "farm.plant":
      return commandInt(command.oc) && commandInt(command.or) && commandString(command.cropKey) &&
        (command.fertilized === undefined || typeof command.fertilized === "boolean");
    // Bulk forms. FARM_BULK_LIMIT is the whole board (289 plots), so the cap bounds the
    // payload without ever refusing a legitimate full-farm stroke. An empty list is
    // accepted and applies nothing — a length floor here would turn a harmless
    // client-side edge into `bad_command_batch`, which pauses the farm permanently.
    case "farm.plow_many":
      return Array.isArray(command.plots) && command.plots.length <= FARM_BULK_LIMIT &&
        command.plots.every((plot) => !!plot && typeof plot === "object" &&
          commandInt((plot as Record<string, unknown>).oc) &&
          commandInt((plot as Record<string, unknown>).or));
    case "farm.plant_many":
      return commandString(command.cropKey) && Array.isArray(command.plots) &&
        command.plots.length <= FARM_BULK_LIMIT &&
        command.plots.every((entry) => {
          if (!entry || typeof entry !== "object") return false;
          const plot = entry as Record<string, unknown>;
          return commandInt(plot.oc) && commandInt(plot.or) &&
            (plot.fertilized === undefined || typeof plot.fertilized === "boolean");
        });
    case "power.buy": return commandString(command.key);
    case "power.use":
      return commandString(command.key) && (command.oc === undefined || commandInt(command.oc)) &&
        (command.or === undefined || commandInt(command.or)) &&
        (command.target === undefined || command.target === "zombie_pot");
    case "object.buy":
      return commandString(command.catalogKey) &&
        (command.clientInstanceId === undefined || commandString(command.clientInstanceId));
    case "object.refund": return commandString(command.instanceId);
    case "object.upgrade": return commandString(command.instanceId) && commandString(command.catalogKey);
    case "object.status":
      return commandString(command.instanceId) && (command.status === "placed" || command.status === "stored");
    case "object.harvest_trees":
      return Array.isArray(command.instanceIds) && command.instanceIds.length <= 225 &&
        command.instanceIds.every((id) => commandString(id));
    case "storage.claim":
      return commandString(command.itemName) &&
        (command.clientInstanceId === undefined || commandString(command.clientInstanceId));
    case "storage.move":
      return commandString(command.itemKey) && (command.direction === "store" || command.direction === "take") &&
        commandInt(command.quantity);
    case "roster.sell": return commandString(command.unitId);
    case "roster.status": return commandString(command.unitId) && typeof command.stored === "boolean";
    case "roster.combine_start":
      return commandString(command.potId) && commandString(command.parentAId) &&
        commandString(command.parentBId) &&
        (command.playerLevel === undefined || (commandInt(command.playerLevel) && command.playerLevel >= 1));
    case "roster.combine":
      return commandString(command.parentAId) && commandString(command.parentBId) &&
        (command.potId === undefined || commandString(command.potId)) &&
        (command.stored === undefined || typeof command.stored === "boolean") &&
        (command.playerLevel === undefined || (commandInt(command.playerLevel) && command.playerLevel >= 1));
    case "shop.size": return commandInt(command.size) && (command.currency === "gold" || command.currency === "brains");
    case "shop.climate": return commandString(command.terrain);
    case "farmer.buy": return commandInt(command.headId);
    case "farmer.equip": return commandInt(command.headId);
    case "farmer.bonus": return command.headId === null || commandInt(command.headId);
    case "pet.buy": return commandString(command.petKey);
    case "pet.equip": return command.petKey === null || commandString(command.petKey);
    case "pet.pen":
      return Array.isArray(command.petKeys) && command.petKeys.length <= 4 &&
        command.petKeys.every((key) => commandString(key));
    case "memorial.enshrine":
      return commandString(command.instanceId) && commandString(command.unitId) &&
        (command.name === undefined || commandString(command.name, 64));
    case "memorial.clear": return commandString(command.instanceId);
    case "quest.periodic_claim":
      return (command.scope === "daily" || command.scope === "weekly") &&
        commandString(command.questId, 64);
    case "epicBoss.token":
      return commandString(command.runId) &&
        (command.count === undefined ||
          (commandInt(command.count) && command.count >= 1 && command.count <= EPIC_BOSS_TOKEN_GRANT_LIMIT));
    case "tutorial.complete": return true;
    default: return false;
  }
};

const validCommandBatch = (body: unknown): body is CommandBatchRequest => {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<CommandBatchRequest>;
  if (b.protocolVersion !== GAMEPLAY_PROTOCOL || typeof b.deviceId !== "string" || b.deviceId.length < 8 || b.deviceId.length > 128) return false;
  if (typeof b.batchId !== "string" || b.batchId.length < 8 || b.batchId.length > 128) return false;
  if (!Number.isSafeInteger(b.firstSequence) || !Number.isSafeInteger(b.expectedAccountVersion) || !Number.isSafeInteger(b.writerGeneration)) return false;
  if (!Array.isArray(b.commands) || b.commands.length < 1 || b.commands.length > COMMAND_BATCH_LIMIT) return false;
  return b.commands.every((entry, index) =>
    !!entry && typeof entry === "object" && entry.sequence === (b.firstSequence as number) + index &&
    validGameplayCommand(entry.command)
  );
};

/** Why a batch failed `validCommandBatch`, in a form that is safe to log.
 *
 *  This is the one rejection in the system with no recovery: the client returns the
 *  commands to its outbox, rebuilds an identical envelope, and is refused again — so a
 *  single unacceptable command pauses that farm across reloads, for good. It was also
 *  the ONLY rejection path with no `slog` line, which meant the failure mode we most
 *  need to see left no trace on the server at all; the player's own toast was the only
 *  evidence anywhere.
 *
 *  Deliberately shape-only. Command TYPES are named (that is what identifies the
 *  offending client build), but no field values are read out — a batch that reached
 *  here is by definition untrusted input, and its payload is nobody's business. */
export function describeInvalidBatch(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return { reason: "not_an_object" };
  const b = body as Partial<CommandBatchRequest>;
  const commands = Array.isArray(b.commands) ? b.commands : null;
  const label = (entry: unknown): string => {
    if (!entry || typeof entry !== "object") return "<malformed>";
    const command = (entry as { command?: unknown }).command;
    if (!command || typeof command !== "object") return "<no-command>";
    const type = (command as { type?: unknown }).type;
    return typeof type === "string" ? type.slice(0, 64) : "<untyped>";
  };
  // Envelope problems come first: with a bad envelope the command list has not been
  // judged at all, so naming a command as the culprit would be a guess.
  const envelope =
    b.protocolVersion !== GAMEPLAY_PROTOCOL ? "protocol_version"
    : typeof b.deviceId !== "string" || b.deviceId.length < 8 || b.deviceId.length > 128 ? "device_id"
    : typeof b.batchId !== "string" || b.batchId.length < 8 || b.batchId.length > 128 ? "batch_id"
    : !Number.isSafeInteger(b.firstSequence) ? "first_sequence"
    : !Number.isSafeInteger(b.expectedAccountVersion) ? "expected_account_version"
    : !Number.isSafeInteger(b.writerGeneration) ? "writer_generation"
    : !commands ? "commands_not_array"
    : commands.length < 1 ? "commands_empty"
    : commands.length > COMMAND_BATCH_LIMIT ? "commands_too_many"
    : null;
  if (envelope || !commands) {
    return { reason: "envelope", field: envelope ?? "commands_not_array",
      protocolVersion: typeof b.protocolVersion === "number" ? b.protocolVersion : null,
      commandCount: commands?.length ?? null };
  }
  const index = commands.findIndex((entry, at) =>
    !entry || typeof entry !== "object" || entry.sequence !== (b.firstSequence as number) + at ||
    !validGameplayCommand(entry.command));
  const offender = index >= 0 ? commands[index] : null;
  return {
    reason: "command",
    index,
    // The refused command, plus the whole batch's shape: a type that is valid on its
    // own but arrives in an order the server does not expect looks identical to an
    // unknown type unless the neighbours are visible too.
    commandType: label(offender),
    sequenceOk: !!offender && typeof offender === "object" &&
      offender.sequence === (b.firstSequence as number) + index,
    commandCount: commands.length,
    types: [...new Set(commands.map(label))].slice(0, 12),
  };
}

// The single "is the economy accepting writes?" question, asked by every mutation
// route. Two independent levers, either of which halts writes: MUTATIONS_DISABLED (a
// Worker var — the incident lever, needs a deploy) and the D1 service mode (the
// planned-closedown lever the admin console flips). Reads are deliberately unaffected:
// in `export_only` a player must still be able to load their farm to move it to Local
// Farm. The service read is memoised per isolate, so this is not a D1 hit per request.
const mutationsHalted = async (
  c: Context<{ Bindings: Bindings; Variables: Vars }>
): Promise<boolean> =>
  c.env.MUTATIONS_DISABLED === "1" || !mutationsAllowed(await readServiceState(c.env.DB));

// The friend graph and gifts are account state too, and a gift claimed after a player
// exported their farm would silently make their exported copy wrong. Freeze them on the
// same gate as gameplay. Registered as middleware because these handlers are far below
// and reads on the same prefixes (GET /friends, GET /gifts/inbox) must stay open.
const haltSocialMutations: MiddlewareHandler<{ Bindings: Bindings; Variables: Vars }> = async (
  c,
  next
) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  await next();
};
for (const path of [
  "/friends/add",
  "/friends/accept",
  "/friends/reject",
  "/friends/remove",
  "/friends/block",
  "/friends/code/rotate",
  "/gifts",
  "/gifts/claim",
]) {
  app.post(path, haltSocialMutations);
}

// One read after authentication initializes and returns every projection needed by
// gameplay. It never takes writer ownership.
app.post("/bootstrap", async (c) => {
  const started = performance.now();
  const accountId = c.get("accountId");
  const now = Date.now();
  // Session expiry is a read-time invariant, not something that waits for the
  // player to start the same activity again. This prevents abandoned fights from
  // leaving a roster locked or blocking the other battle mode indefinitely.
  await v3Raid.expireLiveRaid(c.env.DB, accountId, now);
  await v3EpicBoss.expireLiveEpicBoss(c.env.DB, accountId, now);
  const writerState = await writer.projection(
    c.env.DB, accountId, c.get("sessionId"), writerCredential(c), now
  );
  const response = await v3.bootstrap(
    c.env.DB,
    accountId,
    now,
    !(await mutationsHalted(c)),
    minProtocolVersion(c.env),
    writerState
  );
  // Feature capability, not state: the client shows its Invasions surfaces only when
  // this Worker will accept /raid/pvp/start, so launching PvP is ONE Worker-var flip
  // with no client redeploy and no dead button in the meantime.
  const payload = { ...response, pvpEnabled: pvpEnabled(c.env) };
  metric("bootstrap", accountId, started, { payloadBytes: JSON.stringify(payload).length });
  return c.json(payload);
});

app.post("/commands", async (c) => {
  const started = performance.now();
  const accountId = c.get("accountId");
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<unknown>().catch(() => null);
  if (!validCommandBatch(body)) {
    // "alert", not "warn": this is unrecoverable for the account that hit it (see
    // describeInvalidBatch), so it wants to be findable without knowing to look.
    slog("command_batch_invalid", {
      account: accountHash(accountId),
      build: c.req.header("X-Client-Build") ?? "unknown",
      integrityVersion: c.req.header("X-Integrity-Version") ?? "none",
      ...describeInvalidBatch(body),
    }, "alert");
    return c.json({ error: "bad_command_batch" }, 400);
  }
  const credential = writerCredential(c);
  if (c.req.header("X-Integrity-Version") === String(CLIENT_INTEGRITY_VERSION) &&
      (!credential || body.deviceId !== credential.clientId || body.takeWriter)) {
    return c.json({ error: "bad_writer_command" }, 400);
  }
  if (body.protocolVersion < minProtocolVersion(c.env)) {
    return c.json({ error: "update_required", minimumProtocolVersion: minProtocolVersion(c.env) }, 426);
  }
  const result = await v3.applyBatch(c.env.DB, accountId, body, Date.now());
  metric("commands", accountId, started, {
    build: c.req.header("X-Client-Build") ?? "unknown",
    commands: body.commands.length,
    commandsPerBatch: body.commands.length,
    affectedPlots: new Set(body.commands.flatMap((entry) =>
      "oc" in entry.command && "or" in entry.command ? [`${entry.command.oc}:${entry.command.or}`] : [])).size,
    affectedTrees: body.commands.reduce((count, entry) =>
      count + (entry.command.type === "object.harvest_trees" ? new Set(entry.command.instanceIds).size : 0), 0),
    d1RowsRead: 9,
    d1RowsWritten: result.status === 200 ? 5 : 0,
    commandRejections: result.status === 200
      ? result.response.results.filter((entry) => entry.status === "rejected" || entry.status === "dependency_failed").length
      : 0,
    payloadBytes: Number(c.req.header("content-length") ?? 0),
    status: result.status,
    rejection: result.status === 200 ? undefined : result.error,
  });
  if (result.status === 200) return c.json(result.response);
  if (result.status === 429 && result.body?.retryAfterMs) c.header("Retry-After", String(Math.ceil(Number(result.body.retryAfterMs) / 1000)));
  return c.json({ error: result.error, ...result.body }, result.status);
});

app.put("/presentation", async (c) => {
  const started = performance.now();
  const accountId = c.get("accountId");
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<PresentationRequest>().catch(() => null);
  if (!body || body.protocolVersion !== GAMEPLAY_PROTOCOL || !Number.isSafeInteger(body.expectedVersion) ||
      !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return c.json({ error: "bad_presentation" }, 400);
  }
  const presentationKeys = new Set(["player", "farm", "objectLayout", "rosterLayout", "zombiePot", "zombiePots", "tutorial", "ui", "settings", "camera", "selections", "almanac", "fallen"]);
  const pot = body.data.zombiePot as Record<string, unknown> | undefined;
  const validPot = pot === undefined || (!!pot && typeof pot === "object" && !Array.isArray(pot) &&
    typeof pot.parentAId === "string" && pot.parentAId.length <= 80 &&
    typeof pot.parentBId === "string" && pot.parentBId.length <= 80 &&
    typeof pot.keyA === "string" && typeof pot.keyB === "string" &&
    Number.isFinite(pot.startedAt) && Number.isFinite(pot.finishAt));
  const pots = body.data.zombiePots as Record<string, Record<string, unknown>> | undefined;
  const validPots = pots === undefined || (!!pots && typeof pots === "object" && !Array.isArray(pots) &&
    Object.keys(pots).length <= 3 && Object.entries(pots).every(([id, job]) =>
      /^[A-Za-z0-9_-]{1,80}$/.test(id) && !!job && typeof job === "object" && !Array.isArray(job) &&
      typeof job.parentAId === "string" && job.parentAId.length <= 80 &&
      typeof job.parentBId === "string" && job.parentBId.length <= 80 &&
      typeof job.keyA === "string" && typeof job.keyB === "string" &&
      Number.isFinite(job.startedAt) && Number.isFinite(job.finishAt)
    ));
  const rosterLayout = body.data.rosterLayout as unknown;
  const validRosterLayout = rosterLayout === undefined || (Array.isArray(rosterLayout) &&
    rosterLayout.length <= 512 && rosterLayout.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const row = entry as { id?: unknown; name?: unknown };
      if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id)) return false;
      return row.name === undefined || (typeof row.name === "string" &&
        [...row.name].length <= 24 && !/[\u0000-\u001f\u007f]/.test(row.name));
    }));
  // Zombie Almanac lifetime-discovery counts (cosmetic, client-authored). Bounded
  // like the other presentation shapes so a hostile client can't bloat the blob.
  const almanac = body.data.almanac as { discovered?: unknown } | undefined;
  const validAlmanac = almanac === undefined || (!!almanac && typeof almanac === "object" &&
    !Array.isArray(almanac) && (() => {
      const discovered = almanac.discovered;
      return discovered === undefined || (!!discovered && typeof discovered === "object" &&
        !Array.isArray(discovered) && Object.keys(discovered).length <= 512 &&
        Object.entries(discovered).every(([key, count]) =>
          /^[A-Za-z0-9_-]{1,80}$/.test(key) &&
          typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= 1_000_000));
    })());
  // The graveyard: zombies lost in an invasion, kept only so a Memorial Statue can
  // show one. Client-authored and cosmetic like the Almanac — the server deletes a
  // casualty outright and keeps no record of it, so there is nothing here to check
  // against. Bounded the same way: a hostile client must not be able to inflate the
  // blob, and none of these fields is ever read back as gameplay truth.
  const validFallen = validFallenList(body.data.fallen);
  // Saved farm line-ups ride the `ui` blob (see the client's SaveManager).
  const ui = body.data.ui as { teams?: unknown; stats?: unknown } | undefined;
  const validUi = ui === undefined ||
    (!!ui && typeof ui === "object" && !Array.isArray(ui) &&
      validTeamList(ui.teams) && validStatsBlob(ui.stats));
  const objectLayout = body.data.objectLayout as unknown;
  // Derived, NOT a literal 512, and one MORE than the object cap. A farm may hold
  // MAX_FUNCTIONAL_OBJECTS server objects, and the layout carries one thing the object
  // document never does: the free starter shed, which is presentation-only until it is
  // upgraded (`adoptsFreeStarterShed`) and which `reconcileObjectLayouts` deliberately
  // exempts from tombstone pruning for exactly that reason. So a player who fills their
  // farm to the cap sends 513 layouts against a bound of 512, and the whole presentation
  // write is refused — every zombie name, team, Almanac entry, camera position and
  // lifetime counter stops saving, silently and for good, for the most decorated farms
  // in the game. Two independently-written copies of one number is what made that
  // possible; there is now one.
  const validObjectLayout = objectLayout === undefined || (Array.isArray(objectLayout) &&
    objectLayout.length <= MAX_FUNCTIONAL_OBJECTS + 1 && objectLayout.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const row = entry as { id?: unknown; key?: unknown; oc?: unknown; or?: unknown;
        rotation?: unknown; turn?: unknown; memorial?: unknown };
      return typeof row.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(row.id) &&
        (row.key === undefined || row.key === "storage01") &&
        Number.isSafeInteger(row.oc) && Number(row.oc) >= 0 && Number(row.oc) < 128 &&
        Number.isSafeInteger(row.or) && Number(row.or) >= 0 && Number(row.or) < 128 &&
        (row.rotation === undefined || row.rotation === 0 || row.rotation === 1) &&
        // A road bend stores which corner it is turned to instead of a mirror flag.
        (row.turn === undefined ||
          (Number.isSafeInteger(row.turn) && Number(row.turn) >= 0 && Number(row.turn) < 8)) &&
        // A Memorial Statue carries the one zombie carved on it.
        (row.memorial === undefined || validFallenEntry(row.memorial));
    }));
  if (!Object.keys(body.data).every((key) => presentationKeys.has(key)) ||
      !validObjectLayout || !validRosterLayout || !validPot || !validPots || !validAlmanac ||
      !validFallen || !validUi) {
    return c.json({ error: "bad_presentation" }, 400);
  }
  // Carry a lifetime tally past a client too old to send one. The extra read happens
  // ONLY for such a client — an up-to-date one always sends the field, so the common
  // path is unchanged. Not atomic with the write, and it does not need to be: the
  // version CAS below rejects anything that landed in between, and the client retries.
  let data = body.data;
  if ((body.data.ui as { stats?: unknown } | undefined)?.stats === undefined) {
    const carried = statsToCarryForward(
      body.data, await v3.readPresentationData(c.env.DB, accountId)
    );
    if (carried !== undefined) {
      data = { ...body.data, ui: { ...(body.data.ui as Record<string, unknown> ?? {}), stats: carried } };
    }
  }
  const encoded = JSON.stringify(data);
  if (encoded.length > 128 * 1024) return c.json({ error: "too_large" }, 413);
  const saved = await v3.writePresentation(c.env.DB, accountId, body.expectedVersion, data, Date.now());
  if (!saved) return c.json({ error: "presentation_conflict" }, 409);
  metric("presentation", accountId, started, { payloadBytes: encoded.length });
  return c.json(saved);
});

const marketEnabled = (env: Bindings): boolean => env.BLACK_MARKET_ENABLED === "1";

// Posts expire after three days. The board hides a stale one from everybody the
// moment it ages out; this is where its OWNER's escrow comes back, so it runs on the
// reads they make on the way in. Failing to sweep must never fail the read itself —
// the worst case is that the escrow waits for the next visit.
//
// It is deliberately NOT run from POST /black-market/orders. The sweep bumps
// `account_version`, and create() CAS-checks the version the client fetched moments
// earlier — so sweeping there would make the very post that triggered it fail with
// `state_conflict`. Nothing is lost by leaving it out: both active-limit checks
// already ignore stale posts, so one can never block a new listing.
const sweepStaleMarketPosts = async (
  c: Context<{ Bindings: Bindings; Variables: Vars }>
): Promise<void> => {
  // The sweep returns escrow and bumps the account version — it is a MUTATION that
  // happens to hang off a read, so the closedown switch has to stop it too. Without
  // this, a frozen service would still be moving zombies and currency around, and a
  // player's export could stop matching their account.
  if (await mutationsHalted(c)) return;
  try {
    await blackMarket.expireStalePosts(c.env.DB, c.get("accountId"), Date.now());
  } catch (error) {
    slog("black_market_sweep_failed", { error: String(error) }, "warn");
  }
};

app.get("/black-market/orders", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  await sweepStaleMarketPosts(c);
  return c.json(await blackMarket.list(c.env.DB, c.get("accountId"), c.req.query(), Date.now()));
});

app.get("/black-market/summary", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  await sweepStaleMarketPosts(c);
  return c.json(await blackMarket.summary(c.env.DB, c.get("accountId"), Date.now()));
});

app.get("/black-market/fulfillments", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  return c.json(await blackMarket.fulfillments(c.env.DB, c.get("accountId")));
});

app.get("/black-market/history", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  return c.json(await blackMarket.history(c.env.DB, c.get("accountId")));
});

// Collecting is no longer pure bookkeeping: it is also where the recipient takes
// delivery of a traded zombie, which mints a roster row — hence the mutation gate.
app.post("/black-market/orders/:id/collect", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const result = await blackMarket.collect(c.env.DB, c.get("accountId"), c.req.param("id"), Date.now());
  if (!("ok" in result)) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post("/black-market/orders/:id/repost", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const started = performance.now();
  const result = await blackMarket.repost(c.env.DB, c.get("accountId"), c.req.param("id"), Date.now());
  if (!("ok" in result)) return c.json({ error: result.error }, result.status);
  metric("black_market_repost", c.get("accountId"), started);
  return c.json(result);
});

app.post("/black-market/orders", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const started = performance.now();
  const result = await blackMarket.create(c.env.DB, c.get("accountId"),
    await c.req.json<Record<string, unknown>>().catch(() => ({})), Date.now());
  if (!("ok" in result)) return c.json({ error: result.error }, result.status);
  metric("black_market_create", c.get("accountId"), started, { kind: result.order.kind });
  return c.json(result);
});

app.post("/black-market/orders/:id/cancel", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const started = performance.now();
  const result = await blackMarket.cancel(c.env.DB, c.get("accountId"), c.req.param("id"),
    await c.req.json<Record<string, unknown>>().catch(() => ({})), Date.now());
  if (!("ok" in result)) return c.json({ error: result.error }, result.status);
  metric("black_market_cancel", c.get("accountId"), started);
  return c.json(result);
});

app.post("/black-market/orders/:id/fulfill", async (c) => {
  if (!marketEnabled(c.env)) return c.json({ error: "black_market_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const started = performance.now();
  const result = await blackMarket.fulfill(c.env.DB, c.get("accountId"), c.req.param("id"),
    await c.req.json<Record<string, unknown>>().catch(() => ({})), Date.now());
  if (!("ok" in result)) return c.json({ error: result.error }, result.status);
  metric("black_market_fulfill", c.get("accountId"), started, { kind: result.order.kind });
  return c.json(result);
});

app.post("/raid/start", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  await v3EpicBoss.expireLiveEpicBoss(c.env.DB, c.get("accountId"), Date.now());
  const configured = Number(c.env.RAID_COOLDOWN_MS);
  const result = await v3Raid.startRaid(
    c.env.DB,
    c.get("accountId"),
    body,
    Date.now(),
    Number.isFinite(configured) && configured >= 0 ? configured : undefined
  );
  if (result.status === 200) return c.json(result.body);
  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 403) return c.json(result.body, 403);
  if (result.status === 426) return c.json(result.body, 426);
  if (result.status === 429) return c.json(result.body, 429);
  return c.json(result.body, 409);
});

app.post("/raid/finish", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Raid.finishRaid(c.env.DB, c.get("accountId"), body, Date.now());
  if (result.status === 200) return c.json(result.body);
  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 404) return c.json(result.body, 404);
  if (result.status === 422) return c.json(result.body, 422);
  if (result.status === 425) {
    const retryAfterMs = Number(result.body.retryAfterMs ?? 0);
    c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return c.json(result.body, 425);
  }
  return c.json(result.body, 409);
});

app.post("/raid/revive", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Raid.resolveRevival(c.env.DB, c.get("accountId"), body, Date.now());
  if (result.status === 200) return c.json(result.body);
  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 404) return c.json(result.body, 404);
  return c.json(result.body, 409);
});

// ---- Friend invasions (PvP). Under /raid/ so requireAuth + writer fencing apply.
// PARKED behind PVP_ENABLED while the interface is redesigned (docs/FRIEND_INVASIONS.md):
// same shape as the Black Market's opt-in, and the client hides its surfaces behind
// PVP_UI_ENABLED (src/raid/pvp.ts) — flip both to bring it back.
const pvpEnabled = (env: Bindings): boolean => env.PVP_ENABLED === "1";
/** Which defense a friend invasion fights. Exactly one mode is live at a time and the
 *  WORKER decides: it authors the pinned config to match, so no client redeploy is
 *  involved in switching. Unset or unrecognised falls back to the shipped behaviour. */
const pvpDefenseMode = (env: Bindings): PvpDefenseMode =>
  isPvpDefenseMode(env.PVP_DEFENSE_MODE) ? env.PVP_DEFENSE_MODE : PVP_DEFENSE_MODE_DEFAULT;

app.post("/raid/pvp/start", async (c) => {
  if (!pvpEnabled(c.env)) return c.json({ error: "pvp_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Pvp.startPvp(
    c.env.DB, c.get("accountId"), body, Date.now(), pvpDefenseMode(c.env)
  );
  return c.json(result.body, result.status as 200);
});

app.post("/raid/pvp/finish", async (c) => {
  // Deliberately NOT gated on pvpEnabled: a fight started while the flag was on must
  // still be able to settle (and its idempotent result must stay readable) after an
  // operator flips it off — only NEW attacks are refused.
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Pvp.finishPvp(c.env.DB, c.get("accountId"), body, Date.now());
  return c.json(result.body, result.status as 200);
});

app.post("/raid/pvp/collect", async (c) => {
  // Same reasoning: an earned defense reward stays claimable after the switch-off.
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Pvp.collectPvp(c.env.DB, c.get("accountId"), body, Date.now());
  return c.json(result.body, result.status as 200);
});

app.post("/raid/pvp/collect-all", async (c) => {
  // Same reasoning: an earned defense reward stays claimable after the switch-off.
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const result = await v3Pvp.collectAllPvp(c.env.DB, c.get("accountId"), Date.now());
  return c.json(result.body, result.status as 200);
});

app.get("/raid/pvp/history", async (c) => {
  const result = await v3Pvp.historyPvp(c.env.DB, c.get("accountId"), Date.now());
  return c.json(result.body, result.status as 200);
});

app.get("/raid/pvp/replay/:sessionId", async (c) => {
  // Reads a stored recording — stays live when the feature is off, like history.
  const result = await v3Pvp.replayPvp(c.env.DB, c.get("accountId"), c.req.param("sessionId"));
  return c.json(result.body, result.status as 200);
});

app.post("/raid/pvp/defense", async (c) => {
  if (!pvpEnabled(c.env)) return c.json({ error: "pvp_disabled" }, 503);
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Pvp.setDefensePvp(c.env.DB, c.get("accountId"), body, Date.now());
  return c.json(result.body, result.status as 200);
});

app.get("/raid/pvp/defense", async (c) => {
  if (!pvpEnabled(c.env)) return c.json({ error: "pvp_disabled" }, 503);
  const result = await v3Pvp.getDefensePvp(c.env.DB, c.get("accountId"), pvpDefenseMode(c.env));
  return c.json(result.body, result.status as 200);
});

app.post("/raid/pvp/preview", async (c) => {
  if (!pvpEnabled(c.env)) return c.json({ error: "pvp_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3Pvp.previewPvp(
    c.env.DB, c.get("accountId"), body, Date.now(), pvpDefenseMode(c.env)
  );
  return c.json(result.body, result.status as 200);
});

app.post("/epic-boss/activate", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body: { activationId?: unknown; bossId?: unknown } =
    await c.req.json<{ activationId?: unknown; bossId?: unknown }>().catch(() => ({}));
  const activationId = typeof body.activationId === "string" && body.activationId ? body.activationId : crypto.randomUUID();
  const now = Date.now();
  const result = await v3EpicBoss.activate(c.env.DB, c.get("accountId"), activationId, body.bossId, now);
  // serverTime anchors the run's authoritative epochs for the client's clock translation.
  if (result.status === 200) return c.json({ ...result.body, serverTime: now });
  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 403) return c.json(result.body, 403);
  return c.json(result.body, 409);
});

app.post("/epic-boss/end", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body: { runId?: unknown } = await c.req.json<{ runId?: unknown }>().catch(() => ({}));
  const now = Date.now();
  const result = await v3EpicBoss.end(c.env.DB, c.get("accountId"), body.runId, now);
  if (result.status === 200) return c.json({ ...result.body, serverTime: now });
  if (result.status === 400) return c.json(result.body, 400);
  return c.json(result.body, 409);
});

app.post("/epic-boss/start", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body: { orderedUnitIds?: unknown; payment?: unknown; rulesetVersion?: unknown } =
    await c.req.json<{ orderedUnitIds?: unknown; payment?: unknown; rulesetVersion?: unknown }>().catch(() => ({}));
  const now = Date.now();
  await v3Raid.expireLiveRaid(c.env.DB, c.get("accountId"), now);
  const result = await v3EpicBoss.start(
    c.env.DB, c.get("accountId"), body.orderedUnitIds, body.payment, now, body.rulesetVersion
  );
  if (result.status === 200) return c.json({ ...result.body, serverTime: now });
  if (result.status === 400) return c.json(result.body, 400);
  // Not folded into the 409 default: the client's reload prompt is keyed on the status as
  // well as the code, and a 409 reads as "try again", which a stale bundle never can.
  if (result.status === 426) return c.json(result.body, 426);
  if (result.status === 429) return c.json(result.body, 429);
  return c.json(result.body, 409);
});

app.post("/epic-boss/finish", async (c) => {
  if (await mutationsHalted(c)) return c.json({ error: "mutations_disabled" }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const result = await v3EpicBoss.finish(c.env.DB, c.get("accountId"), body, Date.now());
  if (result.status === 200) return c.json(result.body);
  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 404) return c.json(result.body, 404);
  if (result.status === 422) return c.json(result.body, 422);
  return c.json(result.body, 409);
});

// Protocol v2's mutation/read-sync surface is deliberately retired. Keeping the
// explicit response makes stale clients fail closed instead of silently diverging.
const retiredV2 = new Set([
  "/save", "/state", "/economy/sync", "/economy/apply", "/quest/state", "/quest/complete",
  "/farm/actions", "/farm/sync", "/inventory/sync", "/inventory/actions",
  "/object/sync", "/object/actions", "/roster/sync", "/roster/actions",
  "/shop/state", "/shop/size", "/shop/climate", "/storage/sync", "/storage/actions",
  "/raid/state", "/raid/sync", "/raid/checkpoint", "/raid/start-v2-replay-disabled", "/raid/finish-v2-replay-disabled",
]);
app.use("*", async (c, next) => {
  if (retiredV2.has(c.req.path)) return c.json({ error: "update_required", protocolVersion: GAMEPLAY_PROTOCOL }, 410);
  await next();
});

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
  // server balance. `seed` lazily creates the balance row if it doesn't exist yet —
  // gated by the migration cutoff (NOT trusted straight from the blob), so this path
  // can't be used to self-seed an inflated balance. No-op when nothing is pending.
  const seed = await balanceSeed(c.env, accountId, save?.player);
  const applied = await db.reconcilePendingGrants(c.env.DB, accountId, Date.now(), seed);
  if (applied) slog("grants_reconciled", { account: accountId, applied }, "info");
  if (!save) return c.json({ save: null, rev: 0 });
  return c.json({ save: (await seedAllowed(c.env, accountId)) ? save : presentationOnlySave(save), rev: row!.rev });
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
  const stored = (await seedAllowed(c.env, accountId)) ? (save as SaveGame) : presentationOnlySave(save as SaveGame);
  const newRev = await db.casWriteSave(c.env.DB, accountId, JSON.stringify(stored), baseRev, now);
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

// ---- GET /state: all persistent online value in one projection ----------
app.get("/state", async (c) => {
  const accountId = c.get("accountId");
  const now = Date.now();
  const row = await db.getSave(c.env.DB, accountId);
  const layout = row ? presentationOnlySave(JSON.parse(row.blob) as SaveGame) : null;
  const balance = await db.getOrSeedBalance(c.env.DB, accountId, await balanceSeed(c.env, accountId, null));
  balance.brains += await db.creditLevelUps(c.env.DB, accountId, now);
  const inventory = await db.readInventory(c.env.DB, accountId);
  const objectCounts = await db.readObjects(c.env.DB, accountId);
  const rosterRows = await db.readRosterState(c.env.DB, accountId);
  const rosterLayout = new Map((layout?.ownedZombies ?? []).map((z) => [z.id, z]));
  const roster = rosterRows.map((r) => {
    const hint = rosterLayout.get(r.id);
    return {
      id: r.id,
      key: r.key,
      mutation: r.mutation,
      invasions: r.invasions,
      pos: hint?.pos,
      stored: hint?.stored,
      color: hint?.color,
    };
  });
  const remaining = { ...objectCounts };
  const objects = (layout?.objects ?? []).filter((o) => {
    const n = remaining[o.key] ?? 0;
    if (n <= 0) return false;
    remaining[o.key] = n - 1;
    return true;
  });
  const zombieMax = DEFAULT_ARMY_SIZE + objects.reduce((sum, object) => {
    const def = objectCatalog.find((candidate) => candidate.key === object.key);
    return sum + Math.max(0, def?.armyMax ?? 0);
  }, 0);
  const farm = await db.readFarmPlots(c.env.DB, accountId);
  const authoritativePlotKeys = new Set([
    ...farm.plowed.map((p) => `${p.oc}:${p.pr}`),
    ...farm.crops.map((p) => `${p.oc}:${p.pr}`),
  ]);
  const presentationPlots = (layout?.farm.plots ?? []).filter(
    (p) => (p.state === "dirt" || p.state === "hole") && !authoritativePlotKeys.has(`${p.oc}:${p.or}`)
  );
  const plots: SaveGame["farm"]["plots"] = [
    ...presentationPlots,
    ...farm.plowed.map((p) => ({ oc: p.oc, or: p.pr, state: "plowed" as const })),
    ...farm.crops.map((p) => ({
      oc: p.oc,
      or: p.pr,
      state: "planted" as const,
      crop: {
        key: p.crop_key,
        isZombie: !!catalogName(zombieCatalog, p.crop_key),
        plantedAt: p.planted_at,
        growMs: p.grow_ms,
        fertilized: !!p.fertilized,
      },
    })),
  ];
  const storage = await db.readStorage(c.env.DB, accountId);
  const shop = await db.readShopState(c.env.DB, accountId);
  const raids = await db.readRaidProgress(c.env.DB, accountId);
  const lastRaidAt = await db.raidLastAt(c.env.DB, accountId);
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const quests = await db.readQuestState(c.env.DB, accountId);
  const currentBalance = questChanges.some((change) => change.completed)
    ? await db.getOrSeedBalance(c.env.DB, accountId, balance)
    : balance;
  return c.json({
    integrityVersion: 2,
    balance: currentBalance,
    level: levelForXp(currentBalance.xp),
    zombieMax,
    inventory,
    objectCounts,
    objects,
    roster,
    farm: { size: shop.size, plots },
    shop,
    storage,
    raids: { progress: raids, lastRaidAt },
    quests: { ...quests, questChanges },
  });
});

// ---- GET /friends -------------------------------------------------------
app.get("/friends", async (c) => {
  const accountId = c.get("accountId");
  const now = Date.now();
  const [friends, gifted, pending, received] = await Promise.all([
    db.listFriends(c.env.DB, accountId),
    db.giftedRecipientIds(c.env.DB, accountId, dayBucket(now)),
    db.pendingGiftRecipientIds(c.env.DB, accountId),
    db.giftsReceivedFrom(c.env.DB, accountId),
  ]);
  return c.json(
    friends.map((f) => ({
      accountId: f.id,
      name: f.username ?? "Player", // chosen display name only (no PII)
      friendCode: f.friend_code,
      level: levelForXp(f.xp),
      // The head they're WEARING, so the row can show their face. Cosmetic and
      // self-chosen — never the bonus head, which is a gameplay choice of theirs.
      headId: f.head_id ?? undefined,
      // "Can't gift them right now", for either reason. giftPending distinguishes the
      // two so the UI can explain which one is in the way.
      giftOnCooldown: gifted.has(f.id) || pending.has(f.id),
      giftPending: pending.has(f.id) && !gifted.has(f.id),
      // Lifetime gifts THEY sent ME — my own data about my own inbox, so no
      // disclosure about them beyond what they chose to send.
      giftsReceived: received.get(f.id) ?? 0,
      // Coarse bucket only: friendActivity never lets the raw last-online instant
      // off the server (see logic.ts).
      activity: friendActivity(f.last_online_at, now),
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
// stripped v3 projection is returned. Economy, inventory, quest, and social data are
// not exposed; only the read-only world needed by visit mode is materialized.
app.get("/friends/:id/save", async (c) => {
  const me = c.get("accountId");
  const target = c.req.param("id");
  if (!target || target === me) return c.json({ error: "bad_request" }, 400);
  if (!(await db.areFriends(c.env.DB, me, target))) {
    return c.json({ error: "not_friends" }, 403);
  }
  const boot = await v3.bootstrap(c.env.DB, target, Date.now(), false, minProtocolVersion(c.env));
  const targetAccount = await db.accountById(c.env.DB, target);
  const p = boot.presentation.data as {
    farm?: { climate?: string; background?: string; zombiePatchGathered?: boolean };
    objectLayout?: { id: string; key?: string; oc: number; or: number; rotation?: number;
      turn?: number }[];
    rosterLayout?: { id: string; name?: string; pos?: { col: number, row: number }; color?: [number, number, number] }[];
  };
  const objectLayout = new Map((p.objectLayout ?? []).map((o) => [o.id, o]));
  const rosterLayout = new Map((p.rosterLayout ?? []).map((u) => [u.id, u]));
  // Statue occupants only. The rest of the graveyard is this account's private list
  // of its dead and is deliberately not disclosed to a visitor — what a memorial
  // shows is what standing on the farm shows.
  const enshrined = new Map((boot.gameplay.fallen ?? [])
    .filter((unit) => !!unit.memorialObjectId)
    .map((unit) => [unit.memorialObjectId!, unit]));
  const background = p.farm?.background;
  const safeBackground = background === "deep-forest" || background === "woodland" || background === "light-meadow"
    ? background
    : "woodland";
  const activePet = boot.gameplay.activePet;
  const penPets = boot.gameplay.penPets.slice(0, 4);
  const visiblePets = [...new Set([...(activePet ? [activePet] : []), ...penPets])];
  const save: SaveGame = {
    version: 1,
    savedAt: boot.serverTime,
    player: { name: targetAccount?.username ?? "Player", gold: 0, brains: 0, xp: 0,
      zombieMax: boot.gameplay.zombieMax, zombieCount: boot.gameplay.roster.filter((u) => !u.stored).length,
      petCollection: { owned: visiblePets, active: activePet, pen: penPets } },
    farm: {
      fieldId: "default", w: boot.gameplay.farmSize, h: boot.gameplay.farmSize,
      climate: p.farm?.climate ?? "grass",
      background: safeBackground,
      zombiePatchGathered: p.farm?.zombiePatchGathered === true,
      plots: Object.entries(boot.gameplay.farm.plots).map(([key, plot]) => {
        const [oc, or] = key.split(":").map(Number);
        if (plot.state === "plowed") return { oc, or, state: "plowed" as const };
        if (plot.state === "spent") return { oc, or, state: plot.zombie ? "hole" as const : "dirt" as const };
        return { oc, or, state: "planted" as const, crop: { key: plot.cropKey, isZombie: plot.zombie,
          plantedAt: plot.plantedAt, growMs: plot.growMs, fertilized: plot.fertilized } };
      }),
    },
    objects: boot.gameplay.objects.objects.flatMap((obj) => {
      if (obj.status !== "placed") return [];
      const layout = objectLayout.get(obj.instanceId);
      return [{ id: obj.instanceId, key: obj.catalogKey, oc: layout?.oc ?? 0, or: layout?.or ?? 0,
        rotation: layout?.rotation, turn: layout?.turn, readyAt: obj.readyAt,
        // A visitor sees the zombie carved on each Memorial Statue. This comes from
        // the authoritative graveyard rather than the owner's presentation blob,
        // which is the reason the graveyard is server-side at all: the blob is not
        // consulted here, so a client-held occupant would show every visitor a bare
        // plinth — and would let a tampered client display a zombie that never was.
        ...(enshrined.has(obj.instanceId) ? { memorial: enshrined.get(obj.instanceId) } : {}) }];
    }).concat([...objectLayout.values()].flatMap((layout) =>
      layout.key === "storage01" && !boot.gameplay.objects.objects.some((obj) => obj.instanceId === layout.id)
        ? [{ id: layout.id, key: layout.key, oc: layout.oc, or: layout.or,
          rotation: layout.rotation, turn: layout.turn, readyAt: undefined }]
        : [])),
    ownedZombies: boot.gameplay.roster.map((unit) => {
      const layout = rosterLayout.get(unit.id);
      return { id: unit.id, key: unit.key, name: layout?.name, mutation: unit.mutation, invasions: unit.invasions,
        stored: unit.stored, pos: layout?.pos,
        // Authoritative tint first — a traded zombie's colour lives on the roster row,
        // not in the id-keyed layout hint (see migration 0041).
        color: unit.color ?? layout?.color };
    }),
    raids: { completed: boot.gameplay.raids.progress, lastRaidAt: boot.gameplay.raids.lastRaidAt, attackOrder: [] },
  };
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
  // If they already asked me, accept immediately (mutual intent) — but only if the
  // friendship would actually fit. A full list may still RECEIVE: when either of us
  // is at the cap their request simply stays pending in my inbox, to be accepted once
  // room is made. Without this check adding-them-back would be a way around the cap.
  // Still a non-oracle: the response is generic either way, so nothing about their
  // account (or mine) is disclosed here.
  if (await db.requestExists(c.env.DB, other.id, me)) {
    const [mine, theirs] = await Promise.all([
      db.countFriends(c.env.DB, me),
      db.countFriends(c.env.DB, other.id),
    ]);
    if (mine < MAX_FRIENDS && theirs < MAX_FRIENDS) {
      await db.acceptRequest(c.env.DB, me, other.id, Date.now());
    }
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
  // Accepting is what the cap bounds — the request itself was allowed in and stays in
  // the inbox on refusal, so nothing is lost by trying. BOTH sides are checked because
  // acceptRequest writes the friendship in both directions: if the requester filled up
  // while their request sat here, accepting would push THEM past the cap.
  const [mine, theirs] = await Promise.all([
    db.countFriends(c.env.DB, me),
    db.countFriends(c.env.DB, fromAccountId),
  ]);
  if (mine >= MAX_FRIENDS) return c.json({ error: "friends_full" }, 409);
  if (theirs >= MAX_FRIENDS) return c.json({ error: "requester_full" }, 409);
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

// ---- POST /gifts: send a brain (2 free, then 100 gold; +5 XP each) --------
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
  const result = await db.sendGiftWithReward(
    c.env.DB, me, toAccountId, dayBucket(now), now, { ...STARTER_BALANCE }
  );
  if (result.status === "already_gifted_today") {
    return c.json({ error: "already_gifted_today" }, 429);
  }
  if (result.status === "gift_pending") {
    return c.json({ error: "gift_pending" }, 409);
  }
  if (result.status === "insufficient_gold") {
    return c.json({ error: "insufficient_gold" }, 409);
  }
  if (result.status !== "sent") return c.json({ error: "operation_in_progress" }, 409);
  return c.json({
    ok: true,
    xpAwarded: db.GIFT_XP_REWARD,
    giftsSentToday: result.sentToday,
    balance: result.balance,
    accountVersion: result.accountVersion,
    lastRaidAt: result.lastRaidAt,
    serverTime: now,
  });
});

// ---- GET /gifts/inbox ---------------------------------------------------
app.get("/gifts/inbox", async (c) => {
  const gifts = await db.inbox(c.env.DB, c.get("accountId"), MAX_INBOX);
  return c.json(gifts);
});

// ---- POST /gifts/claim: atomically credit the gift's contents (idempotent) ----
// Grant creation, balance credit, and inbox removal commit in one D1 batch. The
// UNIQUE source_gift_id constraint gives concurrent claims exactly one winner.
// Contents were rolled when the gift was SENT; the only open-time decision is the
// once-a-day guaranteed brain (see db.claimGiftReward).
//
app.post("/gifts/claim", async (c) => {
  const { giftId } = await c.req.json<{ giftId: string }>().catch(() => ({ giftId: "" }));
  const me = c.get("accountId");
  const now = Date.now();

  const gift = await db.claimableGift(c.env.DB, giftId, me);
  const respond = async (
    alreadyClaimed: boolean,
    credited: boolean,
    reward: GiftReward | null = null
  ) => {
    const [balance, runtime] = await Promise.all([
      db.getOrSeedBalance(c.env.DB, me, { ...STARTER_BALANCE }),
      c.env.DB.prepare("SELECT account_version FROM account_runtime_v3 WHERE account_id = ?")
        .bind(me).first<{ account_version: number }>(),
    ]);
    return c.json({
      save: null,
      rev: 0,
      alreadyClaimed,
      credited,
      reward,
      balance,
      accountVersion: runtime?.account_version ?? 0,
    });
  };
  if (!gift) return respond(true, false); // already claimed / not mine / unknown

  const grantId = crypto.randomUUID();
  const claim = await db.claimGiftReward(c.env.DB, gift.id, me, grantId, now, { ...STARTER_BALANCE });
  if (!claim.claimed) {
    // A raid/epic/command settlement may temporarily own the account fence. Do not
    // report the gift as claimed when it is still waiting in the inbox.
    if (await db.claimableGift(c.env.DB, gift.id, me)) {
      const runtime = await c.env.DB.prepare(`SELECT active_batch_id, active_batch_expires_at
        FROM account_runtime_v3 WHERE account_id = ?`).bind(me)
        .first<{ active_batch_id: string | null; active_batch_expires_at: number }>();
      slog("gift_claim_deferred", {
        account: me,
        gift: gift.id,
        activeBatch: runtime?.active_batch_id ?? null,
        activeBatchExpiresAt: runtime?.active_batch_expires_at ?? 0,
      }, "warn");
      return c.json({ error: "operation_in_progress" }, 409);
    }
    return respond(true, false);
  }

  return respond(false, true, claim.reward);
});

// ---- raids: server-owned cooldown + one-use sessions --------------------
// The between-raids cooldown is decided HERE, not by the client-authored save, so
// editing the save can't reset it. Whether the player WON is still client-adjudicated
// (real authority needs deterministic replay — a later phase); the session opened here
// is the seam that replay will hang on. What the server DOES own: which raids you may
// invade (level), that only one raid is open at a time, that a session can't be settled
// after it expires, and the reward number itself.
//
// NOTE on the cooldown: skipping it with an Invasion Voucher is a REAL game mechanic
// (earn gold -> buy a ticket -> raid again), so the cooldown is deliberately NOT a hard
// rate limit and must never be turned into one. It bounds nothing on its own; the reward
// ceiling + the unlock gate are what bound a raid's value.
const RAID_COOLDOWN_DEFAULT_MS = 2 * 60 * 60 * 1000; // 2h
const RAID_SESSION_TTL_DEFAULT_MS = 30 * 60 * 1000; // a raid must be settled within 30 min
function raidCooldownMs(env: Bindings): number {
  const n = Number(env.RAID_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : RAID_COOLDOWN_DEFAULT_MS;
}
/** How long a session stays settleable. Env-overridable so tests can observe an expiry;
 *  a non-positive/garbage value falls back to the default rather than disabling the TTL. */
function raidSessionTtlMs(env: Bindings): number {
  const n = Number(env.RAID_SESSION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : RAID_SESSION_TTL_DEFAULT_MS;
}

// GET /raid/state — the client syncs its cooldown display AND its raid progress (lifetime
// wins per raid, which drive ability unlocks) from this authoritative state, on load and
// after a raid.
app.get("/raid/state", async (c) => {
  const me = c.get("accountId");
  const lastRaidAt = await db.raidLastAt(c.env.DB, me);
  const cooldownMs = raidCooldownMs(c.env);
  const remaining = Math.max(0, cooldownMs - (Date.now() - lastRaidAt));
  const progress = await db.readRaidProgress(c.env.DB, me);
  return c.json({ lastRaidAt, cooldownMs, cooldownRemaining: remaining, progress });
});

// POST /raid/sync — one-time import of a migrating save's lifetime raid wins. Without it
// the server would treat a veteran account as having cleared nothing and re-grant every
// first-clear XP award. Cutoff-gated, then guarded by raid_state.progress_seeded; a
// post-cutoff account imports nothing and just reads its authoritative progress.
app.post("/raid/sync", async (c) => {
  const body = await c.req.json<{ completed?: unknown }>().catch(() => ({ completed: {} }));
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const progress = await db.seedRaidProgress(
    c.env.DB,
    c.get("accountId"),
    allow ? body.completed : {},
    Date.now()
  );
  return c.json({ progress });
});

// POST /raid/start — gate on the raid's UNLOCK LEVEL and the server cooldown, reserve
// the account's single open raid, then open a one-use session that PINS the raid being
// fought (raidId) so /raid/finish can price the reward from the server catalog.
// `bypassed` tells the client whether a cooldown was actually skipped (the voucher is
// consumed server-side).
app.post("/raid/start-v2-replay-disabled", async (c) => {
  const body: {
    raidId?: number;
    orderedUnitIds?: unknown;
    useVoucher?: boolean;
    bypass?: boolean;
    concentration?: boolean;
    dice?: number;
    rulesetVersion?: number;
  } = await c.req
    .json<{
      raidId?: number;
      orderedUnitIds?: unknown;
      useVoucher?: boolean;
      bypass?: boolean;
      concentration?: boolean;
      dice?: number;
      rulesetVersion?: number;
    }>()
    .catch(() => ({}));
  if (body.rulesetVersion !== RAID_RULESET_VERSION) {
    return c.json({ ok: false, error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION }, 426);
  }
  const raidId = body.raidId;
  const econ = typeof raidId === "number" ? raidEcon(raidId as number) : undefined;
  if (!econ) return c.json({ ok: false, error: "bad_raid" }, 400);
  const accountId = c.get("accountId");
  const now = Date.now();
  const balance = await db.getOrSeedBalance(c.env.DB, accountId, await balanceSeed(c.env, accountId, null));
  const level = levelForXp(balance.xp);
  if (!raidUnlocked(econ!, level)) {
    return c.json({ ok: false, error: "locked", unlockLevel: econ!.unlockLevel, level }, 403);
  }
  const cooldownMs = raidCooldownMs(c.env);
  const lastRaidAt = await db.raidLastAt(c.env.DB, accountId);
  const remaining = Math.max(0, cooldownMs - (now - lastRaidAt));
  const onCooldown = remaining > 0;
  if (onCooldown && !(body.useVoucher ?? body.bypass)) {
    return c.json({ ok: false, cooldownRemaining: remaining });
  }
  // Minted first: it seeds the wave's own randomness (the Robots' random boss), and the
  // client redraws the same wave from the session id returned below.
  const sessionId = crypto.randomUUID();
  const pinned = await buildPinnedRaid(
    c.env.DB, accountId, raidId!, body.orderedUnitIds, !!body.concentration, sessionId);
  if (!pinned.ok) return c.json({ ok: false, error: pinned.error }, 422);
  const dice = Number.isInteger(body.dice) ? Math.max(0, body.dice as number) : 0;
  const opened = await db.openVerifiedRaidSession(c.env.DB, {
    id: sessionId,
    accountId,
    raidId: raidId!,
    rosterIds: pinned.config.rosterIds,
    configJson: JSON.stringify(pinned.config),
    rulesetVersion: RAID_RULESET_VERSION,
    rngSeed: crypto.randomUUID(),
    useVoucher: onCooldown,
    concentration: !!body.concentration,
    dice,
    startedAt: now,
    expiresAt: now + raidSessionTtlMs(c.env),
  });
  if (!opened) {
    return c.json({ ok: false, error: onCooldown ? "no_consumable_or_raid_in_progress" : "raid_in_progress" }, 409);
  }
  return c.json({
    ok: true,
    sessionId,
    bypassed: onCooldown,
    concentration: !!body.concentration,
    dice,
    rulesetVersion: RAID_RULESET_VERSION,
  });
});

// The benchmark-selected verifier mode: at most 15 seconds of fixed-tick combat is
// replayed per request, then a JSON-safe pure-sim snapshot is CAS-persisted.
app.post("/raid/checkpoint", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 32 * 1024) return c.json({ error: "transcript_too_large" }, 413);
  let body: { sessionId?: string; finalTick?: number; inputs?: RaidReplayInput[] };
  try { body = JSON.parse(raw) as typeof body; } catch { return c.json({ error: "bad_request" }, 400); }
  const accountId = c.get("accountId");
  if (typeof body.sessionId !== "string") return c.json({ error: "bad_request" }, 400);
  const session = await db.verifiedRaidSession(c.env.DB, body.sessionId, accountId);
  if (!session || session.finished_at != null || session.expires_at <= Date.now()) return c.json({ error: "expired_or_closed" }, 409);
  if (session.ruleset_version !== RAID_RULESET_VERSION) return c.json({ error: "stale_ruleset" }, 409);
  const prior = await db.readRaidCheckpoint(c.env.DB, body.sessionId, accountId);
  const startTick = prior?.last_tick ?? 0;
  const finalTick = body.finalTick as number;
  const inputBytes = JSON.stringify(body.inputs ?? []).length;
  const cumulativeInputBytes = (prior?.input_bytes ?? 0) + inputBytes;
  if (cumulativeInputBytes > 32 * 1024) return c.json({ error: "transcript_too_large" }, 413);
  if (!Number.isInteger(finalTick) || finalTick <= startTick || finalTick - startTick > 300) {
    return c.json({ error: "bad_checkpoint_tick" }, 422);
  }
  // A small latency allowance permits the request to arrive just ahead of wall time,
  // while preventing a bot from precomputing/banking an entire raid instantly.
  const pacedTick = Math.floor((Date.now() - session.started_at) / 50) + 40;
  if (finalTick > pacedTick) return c.json({ error: "future_checkpoint" }, 422);
  let config: PinnedRaidConfig;
  let snapshot: BattleSimSnapshot | null = null;
  try {
    config = JSON.parse(session.config_json) as PinnedRaidConfig;
    snapshot = prior ? JSON.parse(prior.state_json) as BattleSimSnapshot : null;
  } catch { return c.json({ error: "bad_session_config" }, 500); }
  const cpuStart = performance.now();
  const verified = verifyRaidSegment(config, snapshot, startTick, finalTick, prior?.last_seq ?? 0, body.inputs ?? [], false);
  const replayCpuMs = performance.now() - cpuStart;
  slog("raid_replay", { account: accountId, sessionId: body.sessionId, checkpoint: true, replayCpuMs, transcriptSize: raw.length }, "info");
  if (!verified.ok) {
    slog("invalid_raid_input", { account: accountId, sessionId: body.sessionId, error: verified.error }, "alert");
    await db.closeInvalidRaidSession(c.env.DB, body.sessionId, accountId, verified.error, Date.now());
    return c.json({ error: verified.error }, 422);
  }
  const stored = await db.storeRaidCheckpoint(
    c.env.DB, body.sessionId, accountId, startTick, finalTick, verified.lastSeq,
    cumulativeInputBytes, JSON.stringify(verified.snapshot), Date.now()
  );
  if (!stored) return c.json({ error: "checkpoint_conflict" }, 409);
  return c.json({ ok: true, finalTick, lastSeq: verified.lastSeq, finished: verified.finished, replayCpuMs });
});

app.post("/raid/start-legacy-disabled", async (c) => {
  return c.json({ error: "client_upgrade_required", integrityVersion: 2 }, 410);
  /* c8 ignore start -- retained temporarily only to make historical diff reviewable */
  const { bypass, raidId, dice } = await c.req
    .json<{ bypass?: boolean; raidId?: number; dice?: number }>()
    .catch(() => ({ bypass: false, raidId: undefined, dice: 0 }));
  // Pin a KNOWN raid so finish can price it; reject an unknown id up front.
  const econ = typeof raidId === "number" ? raidEcon(raidId as number) : undefined;
  if (!econ) return c.json({ ok: false, error: "bad_raid" }, 400);
  const me = c.get("accountId");
  const now = Date.now();
  // Unlock gate from SERVER-owned xp. Without this any account could invade the richest
  // raid at level 1 and — since a fabricated win still pays first-clear XP, and XP buys
  // level-up brains — turn a forged win into premium currency.
  const bal = await db.getOrSeedBalance(c.env.DB, me, await balanceSeed(c.env, me, null));
  const level = levelForXp(bal.xp);
  if (!raidUnlocked(econ!, level)) {
    return c.json({ ok: false, error: "locked", unlockLevel: econ!.unlockLevel, level }, 403);
  }
  const cooldownMs = raidCooldownMs(c.env);
  const lastRaidAt = await db.raidLastAt(c.env.DB, me);
  const remaining = Math.max(0, cooldownMs - (now - lastRaidAt));
  const onCooldown = remaining > 0;
  // On cooldown: only a voucher gets through, and it's consumed SERVER-SIDE (the count
  // is server-owned now), so a modified client can't bypass for free. No voucher held
  // → treated as still on cooldown. Buying a voucher to raid again is intended play.
  let bypassed = false;
  if (onCooldown) {
    if (!bypass) return c.json({ ok: false, cooldownRemaining: remaining });
    const consumed = await db.consumeVoucher(c.env.DB, me);
    if (!consumed) return c.json({ ok: false, cooldownRemaining: remaining, error: "no_voucher" });
    bypassed = true;
  }
  // One open raid per account, reserved ATOMICALLY. The cooldown only starts at finish,
  // so without this a client could bank many session ids in the pre-first-finish window
  // and settle them later for repeated rewards. A voucher was already consumed above if
  // we bypassed, so refund it rather than swallow it when the reserve loses.
  const sessionId = crypto.randomUUID();
  const opened = await db.openRaidSessionOnce(c.env.DB, sessionId, me, raidId as number, now, now + raidSessionTtlMs(c.env));
  if (!opened) {
    if (bypassed) await db.refundVoucher(c.env.DB, me);
    return c.json({ ok: false, error: "raid_in_progress" }, 409);
  }
  // Golden Dice (loot luck) are consumed HERE and pinned to the session, so the server's
  // loot roll at finish uses the real number rather than a client claim. Done after the
  // reserve so a lost race doesn't eat the dice. Spending fewer than asked is fine — the
  // session records what was actually spent.
  const spent = await db.consumeDice(c.env.DB, me, Number(dice) || 0);
  if (spent > 0) await db.setSessionDice(c.env.DB, sessionId, spent);
  return c.json({ ok: true, sessionId, bypassed, dice: spent });
});

// POST /raid/finish — consume the session once, start the cooldown, and credit the
// SERVER-COMPUTED reward for the session's pinned raid (base win gold + first-clear
// XP + the server-rolled loot). Idempotent: a retry credits nothing and echoes the
// current balance/cooldown. An EXPIRED session is refused (`expired: true`) — a raid must
// be settled within its TTL. `win`/`survivalFrac` are client-asserted (deferred: input
// replay), but the server owns the reward number, so a fabricated win can't exceed that
// raid's real payout.
app.post("/raid/finish-v2-replay-disabled", async (c) => {
  const raw = await c.req.text();
  if (raw.length > 32 * 1024) return c.json({ error: "transcript_too_large" }, 413);
  let body: { sessionId?: string; finalTick?: number; inputs?: RaidReplayInput[] };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  const accountId = c.get("accountId");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return c.json({ error: "bad_request" }, 400);
  const session = await db.verifiedRaidSession(c.env.DB, sessionId, accountId);
  if (!session) return c.json({ error: "unknown_session" }, 404);
  if (session.result_json) return c.json(JSON.parse(session.result_json));
  const now = Date.now();
  if (session.finished_at != null || session.expires_at <= now) {
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, "expired_or_closed", now);
    return c.json({ error: "expired_or_closed", expired: session.expires_at <= now }, 409);
  }
  if (session.ruleset_version !== RAID_RULESET_VERSION) {
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, "stale_ruleset", now);
    return c.json({ error: "stale_ruleset" }, 409);
  }
  let config: PinnedRaidConfig;
  try {
    config = JSON.parse(session.config_json) as PinnedRaidConfig;
  } catch {
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, "bad_session_config", now);
    return c.json({ error: "bad_session_config" }, 500);
  }
  const checkpoint = await db.readRaidCheckpoint(c.env.DB, sessionId, accountId);
  if ((checkpoint?.input_bytes ?? 0) + JSON.stringify(body.inputs ?? []).length > 32 * 1024) {
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, "transcript_too_large", now);
    return c.json({ error: "transcript_too_large" }, 413);
  }
  let checkpointSnapshot: BattleSimSnapshot | null = null;
  try { checkpointSnapshot = checkpoint ? JSON.parse(checkpoint.state_json) as BattleSimSnapshot : null; }
  catch { return c.json({ error: "bad_checkpoint" }, 500); }
  const cpuStart = performance.now();
  const verified = verifyRaidSegment(
    config,
    checkpointSnapshot,
    checkpoint?.last_tick ?? 0,
    body.finalTick as number,
    checkpoint?.last_seq ?? 0,
    body.inputs as RaidReplayInput[],
    true
  );
  const replayCpuMs = performance.now() - cpuStart;
  const transcriptSize = raw.length;
  slog("raid_replay", { account: accountId, sessionId, replayCpuMs, transcriptSize }, "info");
  if (!verified.ok) {
    slog("invalid_raid_input", { account: accountId, sessionId, error: verified.error, replayCpuMs, transcriptSize }, "alert");
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, verified.error, now);
    return c.json({ error: verified.error }, 422);
  }
  if (!verified.finished || !verified.outcome) {
    await db.closeInvalidRaidSession(c.env.DB, sessionId, accountId, "truncated_transcript", now);
    return c.json({ error: "truncated_transcript" }, 422);
  }
  const survivalFrac = config.rosterIds.length
    ? verified.outcome.survivors.length / config.rosterIds.length
    : 0;
  const settled = await db.settleRaid(
    c.env.DB,
    sessionId,
    accountId,
    verified.outcome.win,
    survivalFrac,
    now
  );
  const brains = verified.outcome.win
    ? await db.grantVerifiedRaidBrains(
        c.env.DB,
        accountId,
        sessionId,
        raidEcon(config.raidId)?.recLevel ?? 0,
        session.rng_seed,
        now
      )
    : 0;
  if (brains > 0) {
    settled.balance = await db.getOrSeedBalance(c.env.DB, accountId, settled.balance);
  }
  const questEvents: db.TrustedGameEvent[] = [];
  if (verified.outcome.win) {
    questEvents.push({
      id: `raid:${sessionId}:success`,
      type: "kInvasionSuccessfulNotification",
      subject: config.raidName,
    });
    if (verified.outcome.losses.length === 0) {
      questEvents.push({
        id: `raid:${sessionId}:perfect`,
        type: "kInvasionPerfectGameNotification",
        subject: config.raidName,
      });
    }
    if (settled.loot?.name) {
      questEvents.push({
        id: `raid:${sessionId}:loot`,
        type: "kLootItemWonNotification",
        subject: settled.loot.name,
      });
    }
  }
  await db.recordTrustedGameEvents(c.env.DB, accountId, questEvents, now);
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const result = {
    ...settled,
    brains,
    outcome: verified.outcome,
    replayCpuMs,
    questChanges,
    rulesetVersion: RAID_RULESET_VERSION,
  };
  await db.commitVerifiedRaidRoster(
    c.env.DB,
    sessionId,
    accountId,
    verified.outcome.survivors,
    verified.outcome.losses,
    JSON.stringify(result)
  );
  return c.json(result);
});

app.post("/raid/finish-legacy-disabled", async (c) => {
  return c.json({ error: "client_upgrade_required", integrityVersion: 2 }, 410);
  /* c8 ignore start -- retained temporarily only to make historical diff reviewable */
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
    typeof survivalFrac === "number" ? (survivalFrac as number) : 0,
    Date.now()
  );
  return c.json({
    lastRaidAt: r.lastRaidAt,
    balance: r.balance,
    gold: r.gold,
    xp: r.xp,
    firstClear: r.firstClear,
    expired: !!r.expired,
    loot: r.loot ?? null,
  });
});

// ---- item storage: the Received bucket + the shed ------------------------
// POST /storage/sync — one-time import of a migrating save's Received + shed items.
// Cutoff-gated, then guarded by farm_state.storage_seeded. Raid loot lands in `received`
// server-side now, and the loot roll reads these to answer "do you already own one?".
app.post("/storage/sync", async (c) => {
  const body = await c.req
    .json<{ received?: unknown; stored?: unknown }>()
    .catch(() => ({ received: [], stored: [] }));
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const storage = await db.seedStorage(
    c.env.DB,
    c.get("accountId"),
    allow ? body.received : [],
    allow ? body.stored : []
  );
  return c.json(storage);
});

// POST /storage/actions — MOVES, never grants: claim a Received item into the boost or
// placeable it represents, or pack an owned object into the shed / take it back out.
// Every action spends something the server already recorded you owning.
app.post("/storage/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 256) return c.json({ error: "too_many_actions" }, 413);
  const r = await db.applyStorageActions(c.env.DB, c.get("accountId"), raw as StorageAction[], Date.now());
  const rejected = r.results.filter((x) => x.status === "rejected").length;
  if (rejected) slog("storage_rejected", { account: c.get("accountId"), rejected });
  return c.json(r);
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
  // Only a migration-eligible account may seed from its declared currency; everyone
  // else (new accounts, post-window) gets fixed starter defaults. getOrSeedBalance
  // is INSERT-OR-IGNORE, so an already-seeded balance is preserved either way.
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const s = body.seed ?? {};
  const seed = allow
    ? { gold: s.gold ?? 0, brains: s.brains ?? 0, xp: s.xp ?? 0 }
    : { ...STARTER_BALANCE };
  const balance = await db.getOrSeedBalance(c.env.DB, c.get("accountId"), seed);
  // Catch up any owed level-up brains (and initialize the sentinel for legacy rows) —
  // level is derived from server xp, so this is authoritative and needs no client input.
  balance.brains += await db.creditLevelUps(c.env.DB, c.get("accountId"), Date.now());
  return c.json(balance);
});

app.post("/economy/apply", async (c) => {
  const body = await c.req
    .json<{ events?: unknown }>()
    .catch(() => ({ events: [] }));
  const raw = Array.isArray(body.events) ? body.events : [];
  if (raw.length > 32) return c.json({ error: "too_many_events" }, 413);
  if (!(await commandVolumeAllowed(c.env, c.get("accountId"), raw.length, Date.now()))) {
    return c.json({ error: "command_volume_exceeded" }, 429);
  }
  // Coerce to the event shape; economy.validateEvent rejects anything malformed.
  const events = raw as EconomyEvent[];
  const { balance, results } = await db.applyEvents(c.env.DB, c.get("accountId"), events);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("economy_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, results });
});

// ---- quests: server-authoritative, bounded-once rewards -----------------
// A completed quest grants its reward from the SERVER catalog (never a client amount),
// at most once per (account, quest). Currency rewards hit the balance (and trigger any
// owed level-up); item/zombie rewards are recorded but deferred to Phase D. The client
// still decides WHEN a quest completes (requirement proof is deferred), so the reward is
// bounded-once, not yet proven-earned — a claimed quest yields at most its real payout.
app.get("/quest/state", async (c) => {
  const accountId = c.get("accountId");
  const now = Date.now();
  if (await seedAllowed(c.env, accountId)) {
    const row = await db.getSave(c.env.DB, accountId);
    const save = row ? (JSON.parse(row.blob) as SaveGame) : null;
    await db.seedLegacyQuestCompletions(c.env.DB, accountId, save?.quests?.completed ?? [], now);
  } else {
    await db.seedLegacyQuestCompletions(c.env.DB, accountId, [], now);
  }
  return c.json({ ...(await db.readQuestState(c.env.DB, accountId)), questChanges: [] });
});

app.post("/quest/complete", async (c) => {
  const { questId } = await c.req
    .json<{ questId: string }>()
    .catch(() => ({ questId: "" }));
  if (typeof questId !== "string" || !questId || questId.length > 32) {
    return c.json({ error: "bad_request" }, 400);
  }
  const result = await db.completeQuest(c.env.DB, c.get("accountId"), questId, Date.now());
  if (result.status === "rejected") {
    slog("quest_rejected", { account: c.get("accountId"), questId, error: result.error });
  }
  return c.json(result);
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
  if (raw.length > 64) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as FarmAction[];
  const now = Date.now();
  const accountId = c.get("accountId");
  if (!(await commandVolumeAllowed(c.env, accountId, actions.length, now))) {
    return c.json({ error: "command_volume_exceeded" }, 429);
  }
  const { balance, results } = await db.applyFarmActions(c.env.DB, accountId, actions, now);
  const farm = await db.readFarmPlots(c.env.DB, accountId);
  await db.recordTrustedGameEvents(c.env.DB, accountId, farmQuestEvents(actions, results), now);
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("farm_rejected", { account: c.get("accountId"), rejected });
  const authoritativeBalance = questChanges.some((change) => change.completed)
    ? await db.getOrSeedBalance(c.env.DB, accountId, balance)
    : balance;
  return c.json({ balance: authoritativeBalance, results, farm, questChanges });
});

// ---- POST /farm/sync: one-time import of already-plowed soil -------------
// A migrating player's tilled-but-unplanted soil exists only in their save. Import it
// once (cutoff-gated, then guarded by farm_state.soil_seeded) so plants there aren't
// rejected as `not_plowed` on soil their client won't let them re-till. A post-cutoff
// account imports nothing and simply reads its authoritative set.
app.post("/farm/sync", async (c) => {
  const body = await c.req.json<{ plowed?: unknown }>().catch(() => ({ plowed: [] }));
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const plowed = await db.seedPlowedSoil(
    c.env.DB,
    c.get("accountId"),
    allow ? body.plowed : [],
    Date.now()
  );
  return c.json({ plowed });
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
  // Import boost counts only for a migration-eligible account; otherwise ignore the
  // declared counts (seedInventory is itself seed-once-if-empty as defense in depth).
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const inventory = await db.seedInventory(c.env.DB, c.get("accountId"), allow ? counts : {});
  return c.json({ inventory });
});

app.post("/inventory/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 32) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as InventoryAction[];
  const now = Date.now();
  const accountId = c.get("accountId");
  if (!(await commandVolumeAllowed(c.env, accountId, actions.length, now))) {
    return c.json({ error: "command_volume_exceeded" }, 429);
  }
  const { balance, inventory, results, farm } = await db.applyInventoryActions(
    c.env.DB,
    accountId,
    actions,
    now
  );
  const byId = new Map(actions.map((a) => [a?.id, a]));
  await db.recordTrustedGameEvents(
    c.env.DB,
    accountId,
    results
      .filter((r) => r.status === "applied" && byId.get(r.id)?.type === "buy")
      .map((r) => {
        const a = byId.get(r.id)!;
        return {
          id: `inventory:${r.id}:buy`,
          type: "kItemBoughtNotification",
          subject: catalogName(boostCatalog, a.key),
        };
      }),
    now
  );
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("inventory_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, inventory, results, farm, questChanges });
});

// ---- objects: server-owned placeable ownership (counts) -----------------
// Object OWNERSHIP is server-authoritative (a count per key); placement/position stays
// client-side layout. A buy debits the exact catalog cost + grants buyXp; a refund
// credits floor(cost*0.2) only for an object you actually own — so a client can't
// fabricate a placeable or refund one it never bought. Seed once from the save.
app.post("/object/sync", async (c) => {
  const body = await c.req
    .json<{ counts?: Record<string, unknown> }>()
    .catch(() => ({ counts: {} }));
  const counts: Record<string, unknown> =
    body.counts && typeof body.counts === "object" ? (body.counts as Record<string, unknown>) : {};
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const objects = await db.seedObjects(c.env.DB, c.get("accountId"), allow ? counts : {});
  return c.json({ objects });
});

app.post("/object/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 32) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as ObjectAction[];
  const now = Date.now();
  const accountId = c.get("accountId");
  if (!(await commandVolumeAllowed(c.env, accountId, actions.length, now))) {
    return c.json({ error: "command_volume_exceeded" }, 429);
  }
  const { balance, objects, results } = await db.applyObjectActions(
    c.env.DB,
    accountId,
    actions,
    now
  );
  const byId = new Map(actions.map((a) => [a?.id, a]));
  await db.recordTrustedGameEvents(
    c.env.DB,
    accountId,
    results
      .filter((r) => r.status === "applied")
      .flatMap((r) => {
        const a = byId.get(r.id);
        if (!a || (a.type !== "buy" && a.type !== "upgrade")) return [];
        const key = a.type === "buy" ? a.key : a.toKey;
        return [{ id: `object:${r.id}:buy`, type: "kItemBoughtNotification", subject: catalogName(objectCatalog, key) }];
      }),
    now
  );
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("object_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, objects, results, questChanges });
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
  // Seed farm size + climates from the save only for a migration-eligible account;
  // otherwise seed base size + no skins (getOrSeedShopState only seeds on first init).
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const state = await db.getOrSeedShopState(
    c.env.DB,
    c.get("accountId"),
    allow && typeof body.size === "number" ? body.size : DEFAULT_FARM_SIZE,
    allow ? body.climates : []
  );
  return c.json(state);
});

app.post("/shop/size", async (c) => {
  const body = await c.req.json<{ actionId?: string; size?: number; currency?: string }>().catch(() => ({ actionId: "", size: undefined, currency: "gold" }));
  const currency = body.currency === "brains" ? "brains" : "gold";
  if (typeof body.actionId !== "string" || !body.actionId || typeof body.size !== "number") return c.json({ error: "bad_request" }, 400);
  const r = await db.buySize(c.env.DB, c.get("accountId"), body.actionId, body.size, currency, Date.now());
  if (!r.ok) slog("shop_rejected", { account: c.get("accountId"), kind: "size", error: r.error });
  return c.json(r);
});

app.post("/shop/climate", async (c) => {
  const body = await c.req.json<{ actionId?: string; terrain?: string }>().catch(() => ({ actionId: "", terrain: "" }));
  if (typeof body.actionId !== "string" || !body.actionId || typeof body.terrain !== "string" || !body.terrain) return c.json({ error: "bad_request" }, 400);
  const r = await db.buyClimate(c.env.DB, c.get("accountId"), body.actionId, body.terrain, Date.now());
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
  // Import save units only for a migration-eligible account; otherwise ignore them
  // (seedRoster is itself seed-once-if-empty as defense in depth). This closes the
  // repeat-sync re-injection door — units can't be added then sold for gold.
  const allow = await seedAllowed(c.env, c.get("accountId"));
  const count = await db.seedRoster(c.env.DB, c.get("accountId"), allow ? body.units : []);
  return c.json({ count });
});

app.post("/roster/actions", async (c) => {
  const body = await c.req.json<{ actions?: unknown }>().catch(() => ({ actions: [] }));
  const raw = Array.isArray(body.actions) ? body.actions : [];
  if (raw.length > 32) return c.json({ error: "too_many_actions" }, 413);
  const actions = raw as RosterAction[];
  const now = Date.now();
  const accountId = c.get("accountId");
  if (!(await commandVolumeAllowed(c.env, accountId, actions.length, now))) {
    return c.json({ error: "command_volume_exceeded" }, 429);
  }
  const { balance, results } = await db.applyRosterActions(c.env.DB, accountId, actions, now);
  const byId = new Map(actions.map((a) => [a?.id, a]));
  await db.recordTrustedGameEvents(
    c.env.DB,
    accountId,
    results
      .filter((r) => r.status === "applied" && !!r.subject)
      .flatMap((r) => {
        const a = byId.get(r.id);
        if (!a) return [];
        if (a.type === "combineCollect") {
          // No kCombinerHarvestedNotification here: that event now means "the Pot
          // produced a species neither parent was" (isCombinePromotion), and this
          // legacy path only accepts a result that IS one of the two parent keys —
          // so a promotion cannot reach it. The v3 combine command emits it.
          return [
            { id: `roster:${r.id}:combine`, type: "kCombinerCombinedNotification", subject: r.combinedSubject ?? "" },
          ];
        }
        return [];
      }),
    now
  );
  const questChanges = await db.processQuestEvents(c.env.DB, accountId, now);
  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) slog("roster_rejected", { account: c.get("accountId"), rejected });
  return c.json({ balance, results, questChanges });
});

// ---- scheduled cleanup (cron; see wrangler.toml [triggers]) -------------
const DAY = 24 * 60 * 60 * 1000;
async function runCleanup(env: Bindings, now: number): Promise<void> {
  const sessions = await db.purgeDeadSessions(env.DB, now - DAY, now - 8 * DAY);
  const buckets = await db.purgeOldRateBuckets(env.DB, now - 60 * 60 * 1000);
  const requests = await db.purgeOldFriendRequests(env.DB, now - 30 * DAY);
  const raidSessions = await env.DB.prepare(
    "DELETE FROM raid_sessions_v3 WHERE finished_at IS NOT NULL AND finished_at < ?"
  ).bind(now - 30 * DAY).run();
  // v3 intentionally keeps premium, purchase/refund, zombie-lifecycle, and raid audit
  // events durable. Routine crop receipts no longer exist and therefore need no purge.
  slog("cleanup", { sessions, buckets, requests, raidSessions: raidSessions.meta.changes ?? 0 }, "info");
}

// Export both the HTTP handler and the cron handler. Cloudflare calls `scheduled`
// on the wrangler.toml cron; everything else is the Hono app.
export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    ctx.waitUntil(runCleanup(env, Date.now()));
  },
};
