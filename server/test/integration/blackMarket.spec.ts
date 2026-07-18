import { describe, expect, it } from "vitest";
import { call, grantRoster, signIn, uniqueSub } from "./helpers";

const bootstrap = async (session: Awaited<ReturnType<typeof signIn>>) => {
  const result = await call<any>("POST", "/bootstrap", session.token, {});
  expect(result.status).toBe(200);
  return result.body;
};

const operation = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

describe("Black Market", () => {
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
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 4, invasions: 3, stored: true }),
    ]));
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
