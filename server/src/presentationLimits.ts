// Size bounds for the presentation blob.
//
// These live in their OWN module rather than beside the route that enforces them,
// because index.ts is the Worker's entry module: workerd treats every named export of
// it as a service binding and refuses to start the Worker if one is not a function or
// an ExportedHandler ("Incorrect type for map entry 'X': the provided value is not of
// type 'function or ExportedHandler'"). A plain `export const` of a number there takes
// the whole service down at boot — and nothing catches it, because it is not a type
// error, not a test failure and not a build failure. Only running the Worker finds it.
// So: constants here, handlers there.
import { MAX_FUNCTIONAL_OBJECTS } from "./v3/engine";

// ---- the byte ceiling -------------------------------------------------------
//
// The presentation blob is validated and stored WHOLESALE: one part of it over a
// bound and the ENTIRE write is refused — object positions, zombie names, teams,
// Almanac, camera, lifetime tally, all of it — and the client then retries the same
// blob every minute and is refused every time, silently and for good. So a ceiling
// that sits below what a legal farm sends is not a limit, it is a permanent loss of
// presentation saving for whoever crosses it. This used to be a literal 128 KB, which
// is the same mistake as the literal 512 the object-layout bound once carried: a
// second, independently-written copy of a number someone else owns.
//
// The object layout is the only part of the blob that grows with a gameplay cap, so
// that part is derived exactly — one row per object a farm may own, plus one for the
// presentation-only starter shed. The row budget is sized from the widest row the farm
// can really produce: a Memorial Statue carrying a whole fallen zombie, with the
// `reward-store-<uuid>` ids the client actually mints, measures 348 bytes.
const OBJECT_LAYOUT_ROW_BYTES = 384;

// Everything else in the blob (roster layout, Almanac, graveyard, teams, tally, camera,
// settings, tutorial). A fixed allowance rather than a sum of the other bounds, for two
// reasons: those bounds at their adversarial maxima come to ~285 KB and together with an
// all-Memorial layout exceed any sane request ceiling, and `ui.stats` bounds each counter
// but NOT how many there are — so this number is still doing backstop duty and cannot be
// fully derived. 192 KB against a measured 145 KB for every bounded shape at its bound.
const PRESENTATION_OTHER_BYTES = 192 * 1024;

/** Byte ceiling on one stored presentation blob. Derived — see above. */
export const MAX_PRESENTATION_BYTES =
  (MAX_FUNCTIONAL_OBJECTS + 1) * OBJECT_LAYOUT_ROW_BYTES + PRESENTATION_OTHER_BYTES;

/** Slack over the blob ceiling for the request envelope. The global body limit is
 *  derived from the two, because a body limit BELOW the blob ceiling would refuse a
 *  legal blob at the door — the same silent permanent failure, just as a 413 from
 *  bodyLimit that never reaches the handler. */
export const REQUEST_ENVELOPE_BYTES = 32 * 1024;

/** How many fallen zombies one account may park in its presentation blob. Mirrors
 *  MAX_REMEMBERED_FALLEN on the client. The blob has a byte ceiling of its own, so the
 *  graveyard gets a hard count ceiling rather than being allowed to crowd out object
 *  positions and roster names. */
export const MAX_PRESENTATION_FALLEN = 60;
