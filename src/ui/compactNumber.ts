/** Abbreviate a big gold count for a tight chip: 100k, 123k, 1mil, 1.2mil, 12.3mil.
 *  Truncates rather than rounds, so the chip never claims more than the player has. */
export function compactGold(n: number): string {
  if (!Number.isFinite(n) || n < 100_000) return String(n);
  const units: [number, string][] = [[1e9, "bil"], [1e6, "mil"], [1e3, "k"]];
  for (const [div, suffix] of units) {
    if (n < div) continue;
    const v = n / div;
    if (suffix === "k") return `${Math.floor(v)}k`;
    const t = Math.floor(v * 10) / 10;
    return `${Number.isInteger(t) ? t : t.toFixed(1)}${suffix}`;
  }
  return String(n);
}
