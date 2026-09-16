import { describe, it, expect } from "vitest";
import {
  NO_SOCIAL_BADGES, badgeSummary, friendsBadge, invadedSinceSeen, invasionsBadge,
  socialBadge, type SocialBadges,
} from "./badges";

const badges = (over: Partial<SocialBadges> = {}): SocialBadges =>
  ({ ...NO_SOCIAL_BADGES, ...over });

describe("social badges", () => {
  it("lights nothing when nothing is waiting", () => {
    expect(socialBadge(NO_SOCIAL_BADGES)).toBe(false);
    expect(friendsBadge(NO_SOCIAL_BADGES)).toBe(false);
    expect(invasionsBadge(NO_SOCIAL_BADGES)).toBe(false);
    expect(badgeSummary(NO_SOCIAL_BADGES)).toBe("");
  });

  it("routes gifts and requests to Friends, invasions to Invasions", () => {
    expect(friendsBadge(badges({ gifts: 1 }))).toBe(true);
    expect(friendsBadge(badges({ requests: 1 }))).toBe(true);
    expect(friendsBadge(badges({ invaded: true }))).toBe(false);
    expect(invasionsBadge(badges({ invaded: true }))).toBe(true);
    expect(invasionsBadge(badges({ gifts: 3, requests: 2 }))).toBe(false);
  });

  it("lights the dock button for any of the three", () => {
    expect(socialBadge(badges({ gifts: 1 }))).toBe(true);
    expect(socialBadge(badges({ requests: 1 }))).toBe(true);
    expect(socialBadge(badges({ invaded: true }))).toBe(true);
  });

  it("treats an invasion as unseen only when it is newer than the mark", () => {
    expect(invadedSinceSeen(500, 400)).toBe(true);
    expect(invadedSinceSeen(500, 500)).toBe(false); // the one they just looked at
    expect(invadedSinceSeen(400, 500)).toBe(false);
    expect(invadedSinceSeen(null, 0)).toBe(false);  // never invaded
  });

  it("never lights retroactively on a device that has no mark yet", () => {
    // A fresh install marks itself seen at boot, so history does not arrive as news.
    // With no mark at all (0) an old invasion WOULD light — which is why the boot path
    // stamps the mark before the first paint. Pinned here so that stays deliberate.
    expect(invadedSinceSeen(1_000, 0)).toBe(true);
  });

  it("scopes the wording to the screen the dot actually opens", () => {
    const all = badges({ gifts: 2, requests: 1, invaded: true });
    expect(badgeSummary(all, "friends")).toBe("2 gifts waiting, 1 friend request");
    expect(badgeSummary(all, "invasions")).toBe("your farm was invaded");
    // Nothing in scope reads as nothing, even with the other surfaces lit.
    expect(badgeSummary(badges({ invaded: true }), "friends")).toBe("");
    expect(badgeSummary(badges({ gifts: 1 }), "invasions")).toBe("");
  });

  it("says what is waiting, pluralised", () => {
    expect(badgeSummary(badges({ gifts: 1 }))).toBe("1 gift waiting");
    expect(badgeSummary(badges({ gifts: 2 }))).toBe("2 gifts waiting");
    expect(badgeSummary(badges({ requests: 1 }))).toBe("1 friend request");
    expect(badgeSummary(badges({ gifts: 2, requests: 3, invaded: true })))
      .toBe("2 gifts waiting, 3 friend requests, your farm was invaded");
  });
});
