import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, xpForLevel, type Session } from "./helpers";

// T1 — raid session + gate hardening. These are the checks that DON'T need deterministic
// replay: which raids you may invade (server-derived level), one open raid at a time,
// and refusing a session that outlived its TTL.
//
// NOTE: the between-raids cooldown is deliberately NOT a rate limit — skipping it with an
// Invasion Voucher is intended play — so nothing here caps how often you may raid.

interface StartRes {
  ok: boolean;
  sessionId?: string;
  bypassed?: boolean;
  error?: string;
  unlockLevel?: number;
  cooldownRemaining?: number;
}
interface FinishRes {
  gold: number;
  xp: number;
  firstClear: boolean;
  expired?: boolean;
  balance: { gold: number; xp: number };
}

const aid = (p: string) => `${p}-${uniqueSub()}`;

async function player(level: number, gold = 0): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: xpForLevel(level) } });
  return s;
}

const start = (s: Session, raidId: number, bypass = false) =>
  call<StartRes>("POST", "/raid/start", s.token, { raidId, bypass });

const finish = (s: Session, sessionId: string, win = true, survivalFrac = 1) =>
  call<FinishRes>("POST", "/raid/finish", s.token, { sessionId, win, survivalFrac });

async function buyVoucher(s: Session): Promise<void> {
  await call("POST", "/inventory/actions", s.token, {
    actions: [{ id: aid("v"), type: "buy", key: "invasion_voucher" }],
  });
}

const voucherCount = async (s: Session): Promise<number> => {
  const r = await call<{ inventory: Record<string, number> }>("POST", "/inventory/sync", s.token, { counts: {} });
  return r.body.inventory.invasion_voucher ?? 0;
};

describe("raid gates — unlock level", () => {
  it("refuses the richest raid at level 1, and pays NOTHING for a forged finish", async () => {
    // The headline hole: raid 9 pays 5000+1200 gold AND 5500 first-clear XP, and XP buys
    // level-up brains — so an ungated start turned a fabricated win into premium currency.
    const s = await player(1);
    const r = await start(s, 9);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: "locked", unlockLevel: 43 });
    // No session was opened, so there's nothing to settle: a made-up id credits nothing.
    const f = await finish(s, "fabricated-session-id");
    expect(f.body).toMatchObject({ gold: 0, xp: 0 });
    expect(f.body.balance).toMatchObject({ gold: 0, xp: 0 });
  });

  it("allows the richest raid once the account's SERVER xp reaches its unlock level", async () => {
    const s = await player(43);
    const r = await start(s, 9);
    expect(r.body.ok).toBe(true);
    const f = await finish(s, r.body.sessionId!);
    expect(f.body).toMatchObject({ gold: 6200, xp: 5500, firstClear: true }); // 5000 + 1200
  });

  it("gates on SERVER xp, not on anything the client says", async () => {
    const s = await player(42); // one level short of raid 9
    expect((await start(s, 9)).body).toMatchObject({ ok: false, error: "locked" });
    // The starter raid (unlock level 0) is unaffected.
    expect((await start(s, 1)).body.ok).toBe(true);
  });
});

