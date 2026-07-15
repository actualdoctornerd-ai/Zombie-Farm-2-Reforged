import { describe, it, expect } from "vitest";
import { call, signIn, xpForLevel, type Session } from "./helpers";

// Phase D — server-owned placeable objects. Ownership is a count per key; a buy debits
// the exact catalog cost + grants buyXp, a refund credits floor(cost*0.2) only for an
// object you actually own. Placement/position stays client-side layout.

interface ObjRes {
  balance: { gold: number; brains: number; xp: number };
  objects: Record<string, number>;
  results: { id: string; status: string; error?: string }[];
}

// Seeded at max level: Phase E gates a buy on the catalog's level requirement (daisy is
// level 6, baloon 21...), and these tests are about PRICING, not unlocks. Seeding xp at
// creation stamps claimed_level, so it pays no level-up brains and the balances stay exact.
// xp assertions are relative to BASE_XP because of that seed.
const BASE_XP = xpForLevel(45);

async function player(gold = 1000, brains = 1000): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: BASE_XP } });
  return s;
}

let n = 0;
const aid = (p: string) => `${p}-${n++}`;

describe("objects — server-owned buy + refund", () => {
  it("buys a placeable: exact debit + buy xp + count++", async () => {
    const s = await player(100, 0);
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "daisy" }], // 10 gold, buyXp 1
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(90);
    expect(r.body.balance.xp).toBe(BASE_XP + 1); // buyXp
    expect(r.body.objects.daisy).toBe(1);
  });

  it("refunds an owned placeable for floor(cost*0.2) and decrements the count", async () => {
    const s = await player(100, 0);
    await call("POST", "/object/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "daisy" }] });
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("refund"), type: "refund", key: "daisy" }], // +2 gold
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(92); // 100 - 10 + 2
    expect(r.body.objects.daisy ?? 0).toBe(0);
  });

  it("refuses to refund an object you don't own (no fabricated gold)", async () => {
    const s = await player(0, 0);
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("refund"), type: "refund", key: "daisy" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "none_owned" });
    expect(r.body.balance.gold).toBe(0);
  });

  it("rejects an unaffordable buy and a free/promo (not-purchasable) object", async () => {
    const s = await player(5, 0);
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [
        { id: aid("buy"), type: "buy", key: "daisy" }, // costs 10, only have 5
        { id: aid("buy"), type: "buy", key: "storage01" }, // cost 0 → not purchasable
      ],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(r.body.results[1]).toMatchObject({ status: "rejected", error: "not_purchasable" });
    expect(r.body.balance.gold).toBe(5);
  });

  it("refuses an object the account's LEVEL hasn't unlocked (Phase E)", async () => {
    const s = await signIn(); // level 1: no xp
    await call("POST", "/economy/sync", s.token, { seed: { gold: 99999, brains: 0, xp: 0 } });
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "daisy" }], // unlocks at level 6
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "locked" });
    expect(r.body.balance.gold).toBe(99999); // not charged
  });

  it("upgrades the starter shed: charges the new one in full, no count for the free old one", async () => {
    const s = await player(20000, 0);
    // storage01 (free, never server-tracked) → storage02 (15000, xp 150).
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("up"), type: "upgrade", fromKey: "storage01", toKey: "storage02" }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(5000); // 20000 - 15000
    expect(r.body.balance.xp).toBe(BASE_XP + 150); // the shed's source xp
    expect(r.body.objects.storage02).toBe(1);
  });

  it("upgrades a PRICED shed: consumes the old count, so it can't be refunded afterwards", async () => {
    const s = await player(60000, 0);
    await call("POST", "/object/actions", s.token, {
      actions: [{ id: aid("up"), type: "upgrade", fromKey: "storage01", toKey: "storage02" }], // own storage02
    });
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("up"), type: "upgrade", fromKey: "storage02", toKey: "storage03" }], // 30000
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(15000); // 60000 - 15000 - 30000
    expect(r.body.objects.storage02 ?? 0).toBe(0); // given up...
    expect(r.body.objects.storage03).toBe(1); // ...for this one
    // The old shed is really gone: refunding it now finds no count.
    const refund = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("refund"), type: "refund", key: "storage02" }],
    });
    expect(refund.body.results[0]).toMatchObject({ status: "rejected", error: "none_owned" });
  });

  it("rejects an unaffordable upgrade, an unowned priced shed, and upgrading into a free object", async () => {
    const s = await player(100, 0);
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [
        { id: aid("up"), type: "upgrade", fromKey: "storage01", toKey: "storage02" }, // 15000 > 100
        { id: aid("up"), type: "upgrade", fromKey: "storage05", toKey: "storage02" }, // don't own storage05
        { id: aid("up"), type: "upgrade", fromKey: "storage02", toKey: "storage01" }, // into a free object
      ],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(r.body.results[1]).toMatchObject({ status: "rejected", error: "none_owned" });
    expect(r.body.results[2]).toMatchObject({ status: "rejected", error: "not_purchasable" });
    expect(r.body.balance.gold).toBe(100); // nothing moved
  });

  it("is idempotent: replaying an upgrade doesn't double-charge or double-swap", async () => {
    const s = await player(20000, 0);
    const id = aid("up");
    const body = { actions: [{ id, type: "upgrade", fromKey: "storage01", toKey: "storage02" }] };
    const first = await call<ObjRes>("POST", "/object/actions", s.token, body);
    expect(first.body.balance.gold).toBe(5000);
    const replay = await call<ObjRes>("POST", "/object/actions", s.token, body);
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.balance.gold).toBe(5000); // not charged again
    expect(replay.body.objects.storage02).toBe(1); // not 2
  });

  it("is idempotent: replaying a buy action id doesn't double-charge", async () => {
    const s = await player(100, 0);
    const id = aid("buy");
    const first = await call<ObjRes>("POST", "/object/actions", s.token, { actions: [{ id, type: "buy", key: "daisy" }] });
    expect(first.body.balance.gold).toBe(90);
    const replay = await call<ObjRes>("POST", "/object/actions", s.token, { actions: [{ id, type: "buy", key: "daisy" }] });
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.balance.gold).toBe(90); // not 80
    expect(replay.body.objects.daisy).toBe(1); // not 2
  });

  it("buy→refund is a net loss (can't churn for profit)", async () => {
    const s = await player(100, 0);
    await call("POST", "/object/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "shellScallop" }] }); // -50
    const r = await call<ObjRes>("POST", "/object/actions", s.token, {
      actions: [{ id: aid("refund"), type: "refund", key: "shellScallop" }], // +10
    });
    expect(r.body.balance.gold).toBe(60); // 100 - 50 + 10, a real loss
  });

  it("rejects client-authored object imports without clobbering server truth", async () => {
    const s = await player();
    const seed1 = await call<{ objects: Record<string, number> }>("POST", "/object/sync", s.token, {
      counts: { daisy: 3, skeletonCouple: 1 },
    });
    expect(seed1.body.objects.daisy ?? 0).toBe(0);
    await call("POST", "/object/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "daisy" }] });
    const seed2 = await call<{ objects: Record<string, number> }>("POST", "/object/sync", s.token, {
      counts: { daisy: 3 },
    });
    expect(seed2.body.objects.daisy).toBe(1);
  });
});
