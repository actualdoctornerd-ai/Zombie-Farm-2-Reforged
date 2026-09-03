// The Daily & Weekly quests panel.
//
// Deliberately NOT part of the catalog quest rail. Those are a progression chain that
// grants itself the moment the last objective lands; these expire on a clock and have
// to be collected, so the two need different affordances — a countdown and a Claim
// button here, neither of which the rail has any use for.
//
// Pure presentation: everything it knows arrives in PeriodicQuestPanelView, and the
// only thing it can do is call onClaim.

import { markPrimary, openModal, type ModalHandle } from "../Modal";
import { UI } from "../uiAsset";
import type { PeriodicScope, PeriodicScopeView } from "../../quest/periodic/types";

export interface PeriodicQuestPanelView {
  scopes: PeriodicScopeView[];
  /** Collect a finished quest. The panel redraws from the caller's next render. */
  onClaim: (scope: PeriodicScope, questId: string) => void;
}

const SCOPE_TITLE: Record<PeriodicScope, string> = {
  daily: "Daily",
  weekly: "Weekly",
};

/** "2d 4h" / "4h 12m" / "12m" — coarse on purpose. A second-by-second countdown on a
 *  board that only matters at midnight is noise, and it would force a 1Hz redraw. */
export function formatPeriodRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m`;
}

function questRow(
  quest: PeriodicScopeView["quests"][number],
  view: PeriodicQuestPanelView
): HTMLElement {
  const row = document.createElement("div");
  row.className = "pq-row" + (quest.claimed ? " claimed" : quest.done ? " done" : "");

  const icon = document.createElement("img");
  icon.src = UI(quest.icon);
  icon.alt = "";
  icon.onerror = () => { icon.style.visibility = "hidden"; };

  const body = document.createElement("div");
  body.className = "pq-body";
  const text = document.createElement("div");
  text.className = "pq-text";
  text.textContent = quest.text;
  const meter = document.createElement("div");
  meter.className = "pq-meter";
  const fill = document.createElement("span");
  fill.style.width = `${Math.round((quest.count / Math.max(1, quest.total)) * 100)}%`;
  meter.appendChild(fill);
  const count = document.createElement("div");
  count.className = "pq-count";
  count.textContent = `${quest.count} / ${quest.total}`;
  body.append(text, meter, count);

  const reward = document.createElement("div");
  reward.className = "pq-reward";
  const rewardIcon = document.createElement("img");
  rewardIcon.src = UI("topbar_level_icon.png");
  rewardIcon.alt = "";
  rewardIcon.onerror = () => { rewardIcon.style.visibility = "hidden"; };
  const rewardLabel = document.createElement("span");
  rewardLabel.textContent = `+${quest.xp} XP`;
  reward.append(rewardIcon, rewardLabel);

  const action = document.createElement("div");
  action.className = "pq-action";
  if (quest.claimed) {
    const claimed = document.createElement("span");
    claimed.className = "pq-claimed";
    claimed.textContent = "✓ Claimed";
    action.appendChild(claimed);
  } else if (quest.done && quest.pending) {
    // Finished by this client's own events, not yet by the server's count. The bar is
    // full; the Claim waits for the confirmation that is already on its way.
    const confirming = document.createElement("span");
    confirming.className = "pq-confirming";
    confirming.textContent = "Confirming…";
    confirming.title = "Waiting for the server to confirm this quest";
    action.appendChild(confirming);
  } else if (quest.done) {
    const claim = markPrimary(document.createElement("button"));
    claim.className = "zbtn pq-claim";
    claim.type = "button";
    claim.textContent = "Claim";
    claim.onclick = () => view.onClaim(quest.scope, quest.id);
    action.appendChild(claim);
  }

  row.append(icon, body, reward, action);
  return row;
}

function scopeSection(scope: PeriodicScopeView, view: PeriodicQuestPanelView, now: number): HTMLElement {
  const section = document.createElement("section");
  section.className = `pq-scope pq-${scope.scope}`;
  const heading = document.createElement("div");
  heading.className = "pq-heading";
  const title = document.createElement("span");
  title.className = "pq-title";
  title.textContent = SCOPE_TITLE[scope.scope];
  const timer = document.createElement("span");
  timer.className = "pq-timer";
  timer.textContent = `Resets in ${formatPeriodRemaining(scope.endsAt - now)}`;
  heading.append(title, timer);
  section.appendChild(heading);
  for (const quest of scope.quests) section.appendChild(questRow(quest, view));
  return section;
}

/** Rebuild the panel body in place. Split out so a claim can redraw without the modal
 *  being torn down and reopened under the player's finger. */
export function renderPeriodicQuests(
  panel: HTMLElement,
  view: PeriodicQuestPanelView,
  now = Date.now()
): void {
  panel.querySelector(".pq-list")?.remove();
  const list = document.createElement("div");
  list.className = "pq-list";
  if (!view.scopes.length) {
    const empty = document.createElement("div");
    empty.className = "pq-empty";
    // Both unlock levels live in quest/periodic/generate; the copy stays vague rather
    // than repeating a number that would then have two homes.
    empty.textContent = "Daily and weekly quests unlock as you level up your farm.";
    list.appendChild(empty);
  }
  for (const scope of view.scopes) list.appendChild(scopeSection(scope, view, now));
  panel.appendChild(list);
}

export function openPeriodicQuests(
  host: HTMLElement,
  view: PeriodicQuestPanelView,
  onClose: () => void
): ModalHandle {
  const handle = openModal({
    host,
    panelClass: "periodicquests",
    replaceSelector: ".panel.periodicquests",
    title: "Daily & Weekly",
    onClose,
  });
  renderPeriodicQuests(handle.panel, view);
  return handle;
}
