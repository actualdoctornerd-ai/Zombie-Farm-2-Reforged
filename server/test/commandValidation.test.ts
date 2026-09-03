import { describe, expect, it } from "vitest";
import { describeInvalidBatch, validGameplayCommand } from "../src/index";
import { GAMEPLAY_PROTOCOL, type GameplayCommand } from "../../src/net/protocol";

/** One VALID instance of every command the client can emit.
 *
 *  The Record key is the client's own union, so adding a command type to
 *  `GameplayCommand` fails to compile until a sample lands here — which is the point.
 *  A type the client can send but `validGameplayCommand` doesn't know is not a
 *  degraded action: the batch is refused wholesale as `bad_command_batch`, the
 *  persisted outbox replays it, and the player's farm is paused permanently behind
 *  "Gameplay paused — reconnect to continue".
 *
 *  This is exactly how `farm.move` shipped: the engine implemented it and had six
 *  passing tests, but those call the engine directly and never cross this door, so
 *  every player who moved a plot bricked their own account. */
const SAMPLES: Record<GameplayCommand["type"], GameplayCommand> = {
  "writer.claim": { type: "writer.claim" },
  "farm.plow": { type: "farm.plow", oc: 0, or: 0 },
  "farm.plant": { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot", fertilized: true },
  "farm.plow_many": { type: "farm.plow_many", plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0 }] },
  "farm.plant_many": {
    type: "farm.plant_many", cropKey: "carrot",
    plots: [{ oc: 0, or: 0 }, { oc: 4, or: 0, fertilized: true }],
  },
  "farm.harvest": { type: "farm.harvest", oc: 0, or: 0 },
  "farm.remove": { type: "farm.remove", oc: 0, or: 0 },
  "farm.move": { type: "farm.move", oc: 0, or: 0, toOc: 8, toOr: 4 },
  "power.buy": { type: "power.buy", key: "fertilizer" },
  "power.use": { type: "power.use", key: "fertilizer", oc: 0, or: 0, target: "zombie_pot" },
  "object.buy": { type: "object.buy", catalogKey: "tree", clientInstanceId: "local-1" },
  "object.refund": { type: "object.refund", instanceId: "obj-1" },
  "object.upgrade": { type: "object.upgrade", instanceId: "obj-1", catalogKey: "tree2" },
  "object.status": { type: "object.status", instanceId: "obj-1", status: "stored" },
  "object.harvest_trees": { type: "object.harvest_trees", instanceIds: ["obj-1", "obj-2"] },
  "storage.claim": { type: "storage.claim", itemName: "Gnome", clientInstanceId: "local-2" },
  "storage.move": { type: "storage.move", itemKey: "carrot", direction: "store", quantity: 3 },
  "roster.sell": { type: "roster.sell", unitId: "z-1" },
  "roster.status": { type: "roster.status", unitId: "z-1", stored: true },
  "roster.combine_start": {
    type: "roster.combine_start", potId: "pot-1", parentAId: "z-1", parentBId: "z-2", playerLevel: 25,
  },
  "roster.combine": {
    type: "roster.combine", potId: "pot-1", parentAId: "z-1", parentBId: "z-2", playerLevel: 25,
    stored: true,
  },
  "shop.size": { type: "shop.size", size: 40, currency: "gold" },
  "shop.climate": { type: "shop.climate", terrain: "swamp" },
  "farmer.buy": { type: "farmer.buy", headId: 3 },
  "farmer.equip": { type: "farmer.equip", headId: 3 },
  "farmer.bonus": { type: "farmer.bonus", headId: null },
  "pet.buy": { type: "pet.buy", petKey: "cat" },
  "pet.equip": { type: "pet.equip", petKey: null },
  "pet.pen": { type: "pet.pen", petKeys: ["cat", "dog"] },
  "memorial.enshrine": { type: "memorial.enshrine", instanceId: "obj-1", unitId: "z-1", name: "Bob" },
  "memorial.clear": { type: "memorial.clear", instanceId: "obj-1" },
  "quest.periodic_claim": { type: "quest.periodic_claim", scope: "daily", questId: "daily_invade" },
  "quest.periodic_author": { type: "quest.periodic_author", scope: "daily", level: 5 },
  "epicBoss.token": { type: "epicBoss.token", runId: "run-1", count: 3 },
  "tutorial.complete": { type: "tutorial.complete" },
};

