import { describe, it, expect } from "vitest";
import { call, grantRoster, signIn, befriend, makeSave, type Session } from "./helpers";

// End-to-end integration tests against the real Worker + D1. Focus: the
// concurrency/idempotency/ownership guarantees the unit tests can't cover.

// ---- save: ownership + atomic revision CAS -----------------------------
describe("save — ownership + rev CAS", () => {
  it("creates then updates a save under matching revs", async () => {
    const s = await signIn();
    expect((await call("PUT", "/save", s.token, { save: makeSave(), baseRev: 0 })).body).toMatchObject({ rev: 1 });
    expect((await call("PUT", "/save", s.token, { save: makeSave(300), baseRev: 1 })).body).toMatchObject({ rev: 2 });
    const got = await call<{ rev: number; save: { player: { gold: number } } }>("GET", "/save", s.token);
    expect(got.body.rev).toBe(2);
    expect(got.body.save.player.gold).toBe(300);
  });

  it("rejects a stale write with 409 and returns the server copy", async () => {
    const s = await signIn();
    await call("PUT", "/save", s.token, { save: makeSave(), baseRev: 0 }); // -> rev 1
    const stale = await call<{ error: string; rev: number }>("PUT", "/save", s.token, { save: makeSave(999), baseRev: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("conflict");
    expect(stale.body.rev).toBe(1);
  });

  it("lets only ONE of two concurrent first-writes win (CAS)", async () => {
    const s = await signIn();
    const [a, b] = await Promise.all([
      call("PUT", "/save", s.token, { save: makeSave(1), baseRev: 0 }),
      call("PUT", "/save", s.token, { save: makeSave(2), baseRev: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one committed, one conflicted
  });

  it("does not leak another account's save (each session sees only its own)", async () => {
    const a = await signIn();
    const b = await signIn();
    await call("PUT", "/save", a.token, { save: makeSave(111), baseRev: 0 });
    const bSave = await call<{ save: unknown }>("GET", "/save", b.token);
    expect(bSave.body.save).toBeNull(); // b has no save; can't see a's
  });

  it("rejects an oversized or invalid save", async () => {
    const s = await signIn();
    const bad = makeSave();
    (bad.farm as { w: number }).w = 1_000_000; // out of bounds
    expect((await call("PUT", "/save", s.token, { save: bad, baseRev: 0 })).status).toBe(422);
  });
});

// ---- friends: consent + non-oracle + blocks ----------------------------
describe("friends — consent, non-oracle, blocks", () => {
  it("add files a request; accept forms the friendship both ways", async () => {
    const a = await signIn();
    const b = await signIn();
    await call("POST", "/friends/add", a.token, { code: b.friendCode });
    // Not friends until accepted.
    expect((await call<unknown[]>("GET", "/friends", a.token)).body).toHaveLength(0);
    const reqs = await call<{ fromAccountId: string }[]>("GET", "/friends/requests", b.token);
    expect(reqs.body.map((r) => r.fromAccountId)).toContain(a.accountId);
    await call("POST", "/friends/accept", b.token, { fromAccountId: a.accountId });
    expect((await call<unknown[]>("GET", "/friends", a.token)).body).toHaveLength(1);
    expect((await call<unknown[]>("GET", "/friends", b.token)).body).toHaveLength(1);
  });

  it("add is a non-oracle: a nonexistent code returns the same generic ok", async () => {
    const a = await signIn();
    const r = await call<{ ok: boolean }>("POST", "/friends/add", a.token, { code: "ZF-NONEXISTENT9" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true); // indistinguishable from a real code
  });

  it("block tears down the friendship and prevents re-adding/gifting", async () => {
    const a = await signIn();
    const b = await signIn();
    await befriend(a, b);
    await call("POST", "/friends/block", a.token, { accountId: b.accountId });
    expect((await call<unknown[]>("GET", "/friends", a.token)).body).toHaveLength(0);
    // b can no longer gift a (not friends).
    await call("PUT", "/save", a.token, { save: makeSave(), baseRev: 0 });
    const gift = await call<{ error: string }>("POST", "/gifts", b.token, { toAccountId: a.accountId });
    expect(gift.status).toBe(403);
  });
});

// ---- gifts: once/day + idempotent claim credits balance once -----------
describe("gifts — daily limit + idempotent claim", () => {
  async function friendsWithSaves(): Promise<[Session, Session]> {
    const a = await signIn();
    const b = await signIn();
    await befriend(a, b);
    await call("POST", "/save", b.token, undefined); // no-op guard
    await call("PUT", "/save", a.token, { save: makeSave(), baseRev: 0 });
    await call("PUT", "/save", b.token, { save: makeSave(), baseRev: 0 });
    return [a, b];
  }

  it("enforces once-per-day per recipient", async () => {
    const [a, b] = await friendsWithSaves();
    const before = await call<{ accountId: string; giftOnCooldown: boolean }[]>("GET", "/friends", a.token);
    expect(before.body.find((f) => f.accountId === b.accountId)?.giftOnCooldown).toBe(false);
    expect((await call("POST", "/gifts", a.token, { toAccountId: b.accountId })).status).toBe(200);
    const after = await call<{ accountId: string; giftOnCooldown: boolean }[]>("GET", "/friends", a.token);
    expect(after.body.find((f) => f.accountId === b.accountId)?.giftOnCooldown).toBe(true);
    expect((await call("POST", "/gifts", a.token, { toAccountId: b.accountId })).status).toBe(429);
  });

  it("credits the BALANCE exactly once across concurrent claims", async () => {
    const [a, b] = await friendsWithSaves();
    // Seed b's balance from its save (brains 15).
    await call("POST", "/economy/sync", b.token, { seed: { gold: 200, brains: 15, xp: 0 } });
    await call("POST", "/gifts", a.token, { toAccountId: b.accountId });
    const gid = (await call<{ id: string }[]>("GET", "/gifts/inbox", b.token)).body[0].id;
    // Fire two concurrent claims of the same gift.
    const [c1, c2] = await Promise.all([
      call<{ credited: boolean; alreadyClaimed: boolean }>("POST", "/gifts/claim", b.token, { giftId: gid }),
      call<{ credited: boolean; alreadyClaimed: boolean }>("POST", "/gifts/claim", b.token, { giftId: gid }),
    ]);
    const credited = [c1.body.credited, c2.body.credited].filter(Boolean);
    expect(credited).toHaveLength(1); // exactly one claim credited
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect((await call<unknown[]>("GET", "/gifts/inbox", b.token)).body).toEqual([]);
    const bal = await call<{ brains: number }>("POST", "/economy/sync", b.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.brains).toBe(16); // 15 + one gift, never two
  });
});

// ---- economy: overdraw / cap / idempotency / concurrency ---------------
describe("economy — validation + idempotency", () => {
  async function seeded(gold = 200, brains = 15): Promise<Session> {
    const s = await signIn();
    await call("PUT", "/save", s.token, { save: makeSave(gold, brains), baseRev: 0 });
    await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: 0 } });
    return s;
  }

  it("seeds the balance from the client on first sync", async () => {
    const s = await seeded(500, 20);
    const bal = await call<{ gold: number; brains: number }>("POST", "/economy/sync", s.token, { seed: { gold: 999, brains: 999, xp: 0 } });
    expect(bal.body.gold).toBe(500); // seed only applies once; later seeds ignored
    expect(bal.body.brains).toBe(20);
  });

  it("is SPEND-ONLY: applies a spend, rejects overdraw AND any positive (earn) delta", async () => {
    const s = await seeded(100, 0);
    const r = await call<{ balance: { gold: number }; results: { status: string; error?: string }[] }>(
      "POST", "/economy/apply", s.token,
      { events: [
        { id: "a1", currency: "gold", delta: -30, reason: "purchase" }, // spend → applied
        { id: "a2", currency: "gold", delta: -200, reason: "purchase" }, // overdraw
        { id: "a3", currency: "gold", delta: 9_999_999, reason: "misc" }, // earn → forbidden
      ] }
    );
    expect(r.body.balance.gold).toBe(70); // only the -30 applied
    expect(r.body.results.map((x) => x.status)).toEqual(["applied", "rejected", "rejected"]);
    expect(r.body.results[2].error).toBe("earn_forbidden");
  });

  it("is idempotent by event id across a retry", async () => {
    const s = await seeded(100, 0);
    const ev = { events: [{ id: "dup-1", currency: "gold", delta: -25, reason: "purchase" }] };
    await call("POST", "/economy/apply", s.token, ev);
    await call("POST", "/economy/apply", s.token, ev); // retry same id
    const bal = await call<{ gold: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.gold).toBe(75); // debited once, not twice
  });

  it("lands both of two concurrent applies of DIFFERENT spends", async () => {
    const s = await seeded(100, 0);
    await Promise.all([
      call("POST", "/economy/apply", s.token, { events: [{ id: "c-a", currency: "gold", delta: -10, reason: "purchase" }] }),
      call("POST", "/economy/apply", s.token, { events: [{ id: "c-b", currency: "gold", delta: -20, reason: "purchase" }] }),
    ]);
    const bal = await call<{ gold: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.gold).toBe(70); // both debits landed (atomic add)
  });
});

// ---- raids: server cooldown gate + one-use session ---------------------
describe("raids — server cooldown + idempotent finish", () => {
  it("gates on the server cooldown and consumes the session once", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 5000, brains: 0, xp: 0 } }); // fund a voucher later
    await grantRoster(s, [{ id: "raid-z1", key: "ZombieActorRegularTier1" }]);
    const startBody = { raidId: 1, orderedUnitIds: ["raid-z1"], rulesetVersion: 3 };
    expect((await call<{ cooldownRemaining: number }>("GET", "/raid/state", s.token)).body.cooldownRemaining).toBe(0);
    const start = await call<{ ok: boolean; sessionId: string }>("POST", "/raid/start", s.token, startBody);
    expect(start.body.ok).toBe(true);
    const sid = start.body.sessionId;
    const finishBody = { sessionId: sid, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }] };
    const fin1 = await call<{ lastRaidAt: number }>("POST", "/raid/finish", s.token, finishBody);
    expect(fin1.body.lastRaidAt).toBeGreaterThan(0);
    // Now on cooldown: a plain start is refused.
    expect((await call<{ ok: boolean }>("POST", "/raid/start", s.token, startBody)).body.ok).toBe(false);
    // Without a voucher, a bypass is also refused (voucher is server-owned now).
    expect((await call<{ ok: boolean; error?: string }>("POST", "/raid/start", s.token, { ...startBody, useVoucher: true })).body.error).toBe("no_consumable_or_raid_in_progress");
    // Arm a voucher (gold was seeded at the top), then the bypass is allowed.
    await call("POST", "/inventory/actions", s.token, { actions: [{ id: "vch-" + sid, type: "buy", key: "invasion_voucher" }] });
    expect((await call<{ ok: boolean; bypassed: boolean }>("POST", "/raid/start", s.token, { ...startBody, useVoucher: true })).body.bypassed).toBe(true);
    // Finishing the SAME session again doesn't move the cooldown (idempotent).
    const fin2 = await call<{ lastRaidAt: number }>("POST", "/raid/finish", s.token, finishBody);
    expect(fin2.body.lastRaidAt).toBe(fin1.body.lastRaidAt);
    // An unknown raid id is rejected up front.
    expect((await call<{ ok: boolean }>("POST", "/raid/start", s.token, { ...startBody, raidId: 999 })).status).toBe(400);
  });
});

// ---- sessions: revocation ----------------------------------------------
describe("sessions — revocation", () => {
  it("rejects a token after logout", async () => {
    const s = await signIn();
    expect((await call("GET", "/me", s.token)).status).toBe(200);
    await call("POST", "/logout", s.token);
    expect((await call("GET", "/me", s.token)).status).toBe(401); // session revoked
  });

  it("logout-all revokes every session for the account", async () => {
    const sub = `multi-${Math.floor(Math.random() * 1e9)}`;
    const s1 = await signIn(sub);
    const s2 = await signIn(sub); // same account, second device/session
    await call("POST", "/session/logout-all", s1.token);
    expect((await call("GET", "/me", s1.token)).status).toBe(401);
    expect((await call("GET", "/me", s2.token)).status).toBe(401);
  });
});
