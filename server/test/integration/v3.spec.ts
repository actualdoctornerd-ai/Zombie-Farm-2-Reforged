import { describe, expect, it } from "vitest";
import { befriend, call, signIn } from "./helpers";

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
  it("authenticates and activates an Epic Boss event", async () => {
    const unauthenticated = await call<any>("POST", "/epic-boss/activate", undefined, {
      activationId: "activation-unauthenticated",
    });
    expect(unauthenticated.status).toBe(401);

    const session = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    const grown = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-epic-zombie", 1, [
        { type: "farm.plow", oc: 0, or: 0 },
        { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" },
        { type: "power.buy", key: "insta_grow" },
        { type: "power.use", key: "insta_grow", oc: 0, or: 0 },
        { type: "farm.harvest", oc: 0, or: 0 },
      ]));
    expect(grown.status).toBe(200);
    const epicZombieId = grown.body.createdZombieIds[0];
    const brainsBeforeActivation = grown.body.gameplay.balance.brains;
    const activated = await call<any>("POST", "/epic-boss/activate", session.token, {
      activationId: "activation-authenticated",
      bossId: "loco-locust",
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.event).toMatchObject({
      runId: "activation-authenticated",
      bossId: "loco-locust",
      level: 1,
    });
    expect(activated.body.balance.brains).toBe(brainsBeforeActivation - 10);

    const started = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [epicZombieId],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const escaped = await call<any>("POST", "/epic-boss/finish", session.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    expect(escaped.status, JSON.stringify(escaped.body)).toBe(200);
    expect(escaped.body).toMatchObject({ escaped: true, event: { level: 1 } });
    const retryReadyAt = escaped.body.event.retryReadyAt;
    expect(retryReadyAt).toBeGreaterThan(Date.now());
    const cooldown = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [epicZombieId],
    });
    expect(cooldown.status, JSON.stringify(cooldown.body)).toBe(429);
    expect(cooldown.body.error).toBe("cooldown");

    const skipped = await call<any>("POST", "/epic-boss/skip-retry", session.token, {
      runId: "activation-authenticated",
      retryReadyAt,
    });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    expect(skipped.body).toMatchObject({ costBrains: 10, event: { retryReadyAt: 0 } });
    expect(skipped.body.balance.brains).toBe(brainsBeforeActivation - 20);

    const retried = await call<any>("POST", "/epic-boss/skip-retry", session.token, {
      runId: "activation-authenticated",
      retryReadyAt,
    });
    expect(retried.status).toBe(200);
    expect(retried.body.balance.brains).toBe(brainsBeforeActivation - 20);
  });

  it("persists pet ownership, makes retries idempotent, and ignores presentation forgeries", async () => {
    const owner = await signIn();
    const other = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", owner.token, {})).body;
    expect(boot.gameplay).toMatchObject({ ownedPets: [], activePet: null });

    const body = commandBody(boot, "batch-pet-purchase", 1, [{ type: "pet.buy", petKey: "catActor" }]);
    const bought = await call<any>("POST", "/commands", owner.token, body);
    expect(bought.status).toBe(200);
    expect(bought.body.gameplay).toMatchObject({ ownedPets: ["catActor"], activePet: "catActor" });
    expect(bought.body.gameplay.balance.brains).toBe(boot.gameplay.balance.brains - 50);

    const retried = await call<any>("POST", "/commands", owner.token, body);
    expect(retried.body).toEqual(bought.body);
    const forged = await call<any>("PUT", "/presentation", owner.token, {
      protocolVersion: 3,
      expectedVersion: 0,
      data: { player: { ownedPets: ["alienActor"], activePet: "alienActor" } },
    });
    expect(forged.status).toBe(200);

    const reloaded = (await call<any>("POST", "/bootstrap", owner.token, {})).body;
    expect(reloaded.gameplay).toMatchObject({ ownedPets: ["catActor"], activePet: "catActor" });
    const isolated = (await call<any>("POST", "/bootstrap", other.token, {})).body;
    expect(isolated.gameplay).toMatchObject({ ownedPets: [], activePet: null });
    await befriend(owner, other);
    const visit = await call<any>("GET", `/friends/${owner.accountId}/save`, other.token);
    expect(visit.status).toBe(200);
    expect(visit.body.save.player.petCollection).toEqual({ owned: ["catActor"], active: "catActor" });
  });

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
    expect(applied.body.gameplay.balance.gold).toBe(999_985);
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
        "batch-writer-b", 1, [{ type: "farm.plow", oc: 4, or: 0 }], "device-bbbbbbbb", true));
    expect(takeover.status).toBe(409);
    expect(takeover.body.error).toBe("writer_taken");

    const refreshed = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    expect(refreshed.writerDeviceId).toBe("device-bbbbbbbb");
    const newDevice = await call<any>("POST", "/commands", session.token,
      commandBody(refreshed, "batch-writer-b", 1,
        [{ type: "farm.plow", oc: 4, or: 0 }], "device-bbbbbbbb", false));
    expect(newDevice.status).toBe(200);
    expect(newDevice.body.gameplay.farm.plots["4:0"]).toMatchObject({ state: "plowed" });

    const oldDevice = await call<any>("POST", "/commands", session.token,
      commandBody(newDevice.body, "batch-old-device", 2, [{ type: "farm.plow", oc: 8, or: 0 }], deviceA, false));
    expect(oldDevice.status).toBe(423);
    expect(oldDevice.body.error).toBe("writer_replaced");
  });

  it("settles a retreat immediately without survivor veterancy or a stuck session", async () => {
    const session = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", session.token, {
      protocolVersion: 3,
      deviceId: deviceA,
    })).body;
    const grown = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-retreat-zombie", 1, [
        { type: "farm.plow", oc: 0, or: 0 },
        { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" },
        { type: "power.buy", key: "insta_grow" },
        { type: "power.use", key: "insta_grow", oc: 0, or: 0 },
        { type: "farm.harvest", oc: 0, or: 0 },
      ]));
    expect(grown.status).toBe(200);
    const unitId = grown.body.createdZombieIds[0];
    expect(unitId).toBeTypeOf("string");
    const started = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: [unitId],
    });
    expect(started.status).toBe(200);

    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId: started.body.sessionId,
      win: false,
      survivors: [],
      losses: [],
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ gold: 0, xp: 0, outcome: { win: false, survivors: [], losses: [] } });

    const next = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: [unitId],
    });
    expect(next.status).toBe(429);
    expect(next.body.error).toBe("cooldown");
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
