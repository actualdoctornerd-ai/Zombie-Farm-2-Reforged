// The solver, against answers known in advance. See regression.ts for why this is separate.
import { describe, expect, it } from "vitest";
import { pearson, ridgeSolve, spearman } from "./regression";
import { seededRandom } from "../RaidCatalog";

describe("ridgeSolve", () => {
  it("recovers weights it was given, from counts that sum to a constant", () => {
    // Exactly the shape the effective-strength fit sees: each row is an army's species
    // counts, every row sums to 16, and the target is the weighted sum.
    const truth = [0.9, 0.4, 0.1, 0.55, 0.2];
    const rand = seededRandom("ridge");
    const X: number[][] = [];
    const y: number[] = [];
    for (let r = 0; r < 400; r++) {
      const row = new Array(truth.length).fill(0);
      for (let s = 0; s < 16; s++) row[Math.floor(rand() * truth.length) % truth.length]++;
      X.push(row);
      y.push(row.reduce((sum, n, i) => sum + n * truth[i], 0));
    }
    const w = ridgeSolve(X, y, 1e-6);
    for (let i = 0; i < truth.length; i++) expect(w[i]).toBeCloseTo(truth[i], 3);
  });

  it("survives noise without chasing it", () => {
    const truth = [1, 0.5, 0.25];
    const rand = seededRandom("noise");
    const X: number[][] = [];
    const y: number[] = [];
    for (let r = 0; r < 600; r++) {
      const row = new Array(truth.length).fill(0);
      for (let s = 0; s < 16; s++) row[Math.floor(rand() * truth.length) % truth.length]++;
      X.push(row);
      y.push(row.reduce((sum, n, i) => sum + n * truth[i], 0) + (rand() - 0.5) * 2);
    }
    const w = ridgeSolve(X, y, 1e-3);
    for (let i = 0; i < truth.length; i++) expect(w[i]).toBeCloseTo(truth[i], 1);
  });

  it("returns zero for a column that never appears rather than failing", () => {
    const X = [[1, 0], [2, 0], [3, 0]];
    const w = ridgeSolve(X, [1, 2, 3], 1e-6);
    expect(w[0]).toBeCloseTo(1, 4);
    expect(w[1]).toBe(0);
  });
});

describe("correlations", () => {
  it("scores a perfect and a reversed ordering", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it("spearman sees a monotone but non-linear relationship Pearson understates", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 4, 9, 16, 250];
    expect(spearman(a, b)).toBeCloseTo(1, 6);
    expect(pearson(a, b)).toBeLessThan(0.9);
  });

  it("shares ranks across ties", () => {
    expect(spearman([1, 1, 2], [5, 5, 9])).toBeCloseTo(1, 6);
  });
});
