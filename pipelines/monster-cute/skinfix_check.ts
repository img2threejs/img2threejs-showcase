/** Run the conditioning pass headlessly and report what it moved, plus the gates it could break. */
import { buildRiggedModel } from '../../src/demos/monster-cute/meshCodec';
import { SURFACE_MODEL, SURFACE_STREAM } from '../../src/demos/monster-cute/surfaceData.high';
import { RIG } from '../../src/demos/monster-cute/rigData';
import { conditionHeadSkin } from '../../src/demos/monster-cute/skinFix';

const rigged = buildRiggedModel(SURFACE_MODEL, SURFACE_STREAM, RIG);
const report = conditionHeadSkin(rigged.mesh, RIG);
console.log(JSON.stringify(report, null, 2));
console.log(`\nG4 |1 - sum(w)| = ${report.maxWeightErrorAfter.toExponential(2)} <= 2e-7 : ${report.maxWeightErrorAfter <= 2e-7 ? 'PASS' : 'FAIL'}`);
console.log(`G5 maxSkinIndex = ${report.maxSkinIndexAfter} <= ${RIG.bones.length - 1} : ${report.maxSkinIndexAfter <= RIG.bones.length - 1 ? 'PASS' : 'FAIL'}`);
