import { describe, expect, it } from "vitest";
import type { BoostDef } from "../assets";
import { storageBoostRows } from "./storageBoosts";

const boost = (key: string): BoostDef => ({
  key,
  name: key,
  cost: 1,
  brainsNeeded: false,
  level: 1,
  effect: "grow",
  amount: 1,
  perPurchase: 1,
  giftZombieKey: "",
  usableOnFarm: true,
  info: "",
  flavorText: "",
  icon: `${key}.png`,
});

describe("Storage boost catalog", () => {
  it("shows a never-sold boost (the Green Flower Ticket) only while one is held", () => {
    const ticket = { ...boost("ticket"), notForSale: true };
    expect(storageBoostRows([boost("grow"), ticket], []).map(({ def }) => def.key)).toEqual(["grow"]);
    expect(storageBoostRows([boost("grow"), ticket], [{ key: "ticket", count: 1 }])
      .map(({ def, count }) => [def.key, count])).toEqual([["grow", 0], ["ticket", 1]]);
  });

  it("shows every boost and assigns zero to unowned entries", () => {
    const rows = storageBoostRows(
      [boost("grow"), boost("harvest"), boost("dice")],
      [{ key: "harvest", count: 2 }],
    );
    expect(rows.map(({ def, count }) => [def.key, count])).toEqual([
      ["grow", 0],
      ["harvest", 2],
      ["dice", 0],
    ]);
  });
});
