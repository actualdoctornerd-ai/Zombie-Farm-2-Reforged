import { msg as trMsg, t as tr } from "../../i18n";
// The announcement that an Epic Boss event has begun.
//
// It exists mainly for the events the player did NOT ask for. A favourite crop can lure
// its boss out of a plain harvest (epicBoss/favoriteCrops.ts), and online that roll is
// the server's — so the event arrives on a settle, some seconds after the harvest, with
// nothing on screen tying it to the crop that caused it. Without this the whole feature
// reads as "the Boss button changed colour at some point".
//
// A bought event opens it too. The same 14-day clock starts either way, and a player who
// just spent brains still wants to be told what they now own.
import { markPrimary, openModal } from "../Modal";

/** The run an adopted projection describes, reduced to what the announce rule reads. */
export interface AdoptedEpicBossRun {
  runId: string;
  /** The crop that lured it, if any. Only the server's own roll sets this. */
  startedCrop?: string;
  /** Whether the run is live right now (not completed, not expired). */
  active: boolean;
}

/** What the caller remembers between adoptions. */
export interface EpicBossAnnounceMemory {
  /** False until the first projection of the session has been adopted. */
  adopted: boolean;
  /** Runs already announced — including ones a purchase announced at its call site. */
  announced: ReadonlySet<string>;
}

/**
 * Should this newly adopted run pop the start announcement?
 *
 * Split out from the wiring because the wiring is a DOM call and this is the part that
 * can be wrong. Three rules, and each exists for a bug it prevents:
 *
 *  - Nothing announces before the first adoption. That one is the bootstrap, and an
 *    event that was already running when the game loaded is not news — without this,
 *    every reload during a 14-day event reopens the popup.
 *  - Only a run carrying `startedCrop` announces here. A bought event is announced by
 *    the code that bought it, which knows the purchase succeeded and does not have to
 *    infer it from a state change.
 *  - A run announces once. Settles are frequent and re-adopt the same projection.
 */
export function shouldAnnounceEpicBossStart(
  run: AdoptedEpicBossRun | null | undefined, memory: EpicBossAnnounceMemory
): boolean {
  if (!memory.adopted) return false;
  if (!run?.active || !run.startedCrop) return false;
  return !memory.announced.has(run.runId);
}

export interface EpicBossStartNotice {
  /** Boss display name. */
  name: string;
  /** Resolved portrait URL (epicAsset(def, def.portrait)). */
  portrait: string;
  /** Rungs in this event's ladder. */
  maxLevel: number;
  /** How long the event runs, in whole days. */
  days: number;
  /** Display name of the crop that lured this boss, or null when it was bought. */
  luredBy?: string | null;
  /** Opens the Epic Boss market tab. Wired to the primary button. */
  onView?: () => void;
}

/**
 * Announce a started event and resolve once the player dismisses it.
 *
 * Singleton by class: a second call replaces the first rather than stacking, which
 * matters because a settle can adopt the same activation twice (an optimistic local
 * start followed by the authoritative projection).
 */
export function showEpicBossStart(host: HTMLElement, notice: EpicBossStartNotice): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const { panel, close } = openModal({
      host,
      bgClass: "epic-start-bg",
      panelClass: "epic-start-panel",
      title: trMsg`${tr(notice.name)} has arrived!`,
      replaceSelector: ".epic-start-bg",
      onClose: finish,
    });

    const portrait = document.createElement("img");
    portrait.className = "epic-start-portrait";
    portrait.src = notice.portrait;
    portrait.alt = "";

    const lede = document.createElement("p");
    lede.className = "epic-start-lede";
    lede.textContent = notice.luredBy ? trMsg`Your ${tr(notice.luredBy)} harvest drew ${tr(notice.name)} onto the farm. The event is yours — you paid nothing for it.` : trMsg`${tr(notice.name)} has set up on the farm.`;

    const detail = document.createElement("p");
    detail.textContent = trMsg`You have ${notice.days} day${notice.days === 1 ? "" : tr("s")} to fight through all ${notice.maxLevel} levels. Damage carries between attempts, and harvesting crops during the event earns Boss Tokens to pay for them.`;

    const buttons = document.createElement("div");
    buttons.className = "zbtns";
    const view = document.createElement("button");
    view.className = "zbtn sell";
    view.textContent = tr("View Event");
    markPrimary(view); // Enter opens it
    view.onclick = () => {
      finish();
      close();
      notice.onView?.();
    };
    const later = document.createElement("button");
    later.className = "zbtn locate";
    later.textContent = tr("Later");
    later.onclick = () => close();
    buttons.append(later, view);

    panel.append(portrait, lede, detail, buttons);
  });
}
