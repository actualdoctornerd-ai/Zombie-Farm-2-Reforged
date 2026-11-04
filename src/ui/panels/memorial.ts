import { msg as trMsg, t as tr } from "../../i18n";
// The Memorial Statue's panel.
//
// Two states, one entry point:
//   • Empty  — the graveyard: every zombie lost in an invasion and not revived,
//              newest first. Picking one carves it into the plinth.
//   • Filled — the enshrined zombie's inspect card, exactly as it read while it was
//              alive, and NOTHING else. The card is built with no unit id, which is
//              what makes it action-free (see buildZombieCard/buildZombieActions):
//              a memorial cannot deploy, store, rename or sell what it remembers.
//              There is no revive here, and there is no revive anywhere — the one
//              chance to keep a zombie is the offer made when the raid settles.
import type { Hud } from "../../hud";
import { markPrimary, openModal } from "../Modal";
import { onFirstVisible } from "../onFirstVisible";
import type { ZombieInfo } from "../hudTypes";
import { fallenDateLabel, type FallenZombie } from "../../zombie/memorial";
import { buildZombieCard } from "./zombies";

/** Everything the panel needs from the game, so it stays pure presentation. */
export interface MemorialView {
  /** Who stands on this plinth right now (null = empty). */
  occupant: FallenZombie | null;
  /** Fallen zombies not yet on a statue, newest first. */
  fallen: FallenZombie[];
  /** The inspect card for one fallen zombie, derived from the zombie catalog by the
   *  caller (which owns it). Everything the panel shows about a zombie comes from
   *  here, so the panel never has to know how a card is built. */
  cardOf: (fallen: FallenZombie) => ZombieInfo;
  /** Carve `fallenId` into this statue. Returns false if it could not be claimed. */
  onEnshrine: (fallenId: string) => boolean;
  /** Return the enshrined zombie to the graveyard, leaving the plinth bare. */
  onClear: () => void;
  /** Open the ordinary Move / Rotate / Store / Sell sheet for the statue. A tapped
   *  memorial opens THIS panel instead of that sheet, so without a way through to
   *  it the object would be unmovable and unsellable — which is exactly the trap
   *  every other functional building is in. */
  onObjectOptions: () => void;
}

/** Move / Store / Sell the plinth itself. Kept visually quieter than the memorial's
 *  own actions: this is about the furniture, not about who is on it. */
function objectOptionsButton(view: MemorialView, close: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "zbtn locate memorial-options";
  button.textContent = tr("Move / Store / Sell statue");
  button.onclick = () => { close(); view.onObjectOptions(); };
  return button;
}

/** Portrait tile that swaps in the unit's own mutation render once it is on screen
 *  and the extraction queue reaches it. Same deferral every other roster list uses:
 *  each render blocks the main thread, so nothing is asked for until it is visible. */
function portraitTile(hud: Hud, fallen: FallenZombie, src: string): HTMLImageElement {
  const portrait = document.createElement("img");
  portrait.src = src;
  portrait.alt = "";
  if (hud.zombieMutationPortraitOf) {
    onFirstVisible(portrait, () => {
      void hud.zombieMutationPortraitOf?.(fallen.key, fallen.mutation, fallen.color,
        () => portrait.isConnected)
        .then((image) => { if (portrait.isConnected) portrait.src = image; })
        .catch(() => { /* keep the static species portrait */ });
    });
  }
  return portrait;
}

export function openMemorialPanel(hud: Hud, view: MemorialView) {
  if (view.occupant) openEnshrined(hud, view, view.occupant);
  else openGraveyardPicker(hud, view);
}

/** The read-only card of the zombie this statue remembers. */
function openEnshrined(hud: Hud, view: MemorialView, occupant: FallenZombie) {
  const { panel, close } = openModal({ host: hud.el, panelClass: "zpanel" });

  const info = view.cardOf(occupant);
  const epitaph = document.createElement("div");
  epitaph.className = "memorial-epitaph";
  const date = fallenDateLabel(occupant);
  epitaph.textContent = date ? trMsg`In memory of ${info.name} — fell ${date}` : trMsg`In memory of ${info.name}`;

  panel.append(epitaph, buildZombieCard(hud, info, panel));

  const actions = document.createElement("div");
  actions.className = "zbtns";
  const clear = document.createElement("button");
  clear.className = "zbtn locate";
  clear.textContent = tr("Take off the plinth");
  clear.title = tr("Return them to the graveyard so this statue can remember someone else");
  clear.onclick = () => { close(); view.onClear(); };
  actions.append(clear, objectOptionsButton(view, close));
  panel.appendChild(actions);
}

/** The graveyard list, shown when the plinth is bare. */
function openGraveyardPicker(hud: Hud, view: MemorialView) {
  const { panel, close } = openModal({
    host: hud.el, panelClass: "memorial-panel", title: tr("Memorial Statue"),
  });

  const blurb = document.createElement("p");
  blurb.className = "memorial-blurb";

  const footer = document.createElement("div");
  footer.className = "zbtns";
  footer.appendChild(objectOptionsButton(view, close));

  if (!view.fallen.length) {
    blurb.textContent = tr("No zombie of yours has been lost. Nothing to remember yet.");
    panel.append(blurb, footer);
    return;
  }

  blurb.textContent = trMsg`Choose a zombie to carve in stone. They cannot come back — the statue is only so you remember them.`;
  panel.appendChild(blurb);

  const list = document.createElement("div");
  list.className = "memorial-list";
  for (const fallen of view.fallen) {
    const info = view.cardOf(fallen);
    const row = document.createElement("div");
    row.className = "memorial-row";
    const label = document.createElement("div");
    const name = document.createElement("div");
    name.className = "memorial-name";
    name.textContent = info.name;
    const meta = document.createElement("div");
    meta.className = "memorial-meta";
    const date = fallenDateLabel(fallen);
    meta.textContent = date ? trMsg`${tr(info.typeName)} · fell ${date}` : tr(info.typeName);
    label.append(name, meta);
    const pick = document.createElement("button");
    pick.className = "memorial-pick";
    pick.textContent = tr("Enshrine");
    pick.onclick = () => {
      pick.disabled = true;
      if (view.onEnshrine(fallen.id)) close();
      else pick.disabled = false;
    };
    row.append(portraitTile(hud, fallen, info.portrait), label, pick);
    list.appendChild(row);
  }
  panel.append(list, footer);
  const first = list.querySelector<HTMLButtonElement>(".memorial-pick");
  if (first) markPrimary(first);
}
