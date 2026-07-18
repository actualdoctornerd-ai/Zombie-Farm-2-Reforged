import { describe, expect, it } from "vitest";
import { befriend, call, grantBalance, signIn, uniqueSub } from "./helpers";

const deviceA = "device-aaaaaaaa";
const commandBody = (
  bootstrap: { accountVersion: number; writerGeneration: number },
  batchId: string,
  firstSequence: number,
  commands: unknown[],
  deviceId = deviceA,
  takeWriter = false
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
  it("claims a gift atomically and credits exactly once across concurrent attempts", async () => {
    const sender = await signIn(uniqueSub("gift-sender"));
    const recipient = await signIn(uniqueSub("gift-recipient"));
    await befriend(sender, recipient);
    const before = await call<any>("POST", "/bootstrap", recipient.token, {});
    expect(before.status).toBe(200);
    expect((await call("POST", "/gifts", sender.token, { toAccountId: recipient.accountId })).status).toBe(200);
    const inbox = await call<Array<{ id: string }>>("GET", "/gifts/inbox", recipient.token);
    expect(inbox.body).toHaveLength(1);

    const claims = await Promise.all([
      call<any>("POST", "/gifts/claim", recipient.token, { giftId: inbox.body[0].id }),
      call<any>("POST", "/gifts/claim", recipient.token, { giftId: inbox.body[0].id }),
    ]);
    expect(claims.map((claim) => claim.status)).toEqual([200, 200]);
    expect(claims.filter((claim) => claim.body.credited)).toHaveLength(1);
    expect(claims.every((claim) => claim.body.accountVersion === before.body.accountVersion + 1)).toBe(true);
    const followup = await call<any>("POST", "/commands", recipient.token,
      commandBody(
        { accountVersion: claims[0].body.accountVersion, writerGeneration: before.body.writerGeneration },
        "gift-followup-batch", 1, [{ type: "farm.plow", oc: 0, or: 0 }]
      ));
    expect(followup.status).toBe(200);
    expect((await call<unknown[]>("GET", "/gifts/inbox", recipient.token)).body).toEqual([]);
    const after = await call<any>("POST", "/bootstrap", recipient.token, {});
    expect(after.body.gameplay.balance.brains).toBe(before.body.gameplay.balance.brains + 1);
    expect(after.body.accountVersion).toBe(before.body.accountVersion + 2);
  });

  it("fences activity to one explicit writer and transfers control atomically", async () => {
    const session = await signIn(undefined, false);
    const clientA = "writer-client-aaaaaaaa";
    const clientB = "writer-client-bbbbbbbb";
    const tokenA = "a".repeat(64);
    const tokenB = "b".repeat(64);
    const v4 = { "x-integrity-version": "4" };
    const credential = (clientId: string, generation: number, token: string) => ({
      ...v4,
      "x-writer-client": clientId,
      "x-writer-generation": String(generation),
      "x-writer-token": token,
    });

    const initial = await call<any>("POST", "/bootstrap", session.token, {}, v4);
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body.writer).toMatchObject({ status: "free", generation: 0 });
    const acquired = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientA, token: tokenA, observedGeneration: 0, takeover: false,
    }, v4);
    expect(acquired.status).toBe(200);
    const aHeaders = credential(clientA, acquired.body.writerGeneration, tokenA);
    const ownedA = await call<any>("POST", "/bootstrap", session.token, {}, aHeaders);
    expect(ownedA.body.writer.status).toBe("mine");

    const first = await call<any>("POST", "/commands", session.token,
      commandBody(ownedA.body, "writer-fenced-a", 1, [{ type: "farm.plow", oc: 0, or: 0 }], clientA, false), aHeaders);
    expect(first.status).toBe(200);

    const spoofedClient = await call<any>("POST", "/commands", session.token,
      commandBody(first.body, "writer-spoofed-client", 2, [{ type: "farm.plow", oc: 4, or: 0 }], clientB, false), aHeaders);
    expect(spoofedClient.status).toBe(400);
    expect(spoofedClient.body.error).toBe("bad_writer_command");
    const legacyTakeover = await call<any>("POST", "/commands", session.token,
      commandBody(first.body, "writer-legacy-takeover", 2, [{ type: "farm.plow", oc: 4, or: 0 }], clientA, true), aHeaders);
    expect(legacyTakeover.status).toBe(400);
    expect(legacyTakeover.body.error).toBe("bad_writer_command");

    const observedB = await call<any>("POST", "/bootstrap", session.token, {}, v4);
    expect(observedB.body.writer.status).toBe("other");
    const refused = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientB, token: tokenB, observedGeneration: observedB.body.writer.generation, takeover: false,
    }, v4);
    expect(refused.status).toBe(423);
    const takeover = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientB, token: tokenB, observedGeneration: observedB.body.writer.generation, takeover: true,
    }, v4);
    expect(takeover.status).toBe(200);
    const bHeaders = credential(clientB, takeover.body.writerGeneration, tokenB);

    const stale = await call<any>("POST", "/commands", session.token,
      commandBody(first.body, "writer-stale-a", 2, [{ type: "farm.plow", oc: 4, or: 0 }], clientA, false), aHeaders);
    expect(stale.status).toBe(423);
    expect(stale.body.error).toBe("writer_replaced");

    const ownedB = await call<any>("POST", "/bootstrap", session.token, {}, bHeaders);
    expect(ownedB.body.writer.status).toBe("mine");
    const second = await call<any>("POST", "/commands", session.token,
      commandBody(ownedB.body, "writer-fenced-b", 1, [{ type: "farm.plow", oc: 4, or: 0 }], clientB, false), bHeaders);
    expect(second.status).toBe(200);
    expect(second.body.gameplay.farm.plots["4:0"]).toMatchObject({ state: "plowed" });

    const stalePresentation = await call<any>("PUT", "/presentation", session.token, {
      protocolVersion: 3, expectedVersion: 0, data: { camera: { x: 1 } },
    }, aHeaders);
    expect(stalePresentation.status).toBe(423);
    const currentPresentation = await call<any>("PUT", "/presentation", session.token, {
      protocolVersion: 3, expectedVersion: 0, data: { camera: { x: 2 } },
    }, bHeaders);
    expect(currentPresentation.status).toBe(200);
  });

  it("recovers a lost writer token for the same session and client without takeover", async () => {
    const session = await signIn(undefined, false);
    const clientId = "writer-client-recovery";
    const originalToken = "r".repeat(64);
    const replacementToken = "s".repeat(64);
    const headers = (token: string, generation: number) => ({
      "x-integrity-version": "4",
      "x-writer-client": clientId,
      "x-writer-generation": String(generation),
      "x-writer-token": token,
    });

    const initial = await call<any>("POST", "/bootstrap", session.token, {});
    const acquired = await call<any>("POST", "/writer/acquire", session.token, {
      clientId, token: originalToken,
      observedGeneration: initial.body.writer.generation, takeover: false,
    });
    expect(acquired.status).toBe(200);

    const recovered = await call<any>("POST", "/writer/acquire", session.token, {
      clientId, token: replacementToken,
      observedGeneration: acquired.body.writerGeneration, takeover: false,
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body.writerGeneration).toBe(acquired.body.writerGeneration);
    expect(recovered.body.accountVersion).toBe(acquired.body.accountVersion);

    const stale = await call<any>("POST", "/bootstrap", session.token, {},
      headers(originalToken, acquired.body.writerGeneration));
    expect(stale.body.writer.status).toBe("other");
    const current = await call<any>("POST", "/bootstrap", session.token, {},
      headers(replacementToken, acquired.body.writerGeneration));
    expect(current.body.writer.status).toBe("mine");
  });

  it("authenticates and activates an Epic Boss event", async () => {
    const unauthenticated = await call<any>("POST", "/epic-boss/activate", undefined, {
      activationId: "activation-unauthenticated",
    });
    expect(unauthenticated.status).toBe(401);

    const session = await signIn();
    await grantBalance(session, { gold: 400, brains: 1_000, xp: 0 });
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
    const activationId = uniqueSub("activation-authenticated");
    const activated = await call<any>("POST", "/epic-boss/activate", session.token, {
      activationId,
      bossId: "loco-locust",
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.event).toMatchObject({
      runId: activationId,
      bossId: "loco-locust",
      level: 1,
    });
    expect(activated.body.balance.brains).toBe(brainsBeforeActivation - 100);

    const started = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [epicZombieId],
      payment: "brains",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const escaped = await call<any>("POST", "/epic-boss/finish", session.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    expect(escaped.status, JSON.stringify(escaped.body)).toBe(200);
    expect(escaped.body).toMatchObject({ escaped: true, event: { level: 1 } });
    expect(escaped.body.event.retryReadyAt).toBe(0);
    const retried = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [epicZombieId],
      payment: "brains",
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.balance.brains).toBe(brainsBeforeActivation - 120);

    const ended = await call<any>("POST", "/epic-boss/end", session.token, {
      runId: activationId,
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.event.completedAt).toBe(0);
    expect(ended.body.event.expiresAt).toBeLessThanOrEqual(Date.now());

    const reactivated = await call<any>("POST", "/epic-boss/activate", session.token, {
      activationId: uniqueSub("activation-after-early-end"),
      bossId: "dr-groundhog",
    });
    expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
  });

  it("persists pet ownership, makes retries idempotent, and ignores presentation forgeries", async () => {
    const owner = await signIn();
    const other = await signIn();
    await grantBalance(owner, { gold: 100_000, brains: 1_000, xp: 0 });
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

    const displayed = await call<any>("POST", "/commands", owner.token,
      commandBody(bought.body, "batch-pet-display", 2, [
        { type: "pet.buy", petKey: "alienActor" },
        { type: "pet.pen", petKeys: ["catActor"] },
        { type: "object.buy", catalogKey: "pettingZoo", clientInstanceId: "visit-pet-pen" },
      ]));
    expect(displayed.status).toBe(200);
    expect(displayed.body.gameplay).toMatchObject({
      ownedPets: ["catActor", "alienActor"], activePet: "alienActor", penPets: ["catActor"],
    });

    const reloaded = (await call<any>("POST", "/bootstrap", owner.token, {})).body;
    expect(reloaded.gameplay).toMatchObject({
      ownedPets: ["catActor", "alienActor"], activePet: "alienActor", penPets: ["catActor"],
    });
    const isolated = (await call<any>("POST", "/bootstrap", other.token, {})).body;
    expect(isolated.gameplay).toMatchObject({ ownedPets: [], activePet: null });
    await befriend(owner, other);
    const visit = await call<any>("GET", `/friends/${owner.accountId}/save`, other.token);
    expect(visit.status).toBe(200);
    expect(visit.body.save.player.petCollection).toEqual({
      owned: ["alienActor", "catActor"], active: "alienActor", pen: ["catActor"],
    });
    expect(visit.body.save.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "visit-pet-pen", key: "pettingZoo" }),
    ]));
  });

  it("bootstraps once and applies a mixed ordered batch", async () => {
    const session = await signIn();
    const boot = await call<any>("POST", "/bootstrap", session.token, { protocolVersion: 3, deviceId: deviceA });
    expect(boot.status).toBe(200);
    expect(boot.body.protocolVersion).toBe(3);
    expect(boot.body.gameplay.balance).toEqual({ gold: 400, brains: 20, xp: 0 });
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
    expect(applied.body.gameplay.balance.gold).toBe(385);
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
    for (const objectLayout of [{}, [null], [{ id: "o1", oc: "0", or: 0 }]]) {
      const malformed = await call("PUT", "/presentation", session.token, {
        protocolVersion: 3, expectedVersion: 0, data: { objectLayout },
      });
      expect(malformed.status).toBe(400);
    }
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
