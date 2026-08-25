// The Zombies menu (right bar) and the zombie inspect-card cluster, extracted
// from the Hud class: these functions take the Hud instance and render into it,
// exactly as the former methods did. The menu now has two tabs:
//   • My Zombies — the owned roster, every unit as its full inspect card.
//   • Zombie Almanac — the collection: one entry per obtainable species, shown
//     as a silhouette until one has been obtained (any acquisition counts).
// The inspect-card builders are also used by the Mausoleum grid and the Black
// Market listing views, which stay in hud.ts and import them from here.
import type { Hud } from "../../hud";
import { markPrimary, openModal } from "../Modal";
import { onFirstVisible } from "../onFirstVisible";
import type { AlmanacEntryView, MenuCard, ZombieInfo } from "../hudTypes";
import { zombieSellValue } from "../../economy";
import { BLACK_MARKET_MIN_LEVEL } from "../../blackMarketRules";
import { MAX_ZOMBIE_NAME_LENGTH, RosterEntry } from "../../zombie/types";
import { mutationBonus } from "../../zombie/mutations";
import {
  STATS, veterancy, STAT_TILE, VALUE_FILL, VALUE_END, ABILITY_FRAME, MUTATION_FRAME,
  ABILITY_POOL, unitAbilityAt, TIER_BOSS, MAX_ABILITY_TIER,
} from "../../zombie/traits";
import { mutationEntries, mutationTipText } from "../../zombie/mutationDisplay";
import {
  isMutationHidden, pruneMutationVisibility, setMutationHidden, visibleMutations,
} from "../../zombie/mutationVisibility";
import { statBreakdown } from "../../zombie/statDisplay";
import { classTierRank } from "../../zombie/taxonomy";
import type { AlmanacGuideTopic } from "../../zombie/almanacGuide";
import { statEffectText, type MutationAlmanacEntry } from "../../zombie/mutationAlmanac";
import { SLOTS } from "../../zombie/mutations";
import { ZOMBIE_SORTS, isZombieSort, sortZombies, type ZombieSort } from "../../zombie/rosterSort";
import { getZombieSort, setZombieSort } from "../../prefs";
import { keepScroll, recallOneOf, remember } from "../viewState";

// A closeable modal: the zombie's trading-card (portrait, name board, veterancy /
// type / invasions) on the LEFT, and its stats (icon row) over abilities (icon
// row) on the RIGHT. Tapping a stat or ability icon shows a small tooltip that
// any further interaction dismisses.
/** Build the inspect "card" (trading card + stats + abilities) for one zombie.
 *  Stat/ability tooltips attach to the modal backdrop so a scrolling panel
 *  cannot clip them. Shared by the single-zombie modal and the Zombies list. */
