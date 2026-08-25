// Self-service account deletion, end to end against the real Worker.
//
// The three properties worth proving, because each is a way the feature could look
// like it worked and not have:
//   1. the account and its rows are actually GONE — not blanked, not orphaned;
//   2. signing in again produces a genuinely NEW account rather than the old one
//      coming back, which is what "start again completely fresh" has to mean; and
//   3. it refuses rather than taking another player's property with it.
import { describe, expect, it } from "vitest";
import {
  befriend, call, grantBalance, grantLevel, grantRoster, signIn, uniqueSub,
} from "./helpers";
import { BLACK_MARKET_MIN_LEVEL } from "../../../src/blackMarketRules";

describe("POST /account/delete", () => {
  it("refuses without the explicit confirmation token", async () => {
    const session = await signIn(uniqueSub("delete-unconfirmed"));
    const refused = await call<any>("POST", "/account/delete", session.token, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("confirm_required");

    // Still usable afterwards — a refused delete must not half-happen.
    const alive = await call<any>("POST", "/bootstrap", session.token, {});
    expect(alive.status).toBe(200);
  });

  it("requires authentication", async () => {
    const anonymous = await call<any>("POST", "/account/delete", "", { confirm: "DELETE" });
    expect(anonymous.status).toBe(401);
  });

  it("deletes the account, and its token stops working immediately", async () => {
    const sub = uniqueSub("delete-fresh-start");
    const session = await signIn(sub);
    await grantBalance(session, { gold: 5_000, brains: 40, xp: 900 });
    await grantRoster(session, [{ id: "doomed-zombie", key: "ZombieActorRegularTier1", stored: false }]);

    const before = await call<any>("POST", "/bootstrap", session.token, {});
    expect(before.status).toBe(200);
    expect(before.body.gameplay.balance.gold).toBe(5_000);
    const oldAccountFriendCode = session.friendCode;

    const deleted = await call<any>("POST", "/account/delete", session.token, { confirm: "DELETE" });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.ok).toBe(true);
    // Every reference actioned plus the account row itself — the count is derived
    // from the schema, so it is asserted as "a lot", not as a number that would go
    // stale with the next migration.
    expect(deleted.body.statements).toBeGreaterThan(40);

    // The session row went with the account, so the token it minted is now worthless.
    const afterwards = await call<any>("POST", "/bootstrap", session.token, {});
    expect(afterwards.status).toBe(401);

    // THE POINT OF THE FEATURE: the same Google id signs in to a brand-new account.
    const reborn = await signIn(sub);
    const fresh = await call<any>("POST", "/bootstrap", reborn.token, {});
    expect(fresh.status).toBe(200);
    expect(fresh.body.gameplay.balance.gold).not.toBe(5_000);
    expect(fresh.body.gameplay.balance.xp).toBe(0);
    expect(fresh.body.gameplay.roster ?? []).toHaveLength(0);
    expect(reborn.friendCode).not.toBe(oldAccountFriendCode);
  });

  it("takes the deleted player out of a friend's list rather than leaving a ghost", async () => {
    const leaver = await signIn(uniqueSub("delete-friend-leaver"));
    const stays = await signIn(uniqueSub("delete-friend-stays"));
    await befriend(leaver, stays);

    const paired = await call<unknown[]>("GET", "/friends", stays.token);
    expect(paired.body).toHaveLength(1);

    const deleted = await call<any>("POST", "/account/delete", leaver.token, { confirm: "DELETE" });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

    // The friendship row referenced the deleted account on its `b_id` side; both
    // sides are actioned, so the survivor is left with a clean list and not a row
    // pointing at an account that no longer exists.
    const alone = await call<unknown[]>("GET", "/friends", stays.token);
    expect(alone.status).toBe(200);
    expect(alone.body).toHaveLength(0);

    // And the survivor's own farm is untouched.
    const survivor = await call<any>("POST", "/bootstrap", stays.token, {});
    expect(survivor.status).toBe(200);
  });

  // PROPERTY 3, end to end. A player's orders cascade away with their account, so
  // leaving mid-trade would delete a zombie the BUYER has paid for and not yet
  // collected. The guard is one SQL predicate (unit-tested in
  // ../accountDeletionGuards.test.ts); this proves the route actually consults it,
  // that the refusal leaves the account completely intact, and that finishing the
  // trade clears the way — a refusal a player cannot resolve would be a trap.
  it("refuses to leave a counterparty mid-trade, and relents once the trade settles", async () => {
    const seller = await signIn(uniqueSub("delete-market-seller"));
    const buyer = await signIn(uniqueSub("delete-market-buyer"));
    await grantLevel(seller, BLACK_MARKET_MIN_LEVEL);
    await grantBalance(buyer, { brains: 500, xp: 0 });
    await grantLevel(buyer, BLACK_MARKET_MIN_LEVEL);

    const unitId = `delete-market-${crypto.randomUUID()}`;
    await grantRoster(seller, [{ id: unitId, key: "ZombieActorRegularTier1" }]);

    const sellerBoot = await call<any>("POST", "/bootstrap", seller.token, {});
    const listing = await call<any>("POST", "/black-market/orders", seller.token, {
      operationId: `delete-listing-${crypto.randomUUID()}`,
      expectedAccountVersion: sellerBoot.body.accountVersion,
      kind: "SELL_ZOMBIE", unitId, priceBrains: 1,
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);

    // An OPEN post is already enough: it is holding the seller's escrowed zombie.
    const withOpenPost = await call<any>("POST", "/account/delete", seller.token, { confirm: "DELETE" });
    expect(withOpenPost.status).toBe(409);
    expect(withOpenPost.body.error).toBe("market_unsettled");
    expect(withOpenPost.body.orders).toBeGreaterThan(0);

    // A REFUSED delete must not half-happen — the seller is still fully signed in.
    const stillThere = await call<any>("POST", "/bootstrap", seller.token, {});
    expect(stillThere.status).toBe(200);

    const buyerBoot = await call<any>("POST", "/bootstrap", buyer.token, {});
    const bought = await call<any>(
      "POST", `/black-market/orders/${listing.body.order.id}/fulfill`, buyer.token,
      {
        operationId: `delete-fulfill-${crypto.randomUUID()}`,
        expectedAccountVersion: buyerBoot.body.accountVersion,
      }
    );
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);

    // Still refused, and now for the reason that actually matters: the sale settled,
    // but the zombie is waiting on the order for the buyer to collect. Deleting here
    // would cascade the order — and the buyer's paid-for zombie — out of existence.
    const beforeClaim = await call<any>("POST", "/account/delete", seller.token, { confirm: "DELETE" });
    expect(beforeClaim.status).toBe(409);
    expect(beforeClaim.body.error).toBe("market_unsettled");

    // The buyer collects; nothing is owed to anybody, and the seller may leave.
    const claimed = await call<any>(
      "POST", `/black-market/orders/${listing.body.order.id}/collect`, buyer.token, {}
    );
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);

    const allowed = await call<any>("POST", "/account/delete", seller.token, { confirm: "DELETE" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    // And the buyer keeps what they bought — the whole point of having refused.
    const buyerAfter = await call<any>("POST", "/bootstrap", buyer.token, {});
    expect(buyerAfter.status).toBe(200);
    expect(buyerAfter.body.gameplay.roster.length).toBeGreaterThan(0);
  });
});
