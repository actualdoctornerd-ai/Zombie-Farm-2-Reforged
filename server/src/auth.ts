// Identity: verify a Google ID token once at sign-in, then issue and verify our
// own short session JWT for every subsequent request. Both use `jose`, which runs
// on the Worker's Web Crypto — no Node APIs.
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";

// Google's public signing keys (JWKS). createRemoteJWKSet caches + refreshes them,
// so verification is a local signature check after the first fetch.
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export interface GoogleIdentity {
  sub: string; // stable Google user id (pseudonymous; never exposed by the API)
}

/** Verify a Google ID token: signature (against Google's JWKS), issuer, and that
 *  the audience is OUR client id (prevents replaying a token minted for another
 *  app). Throws if invalid.
 *
 *  PII policy: the token also carries the user's email + display name, but we
 *  deliberately read ONLY `sub` and discard the rest — no personal data is ever
 *  stored or returned. The `sub` is an opaque per-user id used solely to match a
 *  returning login to their account; it's never sent to any client. */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience: clientId,
  });
  const sub = payload.sub;
  if (!sub) throw new Error("google token missing sub");
  return { sub };
}

// Shorter than the old 30d. The access token is now backed by a server-side
// session row (sessions table): sign-out, "log out everywhere", or a leaked token
// can be revoked immediately, and a live session is renewed via /session/refresh.
// TTL bounds the damage of a token whose session revocation somehow can't be
// reached; the DB check is the real control.
const SESSION_TTL = "7d";

/** Identity carried by our access token: the account and the revocable session it
 *  belongs to. The middleware still checks `sid` against the sessions table so a
 *  revoked session's token stops working before it expires. */
export interface SessionClaims {
  accountId: string;
  sessionId: string;
}

/** Mint an access-token JWT carrying our account id (sub) and session id (sid),
 *  HS256-signed with SESSION_SECRET. */
export async function mintSession(
  accountId: string,
  sessionId: string,
  secret: string
): Promise<string> {
  return new SignJWT({ sub: accountId, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(new TextEncoder().encode(secret));
}

/** Verify an access token's signature/expiry and return its claims, or null. This
 *  is only the cryptographic check — the caller must still confirm the session is
 *  not revoked (db.sessionAccount). */
export async function verifySession(
  token: string,
  secret: string
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    const accountId = payload.sub as string | undefined;
    const sessionId = payload.sid as string | undefined;
    if (!accountId || !sessionId) return null;
    return { accountId, sessionId };
  } catch {
    return null;
  }
}