export function buildZombieCard(hud: Hud, info: ZombieInfo, host: HTMLElement): HTMLElement {
  // --- tooltip: one small popup at a time; any interaction dismisses it ---
  let tip: HTMLElement | null = null;
  const closeTip = () => { tip?.remove(); tip = null; };
  const showTip = (anchor: HTMLElement, title: string, body: string) => {
    closeTip();
    tip = document.createElement("div");
    tip.className = "ztip";
    tip.innerHTML = `<b>${title}</b><span>${body}</span>`;
    // On compact layouts the panel itself scrolls. Put the popup beside the
    // panel in its full-viewport backdrop so it can extend beyond the card.
    const portal = host.parentElement ?? host;
    portal.appendChild(tip);
    const ar = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const edge = 8;
    const gap = 8;
    const halfWidth = tr.width / 2;
    const anchorCenter = ar.left + ar.width / 2;
    const left = Math.min(
      window.innerWidth - edge - halfWidth,
      Math.max(edge + halfWidth, anchorCenter)
    );
    tip.style.left = `${left}px`;

    // Prefer the familiar above-anchor position, but flip below when needed.
    // If neither side alone is tall enough, detach just enough from the anchor
    // to keep the whole popup inside the viewport.
    const roomAbove = ar.top - gap - edge;
    const roomBelow = window.innerHeight - ar.bottom - gap - edge;
    const below = roomAbove < tr.height;
    tip.classList.toggle("below", below);
    if (!below) {
      tip.style.top = `${ar.top - gap}px`;
    } else if (roomBelow >= tr.height) {
      tip.style.top = `${ar.bottom + gap}px`;
    } else {
      tip.style.top = `${Math.max(edge, window.innerHeight - edge - tr.height)}px`;
    }
    // The NEXT pointer-down anywhere closes it (this click's down already fired).
    document.addEventListener("pointerdown", closeTip, { capture: true, once: true });
  };

  const wrap = document.createElement("div");
  wrap.className = "zdetail";

  // ---- LEFT: the card ----
  const card = document.createElement("div");
  card.className = "zcard";
  const nailL = document.createElement("span");
  nailL.className = "zcard-nail tl";
  const nailR = document.createElement("span");
  nailR.className = "zcard-nail tr";
  const board = document.createElement("div");
  board.className = "zcard-board";
  board.textContent = info.name;
  card.append(nailL, nailR, board);
  if (info.id && hud.onZombieRename) {
    board.classList.add("renameable");
    board.title = "Click to rename";
    board.tabIndex = 0;
    const edit = () => {
      if (!board.isConnected) return;
      const input = document.createElement("input");
      input.className = "zcard-name-input";
      input.value = info.name;
      input.maxLength = MAX_ZOMBIE_NAME_LENGTH;
      board.replaceWith(input);
      let active = true;
      const cancel = () => {
        if (!active) return;
        active = false;
        input.replaceWith(board);
      };
      const commit = () => {
        if (!active) return;
        active = false;
        const renamed = hud.onZombieRename?.(info.id!, input.value);
        if (renamed) info.name = renamed;
        board.textContent = info.name;
        input.replaceWith(board);
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        else if (event.key === "Escape") { event.preventDefault(); cancel(); }
      };
      input.onblur = commit;
      input.focus();
      input.select();
    };
    board.onclick = edit;
    board.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); edit(); }
    };
  }
  const port = document.createElement("div");
  port.className = "zcard-port";
  port.style.backgroundImage = `url(${info.portrait})`;
  // Use the static catalog portrait immediately, then replace it with the cached
  // individual rig once its mutation-aware render is available. Drawn with the
  // mutations this zombie's own toggles leave visible, so the picture answers the
  // toggles directly.
  const paintPortrait = () => {
    void hud.zombieMutationPortraitOf?.(
      info.key, visibleMutations(info.id, info.mutation), info.color, () => port.isConnected,
    )
      .then((portrait) => {
        if (port.isConnected) port.style.backgroundImage = `url(${portrait})`;
      })
      .catch(() => { /* retain the static species portrait if extraction fails */ });
  };
  // Deferred until on screen — "My Zombies" stacks one of these cards per owned unit.
  if (hud.zombieMutationPortraitOf) onFirstVisible(port, paintPortrait);
  const meta = document.createElement("div");
  meta.className = "zcard-meta";
  meta.innerHTML =
    `<div class="zvet">${veterancy(info.invasions)}</div>` +
    `<div class="ztype">${info.typeName}</div>` +
    `<div class="zinv">Invasions: ${info.invasions}</div>`;
  card.append(port, meta);

  // ---- RIGHT: stats (top) + abilities (bottom), both horizontal ----
  const right = document.createElement("div");
  right.className = "zright";

  const statsHdr = document.createElement("div");
  statsHdr.className = "zsec-h";
  statsHdr.textContent = "Stats";
  const statsRow = document.createElement("div");
  statsRow.className = "zrow zstats";
  // Each tile shows the stat's 0–100 bar with EVERY always-on bonus folded in
  // (mutation + veterancy + the zombie's own passive stat abilities); hovering opens
  // the per-modifier breakdown. See zombie/statDisplay.statBreakdown.
  const abilityUnlocked = (k: string) => hud.state.abilityUnlocked(k);
  // Which stats a mutation is boosting — those tiles render green (permanent species bonus).
  const mutBonus = mutationBonus(info.mutation);
  for (const s of STATS) {
    const bd = statBreakdown(info, s.key, abilityUnlocked);
    const boosted = ((mutBonus as Record<string, number>)[s.key] ?? 0) > 0;
    const cell = document.createElement("button");
    cell.className = "zstat";
    cell.innerHTML =
      `<span class="zstat-tile" style="background-image:url(${STAT_TILE})">` +
      `<img src="${s.icon}" alt=""></span>` +
      `<span class="zstat-val${boosted ? " boosted" : ""}" style="background-image:url(${VALUE_END}),url(${VALUE_FILL})">` +
      `${bd.total}</span>`;
    cell.onclick = (e) => {
      e.stopPropagation();
      // desc, then Base → each modifier (dim if +0) → Total, as aligned rows.
      const rows = [`<span class="zbd-row"><span>Base</span><span>${bd.base}</span></span>`]
        .concat(
          bd.lines.map(
            (l) =>
              `<span class="zbd-row${l.zero ? " zbd-zero" : ""}"><span>${l.label}</span><span>${l.amount}</span></span>`
          )
        )
        .concat(`<span class="zbd-row zbd-total"><span>Total</span><span>${bd.total}</span></span>`)
        .join("");
      showTip(cell, s.label, `${s.desc}<span class="zbd">${rows}</span>`);
    };
    statsRow.appendChild(cell);
  }

  // ---- mutations: one framed icon per mutation this zombie carries ----
  // Only the boosted (green) stat tiles used to hint at these, which never said WHICH
  // mutations they were — the thing you need before pairing the zombie in the Pot.
  // Unmutated zombies (most of them) show no section at all rather than an empty row.
  const mutations = mutationEntries(info);
  const mutHdr = document.createElement("div");
  mutHdr.className = "zsec-h";
  mutHdr.textContent = mutations.length > 1 ? `Mutations (${mutations.length}/5)` : "Mutation";
  const mutRow = document.createElement("div");
  mutRow.className = "zrow zmuts";
  // An owned zombie can also be told which of its mutations to WEAR. The eye badge
  // on each tile hides that one vegetable on this zombie alone — the mask, and so
  // every stat and every slot it occupies, is untouched. Cards without an id (a
  // Market preview, an Almanac entry) have no unit to remember a choice against,
  // so they show the row without badges.
  const canHide = Boolean(info.id);
  for (const mutation of mutations) {
    const slot = document.createElement("div");
    slot.className = "zmut-slot";
    const cell = document.createElement("button");
    cell.className = "zmut";
    cell.style.backgroundImage = `url(${MUTATION_FRAME})`;
    cell.title = mutation.name; // the name is a tap away, like the stat/ability tiles
    cell.innerHTML = `<img src="${mutation.icon}" alt="${mutation.name}">`;
    cell.onclick = (e) => {
      e.stopPropagation();
      showTip(cell, mutation.name, mutationTipText(mutation));
    };
    slot.appendChild(cell);
    if (canHide) {
      const eye = document.createElement("button");
      eye.className = "zmut-vis";
      const paint = () => {
        const hidden = isMutationHidden(info.id, mutation.bit);
        cell.classList.toggle("mut-off", hidden);
        eye.classList.toggle("off", hidden);
        eye.textContent = hidden ? "🚫" : "👁";
        eye.setAttribute("aria-pressed", String(!hidden));
        eye.title = hidden
          ? `Show ${mutation.name} on ${info.name}`
          : `Hide ${mutation.name} on ${info.name}`;
        eye.setAttribute("aria-label", eye.title);
      };
      paint();
      eye.onclick = (e) => {
        e.stopPropagation();
        setMutationHidden(info.id!, mutation.bit, !isMutationHidden(info.id, mutation.bit));
        paint();
        // The card's own picture answers immediately; the farm rig (and the Army
        // screen behind it) is reassembled by the host.
        if (hud.zombieMutationPortraitOf) paintPortrait();
        hud.onZombieAppearanceChanged?.(info.id!);
      };
      slot.appendChild(eye);
    }
    mutRow.appendChild(slot);
  }

  const abilHdr = document.createElement("div");
  abilHdr.className = "zsec-h";
  abilHdr.textContent = "Abilities";
  const abilRow = document.createElement("div");
  abilRow.className = "zrow zabils";
  // A zombie shows its GROUP's one ability per tier, for tiers 1..(colour-class
  // rank): Green=t1, Blue=t1-2, Red=t1-3, Silver+ = t1-4 (so never more than 4).
  // An ability that's been unlocked shows the real icon; still-locked ones show a
  // padlock naming the boss. Some groups (Small) have no ability at low tiers, so
  // their abilities only appear on higher-class units.
  const rank = Math.min(MAX_ABILITY_TIER, classTierRank(info.className));
  for (let t = 1; t <= rank; t++) {
    const key = unitAbilityAt(info.key, info.group, t);
    if (!key) continue; // no ability at this tier for this unit
    const meta = ABILITY_POOL[key];
    if (!meta) continue;
    const cell = document.createElement("button");
    cell.style.backgroundImage = `url(${ABILITY_FRAME})`;
    if (hud.state.abilityUnlocked(key)) {
      cell.className = "zabil";
      cell.innerHTML = `<img src="${meta.icon}" alt="">`;
      cell.onclick = (e) => {
        e.stopPropagation();
        // Skip the effect line when it just repeats the name (stat buffs).
        const body = meta.effect && meta.effect !== meta.label
          ? `<span class="zeff">${meta.effect}</span> ${meta.desc}`
          : meta.desc;
        showTip(cell, meta.label, body);
      };
    } else {
      cell.className = "zabil locked";
      cell.innerHTML = `<span class="zlock">🔒</span>`;
      const boss = TIER_BOSS[t];
      cell.onclick = (e) => {
        e.stopPropagation();
        showTip(cell, meta.label, `Defeat ${boss} to unlock this ability.`);
      };
    }
    abilRow.appendChild(cell);
  }
  if (!abilRow.childElementCount) {
    const none = document.createElement("div");
    none.className = "zabil-none";
    none.textContent = "No abilities at this rank.";
    abilRow.appendChild(none);
  }

  right.append(statsHdr, statsRow);
  if (mutations.length) right.append(mutHdr, mutRow);
  right.append(abilHdr, abilRow);
  wrap.append(card, right);
  return wrap;
}

