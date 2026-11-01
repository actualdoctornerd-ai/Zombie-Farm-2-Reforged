import type { Hud } from "../../hud";
import type { EndlessLeaderboardEntry } from "../../net/api";
import { mutationLabelFor } from "../../zombie/mutationDisplay";
import { VET_RANKS } from "../../zombie/traits";
import { openModal } from "../Modal";

type Mode = "endless" | "nightmare";

const medal = (rank: number): string =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function friendlySpecies(species: string): string {
  return species.replace(/^ZombieActor/, "").replace(/Actor/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/Tier(\d+)/g, "T$1").trim() || "Zombie";
}

export function openEndlessLeaderboardPanel(hud: Hud): void {
  const { panel, close } = openModal({
    host: hud.el,
    bgClass: "raid-bg endless-lb-bg",
    panelClass: "endless-lb-panel",
    title: "Endless Leaderboard",
    replaceSelector: ".endless-lb-bg",
  });

  const subtitle = document.createElement("p");
  subtitle.className = "endless-lb-subtitle";
  subtitle.textContent = "Top 25 personal bests · deepest floor ranks first · time breaks ties";
  const modeTabs = document.createElement("div");
  modeTabs.className = "endless-lb-tabs";
  const status = document.createElement("div");
  status.className = "endless-lb-status";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "endless-lb-list";
  list.setAttribute("aria-label", "Endless leaderboard entries");
  panel.append(subtitle, modeTabs, status, list);

  let mode: Mode = "endless";
  let entries: EndlessLeaderboardEntry[] | null = null;
  let loading = false;
  let failed = false;
  let requestSerial = 0;

  const showEmpty = (message: string) => {
    status.textContent = message;
    list.replaceChildren();
  };

  const renderRows = () => {
    list.replaceChildren();
    if (loading) { showEmpty("Loading records…"); return; }
    if (failed || entries === null) {
      showEmpty("Couldn’t load the leaderboard.");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "endless-lb-retry";
      retry.textContent = "Try again";
      retry.onclick = () => { void load(); };
      list.appendChild(retry);
      return;
    }
    status.textContent = entries.length ? `${entries.length} of 25 records` : "No completed runs yet. Be the first to set a record!";
    if (!entries.length) return;

    const headings = document.createElement("div");
    headings.className = "endless-lb-headings";
    headings.innerHTML = "<span>Rank</span><span>Player</span><span>Best</span><span>Time</span><span>Army</span>";
    list.appendChild(headings);

    for (const entry of entries) {
      const card = document.createElement("section");
      card.className = "endless-lb-entry";
      if (entry.rank <= 3) card.classList.add(`endless-lb-podium-${entry.rank}`);

      const row = document.createElement("div");
      row.className = "endless-lb-row";
      const rank = document.createElement("span");
      rank.className = "endless-lb-rank";
      rank.textContent = medal(entry.rank);
      const name = document.createElement("span");
      name.className = "endless-lb-name";
      name.textContent = entry.name.trim() || "Player";
      const depth = document.createElement("span");
      depth.className = "endless-lb-depth";
      const tier = Math.ceil(Math.max(0, entry.deepestFloor) / 4);
      depth.textContent = `T${tier} · Floor ${entry.deepestFloor}`;
      const time = document.createElement("span");
      time.className = "endless-lb-time";
      time.textContent = formatDuration(entry.durationMs);
      time.title = "Run time · tie-breaker";
      const armyToggle = document.createElement("button");
      armyToggle.type = "button";
      armyToggle.className = "endless-lb-army-toggle";
      armyToggle.textContent = `Army (${entry.army.length})`;
      armyToggle.setAttribute("aria-expanded", "false");
      row.append(rank, name, depth, time, armyToggle);

      const army = document.createElement("div");
      army.className = "endless-lb-army";
      army.hidden = true;
      if (!entry.army.length) {
        const empty = document.createElement("p");
        empty.textContent = "Army details unavailable for this record.";
        army.appendChild(empty);
      } else {
        entry.army.forEach((member, index) => {
          const unit = document.createElement("div");
          unit.className = "endless-lb-unit";
          const position = document.createElement("span");
          position.className = "endless-lb-position";
          position.textContent = String(index + 1).padStart(2, "0");
          const details = document.createElement("span");
          details.className = "endless-lb-unit-details";
          const species = document.createElement("strong");
          species.textContent = friendlySpecies(member.species);
          const traits = document.createElement("span");
          const mutations = mutationLabelFor(member.species, member.mutation);
          traits.textContent = `${mutations || "No mutations"} · ${VET_RANKS[Math.max(0, Math.min(VET_RANKS.length - 1, Math.floor(member.veterancy)))]}`;
          details.append(species, traits);
          unit.append(position, details);
          army.appendChild(unit);
        });
      }
      armyToggle.onclick = () => {
        const expanded = armyToggle.getAttribute("aria-expanded") === "true";
        armyToggle.setAttribute("aria-expanded", String(!expanded));
        armyToggle.textContent = expanded ? `Army (${entry.army.length})` : "Hide army";
        army.hidden = expanded;
      };
      card.append(row, army);
      list.appendChild(card);
    }
  };

  const load = async () => {
    const serial = ++requestSerial;
    loading = true; failed = false; entries = null;
    renderRows();
    try {
      entries = await hud.getEndlessLeaderboard?.(mode) ?? [];
      failed = false;
    } catch {
      failed = true;
    }
    if (!panel.isConnected || serial !== requestSerial) return;
    loading = false;
    renderRows();
  };

  const renderTabs = () => {
    modeTabs.replaceChildren();
    for (const [value, label] of [["endless", "Normal"], ["nightmare", "Nightmare"]] as const) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "endless-lb-tab";
      tab.textContent = label;
      tab.setAttribute("aria-pressed", String(value === mode));
      if (value === mode) tab.classList.add("selected");
      tab.onclick = () => {
        if (value === mode) return;
        mode = value;
        renderTabs();
        void load();
      };
      modeTabs.appendChild(tab);
    }
  };

  renderTabs();
  void load();
  // Keep the backdrop-to-close behavior from openModal, but give this panel an
  // explicit close affordance that returns to the still-open Endless hub.
  panel.querySelector<HTMLButtonElement>(".panelclose")?.addEventListener("click", close);
}
