import type { MutationPart } from "../assets";

export type MutationReplacement = NonNullable<MutationPart["replaces"]>;

/** True when a base-model part should be hidden by a replacement mutation. */
export function matchesMutationReplacement(
  file: string,
  replacement: MutationReplacement,
): boolean {
  return replacement === "body"
    ? /Body(?:\.png)?$/i.test(file)
    : /ArmF(?:\.png)?$/i.test(file);
}