export function openZombieInfo(hud: Hud, info: ZombieInfo, refresh?: () => void) {
  const { panel, close } = openModal({ host: hud.el, panelClass: "zpanel" });

  const wrap = buildZombieCard(hud, info, panel);
  panel.append(wrap);
  if (info.id) panel.appendChild(buildZombieActions(hud, info, close, refresh));
}

function buildZombieActions(hud: Hud, info: ZombieInfo, close: () => void, refresh?: () => void): HTMLElement {
  const btns = document.createElement("div");
  btns.className = "zbtns";
  const mk = (label: string, cls: string, enabled: boolean, fn: () => void | Promise<void>, reopen = true) => {
    const button = document.createElement("button");
    button.className = `zbtn ${cls}`;
    button.textContent = label;
    button.disabled = !enabled;
    button.onclick = async () => {
      button.disabled = true;
      close();
      await fn();
      if (reopen) refresh?.();
    };
    return button;
  };
  if (info.stored) {
    const canDeploy = hud.canDeployZombie ? hud.canDeployZombie() : true;
    btns.appendChild(mk(canDeploy ? "Deploy to farm" : "Farm full", "deploy", canDeploy,
      () => hud.onZombieDeploy?.(info.id!)));
  } else {
    const canStore = hud.canStoreZombies ? hud.canStoreZombies() : true;
    btns.appendChild(mk("Locate", "locate", true, () => hud.onZombieLocate?.(info.id!), false));
    btns.appendChild(mk(canStore ? "Store" : "Need Mausoleum", "store", canStore,
      () => hud.onZombieStore?.(info.id!)));
  }
  const value = zombieSellValue(
    hud.zombieBaseCost?.(info.key) ?? 0,
    hud.zombieCostsBrains?.(info.key) ?? false
  );
  const sell = document.createElement("button");
  sell.className = "zbtn sell";
  sell.textContent = "Sell";
  sell.onclick = () => {
    close();
    openZombieSellChoices(hud, info, value, refresh);
  };
  btns.appendChild(sell);
  return btns;
}

