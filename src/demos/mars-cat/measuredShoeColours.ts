import * as THREE from 'three';

const MEASURED_SHOE_ORANGE = [0.955973353249, 0.155926463708, 0.000303526984] as const;
const MEASURED_SHOE_WHITE = [0.760524504675, 0.715693500506, 0.672443156958] as const;
const MEASURED_SHOE_GREY = [0.30946892281750854, 0.30946892281750854, 0.30946892281750854] as const;
const MEASURED_SHOE_TAN = [0.7156935005064807, 0.4793201831008268, 0.3762621229909065] as const;

const TONGUE_POLYGONS: Record<114 | 115, ReadonlyArray<readonly [number, number]>> = {
  114: [
    [-0.0845082476735115, 0.1452302485704422],
    [-0.0839773491024971, 0.1444409340620041],
    [-0.08322727680206299, 0.14371618628501892],
    [-0.08274085819721222, 0.14328600466251373],
    [-0.0823424831032753, 0.14302028715610504],
    [-0.08165161311626434, 0.14270278811454773],
    [-0.0802389457821846, 0.14214585721492767],
    [-0.07779649645090103, 0.14124733209609985],
    [-0.07468977570533752, 0.14015242457389832],
    [-0.07120509445667267, 0.13898344337940216],
    [-0.06678207963705063, 0.13755443692207336],
    [-0.06118646264076233, 0.13578276336193085],
    [-0.05615171045064926, 0.1343049705028534],
    [-0.05333149805665016, 0.13374018669128418],
    [-0.05215657874941826, 0.1339186578989029],
    [-0.05167919397354126, 0.13463523983955383],
    [-0.05150262266397476, 0.13632658123970032],
    [-0.05144377052783966, 0.13932271301746368],
    [-0.05144052952528, 0.14282801747322083],
    [-0.05146403610706329, 0.14590004086494446],
    [-0.05149190127849579, 0.1481330692768097],
    [-0.05156848207116127, 0.14935331046581268],
    [-0.05161593109369278, 0.14955052733421326],
    [-0.05203206092119217, 0.14997275173664093],
    [-0.0532764308154583, 0.14986680448055267],
    [-0.06673410534858704, 0.1486213058233261],
    [-0.08183460682630539, 0.14691708981990814],
    [-0.08292047679424286, 0.14675448834896088],
    [-0.08343534171581268, 0.14661233127117157],
    [-0.08378172665834427, 0.14639756083488464],
    [-0.08421733230352402, 0.14601419866085052],
    [-0.08437274396419525, 0.14582620561122894],
  ],
  115: [
    [0.05829388648271561, 0.14765965938568115],
    [0.05832068994641304, 0.14543095231056213],
    [0.05837235227227211, 0.14236514270305634],
    [0.05846136435866356, 0.1388677954673767],
    [0.058593522757291794, 0.13587968051433563],
    [0.05881144106388092, 0.13419602811336517],
    [0.05930624529719353, 0.1334918737411499],
    [0.06048522889614105, 0.1333412230014801],
    [0.06329081207513809, 0.13397139310836792],
    [0.06828796863555908, 0.13556602597236633],
    [0.07383856922388077, 0.1374693214893341],
    [0.07822524011135101, 0.13900618255138397],
    [0.08168013393878937, 0.1402631402015686],
    [0.08475898951292038, 0.14143706858158112],
    [0.08717860281467438, 0.14239785075187683],
    [0.08857718110084534, 0.142990842461586],
    [0.08926001936197281, 0.14332586526870728],
    [0.08965177834033966, 0.14360159635543823],
    [0.09012749791145325, 0.14404350519180298],
    [0.0908595472574234, 0.14478619396686554],
    [0.09137098491191864, 0.14558765292167664],
    [0.0912209004163742, 0.14617857336997986],
    [0.09106087684631348, 0.14636464416980743],
    [0.09061611443758011, 0.14673574268817902],
    [0.09026452898979187, 0.14694072306156158],
    [0.08974634855985641, 0.1470693051815033],
    [0.08865690231323242, 0.1472034454345703],
    [0.07351960241794586, 0.14851738512516022],
    [0.060035426169633865, 0.14943480491638184],
    [0.05878880247473717, 0.14951051771640778],
    [0.058383140712976456, 0.1490793377161026],
    [0.058340609073638916, 0.14887897670269012],
  ],
};

