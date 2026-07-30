// Pure geometric helper shared by:
//   - scripts/rig-milestone0.mjs (gate (b)'s axis-exemption predicate, and
//     its --self-check mode, which exercises the exemption boundary itself
//     on a synthetic case -- the derived-capsule run alone always measures
//     axisExemptVertexCount === 0, which proves the counter works when
//     nothing qualifies, not that an on-axis vertex is correctly classified
//     when one DOES qualify)
//
// Extracted to its own module (rather than duplicated) so --self-check
// exercises the EXACT function gate (b) uses, not a second independent
// implementation that could silently drift from it.
//
// (A standalone scripts/rig-milestone0-axis-exemption.test.mjs previously
// covered this same ground with a hand-built THREE.SkinnedMesh, but was
// deleted 2026-07-30: it was never wired into any npm script or CI path, so
// it only ran when a human typed the command by hand. Its two cases that
// --self-check didn't already have -- the on-axis-but-offset-along-the-axis
// case, and the analytic d*sqrt(2) cross-check -- were folded into
// --self-check and forge/tests/test_rig_milestone0.py's AxisExemptionSelfCheck
// respectively, which DO run as part of the wired suite.)
import * as THREE from 'three';

/**
 * Perpendicular distance from `point` to the infinite line defined by
 * `axisPivot` (a point on the line) and `axisDir` (a UNIT vector — the
 * caller must normalize; this function does not, so that a non-unit
 * `axisDir` fails loudly with a wrong answer rather than being silently
 * corrected, which would hide a bug in the caller).
 */
export function perpendicularDistanceFromAxis(point, axisPivot, axisDir) {
  const v = new THREE.Vector3().subVectors(point, axisPivot);
  const along = v.dot(axisDir);
  return v.addScaledVector(axisDir, -along).length();
}