function openZombieSellChoices(hud: Hud, info: ZombieInfo, value: number, refresh?: () => void) {
  if (!hud.socialOnline?.()) { confirmSellZombie(hud, info, value, refresh); return; }
  // The market's level floor is enforced by the Worker on every post, so a farm below
  // it can only sell for gold — skip straight to that rather than offering a choice
  // the server would refuse.
  if ((hud.getPlayerLevel?.() ?? 0) < BLACK_MARKET_MIN_LEVEL) {
    confirmSellZombie(hud, info, value, refresh);
    return;
  }
  const { panel, close } = openModal({ host: hud.el, panelClass: "confirm-panel", title: "Sell this zombie" });
  const message = document.createElement("p");
  message.className = "confirm-msg";
  message.textContent = "Sell immediately for gold, or create a Black Market post for brains.";
  const actions = document.createElement("div");
  actions.className = "zbtns";
  const gold = document.createElement("button");
  gold.className = "zbtn sell";
  gold.textContent = `Sell now +${value}g`;
  gold.onclick = () => { close(); confirmSellZombie(hud, info, value, refresh); };
  const market = document.createElement("button");
  market.className = "zbtn deploy";
  market.textContent = "Sell on Black Market";
  market.onclick = () => { close(); hud.openBlackMarket("SELL_ZOMBIE", info.id); };
  actions.append(gold, market);
  panel.append(message, actions);
}

// Confirmation window for selling a zombie. Names the unit, shows the gold it
// fetches, and warns that the sale is permanent — so a valuable zombie is not
// sold by a single stray tap. Confirm sells; Cancel backs out to the roster.
function confirmSellZombie(hud: Hud, info: ZombieInfo, value: number, refresh?: () => void) {
  const { panel, close } = openModal({ host: hud.el, panelClass: "confirm-panel", title: "Sell this zombie?" });

  const por = document.createElement("div");
  por.className = "obj-por";
  if (info.portrait) por.style.backgroundImage = `url(${info.portrait})`;
  const msg = document.createElement("p");
  msg.className = "confirm-msg";
  msg.append("Sell ");
  const zombieName = document.createElement("b"); zombieName.textContent = info.name;
  const valueText = document.createElement("b"); valueText.textContent = `+${value}g`;
  msg.append(zombieName, ` (${info.typeName}) for `, valueText, "?", document.createElement("br"));
  const warning = document.createElement("span");
  warning.className = "confirm-warn";
  warning.textContent = "This is permanent — the zombie is gone for good.";
  msg.appendChild(warning);

  const btns = document.createElement("div");
  btns.className = "zbtns";
  const cancel = document.createElement("button");
  cancel.className = "zbtn locate";
  cancel.textContent = "Cancel";
  cancel.onclick = () => close();
  const confirm = document.createElement("button");
  confirm.className = "zbtn sell";
  confirm.textContent = `Sell +${value}g`;
  markPrimary(confirm); // Enter confirms this already-explicit sale
  confirm.onclick = async () => {
    confirm.disabled = true;
    close();
    await hud.onZombieSell?.(info.id!);
    refresh?.();
  };
  btns.append(cancel, confirm);

  panel.append(por, msg, btns);
}

/** Preview the inspect card for a catalog species the player does not own yet —
 *  opened by the magnifier on a Market or plant-menu gravestone so its stats and
 *  abilities can be read BEFORE buying. Same card the roster and Black Market
 *  listings use, built from catalog data: no veterancy (nothing has fought yet),
 *  and any guaranteed catalog mutation folded in exactly as the unit dug up will
 *  carry it. Stats include the player's own farmer bonuses, matching the Black
 *  Market's inspect — the numbers are what THIS farm would field.
 *
 *  Only the mutation blurb is printed under the card. Price, grow time and the
 *  unlock gate are on the gravestone the magnifier was tapped on, and repeating
 *  them here just made the card end in things the player had already read. */
export function openCatalogZombieCard(hud: Hud, card: MenuCard) {
  const zombie = card.zombie;
  if (!zombie) return;
  const bonus = mutationBonus(zombie.mutation);
  const info: ZombieInfo = {
    name: card.name, typeName: card.name, key: card.cfg.key,
    group: zombie.group, className: zombie.className, classColor: zombie.classColor,
    str: (zombie.str + bonus.str) * hud.state.farmerZombieStrengthMult(),
    dex: zombie.dex + bonus.dex,
    con: (zombie.con + bonus.con) * hud.state.farmerZombieLifeMult(),
    focus: zombie.focus, mutation: zombie.mutation, invasions: 0,
    portrait: card.portrait,
  };
  const { panel } = openModal({
    host: hud.el, bgClass: "zpreview-bg", panelClass: "zpanel", replaceSelector: ".zpreview-bg",
  });
  panel.appendChild(buildZombieCard(hud, info, panel));
  if (card.description) {
    const note = document.createElement("p");
    note.className = "alm-hint";
    note.textContent = card.description;
    panel.appendChild(note);
  }
}

/** Convert a roster entry into the inspectable ZombieInfo shape. */
export function rosterInfo(hud: Hud, z: RosterEntry): ZombieInfo {
  return {
    name: z.name, typeName: z.typeName, key: z.key, group: z.group,
    className: z.className, classColor: z.classColor,
    str: z.str * hud.state.farmerZombieStrengthMult(), dex: z.dex,
    con: z.con * hud.state.farmerZombieLifeMult(), focus: z.focus, mutation: z.mutation,
    invasions: z.invasions,
    portrait: hud.zombiePortraitOf ? hud.zombiePortraitOf(z.key) : "",
    color: z.color,
    id: z.id, stored: z.stored,
  };
}