describe("gameplay command validation", () => {
  it.each(Object.keys(SAMPLES))("accepts %s", (type) => {
    expect(validGameplayCommand(SAMPLES[type as GameplayCommand["type"]])).toBe(true);
  });

  // The optional fields are the easy ones to over-tighten; omitting them must stay legal.
  it("accepts commands with every optional field omitted", () => {
    const minimal: GameplayCommand[] = [
      { type: "farm.plant", oc: 0, or: 0, cropKey: "carrot" },
      { type: "power.use", key: "fertilizer" },
      { type: "object.buy", catalogKey: "tree" },
      { type: "storage.claim", itemName: "Gnome" },
      { type: "roster.combine_start", potId: "p", parentAId: "a", parentBId: "b" },
      { type: "roster.combine", parentAId: "a", parentBId: "b" },
      { type: "memorial.enshrine", instanceId: "obj-1", unitId: "z-1" },
      { type: "epicBoss.token", runId: "run-1" },
    ];
    for (const command of minimal) expect(validGameplayCommand(command)).toBe(true);
  });

  it("still refuses malformed and unknown commands", () => {
    expect(validGameplayCommand({ type: "farm.move", oc: 0, or: 0 })).toBe(false);
    expect(validGameplayCommand({ type: "farm.move", oc: 0, or: 0, toOc: 1.5, toOr: 0 })).toBe(false);
    expect(validGameplayCommand({ type: "farm.plow", oc: "0", or: 0 })).toBe(false);
    expect(validGameplayCommand({ type: "nonsense.command" })).toBe(false);
    // Unverified is not unbounded: the count still has to be a sane whole number.
    expect(validGameplayCommand({ type: "epicBoss.token", runId: "run-1", count: 0 })).toBe(false);
    expect(validGameplayCommand({ type: "epicBoss.token", runId: "run-1", count: 5_000 })).toBe(false);
    expect(validGameplayCommand({ type: "epicBoss.token", runId: "" })).toBe(false);
    // The board request names a scope and a whole level, nothing else — never quests.
    expect(validGameplayCommand({ type: "quest.periodic_author", scope: "monthly", level: 5 })).toBe(false);
    expect(validGameplayCommand({ type: "quest.periodic_author", scope: "daily", level: 4.5 })).toBe(false);
    expect(validGameplayCommand({ type: "quest.periodic_author", scope: "daily", level: 0 })).toBe(false);
    expect(validGameplayCommand({ type: "quest.periodic_author", scope: "daily" })).toBe(false);
    expect(validGameplayCommand(null)).toBe(false);
  });
});

/** The rejection above is the one with no recovery, and until now it was the only one
 *  that logged nothing — so a farm paused permanently behind `bad_command_batch` left
 *  no server-side trace whatsoever. These cover what the log line says, because a
 *  diagnostic nobody has read is indistinguishable from one that does not work. */
describe("invalid command batch diagnostics", () => {
  const batch = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: GAMEPLAY_PROTOCOL,
    deviceId: "device-abcdef",
    batchId: "batch-abcdef",
    firstSequence: 1,
    expectedAccountVersion: 0,
    writerGeneration: 0,
    commands: [{ sequence: 1, command: SAMPLES["farm.plow"] }],
    ...overrides,
  });

  it("names the offending command type and its position", () => {
    // The farm.move shape from this file's opening note: a type the client can emit
    // that the door does not know. This is the line that would have identified it.
    const detail = describeInvalidBatch(batch({
      commands: [
        { sequence: 1, command: SAMPLES["farm.plow"] },
        { sequence: 2, command: { type: "farm.move", oc: 0, or: 0 } },
        { sequence: 3, command: SAMPLES["farm.harvest"] },
      ],
    }));
    expect(detail).toMatchObject({ reason: "command", index: 1, commandType: "farm.move", commandCount: 3 });
    // The neighbours ride along: one refused type in isolation does not say whether
    // the client is old, forged, or simply ahead of this Worker.
    expect(detail.types).toEqual(["farm.plow", "farm.move", "farm.harvest"]);
  });

  it("blames the envelope rather than guessing at a command", () => {
    // With a bad envelope the command list was never judged, so naming one would be
    // a fabrication — the field that actually failed is the useful thing.
    expect(describeInvalidBatch(batch({ protocolVersion: 99 })))
      .toMatchObject({ reason: "envelope", field: "protocol_version", protocolVersion: 99 });
    expect(describeInvalidBatch(batch({ deviceId: "short" })))
      .toMatchObject({ reason: "envelope", field: "device_id" });
    expect(describeInvalidBatch(batch({ commands: [] })))
      .toMatchObject({ reason: "envelope", field: "commands_empty" });
    expect(describeInvalidBatch(batch({ commands: "nope" })))
      .toMatchObject({ reason: "envelope", field: "commands_not_array" });
    expect(describeInvalidBatch(null)).toEqual({ reason: "not_an_object" });
  });

  it("reports a sequence break without calling it an unknown type", () => {
    // A well-formed command in the wrong slot fails the same door. Reporting only
    // its type would send the reader hunting a validator gap that is not there.
    const detail = describeInvalidBatch(batch({
      commands: [{ sequence: 7, command: SAMPLES["farm.plow"] }],
    }));
    expect(detail).toMatchObject({ reason: "command", index: 0, commandType: "farm.plow", sequenceOk: false });
  });

  it("never reads a value out of the refused payload", () => {
    // Whatever reached here is untrusted input. Types are named; nothing else is.
    const detail = describeInvalidBatch(batch({
      commands: [{ sequence: 1, command: { type: "farm.plant", oc: 0, or: 0, cropKey: "s3cret-token" } }],
    }));
    expect(JSON.stringify(detail)).not.toContain("s3cret-token");
  });

  it("survives a body built to break the describer itself", () => {
    // It runs on input that already failed validation, so it must not be the thing
    // that turns a 400 into a 500.
    for (const hostile of [
      undefined, 42, "string", [],
      batch({ commands: [null, undefined, 0] }),
      batch({ commands: [{ sequence: 1, command: { type: 12345 } }] }),
      batch({ commands: [{ sequence: 1, command: { type: "x".repeat(500) } }] }),
      batch({ firstSequence: Number.NaN }),
    ]) {
      expect(() => describeInvalidBatch(hostile)).not.toThrow();
    }
    const long = describeInvalidBatch(
      batch({ commands: [{ sequence: 1, command: { type: "x".repeat(500) } }] })
    );
    expect(String(long.commandType)).toHaveLength(64);
  });
});
