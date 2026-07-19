// The Storage panel (Items / Pets / Boosts / Received tabs) and its Received-tab
// reward cards. Uses the bespoke themed .st-bg / .st scaffold (not the shared
// Modal), preserved verbatim from the former Hud methods. Takes the Hud instance
// and renders into it.
import type { Hud } from "../../hud";
import { UI } from "../uiAsset";
import { BASE } from "../../base";
import type { ReceivedView } from "../hudTypes";

export function openStorage(hud: Hud, initialTab: string = "Items", managePen = false): void {
  document.querySelector("#hud .st-bg")?.remove();
  const bg = document.createElement("div");
  bg.className = "st-bg";
  const st = document.createElement("div");
  st.className = "st";

  const close = document.createElement("button");
  close.className = "st-close";
  const ci = document.createElement("img");
  ci.src = UI("button_close.png");
  close.appendChild(ci);
  close.onclick = () => bg.remove();

  const header = document.createElement("div");
  header.className = "st-header";
  const fl = document.createElement("img");
  fl.className = "flank";
  fl.src = BASE + "assets/ui/storage/board_items_left.png";
  const banner = document.createElement("div");
  banner.className = "st-banner";
  banner.textContent = "Storage";
  const fr = document.createElement("img");
  fr.className = "flank";
  fr.src = BASE + "assets/ui/storage/board_item_right.png";
  header.append(fl, banner, fr);

  const tabsEl = document.createElement("div");
  tabsEl.className = "st-tabs";
  const count = document.createElement("div");
  count.className = "st-count";
  const body = document.createElement("div");
  body.className = "st-body";

  const portraitOf = (key: string) =>
    hud.objectCards.find((c) => c.def.key === key)?.portrait;

  let tab = ["Items", "Pets", "Boosts", "Received"].includes(initialTab) ? initialTab : "Items";
  const render = () => {
    body.innerHTML = "";
    body.scrollTop = 0;
    if (tab === "Items") {
      const used = hud.state.storedItemTotal();
      count.textContent = `${used} / ${hud.state.storageItemCap} slots`;
      const hint = document.createElement("div");
      hint.className = "st-hint";
      hint.textContent = used
        ? "Tap a stored item to place it back on the farm."
        : "Store decorations by tapping them on the farm.";
      body.appendChild(hint);
      const grid = document.createElement("div");
      grid.className = "st-grid";
      // One slot per stored stack (repeated by count), padded to capacity.
      const flat: string[] = [];
      for (const it of hud.state.storedItems)
        for (let k = 0; k < it.count; k++) flat.push(it.key);
      for (let i = 0; i < hud.state.storageItemCap; i++) {
        const slot = document.createElement("div");
        slot.className = "st-slot";
        const key = flat[i];
        if (key) {
          const img = document.createElement("img");
          const p = portraitOf(key);
          if (p) img.src = p;
          slot.appendChild(img);
          slot.classList.add("filled");
          slot.title = "Place on farm";
          slot.onclick = () => {
            bg.remove();
            hud.onRetrieveItem?.(key);
          };
        }
        grid.appendChild(slot);
      }
      body.appendChild(grid);
    } else if (tab === "Pets") {
      count.textContent = managePen
        ? `${hud.state.penPets.length} / 4 in pen`
        : `${hud.state.ownedPets.length} pet${hud.state.ownedPets.length === 1 ? "" : "s"}`;
      const hint = document.createElement("div");
      hint.className = "st-hint";
      hint.textContent = hud.state.ownedPets.length
        ? managePen
          ? "Choose up to four pets to wander inside this pen."
          : "Tap a pet to make it your active companion."
        : "Adopt pets from the Market's Pets tab.";
      body.appendChild(hint);
      if (!managePen && hud.state.activePet) {
        const hide = document.createElement("button");
        hide.className = "st-use";
        hide.textContent = "Hide Active Pet";
        hide.onclick = () => { hud.onEquipPet?.(null); render(); };
        body.appendChild(hide);
      }
      const grid = document.createElement("div");
      grid.className = "st-grid";
      for (const key of hud.state.ownedPets) {
        const pet = hud.pets.pets.find((candidate) => candidate.key === key);
        if (!pet) continue;
        const slot = document.createElement("button");
        const selected = managePen ? hud.state.penPets.includes(key) : hud.state.activePet === key;
        slot.className = "st-slot st-petslot" + (selected ? " filled" : "");
        slot.title = managePen
          ? selected ? `Remove ${pet.name} from pen` : `Deploy ${pet.name} in pen`
          : selected ? `${pet.name} (active)` : `Activate ${pet.name}`;
        const img = document.createElement("img");
        img.src = `${BASE}assets/pets/${pet.portrait}`;
        img.alt = pet.name;
        slot.appendChild(img);
        slot.onclick = () => {
          if (managePen) {
            const next = selected
              ? hud.state.penPets.filter((candidate) => candidate !== key)
              : hud.state.penPets.length < 4 ? [...hud.state.penPets, key] : null;
            if (!next) return;
            hud.onSetPenPets?.(next.flatMap((petKey) => {
              const found = hud.pets.pets.find((candidate) => candidate.key === petKey);
              return found ? [found] : [];
            }));
          } else hud.onEquipPet?.(pet);
          render();
        };
        grid.appendChild(slot);
      }
      body.appendChild(grid);
    } else if (tab === "Boosts") {
      const total = hud.state.boostInv.reduce((a, b) => a + b.count, 0);
      count.textContent = `${total} boosts`;
      if (!total) {
        const e = document.createElement("div");
        e.className = "st-empty";
        e.textContent = "Buy boosts from the Market's Boosts tab.";
        body.appendChild(e);
      } else {
        const list = document.createElement("div");
        list.className = "st-boostlist";
        for (const inv of hud.state.boostInv) {
          const def = hud.boosts.find((b) => b.key === inv.key);
          if (!def) continue;
          const row = document.createElement("div");
          row.className = "st-boost";
          const img = document.createElement("img");
          img.src = `${BASE}assets/boosts/${def.icon}`;
          const info = document.createElement("div");
          info.className = "st-boost-info";
          info.innerHTML =
            `<div class="nm">${def.name} <span class="ct">x${inv.count}</span></div>` +
            `<div class="ds">${def.info || def.flavorText}</div>`;
          const btn = document.createElement("button");
          btn.className = "st-use";
          if (def.effect === "grow") {
            // Insta-Grow is a manual tool, not an auto-apply: equip it so the
            // player taps each crop to ripen (rather than auto-growing nearby ones).
            btn.textContent = "Equip";
            btn.onclick = () => { bg.remove(); hud.setMode("instagrow"); };
          } else if (def.usableOnFarm) {
            btn.textContent = "Use";
            btn.onclick = () => { hud.onUseBoost?.(def); render(); };
          } else {
            // Battle boosts (Invasion Voucher / Concentration / Golden Dice) are all
            // chosen on the Invade screens, not from Storage — so just label them.
            btn.textContent = "At Invade";
            btn.disabled = true;
          }
          row.append(img, info, btn);
          list.appendChild(row);
        }
        body.appendChild(list);
      }
    } else {
      const views = hud.getReceived?.() ?? [];
      count.textContent = `${views.length} item${views.length === 1 ? "" : "s"}`;
      if (!views.length) {
        const e = document.createElement("div");
        e.className = "st-empty";
        e.textContent = "Rewards from raids and quests appear here.";
        body.appendChild(e);
      } else {
        const hint = document.createElement("div");
        hint.className = "st-hint";
        hint.textContent = "Claim rewards, or place decorations on your farm.";
        body.appendChild(hint);
        const grid = document.createElement("div");
        grid.className = "rcv-grid";
        for (const v of views) grid.appendChild(receivedCard(hud, v, bg, render));
        body.appendChild(grid);
      }
    }
  };

  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const name of ["Items", "Pets", "Boosts", "Received"]) {
    const b = document.createElement("button");
    b.className = "st-tab" + (name === tab ? " sel" : "");
    b.textContent = name;
    b.onclick = () => {
      hud.audio.play("menuClick");
      tab = name;
      Object.values(tabBtns).forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      render();
    };
    tabBtns[name] = b;
    tabsEl.appendChild(b);
  }

  st.append(close, header, tabsEl, count, body);
  bg.appendChild(st);
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  hud.el.appendChild(bg);
  render();
}