/** A compact framed roster tile (portrait + name + class pill). Used by the
 *  Mausoleum grid and the Almanac collection. */
export function buildRosterCard(hud: Hud, z: RosterEntry, onClick: () => void): HTMLElement {
  const card = document.createElement("div");
  card.className = "zr-card";
  const por = document.createElement("div");
  por.className = "zr-por"; // framed slot (matches the storage-shed item tiles)
  const portrait = hud.zombiePortraitOf ? hud.zombiePortraitOf(z.key) : "";
  const pim = document.createElement("img");
  pim.className = "zr-por-img";
  if (portrait) pim.src = portrait;
  por.appendChild(pim);
  // Show the SAME rig the inspect card shows: the static species portrait first,
  // replaced by this individual's mutation-aware render once it is available. The
  // Mausoleum grid used to keep the species art, so a stored mutant looked plain.
  // Deferred until the tile scrolls in: a full Mausoleum builds dozens of these at
  // once, and each render is a blocking GPU readback.
  if (hud.zombieMutationPortraitOf) {
    onFirstVisible(pim, () => {
      void hud.zombieMutationPortraitOf?.(
        z.key, visibleMutations(z.id, z.mutation), z.color, () => pim.isConnected,
      )
        .then((mutated) => { if (pim.isConnected) pim.src = mutated; })
        .catch(() => { /* retain the static species portrait */ });
    });
  }
  const name = document.createElement("div");
  name.className = "zr-name";
  name.textContent = z.name;
  const cls = document.createElement("span");
  cls.className = "zr-cls";
  cls.textContent = z.className;
  cls.style.background = z.classColor;
  card.append(por, name, cls);
  card.onclick = onClick;
  return card;
}

export type ZombiesPanelTab = "roster" | "almanac" | "mutations";

