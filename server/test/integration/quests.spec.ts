import { describe, expect, it } from "vitest";
import { call, signIn, uniqueSub } from "./helpers";

interface QuestState {
  completed: string[];
  progress: { questId: string; counts: number[] }[];
}

describe("quests - client-paced, bounded-once rewards", () => {
  it("pays a catalog quest once and never pays a duplicate claim", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });

    const first = await call<{ status: string; balance: { xp: number } }>(
      "POST",
      "/quest/complete",
      s.token,
      { questId: "70" }
    );
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("applied");
    expect(first.body.balance.xp).toBe(10);

    const duplicate = await call<{ status: string; balance: { xp: number } }>(
      "POST",
      "/quest/complete",
      s.token,
      { questId: "70" }
    );
    expect(duplicate.body.status).toBe("duplicate");
    expect(duplicate.body.balance.xp).toBe(10);

    const balance = await call<{ xp: number }>("POST", "/economy/sync", s.token, { seed: {} });
    expect(balance.body.xp).toBe(10);
  });

  it("allows exactly one winner across concurrent claims for the same quest", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        call<{ status: string }>("POST", "/quest/complete", s.token, { questId: "70" })
      )
    );

    expect(claims.filter((claim) => claim.body.status === "applied")).toHaveLength(1);
    expect(claims.filter((claim) => claim.body.status === "duplicate")).toHaveLength(19);
    const balance = await call<{ xp: number }>("POST", "/economy/sync", s.token, { seed: {} });
    expect(balance.body.xp).toBe(10);
  });

  it("does not wait for server event reconstruction", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const actions = [0, 1, 2].map((n) => ({ id: `plow-${uniqueSub()}`, type: "plow", oc: 8 + n, or: 8 }));
    const applied = await call<{
      balance: { gold: number; xp: number };
      questChanges: { questId: string; completed: boolean }[];
    }>("POST", "/farm/actions", s.token, { actions });

    expect(applied.body.balance).toMatchObject({ gold: 70, xp: 3 });
    expect(applied.body.questChanges).toEqual([]);
    const state = await call<QuestState>("GET", "/quest/state", s.token);
    expect(state.body.completed).not.toContain("70");
    expect(state.body.progress.find((p) => p.questId === "70")).toBeUndefined();
  });

  it("rejects unknown quest ids without granting value", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const result = await call<{ status: string; error?: string }>(
      "POST",
      "/quest/complete",
      s.token,
      { questId: "not-a-quest" }
    );
    expect(result.body).toMatchObject({ status: "rejected", error: "bad_quest" });
  });
});
