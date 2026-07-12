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
}

/** Per-request context we attach after auth: the caller's account id. */
export interface Vars {
  accountId: string;
}

// The client's save blob is opaque to the server EXCEPT player.brains, which a
// gift claim credits. We type-import the real shape (erased at build — no client
// runtime is pulled in) so that one coupling point can't drift.
export type { SaveGame } from "../../src/save/schema";
