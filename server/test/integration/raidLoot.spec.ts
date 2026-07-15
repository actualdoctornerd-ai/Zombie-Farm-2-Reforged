import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, xpForLevel, type Session } from "./helpers";

// T2 — the raid loot roll is SERVER-owned. The drop decides real value (a boost, bonus
// gold, or a placeable), so a client naming its own prize is a mint. It was ALSO simply
// broken online: the client's grants routed through the spend-only economy and the removed
// inventory `grant`, so raid loot silently evaporated. Both are fixed here.
//
// The roll is random, so these assert the INVARIANTS (a drop always happens; it lands in
// real server state; dice are consumed and pinned) rather than a specific item.

interface FinishRes {
  gold: number;
  xp: number;
  firstClear: boolean;
  loot: { name: string; kind: string } | null;
  balance: { gold: number; brains: number; xp: number };
}
interface StartRes {
  ok: boolean;
  sessionId?: string;
  dice?: number;
}

const aid = (p: string) => `${p}-${uniqueSub()}`;

async function player(gold = 0, level = 1): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: xpForLevel(level) } });
  return s;
}

const start = (s: Session, raidId = 1, bypass = false, dice = 0) =>
  call<StartRes>("POST", "/raid/start", s.token, { raidId, bypass, dice });
const finish = (s: Session, sessionId: string) =>
  call<FinishRes>("POST", "/raid/finish", s.token, { sessionId, win: true, survivalFrac: 1 });
const storage = (s: Session) =>
  call<{ received: Record<string, number>; stored: Record<string, number> }>("POST", "/storage/sync", s.token, {});
const boosts = async (s: Session): Promise<Record<string, number>> =>
  (await call<{ inventory: Record<string, number> }>("POST", "/inventory/sync", s.token, { counts: {} })).body.inventory;

async function buy(s: Session, key: string): Promise<void> {
  await call("POST", "/inventory/actions", s.token, { actions: [{ id: aid("b"), type: "buy", key }] });
}

describe("raid loot — server-rolled", () => {
  it("always drops something on a win, and it lands in REAL server state", async () => {
    // raid 1's tier 0 is Bonus Gold, so a win can never come away empty.
    const s = await player();
    const r = await finish(s, (await start(s)).body.sessionId!);
    expect(r.body.loot).not.toBeNull();
    const { name, kind } = r.body.loot!;
    expect(["gold", "boost", "item"]).toContain(kind);
    if (kind === "gold") {
      // Bonus gold is CREDITED on top of the base win gold (McDonnell base 1600, rec
      // level 5 -> 500 bonus). Before T2 this went through the spend-only economy and was
      // rejected outright.
      expect(r.body.gold).toBe(1600 + 500);
      expect(r.body.balance.gold).toBe(2100);
    } else if (kind === "boost") {
      expect(r.body.gold).toBe(1600);
      const inv = await boosts(s);
      expect(Object.values(inv).some((n) => n > 0)).toBe(true); // the boost really landed
    } else {
      expect(r.body.gold).toBe(1600);
      const st = await storage(s);
      expect(st.body.received[name]).toBe(1); // the item really landed in Received
    }
  });

  it("loot never pays brains — a repeatable win can't mint premium currency", async () => {
    // The brain drop stays deferred while `win` is client-asserted, because a forged win
    // would make brains unlimited (tickets are intended play, so raids aren't rate-capped).
    //
    // Brains CAN legitimately move on the first clear: its XP may cross a level threshold
    // and level-ups pay +1 brain each. That's bounded — first-clear XP is once per raid.
    // What must never happen is brains rising from REPEAT wins, which is what an
    // unbounded faucet would look like.
    const s = await player(40000);
    const first = await finish(s, (await start(s, 1)).body.sessionId!);
    expect(first.body.firstClear).toBe(true);
    const afterFirstClear = first.body.balance.brains; // level-up brains from the 100 xp
    for (let i = 0; i < 6; i++) {
      await buy(s, "invasion_voucher");
      const st = await start(s, 1, true);
      expect(st.body.ok).toBe(true);
      const r = await finish(s, st.body.sessionId!);
      expect(r.body).toMatchObject({ firstClear: false, xp: 0 }); // no repeat first-clear xp
      expect(r.body.loot?.kind).not.toBe("brains");
      expect(r.body.balance.brains).toBe(afterFirstClear); // flat, however many wins
    }
  });

  it("consumes Golden Dice at START and pins them to the session", async () => {
    const s = await player(0);
    // Buy 2 dice (10 brains each) — needs brains, so seed them via a fresh account.
    const rich = await signIn();
    await call("POST", "/economy/sync", rich.token, { seed: { gold: 0, brains: 100, xp: 0 } });
    await buy(rich, "golden_dice");
    await buy(rich, "golden_dice");
    expect((await boosts(rich)).golden_dice).toBe(2);
    const st = await start(rich, 1, false, 2);
    expect(st.body).toMatchObject({ ok: true, dice: 2 });
    expect((await boosts(rich)).golden_dice ?? 0).toBe(0); // spent server-side
    await finish(rich, st.body.sessionId!);
    void s;
  });

  it("can't claim more luck than it owns — dice are capped by the real count", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 10, xp: 0 } });
    await buy(s, "golden_dice"); // exactly 1
    // Ask for 99 dice; only 1 is held, so only 1 is spent and pinned.
    const st = await start(s, 1, false, 99);
    expect(st.body).toMatchObject({ ok: true, dice: 1 });
    expect((await boosts(s)).golden_dice ?? 0).toBe(0);
  });

  it("spends no dice when none are held, and the raid still starts", async () => {
    const s = await player();
    const st = await start(s, 1, false, 5);
    expect(st.body).toMatchObject({ ok: true, dice: 0 });
  });

  it("credits loot ONCE — a replayed finish drops nothing more", async () => {
    const s = await player();
    const sid = (await start(s)).body.sessionId!;
    const first = await finish(s, sid);
    expect(first.body.loot).not.toBeNull();
    const replay = await finish(s, sid);
    expect(replay.body).toMatchObject({ gold: 0, xp: 0, loot: null });
    expect(replay.body.balance.gold).toBe(first.body.balance.gold); // unchanged
  });

  it("drops nothing for a LOSS", async () => {
    const s = await player();
    const sid = (await start(s)).body.sessionId!;
    const r = await call<FinishRes>("POST", "/raid/finish", s.token, { sessionId: sid, win: false, survivalFrac: 1 });
    expect(r.body.loot).toBeNull();
    expect(r.body.balance.gold).toBe(0);
  });
});

