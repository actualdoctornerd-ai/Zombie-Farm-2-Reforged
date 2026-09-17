import { describe, expect, it } from "vitest";
import { describeStoredSale, planStoredSale } from "./shedBulkSell";

const ids: Record<string, string[]> = {
  hedge: ["hedge-a", "hedge-b", "hedge-c"],
  crate: ["crate-a"],
};
const idsFor = (key: string) => ids[key] ?? [];
const refundOf = (_key: string, instanceId: string) => (instanceId === "hedge-b" ? 90 : 10);

describe("planStoredSale", () => {
  it("hands each selected copy of a key its own instance id", () => {
    const plan = planStoredSale(["hedge", "hedge"], idsFor, refundOf);
    expect(plan.lots.map((l) => l.instanceId)).toEqual(["hedge-a", "hedge-b"]);
    expect(plan.missing).toBe(0);
  });

  it("prices every copy on its own, so a dearer copy is not averaged away", () => {
    const plan = planStoredSale(["hedge", "hedge", "crate"], idsFor, refundOf);
    expect(plan.lots.map((l) => l.refund)).toEqual([10, 90, 10]);
    expect(plan.gold).toBe(110);
  });

  it("drops copies the shed no longer has rather than inventing an id", () => {
    const plan = planStoredSale(["crate", "crate", "crate"], idsFor, refundOf);
    expect(plan.lots).toEqual([{ key: "crate", instanceId: "crate-a", refund: 10 }]);
    expect(plan.missing).toBe(2);
    expect(plan.gold).toBe(10);
  });

  it("plans nothing for an empty selection", () => {
    expect(planStoredSale([], idsFor, refundOf)).toEqual({ lots: [], missing: 0, gold: 0 });
  });
});

describe("describeStoredSale", () => {
  const name = (key: string) => key[0].toUpperCase() + key.slice(1);
  const lot = (key: string) => ({ key, instanceId: `${key}-x`, refund: 1 });

  it("counts repeats and leads with the biggest stack", () => {
    expect(describeStoredSale([lot("crate"), lot("hedge"), lot("hedge")], name))
      .toBe("2 \u00d7 Hedge, Crate");
  });

  it("folds the tail into a 'more' count so the dialog stays one line", () => {
    const lots = ["a", "b", "c", "d", "e", "e"].map(lot);
    expect(describeStoredSale(lots, name, 2)).toBe("2 \u00d7 E, A, 3 more");
  });
});
