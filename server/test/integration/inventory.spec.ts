import { describe, it, expect } from "vitest";
import { call, signIn, xpForLevel, type Session } from "./helpers";

// Server-owned boost inventory (P11): buy debits the exact catalog price + grants,
// use decrements, seed/sync is one-time, and the invasion voucher is consumed
// server-side on a raid bypass (so the cooldown can't be skipped for free).

interface InvRes {
  balance: { gold: number; brains: number };
  inventory: Record<string, number>;
  results: { id: string; status: string; error?: string }[];
}

// `level` seeds the account's xp, since Phase E gates a boost buy on the catalog's level
// requirement (the gift vouchers are level 25). Default 45 (max) — these tests are about
// pricing/redeem, not unlocks; the level gate has its own test below. Seeding xp at
// creation stamps claimed_level, so it pays no level-up brains and balances stay exact.
async function player(gold = 10000, brains = 500, level = 45): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: xpForLevel(level) } });
  return s;
}

let n = 0;
const aid = (p: string) => `${p}-${n++}`;

describe("inventory — server-owned boosts", () => {
  it("buys a boost: exact brains debit + perPurchase grant", async () => {
    const s = await player(0, 50);
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "insta_grow" }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.brains).toBe(40); // 50 - 10
    expect(r.body.inventory.insta_grow).toBe(20); // perPurchase
  });

  it("rejects a buy the player can't afford, leaving balance + inventory untouched", async () => {
    const s = await player(0, 5); // voucher costs 2000 gold; also can't afford
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "invasion_voucher" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(r.body.inventory.invasion_voucher).toBe(0);
  });

  it("uses a boost it owns and refuses to use one it doesn't", async () => {
    const s = await player(0, 50);
    await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "golden_dice" }], // grants 1
    });
    const use1 = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("use"), type: "use", key: "golden_dice" }],
    });
    expect(use1.body.results[0].status).toBe("applied");
    expect(use1.body.inventory.golden_dice).toBe(0);
    // Now at 0 — a further use is rejected (can't fabricate a consumable).
    const use2 = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("use"), type: "use", key: "golden_dice" }],
    });
    expect(use2.body.results[0]).toMatchObject({ status: "rejected", error: "none_owned" });
  });

  it("is idempotent: replaying a buy action id doesn't double-charge", async () => {
    const s = await player(0, 50);
    const id = aid("buy");
    const first = await call<InvRes>("POST", "/inventory/actions", s.token, { actions: [{ id, type: "buy", key: "concentration" }] });
    expect(first.body.balance.brains).toBe(40);
    expect(first.body.inventory.concentration).toBe(2);
    const replay = await call<InvRes>("POST", "/inventory/actions", s.token, { actions: [{ id, type: "buy", key: "concentration" }] });
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.balance.brains).toBe(40); // not 30
    expect(replay.body.inventory.concentration).toBe(2); // not 4
  });

  it("seeds boost counts once from the save; a later sync won't clobber server truth", async () => {
    const s = await player();
    const seed1 = await call<{ inventory: Record<string, number> }>("POST", "/inventory/sync", s.token, {
      counts: { golden_dice: 7, insta_grow: 3 },
    });
    expect(seed1.body.inventory.golden_dice).toBe(7);
    // Consume one server-side, then re-sync with the OLD (higher) save count: the
    // server count wins (INSERT OR IGNORE), so it stays at 6, not reset to 7.
    await call("POST", "/inventory/actions", s.token, { actions: [{ id: aid("use"), type: "use", key: "golden_dice" }] });
    const seed2 = await call<{ inventory: Record<string, number> }>("POST", "/inventory/sync", s.token, {
      counts: { golden_dice: 7 },
    });
    expect(seed2.body.inventory.golden_dice).toBe(6);
  });

  it("rejects a public grant action, so a client can't mint a free boost/voucher", async () => {
    const s = await player(0, 0);
    // `grant` was removed from the inventory action union — unknown type → rejected,
    // nothing added. A modified client can no longer conjure a free invasion voucher.
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("grant"), type: "grant", key: "invasion_voucher", qty: 99 } as never],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "bad_type" });
    expect(r.body.inventory.invasion_voucher).toBe(0);
  });

  it("refuses a boost the account's LEVEL hasn't unlocked (Phase E)", async () => {
    const s = await player(0, 999, 24); // gift vouchers unlock at 25
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "valentine_gift" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "locked" });
    expect(r.body.balance.brains).toBe(999); // not charged
    // The level comes from server-owned xp, so a client can't claim its way past this.
    const ok = await player(0, 999, 25);
    const r2 = await call<InvRes>("POST", "/inventory/actions", ok.token, {
      actions: [{ id: aid("buy"), type: "buy", key: "valentine_gift" }],
    });
    expect(r2.body.results[0].status).toBe("applied");
  });

  it("redeems a gift voucher into a REAL roster zombie, atomically with the consume", async () => {
    const s = await player(0, 100);
    await call("POST", "/inventory/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "valentine_gift" }] });
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("redeem"), type: "use", key: "valentine_gift", unitId: "gift-unit-1" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "applied", unitKey: "ZombieActorGardenCupid" });
    expect(r.body.inventory.valentine_gift).toBe(0); // voucher consumed
    // The granted unit is REAL server state, under the id the client asked for and
    // priced as the catalog Cupid (cost 100 → sell 50). Before this path existed the
    // client spawned it locally and the server never saw it, so the sell bounced.
    const sell = await call<{ results: { status: string; gold?: number }[] }>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("gsell"), type: "sell", unitId: "gift-unit-1" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 50 });
  });

  it("won't redeem a voucher it doesn't own — no voucher, no zombie", async () => {
    const s = await player(0, 0);
    const r = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("redeem"), type: "use", key: "crazy_zombie_voucher", unitId: "ghost-1" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "none_owned" });
    // No unit was filed: selling the id the redeem asked for finds nothing.
    const sell = await call<{ results: { status: string; error?: string }[] }>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("gsell"), type: "sell", unitId: "ghost-1" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected" });
  });

  it("enforces 1-per-farm: a second voucher for a zombie you own won't redeem", async () => {
    const s = await player(0, 300);
    // Two Valentine vouchers (the 2012 one grants the SAME Cupid zombie).
    await call("POST", "/inventory/actions", s.token, {
      actions: [
        { id: aid("buy"), type: "buy", key: "valentine_gift" },
        { id: aid("buy"), type: "buy", key: "valentine_gift_2012" },
      ],
    });
    const first = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("redeem"), type: "use", key: "valentine_gift", unitId: "cupid-a" }],
    });
    expect(first.body.results[0].status).toBe("applied");
    // Already own Cupid → the other voucher is refused AND stays in the inventory
    // (rejected before the consume), so nothing is silently burned.
    const second = await call<InvRes>("POST", "/inventory/actions", s.token, {
      actions: [{ id: aid("redeem"), type: "use", key: "valentine_gift_2012", unitId: "cupid-b" }],
    });
    expect(second.body.results[0]).toMatchObject({ status: "rejected", error: "already_owned" });
    expect(second.body.inventory.valentine_gift_2012).toBe(1);
  });

  it("is idempotent: replaying a redeem grants one zombie, not two", async () => {
    const s = await player(0, 100);
    await call("POST", "/inventory/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "crazy_zombie_voucher" }] });
    const id = aid("redeem");
    const body = { actions: [{ id, type: "use", key: "crazy_zombie_voucher", unitId: "crazy-1" }] };
    const first = await call<InvRes>("POST", "/inventory/actions", s.token, body);
    expect(first.body.results[0].status).toBe("applied");
    const replay = await call<InvRes>("POST", "/inventory/actions", s.token, body);
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.inventory.crazy_zombie_voucher).toBe(0); // not driven to -1
    // Exactly one zombie exists (the roster is non-empty, so this sync is a pure read).
    const sync = await call<{ count: number }>("POST", "/roster/sync", s.token, { units: [] });
    expect(sync.body.count).toBe(1); // one zombie, not two
  });

  it("consumes an invasion voucher server-side to bypass the raid cooldown; refuses without one", async () => {
    const s = await player();
    // Raid + finish to arm the cooldown.
    const start = await call<{ sessionId: string }>("POST", "/raid/start", s.token, { raidId: 1 });
    await call("POST", "/raid/finish", s.token, { sessionId: start.body.sessionId, win: false });
    // On cooldown, no voucher held → bypass refused.
    const noVoucher = await call<{ ok: boolean; error?: string }>("POST", "/raid/start", s.token, { raidId: 1, bypass: true });
    expect(noVoucher.body).toMatchObject({ ok: false, error: "no_voucher" });
    // Buy a voucher, then the bypass succeeds AND the voucher is consumed.
    await call("POST", "/inventory/actions", s.token, { actions: [{ id: aid("buy"), type: "buy", key: "invasion_voucher" }] });
    const bypass = await call<{ ok: boolean; bypassed: boolean }>("POST", "/raid/start", s.token, { raidId: 1, bypass: true });
    expect(bypass.body).toMatchObject({ ok: true, bypassed: true });
    const inv = await call<{ inventory: Record<string, number> }>("POST", "/inventory/sync", s.token, { counts: {} });
    expect(inv.body.inventory.invasion_voucher).toBe(0); // consumed
  });
});
