import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

// workerd treats every named export of the Worker's ENTRY module as a service binding
// and refuses to start if one is not a function or an ExportedHandler:
//
//   service core:user:zombiefarm-server-staging: Uncaught TypeError: Incorrect type for
//   map entry 'MAX_PRESENTATION_BYTES': the provided value is not of type 'function or
//   ExportedHandler'.
//
// That is a TOTAL outage — every route, every player — and it is invisible to
// everything that guards this repo: `export const MAX_PRESENTATION_BYTES = 590208` in
// index.ts typechecks, bundles, and passes the whole test suite. It shipped once as a
// derived constant parked next to the handler that reads it, and only `wrangler dev`
// found it. Constants belong in a module index.ts IMPORTS (see presentationLimits.ts).
describe("the Worker entry module", () => {
  it("exports nothing workerd would reject as a service binding", () => {
    const offenders = Object.entries(entry)
      .filter(([name]) => name !== "default")
      .filter(([, value]) => typeof value !== "function")
      .map(([name, value]) => `${name}: ${typeof value}`);
    expect(offenders, "move these into a module index.ts imports").toEqual([]);
  });

  it("still exports the fetch handler", () => {
    expect(typeof (entry.default as { fetch?: unknown })?.fetch).toBe("function");
  });
});
