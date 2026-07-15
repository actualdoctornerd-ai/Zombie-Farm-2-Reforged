import { describe, expect, it } from "vitest";
import { call, signIn } from "./helpers";

async function startedRaid() {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
  await call("POST", "/roster/sync", s.token, { units: [{ id: "z1", key: "ZombieActorRegularTier1" }] });
  const start = await call<{ sessionId: string }>("POST", "/raid/start", s.token, {
    raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 2,
  });
  return { s, sessionId: start.body.sessionId };
}

describe("raid transcript validation", () => {
  it("CAS-persists a verifier checkpoint and finishes from that snapshot", async () => {
    const { s, sessionId } = await startedRaid();
    const checkpoint = await call<{ ok: boolean }>("POST", "/raid/checkpoint", s.token, {
      sessionId, finalTick: 1, inputs: [],
    });
    expect(checkpoint).toMatchObject({ status: 200, body: { ok: true } });
    const finish = await call<{ outcome: { win: boolean } }>("POST", "/raid/finish", s.token, {
      sessionId, finalTick: 2, inputs: [{ seq: 1, tick: 2, type: "retreat" }],
    });
    expect(finish).toMatchObject({ status: 200, body: { outcome: { win: false } } });
  });

  it("rejects reordered sequences and closes the session without value", async () => {
    const { s, sessionId } = await startedRaid();
    const bad = await call<{ error: string }>("POST", "/raid/finish", s.token, {
      sessionId, finalTick: 1, inputs: [{ seq: 2, tick: 0, type: "retreat" }],
    });
    expect(bad).toMatchObject({ status: 422, body: { error: "bad_sequence" } });
    const retry = await call<{ error: string }>("POST", "/raid/finish", s.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    expect(retry.status).toBe(409);
  });

  it("rejects future input ticks", async () => {
    const { s, sessionId } = await startedRaid();
    const bad = await call<{ error: string }>("POST", "/raid/finish", s.token, {
      sessionId, finalTick: 1, inputs: [{ seq: 1, tick: 2, type: "retreat" }],
    });
    expect(bad.body.error).toBe("bad_input_tick");
  });
});