describe("item storage — server-owned Received + shed", () => {
  it("imports a save's Received + shed items once, then ignores further imports", async () => {
    const s = await player();
    const first = await call<{ received: Record<string, number>; stored: Record<string, number> }>(
      "POST",
      "/storage/sync",
      s.token,
      { received: ["Scarecrow", "Scarecrow", "Haystack"], stored: [{ key: "Windmill", count: 1 }] }
    );
    expect(first.body.received).toEqual({ Scarecrow: 2, Haystack: 1 });
    expect(first.body.stored).toEqual({ Windmill: 1 });
    // A second import is ignored (storage_seeded already fired) — else a client could
    // re-import items whenever it held none.
    const second = await call<{ received: Record<string, number> }>("POST", "/storage/sync", s.token, {
      received: ["Windmill", "Parrot"],
    });
    expect(second.body.received).toEqual({ Scarecrow: 2, Haystack: 1 });
  });

  it("drops junk item names from an import", async () => {
    const s = await player();
    const r = await call<{ received: Record<string, number> }>("POST", "/storage/sync", s.token, {
      received: ["Scarecrow", "NotARealDrop", ""],
      stored: [{ key: "AlsoFake", count: 3 }],
    });
    expect(r.body.received).toEqual({ Scarecrow: 1 });
  });

  it("won't re-drop a UNIQUE the account already owns", async () => {
    // Own every unique raid 1 can drop, then win it many times: the roll must never
    // return one. This is the filter that stops a unique being farmed.
    const s = await player(60000);
    await call("POST", "/storage/sync", s.token, { received: ["Windmill", "Farmer Banner"] });
    for (let i = 0; i < 8; i++) {
      if (i > 0) await buy(s, "invasion_voucher");
      const st = await start(s, 1, i > 0, 0);
      const r = await finish(s, st.body.sessionId!);
      expect(["Windmill", "Farmer Banner"]).not.toContain(r.body.loot?.name);
    }
    const stg = await storage(s);
    expect(stg.body.received.Windmill).toBe(1); // still exactly the one imported
  });
});