// The "Zombies" tab (right bar): "My Zombies" lists every owned zombie as its
// full inspect card (the same one shown when tapping a zombie); the "Zombie
// Almanac" is the species collection, in three groups — Normal, Special, Epic.
// `initialTab` is a deliberate destination (reopening after a zombie action);
// opening with no argument returns to whichever tab was last read.
export function openZombiesPanel(hud: Hud, initialTab?: ZombiesPanelTab) {
  // position:relative host (zl-panel) for card tooltips
  const { panel, close } = openModal({
    host: hud.el, bgClass: "zl-bg", panelClass: "zl-panel", replaceSelector: ".zl-bg",
  });

  const head = document.createElement("div");
  head.className = "zr-head";
  // Reuse the Market's screen-toggle look for the two tabs.
  const tabs = document.createElement("div");
  tabs.className = "pm-screens zl-tabs";
  const body = document.createElement("div");
  body.className = "zl-list";
  panel.append(head, tabs, body);

  const tabButtons: Record<ZombiesPanelTab, HTMLButtonElement> = {} as never;
  const show = (tab: ZombiesPanelTab) => {
    (Object.keys(tabButtons) as ZombiesPanelTab[]).forEach((key) =>
      tabButtons[key].classList.toggle("sel", key === tab));
    body.innerHTML = "";
    remember("zombies.tab", tab);
    if (tab === "roster") renderRoster();
    else if (tab === "mutations") renderMutations();
    else renderAlmanac();
    // Both lists are long, and both are rebuilt by ordinary actions (a sale, a
    // deploy, opening an Almanac entry), so each keeps its own place.
    keepScroll(body, `zombies.scroll.${tab}`);
  };
  const mkTab = (tab: ZombiesPanelTab, label: string) => {
    const b = document.createElement("button");
    b.className = "pm-screen";
    b.textContent = label;
    b.onclick = () => show(tab);
    tabButtons[tab] = b;
    tabs.appendChild(b);
  };
  mkTab("roster", "My Zombies");
  mkTab("almanac", "Zombie Almanac");
  mkTab("mutations", "Mutations");

  let rosterSort: ZombieSort = getZombieSort();

  const renderRoster = () => {
    // Show the complete owned roster here as a safety net for earned zombies. A boss
    // reward sent to storage remains visible and deployable even before the player
    // opens (or has room in) the physical Mausoleum panel.
    const roster = hud.getRoster ? hud.getRoster() : [];
    // The complete owned roster is in hand exactly here, so this is where the
    // per-zombie mutation toggles shed the entries of zombies that are gone (ids
    // are reissued, so a stale one would dress the next zombie grown).
    pruneMutationVisibility(roster.map((z) => z.id));
    const onFarm = roster.filter((r) => !r.stored).length;
    const stored = roster.length - onFarm;
    head.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Your Zombies";
    const cnt = document.createElement("span");
    cnt.className = "zr-total";
    cnt.textContent = `${onFarm} on farm${stored ? ` · ${stored} stored` : ""}`;
    head.append(title, cnt);

    if (!roster.length) {
      const e = document.createElement("div");
      e.className = "zr-empty";
      e.textContent = "You do not own any zombies yet.";
      body.appendChild(e);
      return;
    }

    // Ordering picker — only worth showing once there is something to order.
    if (roster.length > 1) {
      const label = document.createElement("label");
      label.className = "zl-sort";
      label.append("Sort");
      const select = document.createElement("select");
      select.className = "prof-input zl-sort-select";
      select.setAttribute("aria-label", "Sort zombies");
      for (const option of ZOMBIE_SORTS) {
        const item = new Option(option.label, option.id);
        item.selected = option.id === rosterSort;
        select.appendChild(item);
      }
      select.onchange = () => {
        if (!isZombieSort(select.value)) return;
        rosterSort = select.value;
        setZombieSort(rosterSort);
        // A new ordering is a new list: go back to the top of it deliberately.
        remember("zombies.scroll.roster", 0);
        show("roster");
      };
      label.appendChild(select);
      head.appendChild(label);
    }

    // Sort the INSPECT views, not the raw roster: those carry the farmer's
    // strength/life multipliers, so the list ranks by the number each card shows.
    const infos = roster.map((z) => rosterInfo(hud, z));
    for (const info of sortZombies(infos, rosterSort, (k) => hud.state.abilityUnlocked(k))) {
      const row = document.createElement("div");
      // Use the exact same panel/card composition as the single-zombie modal;
      // the Zombies menu only adds the vertically scrolling list around it.
      row.className = "panel zpanel zl-row";
      row.appendChild(buildZombieCard(hud, info, panel));
      row.appendChild(buildZombieActions(hud, info, close, () => openZombiesPanel(hud, "roster")));
      body.appendChild(row);
    }
  };

  const renderAlmanac = () => {
    const entries = hud.getAlmanac ? hud.getAlmanac() : [];
    const found = entries.filter((entry) => entry.obtained > 0).length;
    head.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Zombie Almanac";
    const cnt = document.createElement("span");
    cnt.className = "zr-total";
    cnt.textContent = `${found} / ${entries.length} discovered`;
    head.append(title, cnt);

    // Field notes sit ABOVE the collection: the three systems that actually hand out
    // the species below (the Pot, Brain Tickets, the Epic events) are what a player
    // staring at a wall of silhouettes needs, and a per-entry hint has no room for
    // them. Chips rather than prose so the grid still starts near the top.
    const topics = hud.getAlmanacGuide ? hud.getAlmanacGuide() : [];
    if (topics.length) {
      const notes = document.createElement("div");
      notes.className = "alm-notes";
      const label = document.createElement("div");
      label.className = "alm-notes-label";
      label.textContent = "How to find new zombies";
      notes.appendChild(label);
      for (const topic of topics) {
        const chip = document.createElement("button");
        chip.className = "alm-note";
        const title = document.createElement("b");
        title.textContent = topic.title;
        const blurb = document.createElement("span");
        blurb.textContent = topic.blurb;
        chip.append(title, blurb);
        chip.onclick = () => openAlmanacGuide(hud, topic);
        notes.appendChild(chip);
      }
      body.appendChild(notes);
    }

    const grid = document.createElement("div");
    grid.className = "zr-grid alm-grid";
    body.appendChild(grid);
    // Epic Boss exclusives are their own group even though the catalog files them as
    // "special", so the flag is checked before the category. Entries arrive already
    // sorted into these groups, so a change of heading opens the next section.
    let lastSection = "";
    for (const entry of entries) {
      const section = entry.epic
        ? "Epic"
        : entry.category === "normal" ? "Normal" : entry.category === "mutant" ? "Mutant" : "Special";
      if (section !== lastSection) {
        lastSection = section;
        const header = document.createElement("div");
        header.className = "alm-section";
        header.textContent = section;
        grid.appendChild(header);
      }
      grid.appendChild(buildAlmanacCard(hud, entry));
    }
  };

  // The third tab: the same collection one level down. A mutation is not a creature,
  // so an entry is a mutation drawn ON a zombie — the base Regular of its own tier, so
  // the grid runs Green through Silver exactly as the species one does.
  const renderMutations = () => {
    const entries = hud.getMutationAlmanac ? hud.getMutationAlmanac() : [];
    const found = entries.filter((entry) => entry.obtained > 0).length;
    head.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "Mutations";
    const cnt = document.createElement("span");
    cnt.className = "zr-total";
    cnt.textContent = `${found} / ${entries.length} discovered`;
    head.append(title, cnt);

    const note = document.createElement("div");
    note.className = "alm-notes-label mut-note";
    note.textContent = "Grown by planting a crop beside a zombie crop";
    body.appendChild(note);

    const grid = document.createElement("div");
    grid.className = "zr-grid alm-grid";
    body.appendChild(grid);
    // Grouped by SLOT rather than tier: one mutation per slot is the rule the whole
    // system turns on, so seeing the five ladders side by side is what tells a player
    // which of two mutations they are actually choosing between.
    let lastSlot = "";
    for (const entry of entries.slice().sort(
      (a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || a.tier - b.tier
    )) {
      if (entry.slot !== lastSlot) {
        lastSlot = entry.slot;
        const header = document.createElement("div");
        header.className = "alm-section";
        header.textContent = entry.slotLabel;
        grid.appendChild(header);
      }
      grid.appendChild(buildMutationCard(hud, entry));
    }
  };

  show(initialTab ?? recallOneOf("zombies.tab", ["roster", "almanac", "mutations"] as const, "roster"));
}

// Undiscovered portraits must not expose the real art: a CSS filter only blacks
// out the on-screen pixels, so "Save image" / long-press would still save the
// full-colour PNG. Instead we bake a genuinely black copy through a canvas and
// use that data-URL as the img src — the silhouette IS the image.
const silhouetteCache = new Map<string, Promise<string>>();
function silhouetteOf(url: string): Promise<string> {
  let p = silhouetteCache.get(url);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error(`portrait load failed: ${url}`));
      img.src = url;
    });
    silhouetteCache.set(url, p);
  }
  return p;
}