const CURRENT_TONGUE_CONTAMINATION_BOUNDS: Record<114 | 115, readonly [number, number, number, number]> = {
  114: [-0.0891236886382103, 0.12835055589675903, 0.15676052868366241, 0.05336939916014671],
  115: [0.05315166339278221, 0.12751206755638123, 0.15607202053070068, 0.052971500903367996],
};

const MEDIAL_CIRCLES: Record<114 | 115, {
  center: readonly [number, number];
  radius: readonly [number, number];
}> = {
  114: {
    center: [0.07562757283449173, -0.01688131457194686],
    radius: [0.02407689392566681, 0.02417563134804368],
  },
  115: {
    center: [0.07447456568479538, -0.01748255081474781],
    radius: [0.024120919406414032, 0.024177251383662224],
  },
};

const OUTER_TRIANGLE_ROTATION_RADIANS = THREE.MathUtils.degToRad(15);
const OUTER_TRIANGLE_HEIGHT_SCALE: Record<114 | 115, number> = {
  114: 0.728316240621045,
  115: 0.7291285524593203,
};
const OUTER_TRIANGLE_DOWNWARD_OFFSET: Record<114 | 115, number> = {
  114: -0.002938962,
  115: -0.002954478,
};
const OUTER_TRIANGLE_HEELWARD_OFFSET: Record<114 | 115, number> = {
  114: -0.006857578,
  115: -0.006893782,
};

function transformOuterTriangle(
  polygon: ReadonlyArray<readonly [number, number]>,
  radians: number,
  verticalScale: number,
  downwardOffset: number,
  heelwardOffset: number,
): ReadonlyArray<readonly [number, number]> {
  const centroid = polygon.reduce(
    (sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length],
    [0, 0],
  );
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return polygon.map(([y, z]) => {
    const offsetY = y - centroid[0];
    const offsetZ = z - centroid[1];
    return [
      centroid[0] + (cosine * offsetY - sine * offsetZ) * verticalScale + downwardOffset,
      centroid[1] + sine * offsetY + cosine * offsetZ + heelwardOffset,
    ] as const;
  });
}

const OUTER_TRIANGLE_POLYGONS: Record<114 | 115, ReadonlyArray<readonly [number, number]>> = {
  114: transformOuterTriangle([
    [0.07051952183246613, -0.016432031989097595],
    [0.07956304401159286, 0.039194948971271515],
    [0.1075473204255104, -0.030925173328558677],
  ], OUTER_TRIANGLE_ROTATION_RADIANS, OUTER_TRIANGLE_HEIGHT_SCALE[114],
  OUTER_TRIANGLE_DOWNWARD_OFFSET[114], OUTER_TRIANGLE_HEELWARD_OFFSET[114]),
  115: transformOuterTriangle([
    [0.07192706316709518, -0.016788354143500324],
    [0.08112288266420364, 0.03879864886403084],
    [0.1108202263712883, -0.03267944517037431],
  ], OUTER_TRIANGLE_ROTATION_RADIANS, OUTER_TRIANGLE_HEIGHT_SCALE[115],
  OUTER_TRIANGLE_DOWNWARD_OFFSET[115], OUTER_TRIANGLE_HEELWARD_OFFSET[115]),
};

const CURRENT_MEDIAL_CONTAMINATION_BOUNDS: Record<114 | 115, readonly [number, number, number, number, number, number]> = {
  114: [-0.019602829590439796, 0.04279027134180069, -0.049087043851614, -0.0012506454950198531, 0.10875748097896576, 0.015170576050877571],
  115: [0.010321388021111488, 0.041832201182842255, -0.048179782927036285, 0.028032807633280754, 0.10781554132699966, 0.014841357246041298],
};

const CURRENT_OUTER_CONTAMINATION_BOUNDS: Record<114 | 115, readonly [number, number, number, number, number, number]> = {
  114: [-0.1252095252275467, 0.060020655393600464, -0.04413498938083649, -0.10323363542556763, 0.1075473204255104, 0.03541675955057144],
  115: [0.11084979772567749, 0.06152871996164322, -0.04513261467218399, 0.13386490941047668, 0.1108202263712883, 0.0346730500459671],
};

const MEASURED_OUTER_WHITE_GAP_BOTTOM: Record<114 | 115, number> = {
  114: 0.037542399019002914,
  115: 0.03868461772799492,
};

const MEASURED_OUTER_CLEANUP_X_BOUNDS: Record<114 | 115, readonly [number, number]> = {
  114: [-0.14454521238803864, -0.025799622759222984],
  115: [0.03394176438450813, 0.15497565269470215],
};

