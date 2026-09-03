import { describe, expect, it } from "vitest";
import { call, commandBody, grantBalance, grantRoster, signIn, uniqueSub } from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";

// The gates on /raid/start, and the roster lock it takes out.
//
// Ported from the protocol-v2 version of this file, which seeded through
// /economy/sync and sold through /roster/actions — both now 410. That retirement is
// why this spec stopped running at all: it was excluded wholesale along with the
// genuinely-dead v2 specs, and took the only end-to-end coverage of the raid roster
// lock with it. The gates themselves were never v2-specific.

async function raidPlayer(label: string) {
  const s = await signIn(uniqueSub(label));
  await grantBalance(s, { gold: 0, brains: 0, xp: 0 });
  // `stored: false` matters: the fixture files units in the Mausoleum by default, and
  // a crypt zombie cannot be deployed — /raid/start answers `unit_not_owned` for it,
  // which reads exactly like a roster that was never granted.
  await grantRoster(s, [{ id: "z1", key: "ZombieActorRegularTier1", stored: false }]);
  return s;
}

/** Try to sell `unitId` through the authoritative command lane. Returns the command
 *  result, which is where a locked unit shows up as `not_owned`. */
async function sellUnit(
  s: Awaited<ReturnType<typeof raidPlayer>>,
  batchId: string,
  sequence: number,
  unitId: string
) {
  const before = await call<{ accountVersion: number; writerGeneration: number }>(
    "POST", "/bootstrap", s.token, {}
  );
  const sold = await call<{ results: { status: string; error?: string }[] }>(
    "POST", "/commands", s.token,
    commandBody(before.body, batchId, sequence, [{ type: "roster.sell", unitId }])
  );
  return sold.body.results[0];
}

