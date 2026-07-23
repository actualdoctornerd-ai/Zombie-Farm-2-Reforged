// Self-contained HUD popups: the level-up and quest-complete celebrations, the
// object action sheet, and the generic info panel. These render pure view-model
// data into `host` (the HUD root) and need nothing else from the Hud class, so
// they live here as plain functions rather than methods. Hud keeps thin
// open*/openPanel wrappers that forward to these.
import { openModal } from "../Modal";
import { UI } from "../uiAsset";
import type { LevelUpView, QuestCompleteView, ObjectActions } from "../hudTypes";

/** Celebratory "LEVEL UP" popup listing what the new level unlocked. */
export function renderLevelUp(host: HTMLElement, view: LevelUpView): void {
  // No corner close button — the popup sets panel.innerHTML (which would wipe it)
  // and is dismissed by its own Continue button or a backdrop click.
  const { panel, close } = openModal({
    host, bgClass: "lvl-bg", panelClass: "lvlup",
    closeButton: false, replaceSelector: ".lvl-bg",
  });

  const brainRow = view.brains
    ? `<div class="lvl-reward"><img src="${UI("topbar_brain_icon.png")}"> +${view.brains} ` +
      `${view.brains === 1 ? "brain" : "brains"}</div>`
    : "";
  const unlockHtml = view.unlocks.length
    ? `<div class="lvl-sub">Unlocked</div><div class="lvl-unlocks">${view.unlocks
        .map(
          (u) =>
            `<span class="lvl-slot" title="${u.name}"><span class="lvl-frame">` +
            `<img src="${u.icon}" onerror="this.style.visibility='hidden'"></span>` +
            `<span class="lvl-nm">${u.name}</span><span class="lvl-tag">${u.kind}</span></span>`
        )
        .join("")}</div>`
    : `<div class="lvl-none">Nothing new this level — keep going!</div>`;

  panel.innerHTML =
    `<div class="lvl-burst">LEVEL UP!</div>` +
    `<div class="lvl-num">You reached level ${view.level}</div>` +
    brainRow +
    unlockHtml;

  const done = document.createElement("button");
  done.className = "lvl-go";
  done.textContent = "Continue";
  done.onclick = () => close();
  panel.appendChild(done);
  requestAnimationFrame(() => panel.classList.add("in"));
}

/** Celebratory "QUEST COMPLETE" popup. `onClosed` advances the queued-completion
 *  chain owned by main.ts (quests can complete in bursts). */
export function renderQuestComplete(
  host: HTMLElement, view: QuestCompleteView, onClosed?: () => void
): void {
  // Deliberately non-dismissible by backdrop/close — only the OK button
  // acknowledges it. onClose advances the queued-completion chain.
  const { panel, close } = openModal({
    host, bgClass: "qc-bg", panelClass: "questdone",
    closeButton: false, backdropClose: false, replaceSelector: ".qc-bg",
    onClose: () => onClosed?.(),
  });

  const rewardHtml = view.rewards.length
    ? `<div class="qc-sub">Reward</div><div class="qc-rewards">${view.rewards
        .map(
          (r) =>
            `<span class="qc-reward"><img src="${r.icon}" onerror="this.style.visibility='hidden'">` +
            `${r.label}</span>`
        )
        .join("")}</div>`
    : "";

  panel.innerHTML =
    `<div class="qc-icon"><img src="${UI(view.icon)}" onerror="this.style.visibility='hidden'"></div>` +
    `<div class="qc-burst">QUEST COMPLETE!</div>` +
    `<div class="qc-title">${view.title}</div>` +
    (view.message ? `<div class="qc-msg">${view.message}</div>` : "") +
    rewardHtml;

  const done = document.createElement("button");
  done.className = "lvl-go";
  done.textContent = "OK";
  // Quest completions may appear while the player is mid-action; the explicit OK
  // button is the only way to acknowledge (and advance to the next queued one).
  done.onclick = () => close();
  panel.appendChild(done);
  requestAnimationFrame(() => panel.classList.add("in"));
}

/** Compact Move / Rotate / Store / Sell action sheet for a tapped farm object. */
export function renderObjectActions(host: HTMLElement, o: ObjectActions): void {
  const { panel, close } = openModal({ host, panelClass: "obj-actions", title: o.name });

  const por = document.createElement("div");
  por.className = "obj-por";
  if (o.portrait) por.style.backgroundImage = `url(${o.portrait})`;

  const btns = document.createElement("div");
  btns.className = "zbtns";
  const mk = (label: string, cls: string, enabled: boolean, fn: () => void) => {
    const b = document.createElement("button");
    b.className = `zbtn ${cls}`;
    b.textContent = label;
    b.disabled = !enabled;
    b.onclick = () => { close(); fn(); };
    return b;
  };
  btns.append(
    mk("Move", "locate", true, o.onMove),
    mk("Rotate", "locate", true, o.onRotate),
    mk(o.canStore ? "Store" : "Storage full", "store", o.canStore, o.onStore)
  );
  if (o.canSell) btns.append(
    mk(`Sell +${o.sellRefund}${o.sellBrains ? "b" : "g"}`, "sell", true, o.onSell)
  );
  panel.append(por, btns);
}

/** Generic titled info panel (title + one paragraph of body text). */
export function renderInfoPanel(host: HTMLElement, title: string, body: string): void {
  const { panel } = openModal({ host, title });
  const p = document.createElement("p");
  p.textContent = body;
  panel.append(p);
}