// Build one Received-tab reward card. Placeables enter placement (closing the
// panel); boosts/currency claim in place (re-rendering the tab); trophies —
// loot decor with no placeable form in this build — are display-only.
function receivedCard(hud: Hud, v: ReceivedView, bg: HTMLElement, rerender: () => void): HTMLElement {
  const card = document.createElement("div");
  card.className = "rcv-card" + (v.actionLabel ? "" : " trophy");
  const por = document.createElement("div");
  por.className = "rcv-por";
  if (v.icon) {
    const img = document.createElement("img");
    img.src = v.icon;
    por.appendChild(img);
  }
  const nm = document.createElement("div");
  nm.className = "rcv-nm";
  nm.textContent = v.name;
  card.append(por, nm);
  if (v.actionLabel) {
    const btn = document.createElement("button");
    btn.className = "st-use rcv-act";
    btn.textContent = v.actionLabel;
    if (v.kind === "placeable") {
      btn.onclick = () => { bg.remove(); hud.onPlaceReceived?.(v.index); };
    } else {
      btn.onclick = () => { hud.onClaimReceived?.(v.index); rerender(); };
    }
    card.appendChild(btn);
  } else {
    const tag = document.createElement("div");
    tag.className = "rcv-trophy";
    tag.textContent = "Trophy";
    card.appendChild(tag);
  }
  return card;
}
