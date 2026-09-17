// The Storage panel (Items / Pets / Boosts / Received tabs) and its Received-tab
// reward cards. Uses the bespoke themed .st-bg / .st scaffold (not the shared
// Modal), preserved verbatim from the former Hud methods. Takes the Hud instance
// and renders into it.
import type { Hud } from "../../hud";
import { UI } from "../uiAsset";
import { BASE } from "../../base";
import { canSellPlaceable, objectTint } from "../../assets";
import type { ReceivedView } from "../hudTypes";
import { setTintedSrc } from "../tintedSprite";
import { storageBoostRows } from "../storageBoosts";
import { openShedAppearance } from "./shedAppearance";
import { keepScroll, recallOneOf, remember } from "../viewState";

const INSTA_PLOW_DELAY_MS = 500;

const TABS = ["Items", "Pets", "Boosts", "Received"];

// `initialTab` is a deliberate destination (the Boosts hotkey, the Pet Pen's
// "Pets"); opening Storage with no argument returns to the tab last used.
export function openStorage(hud: Hud, initialTab?: string, managePen = false): void {
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

  const cardOf = (key: string) => hud.objectCards.find((c) => c.def.key === key);

  let tab = initialTab && TABS.includes(initialTab)
    ? initialTab
    : recallOneOf("storage.tab", TABS, "Items");

  // Bulk-sell state for the Items tab. Held out here so it survives the tab's own
  // re-renders (a reward landing, a sale completing) — picking twenty slots and
  // then losing them to an unrelated repaint would be worse than no feature.
  // Deliberately NOT remembered in viewState: a pending selection is a half-made
  // decision, and reopening Storage should never find the shed pre-armed to sell.
  let picking = false;
  const picked = new Set<number>();
  const render = () => {
    body.innerHTML = "";
    remember("storage.tab", tab);
    if (tab === "Items") {
      const used = hud.state.storedItemTotal();
      count.textContent = `${used} / ${hud.state.storageItemCap} slots`;
      // One slot per stored copy (stacks repeated by count), padded to capacity.
      // Built before anything else on the tab: what the grid holds decides whether
      // a bulk sale is offered at all, and which slots a selection may cover.
      const flat: string[] = [];
      for (const it of hud.state.storedItems)
        for (let k = 0; k < it.count; k++) flat.push(it.key);
      // Only something that can actually be sold. A functional building — a
      // monolith, a Zombie Pot — is permanent, so its Sell button would do nothing
      // at all, and a button that does nothing reads as a broken game.
      const sellable = (key: string) => {
        const card = cardOf(key);
        return !!card && canSellPlaceable(card.def);
      };
      const sellableSlots = flat.flatMap((key, i) => (sellable(key) ? [i] : []));
      const canBulk = !!hud.onSellStoredItems && sellableSlots.length > 0;
      // The shed can move under a selection — a reward gets shelved, a sale lands,
      // a reconcile reorders the stacks — so every render drops slots that have
      // gone or are no longer sellable rather than carrying a stale index.
      if (!canBulk) picking = false;
      for (const i of [...picked]) if (!sellableSlots.includes(i)) picked.delete(i);

      const hint = document.createElement("div");
      hint.className = "st-hint";
      hint.textContent = picking
        ? "Tap items to select them, then sell the lot in one go."
        : used
          ? "Tap a stored item to place it back on the farm."
          : "Tap an item on the farm to store it, or drop it on the shed with the Move tool.";
      body.appendChild(hint);
      // The shed's own look. This tab IS the shed — tapping it on the farm opens
      // exactly here — and the other three tabs belong to the pen, the boosts and
      // gifts, so the button is scoped to this one. Hidden until an upgrade has
      // actually left an earlier look behind to go back to. Stood down mid-select:
      // that bar is about the sale, and a second panel over it is only a way to
      // lose the selection.
      const appearance = picking ? null : hud.getShedAppearance?.();
      if (appearance && appearance.options.length > 1) {
        const skinBtn = document.createElement("button");
        skinBtn.className = "st-use";
        skinBtn.textContent = "Shed Appearance";
        skinBtn.title = "Wear the look of any shed you've owned";
        skinBtn.onclick = () => openShedAppearance(hud, appearance, render);
        body.appendChild(skinBtn);
      }

      // The multi-select bar: the way in when idle, and the tally + actions while
      // picking. Sticky, because a shed of 72 slots scrolls well past it and a
      // selection you cannot act on without scrolling back is a trap.
      let updateBar = () => {};
      if (canBulk) {
        const bar = document.createElement("div");
        bar.className = "st-selbar";
        if (!picking) {
          const start = document.createElement("button");
          start.className = "st-use";
          start.textContent = "Sell Multiple";
          start.title = "Pick several stored items and sell them together";
          start.onclick = () => { picking = true; picked.clear(); render(); };
          bar.appendChild(start);
        } else {
          const tally = document.createElement("div");
          tally.className = "st-seltally";
          const all = document.createElement("button");
          all.className = "st-use st-quiet";
          const sell = document.createElement("button");
          sell.className = "st-use st-sell";
          const cancel = document.createElement("button");
          cancel.className = "st-use st-quiet";
          cancel.textContent = "Cancel";
          cancel.onclick = () => { picking = false; picked.clear(); render(); };

          // Tap to tap, the bar is refreshed in place rather than re-rendering the
          // grid: repainting 72 tinted thumbnails per tap flickers and fights the
          // remembered scroll position.
          updateBar = () => {
            const keys = [...picked].map((i) => flat[i]);
            const gold = keys.length ? hud.getStoredSellTotal?.(keys) ?? 0 : 0;
            tally.innerHTML = keys.length
              ? `${keys.length} selected <span class="g">+${gold.toLocaleString()}g</span>`
              : "Nothing selected";
            const every = picked.size >= sellableSlots.length;
            all.textContent = every ? "Clear" : "Select All";
            all.title = every ? "Unselect everything" : "Select every item that can be sold";
            sell.textContent = keys.length ? `Sell ${keys.length}` : "Sell";
            sell.disabled = !keys.length;
          };
          all.onclick = () => {
            const every = picked.size >= sellableSlots.length;
            picked.clear();
            if (!every) for (const i of sellableSlots) picked.add(i);
            render(); // every slot's tick changes — cheaper to rebuild the grid once
          };
          sell.onclick = async () => {
            const keys = [...picked].map((i) => flat[i]);
            if (!keys.length) return;
            sell.disabled = true; // no second submission while the dialog is up
            const gold = await hud.onSellStoredItems?.(keys);
            // Backing out of the confirm leaves the selection exactly as it was, so
            // a mis-tap on Sell costs nothing; a completed sale ends the mode.
            if (gold !== null && gold !== undefined) { picking = false; picked.clear(); }
            render();
          };
          bar.append(tally, all, sell, cancel);
        }
        body.appendChild(bar);
      }

      const grid = document.createElement("div");
      grid.className = "st-grid";
      for (let i = 0; i < hud.state.storageItemCap; i++) {
        const slot = document.createElement("div");
        slot.className = "st-slot";
        const key = flat[i];
        if (key) {
          const img = document.createElement("img");
          // Greyscale art (a Hedge, a Crate) and every recolour take their colour
          // from the def's tint, so an untinted thumbnail is the wrong item.
          const card = cardOf(key);
          if (card) setTintedSrc(img, card.portrait, objectTint(card.def.color));
          slot.appendChild(img);
          slot.classList.add("filled");
          if (picking && sellable(key)) {
            const tick = document.createElement("span");
            tick.className = "st-tick";
            const paint = () => {
              const on = picked.has(i);
              slot.classList.toggle("picked", on);
              tick.textContent = on ? "\u2713" : "";
              slot.title = on
                ? `${card?.def.name ?? "Selected"} \u2014 tap to unselect`
                : `Select ${card?.def.name ?? "this item"} to sell`;
            };
            slot.appendChild(tick);
            paint();
            slot.onclick = () => {
              if (picked.has(i)) picked.delete(i);
              else picked.add(i);
              paint();
              updateBar();
            };
          } else if (picking) {
            // Still shown, just out of the sale: hiding it would make the grid lie
            // about what the shed is holding.
            slot.classList.add("unpickable");
            slot.title = `${card?.def.name ?? "This item"} can't be sold.`;
          } else {
            slot.title = "Place on farm";
            slot.onclick = () => {
              bg.remove();
              hud.onRetrieveItem?.(key);
            };
            if (sellable(key)) {
              const sell = document.createElement("button");
              sell.className = "st-slot-sell";
              sell.textContent = "Sell";
              sell.title = "Sell from storage";
              sell.onclick = async (event) => {
                event.stopPropagation();
                if (await hud.onSellStoredItem?.(key)) render();
              };
              slot.appendChild(sell);
            }
          }
        }
        grid.appendChild(slot);
      }
      body.appendChild(grid);
      updateBar();
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
      const rows = storageBoostRows(hud.boosts, hud.state.boostInv);
      if (!rows.length) {
        const e = document.createElement("div");
        e.className = "st-empty";
        e.textContent = "No boosts are available.";
        body.appendChild(e);
      } else {
        const list = document.createElement("div");
        list.className = "st-boostlist";
        for (const { def, count: owned } of rows) {
          const row = document.createElement("div");
          row.className = "st-boost" + (owned ? "" : " unowned");
          const img = document.createElement("img");
          img.src = `${BASE}assets/boosts/${def.icon}`;
          const info = document.createElement("div");
          info.className = "st-boost-info";
          info.innerHTML =
            `<div class="nm">${def.name} <span class="ct">x${owned}</span></div>` +
            `<div class="ds">${def.info || def.flavorText}</div>`;
          const btn = document.createElement("button");
          btn.className = "st-use";
          if (!owned) {
            btn.textContent = "Buy";
            btn.onclick = () => { bg.remove(); hud.openMarket("Boosts"); };
          } else if (def.effect === "grow") {
            // Insta-Grow is a manual tool, not an auto-apply: equip it so the
            // player taps each crop to ripen (rather than auto-growing nearby ones).
            btn.textContent = "Equip";
            btn.onclick = () => { bg.remove(); hud.setMode("instagrow"); };
          } else if (def.usableOnFarm) {
            btn.textContent = "Use";
            const usable = hud.canUseBoost?.(def) ?? true;
            btn.disabled = !usable;
            if (!usable && def.effect === "plow") btn.title = "There are no unplowed dirt tiles.";
            btn.onclick = () => {
              if (!(hud.canUseBoost?.(def) ?? true)) return;
              if (def.effect === "plow") {
                // Reveal the farm first, then plow every eligible tile together.
                bg.remove();
                window.setTimeout(() => hud.onUseBoost?.(def), INSTA_PLOW_DELAY_MS);
                return;
              }
              hud.onUseBoost?.(def);
              render();
            };
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
        hint.textContent = "Claim rewards, move zombies into the Mausoleum, place decorations, or sell decorations.";
        body.appendChild(hint);
        const grid = document.createElement("div");
        grid.className = "rcv-grid";
        for (const v of views) grid.appendChild(receivedCard(hud, v, bg, render));
        body.appendChild(grid);
      }
    }
    // Each tab keeps its own place, so selling from a long Items grid or claiming a
    // reward re-renders where the player was rather than at the top.
    keepScroll(body, `storage.scroll.${tab}`);
  };

  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const name of ["Items", "Pets", "Boosts", "Received"]) {
    const b = document.createElement("button");
    b.className = "st-tab" + (name === tab ? " sel" : "");
    b.textContent = name;
    b.onclick = () => {
      hud.audio.play("menuClick");
      // Switching tabs abandons a bulk selection: it is scoped to the Items grid,
      // and coming back to a shed still armed to sell would be a nasty surprise.
      if (name !== tab) { picking = false; picked.clear(); }
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
    setTintedSrc(img, v.icon, v.tint);
    por.appendChild(img);
  }
  const nm = document.createElement("div");
  nm.className = "rcv-nm";
  nm.textContent = v.name;
  card.append(por, nm);
  if (v.actionLabel) {
    const actions = document.createElement("div");
    actions.className = "rcv-actions";
    const btn = document.createElement("button");
    btn.className = "st-use rcv-act";
    btn.textContent = v.actionLabel;
    if (v.kind === "placeable") {
      btn.onclick = () => { bg.remove(); hud.onPlaceReceived?.(v.index); };
    } else {
      btn.onclick = () => { hud.onClaimReceived?.(v.index); rerender(); };
    }
    actions.appendChild(btn);
    // Straight to the shed, skipping the farm. A decoration you have no room (or no
    // plan) for used to have to be placed somewhere and then stored from the object
    // sheet — two steps and a spot you did not want it in. Only offered where the
    // shed can actually take it, so it never turns into a dead button.
    if (v.kind === "placeable" && v.storable) {
      const store = document.createElement("button");
      store.className = "st-use rcv-act";
      store.textContent = "Store";
      store.title = "Put it straight into the shed";
      store.onclick = async () => {
        if (await hud.onStoreReceived?.(v.index)) rerender();
      };
      actions.appendChild(store);
    }
    if (v.sellable) {
      const sell = document.createElement("button");
      sell.className = "st-use st-sell rcv-act";
      sell.textContent = "Sell";
      sell.onclick = async () => {
        if (await hud.onSellReceived?.(v.index)) rerender();
      };
      actions.appendChild(sell);
    }
    card.appendChild(actions);
  } else {
    const tag = document.createElement("div");
    tag.className = "rcv-trophy";
    tag.textContent = "Trophy";
    card.appendChild(tag);
  }
  return card;
}
