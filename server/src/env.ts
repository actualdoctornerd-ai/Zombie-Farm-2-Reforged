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
  /** Protocol-v3 operational controls. Raising the minimum rejects old builds;
   * setting MUTATIONS_DISABLED=1 leaves bootstrap/read paths available while
   * stopping all economy mutations during an incident or maintenance window. */
  MIN_PROTOCOL_VERSION?: string;
  MUTATIONS_DISABLED?: string;
  /** Cross-account trading remains opt-in until the protocol-v3 security gates are met. */
  BLACK_MARKET_ENABLED?: string;
  /** Friend invasions (PvP). Fully built and verified, PARKED ("0") while the interface
   *  is redesigned — see docs/FRIEND_INVASIONS.md for the feature and how to re-enable. */
  PVP_ENABLED?: string;
  /** Which defense a friend invasion fights: "classic" (the shipped wave out of the
   *  barn doorway) or "formation" (one zombie per class, each with a job and a
   *  station). Exactly one is live at a time; the Worker AUTHORS the pinned config to
   *  match, so the client fights whatever it is handed. See src/raid/pvp.ts and
   *  docs/PVP_DEFENSE_FORMATION.md. Unset = "classic". */
  PVP_DEFENSE_MODE?: string;
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
