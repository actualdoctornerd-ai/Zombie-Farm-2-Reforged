import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../src/v3/epicBoss.ts", import.meta.url)),
  "utf8",
);

// Concentration on an epic fight buys the auto-release: the brain bubble fills and
// goes on its own. That changes the charge pace, so it changes the fight — which means
// the flag has to survive the round trip the same way a raid's does, or the verified
// replay settles a different fight than the one the player watched.
describe("Concentration on an Epic Boss", () => {
  it("is pinned into the session config, not read off the finish request", () => {
    const start = source.match(/const config: EpicCombatConfig = \{[\s\S]*?\};/)?.[0];
    expect(start, "the epic config literal has been reshaped").toBeTruthy();
    expect(start).toMatch(/concentration: true/);
    const finish = source.match(/const verified = replayRaid\(buildFight\(\{[\s\S]*?\}\)/)?.[0];
    expect(finish, "the epic verifier call has been reshaped").toBeTruthy();
    // Off the PINNED config. `body.concentration` here would be the client grading
    // its own homework.
    expect(finish).toMatch(/concentration: config\.concentration === true/);
    expect(finish).not.toMatch(/body\.concentration/);
  });

  it("defaults to off for a session opened before the boost reached epic bosses", () => {
    // Such a session has no field at all, so the replay must read it as false and
    // settle exactly as it always did — not refuse, and not silently auto-release.
    expect(source).toMatch(/concentration\?: boolean;/);
    expect(source).toMatch(/concentration: config\.concentration === true/);
  });

  it("charges the boost against the inventory copy that is written back", () => {
    const start = source.match(/const concentration = useConcentration === true;[\s\S]*?const config: EpicCombatConfig/)?.[0];
    expect(start, "the epic start block has been reshaped").toBeTruthy();
    expect(start).toContain("core.inventory[CONCENTRATION_KEY]");
    expect(start).toMatch(/no_concentration/);
    // The debit is worthless unless the document is persisted.
    expect(source).toMatch(/if \(concentration\) \{[\s\S]*?UPDATE gameplay_documents_v3 SET current_json/);
  });

  it("reports the LIVE session's boost on a resume, not the caller's toggle", () => {
    // A resume adopts the fight already pinned to the open session. If the client
    // re-decided from its own toggle it could simulate at a different charge pace than
    // the verifier replays, and the finish would 422 with the attempt already paid for.
    const resume = source.match(/if \(epic\) \{[\s\S]*?battle_in_progress/)?.[0];
    expect(resume, "the epic resume branch has been reshaped").toBeTruthy();
    expect(resume).toMatch(/resumed: true/);
    expect(resume).toMatch(/concentration: resumedConfig\?\.concentration === true/);
  });

  it("only rewrites the gameplay document when a boost was actually spent", () => {
    // An ordinary attempt must not touch the gameplay document: it would race the
    // player's own command batches for no reason.
    const write = source.match(/UPDATE gameplay_documents_v3 SET current_json[\s\S]{0,120}/)?.[0];
    expect(write).toBeTruthy();
    expect(source).toMatch(/if \(concentration\) \{\s*\n\s*statements\.push/);
  });
});
