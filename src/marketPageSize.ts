export interface MarketPageMetrics {
  mobile: boolean;
  columns: number;
  rowHeight: number;
  gap: number;
  availableHeight: number;
}

/** Desktop Market pages are deliberately stable at two rows of five. Compact
 * layouts retain their responsive, touch-scrollable sizing. */
export function marketPageSize(metrics: MarketPageMetrics): number {
  if (!metrics.mobile) return 10;
  if (metrics.availableHeight < metrics.rowHeight) return 10;
  const rows = Math.max(
    1,
    Math.floor((metrics.availableHeight + metrics.gap) / (metrics.rowHeight + metrics.gap)),
  );
  const fit = Math.max(1, metrics.columns) * rows;
  return metrics.columns >= 3 ? fit : Math.max(fit, 8);
}
