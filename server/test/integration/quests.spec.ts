import { describe, expect, it } from "vitest";
import { call, signIn, uniqueSub } from "./helpers";

interface QuestState {
  completed: string[];
  progress: { questId: string; counts: number[] }[];
}

describe("quests — server-owned event progression", () => {
  it("retires direct client completion claims without paying value", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const forged = await call<{ error: string }>("POST", "/quest/complete", s.token, { questId: "70" });
    expect(forged.status).toBe(410);
    expect(forged.body.error).toBe("client_upgrade_required");
    const balance = await call<{ xp: number }>("POST", "/economy/sync", s.token, { seed: {} });
    expect(balance.body.xp).toBe(0);
  });

  it("advances and completes a playable quest only from accepted commands", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const actions = [0, 1, 2].map((n) => ({ id: `plow-${uniqueSub()}`, type: "plow", oc: 8 + n, or: 8 }));
    const applied = await call<{ balance: { gold: number; xp: number }; questChanges: { questId: string; completed: boolean }[] }>(
      "POST",
      "/farm/actions",
      s.token,
      { actions }
    );
    expect(applied.body.balance).toMatchObject({ gold: 70, xp: 13 });
    expect(applied.body.questChanges).toContainEqual(expect.objectContaining({ questId: "70", completed: true }));
    const state = await call<QuestState>("GET", "/quest/state", s.token);
    expect(state.body.completed).toContain("70");
  });

  it("does not double count a retried trusted action", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 100, brains: 0, xp: 0 } });
    const action = { id: `plow-${uniqueSub()}`, type: "plow", oc: 8, or: 8 };
    await call("POST", "/farm/actions", s.token, { actions: [action] });
    await call("POST", "/farm/actions", s.token, { actions: [action] });
    const state = await call<QuestState>("GET", "/quest/state", s.token);
    expect(state.body.progress.find((p) => p.questId === "70")?.counts).toEqual([1]);
  });
});
