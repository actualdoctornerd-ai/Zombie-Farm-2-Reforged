import { describe, it, expect } from "vitest";
import { GameState } from "./GameState";
import { farmLifeForce } from "./lifeForce";

// Life Force is DERIVED from the placed objects (main.ts refreshLifeForce) and handed to
// GameState, which only holds it for the HUD. These pin that the hand-off is idempotent,
// and quiet when nothing changed. SaveManager lists the persisted fields
// explicitly and does not include it.

describe("GameState life force", () => {
  it("starts at zero", () => {
    expect(new GameState().lifeForce).toBe(0);
  });

  it("adopts a derived total and tells listeners once", () => {
    const s = new GameState();
    let emitted = 0;
    s.onChange(() => emitted++);
    s.syncLifeForce(112);
    expect(s.lifeForce).toBe(112);
    expect(emitted).toBe(1);
    s.syncLifeForce(112); // nothing changed: no redraw
    expect(emitted).toBe(1);
  });

  it("floors and clamps whatever it is given", () => {
    const s = new GameState();
    s.syncLifeForce(29.9);
    expect(s.lifeForce).toBe(29);
    s.syncLifeForce(-4);
    expect(s.lifeForce).toBe(0);
  });

  it("is recomputed from the objects standing on the farm, not accumulated", () => {
    const of = (k: string) => ({ crate: 1, gazeboNormal: 16 }[k] ?? 0);
    const s = new GameState();
    s.syncLifeForce(farmLifeForce(["crate", "gazeboNormal"], of));
    expect(s.lifeForce).toBe(17);
    s.syncLifeForce(farmLifeForce(["crate"], of)); // the gazebo was stored away
    expect(s.lifeForce).toBe(1);
  });
});
