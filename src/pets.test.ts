import { describe, expect, it } from "vitest";
import catalog from "../public/assets/pets/catalog.json";
import { GameState } from "./GameState";

describe("cosmetic pet catalog and client ownership", () => {
  it("contains the complete unique, priced source catalog", () => {
    expect(catalog.pets).toHaveLength(40);
    expect(new Set(catalog.pets.map((pet) => pet.key)).size).toBe(40);
    expect(catalog.pets.every((pet) => pet.brains && pet.cost > 0 && !pet.hidden)).toBe(true);
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

  it("deploys up to four owned pets in the pen separately from the follower", () => {
    const state = new GameState();
    state.syncPetOwnership(["a", "b", "c", "d", "e"], "a");

    expect(state.setPenPets(["b", "c", "d", "e"])).toBe(true);
    expect(state.penPets).toEqual(["b", "c", "d", "e"]);
    expect(state.activePet).toBe("a");
    expect(state.setPenPets(["a", "b", "c", "d", "e"])).toBe(false);
    expect(state.setPenPets(["missing"])).toBe(false);

    expect(state.setPenPets(["a", "b"])).toBe(true);
    expect(state.activePet).toBeNull();
    expect(state.equipPet("b")).toBe(true);
    expect(state.penPets).toEqual(["a"]);
  });

  it("sanitizes persisted pen selections against ownership and the four-pet cap", () => {
    const state = new GameState();
    state.syncPetOwnership(["a", "b", "c", "d", "e"], "a", ["a", "b", "b", "c", "d", "e", "missing"]);
    expect(state.penPets).toEqual(["b", "c", "d", "e"]);
  });
});
