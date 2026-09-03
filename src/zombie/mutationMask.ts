// ---------------------------------------------------------------------------
// Wide bitmask primitives.
// ---------------------------------------------------------------------------
// A zombie's mutations persist as ONE integer (see mutations.ts). That integer is
// stored in D1's `roster_v3.mutation` — a 64-bit SQLite INTEGER — and travels through
// JSON, so the mask itself has plenty of room. The limit was never storage: it was
// JavaScript's bitwise operators, which coerce both operands to 32-BIT SIGNED
// integers. `mask | bit` silently wraps at bit 31 and goes NEGATIVE at bit 31, so a
// codebase that reaches for `&` and `|` is capped at 31 mutations however wide its
// column is — and the old MAX_MUTATION of 0xffff capped it at 16 long before that.
//
// These helpers do the same set algebra with ordinary arithmetic (`+`, `-`, `/`,
// `%`), which is exact for every integer up to Number.MAX_SAFE_INTEGER. That lifts
// the ceiling to 53 mutations and — because the wire format is unchanged — costs
// nothing at the storage or protocol boundary. SQLite's own `&` is 64-bit, so the
// Black Market's `(mutation & ?) != 0` predicates keep working untouched.
//
// Past 53 the representation has to change (BigInt end-to-end, or a keyed set with a
// text column); MAX_MASK_BITS below is the tripwire that says so out loud rather than
// letting a 54th mutation round off into a neighbour's bit.
// ---------------------------------------------------------------------------

/** Mutations one mask can carry. 2^53-1 is the largest integer JavaScript can hold
 *  without losing a unit of precision, so bit 52 is the last one that survives a
 *  round trip through a JSON number. Enforced by assertMaskBit. */
export const MAX_MASK_BITS = 53;

/** The value of bit `index` (0 -> 1, 1 -> 2, 2 -> 4, ...). */
export function bitValue(index: number): number {
  assertMaskBitIndex(index);
  return 2 ** index;
}

/** Throws unless `index` names a bit this representation can hold exactly. */
export function assertMaskBitIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_MASK_BITS) {
    throw new RangeError(
      `mutation bit index ${index} is outside 0..${MAX_MASK_BITS - 1}; ` +
      `a wider mask needs a BigInt (or keyed) representation — see mutationMask.ts`
    );
  }
}

/** Is `value` a single bit this representation can hold exactly? */
export function isMaskBit(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 1) return false;
  const index = Math.round(Math.log2(value));
  return index < MAX_MASK_BITS && 2 ** index === value;
}

/** Is `bit` set in `mask`? `bit` must be a single bit (isMaskBit). */
export function maskHas(mask: number, bit: number): boolean {
  return Math.floor(mask / bit) % 2 === 1;
}

/** Walk both masks a binary digit at a time, keeping the digits `keep` selects.
 *  One shared loop so union/intersection/difference cannot drift apart. */
function combine(a: number, b: number, keep: (x: boolean, y: boolean) => boolean): number {
  let out = 0;
  let place = 1;
  let x = Math.max(0, Math.trunc(a));
  let y = Math.max(0, Math.trunc(b));
  while (x > 0 || y > 0) {
    const xb = x % 2;
    const yb = y % 2;
    if (keep(xb === 1, yb === 1)) out += place;
    x = (x - xb) / 2;
    y = (y - yb) / 2;
    place *= 2;
  }
  return out;
}

/** a OR b. */
export function maskUnion(a: number, b: number): number {
  return combine(a, b, (x, y) => x || y);
}

/** a AND b. */
export function maskIntersect(a: number, b: number): number {
  return combine(a, b, (x, y) => x && y);
}

/** a AND NOT b. */
export function maskWithout(a: number, b: number): number {
  return combine(a, b, (x, y) => x && !y);
}

/** The bits `after` carries that `before` did not: what a zombie GAINED when its mask
 *  changed. Named for the one question the Mutation Almanac asks when a server mask
 *  lands on a unit the client spawned optimistically with none — credit the new
 *  mutations, and only those, never the ones it already wore. Bits `before` had and
 *  `after` dropped are not a discovery of anything, so they do not appear. */
export function newMutationBits(before: number, after: number): number {
  return maskWithout(after, before);
}

/** Every bit set in `mask`, lowest first. Unbounded by the known catalog, so it also
 *  surfaces bits a stale client wrote — callers that only want known ones filter. */
export function maskBits(mask: number): number[] {
  const out: number[] = [];
  let rest = Math.max(0, Math.trunc(mask));
  let place = 1;
  while (rest > 0) {
    if (rest % 2 === 1) out.push(place);
    rest = (rest - (rest % 2)) / 2;
    place *= 2;
  }
  return out;
}
