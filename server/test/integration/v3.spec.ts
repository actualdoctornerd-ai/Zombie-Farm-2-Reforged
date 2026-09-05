import { describe, expect, it } from "vitest";
import {
  befriend, call, commandBody, currentIntegrityHeaders, DEVICE_A, grantBalance, grantFallen,
  grantRoster, signIn, uniqueSub, xpForLevel,
} from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import { epicBossById } from "../../../src/epicBoss/catalog";
import { EPIC_BOSS_FIGHT_BRAIN_COST } from "../../../src/epicBoss/tokens";

const deviceA = DEVICE_A;

/** What activating Loco Locust actually costs, read from the same catalog the Worker
 *  charges from. Balance work re-prices these (they now ramp 3-5 brains with the unlock
 *  ladder), and a literal here turns every re-price into a red integration suite. */
const LOCUST_BRAINS = epicBossById("loco-locust")!.costBrains;

describe("protocol v3 API", () => {
  it("persists a level-up invasion cooldown reset in the command transaction", async () => {
    const session = await signIn(uniqueSub("level-cooldown-reset"));
    await grantBalance(session, { xp: 24 });
    await grantRoster(session, [{
      id: "level-reset-zombie", key: "ZombieActorRegularTier1", stored: false,
    }]);

    const started = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: ["level-reset-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.lastRaidAt).toBeGreaterThan(0);

    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    const before = await call<any>("POST", "/bootstrap", session.token, {});
    const leveled = await call<any>("POST", "/commands", session.token,
      commandBody(before.body, "level-cooldown-reset-batch", 1, [
        { type: "farm.plow", oc: 0, or: 0 },
      ]));
    expect(leveled.status, JSON.stringify(leveled.body)).toBe(200);
    expect(leveled.body.gameplay.balance.xp).toBe(25);
    expect(leveled.body.gameplay.raids.lastRaidAt).toBe(0);

    const after = await call<any>("POST", "/bootstrap", session.token, {});
    expect(after.body.gameplay.raids.lastRaidAt).toBe(0);

    const immediate = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: ["level-reset-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(immediate.status, JSON.stringify(immediate.body)).toBe(200);
  });

  it("remembers which parent was in Zombie Pot slot 1 across the hour it runs", async () => {
    const session = await signIn(uniqueSub("pot-slot-order"));
    await grantRoster(session, [
      // Reserved in creation order, which is the order the roster projection returns —
      // and the order a client that rebuilt its Pot job used to send back at collect.
      { id: "pot-slot-older", key: "ZombieActorRegularTier1", mutation: 8, stored: false },
      { id: "pot-slot-newer", key: "ZombieActorGardenTier1", mutation: 0, stored: false },
    ]);

    const before = await call<any>("POST", "/bootstrap", session.token, {});
    const started = await call<any>("POST", "/commands", session.token,
      commandBody(before.body, "pot-slot-start", 1, [
        { type: "roster.combine_start", potId: "o1", parentAId: "pot-slot-newer", parentBId: "pot-slot-older" },
      ]));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.results[0].status).toBe("applied");

    // Re-bootstrap: the slot record has to survive the round trip through D1, not just
    // live inside the request that started the combine.
    const mid = await call<any>("POST", "/bootstrap", session.token, {});
    const collected = await call<any>("POST", "/commands", session.token,
      commandBody(mid.body, "pot-slot-collect", 2, [
        { type: "roster.combine", potId: "o1", parentAId: "pot-slot-older", parentBId: "pot-slot-newer" },
      ]));
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body.results[0].status).toBe("applied");

    const childId = collected.body.results[0].createdIds[0];
    const child = collected.body.gameplay.roster.find((unit: any) => unit.id === childId);
    // Slot 1 was the Garden Zombie, so that is the species — the reversed collect
    // command must not turn it back into a plain Zombie.
    expect(child).toMatchObject({ key: "ZombieActorGardenTier1", mutation: 8 });
  });

  it("makes two gifts free, charges 100 gold after that, and imposes NO per-day ceiling", async () => {
    const sender = await signIn(uniqueSub("gift-xp-sender"));
    await grantBalance(sender, { gold: 1300 });
    // Thirteen recipients — comfortably past the ten-a-day limit that used to apply.
    const recipients = await Promise.all(
      Array.from({ length: 13 }, () => signIn(uniqueSub("gift-xp-recipient")))
    );
    for (const recipient of recipients) await befriend(sender, recipient);

    const sends = [];
    for (const recipient of recipients) {
      sends.push(await call<any>(
        "POST", "/gifts", sender.token, { toAccountId: recipient.accountId }
      ));
    }

    expect(sends.every((send) => send.status === 200)).toBe(true);
    expect(sends[0].body).toMatchObject({ xpAwarded: 5, giftsSentToday: 1, balance: { gold: 1300, xp: 5 } });
    expect(sends[1].body).toMatchObject({ xpAwarded: 5, giftsSentToday: 2, balance: { gold: 1300, xp: 10 } });
    expect(sends[2].body).toMatchObject({ xpAwarded: 5, giftsSentToday: 3, balance: { gold: 1200, xp: 15 } });
    // The 11th, 12th and 13th sends of the day land like any other.
    expect(sends[10].body).toMatchObject({ xpAwarded: 5, giftsSentToday: 11, balance: { gold: 400, xp: 55 } });
    expect(sends[12].body).toMatchObject({ xpAwarded: 5, giftsSentToday: 13, balance: { gold: 200, xp: 65 } });

    const after = await call<any>("POST", "/bootstrap", sender.token, {});
    expect(after.body.gameplay.balance).toMatchObject({ gold: 200, xp: 65 });
    // 13 gifts sent, 11 of them charged.
    expect(1300 - after.body.gameplay.balance.gold).toBe(11 * 100);
  });

  it("refuses a second gift while the recipient still has the first unopened", async () => {
    const sender = await signIn(uniqueSub("gift-pending-sender"));
    const recipient = await signIn(uniqueSub("gift-pending-recipient"));
    await grantBalance(sender, { gold: 5000 });
    await befriend(sender, recipient);

    expect((await call("POST", "/gifts", sender.token, { toAccountId: recipient.accountId })).status).toBe(200);
    // Same day: the once-a-day rule is the one in the way, and says so.
    const sameDay = await call<any>("POST", "/gifts", sender.token, { toAccountId: recipient.accountId });
    expect(sameDay).toMatchObject({ status: 429, body: { error: "already_gifted_today" } });

    // The friends list must show the block BEFORE the player tries to send.
    const friends = await call<any[]>("GET", "/friends", sender.token);
    expect(friends.body.find((f: any) => f.accountId === recipient.accountId))
      .toMatchObject({ giftOnCooldown: true });

    // Backdating the send to yesterday clears the once-a-day rule; the unopened gift
    // must still block it, and the reason reported must switch accordingly.
    await call("POST", "/dev/fixture/gift-backdate", sender.token, { toAccountId: recipient.accountId });
    const nextDay = await call<any>("POST", "/gifts", sender.token, { toAccountId: recipient.accountId });
    expect(nextDay).toMatchObject({ status: 409, body: { error: "gift_pending" } });
    const stillBlocked = await call<any[]>("GET", "/friends", sender.token);
    expect(stillBlocked.body.find((f: any) => f.accountId === recipient.accountId))
      .toMatchObject({ giftOnCooldown: true, giftPending: true });

    // Nothing was charged for either refusal.
    expect((await call<any>("POST", "/bootstrap", sender.token, {})).body.gameplay.balance.gold).toBe(5000);

    // Once they open it, the sender is free to gift again.
    const inbox = await call<Array<{ id: string }>>("GET", "/gifts/inbox", recipient.token);
    expect((await call("POST", "/gifts/claim", recipient.token, { giftId: inbox.body[0].id })).status).toBe(200);
    expect((await call("POST", "/gifts", sender.token, { toAccountId: recipient.accountId })).status).toBe(200);
  });

  // ---- friend cap: bounds ACCEPTING, never receiving --------------------
  // A full list keeps collecting requests; only the accept is refused. The cap is 50,
  // and /dev/fixture/friends-fill seats an account on it rather than signing in fifty.
  // Asserts the seeding actually landed: friendships.b_id is a foreign key, so a
  // fixture that failed to create its placeholder accounts would leave the list EMPTY
  // and every cap assertion below would pass for the wrong reason.
  const fillFriends = async (s: { token: string }, count: number) => {
    const r = await call<any>("POST", "/dev/fixture/friends-fill", s.token, { count });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(count);
  };

  it("block tears down the friendship and refuses a gift from the blocked side", async () => {
    // Ported from the retired api.spec.ts: /friends/block was otherwise asserted nowhere.
    const a = await signIn();
    const b = await signIn();
    await befriend(a, b);
    expect((await call<unknown[]>("GET", "/friends", a.token)).body).toHaveLength(1);
    await call("POST", "/friends/block", a.token, { accountId: b.accountId });
    expect((await call<unknown[]>("GET", "/friends", a.token)).body).toHaveLength(0);
    expect((await call<unknown[]>("GET", "/friends", b.token)).body).toHaveLength(0);
    const gift = await call<{ error: string }>("POST", "/gifts", b.token, { toAccountId: a.accountId });
    expect(gift.status).toBe(403);
    // The block is one-way silent: b's re-add is swallowed by the non-oracle, not filed.
    await call("POST", "/friends/add", b.token, { code: a.friendCode });
    expect((await call<unknown[]>("GET", "/friends/requests", a.token)).body).toHaveLength(0);
  });

  it("a full account still RECEIVES requests but cannot accept them", async () => {
    const full = await signIn(uniqueSub("cap-full"));
    const asker = await signIn(uniqueSub("cap-asker"));
    await fillFriends(full, 50);

    // Receiving is untouched: the request lands in the inbox as usual.
    await call("POST", "/friends/add", asker.token, { code: full.friendCode });
    const reqs = await call<any[]>("GET", "/friends/requests", full.token);
    expect(reqs.body.map((r: any) => r.fromAccountId)).toContain(asker.accountId);

    // Only the accept is refused — and the request survives it, so nothing is lost.
    const refused = await call<any>("POST", "/friends/accept", full.token, { fromAccountId: asker.accountId });
    expect(refused).toMatchObject({ status: 409, body: { error: "friends_full" } });
    const still = await call<any[]>("GET", "/friends/requests", full.token);
    expect(still.body.map((r: any) => r.fromAccountId)).toContain(asker.accountId);
  });

  it("refuses an accept that would push the REQUESTER past the cap", async () => {
    const full = await signIn(uniqueSub("cap-req-full"));
    const other = await signIn(uniqueSub("cap-req-other"));
    // Filed while there was still room; the requester fills up while it sits pending.
    await call("POST", "/friends/add", full.token, { code: other.friendCode });
    await fillFriends(full, 50);
    const refused = await call<any>("POST", "/friends/accept", other.token, { fromAccountId: full.accountId });
    expect(refused).toMatchObject({ status: 409, body: { error: "requester_full" } });
    expect((await call<any[]>("GET", "/friends", other.token)).body).toHaveLength(0);
  });

  it("adding back someone who already asked does not bypass the cap", async () => {
    const full = await signIn(uniqueSub("cap-mutual-full"));
    const asker = await signIn(uniqueSub("cap-mutual-asker"));
    await call("POST", "/friends/add", asker.token, { code: full.friendCode });
    await fillFriends(full, 50);
    // Mutual intent normally auto-accepts; at the cap it must not, and must stay a
    // non-oracle while refusing.
    const r = await call<any>("POST", "/friends/add", full.token, { code: asker.friendCode });
    expect(r.status).toBe(200);
    expect((await call<any[]>("GET", "/friends", asker.token)).body).toHaveLength(0);
    // The request is still pending, so it works the moment room is made.
    const reqs = await call<any[]>("GET", "/friends/requests", full.token);
    expect(reqs.body.map((req: any) => req.fromAccountId)).toContain(asker.accountId);
  });

  it("accepts normally one under the cap", async () => {
    const near = await signIn(uniqueSub("cap-near"));
    const asker = await signIn(uniqueSub("cap-near-asker"));
    await fillFriends(near, 49);
    await call("POST", "/friends/add", asker.token, { code: near.friendCode });
    expect((await call("POST", "/friends/accept", near.token, { fromAccountId: asker.accountId })).status).toBe(200);
    expect((await call<any[]>("GET", "/friends", asker.token)).body).toHaveLength(1);
  });

  // The friends list carries each friend's WORN head so their row can show their
  // face. It is read with json_extract straight out of their core document, so this
  // has to run against real D1 — a mock would prove nothing about that expression.
  it("reports each friend's worn head, and follows it when they change it", async () => {
    const viewer = await signIn(uniqueSub("friend-head-viewer"));
    const friend = await signIn(uniqueSub("friend-head-owner"));
    await befriend(viewer, friend);

    const seen = () => call<any[]>("GET", "/friends", viewer.token)
      .then((r) => r.body.find((f: any) => f.accountId === friend.accountId));
    // A fresh account already wears the default head, so the face is never missing.
    expect(await seen()).toMatchObject({ headId: 1 });

    // Buy and wear the Paper Bag; the list must follow, and only the WORN slot —
    // pinning a bonus head is a gameplay choice and is not disclosed to friends.
    await grantBalance(friend, { brains: 20 });
    const boot = await call<any>("POST", "/bootstrap", friend.token, {});
    const bought = await call<any>("POST", "/commands", friend.token,
      commandBody(boot.body, "friend-head-buy", 1, [
        { type: "farmer.buy", headId: 12 },
        { type: "farmer.equip", headId: 12 },
        { type: "farmer.bonus", headId: 12 },
      ]));
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body.results.map((r: any) => r.status)).toEqual(["applied", "applied", "applied"]);

    const after = await seen();
    expect(after).toMatchObject({ headId: 12 });
    expect(after).not.toHaveProperty("farmerBonusHeadId");
  });

  it("does not send, charge, or award XP when a paid gift lacks 100 gold", async () => {
    const sender = await signIn(uniqueSub("gift-cost-sender"));
    await grantBalance(sender, { gold: 99 });
    const recipients = await Promise.all(
      Array.from({ length: 3 }, () => signIn(uniqueSub("gift-cost-recipient")))
    );
    for (const recipient of recipients) await befriend(sender, recipient);

    expect((await call<any>(
      "POST", "/gifts", sender.token, { toAccountId: recipients[0].accountId }
    )).status).toBe(200);
    expect((await call<any>(
      "POST", "/gifts", sender.token, { toAccountId: recipients[1].accountId }
    )).status).toBe(200);
    const paid = await call<any>(
      "POST", "/gifts", sender.token, { toAccountId: recipients[2].accountId }
    );

    expect(paid).toMatchObject({ status: 409, body: { error: "insufficient_gold" } });
    expect((await call<any>("GET", "/gifts/inbox", recipients[2].token)).body).toEqual([]);
    const after = await call<any>("POST", "/bootstrap", sender.token, {});
    expect(after.body.gameplay.balance).toMatchObject({ gold: 99, xp: 10 });
  });

  it("resets the invasion cooldown when gift XP crosses a level", async () => {
    const sender = await signIn(uniqueSub("gift-level-reset-sender"));
    const recipient = await signIn(uniqueSub("gift-level-reset-recipient"));
    await befriend(sender, recipient);
    await grantBalance(sender, { xp: 24 });
    await grantRoster(sender, [{
      id: "gift-level-zombie", key: "ZombieActorRegularTier1", stored: false,
    }]);

    const started = await call<any>("POST", "/raid/start", sender.token, {
      raidId: 1,
      orderedUnitIds: ["gift-level-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.lastRaidAt).toBeGreaterThan(0);

    const finished = await call<any>("POST", "/raid/finish", sender.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    const gift = await call<any>("POST", "/gifts", sender.token, {
      toAccountId: recipient.accountId,
    });
    expect(gift.status, JSON.stringify(gift.body)).toBe(200);
    expect(gift.body).toMatchObject({ balance: { xp: 29 }, lastRaidAt: 0 });

    const after = await call<any>("POST", "/bootstrap", sender.token, {});
    expect(after.body.gameplay.raids.lastRaidAt).toBe(0);

    const immediate = await call<any>("POST", "/raid/start", sender.token, {
      raidId: 1,
      orderedUnitIds: ["gift-level-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(immediate.status, JSON.stringify(immediate.body)).toBe(200);
  });

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

  it("repairs legacy orphan grants while claiming without double-crediting", async () => {
    const sender = await signIn(uniqueSub("gift-orphan-sender"));
    const recipients = await Promise.all([
      signIn(uniqueSub("gift-orphan-pending")),
      signIn(uniqueSub("gift-orphan-settled")),
    ]);
    for (const recipient of recipients) await befriend(sender, recipient);

    for (const [index, recipient] of recipients.entries()) {
      const beforeSend = await call<any>("POST", "/bootstrap", recipient.token, {});
      expect((await call("POST", "/gifts", sender.token, { toAccountId: recipient.accountId })).status).toBe(200);
      const inbox = await call<Array<{ id: string }>>("GET", "/gifts/inbox", recipient.token);
      expect(inbox.body).toHaveLength(1);
      const settled = index === 1;
      const orphan = await call<any>("POST", "/dev/fixture/orphan-gift-grant", recipient.token, {
        giftId: inbox.body[0].id, settled,
      });
      expect(orphan).toMatchObject({ status: 200, body: { inserted: true, settled } });

      const balanceBeforeClaim = await call<any>("POST", "/bootstrap", recipient.token, {});
      expect(balanceBeforeClaim.body.gameplay.balance.brains).toBe(
        beforeSend.body.gameplay.balance.brains + (settled ? 1 : 0)
      );
      const claimed = await call<any>("POST", "/gifts/claim", recipient.token, {
        giftId: inbox.body[0].id,
      });
      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      expect((await call<unknown[]>("GET", "/gifts/inbox", recipient.token)).body).toEqual([]);
      expect(claimed.body.balance.brains).toBe(beforeSend.body.gameplay.balance.brains + 1);
    }
  });

  // One sender may only gift a given recipient once per UTC day (idx_gifts_once), so
  // filling an inbox with several same-day gifts needs several senders.
  const inboxFrom = async (
    recipient: Awaited<ReturnType<typeof signIn>>,
    contents: { kind: "brain" | "gold"; amount: number }[],
    prefix: string
  ): Promise<string[]> => {
    const senders = await Promise.all(
      contents.map((_, index) => signIn(uniqueSub(`${prefix}-sender-${index}`)))
    );
    for (const sender of senders) {
      await befriend(sender, recipient);
      const sent = await call<any>("POST", "/gifts", sender.token, { toAccountId: recipient.accountId });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    const inbox = await call<Array<{ id: string }>>("GET", "/gifts/inbox", recipient.token);
    expect(inbox.body).toHaveLength(contents.length);
    // Overwrite each send-time roll so the payout under test is deterministic.
    for (const [index, gift] of inbox.body.entries()) {
      const forced = await call<any>("POST", "/dev/fixture/gift-reward", recipient.token, {
        giftId: gift.id, ...contents[index],
      });
      expect(forced, JSON.stringify(forced.body)).toMatchObject({ status: 200, body: contents[index] });
    }
    return inbox.body.map((gift) => gift.id);
  };

  it("guarantees a brain on the day's FIRST open, then pays each gift's own contents", async () => {
    const recipient = await signIn(uniqueSub("gift-daily-brain"));
    const before = await call<any>("POST", "/bootstrap", recipient.token, {});
    const { gold, brains } = before.body.gameplay.balance;
    // Every gift is rolled as gold; only the daily floor can produce a brain here.
    const gifts = await inboxFrom(recipient, [
      { kind: "gold", amount: 150 },
      { kind: "gold", amount: 300 },
      { kind: "gold", amount: 1000 },
    ], "gift-daily-brain");

    const first = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[0] });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // The stored 150 gold is overridden — the first open of the day is always a brain.
    expect(first.body).toMatchObject({ credited: true, reward: { kind: "brain", amount: 1 } });
    expect(first.body.balance).toMatchObject({ gold, brains: brains + 1 });

    const second = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[1] });
    expect(second.body).toMatchObject({ credited: true, reward: { kind: "gold", amount: 300 } });
    expect(second.body.balance).toMatchObject({ gold: gold + 300, brains: brains + 1 });

    const third = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[2] });
    expect(third.body).toMatchObject({ credited: true, reward: { kind: "gold", amount: 1000 } });
    expect(third.body.balance).toMatchObject({ gold: gold + 1300, brains: brains + 1 });

    const after = await call<any>("POST", "/bootstrap", recipient.token, {});
    expect(after.body.gameplay.balance).toMatchObject({ gold: gold + 1300, brains: brains + 1 });
  });

  it("pays a later gift's stored contents, and a re-claim never re-rolls them", async () => {
    const recipient = await signIn(uniqueSub("gift-stored-contents"));
    const before = await call<any>("POST", "/bootstrap", recipient.token, {});
    const { gold, brains } = before.body.gameplay.balance;
    const gifts = await inboxFrom(recipient, [
      { kind: "gold", amount: 150 },
      { kind: "brain", amount: 1 },
      { kind: "gold", amount: 500 },
    ], "gift-stored");

    // Burn the daily brain floor on the first gift so the rest pay what they hold.
    expect((await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[0] })).body)
      .toMatchObject({ credited: true, reward: { kind: "brain", amount: 1 } });

    // A gift rolled as a brain still pays a brain once the floor is spent.
    const brainGift = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[1] });
    expect(brainGift.body).toMatchObject({ credited: true, reward: { kind: "brain", amount: 1 } });
    expect(brainGift.body.balance).toMatchObject({ gold, brains: brains + 2 });

    const goldGift = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[2] });
    expect(goldGift.body).toMatchObject({ credited: true, reward: { kind: "gold", amount: 500 } });
    expect(goldGift.body.balance).toMatchObject({ gold: gold + 500, brains: brains + 2 });

    // Re-claiming a settled gift credits nothing and reveals nothing new.
    const again = await call<any>("POST", "/gifts/claim", recipient.token, { giftId: gifts[2] });
    expect(again.body).toMatchObject({ credited: false, alreadyClaimed: true, reward: null });
    expect(again.body.balance).toMatchObject({ gold: gold + 500, brains: brains + 2 });
  });

  it("tells the friends list how generous each friend has been, and how recently they played", async () => {
    const me = await signIn(uniqueSub("friend-stats-me"));
    const generous = await signIn(uniqueSub("friend-stats-generous"));
    const quiet = await signIn(uniqueSub("friend-stats-quiet"));
    await befriend(generous, me);
    await befriend(quiet, me);

    // `generous` gifts me; `quiet` never does. One send is all today's rules allow
    // per sender, so the lifetime count here is 1 vs 0.
    expect((await call("POST", "/gifts", generous.token, { toAccountId: me.accountId })).status).toBe(200);

    const friends = await call<any[]>("GET", "/friends", me.token);
    expect(friends.status).toBe(200);
    const rows = Object.fromEntries(friends.body.map((f: any) => [f.accountId, f]));
    expect(rows[generous.accountId]).toMatchObject({ giftsReceived: 1, activity: "today" });
    expect(rows[quiet.accountId]).toMatchObject({ giftsReceived: 0, activity: "today" });

    // The count is lifetime, not an inbox count: claiming must not reset it.
    const inbox = await call<Array<{ id: string }>>("GET", "/gifts/inbox", me.token);
    expect((await call("POST", "/gifts/claim", me.token, { giftId: inbox.body[0].id })).status).toBe(200);
    const after = await call<any[]>("GET", "/friends", me.token);
    expect(after.body.find((f: any) => f.accountId === generous.accountId).giftsReceived).toBe(1);

    // Only the coarse bucket is disclosed — never the raw last-online instant.
    for (const row of after.body) {
      expect(["today", "week", "away"]).toContain(row.activity);
      expect(row).not.toHaveProperty("lastOnlineAt");
      expect(row).not.toHaveProperty("last_online_at");
    }
  });

  it("keeps a gift's contents sealed until it is opened", async () => {
    const recipient = await signIn(uniqueSub("gift-sealed"));
    await inboxFrom(recipient, [{ kind: "gold", amount: 1000 }], "gift-sealed");
    const inbox = await call<any[]>("GET", "/gifts/inbox", recipient.token);
    // The inbox must not tell the recipient what is in the box.
    for (const gift of inbox.body) {
      expect(Object.keys(gift).sort()).toEqual(["created_at", "fromName", "id", "type"]);
    }
  });

  it("fences activity to one explicit writer and transfers control atomically", async () => {
    const session = await signIn(undefined, false);
    const clientA = "writer-client-aaaaaaaa";
    const clientB = "writer-client-bbbbbbbb";
    const tokenA = "a".repeat(64);
    const tokenB = "b".repeat(64);
    const currentIntegrity = currentIntegrityHeaders;
    const credential = (clientId: string, generation: number, token: string) => ({
      ...currentIntegrity,
      "x-writer-client": clientId,
      "x-writer-generation": String(generation),
      "x-writer-token": token,
    });

    const initial = await call<any>("POST", "/bootstrap", session.token, {}, currentIntegrity);
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body.writer).toMatchObject({ status: "free", generation: 0 });
    const acquired = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientA, token: tokenA, observedGeneration: 0, takeover: false,
    }, currentIntegrity);
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

    const observedB = await call<any>("POST", "/bootstrap", session.token, {}, currentIntegrity);
    expect(observedB.body.writer.status).toBe("other");
    const refused = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientB, token: tokenB, observedGeneration: observedB.body.writer.generation, takeover: false,
    }, currentIntegrity);
    expect(refused.status).toBe(423);
    const takeover = await call<any>("POST", "/writer/acquire", session.token, {
      clientId: clientB, token: tokenB, observedGeneration: observedB.body.writer.generation, takeover: true,
    }, currentIntegrity);
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
      ...currentIntegrityHeaders,
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

  it("revokes the displaced session when another session takes over", async () => {
    const sub = uniqueSub("writer-session-takeover");
    const displaced = await signIn(sub, false);
    const replacement = await signIn(sub, false);
    const clientA = "writer-session-client-a";
    const clientB = "writer-session-client-b";

    const initial = await call<any>("POST", "/bootstrap", displaced.token, {});
    const acquired = await call<any>("POST", "/writer/acquire", displaced.token, {
      clientId: clientA, token: "a".repeat(64),
      observedGeneration: initial.body.writer.generation, takeover: false,
    });
    expect(acquired.status).toBe(200);

    const observed = await call<any>("POST", "/bootstrap", replacement.token, {});
    expect(observed.body.writer.status).toBe("other");
    const takeover = await call<any>("POST", "/writer/acquire", replacement.token, {
      clientId: clientB, token: "b".repeat(64),
      observedGeneration: observed.body.writer.generation, takeover: true,
    });
    expect(takeover.status).toBe(200);

    expect((await call("POST", "/bootstrap", displaced.token, {})).status).toBe(401);
    expect((await call("POST", "/bootstrap", replacement.token, {})).status).toBe(200);
  });

  it("authenticates and activates an Epic Boss event", async () => {
    const unauthenticated = await call<any>("POST", "/epic-boss/activate", undefined, {
      activationId: "activation-unauthenticated",
    });
    expect(unauthenticated.status).toBe(401);

    const lockedSession = await signIn();
    await grantBalance(lockedSession, { gold: 400, brains: 1_000, xp: 20_500 });
    const locked = await call<any>("POST", "/epic-boss/activate", lockedSession.token, {
      activationId: uniqueSub("activation-level-locked"),
      bossId: "loco-locust",
    });
    expect(locked).toMatchObject({
      status: 403,
      body: { error: "locked", level: 25, unlockLevel: 42 },
    });

    const session = await signIn();
    await grantBalance(session, { gold: 400, brains: 1_000, xp: 165_000 });
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
    // Derived, not literal: activation prices are catalog data on a balance ladder
    // (3-5 brains by unlock order) and an attempt is one brain. Hard-coding either meant
    // this test failed on the re-price rather than on a regression in what it checks —
    // that the activation and every attempt are debited authoritatively, once each.
    expect(activated.body.balance.brains).toBe(brainsBeforeActivation - LOCUST_BRAINS);

    // A bundle that disagrees with the Worker is refused BEFORE it pays. An epic fight is
    // server-replayed and ruleset v28/v29 put the attempt window and the damage curve
    // inside the rules, so a stale client would fight to a win under its own rules and
    // lose it at verification — with the brain already spent. Assert the refusal AND that
    // it cost nothing, which is the whole point of gating at start rather than at finish.
    for (const rulesetVersion of [RAID_RULESET_VERSION - 1, undefined]) {
      // `undefined` is the case that actually reaches production: a bundle predating this
      // handshake sends no such field at all, and must be refused exactly like one sending
      // a number that disagrees.
      const stale = await call<any>("POST", "/epic-boss/start", session.token, {
        orderedUnitIds: [epicZombieId],
        payment: "brains",
        ...(rulesetVersion === undefined ? {} : { rulesetVersion }),
      });
      expect(stale, `rulesetVersion=${rulesetVersion}`).toMatchObject({
        status: 426,
        body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION },
      });
    }
    const afterStale = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    expect(afterStale.gameplay.balance.brains).toBe(brainsBeforeActivation - LOCUST_BRAINS);
    // No session was opened either, so the start below is a first attempt and not a resume.
    expect(afterStale.gameplay.epicBoss?.encounterStartedAt ?? 0).toBe(0);

    const started = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [epicZombieId],
      payment: "brains",
      rulesetVersion: RAID_RULESET_VERSION,
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
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    // Activation plus TWO attempts: the escape above did not refund the first one.
    expect(retried.body.balance.brains).toBe(
      brainsBeforeActivation - LOCUST_BRAINS - 2 * EPIC_BOSS_FIGHT_BRAIN_COST
    );

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

  it("buries an Epic Boss casualty in the graveyard, the same as an invasion does", async () => {
    // The reported bug: a zombie lost to an epic boss left no `fallen_v3` row, so the
    // Memorial Statue — which reads the authoritative graveyard and nothing else —
    // told a player who had just lost one that they had never lost any.
    const session = await signIn(uniqueSub("epic-graveyard"));
    await grantBalance(session, { gold: 400, brains: 1_000, xp: 165_000 });
    const boot = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    const grown = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-epic-graveyard", 1, [
        { type: "farm.plow", oc: 0, or: 0 },
        { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" },
        { type: "power.buy", key: "insta_grow" },
        { type: "power.use", key: "insta_grow", oc: 0, or: 0 },
        { type: "farm.harvest", oc: 0, or: 0 },
      ]));
    expect(grown.status).toBe(200);
    const unitId = grown.body.createdZombieIds[0];
    // Name it, so the plaque has something to carve: names live only in the
    // presentation blob, keyed by the roster id that is about to be deleted.
    expect((await call<any>("PUT", "/presentation", session.token, {
      protocolVersion: 3, expectedVersion: grown.body.presentation?.version ?? 0,
      data: { rosterLayout: [{ id: unitId, name: "Gus" }] },
    })).status).toBe(200);

    const activated = await call<any>("POST", "/epic-boss/activate", session.token, {
      activationId: uniqueSub("activation-graveyard"), bossId: "loco-locust",
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const started = await call<any>("POST", "/epic-boss/start", session.token, {
      orderedUnitIds: [unitId], payment: "brains", rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // No retreat input: the verifier runs the whole fight to its own conclusion, and a
    // Tier-1 Regular against the level-42 boss loses it.
    const finished = await call<any>("POST", "/epic-boss/finish", session.token, {
      sessionId: started.body.sessionId, finalTick: 0, inputs: [],
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.losses).toEqual([unitId]);

    const after = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    expect(after.gameplay.fallen).toEqual([
      expect.objectContaining({ id: unitId, key: "ZombieActorRegularTier1", name: "Gus" }),
    ]);
    // ...and it is genuinely out of the roster, not merely remembered.
    expect(after.gameplay.roster?.some((z: any) => z.id === unitId)).toBeFalsy();
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
    expect(bought.body.gameplay.balance.brains).toBe(boot.gameplay.balance.brains - 5);
    expect(bought.body.gameplay.balance.xp).toBe(boot.gameplay.balance.xp + 500);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const retried = await call<any>("POST", "/commands", owner.token, body);
    expect(retried.body.serverTime).toBeGreaterThan(bought.body.serverTime);
    expect({ ...retried.body, serverTime: bought.body.serverTime }).toEqual(bought.body);
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

  it("shows a friend the zombie carved on a Memorial Statue, and releases it on sale", async () => {
    const owner = await signIn(uniqueSub("memorial-owner"));
    const other = await signIn(uniqueSub("memorial-visitor"));
    await grantBalance(owner, { gold: 30_000 });
    await grantFallen(owner, [
      { id: "z-dead-1", key: "ZombieActorRegularTier1", name: "Gus", mutation: 8, invasions: 3, diedAt: 1_700_000_000_000 },
      { id: "z-dead-2", key: "ZombieActorGardenTier1", diedAt: 1_700_000_001_000 },
    ]);
    const boot = (await call<any>("POST", "/bootstrap", owner.token, { protocolVersion: 3, deviceId: deviceA })).body;
    // The graveyard arrives with the bootstrap, newest first, nobody enshrined yet.
    expect(boot.gameplay.fallen).toEqual([
      expect.objectContaining({ id: "z-dead-2", key: "ZombieActorGardenTier1" }),
      expect.objectContaining({ id: "z-dead-1", name: "Gus", mutation: 8, invasions: 3 }),
    ]);
    expect(boot.gameplay.fallen.every((u: any) => u.memorialObjectId === undefined)).toBe(true);

    const built = await call<any>("POST", "/commands", owner.token,
      commandBody(boot, "batch-memorial-buy", 1, [
        { type: "object.buy", catalogKey: "memorialStatue", clientInstanceId: "statue-1" },
        { type: "object.buy", catalogKey: "memorialStatue", clientInstanceId: "statue-2" },
        { type: "memorial.enshrine", instanceId: "statue-1", unitId: "z-dead-1", name: "Gus" },
      ]));
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    // Unlimited copies: the one-per-farm rule every other functional item lives under
    // does not apply, or a player could only ever remember one zombie.
    expect(built.body.results.map((r: any) => r.status)).toEqual(["applied", "applied", "applied"]);
    expect(built.body.gameplay.fallen).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "z-dead-1", memorialObjectId: "statue-1" }),
    ]));

    // A zombie can only stand on one plinth, and only a zombie this account lost.
    const refused = await call<any>("POST", "/commands", owner.token,
      commandBody(built.body, "batch-memorial-bad", 4, [
        { type: "memorial.enshrine", instanceId: "statue-2", unitId: "z-dead-1" },
        { type: "memorial.enshrine", instanceId: "statue-2", unitId: "z-never-existed" },
        { type: "memorial.enshrine", instanceId: "statue-1", unitId: "z-dead-2" },
      ]));
    expect(refused.body.results.map((r: any) => r.error))
      .toEqual(["already_enshrined", "not_owned", "statue_occupied"]);

    // THE POINT OF ALL THIS: a visitor renders the statue from the authoritative
    // object list, so the occupant has to travel with it. Their own graveyard stays
    // private — a visit shows what stands on the farm, not who else died.
    await befriend(owner, other);
    const visit = await call<any>("GET", `/friends/${owner.accountId}/save`, other.token);
    expect(visit.status).toBe(200);
    const statues = visit.body.save.objects.filter((o: any) => o.key === "memorialStatue");
    expect(statues).toHaveLength(2);
    expect(statues.find((o: any) => o.id === "statue-1").memorial)
      .toMatchObject({ id: "z-dead-1", key: "ZombieActorRegularTier1", name: "Gus", mutation: 8 });
    expect(statues.find((o: any) => o.id === "statue-2").memorial).toBeUndefined();
    expect(visit.body.save.fallen).toBeUndefined();

    // Selling the plinth must not bury the zombie a second time: it goes back to the
    // graveyard, free to be enshrined again.
    const sold = await call<any>("POST", "/commands", owner.token,
      commandBody(refused.body, "batch-memorial-sell", 7, [
        { type: "object.refund", instanceId: "statue-1" },
      ]));
    expect(sold.body.results[0], JSON.stringify(sold.body.results[0])).toMatchObject({ status: "applied" });
    const released = sold.body.gameplay.fallen.find((u: any) => u.id === "z-dead-1");
    expect(released.memorialObjectId).toBeUndefined();
    // …and it rejoins at the TOP of the graveyard rather than at its date of death.
    // A player enshrines a loss they care about, which is usually an old one, so
    // ranking it by `diedAt` on the way back would bury it under everything that has
    // died since — and delete it outright at the next settlement on a farm that has
    // lost MEMORIAL_GRAVEYARD_CAP zombies in the meantime. `z-dead-2` died LATER than
    // `z-dead-1` and led this list before the statue was sold.
    expect(released.releasedAt).toBeGreaterThan(released.diedAt);
    expect(released.diedAt).toBe(1_700_000_000_000); // the plaque's date is untouched
    expect(sold.body.gameplay.fallen.map((u: any) => u.id)).toEqual(["z-dead-1", "z-dead-2"]);

    const reloaded = (await call<any>("POST", "/bootstrap", owner.token, {})).body;
    expect(reloaded.gameplay.fallen.find((u: any) => u.id === "z-dead-1").memorialObjectId)
      .toBeUndefined();
    // The bootstrap's ORDER BY and the settlement trim read the same expression, so
    // the reprieve survives a reload — this is the row that would be kept.
    expect(reloaded.gameplay.fallen.map((u: any) => u.id)).toEqual(["z-dead-1", "z-dead-2"]);
    expect(reloaded.gameplay.objects.objects.some((o: any) => o.instanceId === "statue-1")).toBe(false);
  });

  it("bootstraps once and applies a mixed ordered batch", async () => {
    const session = await signIn();
    const boot = await call<any>("POST", "/bootstrap", session.token, { protocolVersion: 3, deviceId: deviceA });
    expect(boot.status).toBe(200);
    expect(boot.body.protocolVersion).toBe(3);
    expect(boot.body.gameplay.balance).toEqual({ gold: 400, brains: 1, xp: 0 });
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    const duplicate = await call<any>("POST", "/commands", session.token, body);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.serverTime).toBeGreaterThan(applied.body.serverTime);
    expect({ ...duplicate.body, serverTime: applied.body.serverTime }).toEqual(applied.body);

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
    const stale = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1, orderedUnitIds: [unitId], rulesetVersion: 2,
    });
    expect(stale).toMatchObject({ status: 426, body: { error: "stale_ruleset", rulesetVersion: RAID_RULESET_VERSION } });
    const started = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: [unitId],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      // Settlement must ignore a forged client outcome and derive the retreat.
      win: true,
      survivors: [unitId],
      losses: [],
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ gold: 0, xp: 0, outcome: { win: false, survivors: [], losses: [] } });

    const next = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1,
      orderedUnitIds: [unitId],
      rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(next.status).toBe(429);
    expect(next.body.error).toBe("cooldown");
  });

  it("uses a purchased invasion voucher to start again during cooldown", async () => {
    const session = await signIn();
    await grantBalance(session, { gold: 3_000 });
    await grantRoster(session, [{
      id: "voucher-raid-zombie",
      key: "ZombieActorRegularTier1",
      stored: false,
    }]);
    const boot = (await call<any>("POST", "/bootstrap", session.token, {
      protocolVersion: 3,
      deviceId: deviceA,
    })).body;
    const bought = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-buy-invasion-voucher", 1, [
        { type: "power.buy", key: "invasion_voucher" },
      ]));
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body.results[0]).toMatchObject({ status: "applied" });
    expect(bought.body.gameplay.inventory.invasion_voucher).toBe(1);

    const raid = {
      raidId: 1,
      orderedUnitIds: ["voucher-raid-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    };
    const first = await call<any>("POST", "/raid/start", session.token, raid);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId: first.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false,
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    const bypass = await call<any>("POST", "/raid/start", session.token, {
      ...raid,
      useVoucher: true,
    });
    expect(bypass.status, JSON.stringify(bypass.body)).toBe(200);
    expect(bypass.body).toMatchObject({
      ok: true,
      bypassed: true,
      inventory: { invasion_voucher: 0 },
    });
  });

  it("spends a Brain Ticket for an elite invasion, and refuses without one", async () => {
    const session = await signIn();
    // 9,500 XP is XP_THRESHOLDS[19] — exactly level 20, the Brain Ticket's Market gate.
    // The gate is enforced on the SERVER (boostCatalog + engine's `power.buy`), so an
    // account seeded with gold alone is level 1 and the purchase below is refused
    // `locked`. See boostCatalogSync.test.ts for why that number lives in two places.
    await grantBalance(session, { gold: 30_000, xp: 9_500 });
    await grantRoster(session, [{
      id: "elite-raid-zombie",
      key: "ZombieActorRegularTier1",
      stored: false,
    }]);
    const boot = (await call<any>("POST", "/bootstrap", session.token, {
      protocolVersion: 3,
      deviceId: deviceA,
    })).body;
    const raid = {
      raidId: 1,
      orderedUnitIds: ["elite-raid-zombie"],
      rulesetVersion: RAID_RULESET_VERSION,
    };

    // Asking for elite with an empty pocket is refused outright rather than quietly
    // downgraded — the player asked for the fight they were going to be charged for.
    const broke = await call<any>("POST", "/raid/start", session.token, { ...raid, brainTicket: true });
    expect(broke).toMatchObject({ status: 409, body: { error: "no_brain_ticket" } });

    const bought = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-buy-brain-ticket", 1, [
        { type: "power.buy", key: "brain_ticket" },
      ]));
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body.results[0]).toMatchObject({ status: "applied" });
    expect(bought.body.gameplay.inventory.brain_ticket).toBe(1);
    expect(bought.body.gameplay.balance.gold).toBe(20_000);

    const started = await call<any>("POST", "/raid/start", session.token, { ...raid, brainTicket: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ ok: true, elite: true, inventory: { brain_ticket: 0 } });

    await call<any>("POST", "/raid/finish", session.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false,
    });

    // A ticket covers the wait too, so a second elite launch inside the cooldown needs
    // only another ticket — not an Invasion Voucher on top of it.
    const stillBroke = await call<any>("POST", "/raid/start", session.token, { ...raid, brainTicket: true });
    expect(stillBroke).toMatchObject({ status: 409, body: { error: "no_brain_ticket" } });
    const reboot = (await call<any>("POST", "/bootstrap", session.token, {
      protocolVersion: 3,
      deviceId: deviceA,
    })).body;
    // An Invasion Voucher is bought alongside it purely so the next assertion can show
    // it was NOT taken: the ticket alone paid for the bypass.
    const again = await call<any>("POST", "/commands", session.token,
      commandBody(reboot, "batch-buy-brain-ticket-2", 2, [
        { type: "power.buy", key: "brain_ticket" },
        { type: "power.buy", key: "invasion_voucher" },
      ]));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.gameplay.inventory).toMatchObject({ brain_ticket: 1, invasion_voucher: 1 });
    const bypass = await call<any>("POST", "/raid/start", session.token, { ...raid, brainTicket: true });
    expect(bypass.status, JSON.stringify(bypass.body)).toBe(200);
    expect(bypass.body).toMatchObject({
      ok: true,
      elite: true,
      bypassed: true,
      inventory: { brain_ticket: 0, invasion_voucher: 1 },
    });
  });

  it("versions presentation independently and retires v2 mutations", async () => {
    const session = await signIn();
    for (const objectLayout of [{}, [null], [{ id: "o1", oc: "0", or: 0 }]]) {
      const malformed = await call("PUT", "/presentation", session.token, {
        protocolVersion: 3, expectedVersion: 0, data: { objectLayout },
      });
      expect(malformed.status).toBe(400);
    }
    for (const discovered of [
      { "ZombieActorRegularTier1": 0 },      // counts start at 1
      { "ZombieActorRegularTier1": 1.5 },    // integers only
      { "bad key!": 2 },                     // key charset
      [1],                                   // must be a record
    ]) {
      const malformed = await call("PUT", "/presentation", session.token, {
        protocolVersion: 3, expectedVersion: 0, data: { almanac: { discovered } },
      });
      expect(malformed.status, JSON.stringify(discovered)).toBe(400);
    }
    // The graveyard is server-owned (fallen_v3), but a client built before that
    // table still puts `fallen` in its presentation blob. It MUST stay accepted: an
    // unknown key rejects the WHOLE blob, which would silently stop that client's
    // object positions and zombie names from saving the moment a zombie died.
    const fallen = (over: Record<string, unknown> = {}) => ({
      id: "z9", key: "ZombieActorRegularTier1", name: "Bob",
      mutation: 8, invasions: 5, diedAt: 1_700_000_000_000, ...over,
    });
    for (const bad of [
      [fallen({ id: "bad id!" })],                          // id charset
      [fallen({ name: "x".repeat(25) })],                   // name length
      [fallen({ invasions: -1 })],                          // counters are non-negative
      [fallen({ color: [1, 2] })],                          // colour is a triplet
      [{ id: "z9" }],                                       // missing fields
      Array.from({ length: 61 }, (_, i) => fallen({ id: `z${i}` })), // over the cap
      { z9: fallen() },                                     // must be a list
    ]) {
      const malformed = await call("PUT", "/presentation", session.token, {
        protocolVersion: 3, expectedVersion: 0, data: { fallen: bad },
      });
      expect(malformed.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const presentation = await call<any>("PUT", "/presentation", session.token, {
      protocolVersion: 3,
      expectedVersion: 0,
      data: {
        camera: { x: 1, y: 2 }, tutorial: { done: false, step: 1 },
        almanac: { discovered: { ZombieActorRegularTier1: 2, ZombieActorGardenTier1: 1 } },
        fallen: [fallen(), fallen({ id: "z10", color: [12, 34, 56] })],
        objectLayout: [{ id: "o1", oc: 3, or: 4, memorial: fallen({ id: "z11" }) }],
      },
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

  // Boss Tokens are rolled by the CLIENT on harvest and merely reported here. Nothing
  // else writes `epic_boss_runs_v3.token_count` during a command batch any more, so this
  // covers the whole live path: the command door, the engine, the conditional D1 write
  // in v3/db.ts, and the count coming back out of a fresh bootstrap.
  it("records client-rolled Boss Tokens and persists them past the batch", async () => {
    const session = await signIn(uniqueSub("boss-token-grant"));
    // Dr Groundhog unlocks at 24 and costs 5 brains to activate.
    await grantBalance(session, { brains: 20, xp: xpForLevel(24) });
    const activated = await call<any>("POST", "/epic-boss/activate", session.token, {
      activationId: uniqueSub("activation"), bossId: "dr-groundhog",
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const runId = activated.body.event.runId;
    expect(activated.body.event.tokenCount).toBe(0);

    const boot = (await call<any>("POST", "/bootstrap", session.token, {})).body;
    const granted = await call<any>("POST", "/commands", session.token,
      commandBody(boot, "batch-boss-tokens", 1, [
        { type: "epicBoss.token", runId },
        { type: "epicBoss.token", runId, count: 2 },
        // A grant for an event this account is not running is dropped, not applied.
        { type: "epicBoss.token", runId: "some-other-run" },
      ]));
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.results.map((r: any) => r.status))
      .toEqual(["applied", "applied", "rejected"]);
    expect(granted.body.gameplay.epicBoss.tokenCount).toBe(3);

    const after = await call<any>("POST", "/bootstrap", session.token, {});
    expect(after.body.gameplay.epicBoss.tokenCount).toBe(3);
  });
});

// Client-only hazards (the Beach crab — see RaidManager.crabOf) are deliberately absent
// from the server's replay, making that replay an OPTIMISTIC ceiling. `clientWin` lets a
// player concede a fight the hazard actually cost them, and ONLY in that direction.
describe("raid finish — clientWin concession", () => {
  const raidReadyZombie = async (batchId: string) => {
    const session = await signIn();
    const boot = (await call<any>("POST", "/bootstrap", session.token, {
      protocolVersion: 3,
      deviceId: deviceA,
    })).body;
    const grown = await call<any>("POST", "/commands", session.token,
      commandBody(boot, batchId, 1, [
        { type: "farm.plow", oc: 0, or: 0 },
        { type: "farm.plant", oc: 0, or: 0, cropKey: "ZombieActorRegularTier1" },
        { type: "power.buy", key: "insta_grow" },
        { type: "power.use", key: "insta_grow", oc: 0, or: 0 },
        { type: "farm.harvest", oc: 0, or: 0 },
      ]));
    const unitId = grown.body.createdZombieIds[0];
    const started = await call<any>("POST", "/raid/start", session.token, {
      raidId: 1, orderedUnitIds: [unitId], rulesetVersion: RAID_RULESET_VERSION,
    });
    return { session, sessionId: started.body.sessionId, unitId };
  };

  it("clientWin:true can NOT upgrade a server-derived loss", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-up");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }], clientWin: true,
    });
    expect(finished.status).toBe(200);
    // The retreat still governs — a truthful-looking client flag buys nothing.
    expect(finished.body).toMatchObject({ gold: 0, xp: 0, outcome: { win: false } });
  });

  it("clientWin:false settles as a loss and pays nothing", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-down");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }], clientWin: false,
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ gold: 0, xp: 0, firstClear: false, outcome: { win: false } });
  });

  it("settles a natural client-only hazard loss while the server replay is still running", async () => {
    const { session, sessionId, unitId } = await raidReadyZombie("batch-concede-truncated");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId,
      // A hazard can end the visible fight before the hazard-free verifier reaches a
      // terminal state. Unlike a user retreat, that natural ending has no retreat input.
      finalTick: 0,
      inputs: [],
      clientWin: false,
      clientLosses: [unitId],
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({
      gold: 0,
      brains: 0,
      xp: 0,
      firstClear: false,
      outcome: { win: false, survivors: [], losses: [unitId] },
    });
    expect(finished.body.revival?.zombies?.some((z: any) => z.id === unitId)).toBe(true);

    // The result is committed idempotently rather than closing the session as invalid.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retry = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [], clientWin: false, clientLosses: [unitId],
    });
    expect(retry.status).toBe(200);
    expect(retry.body.serverTime).toBeGreaterThan(finished.body.serverTime);
    expect({ ...retry.body, serverTime: finished.body.serverTime }).toEqual(finished.body);
  });

  it("does not let concession bypass structurally invalid transcripts", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-malformed");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId,
      finalTick: 1,
      inputs: [{ seq: 2, tick: 0, type: "retreat" }],
      clientWin: false,
    });
    expect(finished).toMatchObject({ status: 422, body: { error: "bad_sequence" } });
  });

  it("settles after a post-divergence interaction disagrees with the verifier", async () => {
    const { session, sessionId, unitId } = await raidReadyZombie("batch-concede-interaction");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId,
      finalTick: 0,
      // A hazard can change which unit is charging/active, making a locally accepted
      // interaction illegal in the hazard-free replay. The verifier now DROPS the tap it
      // will not take — refusing it is refusing the player help, so it can only cost the
      // server's own army — and settles the fight it actually simulated. This used to
      // reach the concession fallback, which paid the same nothing but reported every
      // unit as unaccounted-for rather than bringing the survivor home.
      inputs: [{ seq: 1, tick: 0, type: "bubble", unitId: "not-charging-server-side" }],
      clientWin: false,
    });
    expect(finished).toMatchObject({
      status: 200,
      // Still zero: `win` is ANDed with the client's conceded loss.
      body: { gold: 0, brains: 0, xp: 0, outcome: { win: false, survivors: [unitId], losses: [] } },
    });
  });

  it("rejects a non-boolean clientWin rather than coercing it", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-bad");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }], clientWin: "yes",
    });
    expect(finished).toMatchObject({ status: 400, body: { error: "bad_client_win" } });
  });

  it("omitting clientWin behaves exactly as before (older clients)", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-absent");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ outcome: { win: false } });
  });

  it("clientLosses folds a conceded death into the settlement", async () => {
    const { session, sessionId, unitId } = await raidReadyZombie("batch-concede-death");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false, clientLosses: [unitId],
    });
    expect(finished.status).toBe(200);
    // The replay retreated with the zombie intact; the client reports it died to a hazard.
    expect(finished.body.outcome.losses).toContain(unitId);
    expect(finished.body.outcome.survivors).not.toContain(unitId);
    // ...and it is genuinely gone from the roster, offered back only as a paid revival.
    expect(finished.body.revival?.zombies?.some((z: any) => z.id === unitId)).toBe(true);
  });

  it("ignores clientLosses ids that were never locked to this raid", async () => {
    const { session, sessionId, unitId } = await raidReadyZombie("batch-concede-foreign");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientLosses: ["not-my-zombie", "someone-elses-unit"],
    });
    expect(finished.status).toBe(200);
    // Foreign ids are dropped, so nothing died and no casualty offer is raised.
    expect(finished.body.outcome.losses).toEqual([]);
    expect(finished.body.revival).toBeNull();
  });

  it("rejects a malformed clientLosses instead of coercing it", async () => {
    const { session, sessionId } = await raidReadyZombie("batch-concede-badloss");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientLosses: [{ id: "z" }],
    });
    expect(finished).toMatchObject({ status: 400, body: { error: "bad_client_losses" } });
  });

  it("a conceded death cannot INCREASE the payout", async () => {
    const { session, sessionId, unitId } = await raidReadyZombie("batch-concede-nopay");
    const finished = await call<any>("POST", "/raid/finish", session.token, {
      sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientLosses: [unitId],
    });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ gold: 0, xp: 0 });
  });
});
