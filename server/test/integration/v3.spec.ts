import { describe, expect, it } from "vitest";
import { call, signIn } from "./helpers";

const deviceA = "device-aaaaaaaa";
const commandBody = (
  bootstrap: { accountVersion: number; writerGeneration: number },
  batchId: string,
  firstSequence: number,
  commands: unknown[],
  deviceId = deviceA,
  takeWriter = true
) => ({
  protocolVersion: 3,
  deviceId,
  batchId,
  firstSequence,
  expectedAccountVersion: bootstrap.accountVersion,
  writerGeneration: bootstrap.writerGeneration,
  takeWriter,
  commands: commands.map((command, index) => ({ sequence: firstSequence + index, command })),
});

describe("protocol v3 API", () => {
  it("bootstraps once and applies a mixed ordered batch", async () => {
    const session = await signIn();
    const boot = await call<any>("POST", "/bootstrap", session.token, { protocolVersion: 3, deviceId: deviceA });
    expect(boot.status).toBe(200);
    expect(boot.body.protocolVersion).toBe(3);
    expect(boot.body.gameplay.balance).toEqual({ gold: 1_000_000, brains: 10_000, xp: 0 });
    expect(boot.body.social).toMatchObject({ friends: [], incomingRequestCount: 0, inboxCount: 0 });

    const body = commandBody(boot.body, "batch-aaaaaaaa", 1, [
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "farm.harvest", oc: 0, or: 0 },
    ]);
    const applied = await call<any>("POST", "/commands", session.token, body);
    expect(applied.status).toBe(200);
    expect(applied.body.results.map((r: any) => [r.status, r.error])).toEqual([
      ["applied", undefined], ["applied", undefined], ["rejected", "not_grown"],
    ]);
    expect(applied.body.gameplay.balance.gold).toBe(185);
    expect(applied.body.gameplay.farm.plots["0:0"].plantedAt).toBeTypeOf("number");

    const duplicate = await call<any>("POST", "/commands", session.token, body);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual(applied.body);

    const zombieBatch = commandBody(applied.body, "batch-zombie-create", 4, [
      { type: "farm.remove", oc: 0, or: 0 },
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" },
      { type: "power.buy", key: "insta_grow" },
      { type: "power.use", key: "insta_grow", oc: 0, or: 0 },
      { type: "farm.harvest", oc: 0, or: 0 },
    ]);
    const zombie = await call<any>("POST", "/commands", session.token, zombieBatch);
    expect(zombie.status).toBe(200);
    expect(zombie.body.results.every((result: any) => result.status === "applied")).toBe(true);
    expect(zombie.body.createdZombieIds).toHaveLength(1);
    expect(zombie.body.gameplay.roster[0].id).toBe(zombie.body.createdZombieIds[0]);
  });

  it("takes writer ownership with a conflict and makes the old device read-only", async () => {
    const session = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    const first = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-writer-a", 1, [{ type: "farm.plow", oc: 0, or: 0 }]));
    expect(first.status).toBe(200);

    const takeover = await call<any>("POST", "/commands", session.token,
      commandBody({ accountVersion: first.body.accountVersion, writerGeneration: first.body.writerGeneration },
        "batch-writer-b", 2, [{ type: "farm.plow", oc: 4, or: 0 }], "device-bbbbbbbb", true));
    expect(takeover.status).toBe(409);
    expect(takeover.body.error).toBe("writer_taken");

    const refreshed = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    expect(refreshed.writerDeviceId).toBe("device-bbbbbbbb");
    const oldDevice = await call<any>("POST", "/commands", session.token,
      commandBody(refreshed, "batch-old-device", 2, [{ type: "farm.plow", oc: 4, or: 0 }], deviceA, false));
    expect(oldDevice.status).toBe(423);
    expect(oldDevice.body.error).toBe("writer_replaced");
  });

  it("versions presentation independently and retires v2 mutations", async () => {
    const session = await signIn();
    const presentation = await call<any>("PUT", "/presentation", session.token, {
      protocolVersion: 3,
      expectedVersion: 0,
      data: { camera: { x: 1, y: 2 }, tutorial: { done: false, step: 1 } },
    });
    expect(presentation.status).toBe(200);
    expect(presentation.body.version).toBe(1);
    const conflict = await call("PUT", "/presentation", session.token, {
      protocolVersion: 3, expectedVersion: 0, data: { camera: {} },
    });
    expect(conflict.status).toBe(409);
    const retired = await call<any>("POST", "/farm/actions", session.token, { actions: [] });
    expect(retired.status).toBe(410);
    expect(retired.body).toEqual({ error: "update_required", protocolVersion: 3 });
  });

  it("rejects unknown and malformed semantic commands before execution", async () => {
    const session = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    const unknown = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-malformed", 1, [{ type: "balance.set", gold: 999999 }]));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("bad_command_batch");
    const malformed = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-bad-trees", 1, [{ type: "object.harvest_trees", instanceIds: "all" }]));
    expect(malformed.status).toBe(400);
  });
});
