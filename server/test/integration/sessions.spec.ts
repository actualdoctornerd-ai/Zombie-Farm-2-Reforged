import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, type Session } from "./helpers";

// Device/session management (P8): GET /session/list, POST /session/revoke, and the
// account-scoping + current-session guards. Two sign-ins with the SAME devSub map to
// one account with two sessions — that's how we get a second device to manage.

interface ListRes {
  sessions: { id: string; label: string | null; lastUsedAt: number; current: boolean }[];
}

describe("session/device management", () => {
  // One 2-session account exercises list, the current flag, remote revoke, and the
  // self/unknown-id guards — minimizing sign-ins (the /auth limiter is per-IP and the
  // whole shared-IP suite runs inside one rate-limit window).
  it("lists devices, revokes another one, and guards self/unknown ids", async () => {
    const sub = uniqueSub("dev");
    const a = await signIn(sub);
    const b = await signIn(sub); // a second device for the SAME account

    // List shows both, with exactly one marked as the caller's current session.
    const list = await call<ListRes>("GET", "/session/list", a.token);
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.body.sessions.filter((s) => s.current)).toHaveLength(1);

    // Can't revoke the current session (that's what logout is for) or an unknown id.
    const mine = list.body.sessions.find((s) => s.current)!;
    expect((await call("POST", "/session/revoke", a.token, { sessionId: mine.id })).status).toBe(400);
    expect((await call("POST", "/session/revoke", a.token, { sessionId: "nope" })).status).toBe(404);

    // Revoking the OTHER device kills b's token immediately; a keeps working.
    const other = list.body.sessions.find((s) => !s.current)!;
    expect((await call("GET", "/me", b.token)).status).toBe(200); // alive before
    expect((await call("POST", "/session/revoke", a.token, { sessionId: other.id })).status).toBe(200);
    expect((await call("GET", "/me", b.token)).status).toBe(401); // dead after
    expect((await call("GET", "/me", a.token)).status).toBe(200);
  });

  it("won't let one account revoke another account's session", async () => {
    const a = await signIn();
    const victim = await signIn();
    const vList = await call<ListRes>("GET", "/session/list", victim.token);
    const vSession = vList.body.sessions.find((s) => s.current)!;

    // a tries to revoke victim's session by id → 404 (account-scoped); victim unaffected.
    const attack = await call("POST", "/session/revoke", a.token, { sessionId: vSession.id });
    expect(attack.status).toBe(404);
    expect((await call("GET", "/me", victim.token)).status).toBe(200);
  });
});
