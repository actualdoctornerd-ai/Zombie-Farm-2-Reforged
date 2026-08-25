import { describe, expect, it } from "vitest";
import {
  call, grantBalance as setBalance, grantLevel, grantRoster,
  signIn as authSignIn, uniqueSub, xpForLevel, type Session,
} from "./helpers";
import { BLACK_MARKET_MIN_LEVEL } from "../../../src/blackMarketRules";

// The Black Market opens at BLACK_MARKET_MIN_LEVEL and the Worker enforces that floor
// on every post and every trade, so each account here trades from that level up. The
// wrappers below exist because `/dev/fixture/balance` REWRITES the whole balances row —
// xp included — so a later balance grant would silently drop the account back to level
// 1. Tests that need a HIGHER level (the special/colour unlocks) pass their own xp and
// keep it. `lockedSignIn` is the way to get an account BELOW the floor on purpose.
const lockedSignIn = authSignIn;

const signIn = async (devSub?: string): Promise<Session> => {
  const session = await authSignIn(devSub);
  await grantLevel(session, BLACK_MARKET_MIN_LEVEL);
  return session;
};

const grantBalance = async (
  s: Session,
  balance: { gold?: number; brains?: number; xp?: number }
): Promise<void> => {
  await setBalance(s, balance);
  if (balance.xp === undefined) await grantLevel(s, BLACK_MARKET_MIN_LEVEL);
};

const bootstrap = async (session: Awaited<ReturnType<typeof signIn>>) => {
  const result = await call<any>("POST", "/bootstrap", session.token, {});
  expect(result.status).toBe(200);
  return result.body;
};

const operation = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** The writer clientId `signIn` acquires; a command batch's deviceId must equal it. */
const WRITER_DEVICE = "device-aaaaaaaa";

