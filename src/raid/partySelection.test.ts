import { describe, expect, it } from "vitest";
import { reconcilePartySelection } from "./partySelection";

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
