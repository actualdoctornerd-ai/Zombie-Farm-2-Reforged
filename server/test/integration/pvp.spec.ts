import { describe, expect, it } from "vitest";
import { befriend, call, grantBalance, grantRoster, signIn, uniqueSub, xpForLevel } from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import {
  PVP_ARMY_SIZE,
  PVP_DAILY_ATTACKS_PER_PAIR,
  PVP_DAILY_REWARDED_DEFENSES,
  PVP_DAILY_REWARDED_WINS,
  PVP_DEFENSE_CAP,
  PVP_MIN_LEVEL,
} from "../../../src/raid/pvp";

// Friend invasions (PvP) end-to-end: /raid/pvp/start pins the whole fight (attacker
// eight + a snapshot of the defender's defense), /raid/pvp/finish settles it by the
// server's OWN replay (finalTick 0 + no inputs = "simulate the whole fight" via the
// overrun path), a held defense parks a claim-on-login reward for the defender, and
// the daily income caps decide which fights PAY without limiting which fights happen.

const ATTACK_IDS = Array.from({ length: PVP_ARMY_SIZE }, (_, i) => `a${i}`);
const REGULAR = "ZombieActorRegularTier1";
const HEADLESS = "ZombieActorHeadlessTier1";

async function pvpPlayer(
  label: string,
  units: { id: string; key?: string; stored?: boolean }[],
  level = PVP_MIN_LEVEL
) {
  const s = await signIn(uniqueSub(label));
  await grantBalance(s, { gold: 0, brains: 0, xp: xpForLevel(level) });
  if (units.length) {
    await grantRoster(s, units.map((u) => ({ id: u.id, key: u.key ?? REGULAR, stored: !!u.stored })));
  }
  return s;
}

const attackUnits = ATTACK_IDS.map((id) => ({ id }));

const startBody = (defenderId: string, orderedUnitIds: string[] = ATTACK_IDS) => ({
  defenderId, orderedUnitIds, rulesetVersion: RAID_RULESET_VERSION,
});

const retreatFinish = (sessionId: string) => ({
  sessionId, finalTick: 0, inputs: [{ seq: 1, tick: 0, type: "retreat" }],
});

describe("friend invasion start gates", () => {
  it("requires friendship, the current ruleset, exactly eight owned units, and a defense", async () => {
    const attacker = await pvpPlayer("pvp-gate-a", attackUnits);
    const stranger = await pvpPlayer("pvp-gate-s", [{ id: "d0" }]);

    const unfriended = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(stranger.accountId));
    expect(unfriended).toMatchObject({ status: 403, body: { error: "not_friends" } });

    await befriend(attacker, stranger);
    const stale = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      { ...startBody(stranger.accountId), rulesetVersion: 1 });
    expect(stale).toMatchObject({ status: 426, body: { error: "stale_ruleset" } });

    const short = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(stranger.accountId, ATTACK_IDS.slice(0, 3)));
    expect(short.body.error).toBe("bad_roster");

    const foreign = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(stranger.accountId, ATTACK_IDS.map((id) => `not-${id}`)));
    expect(foreign.body.error).toBe("unit_not_owned");

    // A defender with an empty farm cannot be farmed for free wins.
    const empty = await signIn(uniqueSub("pvp-gate-e"));
    await grantBalance(empty, { xp: xpForLevel(PVP_MIN_LEVEL) });
    await befriend(attacker, empty);
    const noDefense = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(empty.accountId));
    expect(noDefense.body.error).toBe("no_defense");
  });

  it("gates both sides at the invasion level", async () => {
    const newbie = await pvpPlayer("pvp-lvl-n", attackUnits, 1);
    const veteran = await pvpPlayer("pvp-lvl-v", attackUnits.concat([{ id: "d0" }]));
    await befriend(newbie, veteran);

    const tooLow = await call<{ error: string }>("POST", "/raid/pvp/start", newbie.token,
      startBody(veteran.accountId));
    expect(tooLow).toMatchObject({ status: 403, body: { error: "attacker_level" } });

    const lowDefender = await pvpPlayer("pvp-lvl-d", [{ id: "d0" }], 1);
    await befriend(veteran, lowDefender);
    const protectedFarm = await call<{ error: string }>("POST", "/raid/pvp/start", veteran.token,
      startBody(lowDefender.accountId));
    expect(protectedFarm).toMatchObject({ status: 403, body: { error: "defender_level" } });
  });
});

