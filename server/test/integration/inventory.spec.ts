import { describe, it, expect } from "vitest";
import { call, signIn, type Session } from "./helpers";

// Server-owned boost inventory (P11): buy debits the exact catalog price + grants,
// use decrements, seed/sync is one-time, and the invasion voucher is consumed
// server-side on a raid bypass (so the cooldown can't be skipped for free).

interface InvRes {
  balance: { gold: number; brains: number };
  inventory: Record<string, number>;
  results: { id: string; status: string; error?: string }[];
}

async function player(gold = 10000, brains = 500): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: 0 } });
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
