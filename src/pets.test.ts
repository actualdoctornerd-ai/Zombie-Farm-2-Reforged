import { describe, expect, it } from "vitest";
import catalog from "../public/assets/pets/catalog.json";
import { GameState } from "./GameState";

describe("cosmetic pet catalog and client ownership", () => {
  it("contains the complete unique, post-brainflation catalog", () => {
    expect(catalog.pets).toHaveLength(40);
    expect(new Set(catalog.pets.map((pet) => pet.key)).size).toBe(40);
    expect(catalog.pets.every((pet) => pet.brains && pet.cost > 0)).toBe(true);
    expect(catalog.pets.filter((pet) => pet.cost === 5)).toHaveLength(30);
    expect(catalog.pets.filter((pet) => pet.cost === 10)).toHaveLength(8);
    expect(catalog.pets.filter((pet) => pet.hidden).map((pet) => pet.key).sort()).toEqual([
      "bullyfrogpetActor",
      "drgroundhogpetActor",
      "foulowlpetActor",
      "generalLarvaelusPetActor",
      "locolocustpetActor",
      "rockyRhinoPetActor",
      "skunkPetActor",
      "tameMamba",
    ]);
    expect(catalog.pets.find((pet) => pet.key === "trexActor")?.cost).toBe(25);
    expect(catalog.pets.every((pet) => pet.xp === pet.cost * 100)).toBe(true);
    expect(catalog.pets.find((pet) => pet.key === "brainActor")).toMatchObject({
      cost: 50,
      xp: 5_000,
      description: "An exclusive Pet Brain for the low price of 50 brains! It seems to like you!",
    });
    expect(catalog.pets.find((pet) => pet.key === "pinkBunny")).toMatchObject({
      actorKey: "bunnyActor", color: [255, 190, 190],
    });
    for (const pet of catalog.pets) {
      expect(pet.sheet.frameCount).toBeGreaterThan(0);
      expect(pet.animations).toHaveProperty(pet.states.idle[0].animation);
      expect(pet.animations).toHaveProperty(pet.states.move[0].animation);
    }
  });

  it("reconciles active selection against authoritative ownership", () => {
    const state = new GameState();
    state.syncPetOwnership(["catActor", "catActor", "alienActor"], "alienActor");
    expect(state.ownedPets).toEqual(["catActor", "alienActor"]);
    expect(state.activePet).toBe("alienActor");
    state.syncPetOwnership(["catActor"], "alienActor");
    expect(state.activePet).toBeNull();
    expect(state.equipPet("alienActor")).toBe(false);
    expect(state.equipPet("catActor")).toBe(true);
  });

  it("keeps exactly one selected follower and replaces it when another is equipped", () => {
    const state = new GameState();
    state.syncPetOwnership(["catActor", "alienActor"], null);

    expect(state.equipPet("catActor")).toBe(true);
    expect(state.activePet).toBe("catActor");
    expect(state.equipPet("alienActor")).toBe(true);
    expect(state.activePet).toBe("alienActor");

    expect(state.equipPet(null)).toBe(true);
    expect(state.activePet).toBeNull();
  });

  it("deploys owned pets into pen slots separately from the follower", () => {
    const state = new GameState();
    state.syncPetOwnership(["a", "b", "c", "d", "e"], "a");

    // Pen 0 holds b-e; a fifth pet goes to pen 1's first slot.
    expect(state.setPenPets(["b", "c", "d", "e"])).toBe(true);
    expect(state.penPets).toEqual(["b", "c", "d", "e"]);
    expect(state.activePet).toBe("a");
    expect(state.setPenPets(["b", "c", "d", "e", "b"])).toBe(false); // one pen per pet
    expect(state.setPenPets(Array.from({ length: 17 }, () => ""))).toBe(false);
    expect(state.setPenPets(["missing"])).toBe(false);

    expect(state.setPenPets(["a", "b", "", "", "c"])).toBe(true);
    expect(state.activePet).toBeNull();
    // Following b out of pen 0 leaves a blank, so c stays in pen 1.
    expect(state.equipPet("b")).toBe(true);
    expect(state.penPets).toEqual(["a", "", "", "", "c"]);
  });

  it("sanitizes persisted pen slots against ownership, duplicates and the follower", () => {
    const state = new GameState();
    state.syncPetOwnership(["a", "b", "c", "d", "e"], "a", ["a", "b", "b", "c", "d", "e", "missing"]);
    expect(state.penPets).toEqual(["", "b", "", "c", "d", "e"]);
  });
});