describe("Black Market", () => {
  it(`refuses posts and trades below level ${BLACK_MARKET_MIN_LEVEL}`, async () => {
    const seller = await signIn(uniqueSub("market-floor-seller"));
    const newcomer = await lockedSignIn(uniqueSub("market-floor-newcomer"));
    await setBalance(newcomer, { brains: 50, xp: xpForLevel(BLACK_MARKET_MIN_LEVEL - 1) });

    // The newcomer cannot post...
    const newcomerBoot = await bootstrap(newcomer);
    const posted = await call<any>("POST", "/black-market/orders", newcomer.token, {
      operationId: operation("floor-create"), expectedAccountVersion: newcomerBoot.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false, priceBrains: 1,
    });
    expect(posted).toMatchObject({ status: 403, body: { error: "black_market_locked" } });

    // ...nor buy one somebody at level put up.
    const unitId = `market-floor-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1" }]);
    const sellerBoot = await bootstrap(seller);
    const listing = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("floor-listing"), expectedAccountVersion: sellerBoot.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 1,
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);

    const bought = await call<any>(
      "POST", `/black-market/orders/${listing.body.order.id}/fulfill`, newcomer.token,
      { operationId: operation("floor-fulfill"), expectedAccountVersion: newcomerBoot.accountVersion }
    );
    expect(bought).toMatchObject({ status: 403, body: { error: "black_market_locked" } });

    // Reaching the level opens both, with nothing else about the account changed.
    await grantLevel(newcomer, BLACK_MARKET_MIN_LEVEL);
    const opened = await call<any>(
      "POST", `/black-market/orders/${listing.body.order.id}/fulfill`, newcomer.token,
      { operationId: operation("floor-fulfill-ok"), expectedAccountVersion: newcomerBoot.accountVersion }
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  });

  it("allows 10 concurrent posts and explains the active limit on the 11th", async () => {
    const poster = await signIn(uniqueSub("market-active-limit"));
    await grantBalance(poster, { brains: 20 });
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

  it("browses by colour class and body family, and by both at once", async () => {
    const seller = await signIn(uniqueSub("market-browse-seller"));
    // One zombie per taxonomy cell the filters must separate: colour class (the
    // toolbar's "category") down one axis, body family (its "class") down the other.
    const units = [
      { key: "ZombieActorRegularTier1", id: `browse-green-regular-${crypto.randomUUID()}` },
      { key: "ZombieActorGirlTier1", id: `browse-green-female-${crypto.randomUUID()}` },
      { key: "ZombieActorGardenTier1", id: `browse-green-garden-${crypto.randomUUID()}` },
      { key: "ZombieActorRegularTier2", id: `browse-blue-regular-${crypto.randomUUID()}` },
    ];
    await grantRoster(seller, units.map((unit) => ({ id: unit.id, key: unit.key })));

    let expectedAccountVersion = (await bootstrap(seller)).accountVersion;
    for (const unit of units) {
      const created = await call<any>("POST", "/black-market/orders", seller.token, {
        operationId: operation(`browse-${unit.key}`), expectedAccountVersion,
        kind: "SELL_ZOMBIE", unitId: unit.id, priceBrains: 2,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expectedAccountVersion += 1;
    }

    // `mine` keeps the assertions clear of every other test's posts in the shared DB.
    const browse = async (params: string) => {
      const result = await call<any>("GET",
        `/black-market/orders?kind=SELL_ZOMBIE&mine=true${params}`, seller.token);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return (result.body.orders as Array<{ zombieKey: string }>).map((order) => order.zombieKey).sort();
    };

    expect(await browse("")).toEqual([...units.map((unit) => unit.key)].sort());
    expect(await browse("&zombieClass=Green")).toEqual(
      ["ZombieActorRegularTier1", "ZombieActorGirlTier1", "ZombieActorGardenTier1"].sort());
    expect(await browse("&zombieClass=Blue")).toEqual(["ZombieActorRegularTier2"]);
    expect(await browse("&zombieGroup=Regular")).toEqual(
      ["ZombieActorRegularTier1", "ZombieActorRegularTier2"].sort());
    expect(await browse("&zombieGroup=Female")).toEqual(["ZombieActorGirlTier1"]);
    expect(await browse("&zombieClass=Green&zombieGroup=Regular")).toEqual(["ZombieActorRegularTier1"]);
    expect(await browse("&zombieClass=Blue&zombieGroup=Garden")).toEqual([]);
    // An unrecognized bucket filters nothing rather than emptying the board.
    expect(await browse("&zombieClass=Chartreuse")).toEqual([...units.map((unit) => unit.key)].sort());
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

  it("unlocks a colored zombie at its gravestone level without requiring the gravestone", async () => {
    const seller = await signIn(uniqueSub("market-color-level-seller"));
    const buyer = await signIn(uniqueSub("market-color-level-buyer"));
    const unitId = `market-silver-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorLargeTier4" }]);
    await grantBalance(buyer, { brains: 20, xp: xpForLevel(24) });

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("silver-sale"),
      expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    const locked = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("silver-level-24"),
      expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(locked).toMatchObject({
      status: 403,
      body: { error: "black_market_level_locked" },
    });

    await grantBalance(buyer, { xp: xpForLevel(25) });
    const buyerAt25 = await bootstrap(buyer);
    const fulfilled = await call("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("silver-level-25-no-grave"),
      expectedAccountVersion: buyerAt25.accountVersion,
    });
    expect(fulfilled.status).toBe(200);
  });

  it("escrows and atomically fulfills a zombie sale", async () => {
    const seller = await signIn(uniqueSub("market-seller"));
    const buyer = await signIn(uniqueSub("market-buyer"));
    await grantBalance(buyer, { brains: 5 });
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
    // The buyer pays at settlement; the seller's brains stay with the market until
    // they collect, and the zombie likewise waits for the buyer to collect it.
    expect(sellerAfter.gameplay.balance.brains).toBe(sellerBefore.gameplay.balance.brains);
    expect(buyerAfter.gameplay.balance.brains).toBe(buyerBefore.gameplay.balance.brains - 5);
    expect(buyerAfter.gameplay.roster).toHaveLength(0);
    const sellerSummary = await call<any>("GET", "/black-market/summary", seller.token);
    expect(sellerSummary.body.heldBrains).toBe(5);
    const sellerPaid = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, seller.token, {});
    expect(sellerPaid.status, JSON.stringify(sellerPaid.body)).toBe(200);
    expect(sellerPaid.body.brainsPaid).toBe(5);
    expect((await bootstrap(seller)).gameplay.balance.brains)
      .toBe(sellerBefore.gameplay.balance.brains + 5);
    // Collecting again pays nothing more.
    const sellerRepeat = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, seller.token, {});
    expect(sellerRepeat).toMatchObject({ status: 200, body: { ok: true, alreadyCollected: true } });
    expect(sellerRepeat.body.brainsPaid).toBeUndefined();
    expect((await bootstrap(seller)).gameplay.balance.brains)
      .toBe(sellerBefore.gameplay.balance.brains + 5);
    expect((await call<any>("GET", "/black-market/summary", seller.token)).body.heldBrains).toBe(0);
    const waiting = await call<any>("GET", "/black-market/fulfillments", buyer.token);
    expect(waiting.body.fulfillments).toEqual([
      expect.objectContaining({ id: created.body.order.id, awaitingClaim: true }),
    ]);

    const collected = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, buyer.token, {});
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body.claimed).toMatchObject({ zombieKey: "ZombieActorRegularTier1", stored: false });
    expect((await bootstrap(buyer)).gameplay.roster).toEqual([
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 4, invasions: 3, stored: false }),
    ]);
    // Collecting twice must not mint a second copy.
    const again = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, buyer.token, {});
    expect(again.status).toBe(403);
    expect((await bootstrap(buyer)).gameplay.roster).toHaveLength(1);
  });

  it("holds a purchase as an uncollectable delivery until the buyer frees a slot", async () => {
    const seller = await signIn(uniqueSub("market-full-seller"));
    const buyer = await signIn(uniqueSub("market-full-buyer"));
    const saleUnitId = `market-sale-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: saleUnitId, key: "ZombieActorRegularTier1" }]);
    const blockers = Array.from({ length: 16 }, (_, index) => ({
      id: `market-active-${index}-${crypto.randomUUID()}`,
      key: "ZombieActorGirlTier1",
      stored: false,
    }));
    await grantRoster(buyer, blockers);

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("full-create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId: saleUnitId, priceBrains: 1,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    expect(buyerBefore.gameplay.roster.filter((unit: any) => !unit.stored)).toHaveLength(16);
    // The purchase itself still goes through — the buyer pays, and the seller's brains
    // wait on the order for them to collect.
    const fulfilled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("full-fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200);
    expect((await bootstrap(buyer)).gameplay.roster).toHaveLength(16);

    // With no army slot and no Mausoleum placed, the zombie has nowhere to land, so
    // the claim is refused rather than flagged into a crypt the buyer does not own.
    const blocked = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, buyer.token, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("no_room");
    expect((await bootstrap(buyer)).gameplay.roster).toHaveLength(16);
    // It is still offered, not lost.
    const waiting = await call<any>("GET", "/black-market/fulfillments", buyer.token);
    expect(waiting.body.fulfillments).toHaveLength(1);

    const freed = await bootstrap(buyer);
    const sold = await call<any>("POST", "/commands", buyer.token, {
      protocolVersion: 3,
      deviceId: WRITER_DEVICE,
      batchId: operation("free-a-slot"),
      firstSequence: 1,
      expectedAccountVersion: freed.accountVersion,
      writerGeneration: freed.writer.generation,
      takeWriter: false,
      commands: [{ sequence: 1, command: { type: "roster.sell", unitId: blockers[0].id } }],
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(sold.body.results[0].status).toBe("applied");

    const collected = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, buyer.token, {});
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body.claimed).toMatchObject({ zombieKey: "ZombieActorRegularTier1", stored: false });
    const buyerAfter = await bootstrap(buyer);
    expect(buyerAfter.gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", stored: false }),
    ]));
    expect(buyerAfter.gameplay.roster.filter((unit: any) => unit.stored)).toHaveLength(0);
  });

  it("refunds a cancelled brain request and does not refund the daily post count", async () => {
    const requester = await signIn(uniqueSub("market-requester"));
    await grantBalance(requester, { brains: 7 });
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
    await grantBalance(requester, { brains: 2 });
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
    const delivery = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, requester.token, {});
    expect(delivery.status, JSON.stringify(delivery.body)).toBe(200);
    expect((await bootstrap(requester)).gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 128 | 8 }),
    ]));
  });

  it("refuses to cancel a sale the seller has no room to take back", async () => {
    const cancelSale = async (prefix: string, activeCount: number) => {
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
      return {
        seller,
        orderId: created.body.order.id as string,
        cancelled: await call<any>("POST", `/black-market/orders/${created.body.order.id}/cancel`, seller.token, {
          operationId: operation(`${prefix}-cancel`), expectedAccountVersion: escrowed.accountVersion,
        }),
      };
    };

    const roomy = await cancelSale("market-cancel-room", 0);
    expect(roomy.cancelled.status, JSON.stringify(roomy.cancelled.body)).toBe(200);
    expect((await bootstrap(roomy.seller)).gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "ZombieActorRegularTier1", mutation: 2, invasions: 4, stored: false,
        // The returned zombie is the seller's own, back under a new unit id. The
        // flag is how the client knows not to credit it to the Zombie Almanac.
        restored: true,
      }),
    ]));

    // A cancel hands the zombie straight back — there is no waiting card to hold it —
    // so with the army full and no Mausoleum placed the cancel itself is refused. The
    // listing survives, which is the recoverable outcome.
    const full = await cancelSale("market-cancel-full", 16);
    expect(full.cancelled).toMatchObject({ status: 409, body: { error: "no_room" } });
    const stillListed = await call<any>("GET", "/black-market/orders?kind=SELL_ZOMBIE&mine=true", full.seller.token);
    expect(stillListed.body.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: full.orderId, status: "OPEN" }),
    ]));
    expect((await bootstrap(full.seller)).gameplay.roster).toHaveLength(16);
  });

  it("carries a zombie's body tint through a listing, its card, and a cancel", async () => {
    // A Zombie Pot child's tint used to live only in the presentation blob, keyed by
    // unit id. Cancelling a sale hands the zombie back under a NEW id, so the tint
    // stopped resolving and the zombie reverted to its species' catalog colour for
    // good. It now travels with the escrowed mutation/veterancy.
    const seller = await signIn(uniqueSub("market-color"));
    const unitId = `market-color-${crypto.randomUUID()}`;
    await grantRoster(seller, [
      { id: unitId, key: "ZombieActorRegularTier1", mutation: 2, invasions: 3 },
    ]);
    const tint = [17, 34, 51];
    const presentation = await call<any>("PUT", "/presentation", seller.token, {
      protocolVersion: 3, expectedVersion: 0,
      data: { rosterLayout: [{ id: unitId, color: tint }] },
    });
    expect(presentation.status, JSON.stringify(presentation.body)).toBe(200);

    const before = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("color-create"), expectedAccountVersion: before.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 3,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // The listing card describes one concrete zombie, so it shows that zombie's colour.
    expect(created.body.order).toMatchObject({ color: tint });

    const escrowed = await bootstrap(seller);
    const cancelled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/cancel`,
      seller.token, {
        operationId: operation("color-cancel"), expectedAccountVersion: escrowed.accountVersion,
      });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const restored = (await bootstrap(seller)).gameplay.roster;
    expect(restored).toHaveLength(1);
    // A new unit id — and the same colour, which is the whole point.
    expect(restored[0].id).not.toBe(unitId);
    expect(restored[0]).toMatchObject({
      key: "ZombieActorRegularTier1", mutation: 2, invasions: 3, restored: true, color: tint,
    });
  });

  it("delivers a purchased zombie in the colour the buyer saw on its card", async () => {
    const seller = await signIn(uniqueSub("market-color-sale-seller"));
    const buyer = await signIn(uniqueSub("market-color-sale-buyer"));
    await grantBalance(buyer, { brains: 5 });
    const unitId = `market-color-sale-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1", mutation: 4 }]);
    const tint = [200, 120, 40];
    await call<any>("PUT", "/presentation", seller.token, {
      protocolVersion: 3, expectedVersion: 0,
      data: { rosterLayout: [{ id: unitId, color: tint }] },
    });

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("color-sale-create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 5,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    const filled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`,
      buyer.token, {
        operationId: operation("color-sale-fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
      });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);

    // The delivery card the buyer collects from carries the colour too.
    const owed = await call<any>("GET", "/black-market/fulfillments", buyer.token);
    expect(owed.body.fulfillments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.order.id, color: tint }),
    ]));

    await bootstrap(buyer);
    const collected = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`,
      buyer.token, {});
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect((await bootstrap(buyer)).gameplay.roster).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ZombieActorRegularTier1", mutation: 4, color: tint }),
    ]));
  });

  it("surfaces a fulfilled post to its creator until collected", async () => {
    const seller = await signIn(uniqueSub("market-collect-seller"));
    const buyer = await signIn(uniqueSub("market-collect-buyer"));
    await grantBalance(buyer, { brains: 5 });
    const unitId = `market-collect-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1", mutation: 4, invasions: 2 }]);

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("collect-create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 5,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const orderId = created.body.order.id;

    // Nothing to collect while the post is still open, and an open post can't be collected.
    const empty = await call<any>("GET", "/black-market/fulfillments", seller.token);
    expect(empty.status).toBe(200);
    expect(empty.body.fulfillments).toEqual([]);
    const early = await call<any>("POST", `/black-market/orders/${orderId}/collect`, seller.token, {});
    expect(early).toMatchObject({ status: 409, body: { error: "order_not_fulfilled" } });

    const buyerBefore = await bootstrap(buyer);
    const fulfilled = await call<any>("POST", `/black-market/orders/${orderId}/fulfill`, buyer.token, {
      operationId: operation("collect-fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200);

    // BOTH sides hold a card for the same order: the seller's owes them the brains,
    // the buyer's still owes them the zombie. The two flags are independent, so one
    // collecting cannot dismiss the other's.
    const pending = await call<any>("GET", "/black-market/fulfillments", seller.token);
    expect(pending.status).toBe(200);
    expect(pending.body.fulfillments).toHaveLength(1);
    expect(pending.body.fulfillments[0]).toMatchObject({
      id: orderId, kind: "SELL_ZOMBIE", zombieKey: "ZombieActorRegularTier1",
      mutated: true, mutation: 4, invasions: 2, priceBrains: 5, awaitingPayout: true,
    });
    expect(pending.body.fulfillments[0].awaitingClaim).toBeUndefined();
    const buyerPending = await call<any>("GET", "/black-market/fulfillments", buyer.token);
    expect(buyerPending.body.fulfillments).toEqual([
      expect.objectContaining({ id: orderId, awaitingClaim: true }),
    ]);

    const collected = await call<any>("POST", `/black-market/orders/${orderId}/collect`, seller.token, {});
    expect(collected).toMatchObject({
      status: 200, body: { ok: true, alreadyCollected: false, brainsPaid: 5 },
    });
    expect(collected.body.claimed).toBeUndefined();
    const again = await call<any>("POST", `/black-market/orders/${orderId}/collect`, seller.token, {});
    expect(again).toMatchObject({ status: 200, body: { ok: true, alreadyCollected: true } });
    expect((await call<any>("GET", "/black-market/fulfillments", seller.token)).body.fulfillments).toEqual([]);
    // The seller collecting their brains left the buyer's delivery untouched.
    expect((await call<any>("GET", "/black-market/fulfillments", buyer.token)).body.fulfillments)
      .toHaveLength(1);
    const delivered = await call<any>("POST", `/black-market/orders/${orderId}/collect`, buyer.token, {});
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.claimed).toMatchObject({ zombieKey: "ZombieActorRegularTier1", stored: false });
    // Once claimed, a non-creator has no further business with the order.
    const foreign = await call<any>("POST", `/black-market/orders/${orderId}/collect`, buyer.token, {});
    expect(foreign).toMatchObject({ status: 403, body: { error: "not_order_owner" } });
  });

  it("surfaces a filled request to the requester with the fulfiller's delivery", async () => {
    const requester = await signIn(uniqueSub("market-collect-requester"));
    const filler = await signIn(uniqueSub("market-collect-filler"));
    await grantBalance(requester, { brains: 9 });
    const plainUnitId = `market-collect-offer-${crypto.randomUUID()}`;
    const mutatedUnitId = `market-collect-mutant-${crypto.randomUUID()}`;
    await grantRoster(filler, [
      { id: plainUnitId, key: "ZombieActorRegularTier1" },
      { id: mutatedUnitId, key: "ZombieActorRegularTier1", mutation: 8 | 128, invasions: 3 },
    ]);

    // The delivered unit — not the request's wording — is what the requester must be
    // told about, so the collect notice carries that unit's mutations either way.
    const fillRequest = async (label: string, mutated: boolean, unitId: string, priceBrains: number) => {
      const requesterBefore = await bootstrap(requester);
      const created = await call<any>("POST", "/black-market/orders", requester.token, {
        operationId: operation(`collect-request-${label}`),
        expectedAccountVersion: requesterBefore.accountVersion,
        kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated, priceBrains,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const fillerBefore = await bootstrap(filler);
      const fulfilled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, filler.token, {
        operationId: operation(`collect-fill-${label}`),
        expectedAccountVersion: fillerBefore.accountVersion, unitId,
      });
      expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200);
      return created.body.order.id as string;
    };

    const plainOrderId = await fillRequest("plain", false, plainUnitId, 3);
    const pending = await call<any>("GET", "/black-market/fulfillments", requester.token);
    expect(pending.body.fulfillments).toHaveLength(1);
    expect(pending.body.fulfillments[0]).toMatchObject({
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", priceBrains: 3,
      mutation: 0, invasions: 0,
    });
    const collected = await call<any>("POST", `/black-market/orders/${plainOrderId}/collect`, requester.token, {});
    expect(collected).toMatchObject({ status: 200, body: { ok: true, alreadyCollected: false } });

    const mutantOrderId = await fillRequest("mutant", true, mutatedUnitId, 5);
    const mutantPending = await call<any>("GET", "/black-market/fulfillments", requester.token);
    expect(mutantPending.body.fulfillments).toHaveLength(1);
    expect(mutantPending.body.fulfillments[0]).toMatchObject({
      id: mutantOrderId, kind: "BUY_ZOMBIE", mutation: 8 | 128, invasions: 3,
    });
  });

  it("records completed trades in both accounts' history with lifetime stats", async () => {
    const alice = await signIn(uniqueSub("market-history-alice"));
    const bob = await signIn(uniqueSub("market-history-bob"));
    await grantBalance(alice, { brains: 20 });
    await grantBalance(bob, { brains: 20 });
    const saleUnitId = `history-sale-${crypto.randomUUID()}`;
    const offerUnitId = `history-offer-${crypto.randomUUID()}`;
    await grantRoster(alice, [{ id: saleUnitId, key: "ZombieActorRegularTier1", mutation: 4, invasions: 2 }]);
    await grantRoster(bob, [{ id: offerUnitId, key: "ZombieActorGirlTier1", mutation: 8, invasions: 1 }]);

    // Trade 1: Alice sells her mutated Regular to Bob for 7.
    const aliceBoot1 = await bootstrap(alice);
    const sale = await call<any>("POST", "/black-market/orders", alice.token, {
      operationId: operation("history-sale"), expectedAccountVersion: aliceBoot1.accountVersion,
      kind: "SELL_ZOMBIE", unitId: saleUnitId, priceBrains: 7,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const bobBoot1 = await bootstrap(bob);
    const saleDone = await call<any>("POST", `/black-market/orders/${sale.body.order.id}/fulfill`, bob.token, {
      operationId: operation("history-sale-buy"), expectedAccountVersion: bobBoot1.accountVersion,
    });
    expect(saleDone.status, JSON.stringify(saleDone.body)).toBe(200);

    // Trade 2: Alice requests a mutated Girl for 3; Bob fills it with his unit.
    const aliceBoot2 = await bootstrap(alice);
    const request = await call<any>("POST", "/black-market/orders", alice.token, {
      operationId: operation("history-request"), expectedAccountVersion: aliceBoot2.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorGirlTier1", mutated: true, priceBrains: 3,
    });
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    const bobBoot2 = await bootstrap(bob);
    const requestDone = await call<any>("POST", `/black-market/orders/${request.body.order.id}/fulfill`, bob.token, {
      operationId: operation("history-request-fill"), expectedAccountVersion: bobBoot2.accountVersion,
      unitId: offerUnitId,
    });
    expect(requestDone.status, JSON.stringify(requestDone.body)).toBe(200);

    const aliceHistory = await call<any>("GET", "/black-market/history", alice.token);
    expect(aliceHistory.status).toBe(200);
    expect(aliceHistory.body.stats).toMatchObject({
      sold: { count: 1, brains: 7, best: { zombieKey: "ZombieActorRegularTier1", priceBrains: 7, mutation: 4 } },
      bought: { count: 1, brains: 3 },
    });
    expect(aliceHistory.body.entries).toHaveLength(2);
    const aliceSale = aliceHistory.body.entries.find((entry: any) => entry.kind === "SELL_ZOMBIE");
    expect(aliceSale).toMatchObject({
      mine: true, earned: true, zombieKey: "ZombieActorRegularTier1",
      mutation: 4, invasions: 2, priceBrains: 7,
    });
    // The delivered unit is stamped on a filled request too, so the requester's
    // ledger shows what actually arrived.
    const aliceRequest = aliceHistory.body.entries.find((entry: any) => entry.kind === "BUY_ZOMBIE");
    expect(aliceRequest).toMatchObject({
      mine: true, earned: false, zombieKey: "ZombieActorGirlTier1",
      mutation: 8, invasions: 1, priceBrains: 3,
    });

    const bobHistory = await call<any>("GET", "/black-market/history", bob.token);
    expect(bobHistory.status).toBe(200);
    expect(bobHistory.body.stats).toMatchObject({
      sold: { count: 1, brains: 3, best: { zombieKey: "ZombieActorGirlTier1", priceBrains: 3, mutation: 8 } },
      bought: { count: 1, brains: 7 },
    });
    const bobBuy = bobHistory.body.entries.find((entry: any) => entry.kind === "SELL_ZOMBIE");
    expect(bobBuy).toMatchObject({ mine: false, earned: false, priceBrains: 7 });
    const bobFill = bobHistory.body.entries.find((entry: any) => entry.kind === "BUY_ZOMBIE");
    expect(bobFill).toMatchObject({ mine: false, earned: true, priceBrains: 3 });
  });

  it("allows exactly one winner when buyers race for a sale", async () => {
    const seller = await signIn(uniqueSub("market-race-seller"));
    const buyerA = await signIn(uniqueSub("market-race-a"));
    const buyerB = await signIn(uniqueSub("market-race-b"));
    await Promise.all([
      grantBalance(buyerA, { brains: 3 }),
      grantBalance(buyerB, { brains: 3 }),
    ]);
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

// A post carries its own currency, so every side of it — the escrow, the settlement and
// the payout — has to move the same one. These cover the gold half of that, and check
// the brains wallet stays untouched throughout (the bug a shared column would cause).
describe("Black Market gold pricing", () => {
  it("escrows, settles and pays out a gold sale without touching brains", async () => {
    const seller = await signIn(uniqueSub("market-gold-seller"));
    const buyer = await signIn(uniqueSub("market-gold-buyer"));
    await grantBalance(buyer, { gold: 9_000, brains: 4 });
    await grantBalance(seller, { gold: 100, brains: 4 });
    const unitId = `market-gold-unit-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1", mutation: 4, invasions: 2 }]);

    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("gold-create"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, price: 7_500, currency: "GOLD",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // `priceBrains` is the legacy mirror: same number, so a client cached from before
    // gold posts still renders one.
    expect(created.body.order).toMatchObject({
      kind: "SELL_ZOMBIE", price: 7_500, currency: "GOLD", priceBrains: 7_500,
    });

    const buyerBefore = await bootstrap(buyer);
    const fulfilled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("gold-fulfill"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200);

    const buyerAfter = await bootstrap(buyer);
    expect(buyerAfter.gameplay.balance.gold).toBe(buyerBefore.gameplay.balance.gold - 7_500);
    expect(buyerAfter.gameplay.balance.brains).toBe(buyerBefore.gameplay.balance.brains);
    // The seller is paid by their own collect, and it is GOLD that waits for them.
    expect((await bootstrap(seller)).gameplay.balance.gold).toBe(sellerBefore.gameplay.balance.gold);
    const summary = await call<any>("GET", "/black-market/summary", seller.token);
    expect(summary.body).toMatchObject({ heldGold: 7_500, heldBrains: 0 });
    const card = await call<any>("GET", "/black-market/fulfillments", seller.token);
    expect(card.body.fulfillments).toEqual([
      expect.objectContaining({ price: 7_500, currency: "GOLD", awaitingPayout: true }),
    ]);

    const paid = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, seller.token, {});
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.goldPaid).toBe(7_500);
    expect(paid.body.brainsPaid).toBeUndefined();
    const sellerAfter = await bootstrap(seller);
    expect(sellerAfter.gameplay.balance.gold).toBe(sellerBefore.gameplay.balance.gold + 7_500);
    expect(sellerAfter.gameplay.balance.brains).toBe(sellerBefore.gameplay.balance.brains);
    // Collecting again pays nothing more.
    const repeat = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, seller.token, {});
    expect(repeat).toMatchObject({ status: 200, body: { ok: true, alreadyCollected: true } });
    expect(repeat.body.goldPaid).toBeUndefined();
    expect((await bootstrap(seller)).gameplay.balance.gold)
      .toBe(sellerBefore.gameplay.balance.gold + 7_500);

    // The ledger reports the trade in its own currency, and keeps the two apart.
    const history = await call<any>("GET", "/black-market/history", seller.token);
    expect(history.body.stats.sold).toMatchObject({
      count: 1, gold: 7_500, brains: 0,
      best: null,
      bestGold: { zombieKey: "ZombieActorRegularTier1", price: 7_500, currency: "GOLD", mutation: 4 },
    });
    expect(history.body.entries[0]).toMatchObject({ earned: true, price: 7_500, currency: "GOLD" });
    const buyerHistory = await call<any>("GET", "/black-market/history", buyer.token);
    expect(buyerHistory.body.stats.bought).toMatchObject({ count: 1, gold: 7_500, brains: 0 });
  });

  it("escrows a gold request, refunds it in gold, and pays a filler in gold", async () => {
    const requester = await signIn(uniqueSub("market-gold-requester"));
    const filler = await signIn(uniqueSub("market-gold-filler"));
    await grantBalance(requester, { gold: 20_000 });
    await grantBalance(filler, { gold: 50 });
    const offeredId = `market-gold-offer-${crypto.randomUUID()}`;
    await grantRoster(filler, [{ id: offeredId, key: "ZombieActorRegularTier1" }]);

    // Cancelled: the escrowed gold comes back to the wallet it left.
    const before = await bootstrap(requester);
    const scrapped = await call<any>("POST", "/black-market/orders", requester.token, {
      operationId: operation("gold-request-cancelled"), expectedAccountVersion: before.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 3_000, currency: "GOLD",
    });
    expect(scrapped.status, JSON.stringify(scrapped.body)).toBe(200);
    expect((await bootstrap(requester)).gameplay.balance.gold)
      .toBe(before.gameplay.balance.gold - 3_000);
    const cancelled = await call<any>("POST", `/black-market/orders/${scrapped.body.order.id}/cancel`, requester.token, {
      operationId: operation("gold-request-cancel"),
      expectedAccountVersion: (await bootstrap(requester)).accountVersion,
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await bootstrap(requester)).gameplay.balance.gold).toBe(before.gameplay.balance.gold);

    // Filled: the fulfiller is paid inside the settlement batch, in gold.
    const posting = await bootstrap(requester);
    const created = await call<any>("POST", "/black-market/orders", requester.token, {
      operationId: operation("gold-request"), expectedAccountVersion: posting.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 4_200, currency: "GOLD",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const fillerBefore = await bootstrap(filler);
    const filled = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, filler.token, {
      operationId: operation("gold-fill"), expectedAccountVersion: fillerBefore.accountVersion,
      unitId: offeredId,
    });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    const fillerAfter = await bootstrap(filler);
    expect(fillerAfter.gameplay.balance.gold).toBe(fillerBefore.gameplay.balance.gold + 4_200);
    expect(fillerAfter.gameplay.balance.brains).toBe(fillerBefore.gameplay.balance.brains);
    expect(fillerAfter.gameplay.roster).toHaveLength(0);

    const collected = await call<any>("POST", `/black-market/orders/${created.body.order.id}/collect`, requester.token, {});
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body.claimed).toMatchObject({ zombieKey: "ZombieActorRegularTier1" });
  });

  it("checks the gold wallet, not the brains one, before escrowing a gold request", async () => {
    const poor = await signIn(uniqueSub("market-gold-poor"));
    // Plenty of brains, nowhere near enough gold: the old code would have let this pass.
    await grantBalance(poor, { gold: 10, brains: 5_000 });
    const before = await bootstrap(poor);
    const refused = await call<any>("POST", "/black-market/orders", poor.token, {
      operationId: operation("gold-broke"), expectedAccountVersion: before.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 1_000, currency: "GOLD",
    });
    expect(refused).toMatchObject({ status: 409, body: { error: "insufficient_gold" } });
    expect((await bootstrap(poor)).gameplay.balance.brains).toBe(before.gameplay.balance.brains);
  });

  it("refuses a buyer who cannot afford a gold sale, and never moves their brains", async () => {
    const seller = await signIn(uniqueSub("market-gold-rich-seller"));
    const buyer = await signIn(uniqueSub("market-gold-broke-buyer"));
    await grantBalance(buyer, { gold: 100, brains: 5_000 });
    const unitId = `market-gold-pricey-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1" }]);
    const sellerBefore = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("gold-pricey"), expectedAccountVersion: sellerBefore.accountVersion,
      kind: "SELL_ZOMBIE", unitId, price: 900_000, currency: "GOLD",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const buyerBefore = await bootstrap(buyer);
    const refused = await call<any>("POST", `/black-market/orders/${created.body.order.id}/fulfill`, buyer.token, {
      operationId: operation("gold-pricey-buy"), expectedAccountVersion: buyerBefore.accountVersion,
    });
    expect(refused).toMatchObject({ status: 409, body: { error: "insufficient_gold" } });
    const buyerAfter = await bootstrap(buyer);
    expect(buyerAfter.gameplay.balance.brains).toBe(buyerBefore.gameplay.balance.brains);
    expect(buyerAfter.gameplay.balance.gold).toBe(buyerBefore.gameplay.balance.gold);
  });

  it("accepts any price from 1 to 10,000,000 and nothing outside it", async () => {
    const poster = await signIn(uniqueSub("market-gold-range"));
    await grantBalance(poster, { gold: 100_000_000 });
    const post = async (label: string, price: unknown, currency = "GOLD") => {
      const state = await bootstrap(poster);
      return call<any>("POST", "/black-market/orders", poster.token, {
        operationId: operation(label), expectedAccountVersion: state.accountVersion,
        kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
        price, currency,
      });
    };

    expect((await post("range-min", 1)).status).toBe(200);
    expect((await post("range-max", 10_000_000)).status).toBe(200);
    expect(await post("range-over", 10_000_001)).toMatchObject({
      status: 400, body: { error: "bad_market_order" },
    });
    expect(await post("range-zero", 0)).toMatchObject({ status: 400 });
    expect(await post("range-fraction", 1.5)).toMatchObject({ status: 400 });
    // A currency the market does not have is a clean 400, never a silent fallback to
    // whichever wallet happens to be first.
    expect(await post("range-currency", 5, "DOUBLOONS")).toMatchObject({
      status: 400, body: { error: "bad_market_order" },
    });
  });

  it("browses one currency at a time, and defaults an old client's post to brains", async () => {
    const seller = await signIn(uniqueSub("market-currency-browse"));
    const goldUnit = `market-browse-gold-${crypto.randomUUID()}`;
    const brainUnit = `market-browse-brains-${crypto.randomUUID()}`;
    const legacyUnit = `market-browse-legacy-${crypto.randomUUID()}`;
    await grantRoster(seller, [
      { id: goldUnit, key: "ZombieActorRegularTier1" },
      { id: brainUnit, key: "ZombieActorGirlTier1" },
      { id: legacyUnit, key: "ZombieActorGardenTier1" },
    ]);
    const posts = [
      { label: "browse-gold", unitId: goldUnit, body: { price: 1_200, currency: "GOLD" } },
      { label: "browse-brains", unitId: brainUnit, body: { price: 3, currency: "BRAINS" } },
      // No currency at all: exactly what a client cached from before gold sends.
      { label: "browse-legacy", unitId: legacyUnit, body: { priceBrains: 2 } },
    ];
    for (const post of posts) {
      const state = await bootstrap(seller);
      const created = await call<any>("POST", "/black-market/orders", seller.token, {
        operationId: operation(post.label), expectedAccountVersion: state.accountVersion,
        kind: "SELL_ZOMBIE", unitId: post.unitId, ...post.body,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
    }

    const browse = async (params: string) => {
      const result = await call<any>("GET",
        `/black-market/orders?kind=SELL_ZOMBIE&mine=true${params}`, seller.token);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return (result.body.orders as Array<{ zombieKey: string }>)
        .map((order) => order.zombieKey).sort();
    };

    expect(await browse("&currency=GOLD")).toEqual(["ZombieActorRegularTier1"]);
    expect(await browse("&currency=BRAINS"))
      .toEqual(["ZombieActorGardenTier1", "ZombieActorGirlTier1"]);
    expect(await browse("")).toHaveLength(3);
  });

  // ---- expiry + repost ------------------------------------------------------
  // Both rules read one column, `created_at`, so the fixture that ages a post is the
  // only lever either of them needs.

  it("takes an expired sale off the board and hands the zombie back", async () => {
    const seller = await signIn(uniqueSub("market-expiry-sale"));
    const unitId = `market-expire-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1" }]);
    const before = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("expire-create"), expectedAccountVersion: before.accountVersion,
      kind: "SELL_ZOMBIE", unitId, price: 5, currency: "BRAINS",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // The post advertises its own deadline, three days out.
    expect(created.body.order.expiresAt - created.body.order.createdAt).toBe(3 * 86_400_000);
    const orderId = created.body.order.id as string;

    const aged = await call<any>("POST", "/dev/fixture/market-backdate", seller.token,
      { orderId, ageMs: 3 * 86_400_000 + 60_000 });
    expect(aged.status, JSON.stringify(aged.body)).toBe(200);

    // A stale post is gone from the board and stops holding an active-post slot...
    const board = await call<any>("GET", "/black-market/orders?kind=SELL_ZOMBIE&mine=true", seller.token);
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect((board.body.orders as Array<{ id: string }>).map((order) => order.id)).not.toContain(orderId);
    expect(board.body.summary.activePosts).toBe(0);

    // ...and the escrowed zombie is back in the roster under a fresh id, exactly as a
    // cancel would have returned it. Nothing about an expiry costs the player anything.
    const after = await bootstrap(seller);
    const restored = (after.gameplay.roster as Array<{ zombieKey?: string; key?: string }>)
      .filter((unit) => (unit.key ?? unit.zombieKey) === "ZombieActorRegularTier1");
    expect(restored).toHaveLength(1);
  });

  it("refunds an expired request's escrowed payment", async () => {
    const buyer = await signIn(uniqueSub("market-expiry-request"));
    await grantBalance(buyer, { brains: 40 });
    const before = await bootstrap(buyer);
    const created = await call<any>("POST", "/black-market/orders", buyer.token, {
      operationId: operation("expire-request"), expectedAccountVersion: before.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 7, currency: "BRAINS",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const escrowed = await bootstrap(buyer);
    expect(escrowed.gameplay.balance.brains).toBe(33); // 40 held, 7 in escrow

    await call<any>("POST", "/dev/fixture/market-backdate", buyer.token,
      { orderId: created.body.order.id, ageMs: 4 * 86_400_000 });
    const summary = await call<any>("GET", "/black-market/summary", buyer.token);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.activePosts).toBe(0);
    expect((await bootstrap(buyer)).gameplay.balance.brains).toBe(40);
  });

  it("bumps a post to the top once it is old enough, and not before", async () => {
    const poster = await signIn(uniqueSub("market-repost"));
    await grantBalance(poster, { brains: 20 });
    const before = await bootstrap(poster);
    const created = await call<any>("POST", "/black-market/orders", poster.token, {
      operationId: operation("repost-create"), expectedAccountVersion: before.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 1, currency: "BRAINS",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const orderId = created.body.order.id as string;
    expect(created.body.order.repostableAt - created.body.order.createdAt).toBe(6 * 3_600_000);

    // Fresh: the cooldown is the whole point, so a just-made post cannot be bumped.
    const tooSoon = await call<any>("POST", `/black-market/orders/${orderId}/repost`, poster.token, {});
    expect(tooSoon).toMatchObject({ status: 409, body: { error: "repost_cooldown" } });

    await call<any>("POST", "/dev/fixture/market-backdate", poster.token,
      { orderId, ageMs: 7 * 3_600_000 });
    const bumped = await call<any>("POST", `/black-market/orders/${orderId}/repost`, poster.token, {});
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    // The bump re-dates the post: it leads "newest" again AND its three days restart.
    expect(bumped.body.order.createdAt).toBeGreaterThan(created.body.order.createdAt);
    expect(bumped.body.order.expiresAt).toBeGreaterThan(created.body.order.expiresAt);

    // And immediately afterwards it is on cooldown again — no spamming the front page.
    const again = await call<any>("POST", `/black-market/orders/${orderId}/repost`, poster.token, {});
    expect(again).toMatchObject({ status: 409, body: { error: "repost_cooldown" } });
  });

  it("refuses to bump a post that is not the caller's, or already stale", async () => {
    const owner = await signIn(uniqueSub("market-repost-owner"));
    const stranger = await signIn(uniqueSub("market-repost-stranger"));
    await grantBalance(owner, { brains: 20 });
    const before = await bootstrap(owner);
    const created = await call<any>("POST", "/black-market/orders", owner.token, {
      operationId: operation("repost-guard"), expectedAccountVersion: before.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 1, currency: "BRAINS",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const orderId = created.body.order.id as string;

    const notMine = await call<any>("POST", `/black-market/orders/${orderId}/repost`, stranger.token, {});
    expect(notMine).toMatchObject({ status: 403, body: { error: "not_order_owner" } });

    // Past its life, a post belongs to the sweep that returns its escrow — bumping it
    // would resurrect a listing the board stopped showing days ago.
    await call<any>("POST", "/dev/fixture/market-backdate", owner.token,
      { orderId, ageMs: 5 * 86_400_000 });
    const dead = await call<any>("POST", `/black-market/orders/${orderId}/repost`, owner.token, {});
    expect(dead).toMatchObject({ status: 409, body: { error: "order_expired" } });
  });

  it("still lists an expired sale to its owner when there is nowhere to return it", async () => {
    // The sweep refuses to force-deliver a zombie into a farm and crypt that are both
    // full, so that one post stays OPEN past its life. It must remain visible on the
    // owner's own board: otherwise their zombie is in no roster, on no board and
    // behind no button, and reads as lost. (Everyone else stops seeing it either way.)
    const seller = await signIn(uniqueSub("market-expiry-stuck"));
    const stranger = await signIn(uniqueSub("market-expiry-stuck-watcher"));
    // 17 units: one goes into escrow, and the 16 left over fill the army cap. With no
    // Mausoleum placed the crypt holds nothing, so there is no second destination.
    // 17 ACTIVE units (the fixture stores them by default): one goes into escrow, and
    // the 16 left over fill the army cap. With no Mausoleum placed the crypt holds
    // nothing, so there is no second destination for the zombie to come home to.
    const units = Array.from({ length: 17 }, (_, index) => ({
      id: `stuck-${index}-${crypto.randomUUID()}`,
      key: "ZombieActorRegularTier1",
      stored: false,
    }));
    await grantRoster(seller, units);
    const before = await bootstrap(seller);
    const created = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: operation("stuck-create"), expectedAccountVersion: before.accountVersion,
      kind: "SELL_ZOMBIE", unitId: units[0].id, price: 3, currency: "BRAINS",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const orderId = created.body.order.id as string;
    await call<any>("POST", "/dev/fixture/market-backdate", seller.token,
      { orderId, ageMs: 4 * 86_400_000 });

    const mine = await call<any>("GET",
      "/black-market/orders?kind=SELL_ZOMBIE&mine=true", seller.token);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const stuck = (mine.body.orders as any[]).find((order) => order.id === orderId);
    expect(stuck, "an unreturnable expired sale must stay on its owner's board").toBeTruthy();
    expect(stuck.expiresAt).toBeLessThanOrEqual(mine.body.summary.serverTime);
    // It holds no active-post slot, and it cannot be bumped back onto the front page.
    expect(mine.body.summary.activePosts).toBe(0);
    const bump = await call<any>("POST", `/black-market/orders/${orderId}/repost`, seller.token, {});
    expect(bump).toMatchObject({ status: 409, body: { error: "order_expired" } });

    // Nobody else sees it.
    const theirs = await call<any>("GET", "/black-market/orders?kind=SELL_ZOMBIE", stranger.token);
    expect((theirs.body.orders as any[]).some((order) => order.id === orderId)).toBe(false);

    // The card's Cancel Post button is the escape hatch, and it says exactly what is
    // wrong rather than failing silently — the same answer a manual cancel has always
    // given when there is nowhere to put the zombie.
    const boot = await bootstrap(seller);
    const cancelled = await call<any>("POST", `/black-market/orders/${orderId}/cancel`, seller.token,
      { operationId: operation("stuck-cancel"), expectedAccountVersion: boot.accountVersion });
    expect(cancelled).toMatchObject({ status: 409, body: { error: "no_room" } });
  });

  it("does not reject a new post because another one just expired", async () => {
    // Regression: the create route used to sweep first. The sweep bumps
    // account_version, and create() CAS-checks the version the client fetched moments
    // earlier — so the very post that triggered the sweep failed with state_conflict.
    const poster = await signIn(uniqueSub("market-expiry-create"));
    await grantBalance(poster, { brains: 20 });
    const first = await bootstrap(poster);
    const stale = await call<any>("POST", "/black-market/orders", poster.token, {
      operationId: operation("expiry-create-stale"), expectedAccountVersion: first.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 1, currency: "BRAINS",
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    await call<any>("POST", "/dev/fixture/market-backdate", poster.token,
      { orderId: stale.body.order.id, ageMs: 4 * 86_400_000 });

    const boot = await bootstrap(poster);
    const fresh = await call<any>("POST", "/black-market/orders", poster.token, {
      operationId: operation("expiry-create-fresh"), expectedAccountVersion: boot.accountVersion,
      kind: "BUY_ZOMBIE", zombieKey: "ZombieActorRegularTier1", mutated: false,
      price: 1, currency: "BRAINS",
    });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  });
});
