import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, type Session } from "./helpers";

// P14 — server-authoritative Zombie Pot combine. A combine is a two-step job:
//   combineStart  — must own both distinct parents; consumes them, records their keys.
//   combineCollect — grants the result, VALIDATED to be one of the two parent species
//                    (the pot merges masks, it never invents a new species). A result
//                    key that isn't a parent is a fabrication → rejected (job cleared).
// This closes "start a combine, then claim a pricier zombie out of it."

interface RosterRes {
  balance: { gold: number };
  results: { id: string; status: string; error?: string; gold?: number }[];
}

async function player(gold = 0): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

// Action ids must be GLOBALLY unique — the idempotency tables dedup by id across
// accounts (prod ids are random UUIDs), so uniqueSub() salts every id here.
const aid = (p: string) => `${p}-${uniqueSub()}`;

async function seedParents(s: Session, keyA = "ZombieActorRegularTier1", keyB = "ZombieActorRegularTier1") {
  await call("POST", "/roster/sync", s.token, {
    units: [
      { id: "pa", key: keyA },
      { id: "pb", key: keyB },
    ],
  });
}

describe("combine — server-authoritative pot", () => {
  it("start consumes both parents (neither is then sellable)", async () => {
    const s = await player();
    await seedParents(s);
    const start = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pa", parentBId: "pb" }],
    });
    expect(start.body.results[0].status).toBe("applied");
    // Both parents are gone — selling either is refused (no fabricated gold).
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [
        { id: aid("sell"), type: "sell", unitId: "pa" },
        { id: aid("sell"), type: "sell", unitId: "pb" },
      ],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    expect(sell.body.results[1]).toMatchObject({ status: "rejected", error: "no_unit" });
  });

  it("collect grants a result equal to a parent species, which is then sellable", async () => {
    const s = await player();
    await seedParents(s, "ZombieActorGardenTier2", "ZombieActorRegularTier1"); // GardenTier2 cost 190 → sell 95
    await call("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pa", parentBId: "pb" }],
    });
    const collect = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("collect"), type: "combineCollect", unitId: "res", key: "ZombieActorGardenTier2" }],
    });
    expect(collect.body.results[0].status).toBe("applied");
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "res" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 95 });
  });

  it("rejects a result species that is NOT one of the two parents (anti-upgrade), clearing the job", async () => {
    const s = await player();
    await seedParents(s, "ZombieActorRegularTier1", "ZombieActorRegularTier1"); // sell 17 each
    await call("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pa", parentBId: "pb" }],
    });
    // ZombieActorGardenTier4 is a REAL catalog key (sell 150) but not a parent → rejected.
    const cheat = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("collect"), type: "combineCollect", unitId: "cheat", key: "ZombieActorGardenTier4" }],
    });
    expect(cheat.body.results[0]).toMatchObject({ status: "rejected", error: "bad_result" });
    // The fabricated unit was never recorded → not sellable.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "cheat" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
    // The job was cleared even though the result was rejected (client isn't stuck):
    // a fresh collect now finds no job.
    const again = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("collect"), type: "combineCollect", unitId: "res2", key: "ZombieActorRegularTier1" }],
    });
    expect(again.body.results[0]).toMatchObject({ status: "rejected", error: "no_job" });
  });

  it("rejects a totally fabricated (non-catalog) result key too", async () => {
    const s = await player();
    await seedParents(s);
    await call("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pa", parentBId: "pb" }],
    });
    const bad = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("collect"), type: "combineCollect", unitId: "x", key: "ZombieActorSuperCheat" }],
    });
    expect(bad.body.results[0]).toMatchObject({ status: "rejected", error: "bad_result" });
  });

  it("refuses to start a second combine while one is already running (single pot)", async () => {
    const s = await player();
    await call("POST", "/roster/sync", s.token, {
      units: [
        { id: "pa", key: "ZombieActorRegularTier1" },
        { id: "pb", key: "ZombieActorRegularTier1" },
        { id: "pc", key: "ZombieActorRegularTier1" },
        { id: "pd", key: "ZombieActorRegularTier1" },
      ],
    });
    const first = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pa", parentBId: "pb" }],
    });
    expect(first.body.results[0].status).toBe("applied");
    const second = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "pc", parentBId: "pd" }],
    });
    expect(second.body.results[0]).toMatchObject({ status: "rejected", error: "busy" });
    // pc/pd were NOT consumed by the refused start (still sellable).
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "pc" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 17 });
  });

  it("rejects start with a missing parent or the same unit used twice", async () => {
    const s = await player();
    await call("POST", "/roster/sync", s.token, { units: [{ id: "solo", key: "ZombieActorRegularTier1" }] });
    const missing = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "solo", parentBId: "ghost" }],
    });
    expect(missing.body.results[0]).toMatchObject({ status: "rejected", error: "bad_parent" });
    const dupe = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("start"), type: "combineStart", parentAId: "solo", parentBId: "solo" }],
    });
    expect(dupe.body.results[0]).toMatchObject({ status: "rejected", error: "bad_parent" });
    // A rejected start consumed nothing — solo is still there.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "solo" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "applied", gold: 17 });
  });

  it("collect with no active job is rejected as no_job", async () => {
    const s = await player();
    const collect = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("collect"), type: "combineCollect", unitId: "z", key: "ZombieActorRegularTier1" }],
    });
    expect(collect.body.results[0]).toMatchObject({ status: "rejected", error: "no_job" });
  });

  it("is idempotent: a replayed start id is a duplicate, not a second consumption", async () => {
    const s = await player();
    await seedParents(s);
    const action = { id: aid("start"), type: "combineStart" as const, parentAId: "pa", parentBId: "pb" };
    const first = await call<RosterRes>("POST", "/roster/actions", s.token, { actions: [action] });
    expect(first.body.results[0].status).toBe("applied");
    const replay = await call<RosterRes>("POST", "/roster/actions", s.token, { actions: [action] });
    expect(replay.body.results[0].status).toBe("duplicate");
  });
});
