import { describe, it, expect } from "vitest";
import { call, signIn } from "./helpers";

// Harness smoke test: confirms globalSetup booted the Worker + D1 and dev auth
// works. If this is green the rest of the suite can run.
describe("harness", () => {
  it("serves the root", async () => {
    const r = await call<{ ok: boolean }>("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("rejects unauthenticated account access", async () => {
    expect((await call("GET", "/me")).status).toBe(401);
  });

  it("signs in via dev auth and returns /me", async () => {
    const s = await signIn();
    expect(s.token).toBeTruthy();
    const me = await call<{ accountId: string }>("GET", "/me", s.token);
    expect(me.status).toBe(200);
    expect(me.body.accountId).toBe(s.accountId);
  });
});
