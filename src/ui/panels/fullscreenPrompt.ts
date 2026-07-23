import type { Hud } from "../../hud";
import { openModal } from "../Modal";

export interface FullscreenPromptEnvironment {
  mobile: boolean;
  signedIn: boolean;
  fullscreenEnabled: boolean;
  canRequestFullscreen: boolean;
  alreadyFullscreen: boolean;
  standalone: boolean;
}

/** Keep the startup offer limited to signed-in mobile browser sessions where it
 * can actually do something. Installed PWAs and an already-fullscreen page have
 * no browser chrome to remove, so prompting there would only be noise. */
export function shouldOfferFullscreenPrompt(env: FullscreenPromptEnvironment): boolean {
  return env.mobile &&
    env.signedIn &&
    env.fullscreenEnabled &&
    env.canRequestFullscreen &&
    !env.alreadyFullscreen &&
    !env.standalone;
}

function isStandalone(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return iosNavigator.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
}

export function offerFullscreenPrompt(hud: Hud, mobile: boolean, signedIn: boolean): void {
  if (!shouldOfferFullscreenPrompt({
    mobile,
    signedIn,
    fullscreenEnabled: document.fullscreenEnabled,
    canRequestFullscreen: typeof document.documentElement.requestFullscreen === "function",
    alreadyFullscreen: document.fullscreenElement !== null,
    standalone: isStandalone(),
  })) return;

  const { bg, panel, close } = openModal({
    host: hud.el,
    bgClass: "fullscreen-prompt-bg",
    panelClass: "fullscreen-prompt-panel",
    title: "Play Fullscreen?",
    replaceSelector: ".fullscreen-prompt-bg",
  });

  // This modal deliberately sits above the tutorial and writer-lock gate. Stop
  // its pointer/click events here as a second line of defence: interacting with
  // it must never reach the tutorial blocker or the Pixi game canvas underneath.
  for (const eventName of ["pointerdown", "pointerup", "click"]) {
    bg.addEventListener(eventName, (event) => event.stopPropagation());
  }

  const copy = document.createElement("p");
  copy.textContent =
    "Fullscreen gives your farm more room and hides the browser controls. You can toggle it anytime in Settings.";

  const status = document.createElement("div");
  status.className = "fullscreen-prompt-status";

  const buttons = document.createElement("div");
  buttons.className = "zbtns fullscreen-prompt-actions";

  const dismiss = document.createElement("button");
  dismiss.className = "zbtn locate";
  dismiss.textContent = "Not Now";
  dismiss.onclick = close;

  const enter = document.createElement("button");
  enter.className = "zbtn sell";
  enter.textContent = "Go Fullscreen";
  enter.onclick = async () => {
    enter.disabled = true;
    status.textContent = "";
    try {
      await hud.toggleFullscreen();
      close();
    } catch {
      enter.disabled = false;
      enter.textContent = "Try Again";
      status.textContent = "Your browser couldn't enter fullscreen.";
    }
  };

  buttons.append(dismiss, enter);
  panel.append(copy, status, buttons);
}
