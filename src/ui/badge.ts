// The red dot. One implementation, used by every surface that can carry one, so a
// badge on the menu dock and a badge on a panel tab are literally the same element
// with the same clearing rule.
//
// `setBadge` is idempotent and reversible: calling it with `on: false` removes the dot
// and its announcement together. That matters because these are repainted from live
// state on every refresh rather than toggled by hand — a caller is always allowed to
// just say what is true now.
//
// The dot itself is drawn entirely in CSS and carries no visible text: what it means
// lives in a clipped span inside it (so a screen reader reaches real content, not an
// aria-label on an empty element) and in the host's tooltip.

/** Put a dot on `host` (or take it off). `label` is what the dot means, in words.
 *  `host` must be positioned — the dot is absolute — which every call site already is. */
export function setBadge(host: HTMLElement, on: boolean, label: string): void {
  const existing = host.querySelector<HTMLElement>(":scope > .ui-badge");
  if (!on || !label) {
    existing?.remove();
    // Only ever restores a title this helper replaced: a call site with its own
    // tooltip gets it back, one without keeps having none.
    if (host.dataset.badgeTitle !== undefined) {
      host.title = host.dataset.badgeTitle;
      delete host.dataset.badgeTitle;
    }
    return;
  }
  const dot = existing ?? document.createElement("span");
  if (!existing) {
    dot.className = "ui-badge";
    dot.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "ui-badge-text";
    dot.appendChild(text);
    host.dataset.badgeTitle = host.title;
    host.appendChild(dot);
  }
  dot.querySelector<HTMLElement>(".ui-badge-text")!.textContent = label;
  const own = host.dataset.badgeTitle;
  host.title = own ? `${own} — ${label}` : label;
}