const MEASURED_OUTER_CLEANUP_Z_MIN: Record<114 | 115, number> = {
  114: -0.10418585687875748,
  115: -0.10514520853757858,
};

const LACE_PAD_POLYGONS: Record<114 | 115, ReadonlyArray<readonly [number, number]>> = {
  114: [
    [-0.10714235156774521, 0.08153420686721802],
    [-0.10704836249351501, 0.0745953693985939],
    [-0.10704687982797623, 0.07458855211734772],
    [-0.10592711716890335, 0.06966656446456909],
    [-0.10383733361959457, 0.06742148846387863],
    [-0.1024647131562233, 0.06647015362977982],
    [-0.09958747774362564, 0.06613029539585114],
    [-0.03905778005719185, 0.06597668677568436],
    [-0.03679709881544113, 0.06651725620031357],
    [-0.03535624220967293, 0.06744517385959625],
    [-0.03336247429251671, 0.07060053199529648],
    [-0.03335881605744362, 0.07061298936605453],
    [-0.03188631311058998, 0.07678108662366867],
    [-0.031156018376350403, 0.08452874422073364],
    [-0.030939409509301186, 0.09226121753454208],
    [-0.030631987378001213, 0.10693324357271194],
    [-0.031454749405384064, 0.1088307574391365],
    [-0.032196249812841415, 0.1096988320350647],
    [-0.032745376229286194, 0.11020772159099579],
    [-0.035983793437480927, 0.11200395226478577],
    [-0.042041338980197906, 0.11383792012929916],
    [-0.04845530912280083, 0.11502210795879364],
    [-0.08500846475362778, 0.11522167921066284],
    [-0.0906095802783966, 0.11468994617462158],
    [-0.09663762152194977, 0.11252343654632568],
    [-0.10148550570011139, 0.10933224111795425],
    [-0.10387599468231201, 0.10561856627464294],
    [-0.10489733517169952, 0.10118063539266586],
    [-0.1057697981595993, 0.09567226469516754],
    [-0.1065937802195549, 0.08902991563081741],
  ],
  115: [
    [0.03845015540719032, 0.10597001016139984],
    [0.03911806643009186, 0.09127464145421982],
    [0.039524756371974945, 0.08352669328451157],
    [0.04044553264975548, 0.07576873898506165],
    [0.04206966236233711, 0.0696040466427803],
    [0.04207363724708557, 0.06959172338247299],
    [0.04414474219083786, 0.06646233052015305],
    [0.04560790956020355, 0.0655691921710968],
    [0.04788139462471008, 0.06507600098848343],
    [0.10838962346315384, 0.06669456511735916],
    [0.11125743389129639, 0.06711437553167343],
    [0.11260629445314407, 0.0680999606847763],
    [0.11463967710733414, 0.07042255997657776],
    [0.11563754081726074, 0.0754094123840332],
    [0.11563879996538162, 0.075416199862957],
    [0.11556185036897659, 0.08238929510116577],
    [0.11482904106378555, 0.08989536017179489],
    [0.11384198069572449, 0.09653349220752716],
    [0.11283444613218307, 0.10203107446432114],
    [0.11170440167188644, 0.10645129531621933],
    [0.10922347009181976, 0.11011047661304474],
    [0.10429872572422028, 0.11318299174308777],
    [0.09821943938732147, 0.11519861966371536],
    [0.09260712563991547, 0.11558713018894196],
    [0.05606983229517937, 0.1144917756319046],
    [0.049686726182699203, 0.1131555363535881],
    [0.04367586970329285, 0.11117704957723618],
    [0.04048248007893562, 0.10930172353982925],
    [0.03994615375995636, 0.10877305269241333],
    [0.03922603651881218, 0.10789154469966888],
  ],
};

const CURRENT_GREY_CONTAMINATION_BOUNDS: Record<114 | 115, readonly [number, number, number, number, number, number]> = {
  114: [-0.11092963069677353, 0.05766180157661438, 0.039585091173648834, -0.025799622759222984, 0.115830197930336, 0.09575191885232925],
  115: [0.03394176438450813, 0.058419760316610336, 0.03987910971045494, 0.12000396847724915, 0.11569415032863617, 0.09428012371063232],
};

const MEASURED_FRONT_PALETTE_BOUNDS: Record<114 | 115, readonly [number, number, number, number, number, number]> = {
  114: [-0.14454521238803864, -0.007333437446504831, -0.10418585687875748, 0.0024347887374460697, 0.05, 0.15266206860542297],
  115: [0.008100701496005058, -0.008884408511221409, -0.10514520853757858, 0.15497565269470215, 0.05, 0.1517663151025772],
};

