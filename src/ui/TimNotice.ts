import { t as tr } from "../i18n";
// Tim Buckwheat delivering a one-off piece of guidance OUTSIDE the first-run
// tutorial — today, the hazard warning before the player's first invasion that
// fields one.
//
// It reuses the TutorialController's portrait and speech bubble (.tut-tim /
// .tut-tim-sprite / .tut-bubble) so Tim looks and slides in exactly as he does
// during the tutorial, but it is deliberately NOT part of that layer: the
// tutorial is a persisted state machine that gates farm input and hides itself
// during raids, while this is a self-contained one-shot dismissed by an explicit
// OK button. Wrapping it in `.tut-layer` would also inherit
// `.invasion-menu-open .tut-tim { display: none }` — and the invasion menu is
// exactly what is open when this fires.
import { BASE } from "../base";

/** Matches the .tut-tim slide transition, so the notice is gone from the screen
 *  before the caller moves on (the raid scene mounts straight after). */
const SLIDE_OUT_MS = 300;

/**
 * Slide Tim up with `message` and resolve once the player acknowledges it —
 * the OK button, the backdrop, Enter, or Escape. Any existing notice is
 * replaced, so a second call can never stack two Tims.
 *
 * @param host  the HUD root (styles are scoped under `#hud`).
 */
export function showTimNotice(host: HTMLElement, message: string, buttonLabel = "OK"): Promise<void> {
  return new Promise((resolve) => {
    host.querySelector(".tim-notice-bg")?.remove();

    const bg = document.createElement("div");
    bg.className = "tim-notice-bg";

    const tim = document.createElement("div");
    tim.className = "tut-tim";
    const sprite = document.createElement("img");
    sprite.className = "tut-tim-sprite";
    sprite.src = `${BASE}assets/tutorial/farmer.png`;
    sprite.alt = "";

    const bubble = document.createElement("div");
    bubble.className = "tut-bubble";
    const text = document.createElement("span");
    text.textContent = tr(message);
    const ok = document.createElement("button");
    ok.className = "zbtn sell tim-notice-ok";
    ok.type = "button";
    ok.textContent = tr(buttonLabel);
    bubble.append(text, ok);
    tim.append(sprite, bubble);
    bg.appendChild(tim);
    host.appendChild(bg);

    let settled = false;
    const dismiss = () => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      tim.classList.remove("in"); // slide back down, then drop the whole layer
      window.setTimeout(() => {
        bg.remove();
        resolve();
      }, SLIDE_OUT_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };

    ok.onclick = (e) => { e.stopPropagation(); dismiss(); };
    bg.onclick = () => dismiss(); // clicking away from Tim also acknowledges
    tim.onclick = (e) => e.stopPropagation(); // ...but tapping Tim himself does not
    document.addEventListener("keydown", onKey);

    // Flush layout so the transition has a start value to animate from. This is
    // deliberately NOT requestAnimationFrame: a backgrounded tab never runs rAF, so
    // the class would never land and Tim would stay parked off-screen behind a
    // scrim that covers the game.
    void tim.offsetHeight;
    tim.classList.add("in");
  });
}
