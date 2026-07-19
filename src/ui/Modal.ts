// Shared modal/panel scaffold. Nearly every HUD dialog hand-built the same
// `.panelbg > .panel > .panelclose` structure with a backdrop-click-to-close
// handler; that boilerplate was copied ~25 times. `openModal` builds exactly
// that DOM (identical tags, class names and child order, so the existing CSS in
// hud.css applies unchanged) and returns handles to the pieces the caller fills
// in. A single idempotent `close()` covers the close button, the backdrop click
// and any programmatic dismissal.
import { UI } from "./uiAsset";

export interface ModalHandle {
  /** The `.panelbg` backdrop element (already appended to the host). */
  bg: HTMLElement;
  /** The `.panel` container — append your body content here. */
  panel: HTMLElement;
  /** Remove the modal and fire `onClose` once (safe to call repeatedly). */
  close: () => void;
}

export interface ModalOpts {
  /** Where to append the backdrop (the HUD root element). */
  host: HTMLElement;
  /** Extra class(es) added to `.panel` (e.g. "confirm-panel", "obj-actions"). */
  panelClass?: string;
  /** Extra class(es) added to `.panelbg` (e.g. "game-confirm-bg", "raid-bg"). */
  bgClass?: string;
  /** Optional `<h2>` heading rendered right after the close button. */
  title?: string;
  /** Render the corner close button (default true). */
  closeButton?: boolean;
  /** Close when the backdrop (outside the panel) is clicked (default true). */
  backdropClose?: boolean;
  /** Fired once, whenever the modal closes by any path. */
  onClose?: () => void;
  /**
   * Before opening, remove an existing element matching this selector within
   * `host`. Used by singleton dialogs (e.g. the confirm window) to avoid stacking.
   */
  replaceSelector?: string;
}

export function openModal(opts: ModalOpts): ModalHandle {
  const { host } = opts;
  if (opts.replaceSelector) host.querySelector(opts.replaceSelector)?.remove();

  const bg = document.createElement("div");
  bg.className = opts.bgClass ? `panelbg ${opts.bgClass}` : "panelbg";
  const panel = document.createElement("div");
  panel.className = opts.panelClass ? `panel ${opts.panelClass}` : "panel";

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bg.remove();
    opts.onClose?.();
  };

  if (opts.closeButton !== false) {
    const x = document.createElement("button");
    x.className = "panelclose";
    const xi = document.createElement("img");
    xi.src = UI("button_close.png");
    x.appendChild(xi);
    x.onclick = () => close();
    panel.appendChild(x);
  }

  if (opts.title != null) {
    const h = document.createElement("h2");
    h.textContent = opts.title;
    panel.appendChild(h);
  }

  bg.appendChild(panel);
  if (opts.backdropClose !== false) {
    bg.onclick = (e) => { if (e.target === bg) close(); };
  }
  host.appendChild(bg);
  return { bg, panel, close };
}
