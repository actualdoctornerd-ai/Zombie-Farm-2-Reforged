import { describe, it, expect } from "vitest";
import {
  classOptions, decodeRosterFilter, encodeRosterFilter, filterZombies, isFiltered,
  NO_ROSTER_FILTER, settleRosterFilter, speciesOptions, type FilterableZombie,
} from "./rosterFilter";

const z = (key: string, typeName: string, group: string) => ({ key, typeName, group });
const rows: FilterableZombie[] = [
  z("ZombieActorGarden", "Garden Zombie", "Garden"),
  z("ZombieActorRegular", "Zombie", "Regular"),
  z("ZombieActorFemale", "Girl Zombie", "Female"),
  z("ZombieActorRegular", "Zombie", "Regular"),
  z("ZombieActorCrazy", "Crazy Zombie", "Regular"),
];

describe("roster filter", () => {
  it("no filter keeps every row, in order", () => {
    expect(filterZombies(rows, NO_ROSTER_FILTER)).toEqual(rows);
    expect(isFiltered(NO_ROSTER_FILTER)).toBe(false);
  });

  it("filters by class and by species, and by both together", () => {
    expect(filterZombies(rows, { group: "Regular", species: "" })).toHaveLength(3);
    expect(filterZombies(rows, { group: "", species: "ZombieActorRegular" })).toHaveLength(2);
    expect(filterZombies(rows, { group: "Regular", species: "ZombieActorCrazy" })).toHaveLength(1);
  });

  it("offers only the classes present, in the Black Market's order and labels", () => {
    expect(classOptions(rows)).toEqual([
      { value: "Regular", label: "Normal", count: 3 },
      { value: "Female", label: "Girl", count: 1 },
      { value: "Garden", label: "Garden", count: 1 },
    ]);
  });

  it("never hides a zombie whose group the Market does not list", () => {
    const odd = [...rows, z("ZombieActorOdd", "Odd", "Mystery")];
    expect(classOptions(odd).map((o) => o.value)).toContain("Mystery");
  });

  it("lists species by name with counts, narrowed by class", () => {
    expect(speciesOptions(rows).map((o) => [o.label, o.count])).toEqual([
      ["Crazy Zombie", 1], ["Garden Zombie", 1], ["Girl Zombie", 1], ["Zombie", 2],
    ]);
    expect(speciesOptions(rows, "Regular").map((o) => o.value))
      .toEqual(["ZombieActorCrazy", "ZombieActorRegular"]);
  });

  it("settling drops a species from another class, and choices the rows lost", () => {
    expect(settleRosterFilter(rows, { group: "Garden", species: "ZombieActorCrazy" }))
      .toEqual({ group: "Garden", species: "" });
    expect(settleRosterFilter(rows, { group: "Large", species: "ZombieActorGone" }))
      .toEqual(NO_ROSTER_FILTER);
    expect(settleRosterFilter(rows, { group: "Regular", species: "ZombieActorCrazy" }))
      .toEqual({ group: "Regular", species: "ZombieActorCrazy" });
  });

  it("round-trips through a string and survives junk", () => {
    const f = { group: "Female", species: "ZombieActorFemale" };
    expect(decodeRosterFilter(encodeRosterFilter(f))).toEqual(f);
    expect(decodeRosterFilter(undefined)).toEqual(NO_ROSTER_FILTER);
    expect(decodeRosterFilter("{nope")).toEqual(NO_ROSTER_FILTER);
    expect(decodeRosterFilter("null")).toEqual(NO_ROSTER_FILTER);
  });
});
