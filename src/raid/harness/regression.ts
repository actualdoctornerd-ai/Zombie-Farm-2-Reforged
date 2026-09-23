// Least squares with a ridge term — the arithmetic behind the effective-strength fit.
//
// Kept apart from the thing that uses it because a solver is either right or it is not,
// and that is a question a unit test can settle in microseconds against a known answer,
// whereas the fit it feeds takes nine thousand simulated fights to produce. When the
// effective-strength numbers look surprising, this file is the half that has already been
// ruled out.
//
// WHY RIDGE AND NOT PLAIN OLS. The design matrix is species counts per army, and some
// species are near-substitutes that a random sampler will often draw together; a couple of
// near-collinear columns is enough to make an unregularised solve hand back two enormous
// coefficients that cancel. A small ridge term costs a little bias and removes the whole
// failure mode. It also guarantees the normal-equation matrix is invertible, so a species
// that never appeared cannot make the solve fail — it comes back at zero, which is the
// honest answer for "no evidence".

/** Solve `(XᵀX + λI) w = Xᵀy` for w. Returns one weight per column of X.
 *
 *  No intercept, deliberately. Every row of X is an army's species counts and those always
 *  sum to the army size, so a column of ones is an exact linear combination of the rest and
 *  the system would be singular. Without it each weight reads as "score contributed per
 *  slot of this species", which is the quantity wanted anyway. */
export function ridgeSolve(X: readonly (readonly number[])[], y: readonly number[], lambda: number): number[] {
  const n = X.length;
  if (!n) return [];
  const p = X[0].length;
  if (y.length !== n) throw new Error(`ridgeSolve: ${n} rows but ${y.length} targets`);

  // Normal equations. XᵀX is p×p and symmetric, so only half is built and mirrored.
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let r = 0; r < n; r++) {
    const row = X[r];
    if (row.length !== p) throw new Error(`ridgeSolve: ragged row ${r}`);
    for (let i = 0; i < p; i++) {
      const xi = row[i];
      if (xi === 0) continue;
      b[i] += xi * y[r];
      for (let j = i; j < p; j++) A[i][j] += xi * row[j];
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < i; j++) A[i][j] = A[j][i];
    A[i][i] += lambda;
  }
  return solveSymmetric(A, b);
}

/** Gaussian elimination with partial pivoting. Small p, so nothing clever is called for. */
function solveSymmetric(A: number[][], b: number[]): number[] {
  const p = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) continue; // ridge should prevent this
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let c = col; c <= p; c++) M[col][c] /= d;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[p]);
}

/** Pearson correlation. The headline for "does this predict better than that": both
 *  candidate scores are on different scales, and only their ORDERING has to be right. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n < 2 || b.length !== n) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Spearman rank correlation — Pearson on ranks.
 *
 *  Reported alongside Pearson because the thing being judged is a LADDER: what matters is
 *  whether it puts armies in the right order, not whether the relationship is linear. A
 *  metric could be a perfect ranking and a poor linear predictor, and that metric would be
 *  entirely fit for purpose. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  return pearson(ranks(a), ranks(b));
}

function ranks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    // Ties share the mean of the ranks they span, so a metric that cannot separate two
    // armies is not rewarded for the arbitrary order they happened to arrive in.
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = mean;
    i = j + 1;
  }
  return out;
}
