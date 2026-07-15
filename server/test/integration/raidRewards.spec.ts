import { describe, expect, it } from "vitest";
import { call, grantRoster, signIn } from "./helpers";

describe("raid finish — replay-derived and idempotent", () => {
  it("never accepts client outcome or reward claims", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    await grantRoster(s, [{ id: "z1", key: "ZombieActorRegularTier1" }]);
    const start = await call<{ sessionId: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 3,
    });
    const forged = await call<{ error: string }>("POST", "/raid/finish", s.token, {
      sessionId: start.body.sessionId, win: true, gold: 999999, xp: 999999,
    });
    expect(forged.status).toBe(422);
    expect(forged.body.error).toBe("bad_final_tick");
    const balance = await call<{ gold: number; xp: number }>("POST", "/economy/sync", s.token, { seed: {} });
    expect(balance.body).toMatchObject({ gold: 0, xp: 0 });
  });

  it("stores a verified retreat result and returns it unchanged on retry", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    await grantRoster(s, [{ id: "z1", key: "ZombieActorRegularTier1" }]);
    const start = await call<{ sessionId: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 3,
    });
    const body = { sessionId: start.body.sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }] };
    const first = await call<Record<string, unknown>>("POST", "/raid/finish", s.token, body);
    const retry = await call<Record<string, unknown>>("POST", "/raid/finish", s.token, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: { win: false }, gold: 0, xp: 0 });
    expect(retry.body).toEqual(first.body);
  });
});
