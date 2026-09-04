/**
 * Runtime half of the raz animation gate. Paste into the console on #/demo/raz, or hand the function
 * to any browser driver's evaluate().
 *
 * The offline half (`score-raz-animation.mjs`) measures the rig: technique, schedule integrity. This
 * half measures what only a running page can answer — whether the sequence actually switches clips,
 * whether the trail is live, whether the burst is distinct, whether the figure stays in frame, and
 * whether adding the Knockout broke any other action.
 *
 * It is a plain .js file rather than a runnable node script deliberately: driving a browser needs a
 * driver, playwright is not a dependency of this project, and adding one to run a quality gate would
 * cost more than the gate is worth. Committed so the numbers in any report can be reproduced.
 *
 * Returns { checks: [{name, ok, detail}], passed, total, score, failing }.
 */
window.scoreRazRuntime = async function scoreRazRuntime() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  // --- wait for the rig and the level of detail to land, then prove the loop is advancing
  let sr = null;
  let v = null;
  for (let i = 0; i < 300; i += 1) {
    v = window.__IMG2THREEJS_VIEWER__;
    sr = v && v.inspectRoot && v.inspectRoot.userData.sculptRuntime;
    if (sr) break;
    await sleep(250);
  }
  if (!sr) return { checks: [{ name: 'READY', ok: false, detail: 'sculptRuntime never appeared' }], passed: 0, total: 1, score: 0, failing: ['READY'] };
  const t0 = sr.state().clipTime;
  await sleep(300);
  if (sr.state().clipTime === t0) {
    return { checks: [{ name: 'READY', ok: false, detail: 'clip clock is frozen — a cancelled RAF will make every other check meaningless' }], passed: 0, total: 1, score: 0, failing: ['READY'] };
  }

  const cam = v.camera;
  const canvas = v.renderer.domElement;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const carrier = v.inspectRoot.getObjectByName('raz-stance');
  let mesh = null;
  v.inspectRoot.traverse((o) => { if (!mesh && o.isSkinnedMesh && !o.userData.isHighlight) mesh = o; });
  const head = mesh.skeleton.bones.find((b) => b.name === 'Head');

  /**
   * Screen extent of the SKINNED figure, Root excluded.
   *
   * Root carries a clip's own root motion — `run` walks it 2.720 H per loop — so it sits far from the
   * body by design and would dominate any extent measured over all bones. It drives no visible
   * geometry meaningfully; the rest of the skeleton is what the viewer sees.
   */
  const extent = () => {
    let left = Infinity; let right = -Infinity; let top = Infinity;
    for (const b of mesh.skeleton.bones) {
      if (b.name === 'Root') continue;
      const p = b.position.clone();
      b.getWorldPosition(p);
      p.project(cam);
      const px = (p.x * 0.5 + 0.5) * W;
      left = Math.min(left, px);
      right = Math.max(right, px);
    }
    const hp = head.position.clone();
    head.getWorldPosition(hp);
    hp.project(cam);
    top = (-hp.y * 0.5 + 0.5) * H;
    return { left, right, top };
  };

  /**
   * Measure the rendered skin, not just the skeleton. Incompatible rotations can collapse linear-
   * blend skinning while every bone keeps a perfect local length and scale, which is exactly how the
   * rejected Mixamo retarget passed the old proportion check despite looking visibly crushed.
   */
  const surfaceShape = () => {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const a = mesh.position.clone(); const b = mesh.position.clone(); const c = mesh.position.clone();
    const oa = mesh.position.clone(); const ob = mesh.position.clone(); const oc = mesh.position.clone();
    const ab = mesh.position.clone(); const ac = mesh.position.clone();
    const oab = mesh.position.clone(); const oac = mesh.position.clone();
    const edgeRatios = [];
    const areaRatios = [];
    const triangles = index.count / 3;
    const stride = Math.max(1, Math.floor(triangles / 12000));
    const readBind = (vertex, out) => out.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    const edgeRatio = (x, y, ox, oy) => {
      const bindLength = ox.distanceTo(oy);
      return bindLength > 1e-8 ? x.distanceTo(y) / bindLength : 1;
    };
    for (let triangle = 0; triangle < triangles; triangle += stride) {
      const ia = index.getX(triangle * 3);
      const ib = index.getX(triangle * 3 + 1);
      const ic = index.getX(triangle * 3 + 2);
      mesh.getVertexPosition(ia, a); mesh.getVertexPosition(ib, b); mesh.getVertexPosition(ic, c);
      readBind(ia, oa); readBind(ib, ob); readBind(ic, oc);
      edgeRatios.push(edgeRatio(a, b, oa, ob), edgeRatio(b, c, ob, oc), edgeRatio(c, a, oc, oa));
      ab.copy(b).sub(a); ac.copy(c).sub(a);
      oab.copy(ob).sub(oa); oac.copy(oc).sub(oa);
      const bindArea = oab.cross(oac).length();
      if (bindArea > 1e-10) areaRatios.push(ab.cross(ac).length() / bindArea);
    }
    edgeRatios.sort((x, y) => x - y);
    areaRatios.sort((x, y) => x - y);
    const percentile = (values, p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
    return {
      edgeP01: percentile(edgeRatios, 0.01), edgeP99: percentile(edgeRatios, 0.99),
      areaP01: percentile(areaRatios, 0.01), areaP99: percentile(areaRatios, 0.99),
    };
  };

  // ---------------------------------------------------------------- the knockout, over two loops
  sr.animationController.play('knockout');
  await sleep(250);
  const koBefore = sr.state().fired.strikes;
  const clipsSeen = new Set();
  let liftAtContact = 0;
  let peakCrouch = 0;
  let peakSpin = 0;
  let reverseSpin = 0;
  let aerialClipMin = Infinity;
  let aerialClipMax = -Infinity;
  let previousAerialClipTime = null;
  let maxAerialClipStep = 0;
  let maxHeldHorizontalDrift = 0;
  let minPostSpinLift = Infinity;
  let landingClipTime = 0;
  let jumpStance = null;
  let peakTrail = 0;
  let peakRings = 0;
  let koHitstop = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let maxPositionError = 0;
  let maxScaleError = 0;
  let maxRootHipLength = 0;
  let maxPhaseStep = 0;
  let maxPhaseStepLabel = 'none';
  let minSkinEdgeP01 = Infinity;
  let maxSkinEdgeP99 = 0;
  let minSkinAreaP01 = Infinity;
  let maxSkinAreaP99 = 0;
  let maxRenderedTriangles = 0;
  let maxEmbers = 0;
  let maxSmoke = 0;
  const previousCarrier = carrier.position.clone();
  let previousPhase = sr.state().seqPhase;
  let lastStrikes = koBefore;
  const contactLifts = [];
  // Stop from choreography state, not wall time: browser-driver sleeps can overshoot badly enough
  // to enter a third loop. Two contacts plus the second touchdown/recovery is the exact evidence.
  for (let i = 0; i < 600; i += 1) {
    const s = sr.state();
    clipsSeen.add(s.activeClip);
    peakTrail = Math.max(peakTrail, s.vfx.ghosts);
    peakCrouch = Math.max(peakCrouch, s.crouch || 0);
    peakSpin = Math.max(peakSpin, Math.abs(s.spin || 0));
    reverseSpin = Math.min(reverseSpin, s.spin || 0);
    if (s.inPlace) {
      if (jumpStance && s.stance) {
        maxHeldHorizontalDrift = Math.max(maxHeldHorizontalDrift,
          Math.hypot(s.stance[0] - jumpStance[0], s.stance[2] - jumpStance[2]));
      }
      if (s.activeClip.includes(':uppercut')) {
        aerialClipMin = Math.min(aerialClipMin, s.clipTime);
        aerialClipMax = Math.max(aerialClipMax, s.clipTime);
        if (previousAerialClipTime !== null && s.clipTime >= previousAerialClipTime) {
          maxAerialClipStep = Math.max(maxAerialClipStep, s.clipTime - previousAerialClipTime);
        }
        previousAerialClipTime = s.clipTime;
      }
      if (Math.abs(s.spin) >= 0.98) {
        minPostSpinLift = Math.min(minPostSpinLift, s.lift);
        if (s.activeClip.includes(':uppercut')) landingClipTime = Math.max(landingClipTime, s.clipTime);
      }
    } else {
      previousAerialClipTime = null;
    }
    maxRenderedTriangles = Math.max(maxRenderedTriangles, v.renderer.info.render.triangles);
    maxEmbers = Math.max(maxEmbers, s.vfx.embers);
    maxSmoke = Math.max(maxSmoke, s.vfx.smoke);
    peakRings = Math.max(peakRings, s.vfx.rings);
    koHitstop = Math.max(koHitstop, s.hitstop);
    if (s.proportions) {
      maxPositionError = Math.max(maxPositionError, s.proportions.maxPositionError);
      maxScaleError = Math.max(maxScaleError, s.proportions.maxScaleError);
      maxRootHipLength = Math.max(maxRootHipLength, s.proportions.rootHipLength);
    }
    if (s.seqPhase !== previousPhase) {
      const phaseStep = carrier.position.distanceTo(previousCarrier);
      if (phaseStep > maxPhaseStep) {
        maxPhaseStep = phaseStep;
        maxPhaseStepLabel = `${previousPhase}->${s.seqPhase} at ${s.seqTime.toFixed(3)}s`;
      }
      previousPhase = s.seqPhase;
    }
    previousCarrier.copy(carrier.position);
    if (s.fired.strikes > lastStrikes) {
      lastStrikes = s.fired.strikes;
      contactLifts.push(carrier.position.y);
      jumpStance = s.stance ? [...s.stance] : null;
      const shape = surfaceShape();
      minSkinEdgeP01 = Math.min(minSkinEdgeP01, shape.edgeP01);
      maxSkinEdgeP99 = Math.max(maxSkinEdgeP99, shape.edgeP99);
      minSkinAreaP01 = Math.min(minSkinAreaP01, shape.areaP01);
      maxSkinAreaP99 = Math.max(maxSkinAreaP99, shape.areaP99);
    }
    const e = extent();
    left = Math.min(left, e.left);
    right = Math.max(right, e.right);
    top = Math.min(top, e.top);
    if (s.fired.strikes - koBefore >= 2 && s.seqTime >= 2.65 && !s.poseHeld) break;
    await sleep(16);
  }
  const koStrikes = sr.state().fired.strikes - koBefore;
  liftAtContact = contactLifts.length ? Math.max(...contactLifts) : 0;

  add('SEQUENCE', clipsSeen.size >= 2, `${clipsSeen.size} clips observed: ${[...clipsSeen].join(', ')}`);
  add('RUN-PHASE', [...clipsSeen].some((c) => c.includes(':run')), `clips: ${[...clipsSeen].join(', ')}`);
  add('CROUCH', peakCrouch >= 0.1, `carrier drops ${peakCrouch.toFixed(3)} before takeoff (want >= 0.10)`);
  add('AIRBORNE', liftAtContact >= 0.4, `carrier lift ${liftAtContact.toFixed(3)} on the contact frame (want >= 0.40)`);
  add('SPIN-360', peakSpin >= 0.98 && reverseSpin <= -0.98,
    `${reverseSpin.toFixed(3)} reverse turns observed before touchdown (want <= -0.98)`);
  const aerialClipTravel = Number.isFinite(aerialClipMin) ? aerialClipMax - aerialClipMin : 0;
  add('POSE-FLOW', aerialClipTravel >= 0.48 && maxAerialClipStep <= 0.05,
    `uppercut advances ${aerialClipTravel.toFixed(3)}s through the spin, max frame step `
    + `${maxAerialClipStep.toFixed(4)}s (want >= 0.48 travel and <= 0.05 step)`);
  add('IN-PLACE', maxHeldHorizontalDrift <= 0.02,
    `stance moved ${maxHeldHorizontalDrift.toFixed(4)} horizontally from the jump mark through spin and landing (want <= 0.020)`);
  add('TOUCHDOWN', minPostSpinLift <= 0.02,
    `minimum carrier lift after the spin ${minPostSpinLift.toFixed(3)} (want <= 0.020 before returning home)`);
  add('LAND-POSE', landingClipTime >= 1.10 && landingClipTime <= 1.18,
    `uppercut recovery reached ${landingClipTime.toFixed(3)}s as the reverse turn touched down (target 1.137s)`);
  add('TRAIL', peakTrail >= 4, `${peakTrail} afterimages live at once (want >= 4)`);
  add('ONCE', koStrikes === 2, `${koStrikes} contacts across two 3.00 s loops (want exactly 2)`);
  add('RINGS', peakRings === 3, `${peakRings} shock rings (the knockout shape is 3)`);
  add('FRAME-X', left >= 40 && right <= W - 40, `bones span ${Math.round(left)}..${Math.round(right)} px of ${W} (want 40..${W - 40})`);
  add('FRAME-Y', top >= 70, `head bone reaches ${Math.round(top)} px from the top (want >= 70)`);
  add('PROPORTIONS', maxPositionError <= 1e-6 && maxScaleError <= 1e-6 && maxRootHipLength <= 0.56,
    `max bind-position error ${maxPositionError}, scale error ${maxScaleError}, Root-Hip ${maxRootHipLength} (want <= 0.56)`);
  // The low tail includes triangles folded tightly around Raz's authored clavicle/twist
  // weights during the overhead punch. Keep the boundary comfortably above the broken
  // world-pose retarget while allowing that intentional joint compression.
  add('SKIN-SHAPE', minSkinEdgeP01 >= 0.6 && maxSkinEdgeP99 <= 1.9
    && minSkinAreaP01 >= 0.35 && maxSkinAreaP99 <= 2.1,
  `contact skin edge p01..p99 ${minSkinEdgeP01.toFixed(3)}..${maxSkinEdgeP99.toFixed(3)}, `
    + `area ${minSkinAreaP01.toFixed(3)}..${maxSkinAreaP99.toFixed(3)} `
    + '(retarget failure was edge 0.368..3.387, area 0.131..3.549)');
  add('VFX-BUDGET', maxRenderedTriangles <= 600000 && maxEmbers <= 720 && maxSmoke <= 400,
    `peak ${maxRenderedTriangles} triangles, ${maxEmbers} embers, ${maxSmoke} smoke `
    + '(old full-shell ghosts peaked at 1718356 triangles, 918 embers, 445 smoke)');
  add('PHASE-CONTINUITY', maxPhaseStep <= 0.15,
    `largest carrier step at a phase seam ${maxPhaseStep.toFixed(4)} (${maxPhaseStepLabel}; want <= 0.15)`);

  // ------------------------------------------------------------- every other action, for regression
  const seen = {};
  let otherHitstop = 0;
  for (const c of sr.clips) {
    if (c.id === 'knockout') continue;
    sr.animationController.play(c.id);
    await sleep(220);
    const before = sr.state();
    let kind = null;
    let stop = 0;
    for (let i = 0; i < 150; i += 1) {
      const s = sr.state();
      stop = Math.max(stop, s.hitstop);
      if (s.lastContact) kind = s.lastContact.kind;
      await sleep(20);
    }
    const after = sr.state();
    seen[c.id] = { strikes: after.fired.strikes - before.fired.strikes, kind, stop };
    otherHitstop = Math.max(otherHitstop, stop);
  }

  add('HITSTOP', koHitstop > otherHitstop, `knockout ${koHitstop.toFixed(3)}s vs the next largest ${otherHitstop.toFixed(3)}s`);

  /**
   * POWER — assert the VALUE, not the ranking. This is the check that catches a dead credit.
   *
   * The knockout's whole premise is that the body's closing speed is added to a hand the strike
   * sweep called too slow, clamping power to 1.0. When that credit silently stopped firing (the
   * lunge profile's `arrive` is on the composite clock, the strike's time is clip-local, and the
   * runtime compared them directly), power fell to 0.575 and hitstop to 0.180 s — and HITSTOP above
   * still passed, because 0.180 is still larger than every other action. A ranking check cannot see
   * a blow that is merely weaker than it should be.
   *
   * Power is recovered from hitstop by inverting the two formulas in `razVfx.ts`:
   *   force   = 0.55 + power * 0.75
   *   hitstop = STRIKE_SHAPE.knockout.hitstop * (0.7 + force * 0.4)     (0.130 s base)
   * so power 1.0 => 0.1586 s and power 0.575 => 0.1420 s. Anything under 0.99 means the credit is
   * not arriving.
   */
  /**
   * SAMPLE THIS TIGHTLY. `hitstop` is a countdown that decays every frame, so `state()` returns
   * whatever is LEFT of it, not the value it was set to. Polled at 18 ms this check read an implied
   * power of 0.663 on a build that actually clamps to 1.0 — a false failure. The loop above samples
   * at 16 ms across two full composite loops, which lands on the set frame; anything slacker makes
   * this check flaky, and a flaky gate is worse than no gate.
   */
  const impliedPower = ((koHitstop / 0.130 - 0.7) / 0.4 - 0.55) / 0.75;
  add('POWER', impliedPower >= 0.99,
    `hitstop ${koHitstop.toFixed(4)}s implies power ${impliedPower.toFixed(3)} (want >= 0.99; 0.575 means the closing-speed credit is dead)`);

  const expected = {
    combination: 'cross', lead: 'straight', hook: 'hook',
    'front-kick': 'kick', fireball: 'kick', 'snap-kick': 'kick', dash: 'straight',
  };
  const wrong = Object.entries(expected)
    .filter(([id, kind]) => seen[id] && (seen[id].strikes === 0 || seen[id].kind !== kind))
    .map(([id, kind]) => `${id} expected ${kind} got ${seen[id].kind}/${seen[id].strikes} strikes`);
  add('REGRESS', wrong.length === 0, wrong.length ? wrong.join('; ') : 'every striking action still fires its own measured kind');

  add('SCOPE', seen.footwork && seen.footwork.strikes === 0,
    `footwork fired ${seen.footwork ? seen.footwork.strikes : '?'} strikes (want 0)`);

  const locomotion = ['rage', 'footwork', 'charge', 'guard'].filter((id) => seen[id] && seen[id].strikes !== 0);
  add('IDLE', locomotion.length === 0, locomotion.length ? `these fired strikes: ${locomotion.join(', ')}` : 'rage, footwork, charge, guard all fire none');

  // ------------------------------------------------------------------------------- NaN geometry
  const nan = [];
  v.scene.traverse((o) => {
    if (!o.geometry) return;
    o.geometry.computeBoundingSphere();
    const s = o.geometry.boundingSphere;
    if (!s || !Number.isFinite(s.radius)) nan.push(o.geometry.type);
  });
  add('CLEAN', nan.length === 0, nan.length ? `NaN bounding spheres: ${nan.join(', ')}` : 'every geometry has a finite bounding sphere');

  const passed = checks.filter((c) => c.ok).length;
  return {
    checks,
    passed,
    total: checks.length,
    score: (10 * passed) / checks.length,
    failing: checks.filter((c) => !c.ok).map((c) => c.name),
  };
};