/** An <img> showing only the black silhouette of the portrait at `url`. The
 *  real art is never assigned as src, so saving the image saves the shadow. */
function silhouetteImg(url: string): HTMLImageElement {
  const pim = document.createElement("img");
  pim.className = "zr-por-img alm-sil";
  pim.draggable = false;
  if (url) silhouetteOf(url).then((src) => { pim.src = src; }).catch(() => {});
  return pim;
}

/** One Almanac tile: the species portrait (a black silhouette until obtained),
 *  its name, and the lifetime count. Tapping opens the entry detail. */
function buildAlmanacCard(hud: Hud, entry: AlmanacEntryView): HTMLElement {
  const card = document.createElement("div");
  card.className = "zr-card alm-card";
  const por = document.createElement("div");
  por.className = "zr-por";
  let pim: HTMLImageElement;
  if (entry.obtained) {
    pim = document.createElement("img");
    pim.className = "zr-por-img";
    if (entry.portrait) pim.src = entry.portrait;
  } else {
    pim = silhouetteImg(entry.portrait);
  }
  por.appendChild(pim);
  if (entry.obtained) {
    const count = document.createElement("span");
    count.className = "alm-count";
    count.textContent = `×${entry.obtained}`;
    por.appendChild(count);
  }
  const name = document.createElement("div");
  name.className = "zr-name";
  name.textContent = entry.name;
  card.append(por, name);
  if (entry.obtained) {
    const cls = document.createElement("span");
    cls.className = "zr-cls";
    cls.textContent = entry.className;
    cls.style.background = entry.classColor;
    card.appendChild(cls);
  } else {
    const unknown = document.createElement("span");
    unknown.className = "zr-cls alm-unknown";
    unknown.textContent = "Not found";
    card.appendChild(unknown);
  }
  card.onclick = () => openAlmanacEntry(hud, entry);
  return card;
}

/** The Almanac detail modal. Discovered: the full trading card with BASE stats
 *  (no modifiers) + lifetime count. Undiscovered: only how to obtain it. */