function polygonBody(polygon: ReadonlyArray<readonly [number, number]>): string {
  return polygon.map((point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return `
      if (((${point[1]} > point.y) != (${next[1]} > point.y)) &&
          (point.x < (${next[0]} - ${point[0]}) * (point.y - ${point[1]}) /
          (${next[1]} - ${point[1]}) + ${point[0]})) inside = 1.0 - inside;`;
  }).join('');
}

export function applyMeasuredShoeColourRegions(
  material: THREE.MeshPhysicalMaterial,
  node: 114 | 115,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  const polygon = TONGUE_POLYGONS[node];
  const bounds = CURRENT_TONGUE_CONTAMINATION_BOUNDS[node];
  const measuredPolygon = polygonBody(polygon);
  const medialCircle = MEDIAL_CIRCLES[node];
  const medialBounds = CURRENT_MEDIAL_CONTAMINATION_BOUNDS[node];
  const outerBounds = CURRENT_OUTER_CONTAMINATION_BOUNDS[node];
  const outerWhiteGapBottom = MEASURED_OUTER_WHITE_GAP_BOTTOM[node];
  const outerCleanupXBounds = MEASURED_OUTER_CLEANUP_X_BOUNDS[node];
  const outerCleanupZMin = MEASURED_OUTER_CLEANUP_Z_MIN[node];
  const measuredOuterPolygon = polygonBody(OUTER_TRIANGLE_POLYGONS[node]);
  const measuredLacePadPolygon = polygonBody(LACE_PAD_POLYGONS[node]);
  const greyBounds = CURRENT_GREY_CONTAMINATION_BOUNDS[node];
  const frontPaletteBounds = MEASURED_FRONT_PALETTE_BOUNDS[node];

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vMeasuredShoePosition;\nvarying vec3 vMeasuredShoeNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvMeasuredShoePosition = position;\nvMeasuredShoeNormal = normal;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vMeasuredShoePosition;
        varying vec3 vMeasuredShoeNormal;
        float measuredTongueOrange(vec2 point) {
          float inside = 0.0;${measuredPolygon}
          return inside;
        }
        float measuredOuterOrange(vec2 point) {
          float inside = 0.0;${measuredOuterPolygon}
          return inside;
        }
        float measuredLacePadGrey(vec2 point) {
          float inside = 0.0;${measuredLacePadPolygon}
          return inside;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float measuredTongueZone =
          step(${bounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${node === 114 ? -0.0451967716217041 : 0.09596262872219086}) *
          step(${bounds[1]}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${bounds[2]}) *
          step(0.03667746111750603, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${bounds[3]});
        if (measuredTongueZone > 0.5) {
          diffuseColor.rgb = mix(
            vec3(${MEASURED_SHOE_WHITE.join(', ')}),
            vec3(${MEASURED_SHOE_ORANGE.join(', ')}),
            measuredTongueOrange(vMeasuredShoePosition.xy)
          );
        }
        float measuredMedialZone =
          step(${medialBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${medialBounds[3]}) *
          step(${medialBounds[1]}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${medialBounds[4]}) *
          step(${medialBounds[2]}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${medialBounds[5]});
        if (measuredMedialZone > 0.5) {
          vec2 measuredCirclePoint =
            (vMeasuredShoePosition.yz - vec2(${medialCircle.center.join(', ')})) /
            vec2(${medialCircle.radius.join(', ')});
          float measuredCircle = step(dot(measuredCirclePoint, measuredCirclePoint), 1.0);
          diffuseColor.rgb = mix(
            vec3(${MEASURED_SHOE_WHITE.join(', ')}),
            vec3(${MEASURED_SHOE_ORANGE.join(', ')}),
            measuredCircle
          );
        }
        float measuredOuterZone =
          step(${outerBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${outerBounds[3]}) *
          step(${outerBounds[1]}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${outerBounds[4]}) *
          step(${outerCleanupZMin}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${outerBounds[5]});
        if (measuredOuterZone > 0.5) {
          float measuredOuterRaisedSurface = ${node === 114
    ? 'step(vMeasuredShoePosition.x, -0.10966870188713074)'
    : 'step(0.11758916079998016, vMeasuredShoePosition.x)'};
          diffuseColor.rgb = mix(
            vec3(${MEASURED_SHOE_WHITE.join(', ')}),
            vec3(${MEASURED_SHOE_ORANGE.join(', ')}),
            measuredOuterOrange(vMeasuredShoePosition.yz) * measuredOuterRaisedSurface
          );
        }
        float measuredGreyContaminationZone =
          step(${greyBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${greyBounds[3]}) *
          step(${greyBounds[1]}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${greyBounds[4]}) *
          step(${greyBounds[2]}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${greyBounds[5]});
        float measuredGreyInside = measuredLacePadGrey(vMeasuredShoePosition.xy);
        float measuredGreyDistance = distance(diffuseColor.rgb, vec3(${MEASURED_SHOE_GREY.join(', ')}));
        float measuredWhiteDistance = distance(diffuseColor.rgb, vec3(${MEASURED_SHOE_WHITE.join(', ')}));
        float measuredMedialLaceSpill = ${node === 114
    ? 'step(-0.030631987378001213, vMeasuredShoePosition.x)'
    : 'step(vMeasuredShoePosition.x, 0.03845015540719032)'};
        if (measuredGreyContaminationZone > 0.5 && measuredGreyInside < 0.5 &&
            (measuredGreyDistance < measuredWhiteDistance || measuredMedialLaceSpill > 0.5)) {
          diffuseColor.rgb = vec3(${MEASURED_SHOE_WHITE.join(', ')});
        }
        float measuredFrontPaletteZone =
          step(${frontPaletteBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${frontPaletteBounds[3]}) *
          step(${frontPaletteBounds[1]}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${frontPaletteBounds[4]}) *
          step(${frontPaletteBounds[2]}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${frontPaletteBounds[5]});
        if (measuredFrontPaletteZone > 0.5) {
          vec3 measuredFrontWhite = vec3(${MEASURED_SHOE_WHITE.join(', ')});
          vec3 measuredFrontTan = vec3(${MEASURED_SHOE_TAN.join(', ')});
          vec3 measuredFrontGrey = vec3(${MEASURED_SHOE_GREY.join(', ')});
          float measuredTanBand = step(vMeasuredShoePosition.y, 0.024);
          float measuredGreyBand =
            step(0.024, vMeasuredShoePosition.y) *
            step(vMeasuredShoePosition.y, 0.038);
          diffuseColor.rgb = measuredTanBand > 0.5
            ? measuredFrontTan
            : (measuredGreyBand > 0.5 ? measuredFrontGrey : measuredFrontWhite);
        }
        float measuredOuterCleanupZone =
          step(${outerCleanupXBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${outerCleanupXBounds[1]}) *
          step(${outerWhiteGapBottom}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${bounds[1]}) *
          step(${outerCleanupZMin}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${greyBounds[2]});
        float measuredInnerLayerCleanupZone =
          step(${medialBounds[0]}, vMeasuredShoePosition.x) *
          step(vMeasuredShoePosition.x, ${medialBounds[3]}) *
          step(${outerWhiteGapBottom}, vMeasuredShoePosition.y) *
          step(vMeasuredShoePosition.y, ${bounds[1]}) *
          step(${outerCleanupZMin}, vMeasuredShoePosition.z) *
          step(vMeasuredShoePosition.z, ${greyBounds[2]});
        float measuredOutwardFacingLayer = ${node === 114
    ? 'step(vMeasuredShoeNormal.x, 0.0)'
    : 'step(0.0, vMeasuredShoeNormal.x)'};
        float measuredOuterCleanupTarget = max(
          measuredOuterCleanupZone,
          measuredInnerLayerCleanupZone * measuredOutwardFacingLayer
        );
        if (measuredOuterCleanupTarget > 0.5 &&
            measuredOuterOrange(vMeasuredShoePosition.yz) < 0.5) {
          diffuseColor.rgb = vec3(${MEASURED_SHOE_WHITE.join(', ')});
        }`,
      );
  };
  material.customProgramCacheKey = () => `${previousCacheKey()}-measured-shoe-tongue-regions-${node}-v25`;
  material.userData.measuredShoeColourRegions = {
    sourceNode: node,
    method: 'source-derived-analytic-and-polygon-fragment-predicates',
    measuredSourceOrangeVertexCount: 278,
    previousTransferredOrangeVertexCount: node === 114 ? 2105 : 2069,
    textureShipped: false,
    correctedRegions: ['tongue-orange-mark', 'medial-orange-disc', 'lateral-orange-triangle', 'lace-pad-and-laces', 'front-palette-boundaries'],
  };
}

export function createMeasuredOuterShoeTrianglePatch(
  sourceGeometry: THREE.BufferGeometry,
  node: 114 | 115,
  cellMillimetres: number,
  roughness: number,
  metalness: number,
): THREE.Mesh {
  const sourcePosition = sourceGeometry.getAttribute('position');
  const triangle = OUTER_TRIANGLE_POLYGONS[node];
  const subdivisions = 12;
  const triangleMaximumY = Math.max(...triangle.map(([y]) => y));
  const lateralThreshold = node === 114 ? -0.10966870188713074 : 0.11758916079998016;
  const outwardSign = node === 114 ? -1 : 1;
  const proudOffset = cellMillimetres / 2000;
  const outerSamples: Array<readonly [number, number, number]> = [];

  for (let index = 0; index < sourcePosition.count; index += 1) {
    const x = sourcePosition.getX(index);
    if ((node === 114 && x > lateralThreshold) || (node === 115 && x < lateralThreshold)) continue;
    outerSamples.push([x, sourcePosition.getY(index), sourcePosition.getZ(index)]);
  }

  const clippedPolygon: Array<readonly [number, number]> = [];
  for (let index = 0; index < triangle.length; index += 1) {
    const current = triangle[index];
    const previous = triangle[(index + triangle.length - 1) % triangle.length];
    const currentInside = current[0] <= triangleMaximumY;
    const previousInside = previous[0] <= triangleMaximumY;
    if (currentInside !== previousInside) {
      const amount = (triangleMaximumY - previous[0]) / (current[0] - previous[0]);
      clippedPolygon.push([
        triangleMaximumY,
        previous[1] + (current[1] - previous[1]) * amount,
      ]);
    }
    if (currentInside) clippedPolygon.push(current);
  }
  const clippedTriangles = Array.from(
    { length: clippedPolygon.length - 2 },
    (_, index) => [clippedPolygon[0], clippedPolygon[index + 1], clippedPolygon[index + 2]] as const,
  );

  const positions: number[] = [];
  const indices: number[] = [];
  const rowStart = (row: number) => row * (subdivisions + 1) - (row * (row - 1)) / 2;
  for (const clippedTriangle of clippedTriangles) {
    const baseIndex = positions.length / 3;
    for (let row = 0; row <= subdivisions; row += 1) {
      for (let column = 0; column <= subdivisions - row; column += 1) {
        const weightB = row / subdivisions;
        const weightC = column / subdivisions;
        const weightA = 1 - weightB - weightC;
        const y = clippedTriangle[0][0] * weightA
          + clippedTriangle[1][0] * weightB
          + clippedTriangle[2][0] * weightC;
        const z = clippedTriangle[0][1] * weightA
          + clippedTriangle[1][1] * weightB
          + clippedTriangle[2][1] * weightC;
        let nearestDistanceSquared = Number.POSITIVE_INFINITY;
        let nearestX = lateralThreshold;
        for (const sample of outerSamples) {
          const dy = sample[1] - y;
          const dz = sample[2] - z;
          const distanceSquared = dy * dy + dz * dz;
          if (distanceSquared < nearestDistanceSquared) {
            nearestDistanceSquared = distanceSquared;
            nearestX = sample[0];
          }
        }
        positions.push(nearestX + outwardSign * proudOffset, y, z);
      }
    }
    for (let row = 0; row < subdivisions; row += 1) {
      for (let column = 0; column < subdivisions - row; column += 1) {
        const current = baseIndex + rowStart(row) + column;
        const nextRow = baseIndex + rowStart(row + 1) + column;
        indices.push(current, nextRow, current + 1);
        if (column < subdivisions - row - 1) {
          indices.push(nextRow, nextRow + 1, current + 1);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(...MEASURED_SHOE_ORANGE),
    roughness,
    metalness,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${node === 114 ? 'shoe-right' : 'shoe-left'}-outer-triangle-patch`;
  mesh.frustumCulled = false;
  mesh.userData.sdfSurface = true;
  mesh.userData.authoredAnalyticSurface = true;
  mesh.userData.sourceNode = node;
  mesh.userData.measuredCellMillimetres = cellMillimetres;
  mesh.userData.oneSidedProudResidualMetres = proudOffset;
  mesh.userData.surfaceSampleCount = outerSamples.length;
  mesh.userData.patchVertexCount = positions.length / 3;
  mesh.userData.patchTriangleCount = indices.length / 3;
  return mesh;
}