describe("a defense line-up is one zombie per class", () => {
  it("refuses a second zombie of the same class", async () => {
    // The formation fills ONE job per group, so a second Regular could never take the
    // field — selectFormationDefense drops it at snapshot time. Before this rule the
    // player could save such a line-up and would then defend with five without ever
    // being told, finding out by losing. Refuse it at the door instead.
    const player = await pvpPlayer("pvp-oneclass", [
      { id: "u0", key: REGULAR }, { id: "u1", key: REGULAR }, { id: "u2", key: HEADLESS },
    ]);
    const dup = await call<{ error: string }>("POST", "/raid/pvp/defense", player.token,
      { unitIds: ["u0", "u1"] });
    expect(dup).toMatchObject({ status: 400, body: { error: "duplicate_class" } });

    // One of each is fine, and is what comes back.
    const ok = await call<{ ok: boolean; unitIds: string[] }>(
      "POST", "/raid/pvp/defense", player.token, { unitIds: ["u0", "u2"] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.unitIds).toEqual(["u0", "u2"]);

    // Ownership still outranks it: an unowned id is refused before the class rule,
    // so a probe cannot learn what classes another account holds.
    const foreign = await call<{ error: string }>("POST", "/raid/pvp/defense", player.token,
      { unitIds: ["u0", "not-mine"] });
    expect(foreign).toMatchObject({ status: 400, body: { error: "unit_not_owned" } });

    // Clearing back to automatic is unaffected.
    const cleared = await call<{ ok: boolean }>("POST", "/raid/pvp/defense", player.token,
      { unitIds: [] });
    expect(cleared.status).toBe(200);
  });
});

describe("abandoning a fight gives the slot back", () => {
  interface Started { ok: boolean; sessionId: string }
  interface View {
    attacks: { sessionId: string }[];
    defenses: { sessionId: string }[];
    stats: { lifetime: { attackWins: number; attackLosses: number; defenseWins: number } };
    claim: { count: number };
  }

  it("releases the live session, settles nothing, and does not refund the attempt", async () => {
    // The bug this pins: /raid/pvp/start allows one live session per attacker, and the
    // ONLY things that used to close one were a settle and the 15-minute TTL. So a
    // scene that failed to load, a refused settle, or a tab closed mid-battle locked
    // the player out of EVERY invasion until it ran down.
    const attacker = await pvpPlayer("pvp-abandon-a", attackUnits);
    const defender = await pvpPlayer("pvp-abandon-d", [{ id: "d0" }]);
    await befriend(attacker, defender);

    const started = await call<Started>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const blocked = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(blocked).toMatchObject({ status: 409, body: { error: "raid_in_progress" } });

    const released = await call<{ ok: boolean; released: boolean }>(
      "POST", "/raid/pvp/abandon", attacker.token, { sessionId: started.body.sessionId });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.released).toBe(true);

    // The slot is free again immediately — no waiting out the TTL.
    const retry = await call<Started>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.sessionId).not.toBe(started.body.sessionId);
    await call("POST", "/raid/pvp/abandon", attacker.token, { sessionId: retry.body.sessionId });

    // NOTHING was settled: no win, no loss, no defense reward parked. An abandoned
    // fight is not a defense the friend held — they were never really attacked.
    const attackerView = await call<View>("GET", "/raid/pvp/history", attacker.token);
    expect(attackerView.body.attacks).toHaveLength(0);
    expect(attackerView.body.stats.lifetime.attackWins).toBe(0);
    expect(attackerView.body.stats.lifetime.attackLosses).toBe(0);
    const defenderView = await call<View>("GET", "/raid/pvp/history", defender.token);
    expect(defenderView.body.defenses).toHaveLength(0);
    expect(defenderView.body.stats.lifetime.defenseWins).toBe(0);
    expect(defenderView.body.claim.count).toBe(0);

    // But the attempts were still SPENT — abandoning must not farm free retries.
    for (let opened = 2; opened < PVP_DAILY_ATTACKS_PER_PAIR; opened++) {
      const more = await call<Started>("POST", "/raid/pvp/start", attacker.token,
        startBody(defender.accountId));
      expect(more.status, `attempt ${opened}: ${JSON.stringify(more.body)}`).toBe(200);
      await call("POST", "/raid/pvp/abandon", attacker.token, { sessionId: more.body.sessionId });
    }
    const capped = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(capped).toMatchObject({ status: 429, body: { error: "pair_limit" } });
  });

  it("releases without a writer lease — the unload beacon and the replaced tab", async () => {
    // The case this exists for is a tab that is going away or has already lost the
    // writer lease to a newer one. Both reach /raid/pvp/abandon with no usable writer
    // credential — the pagehide keepalive cannot read one, and a replaced tab's is
    // stale. `/raid/*` POSTs are writer-fenced as a class, so abandon answered 423
    // Locked in exactly the situation it is for, and the session stayed stuck for the
    // full TTL. Blanking the writer headers here reproduces that.
    const attacker = await pvpPlayer("pvp-abandon-w", attackUnits);
    const defender = await pvpPlayer("pvp-abandon-x", [{ id: "d0" }]);
    await befriend(attacker, defender);

    const started = await call<Started>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const noLease = { "x-writer-client": "", "x-writer-generation": "", "x-writer-token": "" };
    const released = await call<{ ok: boolean; released: boolean }>(
      "POST", "/raid/pvp/abandon", attacker.token, { sessionId: started.body.sessionId }, noLease);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.released).toBe(true);

    // And the slot really is free — not merely reported as such.
    const retry = await call<Started>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    await call("POST", "/raid/pvp/abandon", attacker.token, { sessionId: retry.body.sessionId });
  });

  it("is idempotent, and cannot re-open a fight that already settled", async () => {
    const attacker = await pvpPlayer("pvp-abandon-i", attackUnits);
    const defender = await pvpPlayer("pvp-abandon-j", [{ id: "d0" }]);
    await befriend(attacker, defender);

    // Nothing live: a blind release is a no-op, not an error. The client fires this
    // from teardown paths that cannot know whether a session is still open.
    const idle = await call<{ ok: boolean; released: boolean }>(
      "POST", "/raid/pvp/abandon", attacker.token, {});
    expect(idle).toMatchObject({ status: 200, body: { ok: true, released: false } });

    const started = await call<Started>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    const sessionId = started.body.sessionId;
    const finished = await call<{ win: boolean }>("POST", "/raid/pvp/finish", attacker.token,
      { sessionId, finalTick: 0, inputs: [] });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    // A late release cannot un-settle it: the result stands and stays readable.
    const late = await call<{ released: boolean }>("POST", "/raid/pvp/abandon", attacker.token,
      { sessionId });
    expect(late.body.released).toBe(false);
    const view = await call<View>("GET", "/raid/pvp/history", attacker.token);
    expect(view.body.attacks).toHaveLength(1);
    expect(view.body.attacks[0].sessionId).toBe(sessionId);
  });
});