function openAlmanacEntry(hud: Hud, entry: AlmanacEntryView) {
  const { panel } = openModal({ host: hud.el, panelClass: "zpanel", bgClass: "alm-bg", replaceSelector: ".alm-bg" });

  if (entry.obtained > 0) {
    const info: ZombieInfo = {
      name: entry.name, typeName: entry.name, key: entry.key, group: entry.group,
      className: entry.className, classColor: entry.classColor,
      str: entry.str, dex: entry.dex, con: entry.con, focus: entry.focus,
      mutation: 0, invasions: 0, portrait: entry.portrait,
    };
    panel.appendChild(buildZombieCard(hud, info, panel));
    const meta = document.createElement("div");
    meta.className = "alm-meta";
    meta.innerHTML = `<b>Lifetime obtained: ${entry.obtained}</b>`;
    panel.appendChild(meta);
    const hint = document.createElement("p");
    hint.className = "alm-hint";
    hint.textContent = entry.hint;
    panel.appendChild(hint);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "alm-detail";
  const por = document.createElement("div");
  por.className = "zr-por alm-detail-por";
  por.appendChild(silhouetteImg(entry.portrait));
  const title = document.createElement("h2");
  title.textContent = entry.name;
  const status = document.createElement("div");
  status.className = "alm-meta";
  status.textContent = "Not yet obtained";
  const hint = document.createElement("p");
  hint.className = "alm-hint";
  hint.textContent = entry.hint;
  wrap.append(por, title, status, hint);
  panel.appendChild(wrap);
}

/** Paint a mutation portrait into `por`, blacked out when undiscovered.
 *
 *  Extraction blocks the main thread for ~30ms and there are sixteen of these, so the
 *  work is deferred until the tile scrolls into view and abandoned if it leaves before
 *  its turn comes up (the `wanted` test). `forceMutation` is what makes the entry show
 *  the mutation even for a player who has mutations hidden on their own army.
 *
 *  An undiscovered entry is silhouetted from the SAME extraction rather than a species
 *  portrait: the shape of the thing is the clue, and a plain zombie outline sixteen
 *  times over would tell nobody anything.
 *
 *  THE AUTHORED ICON PAINTS FIRST, and it is not decoration. Every other portrait tile
 *  in the HUD sets the static species PNG before asking for the mutation-aware render,
 *  and keeps it when that render never arrives; this tab was the only one with nothing
 *  underneath, so anything that stopped the extraction — a device whose renderer will
 *  not read pixels back, an observer that never fires — emptied all sixteen frames,
 *  which is exactly what got reported. The flask icon is a plain file: no renderer, no
 *  intersection test, no queue. It says WHICH mutation the entry is, which is more than
 *  a blank frame and more than an unmutated zombie would. */
function paintMutationPortrait(hud: Hud, por: HTMLElement, entry: MutationAlmanacEntry): void {
  const img = document.createElement("img");
  img.className = "zr-por-img";
  img.alt = "";
  // Same marker the species tiles carry. On a baked silhouette the filter is a no-op
  // — it is on for consistency, because the hover-reveal rule keyed off it must find
  // nothing to reveal either way, and because it is what blacks out the icon below if
  // this device cannot bake one.
  if (!entry.obtained) img.classList.add("alm-sil");
  por.appendChild(img);
  // The extracted portrait always wins, whenever it lands: the icon is a floor, not a
  // race. Without this an icon silhouette baked slowly could overwrite the real one.
  let extracted = false;
  // Deliberately NOT gated on por.isConnected: the card is assembled before it is
  // appended, so the icon below is painted into a tile that is not in the document
  // yet. An <img> takes its src just as well detached, and the liveness test that
  // does matter — the one that stops a queued extraction nobody is waiting for — is
  // passed to the portrait call instead.
  const show = (url: string, isPortrait: boolean) => {
    if (!url || (!isPortrait && extracted)) return;
    if (isPortrait) extracted = true;
    if (entry.obtained) { img.src = url; return; }
    void silhouetteOf(url)
      .then((black) => { if (isPortrait || !extracted) img.src = black; })
      // Baking black needs a canvas the device may not give us. Falling back to the
      // art under alm-sil's brightness(0) shows the same black shape; only "save
      // image" would reach the real pixels, and for a 40x40 icon the tile already
      // carries elsewhere that is a far better trade than an empty frame.
      .catch(() => { if (isPortrait || !extracted) img.src = url; });
  };
  show(entry.icon, false);
  if (!hud.zombieMutationPortraitOf) return;
  onFirstVisible(por, () => {
    void hud.zombieMutationPortraitOf!(
      entry.portraitZombieKey, entry.bit, undefined, () => por.isConnected, true,
    )
      .then((portrait) => show(portrait, true))
      .catch(() => { /* the authored icon painted above stands in for it */ });
  });
}

/** One Mutation Almanac tile: the mutation worn by the tier-appropriate zombie, its
 *  name, and its stat changes — silhouetted, and stats withheld, until discovered. */
function buildMutationCard(hud: Hud, entry: MutationAlmanacEntry): HTMLElement {
  const card = document.createElement("div");
  card.className = "zr-card alm-card mut-card";
  const por = document.createElement("div");
  por.className = "zr-por";
  paintMutationPortrait(hud, por, entry);
  if (entry.obtained) {
    const count = document.createElement("span");
    count.className = "alm-count";
    count.textContent = `×${entry.obtained}`;
    por.appendChild(count);
  }
  const name = document.createElement("div");
  name.className = "zr-name";
  name.textContent = entry.obtained ? entry.name : "???";
  card.append(por, name);
  if (entry.obtained) {
    const stats = document.createElement("div");
    stats.className = "mut-stats";
    stats.textContent = entry.statEffects.map(statEffectText).join(", ");
    card.appendChild(stats);
  }
  const chip = document.createElement("span");
  chip.className = entry.obtained ? "zr-cls" : "zr-cls alm-unknown";
  chip.textContent = entry.obtained ? entry.className : "Not found";
  if (entry.obtained) chip.style.background = entry.classColor;
  card.appendChild(chip);
  card.onclick = () => openMutationEntry(hud, entry);
  return card;
}

/** The mutation detail modal. Discovered: the portrait, the slot it fills, and every
 *  stat it moves. Undiscovered: the silhouette and the obtain hint, nothing else —
 *  same bargain the species entries strike. */
function openMutationEntry(hud: Hud, entry: MutationAlmanacEntry) {
  const { panel } = openModal({
    host: hud.el, panelClass: "zpanel", bgClass: "alm-bg", replaceSelector: ".alm-bg",
  });
  const wrap = document.createElement("div");
  wrap.className = "alm-detail";
  const por = document.createElement("div");
  por.className = "zr-por alm-detail-por";
  paintMutationPortrait(hud, por, entry);
  const title = document.createElement("h2");
  title.textContent = entry.obtained ? entry.name : "Undiscovered mutation";
  wrap.append(por, title);

  if (!entry.obtained) {
    const status = document.createElement("div");
    status.className = "alm-meta";
    status.textContent = "Not yet obtained";
    const hint = document.createElement("p");
    hint.className = "alm-hint";
    hint.textContent = entry.hint;
    wrap.append(status, hint);
    panel.appendChild(wrap);
    return;
  }

  const cls = document.createElement("span");
  cls.className = "zr-cls mut-detail-cls";
  cls.textContent = `${entry.className} · Tier ${entry.tier}`;
  cls.style.background = entry.classColor;
  wrap.appendChild(cls);
  panel.appendChild(wrap);

  const meta = document.createElement("div");
  meta.className = "alm-meta";
  meta.innerHTML = `<b>Slot: ${entry.slotLabel}</b>`;
  panel.appendChild(meta);

  const stats = document.createElement("p");
  stats.className = "mut-detail-stats";
  stats.textContent = entry.statEffects.map(statEffectText).join("   ");
  panel.appendChild(stats);

  const slotNote = document.createElement("p");
  slotNote.className = "alm-hint";
  slotNote.textContent = `A zombie wears one mutation per slot, so this competes with `
    + `every other ${entry.slotLabel} mutation — growing or combining a second one `
    + `replaces it.`;
  panel.appendChild(slotNote);

  const found = document.createElement("div");
  found.className = "alm-meta";
  found.textContent = `Lifetime obtained: ${entry.obtained}`;
  panel.appendChild(found);
}

/** One field-note page: the topic's title over its paragraphs. Text only — these
 *  explain a system rather than a species, so there is nothing to illustrate, and
 *  the modal scrolls because the Pot's page is deliberately long. */
function openAlmanacGuide(hud: Hud, topic: AlmanacGuideTopic) {
  const { panel } = openModal({
    host: hud.el, panelClass: "zpanel alm-guide", bgClass: "alm-bg", replaceSelector: ".alm-bg",
  });
  const title = document.createElement("h2");
  title.textContent = topic.title;
  panel.appendChild(title);
  for (const paragraph of topic.paragraphs) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    panel.appendChild(p);
  }
}
