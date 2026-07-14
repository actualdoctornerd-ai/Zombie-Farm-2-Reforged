import { describe, it, expect } from "vitest";
import { call, signIn, type Session } from "./helpers";

// Server-authoritative raid rewards (P10): /raid/finish credits the server-computed
// base win gold + first-clear XP for the session's pinned raid, idempotently, capped
// at that raid's real ceiling. Whether the player "won" is client-asserted here, which
// is exactly the deferred gap — the point is that the CREDIT can't be fabricated.

interface FinishRes {
  lastRaidAt: number;
  balance: { gold: number; xp: number };
  gold: number;
  xp: number;
  firstClear: boolean;
}

async function player(gold = 0): Promise<Session> {
  const s = await signIn();
  // Seed a (mostly) zeroed server balance so reward deltas are easy to read. `gold`
  // lets a test that needs to bypass the cooldown afford an invasion voucher.
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

/** Buy one invasion voucher (server-owned; needed to bypass the cooldown). */
async function buyVoucher(s: Session): Promise<void> {
  await call("POST", "/inventory/actions", s.token, {
    actions: [{ id: `v-${Math.floor(Date.now() % 1e6)}-${Math.random()}`, type: "buy", key: "invasion_voucher" }],
  });
}

async function startRaid(s: Session, raidId = 1, bypass = false): Promise<string> {
  const r = await call<{ ok: boolean; sessionId: string }>("POST", "/raid/start", s.token, { raidId, bypass });
  if (!r.body.ok) throw new Error("raid start refused");
  return r.body.sessionId;
}

describe("raid rewards — server-authoritative", () => {
  it("credits base win gold + first-clear XP for a win (McDonnell = 1600/100)", async () => {
    const s = await player();
    const sid = await startRaid(s, 1);
    const fin = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: true, survivalFrac: 1 });
    expect(fin.body).toMatchObject({ gold: 1600, xp: 100, firstClear: true });
    expect(fin.body.balance).toMatchObject({ gold: 1600, xp: 100 });
  });

  it("clamps a fabricated survival fraction to the raid ceiling", async () => {
    const s = await player();
    const sid = await startRaid(s, 1);
    // survivalFrac 99 → clamped to 1 → the raid's real max, not more.
    const fin = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: true, survivalFrac: 99 });
    expect(fin.body.gold).toBe(1600);
  });

  it("grants first-clear XP only once; a repeat win pays gold but no XP", async () => {
    const s = await player(5000); // gold to afford a voucher for the second raid
    const first = await call<FinishRes>("POST", "/raid/finish", s.token, {
      sessionId: await startRaid(s, 1),
      win: true,
      survivalFrac: 1,
    });
    expect(first.body).toMatchObject({ xp: 100, firstClear: true });
    // Second clear of the SAME raid (bypass the cooldown with a voucher): gold again, XP 0.
    await buyVoucher(s);
    const second = await call<FinishRes>("POST", "/raid/finish", s.token, {
      sessionId: await startRaid(s, 1, true),
      win: true,
      survivalFrac: 1,
    });
    expect(second.body).toMatchObject({ gold: 1600, xp: 0, firstClear: false });
    expect(second.body.balance.xp).toBe(100); // still just the one grant
  });

  it("credits nothing for a loss", async () => {
    const s = await player();
    const sid = await startRaid(s, 1);
    const fin = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: false, survivalFrac: 1 });
    expect(fin.body).toMatchObject({ gold: 0, xp: 0 });
    expect(fin.body.balance).toMatchObject({ gold: 0, xp: 0 });
  });

  it("is idempotent — replaying a finish credits nothing more", async () => {
    const s = await player();
    const sid = await startRaid(s, 1);
    const a = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: true, survivalFrac: 1 });
    expect(a.body.balance.gold).toBe(1600);
    const b = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: true, survivalFrac: 1 });
    expect(b.body).toMatchObject({ gold: 0, xp: 0 }); // nothing credited this call
    expect(b.body.balance.gold).toBe(1600); // balance unchanged
  });
});
