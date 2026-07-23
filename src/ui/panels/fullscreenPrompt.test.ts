import { describe, expect, it } from "vitest";
import {
  shouldOfferFullscreenPrompt,
  type FullscreenPromptEnvironment,
} from "./fullscreenPrompt";

const eligible: FullscreenPromptEnvironment = {
  mobile: true,
  signedIn: true,
  fullscreenEnabled: true,
  canRequestFullscreen: true,
  alreadyFullscreen: false,
  standalone: false,
};

describe("shouldOfferFullscreenPrompt", () => {
  it("offers fullscreen to a signed-in mobile browser", () => {
    expect(shouldOfferFullscreenPrompt(eligible)).toBe(true);
  });

  it.each([
    ["desktop", { mobile: false }],
    ["signed out", { signedIn: false }],
    ["fullscreen disabled", { fullscreenEnabled: false }],
    ["missing requestFullscreen", { canRequestFullscreen: false }],
    ["already fullscreen", { alreadyFullscreen: true }],
    ["installed standalone app", { standalone: true }],
  ])("does not offer when %s", (_label, patch) => {
    expect(shouldOfferFullscreenPrompt({ ...eligible, ...patch })).toBe(false);
  });
});