describe("defense authoring", () => {
  interface DefenseGet {
    ok: boolean;
    unitIds: string[];
    defense: {
      score: number;
      tier: number;
      defenders: { key: string; name: string }[];
      authored: boolean;
    } | null;
    error?: string;
  }

  it("saves an ordered loadout (resting zombies included), snapshots it, and falls back to auto", async () => {
    const attacker = await pvpPlayer("pvp-def-a", attackUnits);
    // d0 deployed Regular, d1 deployed Headless, d2 RESTING Regular.
    const defender = await pvpPlayer("pvp-def-d", [
      { id: "d0" }, { id: "d1", key: HEADLESS }, { id: "d2", stored: true },
    ]);
    await befriend(attacker, defender);

    // Validation: unowned ids and oversized loadouts are refused.
    const foreign = await call<{ error: string }>("POST", "/raid/pvp/defense", defender.token,
      { unitIds: ["not-mine"] });
    expect(foreign).toMatchObject({ status: 400, body: { error: "unit_not_owned" } });
    const oversized = await call<{ error: string }>("POST", "/raid/pvp/defense", defender.token,
      { unitIds: Array.from({ length: PVP_DEFENSE_CAP + 1 }, (_, i) => `x${i}`) });
    expect(oversized).toMatchObject({ status: 400, body: { error: "bad_loadout" } });

    // Authored order: the RESTING d2 first, then the Headless — a defense is a plan,
    // not who happens to stand on the lawn, so the crypt zombie counts.
    const saved = await call<{ ok: boolean }>("POST", "/raid/pvp/defense", defender.token,
      { unitIds: ["d2", "d1"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const mine = await call<DefenseGet>("GET", "/raid/pvp/defense", defender.token);
    expect(mine.status).toBe(200);
    expect(mine.body.unitIds).toEqual(["d2", "d1"]);
    expect(mine.body.defense?.authored).toBe(true);
    // Ordering is MODE-dependent (classic keeps the saved order, formation orders by
    // job), so this spec asserts membership; the ordering rules are pinned per mode in
    // "defense modes" below and in src/raid/pvp.test.ts.
    expect([...(mine.body.defense?.defenders ?? [])].map((d) => d.key).sort())
      .toEqual([HEADLESS, REGULAR].sort());
    expect(mine.body.defense?.tier).toBeGreaterThanOrEqual(1);

    // The pinned fight fields the authored defense in the authored EMERGENCE order.
    const started = await call<{ ok: boolean; sessionId: string; config: {
      enemyUnits: { id: string; sourceKey: string; team: string }[];
    } }>("POST", "/raid/pvp/start", attacker.token, startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect([...started.body.config.enemyUnits].map((u) => u.sourceKey).sort())
      .toEqual([HEADLESS, REGULAR].sort());
    expect(started.body.config.enemyUnits.map((u) => u.id)).toEqual(["d0", "d1"]);
    await call("POST", "/raid/pvp/finish", attacker.token, retreatFinish(started.body.sessionId));

    // Scouting shows the same defense to a would-be attacker, display fields only.
    const scout = await call<{ ok: boolean; defenders: { key: string }[]; authored: boolean;
      attackerTier: number; defenseScore: number }>(
      "POST", "/raid/pvp/preview", attacker.token, { defenderId: defender.accountId });
    expect(scout.status).toBe(200);
    expect(scout.body.authored).toBe(true);
    expect([...scout.body.defenders].map((d) => d.key).sort())
      .toEqual([HEADLESS, REGULAR].sort());
    expect(scout.body.attackerTier).toBeGreaterThanOrEqual(1);
    // Scouting works both ways between friends…
    const reverseScout = await call<{ ok: boolean }>("POST", "/raid/pvp/preview",
      defender.token, { defenderId: attacker.accountId });
    expect(reverseScout.status).toBe(200);
    // …but never on a stranger.
    const outsider = await pvpPlayer("pvp-def-s", [{ id: "d0" }]);
    const refused = await call<{ error: string }>("POST", "/raid/pvp/preview", outsider.token,
      { defenderId: defender.accountId });
    expect(refused).toMatchObject({ status: 403, body: { error: "not_friends" } });

    // Clearing the loadout returns to the automatic strongest pick — deployed only.
    const cleared = await call<{ ok: boolean }>("POST", "/raid/pvp/defense", defender.token,
      { unitIds: [] });
    expect(cleared.status).toBe(200);
    const auto = await call<DefenseGet>("GET", "/raid/pvp/defense", defender.token);
    expect(auto.body.unitIds).toEqual([]);
    expect(auto.body.defense?.authored).toBe(false);
    // d2 rests in the crypt, so the auto snapshot fields the two deployed zombies.
    expect(auto.body.defense?.defenders).toHaveLength(2);
  });
});

describe("defenses degrade gracefully when zombies disappear", () => {
  const removeUnits = (s: { token: string }, ids: string[]) =>
    call("POST", "/dev/fixture/roster", s.token, { remove: ids });
  interface Preview {
    ok: boolean;
    error?: string;
    authored?: boolean;
    defenders?: { key: string }[];
  }

  it("drops lost loadout members, survives losses MID-invasion, falls back to auto, then no_defense", async () => {
    const attacker = await pvpPlayer("pvp-gone-a", attackUnits);
    const defender = await pvpPlayer("pvp-gone-d", [
      { id: "d0" }, { id: "d1", key: HEADLESS }, { id: "d2" },
    ]);
    await befriend(attacker, defender);
    const saved = await call<{ ok: boolean }>("POST", "/raid/pvp/defense", defender.token,
      { unitIds: ["d1", "d2"] });
    expect(saved.status).toBe(200);

    // d2 is lost elsewhere (sold / perished): the authored defense simply fields on
    // without it, order intact.
    await removeUnits(defender, ["d2"]);
    const thinned = await call<Preview>("POST", "/raid/pvp/preview", attacker.token,
      { defenderId: defender.accountId });
    expect(thinned.status).toBe(200);
    expect(thinned.body.authored).toBe(true);
    expect(thinned.body.defenders?.map((d) => d.key)).toEqual([HEADLESS]);

    // A fight pinned against that defense is UNTOUCHED by anything that happens to
    // the defender's farm while it runs: lose the last loadout zombie, clear the
    // loadout — the settlement replays the pinned config and the recording survives.
    const started = await call<{ ok: boolean; sessionId: string }>(
      "POST", "/raid/pvp/start", attacker.token, startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await removeUnits(defender, ["d1"]);
    await call("POST", "/raid/pvp/defense", defender.token, { unitIds: [] });
    const finished = await call<{ win: boolean }>("POST", "/raid/pvp/finish", attacker.token,
      retreatFinish(started.body.sessionId));
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.win).toBe(false);
    const replay = await call<{ ok: boolean }>(
      "GET", `/raid/pvp/replay/${started.body.sessionId}`, defender.token);
    expect(replay.status).toBe(200);

    // With the loadout gone the snapshot falls back to the auto pick over whoever
    // still stands (d0)...
    const auto = await call<Preview>("POST", "/raid/pvp/preview", attacker.token,
      { defenderId: defender.accountId });
    expect(auto.status).toBe(200);
    expect(auto.body.authored).toBe(false);
    expect(auto.body.defenders).toHaveLength(1);

    // ...and an emptied farm refuses cleanly everywhere.
    await removeUnits(defender, ["d0"]);
    const bare = await call<Preview>("POST", "/raid/pvp/preview", attacker.token,
      { defenderId: defender.accountId });
    expect(bare).toMatchObject({ status: 409, body: { error: "no_defense" } });
    const noStart = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(noStart.body.error).toBe("no_defense");
  });

  it("a farm whose zombies all rest in the crypt defends only by authored choice", async () => {
    const attacker = await pvpPlayer("pvp-crypt-a", attackUnits);
    const defender = await pvpPlayer("pvp-crypt-d", [
      { id: "c0", stored: true }, { id: "c1", stored: true },
    ]);
    await befriend(attacker, defender);
    // No loadout: the auto pick only fields DEPLOYED zombies, so there is nothing.
    const bare = await call<Preview>("POST", "/raid/pvp/preview", attacker.token,
      { defenderId: defender.accountId });
    expect(bare).toMatchObject({ status: 409, body: { error: "no_defense" } });
    // An authored line-up may field resting zombies — a defense is a plan.
    await call("POST", "/raid/pvp/defense", defender.token, { unitIds: ["c1"] });
    const planned = await call<Preview>("POST", "/raid/pvp/preview", attacker.token,
      { defenderId: defender.accountId });
    expect(planned.status).toBe(200);
    expect(planned.body.authored).toBe(true);
    expect(planned.body.defenders).toHaveLength(1);
  });
});

describe("defense modes", () => {
  // The suite's Worker runs PVP_DEFENSE_MODE=formation (wrangler.test.env), so these
  // assert the mode that is under development. Exactly one mode is reachable at a
  // time; switching is a Worker var, so there is nothing client-side to toggle.
  interface DefenseGet {
    ok: boolean;
    mode: string;
    defense: { defenders: { key: string; role?: string }[]; authored: boolean } | null;
  }
  interface StartResponse {
    ok: boolean;
    sessionId: string;
    config: {
      waveCadence: { maxActive: number; dripMs: number };
      bossThrow: { options: { sprite: string; damage: number }[] } | null;
      enemyUnits: {
        sourceKey: string; abilities: string[]; isBoss?: boolean;
        defenseRole?: string; stationX?: number; stationY?: number; deployAtMs?: number;
      }[];
    };
  }

  it("fields one zombie per class, each with a job, a station and an arrival", async () => {
    const attacker = await pvpPlayer("pvp-mode-a", attackUnits);
    // One of every class, plus a spare Regular that should NOT get a seat.
    const defender = await pvpPlayer("pvp-mode-d", [
      { id: "f0", key: HEADLESS }, { id: "f1", key: "ZombieActorGardenTier3" },
      { id: "f2", key: "ZombieActorLargeTier3" }, { id: "f3", key: "ZombieActorSmallTier3" },
      { id: "f4", key: REGULAR }, { id: "f5", key: "ZombieActorGirlTier3" },
      { id: "f6", key: REGULAR },
    ]);
    await befriend(attacker, defender);

    const mine = await call<DefenseGet>("GET", "/raid/pvp/defense", defender.token);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.mode).toBe("formation");
    const roles = (mine.body.defense?.defenders ?? []).map((d) => d.role);
    expect(roles).toEqual(["tank", "brute", "mini", "line", "line", "support"]);

    const started = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const units = started.body.config.enemyUnits;
    expect(units).toHaveLength(6);

    // The tank holds the front, the support sits deepest, the line reinforces late.
    const byRole = new Map(units.map((u) => [u.defenseRole, u]));
    expect(byRole.get("tank")!.stationX).toBeLessThan(byRole.get("mini")!.stationX!);
    expect(byRole.get("support")!.stationX).toBeGreaterThan(byRole.get("mini")!.stationX!);
    expect(byRole.get("tank")!.deployAtMs).toBe(0);
    expect(byRole.get("support")!.deployAtMs).toBe(0);
    // The brute takes the boss's perch: its station is in the AIR, above the ground
    // line, and it lobs the mini from up there.
    expect(byRole.get("brute")!.isBoss).toBe(true);
    expect(byRole.get("brute")!.stationY!).toBeLessThan(0);
    // The throw must be IN THE PINNED CONFIG the client adopts. The client builds its
    // BattleSim from exactly this object, and the verifier replays with it — a client
    // that dropped it would fight a throw-less fight and then be settled against one
    // with throws, diverging from the brute's first lob. (That bug shipped briefly:
    // main.ts hardcoded bossThrow: null on the PvP launch.)
    const throwCfg = started.body.config.bossThrow;
    expect(throwCfg, "formation mode must pin the brute's throw").toBeTruthy();
    expect(throwCfg!.options[0].sprite).toContain(byRole.get("mini")!.sourceKey);
    expect(throwCfg!.options[0].damage).toBeGreaterThan(0);
    expect(units.filter((u) => u.defenseRole === "line")
      .every((u) => (u.deployAtMs ?? 0) > 0)).toBe(true);

    // Nothing TAPPABLE survives on defense. The positive half — a defending healer
    // keeping `heal` and actually healing — needs the ability UNLOCKED, which takes
    // raid progress no dev fixture grants, so it is pinned at sim level instead
    // (src/raid/pvp.test.ts, "a defending healer heals").
    for (const unit of units) {
      expect(unit.abilities.every((key) => key === "heal" || key === "healAOE")).toBe(true);
    }
    // The wave drip is switched off: a formation authors its own arrivals.
    expect(started.body.config.waveCadence.dripMs).toBe(0);

    await call("POST", "/raid/pvp/finish", attacker.token, retreatFinish(started.body.sessionId));
  });

  it("still settles a formation fight end to end", async () => {
    const attacker = await pvpPlayer("pvp-mode-w", attackUnits);
    const defender = await pvpPlayer("pvp-mode-x", [{ id: "g0" }, { id: "g1", key: HEADLESS }]);
    await befriend(attacker, defender);
    const started = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const finished = await call<{ win: boolean; rewards: unknown[] }>(
      "POST", "/raid/pvp/finish", attacker.token,
      { sessionId: started.body.sessionId, finalTick: 0, inputs: [] });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(typeof finished.body.win).toBe("boolean");
  });
});

describe("friend invasion — attacks, claims, daily caps", () => {
  interface StartResponse {
    ok: boolean;
    sessionId: string;
    config: {
      raidId: number;
      concentration: boolean;
      playerUnits: { team: string }[];
      enemyUnits: { team: string; group?: string; abilities: string[] }[];
      pvp: { defenderId: string; attackerTier: number; defenderTier: number; defenseScore: number };
    };
  }
  interface FinishResponse {
    settlementId?: string;
    win: boolean;
    rewarded?: boolean;
    rewards: { key: string; qty: number }[];
    inventory?: Record<string, number>;
    error?: string;
  }
  interface Overview {
    ok: boolean;
    attacks: { sessionId: string; attackerWon: boolean; rewarded: boolean; replayAvailable?: boolean }[];
    defenses: { sessionId: string; attackerWon: boolean; rewarded: boolean; claimableTier?: number }[];
    stats: {
      lifetime: { attackWins: number; attackLosses: number; defenseWins: number; defenseLosses: number };
      week: { attackWins: number; attackLosses: number; defenseWins: number; defenseLosses: number };
    };
    claim: { count: number; rewards: { key: string; qty: number }[] };
    rewardedWinsToday: number;
    rewardedDefensesToday: number;
  }

  const winFight = async (attacker: { token: string }, defenderId: string) => {
    const started = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
      startBody(defenderId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const finished = await call<FinishResponse>("POST", "/raid/pvp/finish", attacker.token,
      { sessionId: started.body.sessionId, finalTick: 0, inputs: [] });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.win).toBe(true);
    return { sessionId: started.body.sessionId, result: finished.body };
  };

  it("settles fights, holds defense claims, caps daily income, and claims the backlog at once", async () => {
    // 8 attackers vs a single defender of the same species: the attacker wins the
    // server's own simulation of the fight.
    const attacker = await pvpPlayer("pvp-flow-a", attackUnits);
    const defender = await pvpPlayer("pvp-flow-d", [{ id: "d0" }]);
    await befriend(attacker, defender);

    // ---- attack 1: a win, settled entirely by the server's replay (no inputs).
    const started = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const config = started.body.config;
    expect(config.raidId).toBeLessThan(0);
    expect(config.concentration).toBe(true);
    expect(config.playerUnits).toHaveLength(PVP_ARMY_SIZE);
    expect(config.enemyUnits.length).toBeGreaterThan(0);
    for (const unit of config.enemyUnits) {
      expect(unit.team).toBe("enemy");
      expect(unit.group, "defender snapshot keeps the zombie taxonomy for rendering").toBeTruthy();
      expect(unit.abilities).toEqual([]);
    }
    expect(config.pvp.defenderId).toBe(defender.accountId);
    expect(config.pvp.attackerTier).toBeGreaterThanOrEqual(1);

    // One live session per attacker.
    const second = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(second).toMatchObject({ status: 409, body: { error: "raid_in_progress" } });

    const finished = await call<FinishResponse>("POST", "/raid/pvp/finish", attacker.token,
      { sessionId: started.body.sessionId, finalTick: 0, inputs: [] });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.win).toBe(true);
    expect(finished.body.rewarded).toBe(true);
    expect(finished.body.rewards.length).toBeGreaterThan(0);
    for (const reward of finished.body.rewards) {
      expect(finished.body.inventory?.[reward.key] ?? 0).toBeGreaterThanOrEqual(reward.qty);
    }
    // Idempotent replay of the same settlement.
    const replayed = await call<FinishResponse>("POST", "/raid/pvp/finish", attacker.token,
      { sessionId: started.body.sessionId, finalTick: 0, inputs: [] });
    expect(replayed.status).toBe(200);
    expect(replayed.body.settlementId).toBe(finished.body.settlementId);

    // ---- attack 2: a retreat — the defense holds and the defender earns a claim.
    const retreatStart = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(retreatStart.status).toBe(200);
    const retreated = await call<FinishResponse>("POST", "/raid/pvp/finish", attacker.token,
      retreatFinish(retreatStart.body.sessionId));
    expect(retreated.status, JSON.stringify(retreated.body)).toBe(200);
    expect(retreated.body.win).toBe(false);
    expect(retreated.body.rewards).toEqual([]);

    // The defender's overview: both rows under `defenses`, stats counted, only the
    // held defense claimable.
    const overview = await call<Overview>("GET", "/raid/pvp/history", defender.token);
    expect(overview.status).toBe(200);
    expect(overview.body.attacks).toHaveLength(0);
    const held = overview.body.defenses.find((e) => e.sessionId === retreatStart.body.sessionId);
    const lost = overview.body.defenses.find((e) => e.sessionId === started.body.sessionId);
    expect(held).toMatchObject({ attackerWon: false, rewarded: true });
    expect(held?.claimableTier).toBeGreaterThanOrEqual(1);
    expect(lost).toMatchObject({ attackerWon: true });
    expect(lost?.claimableTier).toBeUndefined();
    expect(overview.body.stats.lifetime).toMatchObject({ defenseWins: 1, defenseLosses: 1 });
    expect(overview.body.stats.week).toMatchObject({ defenseWins: 1, defenseLosses: 1 });
    expect(overview.body.rewardedDefensesToday).toBe(1);
    expect(overview.body.claim.count).toBe(1);

    // Single-claim path: once, defender only, held+rewarded rows only.
    const collected = await call<{ ok: boolean; rewards: { key: string; qty: number }[] }>(
      "POST", "/raid/pvp/collect", defender.token, { sessionId: retreatStart.body.sessionId });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(collected.body.rewards.length).toBeGreaterThan(0);
    const again = await call<{ error: string }>("POST", "/raid/pvp/collect", defender.token,
      { sessionId: retreatStart.body.sessionId });
    expect(again).toMatchObject({ status: 409, body: { error: "already_claimed" } });
    const notHeld = await call<{ error: string }>("POST", "/raid/pvp/collect", defender.token,
      { sessionId: started.body.sessionId });
    expect(notHeld).toMatchObject({ status: 409, body: { error: "not_defended" } });
    const wrongParty = await call<{ error: string }>("POST", "/raid/pvp/collect", attacker.token,
      { sessionId: retreatStart.body.sessionId });
    expect(wrongParty.status).toBe(404);

    // ---- daily rewarded-wins cap: wins keep landing, the pay stops at the cap.
    const winIds: string[] = [started.body.sessionId];
    for (let n = 2; n <= PVP_DAILY_REWARDED_WINS; n++) {
      const win = await winFight(attacker, defender.accountId);
      expect(win.result.rewarded, `win ${n} inside the cap pays`).toBe(true);
      expect(win.result.rewards.length).toBeGreaterThan(0);
      winIds.push(win.sessionId);
    }
    const capped = await winFight(attacker, defender.accountId);
    expect(capped.result.rewarded, "a win past the daily cap still counts, but does not pay").toBe(false);
    expect(capped.result.rewards).toEqual([]);
    winIds.push(capped.sessionId);

    const mine = await call<Overview>("GET", "/raid/pvp/history", attacker.token);
    expect(mine.status).toBe(200);
    expect(mine.body.rewardedWinsToday).toBe(PVP_DAILY_REWARDED_WINS);
    expect(mine.body.stats.lifetime).toMatchObject({
      attackWins: PVP_DAILY_REWARDED_WINS + 1, attackLosses: 1,
    });
    const cappedRow = mine.body.attacks.find((e) => e.sessionId === capped.sessionId);
    expect(cappedRow).toMatchObject({ attackerWon: true, rewarded: false });
    expect(cappedRow?.replayAvailable).toBe(true);

    // ---- the stored recording is fetchable by both parties, and only them.
    const replay = await call<{ ok: boolean; config: { pvp: { defenderId: string } };
      inputs: unknown[]; attackerWon: boolean }>(
      "GET", `/raid/pvp/replay/${started.body.sessionId}`, defender.token);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.attackerWon).toBe(true);
    expect(replay.body.config.pvp.defenderId).toBe(defender.accountId);
    const outsider = await pvpPlayer("pvp-flow-s", [{ id: "d0" }]);
    const refused = await call<{ error: string }>(
      "GET", `/raid/pvp/replay/${started.body.sessionId}`, outsider.token);
    expect(refused.status).toBe(404);

    // ---- fill the day with retreats: the defense-reward cap and the pair cap.
    // Opened so far: 1 win + 1 retreat + 3 wins = 5 (or 2+cap-1 in general).
    const openedSoFar = 2 + PVP_DAILY_REWARDED_WINS;
    const extraRetreats: string[] = [];
    for (let opened = openedSoFar; opened < PVP_DAILY_ATTACKS_PER_PAIR; opened++) {
      const extra = await call<StartResponse>("POST", "/raid/pvp/start", attacker.token,
        startBody(defender.accountId));
      expect(extra.status, JSON.stringify(extra.body)).toBe(200);
      await call("POST", "/raid/pvp/finish", attacker.token, retreatFinish(extra.body.sessionId));
      extraRetreats.push(extra.body.sessionId);
    }
    const overCap = await call<{ error: string }>("POST", "/raid/pvp/start", attacker.token,
      startBody(defender.accountId));
    expect(overCap).toMatchObject({ status: 429, body: { error: "pair_limit" } });

    // Held defenses today: 1 (claimed) + extraRetreats. Only the first
    // PVP_DAILY_REWARDED_DEFENSES parked a reward; the rest were for the record.
    const backlog = await call<Overview>("GET", "/raid/pvp/history", defender.token);
    const rewardedLeft = PVP_DAILY_REWARDED_DEFENSES - 1; // one already claimed
    expect(backlog.body.claim.count).toBe(rewardedLeft);
    expect(backlog.body.rewardedDefensesToday).toBe(PVP_DAILY_REWARDED_DEFENSES);
    // An unrewarded held defense cannot be claimed even by hand.
    const unrewarded = extraRetreats[extraRetreats.length - 1];
    const refusedClaim = await call<{ error: string }>("POST", "/raid/pvp/collect",
      defender.token, { sessionId: unrewarded });
    expect(refusedClaim).toMatchObject({ status: 409, body: { error: "not_rewarded" } });

    // ---- claim-all drains the whole rewarded backlog in one go.
    const claimAll = await call<{ ok: boolean; claimed: number; rewards: { key: string; qty: number }[];
      remaining: boolean }>("POST", "/raid/pvp/collect-all", defender.token, {});
    expect(claimAll.status, JSON.stringify(claimAll.body)).toBe(200);
    expect(claimAll.body.claimed).toBe(rewardedLeft);
    expect(claimAll.body.rewards.length).toBeGreaterThan(0);
    expect(claimAll.body.remaining).toBe(false);
    const drained = await call<{ ok: boolean; claimed: number }>(
      "POST", "/raid/pvp/collect-all", defender.token, {});
    expect(drained.body.claimed).toBe(0);
    const after = await call<Overview>("GET", "/raid/pvp/history", defender.token);
    expect(after.body.claim.count).toBe(0);
  });
});
