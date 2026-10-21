/**
 * The version tag inside a `generatedWith` string.
 *
 * Shared rather than copied: the workbench readout and the demo panel's version badge must never
 * disagree about which version built an exhibit. Case-insensitive because one entry records `V2`, and
 * the optional suffix catches `v1.5-beta`. Returns null for the entries that name no version at all --
 * the reference baseline is rendered as shipped, so there is nothing to claim.
 */
const VERSION_TAG = /v\d+(?:\.\d+){0,2}(?:-[a-z0-9.]+)?/i;

export function extractVersion(generatedWith: string): string | null {
  return generatedWith.match(VERSION_TAG)?.[0] ?? null;
}
