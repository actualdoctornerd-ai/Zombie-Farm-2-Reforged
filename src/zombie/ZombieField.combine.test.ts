import { describe, expect, it } from "vitest";
import type { GameAssets, ZombieDef } from "../assets";
import type { Field } from "../Field";
import { GameState } from "../GameState";
import type { ZombiePotSave } from "../save/schema";
import { ZombieField } from "./ZombieField";

const legacyJob = (): ZombiePotSave => ({
  parentAId: "parent-a",
  parentBId: "parent-b",
  keyA: "ordinary",
  keyB: "mutant",
  maskA: 0,
  maskB: 1,
  startedAt: 1,
  finishAt: 2,
});

/** Enough of GameAssets for ZombieUnit to build a part-less model. */
const renderableAssets = (key: string): GameAssets => ({
  zombieModels: { [key]: { color: [0, 0, 0], neck: { x: 0, y: 0 }, parts: [] } },
  zombiePartTex: {},
  mutationParts: {}, // a mutated child looks up its extra parts here
  invasionBubble: undefined,
} as unknown as GameAssets);

/** A Field that can host a spawned unit (the combine result is added to the farm). */
const renderableField = (extra: Partial<Record<string, unknown>> = {}): Field => ({
  zombiePotId: () => "pot",
  entityLayer: { addChild: () => {}, removeChild: () => {} },
  patchRestTiles: () => [],
  objectDefOf: () => ({ zombiePot: true }),
  mausoleumId: () => null,
  hasGrave: () => false,
  hasCombineMonolith: () => false,
  inBounds: () => true,
  isPassable: () => true,
  isOpenGround: () => true,
  ...extra,
} as unknown as Field);

