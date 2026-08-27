// The Invasions panel (Social → Invasions): friend PvP's home.
//
// Three tabs, market-styled:
//   • Attack  — scout a friend's defense (score → reward tier, their line-up)
//               before committing, then launch the invasion.
//   • Defense — arrange your OWN defense: which owned zombies stand, in what
//               order (slot 1 emerges first), or fall back to the automatic
//               strongest pick. Shows your defense as attackers will meet it.
//   • History — the last 10 attacks and 10 defenses (watchable while their
//               recording survives), lifetime + trailing-week stats, and the
//               accumulated defense-reward backlog with one Claim-all button.
//
// The panel only ever asks the Hud hooks for things; every server call lives in
// main.ts. Nothing here runs unless PVP_UI_ENABLED let the entry point render.
import type { Hud } from "../../hud";
import { markPrimary, openModal } from "../Modal";
import { onFirstVisible } from "../onFirstVisible";
import type { RosterEntry } from "../../zombie/types";
import { visibleMutations } from "../../zombie/mutationVisibility";
import {
  compactOrder, selectedCount, toggleSlot, type OrderSlots,
} from "../../raid/attackOrderSlots";
import {
  roleForGroup, PVP_ARMY_SIZE, PVP_DEFENSE_CAP, PVP_DEFENSE_ROLES,
  PVP_MIN_LEVEL,
} from "../../raid/pvp";
import { hasSeenPvpTip, markPvpTipSeen } from "../../prefs";

/** Tim's one-off briefing, given the first time the Invasions panel opens. Defending
 *  is the one thing in the game the player never actually plays — the farm fights on
 *  its own while they are away — so the two rules that make the Defense tab make sense
 *  (one zombie per class, and nothing is ever lost) are said out loud once rather than
 *  left to be inferred from a screen of empty jobs. See prefs.hasSeenPvpTip. */
const PVP_INTRO_TIP =
  "Now then — invadin' a neighbour is one thing, but defendin' yer OWN patch works " +
  "a mite different. Ye don't march an army out; the farm holds the line without ye. " +
  "So pick yer strongest of EACH kind — they've each got their own job to do.\n" +
  "And don't ye fret. It's all in good fun: no zombie's ever lost defendin' the " +
  "place. They get right back up and dust themselves off!";

// ---- view types (structurally matched by net/api's results; main.ts passes the
// server payloads straight through) --------------------------------------------

export interface PvpRewardView { key: string; qty: number }

export interface PvpFightRowView {
  sessionId: string;
  otherName: string;
  finishedAt: number;
  attackerWon: boolean;
  attackScore: number;
  defenseScore: number;
  rewarded: boolean;
  claimableTier?: number;
  replayAvailable?: boolean;
}

export interface PvpStatLineView {
  attackWins: number;
  attackLosses: number;
  defenseWins: number;
  defenseLosses: number;
}

export interface PvpOverviewView {
  attacks: PvpFightRowView[];
  defenses: PvpFightRowView[];
  stats: { lifetime: PvpStatLineView; week: PvpStatLineView };
  claim: { count: number; rewards: PvpRewardView[]; more?: boolean };
  rewardedWinsToday: number;
  rewardedDefensesToday: number;
  rewardedWinsPerDay: number;
  rewardedDefensesPerDay: number;
}

export interface PvpDefenderPreviewView {
  key: string;
  name: string;
  mutation?: number;
  color?: [number, number, number];
  role?: string;
}

export interface PvpScoutView {
  error?: string;
  defenderName?: string;
  defenseScore?: number;
  attackerTier?: number;
  defenders?: PvpDefenderPreviewView[];
  authored?: boolean;
  pairAttacksToday?: number;
  pairAttackLimit?: number;
}

export interface PvpDefenseInfoView {
  mode?: string;
  unitIds: string[];
  defense: {
    score: number;
    tier: number;
    defenders: PvpDefenderPreviewView[];
    authored: boolean;
  } | null;
  error?: string;
}

// -------------------------------------------------------------------------------

