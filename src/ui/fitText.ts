/** Shrink each element's font until its text fits on one line in the box the layout
 *  gave it. Clears any earlier size first, so growing room restores the stylesheet's
 *  size. Reads and writes are batched across the whole list: resetting one chip's text
 *  changes how flex shares the row with the others. An element that cannot fit even at
 *  `minPx` keeps that floor and falls back to its own ellipsis. */
export function fitTexts(els: readonly HTMLElement[], minPx = 8, stepPx = 0.5): void {
  for (const el of els) el.style.fontSize = "";
  const sizes = els.map((el) => {
    if (el.clientWidth === 0) return null; // display:none (e.g. the nameplate in portrait)
    if (el.scrollWidth <= el.clientWidth) return null;
    return parseFloat(getComputedStyle(el).fontSize);
  });
  els.forEach((el, i) => {
    let size = sizes[i];
    if (size === null || !Number.isFinite(size)) return;
    while (size > minPx && el.scrollWidth > el.clientWidth) {
      size = Math.max(minPx, size - stepPx);
      el.style.fontSize = `${size}px`;
    }
  });
}

/** Does a flex row's content run past its right edge? Looks at the last child's edge,
 *  not scrollWidth: an absolutely positioned tooltip inside a chip (hidden or not)
 *  also counts toward scrollWidth and would read as overflow. */
function rowOverflows(row: HTMLElement): boolean {
  const last = row.lastElementChild;
  if (!last) return false;
  return last.getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5;
}

/** Shrink a row of text boxes TOGETHER until the row fits its container, so a tight
 *  top bar gets one consistent smaller size instead of each chip picking its own.
 *  `row` must be a shrinkable flex container whose children never shrink themselves:
 *  overflow shows up as the last child running past the row's right edge. */
export function fitRow(row: HTMLElement, els: readonly HTMLElement[], minPx = 8, stepPx = 0.5): void {
  for (const el of els) el.style.fontSize = "";
  if (row.clientWidth === 0 || !els.length || !rowOverflows(row)) return;
  let size = parseFloat(getComputedStyle(els[0]).fontSize);
  if (!Number.isFinite(size)) return;
  while (size > minPx && rowOverflows(row)) {
    size = Math.max(minPx, size - stepPx);
    for (const el of els) el.style.fontSize = `${size}px`;
  }
}
