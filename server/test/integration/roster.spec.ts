import { describe, it, expect } from "vitest";
import { call, signIn, type Session } from "./helpers";

// Server-owned roster (P12): the server keeps a money+validation shadow of the units.
// A SELL is priced + credited server-side (a unit the server doesn't own can't be
// sold for gold); grant/veteran/casualty keep the shadow accurate.

interface RosterRes {
  balance: { gold: number };
  results: { id: string; status: string; error?: string; gold?: number }[];
}

async function player(gold = 0): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

let n = 0;
const aid = (p: string) => `${p}-${n++}`;

describe("roster — server-owned units", () => {
  it("seeds units from the save and sells one for the exact catalog value", async () => {
    const s = await player(0);
    const count = await call<{ count: number }>("POST", "/roster/sync", s.token, {
      units: [
        { id: "z1", key: "ZombieActorRegularTier1", invasions: 0 }, // cost 35 → sell 17
        { id: "z2", key: "ZombieActorGardenTier4" }, // cost 300 → sell 150
      ],
    });
    expect(count.body.count).toBe(2);
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "z1" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 17 });
    expect(sell.body.balance.gold).toBe(17);
  });

  it("refuses to sell a unit the server doesn't own (no fabricated-zombie gold)", async () => {
    const s = await player(0);
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "ghost" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    expect(sell.body.balance.gold).toBe(0);
  });

  it("grants a real unit (then it's sellable) and rejects a fabricated key", async () => {
    const s = await player(0);
    const grant = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("grant"), type: "grant", unitId: "z10", key: "ZombieActorLargeTier4" }, // cost 160 → sell 80
        { id: aid("grant"), type: "grant", unitId: "z11", key: "ZombieActorSuperCheat" },
      ],
    });
    expect(grant.body.results[0].status).toBe("applied");
    expect(grant.body.results[1]).toMatchObject({ status: "rejected", error: "bad_key" });
    // The granted unit can be sold; the rejected one can't (never recorded).
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("sell"), type: "sell", unitId: "z10" },
        { id: aid("sell"), type: "sell", unitId: "z11" },
      ],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 80 });
    expect(sell.body.results[1]).toMatchObject({ status: "rejected", error: "no_unit" });
  });

  it("is idempotent: replaying a sell doesn't double-credit", async () => {
    const s = await player(0);
    await call("POST", "/roster/sync", s.token, { units: [{ id: "zA", key: "ZombieActorRegularTier1" }] });
    const id = aid("sell");
    const first = await call<RosterRes>("POST", "/roster/actions", s.token, { actions: [{ id, type: "sell", unitId: "zA" }] });
    expect(first.body.balance.gold).toBe(17);
    const replay = await call<RosterRes>("POST", "/roster/actions", s.token, { actions: [{ id, type: "sell", unitId: "zA" }] });
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.balance.gold).toBe(17); // not 34
  });

  it("combine = casualty(parents) + grant(result); a parent can't then be sold", async () => {
    const s = await player(0);
    await call("POST", "/roster/sync", s.token, {
      units: [
        { id: "p1", key: "ZombieActorRegularTier1" },
        { id: "p2", key: "ZombieActorRegularTier1" },
      ],
    });
    await call("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("cas"), type: "casualty", unitIds: ["p1", "p2"] },
        { id: aid("grant"), type: "grant", unitId: "r1", key: "ZombieActorGardenTier2" }, // cost 190 → sell 95
      ],
    });
    // A consumed parent is gone; the result is sellable.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("sell"), type: "sell", unitId: "p1" },
        { id: aid("sell"), type: "sell", unitId: "r1" },
      ],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    expect(sell.body.results[1]).toMatchObject({ status: "applied", gold: 95 });
  });
});
