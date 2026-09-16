// The shed appearance picker.
//
// Upgrading the shed is one-way, and the earlier tiers are the ones a lot of farms
// were built around — this puts those looks back without putting the capacity back
// with them. Reached from the Storage panel's Items tab, which is where tapping the
// shed already lands.
import type { Hud } from "../../hud";
import type { ShedAppearanceView } from "../hudTypes";
import { openModal } from "../Modal";
import { setTintedSrc } from "../tintedSprite";

/** Open the picker over the Storage panel. `onPicked` fires after a choice has been
 *  applied, so the panel underneath can redraw. */
export function openShedAppearance(
  hud: Hud, view: ShedAppearanceView, onPicked?: () => void,
): void {
  // Opened from ON TOP of the Storage panel, whose own backdrop sits at z-index 21
  // — above the shared modal's 20. Without a layer of its own the picker renders
  // perfectly and is never seen.
  const { panel, close } = openModal({
    host: hud.el, panelClass: "shed-skin-panel", bgClass: "shed-skin-bg",
    title: "Shed Appearance",
  });

  // A plain <p>: the shared modal is dark brown with white text, and the Storage
  // panel's own parchment hint colour is unreadable on it.
  const blurb = document.createElement("p");
  blurb.className = "shed-skin-blurb";
  // Say the split out loud. A player who dresses their barn as a Shabby Shed has to
  // be able to tell at a glance that they did not just throw away 56 slots.
  blurb.textContent =
    `Pick any shed you've owned. This changes the look only — it stays a ${view.realName}, holding ${view.slots} items.`;
  panel.appendChild(blurb);

  const grid = document.createElement("div");
  grid.className = "st-grid";
  for (const option of view.options) {
    const slot = document.createElement("button");
    const active = option.key === view.current;
    slot.className = "st-slot shed-skin-slot" + (active ? " filled" : "");
    slot.title = active ? `${option.name} (current look)` : `Look like the ${option.name}`;
    const img = document.createElement("img");
    setTintedSrc(img, option.portrait, option.tint);
    const label = document.createElement("span");
    label.className = "shed-skin-name";
    label.textContent = option.name;
    slot.append(img, label);
    slot.onclick = async () => {
      if (active) { close(); return; }
      slot.disabled = true;
      await hud.onPickShedAppearance?.(option.key);
      close();
      onPicked?.();
    };
    grid.appendChild(slot);
  }
  panel.appendChild(grid);
}
