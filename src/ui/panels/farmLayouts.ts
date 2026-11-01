// The Farm Layouts panel: save where every decoration stands, and swap the farm
// between saved looks. Reached from the Storage panel's Items tab, because a load is
// nothing but shed moves. The rules (what is kept, shelved, placed or skipped) live in
// src/farmLayouts.ts; main.ts performs the swap.
import type { Hud } from "../../hud";
import { openModal } from "../Modal";
import { LAYOUT_NAME_MAX, MAX_LAYOUTS } from "../../farmLayouts";

export interface FarmLayoutSummary {
  id: string;
  name: string;
  savedAt: number;
  count: number;
}

/** What a load would do, for the confirm prompt. */
export interface FarmLayoutPreview {
  keep: number;
  store: number;
  place: number;
  missing: number;
  stuck: number;
  shedAfter: number;
  shedCap: number;
}

export interface FarmLayoutsHooks {
  /** Fetch the latest list (the server's, online). Resolves to a notice, or null. */
  sync: () => Promise<string | null>;
  /** The list as of the last sync or write. */
  list: () => FarmLayoutSummary[];
  /** Objects on the farm right now (what Save would capture). */
  placedCount: () => number;
  preview: (id: string) => FarmLayoutPreview | null;
  /** Save the farm as a new layout, or over `replaceId`. Returns an error, or null. */
  save: (name: string, replaceId?: string) => Promise<string | null>;
  /** Perform the swap. Resolves to the message to show. */
  load: (id: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function openFarmLayouts(hud: Hud, hooks: FarmLayoutsHooks): void {
  // Same raised layer as the Shed Appearance picker: this opens over Storage (z 21).
  const { panel, close } = openModal({
    host: hud.el, bgClass: "shed-skin-bg", panelClass: "farm-layouts-panel",
    title: "Farm Layouts", replaceSelector: ".farm-layouts-bg",
  });
  panel.parentElement?.classList.add("farm-layouts-bg");

  const blurb = document.createElement("p");
  blurb.className = "shed-skin-blurb";
  blurb.textContent =
    "Save where your decorations stand and swap between looks — a seasonal farm, a " +
    "party farm, anything. Plots stay where they are, and an item whose spot a plot " +
    "covers stays in the shed. Loading uses your shed: things not in the layout are " +
    "stored, the layout's items come back out. Signed in, layouts follow your account to any device.";
  panel.appendChild(blurb);

  const list = document.createElement("div");
  list.className = "zteam-list";
  const saveRow = document.createElement("div");
  saveRow.className = "zteam-row farm-layout-save";
  panel.append(list, saveRow);

  let busy = true; // until the first sync lands
  const render = () => {
    const layouts = hooks.list();
    list.replaceChildren();
    if (!layouts.length) {
      const empty = document.createElement("div");
      empty.className = "zr-empty";
      empty.textContent = busy ? "Loading…" : "No saved layouts yet.";
      list.appendChild(empty);
    }
    for (const layout of layouts) {
      const row = document.createElement("div");
      row.className = "zteam-row";
      const info = document.createElement("div");
      info.className = "zteam-info";
      const nm = document.createElement("div");
      nm.className = "zteam-nm";
      nm.textContent = layout.name;
      const sub = document.createElement("div");
      sub.className = "zteam-sub";
      sub.textContent = `${plural(layout.count, "item")} · saved ${new Date(layout.savedAt).toLocaleDateString()}`;
      info.append(nm, sub);

      const actions = document.createElement("div");
      actions.className = "zbtns zteam-actions";
      const load = document.createElement("button");
      load.className = "zbtn deploy";
      load.textContent = "Load";
      load.disabled = busy;
      load.onclick = async () => {
        const p = hooks.preview(layout.id);
        if (!p) return;
        if (p.shedAfter > p.shedCap) {
          hud.showToast(
            `Not enough shed room for that swap — free ${plural(p.shedAfter - p.shedCap, "slot")} first.`);
          return;
        }
        if (!p.store && !p.place) {
          hud.showToast(p.missing
            ? `Already loaded — ${plural(p.missing, "item")} in it are no longer owned.`
            : "Your farm already matches this layout.");
          return;
        }
        const lines = [
          `${plural(p.store, "item")} go into the shed, ${plural(p.place, "item")} come out.`,
          p.keep ? `${p.keep} already in place stay put.` : "",
          p.missing ? `${plural(p.missing, "item")} you no longer own will be skipped.` : "",
          p.stuck ? `${plural(p.stuck, "building")} that can't be stored stay where they are.` : "",
        ].filter(Boolean);
        if (!await hud.confirmInGame(`Load "${layout.name}"?`, lines.join(" "), "Load")) return;
        busy = true;
        render();
        const message = await hooks.load(layout.id);
        busy = false;
        hud.showToast(message);
        render();
      };
      const over = document.createElement("button");
      over.className = "zbtn store";
      over.textContent = "Overwrite";
      over.title = "Replace this layout with the farm as it is now";
      over.disabled = busy;
      over.onclick = async () => {
        if (!await hud.confirmInGame(`Overwrite "${layout.name}"?`,
          "This replaces the saved layout with your farm as it is right now.", "Overwrite")) return;
        busy = true;
        render();
        const err = await hooks.save(layout.name, layout.id);
        busy = false;
        hud.showToast(err ?? `Saved "${layout.name}".`);
        render();
      };
      const del = document.createElement("button");
      del.className = "zbtn sell";
      del.textContent = "Delete";
      del.disabled = busy;
      del.onclick = async () => {
        if (!await hud.confirmInGame(`Delete "${layout.name}"?`,
          "The saved layout is removed. Nothing on your farm changes.", "Delete")) return;
        busy = true;
        render();
        await hooks.remove(layout.id);
        busy = false;
        render();
      };
      actions.append(load, over, del);
      row.append(info, actions);
      list.appendChild(row);
    }

    saveRow.replaceChildren();
    const full = layouts.length >= MAX_LAYOUTS;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "farm-layout-name";
    input.maxLength = LAYOUT_NAME_MAX;
    input.placeholder = full ? `${MAX_LAYOUTS} layouts saved — overwrite one` : "Layout name";
    input.disabled = full || busy;
    const save = document.createElement("button");
    save.className = "zbtn deploy";
    save.textContent = "Save Current";
    save.title = `Save the ${plural(hooks.placedCount(), "item")} on your farm now`;
    save.disabled = full || busy;
    const doSave = async () => {
      if (busy) return;
      busy = true;
      render();
      const err = await hooks.save(input.value || `Layout ${layouts.length + 1}`);
      busy = false;
      hud.showToast(err ?? "Layout saved.");
      render();
    };
    save.onclick = () => void doSave();
    input.onkeydown = (e) => { if (e.key === "Enter") void doSave(); };
    saveRow.append(input, save);
  };
  render();
  void hooks.sync().then((notice) => {
    busy = false;
    if (!panel.isConnected) return;
    if (notice) hud.showToast(notice);
    render();
  });
  void close;
}
