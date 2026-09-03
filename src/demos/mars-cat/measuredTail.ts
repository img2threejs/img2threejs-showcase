import * as THREE from 'three';

type TailStation = Readonly<{
  centre: readonly [number, number, number];
  radiusLateral: number;
  radiusInPlane: number;
}>;

// Offline measurements from GLB node 118. These are centreline/radius parameters, not copied
// vertices or topology. See work/polish/tail-reference-profile.json for the extraction evidence.
const LATERAL_AXIS = new THREE.Vector3(
  0.9999801183509539,
  0.004136361735356693,
  0.004759560316518199,
).normalize();

const STATIONS: readonly TailStation[] = [
  { centre: [-0.001725518762647908, 0.6148417271766249, -0.36733709938263004], radiusLateral: 0.0010377602029645312, radiusInPlane: 0.0009872928864241531 },
  { centre: [-0.0017255192032971526, 0.6296456889798177, -0.34361203966011217], radiusLateral: 0.016449287706328836, radiusInPlane: 0.0156420565571564 },
  { centre: [-0.0017253671077882826, 0.6457062091502733, -0.32094812812197604], radiusLateral: 0.025990838987534938, radiusInPlane: 0.02391038426132146 },
  { centre: [-0.0017248843621313005, 0.6528997438169467, -0.2966874561669564], radiusLateral: 0.031175828745156058, radiusInPlane: 0.02812189680156711 },
  { centre: [-0.0017236278002460137, 0.6499907855152048, -0.26986506610258504], radiusLateral: 0.033304451006942744, radiusInPlane: 0.030460574632026477 },
  { centre: [-0.0017274152889425285, 0.6428788266494163, -0.24614889882345062], radiusLateral: 0.03346370619789309, radiusInPlane: 0.0299862948132149 },
  { centre: [-0.0017289485089535537, 0.624779836318172, -0.22819003227376053], radiusLateral: 0.03252732753714623, radiusInPlane: 0.029358608749577082 },
  { centre: [-0.0017257659755952855, 0.6049142951929133, -0.21197200802506933], radiusLateral: 0.031155855582896606, radiusInPlane: 0.02837717856315275 },
  { centre: [-0.0017252657019923938, 0.5834779453809708, -0.20514135656527813], radiusLateral: 0.02979660985924846, radiusInPlane: 0.027058369733072872 },
  { centre: [-0.0017259124829708393, 0.5583331824561274, -0.20599350664891486], radiusLateral: 0.02868370045489886, radiusInPlane: 0.02660247342339888 },
  { centre: [-0.0017255271444263148, 0.5336040455608276, -0.2072899980982903], radiusLateral: 0.027838718775487683, radiusInPlane: 0.02648148320200413 },
  { centre: [-0.0017258886372265028, 0.5091989616382515, -0.2101029725947762], radiusLateral: 0.027125785489418526, radiusInPlane: 0.02599736786768571 },
  { centre: [-0.0017259734287880712, 0.4846131699027753, -0.21329248997310743], radiusLateral: 0.02641799893829159, radiusInPlane: 0.024455556993380367 },
  { centre: [-0.0017256947053512592, 0.46097337297726687, -0.20661326076799497], radiusLateral: 0.025652467265732646, radiusInPlane: 0.0239738411357863 },
  { centre: [-0.0017263609890948587, 0.438854789143025, -0.19219670880669806], radiusLateral: 0.02483100732183926, radiusInPlane: 0.023489952664611513 },
  { centre: [-0.0017256479626976294, 0.41953825410075435, -0.17432305985229674], radiusLateral: 0.02402016006221117, radiusInPlane: 0.02194715220638571 },
  { centre: [-0.0017255334671941688, 0.412156791452723, -0.1477033213309692], radiusLateral: 0.02335119386618084, radiusInPlane: 0.022246159502600886 },
  { centre: [-0.0017255599839126896, 0.40415964244468017, -0.11840650066600694], radiusLateral: 0.023020084585138247, radiusInPlane: 0.02080574822604393 },
  { centre: [-0.001725530365293765, 0.4156854754100712, -0.08657313846909113], radiusLateral: 0.023287536036286076, radiusInPlane: 0.02172660250028846 },
  { centre: [-0.0017255392385686814, 0.4359238579298099, -0.051489359339388995], radiusLateral: 0.024478977935677805, radiusInPlane: 0.023275351369119984 },
];

const COLOUR_LINEAR_UINT8 = [0, 66, 171] as const;

