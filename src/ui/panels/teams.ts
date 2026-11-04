import { msg as trMsg, t as tr } from "../../i18n";
// The Zombie Teams panel (opened from the Mausoleum): saved farm line-ups.
//
// Two screens, both rendered here:
//   • the team list — every saved team with who is in it and an Assemble button
//   • the team editor — the whole owned roster as a numbered picker, so a team
//     records an ORDER as well as a membership (it becomes the raid attack order)
//
// The panel only ever asks the Hud hooks for things: it never touches the roster
// itself. Assembling is a single call into main.ts, which performs the moves
// through the same authoritative store/deploy path the Mausoleum's own buttons
// use — see hud.onTeamAssemble.
import type { Hud } from "../../hud";
import { markPrimary, openModal } from "../Modal";
import { onFirstVisible } from "../onFirstVisible";
import type { RosterEntry } from "../../zombie/types";
import { visibleMutations } from "../../zombie/mutationVisibility";
import {
  compactOrder, selectedCount, toggleSlot, type OrderSlots,
} from "../../raid/attackOrderSlots";
import {
  assembleReport, MAX_TEAMS, MAX_TEAM_NAME_LENGTH, nextTeamId, normalizeTeamName,
  planTeamAssembly, shortfallNotice, type ZombieTeam,
} from "../../zombie/teams";

/** Portrait tile for one roster entry: the species art first, replaced by this
 *  individual's mutation-aware render once it is available (deferred, like every
 *  other grid — each render is a blocking GPU readback). */
function paintPortrait(el: HTMLElement, hud: Hud, z: RosterEntry): void {
  const portrait = hud.zombiePortraitOf ? hud.zombiePortraitOf(z.key) : "";
  if (portrait) el.style.backgroundImage = `url(${portrait})`;
  if (!hud.zombieMutationPortraitOf) return;
  onFirstVisible(el, () => {
    void hud.zombieMutationPortraitOf?.(
      z.key, visibleMutations(z.id, z.mutation), z.color, () => el.isConnected,
    )
      .then((image) => { if (el.isConnected) el.style.backgroundImage = `url(${image})`; })
      .catch(() => { /* retain the static species portrait */ });
  });
}

/** "6 on farm · 2 resting · 1 missing" — what this team would field right now. */
function teamSummary(team: ZombieTeam, roster: RosterEntry[]): string {
  if (!team.members.length) return "Empty — nobody picked yet";
  const owned = new Map(roster.map((z) => [z.id, z]));
  let onFarm = 0;
  let stored = 0;
  let missing = 0;
  for (const id of team.members) {
    const unit = owned.get(id);
    if (!unit) missing++;
    else if (unit.stored) stored++;
    else onFarm++;
  }
  const parts = [trMsg`${onFarm + stored} zombie${onFarm + stored === 1 ? "" : tr("s")}`];
  if (stored) parts.push(trMsg`${stored} resting`);
  if (missing) parts.push(trMsg`${missing} missing`);
  return parts.join(" · ");
}

export function openTeamsPanel(hud: Hud, onClose?: () => void) {
  const { panel } = openModal({
    host: hud.el, bgClass: "zteam-bg", panelClass: "zteam-panel", replaceSelector: ".zteam-bg",
    // Assembling moves zombies between the farm and the Mausoleum, so whatever
    // opened this panel (the Mausoleum grid) is stale by the time it closes.
    onClose,
  });

  const wrap = document.createElement("div");
  wrap.className = "zroster zteam";
  const head = document.createElement("div");
  head.className = "zr-head";
  const list = document.createElement("div");
  list.className = "zteam-list";
  const foot = document.createElement("div");
  foot.className = "zbtns";
  wrap.append(head, list, foot);
  panel.append(wrap);

  const render = () => {
    const teams = hud.getTeams?.() ?? [];
    const roster = hud.getRoster?.() ?? [];

    head.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = tr("Zombie Teams");
    const count = document.createElement("span");
    count.className = "zr-total";
    count.textContent = trMsg`${teams.length} / ${MAX_TEAMS} saved`;
    head.append(title, count);

    list.innerHTML = "";
    if (!teams.length) {
      const empty = document.createElement("div");
      empty.className = "zr-empty";
      empty.textContent =
        trMsg`No teams yet. Save your garden crew, a raiding party, or a line-up for one particular invasion — then swap between them with a single tap.`;
      list.appendChild(empty);
    }
    for (const team of teams) list.appendChild(buildTeamRow(hud, team, roster, render));

    foot.innerHTML = "";
    const add = document.createElement("button");
    add.className = "zbtn deploy";
    add.textContent = tr("New team");
    add.disabled = teams.length >= MAX_TEAMS;
    if (add.disabled) add.title = trMsg`You can keep ${MAX_TEAMS} teams. Delete one to make room.`;
    add.onclick = () => openTeamEditor(hud, null, render);
    foot.appendChild(add);
  };
  render();
}

