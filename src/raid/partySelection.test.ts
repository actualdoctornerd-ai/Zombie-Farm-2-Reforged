import { describe, expect, it } from "vitest";
import { fillPartySelection, orderPartyRoster, reconcilePartySelection } from "./partySelection";

describe("reconcilePartySelection", () => {
  it("replaces an optimistic id with its authoritative id", () => {
    const result = reconcilePartySelection(
      ["local-zombie", "existing"],
      [{ id: "server-zombie", name: "New zombie" }, { id: "existing", name: "Existing zombie" }],
      (id) => id === "local-zombie" ? "server-zombie" : id,
      16
    );

    expect(result.ids).toEqual(["server-zombie", "existing"]);
    expect(result.party.map((unit) => unit.name)).toEqual(["New zombie", "Existing zombie"]);
    expect(result.missingIds).toEqual([]);
  });

  it("reports a selected optimistic zombie removed during settlement", () => {
    const result = reconcilePartySelection(
      ["kept", "rejected-harvest"],
      [{ id: "kept" }],
      (id) => id,
      16
    );

    expect(result.ids).toEqual(["kept"]);
    expect(result.missingIds).toEqual(["rejected-harvest"]);
  });

  it("deduplicates and clamps the submitted selection", () => {
    const result = reconcilePartySelection(
      ["a", "a", "b", "c"],
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      (id) => id,
      2
    );

    expect(result.ids).toEqual(["a", "b"]);
  });
});

describe("fillPartySelection", () => {
  it("does not let sold zombies in a remembered order consume selection slots", () => {
    expect(fillPartySelection(
      [],
      ["old-sold-a", "kept", "old-sold-b"],
      ["kept", "new-crazy", "new-dapper"],
      3
    )).toEqual(["kept", "new-crazy", "new-dapper"]);
  });

  it("preserves valid manual choices before filling", () => {
    expect(fillPartySelection(
      ["new-dapper"],
      ["kept", "new-dapper"],
      ["kept", "new-crazy", "new-dapper"],
      2
    )).toEqual(["new-dapper", "kept"]);
  });
});

describe("orderPartyRoster", () => {
  it("puts the previous raid order before remaining zombies in harvest order", () => {
    const eligible = ["harvest-1", "headless-a", "harvest-3", "headless-b", "newest"]
      .map((id) => ({ id }));

    expect(orderPartyRoster(eligible, ["headless-a", "headless-b"]).map((z) => z.id))
      .toEqual(["headless-a", "headless-b", "harvest-1", "harvest-3", "newest"]);
  });

  it("drops unavailable preferred ids and removes duplicates", () => {
    const eligible = ["a", "b", "c"].map((id) => ({ id }));
    expect(orderPartyRoster(eligible, ["gone", "b", "b"]).map((z) => z.id))
      .toEqual(["b", "a", "c"]);
  });
});
