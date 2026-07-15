import { describe, it, expect } from "vitest";
import { call, signIn, type Session } from "./helpers";

// Phase C — server-authoritative quest rewards (bounded-once) + the level-up reward
// they can trigger. A completed quest grants its SERVER-catalog reward at most once;
// currency rewards hit the balance, an xp reward can cross a level threshold and pay a
// level-up brain, and item/zombie rewards are recorded but deferred (Phase D).

interface QuestRes {
  status: string;
  error?: string;
  balance: { gold: number; brains: number; xp: number };
  granted: { gold: number; brains: number; xp: number };
  deferred: boolean;
}

async function player(): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
  return s;
}

describe("quests — bounded-once server rewards", () => {
  it("grants an xp quest's catalog reward once AND pays the level-up brain it triggers", async () => {
    const s = await player();
    // Quest "0" = 30 XP. From 0 xp that crosses the level-2 threshold (25) → +1 brain.
    const r = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "0" });
    expect(r.body.status).toBe("applied");
    expect(r.body.balance.xp).toBe(30);
    expect(r.body.balance.brains).toBe(1); // level 1→2 level-up reward, server-derived
    expect(r.body.granted).toMatchObject({ xp: 30, brains: 1 });
  });

  it("is bounded-once: re-completing the same quest grants nothing", async () => {
    const s = await player();
    const first = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "0" });
    expect(first.body.status).toBe("applied");
    const again = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "0" });
    expect(again.body.status).toBe("duplicate");
    expect(again.body.balance.xp).toBe(30); // not 60
    expect(again.body.granted).toMatchObject({ gold: 0, brains: 0, xp: 0 });
  });

  it("grants a gold quest and a brains quest their exact catalog amounts", async () => {
    const s = await player();
    const gold = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "54" }); // 20 gold
    expect(gold.body.balance.gold).toBe(20);
    expect(gold.body.granted.gold).toBe(20);
    const brains = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "1010" }); // 5 brains
    expect(brains.body.balance.brains).toBe(5);
    expect(brains.body.granted.brains).toBe(5);
  });

  it("records an item/zombie quest but defers the grant (no currency, blocked from re-run)", async () => {
    const s = await player();
    const item = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "36" }); // item
    expect(item.body).toMatchObject({ status: "applied", deferred: true });
    expect(item.body.granted).toMatchObject({ gold: 0, brains: 0, xp: 0 });
    const zombie = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "1000" }); // zombie
    expect(zombie.body).toMatchObject({ status: "applied", deferred: true });
    // Re-running the recorded item quest still grants nothing (once-guard holds).
    const dupe = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "36" });
    expect(dupe.body.status).toBe("duplicate");
  });

  it("rejects an unknown quest id (no catalog reward to mint)", async () => {
    const s = await player();
    const r = await call<QuestRes>("POST", "/quest/complete", s.token, { questId: "99999" });
    expect(r.body).toMatchObject({ status: "rejected", error: "bad_quest" });
    expect(r.body.balance).toMatchObject({ gold: 0, brains: 0, xp: 0 });
  });
});
