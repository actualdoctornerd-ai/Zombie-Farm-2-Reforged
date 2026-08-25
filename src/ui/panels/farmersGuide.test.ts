import { describe, expect, it } from "vitest";
import { FARMERS_GUIDE_PAGES } from "./farmersGuide";

describe("Farmer's Guide", () => {
  it("has unique, navigable pages for every requested topic", () => {
    expect(FARMERS_GUIDE_PAGES.map((page) => page.id)).toEqual([
      "welcome", "saves", "install", "currency", "mutations", "combat", "social", "privacy", "project",
    ]);
    expect(new Set(FARMERS_GUIDE_PAGES.map((page) => page.id)).size)
      .toBe(FARMERS_GUIDE_PAGES.length);

    const copy = FARMERS_GUIDE_PAGES
      .flatMap((page) => [page.title, page.intro, ...page.sections.flatMap((section) => [section.title, section.body])])
      .join(" ");
    for (const topic of ["Local Farm", "Online Farm", "Gold", "Brains", "Mutations", "Raids", "Epic Bosses", "Discord", "GitHub", "alpha tester", "Add to Home Screen"])
      expect(copy.toLowerCase()).toContain(topic.toLowerCase());
  });

  // The privacy page is the one place the game makes promises ABOUT ITSELF to a player, so
  // each promise is pinned to the code that has to keep it. A change that breaks one of
  // these should fail here rather than quietly turn the page into a lie:
  //   - email/name discarded      -> server/src/auth.ts reads only `sub`
  //   - no IP or email stored     -> the `accounts` / `sessions` columns in server/schema.sql
  //   - name visible to strangers -> `creator_name` on every Black Market listing query
  //   - diagnostics never sent    -> the local-only contract in src/diagnostics.ts
  //   - deletion on request       -> POST /account/delete (server/src/accountDeletion.ts),
  //                                  itself held to schema.sql by accountDeletion.test.ts
  it("keeps the privacy promises it makes, and makes them findable", () => {
    const privacy = FARMERS_GUIDE_PAGES.find((page) => page.id === "privacy");
    expect(privacy, "the Privacy page must exist").toBeDefined();

    const copy = [privacy!.title, privacy!.intro, ...privacy!.sections.flatMap((s) => [s.title, s.body])]
      .join(" ")
      .toLowerCase();

    for (const promise of [
      "email address",      // stated as never stored
      "never stored",
      "ip addresses",       // stated as not stored
      "black market",       // the one place a stranger sees the player's name
      "no advertising",
      "copy diagnostics",   // the local-only crash record
      "delete",             // the removal route — matches "delete"/"deleted"/"delete button"
      "permanent",          // ...and that it is stated as irreversible, not just offered
      "export",             // the data-portability route
    ])
      expect(copy, `privacy page must still address "${promise}"`).toContain(promise);
  });
});