function ellipseCircumference(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function sampledStations(cell: number): TailStation[] {
  const sampled: TailStation[] = [STATIONS[0]];
  const controlPoints = STATIONS.map((station) => new THREE.Vector3().fromArray(station.centre));
  const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'centripetal');
  const segmentScale = STATIONS.length - 1;
  for (let stationIndex = 0; stationIndex < STATIONS.length - 1; stationIndex += 1) {
    const a = STATIONS[stationIndex];
    const b = STATIONS[stationIndex + 1];
    let intervals = 1;
    // Refine this measured span until every executed centreline edge fits inside the tier's cell.
    // The centripetal curve passes through each measured station but removes the hard tangent jumps
    // that made the first piecewise-linear sweep fold through itself at sharp stations.
    for (;;) {
      let previous = curve.getPoint(stationIndex / segmentScale);
      let withinCell = true;
      for (let interval = 1; interval <= intervals; interval += 1) {
        const t = (stationIndex + interval / intervals) / segmentScale;
        const point = curve.getPoint(t);
        if (previous.distanceTo(point) > cell) withinCell = false;
        previous = point;
      }
      if (withinCell) break;
      // Use the minimum supported count. Over-refining a thin prop changes its weight in the
      // percentile band comparison even when its shape is unchanged.
      intervals += 1;
      if (intervals > 65536) throw new Error('tail centreline tessellation did not converge');
    }
    for (let interval = 1; interval <= intervals; interval += 1) {
      const t = interval / intervals;
      const point = curve.getPoint((stationIndex + t) / segmentScale);
      sampled.push({
        centre: [point.x, point.y, point.z],
        radiusLateral: THREE.MathUtils.lerp(a.radiusLateral, b.radiusLateral, t),
        radiusInPlane: THREE.MathUtils.lerp(a.radiusInPlane, b.radiusInPlane, t),
      });
    }
  }
  return sampled;
}

export function createMeasuredTailGeometry(cellMillimetres: number): THREE.BufferGeometry {
  const cell = cellMillimetres / 1000;
  const stations = sampledStations(cell);
  const maximumCircumference = Math.max(
    ...STATIONS.map((station) => ellipseCircumference(station.radiusLateral, station.radiusInPlane)),
  );
  // Four-way rounding keeps all measured ellipse extrema represented while ensuring every edge is
  // no longer than the cell. At the Medium 5 mm level this is exactly 44 radial segments.
  const radialSegments = 4 * Math.max(1, Math.ceil((maximumCircumference / cell) / 4));
  const ringVertexCount = stations.length * radialSegments;
  const positions = new Float32Array((ringVertexCount + 2) * 3);
  const colours = new Uint8Array((ringVertexCount + 2) * 3);
  const indices: number[] = [];

  const centre = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const next = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const inPlaneAxis = new THREE.Vector3();
  const point = new THREE.Vector3();

  const setColour = (vertex: number): void => {
    colours[vertex * 3] = COLOUR_LINEAR_UINT8[0];
    colours[vertex * 3 + 1] = COLOUR_LINEAR_UINT8[1];
    colours[vertex * 3 + 2] = COLOUR_LINEAR_UINT8[2];
  };

  for (let ring = 0; ring < stations.length; ring += 1) {
    const station = stations[ring];
    centre.fromArray(station.centre);
    previous.fromArray(stations[Math.max(0, ring - 1)].centre);
    next.fromArray(stations[Math.min(stations.length - 1, ring + 1)].centre);
    tangent.copy(next).sub(previous).normalize();
    inPlaneAxis.crossVectors(tangent, LATERAL_AXIS).normalize();
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      point.copy(centre)
        .addScaledVector(LATERAL_AXIS, Math.cos(angle) * station.radiusLateral)
        .addScaledVector(inPlaneAxis, Math.sin(angle) * station.radiusInPlane);
      const vertex = ring * radialSegments + segment;
      point.toArray(positions, vertex * 3);
      setColour(vertex);
    }
  }

  for (let ring = 0; ring < stations.length - 1; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const nextSegment = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = ring * radialSegments + nextSegment;
      const c = (ring + 1) * radialSegments + nextSegment;
      const d = (ring + 1) * radialSegments + segment;
      indices.push(a, b, c, a, c, d);
    }
  }

  const tipCentre = ringVertexCount;
  const rootCentre = ringVertexCount + 1;
  new THREE.Vector3().fromArray(stations[0].centre).toArray(positions, tipCentre * 3);
  new THREE.Vector3().fromArray(stations[stations.length - 1].centre).toArray(positions, rootCentre * 3);
  setColour(tipCentre);
  setColour(rootCentre);
  const rootRing = (stations.length - 1) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const nextSegment = (segment + 1) % radialSegments;
    indices.push(tipCentre, nextSegment, segment);
    indices.push(rootCentre, rootRing + segment, rootRing + nextSegment);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3, true));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.measurement = {
    sourceNode: 118,
    measuredStationCount: STATIONS.length,
    cellMillimetres,
    ringCount: stations.length,
    radialSegments,
    colourLinearUint8: [...COLOUR_LINEAR_UINT8],
    sourceTopologyCopied: false,
  };
  return geometry;
}
