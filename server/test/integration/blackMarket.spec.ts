import { describe, expect, it } from "vitest";
import { call, grantBalance, grantRoster, signIn, uniqueSub, xpForLevel } from "./helpers";

const bootstrap = async (session: Awaited<ReturnType<typeof signIn>>) => {
  const result = await call<any>("POST", "/bootstrap", session.token, {});
  expect(result.status).toBe(200);
  return result.body;
};

const operation = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

describe("Black Market", () => {
  it("allows 10 concurrent posts and explains the active limit on the 11th", async () => {
    const poster = await signIn(uniqueSub("market-active-limit"));
    const initial = await bootstrap(poster);
    let expectedAccountVersion = initial.accountVersion;

    for (let index = 0; index < 10; index++) {
      const created = await call<any>("POST", "/black-market/orders", poster.token, {
        operationId: operation(`active-${index}`), expectedAccountVersion,
        kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1",
        mutated: false, priceBrains: 1,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expectedAccountVersion += 1;
    }

    const eleventh = await call<any>("POST", "/black-market/orders", poster.token, {
      operationId: operation("active-11"), expectedAccountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1",
      mutated: false, priceBrains: 1,
    });
    expect(eleventh).toMatchObject({ status: 409, body: { error: "active_post_limit" } });
  });

  it("allows 50 posts per day and explains the daily limit on the 51st", async () => {
    const poster = await signIn(uniqueSub("market-daily-limit"));
    const initial = await bootstrap(poster);
    let expectedAccountVersion = initial.accountVersion;

    for (let index = 0; index < 50; index++) {
      const created = await call<any>("POST", "/black-market/orders", poster.token, {
        operationId: operation(`daily-create-${index}`), expectedAccountVersion,
        kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1",
        mutated: false, priceBrains: 1,
      });
      expect(created.status, `create ${index + 1}: ${JSON.stringify(created.body)}`).toBe(200);
      expectedAccountVersion += 1;

      const cancelled = await call<any>(
        "POST", `/black-market/orders/${created.body.order.id}/cancel`, poster.token,
        { operationId: operation(`daily-cancel-${index}`), expectedAccountVersion }
      );
      expect(cancelled.status, `cancel ${index + 1}: ${JSON.stringify(cancelled.body)}`).toBe(200);
      expectedAccountVersion += 1;
    }

    const fiftyFirst = await call<any>("POST", "/black-market/orders", poster.token, {
      operationId: operation("daily-create-51"), expectedAccountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1",
      mutated: false, priceBrains: 1,
    });
    expect(fiftyFirst).toMatchObject({ status: 409, body: { error: "daily_post_limit" } });
  }, 30_000);

  it("allows a non-reward named special zombie to be posted for sale", async () => {
    const seller = await signIn(uniqueSub("market-special-seller"));
    const unitId = `market-special-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorZomBetty" }]);
    const before = await bootstrap(seller);

    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("special-create"), expectedAccountVersion: before.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 4,
    });

    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.order).toMatchObject({ kind: "SELL_ZOMBIE", zombieKey: "ZombieActorZomBetty" });
  });

  it("requires level 20 before requesting or purchasing a special zombie", async () => {
    const seller = await signIn(uniqueSub("market-special-level-seller"));
    const buyer = await signIn(uniqueSub("market-special-level-buyer"));
    const unitId = `market-special-level-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorZomBetty" }]);

    const buyerBefore = await bootstrap(buyer);
    const requestLocked = await call("POST", "/black-market/orders", buyer.token, {
      operationId: operation("special-level-request"),
      expectedAccountVersion: buyerBefore.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorZomBetty", mutated: false, priceBrains: 1,
    });
    expect(requestLocked).toMatchObject({
      status: 403,
      body: { error: "black_market_level_locked" },
    });

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("special-level-sale"),
      expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const locked = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("special-level-locked"),
      expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(locked).toMatchObject({ status: 403, body: { error: "black_market_level_locked" } });

    await grantBalance(buyer, { xp: xpForLevel(20) });
    const buyerAt20 = await bootstrap(buyer);
    const fulfilled = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("special-level-unlocked"),
      expectedAccountVersion: buyerAt20.accountVersion,
    });
    expect(fulfilled.status).toBe(200);
  });

  it("requires the zombie's colored gravestone to be placed before purchase", async () => {
    const seller = await signIn(uniqueSub("market-grave-seller"));
    const buyer = await signIn(uniqueSub("market-grave-buyer"));
    const unitId = `market-red-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier3" }]);
    await grantBalance(buyer, { brains: 20, xp: xpForLevel(20) });

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("red-sale"),
      expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    const locked = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("red-no-grave"),
      expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(locked).toMatchObject({
      status: 403,
      body: { error: "black_market_grave_required" },
    });

    const graveBatch = await call<any>("POST", "/commands", buyer.token, {
      protocolVersion: 3,
      deviceId: "device-aaaaaaaa",
      batchId: operation("red-grave-batch"),
      firstSequence: 1,
      expectedAccountVersion: buyerBefore.accountVersion,
      writerGeneration: buyerBefore.writerGeneration,
      commands: [{
        sequence: 1,
        command: {
          type: "object.buy",
          catalogKey: "gravestoneRed",
          clientInstanceId: operation("red-grave"),
        },
      }],
    });
    expect(graveBatch.status, JSON.stringify(graveBatch.body)).toBe(200);
    expect(graveBatch.body.results[0]).toMatchObject({ status: "applied" });

    const buyerWithGrave = await bootstrap(buyer);
    const fulfilled = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("red-with-grave"),
      expectedAccountVersion: buyerWithGrave.accountVersion,
    });
    expect(fulfilled.status).toBe(200);
  });

  it("escrows and atomically fulfills a zombie sale", async () => {
    const seller = await signIn(uniqueSub("market-seller"));
    const buyer = await signIn(uniqueSub("market-buyer"));
    const unitId = `market-unit-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1", mutation: 4, invasions: 3 }]);

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 5,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.order).toMatchObject({ kind: "SELL_ZOMBIE", mutated: true, priceBrains: 5 });
    expect((await bootstrap(seller)).gameplay.roster.some((unit: any) => unit.id === unitId)).toBe(false);

    const buyerBefore = await bootstrap(buyer);
    const fulfilled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(fulfilled.status).toBe(200);

    const sellerAfter = await bootstrap(seller);
    const buyerAfter = await bootstrap(buyer);
    expect(sellerAfter.gameplay.balance.brains).toBe(sellerBefore.gameplay.balance.brains + 5);
    expect(buyerAfter.gameplay.balance.brains).toBe(buyerBefore.gameplay.balance.brains - 5);
    expect(buyerAfter.gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 4, invasions: 3, stored: false }),
    ]));
  });

  it("puts a purchased zombie in storage when the active farm is full", async () => {
    const seller = await signIn(uniqueSub("market-full-seller"));
    const buyer = await signIn(uniqueSub("market-full-buyer"));
    const saleUnitId = `market-sale-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: saleUnitId, key: "ZombieActorRegularTier1" }]);
    await grantRoster(buyer, Array.from({ length: 16 }, (_, index) => ({
      id: `market-active-${index}-${crypto.randomUUID()}`,
      key: "ZombieActorGirlTier1",
      stored: false,
    })));

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("full-create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId: saleUnitId, priceBrains: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    expect(buyerBefore.gameplay.roster.filter((unit: any) => !unit.stored)).toHaveLength(16);
    const fulfilled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("full-fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200);

    const buyerAfter = await bootstrap(buyer);
    expect(buyerAfter.gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", stored: true }),
    ]));
    expect(buyerAfter.gameplay.roster.filter((unit: any) => !unit.stored)).toHaveLength(16);
  });

  it("refunds a cancelled brain request and does not refund the daily post count", async () => {
    const requester = await signIn(uniqueSub("market-requester"));
    const before = await bootstrap(requester);
    const operationId = operation("request");
    const created = await call<any>("POST", "/black-market/orders", requester.token, {
      operationId, expectedAccountVersion: before.accountVersion, kind: "BUY_ZOMBIE",
      zombieKey: "ZombieActorRegularTier1", mutated: false, priceBrains: 7,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect((await bootstrap(requester)).gameplay.balance.brains).toBe(before.gameplay.balance.brains - 7);

    const current = await bootstrap(requester);
    const cancelled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/cancel`, requester.token, {
      operationId: operation("cancel"), expectedAccountVersion: current.accountVersion,
    });
    expect(cancelled.status).toBe(200);
    const after = await bootstrap(requester);
    expect(after.gameplay.balance.brains).toBe(before.gameplay.balance.brains);
    expect(cancelled.body.summary).toMatchObject({ activePosts: 0, postsToday: 1 });
  });

  it("allows multiple requested mutations and ORs alternatives in the same slot", async () => {
    const requester = await signIn(uniqueSub("market-specific-requester"));
    const seller = await signIn(uniqueSub("market-specific-seller"));
    const wrongId = `market-wrong-mutation-${crypto.randomUUID()}`;
    const matchingId = `market-matching-mutation-${crypto.randomUUID()}`;
    await grantRoster(seller, [
      { id: wrongId, key: "ZombieActorRegularTier1", mutation: 4 },
      // Broccohair satisfies a request for Broccohair OR Cauli-hair. The extra
      // Turnip-Arm mutation does not prevent the match.
      { id: matchingId, key: "ZombieActorRegularTier1", mutation: 128 | 8 },
    ]);

    const requesterBefore = await bootstrap(requester);
    const created = await call<any>("POST", "/black-market/orders", requester.token, {
      operationId: operation("specific-request"),
      expectedAccountVersion: requesterBefore.accountVersion,
      kind: "BUY_ZOMBIE",
      zombieKey: "ZombieActorRegularTier1",
      mutated: true,
      mutationRequired: 128 | 512,
      priceBrains: 2,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.order).toMatchObject({
      mutated: true,
      mutationRequired: 128 | 512,
    });

    const sellerBefore = await bootstrap(seller);
    const mismatch = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, seller.token, {
      operationId: operation("specific-mismatch"),
      expectedAccountVersion: sellerBefore.accountVersion,
      unitId: wrongId,
    });
    expect(mismatch).toMatchObject({ status: 409, body: { error: "zombie_mismatch" } });

    const fulfilled = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, seller.token, {
      operationId: operation("specific-match"),
      expectedAccountVersion: sellerBefore.accountVersion,
      unitId: matchingId,
    });
    expect(fulfilled.status).toBe(200);
    expect((await bootstrap(requester)).gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 128 | 8 }),
    ]));
  });

  it("returns a cancelled sale to the farm unless the active farm is full", async () => {
    const cancelSale = async (prefix: string, activeCount: number, expectedStored: boolean) => {
      const seller = await signIn(uniqueSub(prefix));
      const saleUnitId = `${prefix}-sale-${crypto.randomUUID()}`;
      await grantRoster(seller, [
        { id: saleUnitId, key: "ZombieActorRegularTier1", mutation: 2, invasions: 4 },
        ...Array.from({ length: activeCount }, (_, index) => ({
          id: `${prefix}-active-${index}-${crypto.randomUUID()}`,
          key: "ZombieActorGirlTier1",
          stored: false,
        })),
      ]);
      const before = await bootstrap(seller);
      const created = await call<any>("POST", "/black-market/orders", seller.token, {
        operationId: operation(`${prefix}-create`), expectedAccountVersion: before.accountVersion,
        kind: "SELL_ZOMBIE", unitId: saleUnitId, priceBrains: 2,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);

      const escrowed = await bootstrap(seller);
      const cancelled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/cancel`, seller.token, {
        operationId: operation(`${prefix}-cancel`), expectedAccountVersion: escrowed.accountVersion,
      });
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

      const after = await bootstrap(seller);
      expect(after.gameplay.roster).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "ZombieActorRegularTier1", mutation: 2, invasions: 4, stored: expectedStored,
        }),
      ]));
    };

    await cancelSale("market-cancel-room", 0, false);
    await cancelSale("market-cancel-full", 16, true);
  });

  it("allows exactly one winner when buyers race for a sale", async () => {
    const seller = await signIn(uniqueSub("market-race-seller"));
    const buyerA = await signIn(uniqueSub("market-race-a"));
    const buyerB = await signIn(uniqueSub("market-race-b"));
    const unitId = `market-race-unit-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1" }]);
    const sellerState = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("race-create"), expectedAccountVersion: sellerState.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 3,
    });
    expect(created.status).toBe(200);
    const [stateA, stateB] = await Promise.all([bootstrap(buyerA), bootstrap(buyerB)]);
    const attempts = await Promise.all([
      call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyerA.token, {
        operationId: operation("race-a"), expectedAccountVersion: stateA.accountVersion,
      }),
      call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyerB.token, {
        operationId: operation("race-b"), expectedAccountVersion: stateB.accountVersion,
      }),
    ]);
    expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
  });
});