/** One saved team: name, who it fields, a portrait strip, and its actions. */
function buildTeamRow(
  hud: Hud,
  team: ZombieTeam,
  roster: RosterEntry[],
  refresh: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "zteam-row";

  const info = document.createElement("div");
  info.className = "zteam-info";
  const name = document.createElement("div");
  name.className = "zteam-nm";
  name.textContent = team.name;
  const sub = document.createElement("div");
  sub.className = "zteam-sub";
  sub.textContent = tr(teamSummary(team, roster));
  info.append(name, sub);

  // The strip shows the line-up in ATTACK ORDER, with anyone no longer owned kept
  // as an empty frame rather than silently dropped — the count above says "1
  // missing", and this is where the player sees which slot it was.
  const strip = document.createElement("div");
  strip.className = "zteam-strip";
  const owned = new Map(roster.map((z) => [z.id, z]));
  for (const id of team.members) {
    const unit = owned.get(id);
    const tile = document.createElement("div");
    tile.className = "zteam-pip";
    if (!unit) {
      tile.classList.add("gone");
      tile.title = tr("This zombie is no longer in your roster — the team assembles without it.");
    } else {
      tile.title = unit.stored ? trMsg`${unit.name} (resting in the Mausoleum)` : unit.name;
      if (unit.stored) tile.classList.add("resting");
      paintPortrait(tile, hud, unit);
    }
    strip.appendChild(tile);
  }
  if (team.members.length) info.appendChild(strip);

  // Work the assembly out NOW, before anything is tapped: a team that cannot be
  // fielded should say so on its own row rather than only in the toast afterwards.
  // planTeamAssembly is pure and cheap, so this is just the same arithmetic the
  // Assemble button will do.
  const plan = planTeamAssembly(
    team.members, roster, hud.getArmyCap?.() ?? roster.length, hud.getMausoleumCap?.() ?? 0,
  );
  const notice = shortfallNotice(plan);
  if (notice) {
    const warn = document.createElement("div");
    warn.className = "zteam-warn";
    warn.textContent = tr(notice);
    info.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "zbtns zteam-actions";

  const assemble = document.createElement("button");
  assemble.className = "zbtn deploy";
  assemble.textContent = tr("Assemble");
  // Nothing to do is a different state from "this will not work": a team already
  // standing on the farm reads as done, not as broken.
  const idle = !plan.store.length && !plan.deploy.length;
  assemble.disabled = !team.members.length || idle;
  if (!team.members.length) assemble.title = tr("This team has nobody in it yet.");
  else if (idle) {
    assemble.title = notice ? trMsg`${notice} Nothing can be moved right now.` : tr("This team is already on your farm.");
    if (!notice) assemble.textContent = tr("On the farm");
  }
  assemble.onclick = async () => {
    assemble.disabled = true;
    const result = await hud.onTeamAssemble?.(team.members);
    // A null result means main.ts refused the whole thing (offline gameplay gate,
    // an unsettled roster) and has already said why.
    if (result) hud.showToast(tr(assembleReport(team.name, result)));
    refresh();
  };

  const edit = document.createElement("button");
  edit.className = "zbtn store";
  edit.textContent = tr("Edit");
  edit.onclick = () => openTeamEditor(hud, team, refresh);

  const remove = document.createElement("button");
  remove.className = "zbtn sell";
  remove.textContent = tr("Delete");
  remove.onclick = async () => {
    const ok = await hud.confirmInGame(
      tr("Delete this team?"),
      trMsg`"${team.name}" will be forgotten. Your zombies are not affected — only the saved line-up.`,
      tr("Delete"),
    );
    if (!ok) return;
    hud.onTeamsChange?.((hud.getTeams?.() ?? []).filter((t) => t.id !== team.id));
    refresh();
  };

  actions.append(assemble, edit, remove);
  row.append(info, actions);
  return row;
}

// The picker. Every owned zombie is a card; tapping it appends to the line-up
// (the number on the card is its attack position), tapping again removes it and
// renumbers the rest — deliberately the same interaction as the raid Army screen,
// down to the CSS, because it is the same decision being made in advance.
function openTeamEditor(hud: Hud, team: ZombieTeam | null, afterSave: () => void) {
  const roster = hud.getRoster?.() ?? [];
  const cap = hud.getArmyCap?.() ?? roster.length;
  const { panel, close } = openModal({
    host: hud.el, bgClass: "zteam-edit-bg", replaceSelector: ".zteam-edit-bg",
  });

  const wrap = document.createElement("div");
  wrap.className = "army-wrap zteam-edit";
  const head = document.createElement("div");
  head.className = "army-head";
  const grid = document.createElement("div");
  grid.className = "army-grid";
  const foot = document.createElement("div");
  foot.className = "army-foot";
  wrap.append(head, grid, foot);
  panel.append(wrap);

  // Only members that still exist can be pre-selected; a missing one would occupy
  // an invisible slot in the order. It is dropped from the saved team on the next
  // save, which is the one moment the player can see what they are losing.
  const ownedIds = new Set(roster.map((z) => z.id));
  // Slotted, like the invasion picker: un-picking a member leaves its slot EMPTY and
  // the next card tapped fills the lowest one, so replacing whoever leads a saved
  // line-up doesn't renumber the rest. Saving closes the gaps (see attackOrderSlots).
  let order: OrderSlots = (team?.members ?? []).filter((id) => ownedIds.has(id)).slice(0, cap);

  const title = document.createElement("h2");
  title.textContent = team ? tr("Edit team") : tr("New team");
  const counter = document.createElement("span");
  counter.className = "army-count";
  const nameInput = document.createElement("input");
  nameInput.className = "prof-input zteam-name";
  nameInput.maxLength = MAX_TEAM_NAME_LENGTH;
  nameInput.placeholder = tr("Team name (e.g. Garden Crew)");
  nameInput.value = team?.name ?? "";
  nameInput.setAttribute("aria-label", tr("Team name"));
  head.append(title, counter, nameInput);

  const save = document.createElement("button");
  save.className = "raid-go";
  markPrimary(save);

  const refresh = () => {
    const n = selectedCount(order);
    counter.textContent = trMsg`${n} / ${cap} picked`;
    counter.classList.toggle("short", !n);
    for (const card of grid.querySelectorAll<HTMLElement>(".army-card")) {
      const at = order.indexOf(card.dataset.id!);
      card.classList.toggle("sel", at >= 0);
      const tick = card.querySelector<HTMLElement>(".tick");
      if (tick) tick.textContent = at >= 0 ? tr(String(at + 1)) : "";
    }
    save.textContent = n ? trMsg`Save team of ${n}` : tr("Save empty team");
  };

  if (!roster.length) {
    const empty = document.createElement("div");
    empty.className = "zr-empty";
    empty.textContent = tr("You do not own any zombies yet.");
    grid.appendChild(empty);
  }
  for (const z of roster) {
    const card = document.createElement("div");
    card.className = "army-card";
    card.dataset.id = z.id;
    const por = document.createElement("div");
    por.className = "army-por";
    paintPortrait(por, hud, z);
    const nm = document.createElement("div");
    nm.className = "army-nm";
    nm.textContent = z.name;
    const ty = document.createElement("div");
    ty.className = "army-ty";
    ty.textContent = tr(z.typeName);
    const where = document.createElement("div");
    where.className = "army-st zteam-where";
    // Where the zombie is right now matters when planning a line-up: a team full
    // of resting zombies is a bigger swap than one that is already standing there.
    where.textContent = z.stored ? tr("Resting") : tr("On farm");
    const tick = document.createElement("span");
    tick.className = "tick";
    card.append(tick, por, nm, ty, where);
    card.onclick = () => {
      order = toggleSlot(order, z.id, cap);
      refresh();
    };
    grid.appendChild(card);
  }

  // "Use current farm" captures the line-up standing on the farm right now, in
  // roster order — the fastest way to record a team you have already arranged.
  const capture = document.createElement("button");
  capture.className = "raid-quick";
  capture.textContent = tr("Use current farm");
  capture.onclick = () => {
    order = roster.filter((z) => !z.stored).slice(0, cap).map((z) => z.id);
    refresh();
  };

  const clear = document.createElement("button");
  clear.className = "raid-quick";
  clear.textContent = tr("Clear");
  clear.onclick = () => { order = []; refresh(); };

  save.onclick = () => {
    const teams = hud.getTeams?.() ?? [];
    const fallback = team?.name ?? `Team ${teams.length + 1}`;
    const name = normalizeTeamName(nameInput.value) ?? fallback;
    // A saved team is a continuous line-up: empty slots are a picking aid only, and a
    // hole in `members` would carry straight into the raid attack order it becomes.
    const members = compactOrder(order);
    const next: ZombieTeam = team
      ? { ...team, name, members }
      : { id: nextTeamId(teams), name, members };
    hud.onTeamsChange?.(team
      ? teams.map((t) => (t.id === team.id ? next : t))
      : [...teams, next].slice(0, MAX_TEAMS));
    close();
    afterSave();
  };

  foot.append(capture, clear, save);
  refresh();
}