const TIER_STARS = (tier: number) => "★".repeat(Math.max(1, Math.min(5, tier)));

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function rewardLabel(hud: Hud, rewards: PvpRewardView[]): string {
  const name = (key: string) => hud.boosts.find((b) => b.key === key)?.name ?? key;
  return rewards.map((r) => (r.qty > 1 ? `${name(r.key)} ×${r.qty}` : name(r.key))).join(", ");
}

/** Species-portrait pip strip for a defense line-up (emergence order). These are
 *  OTHER people's zombies (or built units), so only the static species portrait is
 *  available — no per-unit mutation render. */
function defenseStrip(hud: Hud, defenders: PvpDefenderPreviewView[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "zteam-strip";
  for (const d of defenders) {
    const pip = document.createElement("div");
    pip.className = "zteam-pip";
    pip.title = d.name;
    const portrait = hud.zombiePortraitOf?.(d.key) ?? "";
    if (portrait) pip.style.backgroundImage = `url(${portrait})`;
    strip.appendChild(pip);
  }
  return strip;
}

/** The jobs a formation defense fills, front to back — ONE PER CLASS, which is why
 *  there are six of them and not five: Headless tanks, Large is the brute, Small its
 *  ammunition, Garden heals, and Normal and Girl are a reinforcement job EACH. Those
 *  two do identical work, and are still two jobs rather than one job with two holders
 *  (owner's ruling) — which is also what lets the picker count jobs and be right, since
 *  the job list and the class list are now the same six things. */
const DEFENSE_ROLES = PVP_DEFENSE_ROLES;

/** The job's NAME, for the picker ("who stands here"). ROLE_LABEL below says what the
 *  job DOES, which is what a finished line-up wants to show instead. */
const ROLE_NAME: Readonly<Record<string, string>> = {
  tank: "Front line",
  brute: "Heavy",
  mini: "Ammo",
  line: "Reinforcement (Normal)",
  girl: "Reinforcement (Girl)",
  support: "Healer",
};

const ROLE_LABEL: Readonly<Record<string, string>> = {
  tank: "Holds the front",
  brute: "Heavy hitter",
  mini: "Little terror",
  line: "Normal reinforcement",
  girl: "Girl reinforcement",
  support: "Heals the line",
};

/** The formation, one row per job: portrait, who is filling it, what it does. */
function formationList(hud: Hud, defenders: PvpDefenderPreviewView[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pvp-roles";
  for (const d of defenders) {
    const row = document.createElement("div");
    row.className = "pvp-role";
    const pip = document.createElement("div");
    pip.className = "zteam-pip";
    const portrait = hud.zombiePortraitOf?.(d.key) ?? "";
    if (portrait) pip.style.backgroundImage = `url(${portrait})`;
    const text = document.createElement("div");
    text.className = "pvp-role-text";
    const who = document.createElement("div");
    who.className = "pvp-role-name";
    who.textContent = d.name;
    const job = document.createElement("div");
    job.className = "zteam-sub";
    job.textContent = ROLE_LABEL[d.role ?? ""] ?? "Defender";
    text.append(who, job);
    row.append(pip, text);
    wrap.appendChild(row);
  }
  return wrap;
}

/** Portrait tile for an OWN roster entry (mutation-aware, deferred). */
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

export function openInvasionsPanel(hud: Hud) {
  const { panel, close } = openModal({
    host: hud.el, bgClass: "pvp-bg", panelClass: "pvp-panel",
    title: "Invasions", replaceSelector: ".pvp-bg",
  });

  if (!hud.socialOnline?.()) {
    const note = document.createElement("p");
    note.className = "rd-intro";
    note.textContent = "Friend invasions are an online feature — sign in from the Friends panel to take part.";
    panel.appendChild(note);
    return;
  }
  const myLevel = hud.getPlayerLevel?.() ?? 0;
  if (myLevel < PVP_MIN_LEVEL) {
    const note = document.createElement("p");
    note.className = "rd-intro";
    note.textContent = `Friend invasions open at level ${PVP_MIN_LEVEL} — get the farm going first!`;
    panel.appendChild(note);
    return;
  }

  const tabs = document.createElement("div");
  tabs.className = "mkt-tabs pvp-tabs";
  const body = document.createElement("div");
  body.className = "pvp-body";
  panel.append(tabs, body);

  // First open only: Tim explains defending before the player meets the Defense tab.
  // Fired after the panel is built (Tim layers over it at z-index 44), and never
  // awaited — the tabs stay usable behind him and the notice dismisses itself.
  if (!hasSeenPvpTip()) {
    markPvpTipSeen();
    void hud.timSays(PVP_INTRO_TIP, "Right ye are");
  }

  // The overview backs the Attack pips AND the whole History tab; fetched once per
  // panel open, re-fetched after anything that changes it (a claim).
  let overview: PvpOverviewView | null = null;
  let overviewPending: Promise<void> | null = null;
  const loadOverview = (force = false): Promise<void> => {
    if (overview && !force) return Promise.resolve();
    overviewPending ??= (async () => {
      try { overview = (await hud.getPvpOverview?.()) ?? null; }
      catch { /* keep whatever we had */ }
      overviewPending = null;
    })();
    return overviewPending;
  };

  let current = "Attack";
  const tabButtons = new Map<string, HTMLButtonElement>();
  for (const name of ["Attack", "Defense", "History"] as const) {
    const tab = document.createElement("button");
    tab.className = "mkt-tab";
    tab.textContent = name;
    tab.onclick = () => { current = name; render(); };
    tabButtons.set(name, tab);
    tabs.appendChild(tab);
  }

  const render = () => {
    for (const [name, tab] of tabButtons) tab.classList.toggle("sel", name === current);
    body.innerHTML = "";
    if (current === "Attack") renderAttack();
    else if (current === "Defense") renderDefense();
    else renderHistory();
  };

  // ---- Attack -----------------------------------------------------------------

  const renderAttack = () => {
    const pips = document.createElement("div");
    pips.className = "pvp-pips";
    body.appendChild(pips);
    const paintPips = () => {
      if (!overview) { pips.textContent = "Loading…"; return; }
      pips.textContent =
        `Rewarded wins today: ${overview.rewardedWinsToday}/${overview.rewardedWinsPerDay}` +
        (overview.rewardedWinsToday >= overview.rewardedWinsPerDay
          ? " — the rest are for bragging rights."
          : "");
    };
    paintPips();
    void loadOverview().then(() => { if (pips.isConnected) paintPips(); });

    // Online mode only reaches here, so getFriends IS the server list — no offline
    // placeholder rows to filter. A friend with an unknown cached level stays
    // invadable; the server's own gate answers if they are actually too new.
    const friends = hud.getFriends?.() ?? [];
    if (!friends.length) {
      const empty = document.createElement("div");
      empty.className = "zr-empty";
      empty.textContent = "No friends yet — add some in the Friends panel, then come invade them (kindly).";
      body.appendChild(empty);
      return;
    }
    const list = document.createElement("div");
    list.className = "pvp-list";
    body.appendChild(list);
    for (const f of friends) {
      const row = document.createElement("div");
      row.className = "zteam-row pvp-row";
      const info = document.createElement("div");
      info.className = "zteam-info";
      const nm = document.createElement("div");
      nm.className = "zteam-nm";
      nm.textContent = f.name; // account-controlled → textContent
      info.appendChild(nm);
      const sub = document.createElement("div");
      sub.className = "zteam-sub";
      sub.textContent = f.level != null ? `Level ${f.level}` : "";
      info.appendChild(sub);
      const detail = document.createElement("div");
      detail.className = "pvp-scout";
      info.appendChild(detail);

      const actions = document.createElement("div");
      actions.className = "zbtns zteam-actions";
      const locked = f.level != null && f.level < PVP_MIN_LEVEL;
      const scout = document.createElement("button");
      scout.className = "zbtn store";
      scout.textContent = "Scout";
      const invade = document.createElement("button");
      invade.className = "zbtn deploy";
      invade.textContent = "Invade ⚔";
      invade.title = `Send ${PVP_ARMY_SIZE} zombies at ${f.name}'s defense. ` +
        "Nobody gets hurt for real — stronger defenders give more boosts.";
      if (locked) {
        scout.disabled = true;
        invade.disabled = true;
        sub.textContent = `Level ${f.level} — their farm opens for invasions at level ${PVP_MIN_LEVEL}.`;
      }
      scout.onclick = async () => {
        scout.disabled = true;
        detail.textContent = "Scouting…";
        const view = await (hud.onScoutPvpDefense?.(f.id) ?? Promise.resolve(null));
        scout.disabled = false;
        detail.innerHTML = "";
        if (!view || view.error) {
          detail.textContent =
            view?.error === "no_defense" ? "No zombies on their farm — nothing to fight!"
            : view?.error === "defender_level" ? `Their farm opens for invasions at level ${PVP_MIN_LEVEL}.`
            : "Scouting failed — try again in a moment.";
          return;
        }
        const tier = view.attackerTier ?? 1;
        const line = document.createElement("div");
        line.className = "zteam-sub";
        line.textContent =
          `Tier ${tier} ${TIER_STARS(tier)} defense · ${view.defenders?.length ?? 0} defenders · ` +
          `${view.authored ? "arranged" : "auto"}` +
          ((view.pairAttacksToday ?? 0) > 0
            ? ` · ${view.pairAttacksToday}/${view.pairAttackLimit} attacks today`
            : "");
        detail.appendChild(line);
        if (view.defenders?.length) detail.appendChild(defenseStrip(hud, view.defenders));
      };
      invade.onclick = () => {
        close();
        hud.onInvadeFriend?.(f.id, f.name);
      };
      actions.append(scout, invade);
      row.append(info, actions);
      list.appendChild(row);
    }
  };

  // ---- Defense ----------------------------------------------------------------

  const renderDefense = () => {
    const holder = document.createElement("div");
    holder.className = "pvp-list";
    holder.textContent = "Loading your defense…";
    body.appendChild(holder);
    void (async () => {
      const view = await (hud.getPvpDefense?.() ?? Promise.resolve(null));
      if (!holder.isConnected) return;
      holder.innerHTML = "";
      if (!view) {
        holder.textContent = "Couldn't load your defense — try again in a moment.";
        return;
      }
      const formation = view.mode === "formation";
      const note = document.createElement("p");
      note.className = "rd-intro";
      note.textContent = formation
        ? "When a friend invades, these zombies defend your farm — one of each kind, " +
          "each with a job. Zombies play nice with each other, so no losses are permanent."
        : "When a friend invades, these zombies defend your farm. " +
          "Zombies play nice with each other, so no losses are permanent. " +
          "Arrange your own line-up, or let the farm field its strongest automatically.";
      holder.appendChild(note);

      if (view.error === "no_defense") {
        const empty = document.createElement("div");
        empty.className = "zr-empty";
        empty.textContent = "You need at least one zombie before anyone can invade you.";
        holder.appendChild(empty);
        return;
      }
      if (view.defense) {
        const summary = document.createElement("div");
        summary.className = "zteam-row pvp-row";
        const info = document.createElement("div");
        info.className = "zteam-info";
        const head = document.createElement("div");
        head.className = "zteam-nm";
        head.textContent = formation
          ? `Your farm's defenders (${view.defense.defenders.length})`
          : view.defense.authored
            ? `Your arranged defense (${view.defense.defenders.length})`
            : `Auto defense: your strongest ${view.defense.defenders.length}`;
        const sub = document.createElement("div");
        sub.className = "zteam-sub";
        sub.textContent =
          `Tier ${view.defense.tier} ${TIER_STARS(view.defense.tier)} defense. ` +
          "Stronger defenders give more boosts — hold the farm and the reward is yours.";
        info.append(head, sub, formation
          ? formationList(hud, view.defense.defenders)
          : defenseStrip(hud, view.defense.defenders));
        summary.appendChild(info);
        holder.appendChild(summary);
      }

      const actions = document.createElement("div");
      actions.className = "zbtns";
      const edit = document.createElement("button");
      edit.className = "zbtn deploy";
      edit.textContent = formation
        ? (view.defense?.authored ? "Choose defenders" : "Pick your defenders")
        : (view.defense?.authored ? "Edit line-up" : "Arrange a line-up");
      edit.onclick = () => openDefenseEditor(hud, view.unitIds, formation, () => {
        body.innerHTML = "";
        renderDefense();
      });
      actions.appendChild(edit);
      if (view.defense?.authored) {
        const auto = document.createElement("button");
        auto.className = "zbtn store";
        auto.textContent = "Use strongest automatically";
        auto.onclick = async () => {
          auto.disabled = true;
          const err = await (hud.onSavePvpDefense?.([]) ?? Promise.resolve("offline"));
          if (err) { hud.showToast("Couldn't update the defense."); auto.disabled = false; return; }
          hud.showToast("Defense set to automatic — your strongest stand guard.");
          body.innerHTML = "";
          renderDefense();
        };
        actions.appendChild(auto);
      }
      holder.appendChild(actions);
    })();
  };

  function openDefenseEditor(
    hudRef: Hud,
    currentIds: string[],
    /** Formation mode fills one job per class, so the picker enforces one per class.
     *  CLASSIC mode fields the saved order as-is, any six — the same restriction there
     *  would refuse a playable line-up, so the editor keeps its old free-pick shape. */
    formation: boolean,
    afterSave: () => void
  ) {
    const roster = hudRef.getRoster?.() ?? [];
    const { panel: editorPanel, close: closeEditor } = openModal({
      host: hudRef.el, bgClass: "pvp-edit-bg", replaceSelector: ".pvp-edit-bg",
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
    editorPanel.append(wrap);

    const cap = PVP_DEFENSE_CAP;
    const ownedIds = new Set(roster.map((z) => z.id));
    const byId = new Map(roster.map((z) => [z.id, z]));
    const roleOf = (id: string) => roleForGroup(byId.get(id)?.group);
    // ONE PER JOB. Each class fills its own job, so a second Regular has nowhere to
    // stand — picking one REPLACES the Regular already chosen rather than being
    // refused, which is the difference between a rule you can feel and one that just
    // says no. The server enforces the same thing per CLASS (`duplicate_class`), and
    // one class now maps to exactly one job, so the two rules are the same rule.
    let order: OrderSlots = [];
    for (const id of currentIds) {
      if (!ownedIds.has(id)) continue;
      if (formation) {
        const role = roleOf(id);
        if (!role || order.some((held) => held && roleOf(held) === role)) continue;
      }
      if (order.length < cap) order.push(id);
    }

    const title = document.createElement("h2");
    title.textContent = "Arrange your defense";
    const counter = document.createElement("span");
    counter.className = "army-count";
    head.append(title, counter);
    const blurb = document.createElement("p");
    blurb.className = "zteam-note";
    blurb.textContent = formation
      ? "One of each class — they each fill their own job."
      : "They walk out in the order you pick.";
    head.append(blurb);

    const save = document.createElement("button");
    save.className = "raid-go";
    markPrimary(save);

    const refresh = () => {
      const n = selectedCount(order);
      const filled = new Set(order.filter(Boolean).map((id) => roleOf(id!)));
      counter.textContent = formation ? `${n} / ${cap} jobs filled` : `${n} / ${cap} standing`;
      counter.classList.toggle("short", !n);
      const empty = DEFENSE_ROLES.filter((role) => !filled.has(role));
      if (formation) {
        blurb.textContent = empty.length === DEFENSE_ROLES.length
          ? "One of each class — they each fill their own job."
          : empty.length
            ? `No one on: ${empty.map((role) => ROLE_NAME[role]).join(", ")}.`
            : "Every job filled — a full formation.";
      }
      for (const card of grid.querySelectorAll<HTMLElement>(".army-card")) {
        const id = card.dataset.id!;
        const at = order.indexOf(id);
        const role = roleOf(id);
        card.classList.toggle("sel", at >= 0);
        // Someone else already holds this job: still clickable (it swaps), but shown
        // as taken so the one-per-class rule is visible before the click, not after.
        card.classList.toggle("taken", formation && at < 0 && !!role && filled.has(role));
        const tick = card.querySelector<HTMLElement>(".tick");
        if (tick) tick.textContent = at >= 0 ? String(at + 1) : "";
      }
      save.textContent = n ? `Save defense of ${n}` : "Pick at least one";
      save.disabled = !n;
    };

    if (!roster.length) {
      const empty = document.createElement("div");
      empty.className = "zr-empty";
      empty.textContent = "You do not own any zombies yet.";
      grid.appendChild(empty);
    }
    // Any owned zombie can stand in the defense — resting ones included: the
    // defense is a plan the server snapshots, not who happens to be on the lawn.
    // Ordered by job, so the grid itself reads as one job per class.
    const roleRank = (group: string | undefined) => {
      const role = roleForGroup(group);
      const at = role ? DEFENSE_ROLES.indexOf(role) : -1;
      return at < 0 ? DEFENSE_ROLES.length : at; // a class with no job sorts last
    };
    const ranked = [...roster].sort((a, b) =>
      roleRank(a.group) - roleRank(b.group)
      || a.typeName.localeCompare(b.typeName) || a.name.localeCompare(b.name));
    for (const z of ranked) {
      const card = document.createElement("div");
      card.className = "army-card";
      card.dataset.id = z.id;
      const por = document.createElement("div");
      por.className = "army-por";
      paintPortrait(por, hudRef, z);
      const nm = document.createElement("div");
      nm.className = "army-nm";
      nm.textContent = z.name;
      const ty = document.createElement("div");
      ty.className = "army-ty";
      ty.textContent = z.typeName;
      const job = document.createElement("div");
      job.className = "army-st pvp-job";
      const role = roleForGroup(z.group);
      job.textContent = formation ? (role ? ROLE_NAME[role] : "No job") : "";
      const where = document.createElement("div");
      where.className = "army-st zteam-where";
      where.textContent = z.stored ? "Resting" : "On farm";
      const tick = document.createElement("span");
      tick.className = "tick";
      card.append(tick, por, nm, ty, job, where);
      card.onclick = () => {
        if (!formation) { order = toggleSlot(order, z.id, cap); refresh(); return; }
        const mine = roleForGroup(z.group);
        if (!mine) return; // no job to stand in
        if (order.includes(z.id)) order = order.filter((id) => id !== z.id);
        // Taking a job the player already filled REPLACES its holder, so a click
        // always does something rather than silently failing at the cap.
        else order = [...order.filter((id) => !id || roleOf(id) !== mine), z.id].slice(0, cap);
        refresh();
      };
      grid.appendChild(card);
    }

    const strongest = document.createElement("button");
    strongest.className = "raid-quick";
    strongest.textContent = formation ? "One of each class" : "Fill with current farm";
    strongest.onclick = () => {
      if (!formation) {
        order = roster.filter((z) => !z.stored).slice(0, cap).map((z) => z.id);
        refresh();
        return;
      }
      // First zombie of each JOB, in job order — the same shape the server's auto
      // snapshot builds, so "fill" and "leave it to the game" agree.
      const picked = new Map<string, string>();
      for (const z of ranked) {
        const role = roleForGroup(z.group);
        if (role && !picked.has(role)) picked.set(role, z.id);
      }
      order = [...picked.values()].slice(0, cap);
      refresh();
    };
    const clear = document.createElement("button");
    clear.className = "raid-quick";
    clear.textContent = "Clear";
    clear.onclick = () => { order = []; refresh(); };

    save.onclick = async () => {
      const ids = compactOrder(order);
      if (!ids.length) return;
      save.disabled = true;
      const err = await (hudRef.onSavePvpDefense?.(ids) ?? Promise.resolve("offline"));
      if (err) {
        hudRef.showToast(err === "duplicate_class"
          ? "Only one zombie of each class can stand — they each fill their own job."
          : "Couldn't save the defense — try again in a moment.");
        save.disabled = false;
        return;
      }
      hudRef.showToast("Defense saved — that's the order they'll stand in.");
      closeEditor();
      afterSave();
    };

    foot.append(strongest, clear, save);
    refresh();
  }

  // ---- History ----------------------------------------------------------------

  const renderHistory = () => {
    const holder = document.createElement("div");
    holder.className = "pvp-list";
    holder.textContent = "Loading…";
    body.appendChild(holder);
    void loadOverview().then(() => {
      if (!holder.isConnected) return;
      holder.innerHTML = "";
      if (!overview) {
        holder.textContent = "Couldn't load the invasion history — try again in a moment.";
        return;
      }
      const view = overview;

      // Claim banner — the whole backlog, however old the fights.
      if (view.claim.count > 0) {
        const banner = document.createElement("div");
        banner.className = "zteam-row pvp-row pvp-claim";
        const info = document.createElement("div");
        info.className = "zteam-info";
        const head = document.createElement("div");
        head.className = "zteam-nm";
        head.textContent = `🛡 ${view.claim.count} defense${view.claim.count === 1 ? "" : "s"} held — reward waiting`;
        const sub = document.createElement("div");
        sub.className = "zteam-sub";
        sub.textContent = rewardLabel(hud, view.claim.rewards) || "Boost bundle";
        info.append(head, sub);
        const claim = document.createElement("button");
        claim.className = "zbtn deploy";
        claim.textContent = "Claim all";
        markPrimary(claim);
        claim.onclick = async () => {
          claim.disabled = true;
          const got = await (hud.onClaimAllPvpDefense?.() ?? Promise.resolve(null));
          if (!got || !got.claimed) {
            hud.showToast("Nothing could be claimed just now.");
            claim.disabled = false;
            return;
          }
          hud.showToast(`Defense rewards claimed: ${rewardLabel(hud, got.rewards)}!`, 6000);
          await loadOverview(true);
          body.innerHTML = "";
          renderHistory();
        };
        banner.append(info, claim);
        holder.appendChild(banner);
      }

      // Stats: lifetime and the trailing week, both roles.
      const stats = document.createElement("div");
      stats.className = "pvp-stats";
      const line = (label: string, s: PvpStatLineView) =>
        `${label}: attacks ${s.attackWins}W–${s.attackLosses}L · defenses ${s.defenseWins}W–${s.defenseLosses}L`;
      const lifetime = document.createElement("div");
      lifetime.className = "zteam-sub";
      lifetime.textContent = line("All time", view.stats.lifetime);
      const week = document.createElement("div");
      week.className = "zteam-sub";
      week.textContent = line("Last 7 days", view.stats.week);
      stats.append(lifetime, week);
      holder.appendChild(stats);

      const section = (label: string, rows: PvpFightRowView[], role: "attacker" | "defender") => {
        const hd = document.createElement("div");
        hd.className = "fr-inbox-h";
        hd.textContent = label;
        holder.appendChild(hd);
        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "zr-empty";
          empty.textContent = role === "attacker"
            ? "No attacks yet — scout a friend in the Attack tab."
            : "Nobody has invaded your farm yet.";
          holder.appendChild(empty);
          return;
        }
        for (const row of rows) {
          const el = document.createElement("div");
          el.className = "zteam-row pvp-row";
          const info = document.createElement("div");
          info.className = "zteam-info";
          const nm = document.createElement("div");
          nm.className = "zteam-nm";
          const who = document.createElement("b");
          who.textContent = row.otherName; // account-controlled → textContent
          const youWon = role === "attacker" ? row.attackerWon : !row.attackerWon;
          if (role === "attacker") {
            nm.append("⚔ You invaded ", who, row.attackerWon ? " — victory!" : " — repelled");
          } else {
            nm.append("🛡 ", who, row.attackerWon ? " raided your farm" : " was repelled!");
          }
          const sub = document.createElement("div");
          sub.className = "zteam-sub";
          const paid = youWon
            ? (row.rewarded ? (row.claimableTier ? "reward waiting" : "rewarded") : "past the daily cap — no reward")
            : "";
          sub.textContent = [ago(row.finishedAt), paid].filter(Boolean).join(" · ");
          info.append(nm, sub);
          el.appendChild(info);
          if (row.replayAvailable) {
            const watch = document.createElement("button");
            watch.className = "zbtn store";
            watch.textContent = "▶ Watch";
            watch.onclick = () => {
              close();
              hud.onWatchPvpReplay?.(row.sessionId);
            };
            el.appendChild(watch);
          }
          holder.appendChild(el);
        }
      };
      section("⚔ Your attacks", view.attacks, "attacker");
      section("🛡 Invasions against you", view.defenses, "defender");
    });
  };

  render();
  void loadOverview();
  // Pull a fresh friends list (levels included) and repaint the Attack tab if the
  // player is still looking at it — the cached list can predate this session.
  void hud.refreshFriends?.().then(() => {
    if (current === "Attack" && body.isConnected) render();
  }).catch(() => { /* cached list stands */ });
}
