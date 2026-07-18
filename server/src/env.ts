/** Cloudflare Rate Limiting binding (configured in wrangler.toml). `limit()` is a
 *  fast, globally-consistent-enough counter that does NOT touch D1 — the cheap way
 *  to throttle ordinary traffic on the free tier. Optional: absent in local dev and
 *  offline builds, where the middleware falls back to a D1 counter. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Worker bindings (D1 + config). Wrangler injects these as the second arg to the
// fetch handler; Hono exposes them as `c.env`.
export interface Bindings {
  DB: D1Database;
  /** OAuth 2.0 Web client id — the audience we require on Google ID tokens. */
  GOOGLE_CLIENT_ID: string;
  /** HMAC secret for signing our own session JWTs (a Worker secret). */
  SESSION_SECRET: string;
  /** Origin allowed by CORS (the Pages site). */
  ALLOWED_ORIGIN: string;
  /** "1" enables the no-Google dev sign-in path. MUST be unset/"0" in prod. */
  DEV_AUTH?: string;
  /** Server-owned between-raids cooldown in ms (string var). Defaults to 2h when
   *  unset. Set small in .dev.vars (e.g. "60000") so local play isn't gated.
   *  NOTE: skipping this with an Invasion Voucher is intended play, so it is NOT a rate
   *  limit and must never be used as one. */
  RAID_COOLDOWN_MS?: string;
  /** How long a raid session stays settleable, in ms (string var). Defaults to 30 min.
   *  A finish after this is refused, so a session can't be banked and cashed in later.
   *  Set short in .dev.vars so the integration suite can actually observe an expiry. */
  RAID_SESSION_TTL_MS?: string;
  /** Save-import cutoff (epoch ms, string var). An account may import its pre-existing
   *  save (currency/roster/boosts/farm) into server-owned state ONLY if it was created
   *  before this instant, and only once per subsystem. Accounts created at/after it —
   *  and every account when this is unset/0 — get fixed SERVER DEFAULTS instead and can
   *  never self-declare a starting balance. Set to the migration-window end in prod;
   *  set far-future in .dev.vars so local/integration accounts can seed. Default 0 =
   *  no imports (most secure). See SECURITY.md own-account plan, item 2/5. */
  MIGRATION_CUTOFF_MS?: string;
  /** Epoch ms after which mutation clients must send X-Integrity-Version: 2. */
  INTEGRITY_V2_ENFORCE_AFTER_MS?: string;
  /** Protocol-v3 operational controls. Raising the minimum rejects old builds;
   * setting MUTATIONS_DISABLED=1 leaves bootstrap/read paths available while
   * stopping all economy mutations during an incident or maintenance window. */
  MIN_PROTOCOL_VERSION?: string;
  MUTATIONS_DISABLED?: string;
  /** Cross-account trading remains opt-in until the protocol-v3 security gates are met. */
  BLACK_MARKET_ENABLED?: string;
  /** Exclusive-writer rollout: observe accepts legacy clients; enforce requires the
   * authenticated writer credential on every gameplay mutation. */
  WRITER_LEASE_MODE?: "observe" | "enforce";
  /** Rate-limit tiers (optional; see wrangler.toml). Tight for sign-in, moderate
   *  for writes, loose for reads. When unset the middleware uses the D1 fallback. */
  RL_AUTH?: RateLimiter;
  RL_WRITE?: RateLimiter;
  RL_READ?: RateLimiter;
  /** Optional per-tier overrides for the D1-fallback limit (local/degraded mode only;
   *  prod uses the CF binding above, so these never apply in prod). Set e.g.
   *  RL_AUTH_MAX="100000" in .dev.vars so the integration suite's many isolated sign-ins
   *  from one IP aren't throttled. Unset → the middleware's coded fallback is used. */
  RL_AUTH_MAX?: string;
  RL_WRITE_MAX?: string;
  RL_READ_MAX?: string;
}

/** Per-request context we attach after auth: the caller's account id and the
 *  revocable session the token belongs to (so /logout can revoke exactly it). */
export interface Vars {
  accountId: string;
  sessionId: string;
}

// The client's save blob is opaque to the server EXCEPT player.brains, which a
// gift claim credits. We type-import the real shape (erased at build — no client
// runtime is pulled in) so that one coupling point can't drift.
export type { SaveGame } from "../../src/save/schema";
