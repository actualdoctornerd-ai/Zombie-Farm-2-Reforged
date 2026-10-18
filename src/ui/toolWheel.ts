// The right-click tool menu (Settings → Controls → Right-Click → Tool Menu): a small
// scrollable list of the farm tools that opens at the cursor. The mouse wheel moves
// the highlight, Enter (or a click) equips the highlighted tool, Escape / right-click
// / a click outside cancels.
//
// It deliberately opens on Select, because right-click means "back to the Select
// tool" by default — so a player who switched to the menu keeps that muscle memory
// (right-click, Enter), and everything else is a scroll away. The tool that is
// actually equipped is marked separately, so the highlight never lies about the state.
import { UI } from "./uiAsset";

export interface ToolWheelItem {
  /** Stable id (the HUD Mode it equips, or "plant" for the picker). */
  id: string;
  label: string;
  /** UI-atlas image name, e.g. "button_plow.png". */
  icon: string;
  /** Keyboard shortcut shown on the row; also picks the row while open. */
  hint: string;
  /** True for the tool currently equipped on the farm. */
  active?: boolean;
  onPick: () => void;
}

export interface ToolWheelHandle {
  close: () => void;
}

export interface ToolWheelOpts {
  /** Viewport point to anchor the menu at (the right-click position). */
  x: number;
  y: number;
  items: ToolWheelItem[];
  /** Click feedback for a pick (the HUD's menu blip). */
  onSound?: () => void;
  /** Fired once when the menu goes away by any path, including `close()`. */
  onClose?: () => void;
}

/** The object the rotate control is looking at right now: the one on the placement
 *  ghost, or the one the Move tool is carrying. Null when the player's hands are empty,
 *  which is when Rotate means the standalone tool. `move` mode alone is not enough —
 *  the tool is equipped long before anything is picked up with it.
 *
 *  Pure so the rule can be pinned in a test; the menu itself is built in main. */
export function heldObjectName(
  mode: string,
  placingName: string | undefined,
  carryingName: string | undefined,
): string | null {
  if (mode === "place") return placingName ?? null;
  if (mode === "move") return carryingName ?? null;
  return null;
}

/** The rotate row's identity for the current context.
 *
 *  With something in hand this row TURNS it — the same thing the toolbar's Rotate button
 *  and the 3 key already do, and the only rotate-before-placing a right-click player has.
 *  It was briefly a plain tool switch, after a report of picking Rotate here mid-purchase
 *  and appearing to be stuck in placement mode (the pick was spinning the ghost, which is
 *  easy to miss); that removed the capability and came straight back as its own report.
 *  Naming the row after the thing it turns settles both — it cannot be mistaken for a
 *  tool switch, and Select, the row the menu opens on, is still the way out. */
export function rotateRowFor(heldName: string | null): { id: string; label: string } {
  return heldName ? { id: "turn", label: `Turn ${heldName}` } : { id: "rotate", label: "Rotate" };
}

/** Trackpads emit many tiny wheel events; a notch-per-row menu needs a
 *  deliberate gesture. Roughly one mouse notch. */
export const WHEEL_STEP_THRESHOLD = 40;

/** Move a highlight by `delta` rows, wrapping at both ends. */
export function stepWheelIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

/**
 * Fold one wheel event into an accumulator. Returns the carried-over total and
 * how many rows the highlight should move (0 until the gesture is big enough).
 * The remainder is dropped rather than carried so a slow trackpad drift can't
 * bank up into a surprise jump later.
 */
export function accumulateWheel(
  total: number,
  delta: number,
  threshold = WHEEL_STEP_THRESHOLD,
): { total: number; step: number } {
  const next = total + delta;
  if (Math.abs(next) < threshold) return { total: next, step: 0 };
  return { total: 0, step: next > 0 ? 1 : -1 };
}

/**
 * Open the tool menu at viewport point (`x`, `y`) inside `host` (the HUD root).
 * Returns a handle whose `close()` is safe to call repeatedly; the menu also
 * closes itself on pick, Escape, an outside click, or window blur.
 */
export function openToolWheel(host: HTMLElement, opts: ToolWheelOpts): ToolWheelHandle {
  const { x, y, items, onSound, onClose } = opts;
  const bg = document.createElement("div");
  bg.className = "tw-bg";
  const menu = document.createElement("div");
  menu.className = "tw";
  menu.tabIndex = -1;

  const title = document.createElement("div");
  title.className = "tw-title";
  title.textContent = "Tools";
  menu.appendChild(title);

  const rows: HTMLButtonElement[] = [];
  items.forEach((item, i) => {
    const row = document.createElement("button");
    row.className = "tw-item";
    row.type = "button";
    const img = document.createElement("img");
    img.src = UI(item.icon);
    img.alt = "";
    const label = document.createElement("span");
    label.className = "tw-lbl";
    label.textContent = item.label;
    const key = document.createElement("span");
    key.className = "tw-key";
    key.textContent = item.hint;
    row.append(img, label, key);
    if (item.active) {
      row.classList.add("equipped");
      const dot = document.createElement("span");
      dot.className = "tw-dot";
      dot.title = "Currently equipped";
      row.appendChild(dot);
    }
    // Hovering is the mouse's own way of aiming: keep it in sync with the wheel
    // so a click never equips a different tool than the one under the cursor.
    row.addEventListener("pointerenter", () => highlight(i));
    row.addEventListener("click", (e) => { e.preventDefault(); pick(i); });
    rows.push(row);
    menu.appendChild(row);
  });

  const legend = document.createElement("div");
  legend.className = "tw-legend";
  legend.textContent = "Scroll to choose · Enter to select · Esc to cancel";
  menu.appendChild(legend);

  bg.appendChild(menu);
  host.appendChild(bg);

  // Anchor at the cursor, then pull the menu back inside the viewport. Measuring
  // after the append is a forced layout, but it happens once per open.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const box = menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - box.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - box.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  let index = 0;
  let closed = false;
  let wheelTotal = 0;

  function highlight(i: number) {
    index = i;
    rows.forEach((row, n) => row.classList.toggle("sel", n === i));
    rows[i]?.scrollIntoView({ block: "nearest" });
  }

  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    bg.remove();
    onClose?.();
  }

  function pick(i: number) {
    const item = items[i];
    if (!item) return;
    close();
    onSound?.();
    item.onPick();
  }

  function onKey(e: KeyboardEvent) {
    // Capture phase, and every handled key stops here: the HUD's own 1-5 / p
    // shortcuts are window-level too, and letting both fire would toggle the
    // tool twice (setMode treats a repeat of the current tool as "unequip").
    const key = e.key;
    if (key === "Escape" || key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
      e.preventDefault();
      e.stopPropagation();
      pick(index);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      highlight(stepWheelIndex(index, key === "ArrowDown" ? 1 : -1, rows.length));
      return;
    }
    const shortcut = items.findIndex((it) => it.hint.toLowerCase() === key.toLowerCase());
    if (shortcut >= 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(shortcut);
    }
  }

  bg.addEventListener("wheel", (e) => {
    e.preventDefault(); // never let the farm camera zoom underneath the menu
    e.stopPropagation();
    const primary = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const { total, step } = accumulateWheel(wheelTotal, primary);
    wheelTotal = total;
    if (step) highlight(stepWheelIndex(index, step, rows.length));
  }, { passive: false });
  bg.addEventListener("pointerdown", (e) => {
    if (e.target === bg) close(); // clicked away from the menu
  });
  bg.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // a second right-click dismisses instead of stacking menus
    close();
  });
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);

  highlight(0);
  menu.focus({ preventScroll: true });
  return { close };
}