describe("raid gates — one open session", () => {
  it("refuses a second raid while one is in progress", async () => {
    // The cooldown clock only advances at FINISH, so without a reserve a client could
    // open many sessions in the pre-first-finish window and bank the ids to settle later.
    const s = await player(1);
    const a = await start(s, 1);
    expect(a.body.ok).toBe(true);
    const b = await start(s, 1);
    expect(b.status).toBe(409);
    expect(b.body).toMatchObject({ ok: false, error: "raid_in_progress" });
    // Finishing the open one frees the slot again.
    await finish(s, a.body.sessionId!);
  });

  it("refunds a bypass voucher when the reserve loses — a ticket is never silently eaten", async () => {
    const s = await player(1, 5000);
    // Raid + finish to arm the cooldown, so a further start needs a voucher.
    await finish(s, (await start(s, 1)).body.sessionId!);
    await buyVoucher(s);
    await buyVoucher(s);
    expect(await voucherCount(s)).toBe(2);
    // This one bypasses the cooldown and opens a session (voucher spent, legitimately).
    const live = await start(s, 1, true);
    expect(live.body).toMatchObject({ ok: true, bypassed: true });
    expect(await voucherCount(s)).toBe(1);
    // This one bypasses too (consuming the 2nd voucher) but LOSES the reserve — a raid is
    // already live. The voucher must come back rather than vanish.
    const blocked = await start(s, 1, true);
    expect(blocked.body).toMatchObject({ ok: false, error: "raid_in_progress" });
    expect(await voucherCount(s)).toBe(1); // refunded, not eaten
  });

  it("lets an ABANDONED session age out instead of locking the account out forever", async () => {
    // Browser closed mid-raid: the session is never finished. Once it passes its TTL it
    // stops being "live", so a new raid can start. (TTL is 3s in .dev.vars.)
    const s = await player(1);
    const a = await start(s, 1);
    expect(a.body.ok).toBe(true);
    expect((await start(s, 1)).body.error).toBe("raid_in_progress"); // still live
    await new Promise((r) => setTimeout(r, 3300));
    const b = await start(s, 1);
    expect(b.body.ok).toBe(true); // aged out -> allowed
    await finish(s, b.body.sessionId!);
  });
});

describe("raid gates — session expiry at finish", () => {
  it("refuses to settle a session that outlived its TTL, crediting nothing", async () => {
    // expires_at used to be written but only ever read by the cron purge, so a stale
    // session could be banked and cashed in much later. (TTL is 3s in .dev.vars.)
    const s = await player(1);
    const r = await start(s, 1);
    await new Promise((res) => setTimeout(res, 3300));
    const f = await finish(s, r.body.sessionId!, true, 1);
    expect(f.body.expired).toBe(true);
    expect(f.body).toMatchObject({ gold: 0, xp: 0 });
    expect(f.body.balance).toMatchObject({ gold: 0, xp: 0 }); // nothing credited
    // And it can't be retried into a payout.
    const again = await finish(s, r.body.sessionId!, true, 1);
    expect(again.body).toMatchObject({ gold: 0, xp: 0 });
  });
});

describe("raid progress — server-owned lifetime wins", () => {
  it("imports a migrating save's wins once, so first-clear XP isn't re-earned", async () => {
    const s = await player(43);
    // A veteran arrives having already cleared raids 1 and 9.
    const sync = await call<{ progress: Record<string, number> }>("POST", "/raid/sync", s.token, {
      completed: { "1": 3, "9": 1 },
    });
    expect(sync.body.progress).toMatchObject({ "1": 3, "9": 1 });
    // Re-clearing raid 9 now pays gold but NOT its 5500 first-clear XP.
    const f = await finish(s, (await start(s, 9)).body.sessionId!);
    expect(f.body).toMatchObject({ gold: 6200, xp: 0, firstClear: false });
    expect(f.body.balance.xp).toBe(xpForLevel(43)); // unchanged by the raid
  });

  it("imports exactly once — a client can't re-declare wins to unlock abilities", async () => {
    const s = await player(1);
    await call("POST", "/raid/sync", s.token, { completed: { "1": 1 } });
    const second = await call<{ progress: Record<string, number> }>("POST", "/raid/sync", s.token, {
      completed: { "1": 99, "2": 99 },
    });
    expect(second.body.progress).toEqual({ "1": 1 }); // not 99, and no raid 2
  });

  it("counts real wins, and drops junk raid ids from an import", async () => {
    const s = await player(1, 5000);
    await call("POST", "/raid/sync", s.token, { completed: { "999": 5, notARaid: 3 } });
    const st0 = await call<{ progress: Record<string, number> }>("GET", "/raid/state", s.token);
    expect(st0.body.progress).toEqual({}); // junk dropped
    // Win raid 1 twice (voucher bypasses the cooldown for the second).
    await finish(s, (await start(s, 1)).body.sessionId!);
    await buyVoucher(s);
    await finish(s, (await start(s, 1, true)).body.sessionId!);
    const st = await call<{ progress: Record<string, number> }>("GET", "/raid/state", s.token);
    expect(st.body.progress).toEqual({ "1": 2 });
  });
});