describe("ZombieField combine save migration", () => {
  it("hydrates legacy jobs and falls back when the multi-pot map is empty", () => {
    const state = new GameState();
    state.xp = 20_500;
    const defs = new Map<string, Partial<ZombieDef>>([
      ["ordinary", { key: "ordinary", tier: 3, group: "Large", category: "normal" }],
      ["mutant", { key: "mutant", tier: 2, group: "Small", category: "mutant" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets,
      field,
      state,
      (key) => defs.get(key) as ZombieDef | undefined
    );

    zombies.restorePots({}, legacyJob());

    expect(zombies.potFor("pot").pending).toMatchObject({
      tierA: 3,
      tierB: 2,
      baseA: false,
      baseB: true,
      groupA: "Large",
      groupB: "Small",
      specialA: false,
      specialB: false,
      playerLevel: 25,
    });
  });

  it("renames stored zombies and persists the normalized custom name", () => {
    const state = new GameState();
    const def = {
      key: "ordinary", name: "Regular Zombie", group: "Regular",
      className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    // isPassable/inBounds: the save carries no position, so the unit arrives on
    // the farmer's tile.
    const field = {
      zombiePotId: () => "pot", inBounds: () => true, isPassable: () => true,
      isOpenGround: () => true,
    } as unknown as Field;
    const zombies = new ZombieField({} as GameAssets, field, state, (key) => key === def.key ? def : undefined);
    zombies.restore([{ id: "z1", key: def.key, stored: true, name: "Original" }]);

    expect(zombies.rename("z1", "  Sir   Rottington  ")).toBe("Sir Rottington");
    expect(zombies.serialize()[0]).toMatchObject({ id: "z1", name: "Sir Rottington", stored: true });
    expect(zombies.rename("z1", "   ")).toBeNull();
    expect(zombies.serialize()[0].name).toBe("Sir Rottington");
  });

  it("leaves a ready Pot pending while the active zombie capacity is full", () => {
    const state = new GameState();
    state.zombieMax = 0;
    const def = {
      key: "ordinary", name: "Regular Zombie", group: "Regular", tier: 1,
      className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField({} as GameAssets, field, state, (key) => key === def.key ? def : undefined);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: def.key, keyB: def.key,
      maskA: 0, maskB: 0, startedAt: 0, finishAt: 0,
    } });

    expect(zombies.collectCombine(0, 0, "pot")).toBeNull();
    expect(zombies.potFor("pot").pending).not.toBeNull();
  });

  it("previews the ready pot's finished zombie, and stops once it is collected", () => {
    const state = new GameState();
    const def = {
      key: "ordinary", name: "Regular Zombie", group: "Regular", tier: 1, mutation: 0,
      className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    const field = renderableField();
    const zombies = new ZombieField(renderableAssets(def.key), field, state, (key) => key === def.key ? def : undefined);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: def.key, keyB: def.key,
      maskA: 1, maskB: 8, startedAt: 0, finishAt: Date.now() + 60_000,
    } });

    expect(zombies.combinePreview("pot")).toBeNull(); // still combining
    zombies.finishCombineNow("pot");
    expect(zombies.combinePreview("pot")).toMatchObject({
      key: def.key, name: "Regular Zombie", mutation: 9,
    });

    expect(zombies.collectCombine(0, 0, "pot")).not.toBeNull();
    expect(zombies.combinePreview("pot")).toBeNull(); // back to the normal pot view
  });

  it("never previews an eye mutation on a headless result", () => {
    const state = new GameState();
    const headless = {
      key: "headless", name: "Party Zombie", group: "Headless", tier: 4, mutation: 0,
      className: "Silver", classColor: "#cfd4dd", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    const field = renderableField();
    const zombies = new ZombieField(
      renderableAssets(headless.key), field, state,
      (key) => key === headless.key ? headless : undefined
    );
    // Slot 2 donates carrot eyes (4) plus a turnip arm (8); only the arm can land.
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: headless.key, keyB: headless.key,
      maskA: 0, maskB: 4 | 8, startedAt: 0, finishAt: 0,
    } });

    expect(zombies.combinePreview("pot")).toMatchObject({ key: headless.key, mutation: 8 });
    // ...and the collected unit agrees with what the preview showed.
    expect(zombies.collectCombine(0, 0, "pot")?.mutation).toBe(8);
  });

  it("puts the job back when the collection cannot be handed to the server", () => {
    const state = new GameState();
    const def = {
      key: "ordinary", name: "Regular Zombie", group: "Regular", tier: 1,
      className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    const field = renderableField();
    const zombies = new ZombieField(renderableAssets(def.key), field, state, (key) => key === def.key ? def : undefined);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: def.key, keyB: def.key,
      maskA: 0, maskB: 0, reserved: true, startedAt: 0, finishAt: 0,
    } });
    zombies.setRosterLive();
    zombies.onCombineCollect = () => false; // client no longer knows the parents

    expect(zombies.collectCombine(0, 0, "pot")).toBeNull();
    // The parents were consumed at start: losing the job here would destroy both.
    expect(zombies.potFor("pot").pending).toMatchObject({ parentAId: "a", parentBId: "b" });
    expect(zombies.potFor("pot").ready).toBe(true);
    expect(zombies.roster()).toHaveLength(0); // no phantom child left behind
  });

  it("keeps the job when the collection is accepted", () => {
    const state = new GameState();
    const def = {
      key: "ordinary", name: "Regular Zombie", group: "Regular", tier: 1,
      className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
    } as ZombieDef;
    const field = renderableField();
    const zombies = new ZombieField(renderableAssets(def.key), field, state, (key) => key === def.key ? def : undefined);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: def.key, keyB: def.key,
      maskA: 0, maskB: 0, reserved: true, startedAt: 0, finishAt: 0,
    } });
    zombies.setRosterLive();
    zombies.onCombineCollect = () => true;

    expect(zombies.collectCombine(0, 0, "pot")).not.toBeNull();
    expect(zombies.potFor("pot").pending).toBeNull();
    expect(zombies.roster()).toHaveLength(1);
  });

  it("retires a reserved job the settled authoritative roster does not back", () => {
    const state = new GameState();
    const defs = new Map<string, Partial<ZombieDef>>([
      ["ordinary", { key: "ordinary", tier: 1, category: "normal" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets, field, state, (key) => defs.get(key) as ZombieDef | undefined
    );
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: "ordinary", keyB: "ordinary",
      maskA: 0, maskB: 0, reserved: true, startedAt: 0, finishAt: 0,
    } });

    // Unsettled: this client still has work outstanding, so the roster proves nothing.
    expect(zombies.reconcileServerPots([
      { id: "a", key: "ordinary", mutation: 0 },
      { id: "b", key: "ordinary", mutation: 0 },
    ], false).retired).toEqual([]);
    expect(zombies.potFor("pot").busy).toBe(true);

    // Settled with both parents unreserved: the server has no such combine.
    const result = zombies.reconcileServerPots([
      { id: "a", key: "ordinary", mutation: 0 },
      { id: "b", key: "ordinary", mutation: 0 },
    ], true);
    expect(result.retired).toEqual(["pot"]);
    expect(zombies.potFor("pot").busy).toBe(false);
    // Released: the parents are no longer hidden from the roster reconcile.
    expect(zombies.pendingPotParents()).toEqual([]);
  });

  it("never retires an unreserved legacy job the server still honours", () => {
    const state = new GameState();
    const defs = new Map<string, Partial<ZombieDef>>([
      ["ordinary", { key: "ordinary", tier: 1, category: "normal" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets, field, state, (key) => defs.get(key) as ZombieDef | undefined
    );
    zombies.restorePots({ pot: legacyJob() });

    const result = zombies.reconcileServerPots([
      { id: "parent-a", key: "ordinary", mutation: 0 },
      { id: "parent-b", key: "ordinary", mutation: 0 },
    ], true);

    expect(result.retired).toEqual([]);
    expect(zombies.potFor("pot").busy).toBe(true);
  });

  it("keeps the started slot order when the authoritative roster disagrees", () => {
    const state = new GameState();
    const defs = new Map<string, Partial<ZombieDef>>([
      ["garden", { key: "garden", tier: 1, group: "Garden", category: "normal" }],
      ["ordinary", { key: "ordinary", tier: 1, group: "Regular", category: "normal" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets, field, state, (key) => defs.get(key) as ZombieDef | undefined
    );
    // The player put the NEWER garden zombie in slot 1 — that is what sets the species.
    zombies.restorePots({ pot: {
      parentAId: "new-garden", parentBId: "old-ordinary", keyA: "garden", keyB: "ordinary",
      maskA: 0, maskB: 0, playerLevel: 17, reserved: true, startedAt: 0, finishAt: 0,
    } });

    // The server returns its roster in creation order, so the slot-2 parent comes first.
    const recovered = zombies.reconcileServerPots([
      { id: "old-ordinary", key: "ordinary", mutation: 0, lockedByRaid: "pot:pot" },
      { id: "new-garden", key: "garden", mutation: 0, lockedByRaid: "pot:pot" },
    ], true);

    // These ids become the collect command's parentA/parentB: swapping them would make
    // the server hand back a Regular Zombie instead of the Garden Zombie in slot 1.
    expect(recovered.live).toEqual([{
      potId: "pot", parentAId: "new-garden", parentBId: "old-ordinary", playerLevel: 17,
    }]);
    expect(zombies.potFor("pot").pending).toMatchObject({
      parentAId: "new-garden", parentBId: "old-ordinary", keyA: "garden", keyB: "ordinary",
    });
  });

  it("recovers an orphaned authoritative Pot reservation as ready", () => {
    const state = new GameState();
    const defs = new Map<string, Partial<ZombieDef>>([
      ["ordinary", { key: "ordinary", tier: 1, category: "normal" }],
      ["mutant", { key: "mutant", tier: 1, category: "mutant" }],
    ]);
    const field = { zombiePotId: () => "pot" } as unknown as Field;
    const zombies = new ZombieField(
      {} as GameAssets, field, state, (key) => defs.get(key) as ZombieDef | undefined
    );

    const recovered = zombies.reconcileServerPots([
      { id: "a", key: "ordinary", mutation: 0, lockedByRaid: "pot:pot" },
      { id: "b", key: "mutant", mutation: 1, lockedByRaid: "pot:pot" },
    ]);

    expect(recovered.live).toEqual([{
      potId: "pot", parentAId: "a", parentBId: "b", playerLevel: state.level,
    }]);
    expect(recovered.retired).toEqual([]);
    expect(zombies.potFor("pot").ready).toBe(true);
    expect(zombies.potFor("pot").pending).toMatchObject({
      parentAId: "a", parentBId: "b", keyA: "ordinary", keyB: "mutant",
    });
  });
});

describe("Zombie Pot and the Mausoleum", () => {
  const green = {
    key: "green", name: "Zombie", group: "Regular", tier: 1, category: "normal",
    className: "Green", classColor: "#00ff00", str: 1, dex: 1, con: 1, focus: 1,
  } as ZombieDef;

  /** A field with a Zombie Pot, plus a Mausoleum of `slots` capacity (0 = none). */
  const cryptField = (slots: number, graves: string[] = []) => renderableField({
    mausoleumId: () => (slots > 0 ? "crypt" : null),
    objectDefOf: (id: string) => (id === "crypt" ? { zombieSlots: slots } : { zombiePot: true }),
    hasGrave: (color: string) => graves.includes(color),
  });

  const fieldWith = (slots: number, graves: string[] = []) => {
    const state = new GameState();
    state.zombieMax = 2;
    const zombies = new ZombieField(
      renderableAssets(green.key), cryptField(slots, graves), state,
      (key) => (key === green.key ? green : undefined)
    );
    return { state, zombies };
  };

  it("combines two zombies resting in the Mausoleum", () => {
    const { zombies } = fieldWith(5);
    zombies.restore([
      { id: "z1", key: green.key, stored: true },
      { id: "z2", key: green.key, stored: true },
    ]);

    expect(zombies.combine("z1", "z2", 1000, "pot")).toBe(true);
    // Both parents are consumed from the crypt, freeing their slots.
    expect(zombies.roster()).toHaveLength(0);
    expect(zombies.storedCount).toBe(0);
    expect(zombies.potFor("pot").pending).toMatchObject({ keyA: green.key, keyB: green.key });
  });

  it("collects the finished zombie straight into the Mausoleum", () => {
    const { state, zombies } = fieldWith(5);
    state.zombieMax = 0; // farm full — the crypt is the only destination left
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: green.key, keyB: green.key,
      maskA: 0, maskB: 0, startedAt: 0, finishAt: 0,
    } });

    expect(zombies.canStoreCombine()).toBe(true);
    expect(zombies.collectCombine(0, 0, "pot")).toBeNull(); // farm has no room
    const child = zombies.collectCombine(0, 0, "pot", { stored: true });
    expect(child).not.toBeNull();
    expect(zombies.storedCount).toBe(1);
    expect(zombies.roster()[0]).toMatchObject({ id: child!.id, stored: true });
    expect(zombies.potFor("pot").pending).toBeNull();
  });

  it("refuses the crypt when there is no Mausoleum, or it is full", () => {
    const none = fieldWith(0);
    none.zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: green.key, keyB: green.key,
      maskA: 0, maskB: 0, startedAt: 0, finishAt: 0,
    } });
    expect(none.zombies.canStoreCombine()).toBe(false);
    expect(none.zombies.collectCombine(0, 0, "pot", { stored: true })).toBeNull();
    // Refused, not consumed: the parents were spent when the combine started.
    expect(none.zombies.potFor("pot").ready).toBe(true);

    const full = fieldWith(1);
    full.zombies.restore([{ id: "z1", key: green.key, stored: true }]);
    full.zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: green.key, keyB: green.key,
      maskA: 0, maskB: 0, startedAt: 0, finishAt: 0,
    } });
    expect(full.zombies.canStoreCombine()).toBe(false);
    expect(full.zombies.collectCombine(0, 0, "pot", { stored: true })).toBeNull();
    expect(full.zombies.potFor("pot").ready).toBe(true);
  });

  it("starts a combine with a special in slot 2 and keeps slot 1's species", () => {
    const special = { ...green, key: "ZombieActorBombie", category: "special" } as ZombieDef;
    const state = new GameState();
    state.zombieMax = 2;
    const zombies = new ZombieField(
      renderableAssets(green.key), cryptField(5), state,
      (key) => (key === green.key ? green : key === special.key ? special : undefined)
    );
    zombies.restore([
      { id: "z1", key: green.key, stored: true },
      { id: "z2", key: special.key, stored: true },
    ]);

    // The parents are consumed as the job starts, so the Pot must take the job.
    expect(zombies.combine("z1", "z2", 0, "pot")).toBe(true);
    expect(zombies.potFor("pot").pending).toMatchObject({
      keyA: green.key, keyB: special.key, anySlot: true,
    });
    expect(zombies.collectCombine(0, 0, "pot", { stored: true })!.key).toBe(green.key);
  });

  it("hands the child slot 1's name", () => {
    const { zombies } = fieldWith(5);
    zombies.restore([
      { id: "z1", key: green.key, name: "Gravy" },
      { id: "z2", key: green.key, name: "Mildred" },
    ]);

    expect(zombies.combine("z1", "z2", 0, "pot")).toBe(true);
    // Slot 1 already decides the species; the name is recorded with it, so it
    // survives a reload of the running job.
    expect(zombies.potFor("pot").pending).toMatchObject({ nameA: "Gravy" });
    expect(zombies.collectCombine(0, 0, "pot")!.name).toBe("Gravy");
  });

  it("falls back to a rolled name for a job started before names were recorded", () => {
    const { zombies } = fieldWith(5);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: green.key, keyB: green.key,
      maskA: 0, maskB: 0, startedAt: 0, finishAt: 0,
    } });
    // No nameA on the persisted job: the child is named the old way rather than
    // arriving nameless.
    expect(zombies.collectCombine(0, 0, "pot")!.name).toBeTruthy();
  });

  it("tells the server where the child landed", () => {
    const { zombies } = fieldWith(5);
    zombies.restorePots({ pot: {
      parentAId: "a", parentBId: "b", keyA: green.key, keyB: green.key,
      maskA: 0, maskB: 0, reserved: true, startedAt: 0, finishAt: 0,
    } });
    zombies.setRosterLive();
    const handed: boolean[] = [];
    zombies.onCombineCollect = (_pot, _id, _key, _mutation, stored) => {
      handed.push(stored);
      return true;
    };

    zombies.collectCombine(0, 0, "pot", { stored: true });
    expect(handed).toEqual([true]);
  });

  it("breeds a matched pair up the colour ladder the farm has unlocked", () => {
    const blue = {
      ...green, key: "ZombieActorRegularTier2", name: "Zyborg", className: "Blue",
    } as ZombieDef;
    const catalog = new Map([[green.key, green], [blue.key, blue]]);
    const withGrave = (graves: string[]) => {
      const state = new GameState();
      const zombies = new ZombieField(
        renderableAssets(green.key), cryptField(0, graves), state,
        (key) => catalog.get(key)
      );
      zombies.restore([
        { id: "z1", key: green.key }, { id: "z2", key: green.key },
      ]);
      zombies.combine("z1", "z2", 0, "pot");
      return zombies;
    };

    // The class of both parents is captured with the job...
    expect(withGrave([]).potFor("pot").pending).toMatchObject({ classA: "Green", classB: "Green" });
    // ...and only a farm holding the Blue Grave breeds them up to Zyborg.
    expect(withGrave([]).combinePreview("pot")).toMatchObject({ key: green.key });
    expect(withGrave(["Blue"]).combinePreview("pot")).toMatchObject({ key: blue.key });
  });
});
