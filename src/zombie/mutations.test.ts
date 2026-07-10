import { describe, it, expect } from "vitest";
import { combineMasks, SLOT_MASK } from "./mutations";

// Ground truth: combineZombieMutationFlag:withZombieFlag: / randMutation: — per slot,
// non-conflicting bits carry over; a same-slot conflict keeps the HIGHER bit value
// (higher-tier mutation), DETERMINISTICALLY (no RNG). One mutation per slot.

describe("combineMasks — deterministic per-slot inheritance", () => {
  it("carries a mutation from either parent when the other slot is empty", () => {
    expect(combineMasks(1, 0)).toBe(1); // only A (head)
    expect(combineMasks(0, 8)).toBe(8); // only B (arm)
  });

  it("unions mutations that occupy different slots", () => {
    // 1 = head (tomato), 8 = arm (turnip) — independent slots
    expect(combineMasks(1, 8)).toBe(9);
  });

  it("resolves a same-slot conflict to the higher bit (higher tier wins)", () => {
    // head slot: 1 (tomato) vs 256 (garlic) -> garlic
    expect(combineMasks(1, 256)).toBe(256);
    expect(combineMasks(256, 1)).toBe(256); // order-independent
  });

  it("keeps at most one mutation per slot in the child", () => {
    const child = combineMasks(1, 16); // both head (tomato vs potato)
    expect(child & SLOT_MASK.head).toBe(16); // the higher one, only
    // exactly one head bit set
    const headBits = SLOT_MASK.head & child;
    expect(headBits & (headBits - 1)).toBe(0);
  });

  it("is commutative across every slot", () => {
    const a = 1 | 8 | 1024; // head + arm + body
    const b = 256 | 4 | 2048; // head + hair_eye + neck
    expect(combineMasks(a, b)).toBe(combineMasks(b, a));
  });
});
