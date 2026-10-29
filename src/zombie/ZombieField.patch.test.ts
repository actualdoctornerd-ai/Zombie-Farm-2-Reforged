import { describe, expect, it, vi } from "vitest";
import { joiningPatchTile, ZombieField } from "./ZombieField";

type UnitStub = {
  napOnPatch: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
};

const subject = (units: UnitStub[]) => {
  const zombies = Object.create(ZombieField.prototype) as ZombieField;
  Object.assign(zombies, { units, gathered: false });
  return zombies;
};

describe("Zombie Patch persistence", () => {
  it("assigns zombies arriving during a gathering to the next patch tile", () => {
    const tiles = [{ col: 4, row: 5 }, { col: 6, row: 7 }];
    expect(joiningPatchTile(true, tiles, 2)).toEqual({ col: 4, row: 5 });
    expect(joiningPatchTile(false, tiles, 2)).toBeNull();
    expect(joiningPatchTile(true, null, 2)).toBeNull();
  });

  it("restores gathered zombies to sleep across the patch tiles", () => {
    const units = [
      { napOnPatch: vi.fn(), wake: vi.fn() },
      { napOnPatch: vi.fn(), wake: vi.fn() },
      { napOnPatch: vi.fn(), wake: vi.fn() },
    ];
    const zombies = subject(units);
    const tiles = [{ col: 4, row: 5 }, { col: 6, row: 7 }];

    zombies.restoreGathered(true, tiles);

    expect(zombies.isGathered).toBe(true);
    expect(units[0].napOnPatch).toHaveBeenCalledWith({ col: 4, row: 5 }, tiles);
    expect(units[1].napOnPatch).toHaveBeenCalledWith({ col: 6, row: 7 }, tiles);
    expect(units[2].napOnPatch).toHaveBeenCalledWith({ col: 4, row: 5 }, tiles);
  });

  it("defaults old saves to awake and ignores a stale nap without a patch", () => {
    const unit = { napOnPatch: vi.fn(), wake: vi.fn() };
    const zombies = subject([unit]);

    zombies.restoreGathered(undefined, [{ col: 4, row: 5 }]);
    expect(zombies.isGathered).toBe(false);
    expect(unit.wake).toHaveBeenCalledOnce();

    zombies.restoreGathered(true, null);
    expect(zombies.isGathered).toBe(false);
    expect(unit.napOnPatch).not.toHaveBeenCalled();
  });
});
