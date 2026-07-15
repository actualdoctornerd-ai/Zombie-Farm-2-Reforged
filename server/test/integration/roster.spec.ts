import { describe, it, expect } from "vitest";
import { call, signIn, type Session } from "./helpers";

// Server-owned roster (P12): the server keeps a money+validation shadow of the units.
// A SELL is priced + credited server-side (a unit the server doesn't own can't be
// sold for gold); veteran/casualty keep the shadow accurate. There is NO public grant
// (it would let a client mint any zombie then sell it) — units enter only via the
// one-time save-migration seed or the server-validated combine (see combine.spec).

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
  it("permanently closes an empty roster import", async () => {
    const s = await player(0);
    expect((await call<{ count: number }>("POST", "/roster/sync", s.token, { units: [] })).body.count).toBe(0);
    const reseed = await call<{ count: number }>("POST", "/roster/sync", s.token, {
      units: [{ id: "late", key: "ZombieActorGardenTier4" }],
    });
    expect(reseed.body.count).toBe(0);
  });

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

  it("rejects a public grant action, so a client can't mint then sell a unit", async () => {
    const s = await player(0);
    // The `grant` action was removed: it's an unknown type now → rejected, nothing recorded.
    const grant = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("grant"), type: "grant", unitId: "z10", key: "ZombieActorLargeTier4" } as never, // cost 160 — must NOT mint
      ],
    });
    expect(grant.body.results[0]).toMatchObject({ status: "rejected", error: "bad_type" });
    // No unit was recorded, so it can't be sold for gold.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "z10" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    expect(sell.body.balance.gold).toBe(0);
  });

  it("seed-once: a later /roster/sync can't inject more units (no re-injection→sell)", async () => {
    const s = await player(0);
    const first = await call<{ count: number }>("POST", "/roster/sync", s.token, {
      units: [{ id: "z1", key: "ZombieActorRegularTier1" }],
    });
    expect(first.body.count).toBe(1);
    // Roster is now non-empty → a second sync with a fresh id is ignored entirely.
    const second = await call<{ count: number }>("POST", "/roster/sync", s.token, {
      units: [{ id: "zInjected", key: "ZombieActorGardenTier4" }], // would sell for 150
    });
    expect(second.body.count).toBe(1); // NOT 2 — injection refused
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "zInjected" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    expect(sell.body.balance.gold).toBe(0);
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

  it("rejects client-authored casualty claims", async () => {
    const s = await player(0);
    await call("POST", "/roster/sync", s.token, {
      units: [
        { id: "p1", key: "ZombieActorRegularTier1" },
        { id: "p2", key: "ZombieActorGardenTier2" }, // cost 190 → sell 95
      ],
    });
    const forged = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("cas"), type: "casualty", unitIds: ["p1"] }],
    });
    expect(forged.body.results[0]).toMatchObject({ status: "rejected", error: "server_only_raid_result" });
    // The forged casualty changed nothing, so both units remain sellable.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("sell"), type: "sell", unitId: "p1" },
        { id: aid("sell"), type: "sell", unitId: "p2" },
      ],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 17 });
    expect(sell.body.results[1]).toMatchObject({ status: "applied", gold: 95 });
  });
});
