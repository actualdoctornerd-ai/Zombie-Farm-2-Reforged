import { describe, expect, it } from "vitest";
import { call, grantRoster, signIn } from "./helpers";

async function raidPlayer() {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
  await grantRoster(s, [{ id: "z1", key: "ZombieActorRegularTier1" }]);
  return s;
}

describe("raid start — pinned server state", () => {
  it("requires the current ruleset and an owned, unique roster", async () => {
    const s = await raidPlayer();
    const stale = await call<{ error: string }>("POST", "/raid/start", s.token, { raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 1 });
    expect(stale).toMatchObject({ status: 426, body: { error: "stale_ruleset" } });
    const foreign = await call<{ error: string }>("POST", "/raid/start", s.token, { raidId: 1, orderedUnitIds: ["not-owned"], rulesetVersion: 6 });
    expect(foreign.body.error).toBe("unit_not_owned");
    const duplicate = await call<{ error: string }>("POST", "/raid/start", s.token, { raidId: 1, orderedUnitIds: ["z1", "z1"], rulesetVersion: 6 });
    expect(duplicate.body.error).toBe("bad_roster");
  });

  it("locks participating units until the verified raid closes", async () => {
    const s = await raidPlayer();
    const started = await call<{ ok: boolean; sessionId: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 6,
    });
    expect(started.body.ok).toBe(true);
    const sale = await call<{ results: { error?: string }[] }>("POST", "/roster/actions", s.token, {
      actions: [{ id: "sell-locked", type: "sell", unitId: "z1" }],
    });
    expect(sale.body.results[0].error).toBe("no_unit");
    await call("POST", "/raid/finish", s.token, {
      sessionId: started.body.sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    const after = await call<{ results: { status: string }[] }>("POST", "/roster/actions", s.token, {
      actions: [{ id: "sell-after", type: "sell", unitId: "z1" }],
    });
    expect(after.body.results[0].status).toBe("applied");
  });
});