describe("raid start — pinned server state", () => {
  it("requires the current ruleset and an owned, unique roster", async () => {
    const s = await raidPlayer("raid-gate");
    const stale = await call<{ error: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: 1,
    });
    expect(stale).toMatchObject({ status: 426, body: { error: "stale_ruleset" } });

    const foreign = await call<{ error: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["not-owned"], rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(foreign.body.error).toBe("unit_not_owned");

    const duplicate = await call<{ error: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1", "z1"], rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(duplicate.body.error).toBe("bad_roster");
  });

  it("locks participating units until the verified raid closes", async () => {
    // The property that matters: a zombie cannot be sold out from under a fight it is
    // currently in, and the lock is released by settlement rather than lingering.
    const s = await raidPlayer("raid-lock");
    const started = await call<{ ok: boolean; sessionId: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.body.ok, JSON.stringify(started.body)).toBe(true);

    const locked = await sellUnit(s, "raid-lock-sell-locked", 1, "z1");
    expect(locked).toMatchObject({ status: "rejected", error: "not_owned" });

    const finished = await call("POST", "/raid/finish", s.token, {
      sessionId: started.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    const released = await sellUnit(s, "raid-lock-sell-after", 2, "z1");
    expect(released.status, JSON.stringify(released)).toBe("applied");
  });
});

// The gates on /raid/finish. These are the ones SECURITY.md's "Verification status"
// claimed were covered by raidRewards.spec.ts — which is excluded, so they were not
// running anywhere. The v2 spec asserted `bad_final_tick`; the v3 route spells the same
// property as `future_finish`, and derives the outcome from the transcript rather than
// reading a claim off the body at all.
describe("raid finish — replay-derived, never client-claimed", () => {
  /** Start a raid and hand back the session plus its id. */
  async function startRaid(s: Awaited<ReturnType<typeof raidPlayer>>) {
    const started = await call<{ ok: boolean; sessionId: string }>("POST", "/raid/start", s.token, {
      raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: RAID_RULESET_VERSION,
    });
    expect(started.body.ok, JSON.stringify(started.body)).toBe(true);
    return started.body.sessionId;
  }

  it("refuses a finish paced further into the fight than real time allows", async () => {
    // `pacedTick = floor((now - started_at) / 50) + 40`. A raid started milliseconds ago
    // cannot honestly have reached tick 100000, so claiming it is a client running the
    // fight faster than wall time — the cheapest way to shorten a long invasion. This is
    // defense in depth BEHIND the replay, not a substitute for it: the replay decides who
    // won, and this decides whether enough time has passed to have fought at all.
    const s = await raidPlayer("raid-future-finish");
    const sessionId = await startRaid(s);
    const forged = await call<{ error: string }>("POST", "/raid/finish", s.token, {
      sessionId, finalTick: 100_000, inputs: [],
    });
    expect(forged, JSON.stringify(forged.body)).toMatchObject({
      status: 422, body: { error: "future_finish" },
    });
  });

  it("pays nothing for a win asserted in the request body", async () => {
    // The v2-era forgery: claim the outcome AND the reward. The v3 route has no `win`,
    // `gold` or `xp` input — the only client-supplied outcome field is `clientWin`, which
    // is ANDed (it can concede a loss, never claim a win). A body like this therefore
    // carries no transcript, so it cannot produce a finished fight, and it must not settle
    // as a win or move the balance.
    const s = await raidPlayer("raid-forged-win");
    const before = await call<any>("POST", "/bootstrap", s.token, {});
    const sessionId = await startRaid(s);
    const forged = await call<any>("POST", "/raid/finish", s.token, {
      sessionId, win: true, gold: 999_999, xp: 999_999,
    });
    // Whichever way it fails, it must not be a paid win.
    expect(forged.body?.win).not.toBe(true);
    expect(forged.body?.gold ?? 0).toBe(0);
    expect(forged.body?.xp ?? 0).toBe(0);

    const after = await call<any>("POST", "/bootstrap", s.token, {});
    expect(after.body.gameplay.balance).toEqual(before.body.gameplay.balance);
  });

  it("settles a retreat from the transcript, and replays the stored result on a retry", async () => {
    // The positive half of the same property: the outcome comes from the inputs. A retreat
    // transcript settles as a retreat, and re-posting it returns the STORED result rather
    // than settling twice — which is what stops a duplicate finish from paying twice.
    const s = await raidPlayer("raid-finish-idempotent");
    const sessionId = await startRaid(s);
    const body = { sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }] };
    const first = await call<any>("POST", "/raid/finish", s.token, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.win).not.toBe(true);

    const replayed = await call<any>("POST", "/raid/finish", s.token, body);
    expect(replayed.status).toBe(200);
    expect(replayed.body.gold).toBe(first.body.gold);
    expect(replayed.body.xp).toBe(first.body.xp);
    expect(replayed.body.win).toBe(first.body.win);
  });
});

// Two starts that TIE. Each reads "no live session" before inserting one, so a genuine
// tie gets past both reads and lands on idx_raid_v3_live, which refuses the second
// insert. That refusal used to escape as a raw 500; it is the same situation the read
// answers with 409, and it must say so (server/src/v3/liveSessionRace.ts). The
// client's double-tap guard makes the tie rare; this is the server being right anyway.
describe("raid start — two starts at once", () => {
  it("opens exactly one session and refuses the other as in-progress, never a 500", async () => {
    const s = await raidPlayer("raid-race");
    const body = { raidId: 1, orderedUnitIds: ["z1"], rulesetVersion: RAID_RULESET_VERSION };
    const results = await Promise.all([
      call<{ ok?: boolean; error?: string }>("POST", "/raid/start", s.token, body),
      call<{ ok?: boolean; error?: string }>("POST", "/raid/start", s.token, body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([200, 409]);
    // Which 409 depends on how far the loser got before the winner committed: the
    // roster pin runs before the live-session read, so a loser that arrives after the
    // commit sees its zombie locked (`unit_not_owned`); one that reads before the
    // commit sees the live row (`raid_in_progress`); and a true tie on the insert is
    // mapped to `raid_in_progress` by liveSessionRace.ts, whose message match is
    // pinned in ../liveSessionRace.test.ts. Local D1 serialises requests closely
    // enough that the tie itself cannot be forced from here — what this proves is
    // that no path answers 500.
    const refused = results.find((r) => r.status === 409)!;
    expect(["raid_in_progress", "unit_not_owned"]).toContain(refused.body.error);

    // And the one that won is the only live session: a third start is refused too.
    const third = await call<{ error?: string }>("POST", "/raid/start", s.token, body);
    expect(third.status).toBe(409);
    expect(["raid_in_progress", "unit_not_owned"]).toContain(third.body.error);
  });
});
