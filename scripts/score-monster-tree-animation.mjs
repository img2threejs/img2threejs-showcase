/**
 * Score the authored animation, out of ten, from a running browser.
 *
 *   node tools/score-animation.mjs [--url http://127.0.0.1:5347/showcase.html] [--json]
 *
 * WHY THIS EXISTS. "The animation looks good" is an opinion and it is not reviewable. Every check
 * below reads a number out of the real showcase — the real skinned rig, the real AnimationMixer,
 * the real skill runner — and the total is a measurement anyone can reproduce by running this file.
 *
 * HOW IT SAMPLES. Deterministically. The clip is stepped by hand at a fixed rate and the pose
 * solved exactly as the frame loop solves it (`mixer.update(0)` → `runner.update` → `applyPose` →
 * `applyStretch`), so a result never depends on what the render loop happened to do that second.
 * An earlier version of this harness sampled from its own rAF and divided by near-zero frame
 * deltas, which reported hand speeds of 51,000 H/s on motion that was in fact smooth.
 *
 * Ten checks, one point each. Partial credit is on a stated curve so the score moves as the work
 * improves rather than flipping between 0 and 1.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * CloakBrowser is installed globally on this machine rather than as a dependency of the demo.
 * Adding a browser driver to the project's package.json to run a review harness would put a
 * several-hundred-megabyte install in the way of anyone who only wants to build the page, so it is
 * resolved from where it lives — reading the package's own `exports` map rather than guessing at an
 * entry file, because `require.resolve` refuses a package that only publishes ESM exports.
 */
const DRIVER = join(homedir(), 'cloakbrowser-e2e', 'node_modules', 'cloakbrowser');
const manifest = JSON.parse(readFileSync(join(DRIVER, 'package.json'), 'utf8'));
const entry = manifest.exports?.['.']?.import ?? manifest.main;
const { launch } = await import(pathToFileURL(join(DRIVER, entry)).href);

const URL = process.argv.find((a) => a.startsWith('--url='))?.slice(6)
  ?? 'http://127.0.0.1:5347/showcase.html';
const JSON_OUT = process.argv.includes('--json');
const KIT = ['passive', 'vine', 'natures-call', 'ultimate'];
const RATE = 240;

const browser = await launch({ headless: true });
const page = await browser.newPage();
await page.setViewportSize({ width: 1000, height: 900 });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => document.getElementById('status')?.hidden, { timeout: 240000 });
await page.waitForTimeout(2500);

const data = await page.evaluate(({ kit, rate }) => {
  const mt = window.monsterTree;
  const H = 1.9;
  const TRACKED = ['L_Hand', 'R_Hand', 'L_Forearm', 'R_Forearm', 'L_Upperarm', 'R_Upperarm', 'Head', 'Spine02'];
  const AIMED = ['Waist', 'Spine01', 'Spine02', 'L_Clavicle', 'L_Upperarm', 'L_Forearm',
    'R_Clavicle', 'R_Upperarm', 'R_Forearm', 'L_Thigh', 'L_Calf', 'R_Thigh', 'R_Calf'];

  const wp = (name) => {
    const e = mt.rig.bones[name].matrixWorld.elements;
    return [e[12], e[13], e[14]];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const canvas = document.querySelector('#stage canvas');
  const V3 = mt.camera.position.constructor;
  const px = ([x, y, z]) => {
    const v = new V3(x, y, z).project(mt.camera);
    return [(v.x * 0.5 + 0.5) * canvas.clientWidth, (-v.y * 0.5 + 0.5) * canvas.clientHeight];
  };

  /** Step one skill through its whole clip, solving the pose exactly as the frame loop does. */
  const sweep = (skill) => {
    mt.runner.play(skill);
    const clip = mt.rig.clips.find((c) => c.name === mt.runner.current.clip);
    const action = mt.rig.mixer.existingAction(clip);
    // Let the hand-over finish before sampling, WITH THE PLAYHEAD PINNED. A move fades its gesture
    // in over its own cross-fade window, and sampling from frame zero measures that ramp rather
    // than the animation — on the passive, whose own motion is tiny, the ramp read as a 5x spike.
    //
    // Pinning matters: settling by advancing real time ran the one-shot clips off their own ends,
    // the runner handed back to idle, and the sweep then measured idle for every skill. It scored
    // beautifully on speed and reported every payoff pose as indistinguishable, which is what
    // measuring the wrong thing looks like when the wrong thing happens to be very smooth.
    for (let i = 0; i < 90; i += 1) {
      action.time = 0;
      mt.rig.mixer.update(0);
      mt.runner.update(1 / 60);
      mt.rig.applyPose();
      mt.rig.applyStretch();
    }
    const n = Math.max(4, Math.round(clip.duration * rate));
    const frames = [];
    for (let i = 0; i <= n; i += 1) {
      const t = (i / n) * clip.duration;
      action.time = t;
      mt.rig.mixer.update(0);
      mt.runner.update(1 / rate);
      mt.rig.applyPose();
      mt.rig.applyStretch();
      mt.rig.group.updateMatrixWorld(true);
      const pose = {};
      for (const b of TRACKED) pose[b] = wp(b);
      // The same pose in SCREEN space. A gesture only exists if it survives the projection, and
      // three-dimensional distance cannot tell you whether it did.
      const screen = {};
      for (const b of TRACKED) screen[b] = px(pose[b]);
      frames.push({
        t,
        pose,
        screen,
        toeL: wp('L_ToeBase')[1],
        toeR: wp('R_ToeBase')[1],
        scaleForearm: mt.rig.bones.L_Forearm.scale.y,
      });
    }
    return { clip: clip.name, duration: clip.duration, frames };
  };

  const out = { clips: {}, transitions: [], residue: {}, payoff: {}, payoffScreen: {}, restPose: null, restScreen: null };

  // The resting pose, for the "is this move readable" comparison.
  {
    const s = sweep('idle');
    out.restPose = s.frames[Math.floor(s.frames.length / 2)].pose;
    out.restScreen = s.frames[Math.floor(s.frames.length / 2)].screen;
  }

  for (const skill of kit) {
    const s = sweep(skill);
    const speed = { L: [], R: [] };
    for (let i = 1; i < s.frames.length; i += 1) {
      speed.L.push(dist(s.frames[i].pose.L_Hand, s.frames[i - 1].pose.L_Hand) * rate / H);
      speed.R.push(dist(s.frames[i].pose.R_Hand, s.frames[i - 1].pose.R_Hand) * rate / H);
    }
    const all = speed.L.concat(speed.R).sort((a, b) => a - b);
    const q = (f) => all[Math.min(all.length - 1, Math.floor(all.length * f))];
    const peak = all[all.length - 1];
    const p90 = q(0.90);
    let worstRatioAt = 0;
    let worstRatio = 0;
    for (const side of ['L', 'R']) {
      // Each hand against ITS OWN distribution. Pooling both drags the quantile down with whichever
      // arm is standing still, and then the working arm looks like a teleport for doing its job:
      // Vine Lash throws with one hand and holds the other, so pooled it read 5x its own p90.
      const own = [...speed[side]].sort((x, y) => x - y);
      const ref = Math.max(0.05, own[Math.floor(own.length * 0.90)]);
      for (let i = 0; i < speed[side].length; i += 1) {
        const r = speed[side][i] / ref;
        if (r > worstRatio) { worstRatio = r; worstRatioAt = s.frames[i + 1].t; }
      }
    }
    const toeLo = Math.min(...s.frames.map((f) => Math.min(f.toeL, f.toeR)));
    const toeHi = Math.min(...s.frames.map((f) => Math.max(f.toeL, f.toeR)));
    // Motion during a HOLD, if the skill declares one: the window between the arms arriving and
    // the move committing at the end.
    const hold = skill === 'natures-call' && window.monsterTree.beats
      ? [window.monsterTree.beats.logs.raised + 0.05, window.monsterTree.beats.logs.finish - 0.15]
      : null;
    let holdMean = 0;
    if (hold) {
      const inWindow = [];
      for (let i = 1; i < s.frames.length; i += 1) {
        const t = s.frames[i].t;
        if (t < hold[0] || t > hold[1]) continue;
        inWindow.push(dist(s.frames[i].pose.L_Hand, s.frames[i - 1].pose.L_Hand) * rate / H);
        inWindow.push(dist(s.frames[i].pose.R_Hand, s.frames[i - 1].pose.R_Hand) * rate / H);
      }
      holdMean = inWindow.length ? inWindow.reduce((a, b) => a + b, 0) / inWindow.length : 0;
    }

    out.clips[skill] = {
      duration: +s.duration.toFixed(3),
      holdMean: +holdMean.toFixed(4),
      peak: +peak.toFixed(3),
      p90: +p90.toFixed(3),
      mean: +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(4),
      worstRatio: +worstRatio.toFixed(2),
      worstRatioAt: +worstRatioAt.toFixed(3),
      // The LOWER toe at each frame: the planted one. A gesture may lift one foot; it must not
      // float on both.
      plantedHighest: +toeHi.toFixed(4),
      toeLowest: +toeLo.toFixed(4),
      // Arrests, for the beat-agreement check.
      arrests: (() => {
        const found = [];
        for (const side of ['L', 'R']) {
          const v = speed[side];
          for (let i = 2; i < v.length - 1; i += 1) {
            const decel = (v[i - 1] - v[i]) * rate;
            if (v[i - 1] > 0.9 && v[i] < v[i - 1] * 0.55 && decel > 40) {
              found.push({ side, at: +s.frames[i + 1].t.toFixed(3), decel: Math.round(decel) });
            }
          }
        }
        found.sort((a, b) => b.decel - a.decel);
        const kept = [];
        for (const a of found) if (!kept.some((k) => Math.abs(k.at - a.at) < 0.08)) kept.push(a);
        return kept.sort((a, b) => a.at - b.at).slice(0, 8);
      })(),
    };

    // Payoff pose: the frame of the clip's own strongest arrest, or its midpoint if it has none.
    const beat = out.clips[skill].arrests[0]?.at ?? s.duration * 0.5;
    const at = s.frames.reduce((a, b) => (Math.abs(b.t - beat) < Math.abs(a.t - beat) ? b : a));
    out.payoff[skill] = at.pose;
    out.payoffScreen[skill] = at.screen;
  }

  // Transitions: play A, jump to B, and watch the hands across the switch under a REAL delta.
  const pairs = [];
  for (const a of [...kit, 'idle']) for (const b of [...kit, 'idle']) if (a !== b) pairs.push([a, b]);
  for (const [a, b] of pairs) {
    mt.runner.play(a);
    for (let i = 0; i < 40; i += 1) {
      mt.rig.update(1 / 60); mt.runner.update(1 / 60); mt.rig.applyPose(); mt.rig.applyStretch();
    }
    mt.rig.group.updateMatrixWorld(true);
    let prev = [wp('L_Hand'), wp('R_Hand')];
    mt.runner.play(b);
    let worst = 0;
    let worstAt = 0;
    const jumps = [];
    for (let i = 0; i < 50; i += 1) {
      mt.rig.update(1 / 60); mt.runner.update(1 / 60); mt.rig.applyPose(); mt.rig.applyStretch();
      mt.rig.group.updateMatrixWorld(true);
      const now = [wp('L_Hand'), wp('R_Hand')];
      jumps.push(Math.max(dist(now[0], prev[0]), dist(now[1], prev[1])));
      prev = now;
    }
    // A POP IS A DISCONTINUITY, NOT SPEED. Taking the largest single-frame jump punished Vine
    // Lash for having a fast throw in it — its release genuinely moves the hand 0.24 units in a
    // frame, and that is the move working. What a pop looks like is a frame that stands ALONE:
    // much larger than the frames either side of it. Measuring the excess over its own neighbours
    // separates "this animation is quick here" from "this animation teleported here".
    for (let i = 1; i < jumps.length - 1; i += 1) {
      const excess = jumps[i] - Math.max(jumps[i - 1], jumps[i + 1]);
      if (excess > worst) { worst = excess; worstAt = i; }
    }
    // Frame 0 has no "before", so it is compared against what follows it.
    const first = jumps[0] - Math.max(jumps[1] ?? 0, jumps[2] ?? 0);
    if (first > worst) { worst = first; worstAt = 0; }
    out.transitions.push({ from: a, to: b, jump: +Math.max(0, worst).toFixed(4), frame: worstAt });
  }

  // Residue: after a kit skill hands back to idle, does anything stay behind?
  {
    /**
     * Read every comparison at the SAME idle playhead.
     *
     * Idle is a 15.4-second clip. Comparing "idle reached from a clean start" against "idle reached
     * after a skill" without pinning the time compares two different frames of the same animation,
     * and reports the difference between them as residue: 2.48 degrees on a bone nothing had left
     * behind at all.
     */
    const IDLE_AT = 4.0;
    const settleIdle = () => {
      for (let i = 0; i < 120; i += 1) { mt.rig.update(1 / 60); mt.runner.update(1 / 60); mt.rig.applyPose(); mt.rig.applyStretch(); }
      const clip = mt.rig.clips.find((c) => c.name === mt.runner.current.clip);
      const action = mt.rig.mixer.existingAction(clip);
      if (action) { action.time = IDLE_AT; mt.rig.mixer.update(0); mt.runner.update(1 / 60); mt.rig.applyPose(); mt.rig.applyStretch(); }
      mt.rig.group.updateMatrixWorld(true);
    };
    mt.runner.play('idle');
    settleIdle();
    const clean = {};
    for (const b of AIMED) clean[b] = mt.rig.bones[b].quaternion.toArray();
    const cleanScale = mt.rig.bones.L_Forearm.scale.y;
    const home = mt.rig.group.position.toArray();

    let worstAngle = 0;
    let worstBone = '';
    let worstScale = 0;
    let worstHome = 0;
    for (const skill of kit) {
      mt.runner.play(skill);
      for (let i = 0; i < 260; i += 1) { mt.rig.update(1 / 60); mt.runner.update(1 / 60); mt.rig.applyPose(); mt.rig.applyStretch(); }
      mt.runner.play('idle');
      settleIdle();
      for (const b of AIMED) {
        const q = mt.rig.bones[b].quaternion.toArray();
        const dot = Math.abs(q[0] * clean[b][0] + q[1] * clean[b][1] + q[2] * clean[b][2] + q[3] * clean[b][3]);
        const deg = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
        if (deg > worstAngle) { worstAngle = deg; worstBone = `${skill}/${b}`; }
      }
      worstScale = Math.max(worstScale, Math.abs(mt.rig.bones.L_Forearm.scale.y - cleanScale));
      const p = mt.rig.group.position.toArray();
      worstHome = Math.max(worstHome, Math.hypot(p[0] - home[0], p[1] - home[1], p[2] - home[2]));
    }
    out.residue = {
      worstAngleDeg: +worstAngle.toFixed(2), worstBone, worstScale: +worstScale.toFixed(5), worstHome: +worstHome.toFixed(5),
    };
  }

  mt.runner.play('idle');
  return out;
}, { kit: KIT, rate: RATE });

/**
 * Frame timing, measured live — TWICE, keeping the better pass per skill.
 *
 * A stall in the code lands on the same skill at the same clip time on every run: the earlier
 * shader-compile and light-recompile stalls did exactly that, 52 ms on Bark Strike's payoff, every
 * single pass. A garbage collection or a scheduling hiccup in a headless browser lands wherever it
 * lands — across four runs of an unchanged build this check saw its worst frame on `passive`, then
 * `vine`, then `grove`, then `vine` again, and swung the total by 0.17.
 *
 * Taking the better of two passes keeps the first kind and drops the second, which is the whole
 * difference between measuring the build and measuring the machine.
 */
const timing = await page.evaluate(async (skills) => {
  const pass = async (list) => {
  const out = {};
  for (const s of list) {
    window.monsterTree.runner.play(s);
    const stamps = [];
    await new Promise((resolve) => {
      const started = performance.now();
      const loop = () => {
        stamps.push(performance.now());
        if (performance.now() - started > 2600) resolve();
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const d = [];
    for (let i = 1; i < stamps.length; i += 1) d.push(stamps[i] - stamps[i - 1]);
    d.sort((a, b) => a - b);
    out[s] = {
      p95: +d[Math.floor(d.length * 0.95)].toFixed(1),
      max: +d[d.length - 1].toFixed(1),
      over25: d.filter((x) => x > 25).length,
    };
  }
  window.monsterTree.runner.play('idle');
  return out;
  };
  const a = await pass(skills);
  const b = await pass(skills);
  const merged = {};
  for (const s of skills) {
    merged[s] = a[s].max <= b[s].max ? a[s] : b[s];
    merged[s].repeated = Math.min(a[s].over25, b[s].over25);
  }
  return merged;
}, ['passive', 'vine', 'natures-call', 'ultimate', 'echoes', 'grove', 'idle',
  'strike', 'combo', 'uppercut', 'kick', 'stomp', 'ignite', 'fall']);

const beats = await page.evaluate(() => window.monsterTree.beats ?? null);
await browser.close();

// ---------------------------------------------------------------- scoring
const checks = [];
const add = (name, score, detail) => checks.push({ name, score: Math.max(0, Math.min(1, score)), detail });
const ramp = (value, good, bad) => (value <= good ? 1 : value >= bad ? 0 : (bad - value) / (bad - good));

// 2. no teleports
{
  let worstPeak = 0; let worstRatio = 0; let who = '';
  for (const [k, c] of Object.entries(data.clips)) {
    if (c.peak > worstPeak) worstPeak = c.peak;
    if (c.worstRatio > worstRatio) { worstRatio = c.worstRatio; who = `${k}@${c.worstRatioAt}s`; }
  }
  add('no teleports', Math.min(ramp(worstPeak, 12, 30), ramp(worstRatio, 4, 12)),
    `peak ${worstPeak} H/s, worst frame ${worstRatio}x its clip's p90 (${who})`);
}
// 3. no stalls
{
  const rows = Object.entries(timing);
  const worst = rows.reduce((a, b) => (b[1].max > a[1].max ? b : a));
  const worstP95 = rows.reduce((a, b) => (b[1].p95 > a[1].p95 ? b : a));
  // Only stalls that showed up in BOTH passes count.
  const stalls = rows.reduce((s, [, v]) => s + v.repeated, 0);
  // A stall is the defect; p95 only needs to stay off the floor. Scoring p95 on a tight 12-20ms
  // ramp made the total swing 0.16 between identical runs, because a headless browser's p95 moves
  // by several milliseconds on its own — a rubric that reports a different number for the same
  // build is not measuring the build.
  add('no frame stalls', stalls > 0 ? 0.3 * ramp(worst[1].max, 25, 60) : ramp(worstP95[1].p95, 20, 33),
    `worst max ${worst[1].max}ms (${worst[0]}), worst p95 ${worstP95[1].p95}ms (${worstP95[0]}), stalls seen in both passes: ${stalls}`);
}
// 4. transitions
{
  const sorted = [...data.transitions].sort((a, b) => b.jump - a.jump);
  const worst = sorted[0];
  add('transitions do not pop', ramp(worst.jump, 0.10, 0.45),
    `worst ${sorted.slice(0, 3).map((s) => `${s.from}->${s.to} ${s.jump}@f${s.frame}`).join(', ')}`);
}
// 5. beats agree
{
  const vine = data.clips.vine?.arrests ?? [];
  const near = (list, target) => list.length
    ? Math.min(...list.map((a) => Math.abs(a.at - target)))
    : 99;
  const dv = near(vine, beats?.vine?.release ?? 0.34);
  add('beats match the gesture', ramp(dv, 0.06, 0.30),
    `Vine Lash arrest is ${dv.toFixed(3)}s from its authored release`);
}
// 6. alive
{
  const p = data.clips.passive?.mean ?? 0;
  // The hold, not the whole clip. Nature's Call spends its first 0.42s raising both arms, and
  // averaging that in reports the raise rather than the thing the criterion is about.
  const n = data.clips['natures-call']?.holdMean ?? 0;
  const inBand = (v, lo, hi) => (v >= lo && v <= hi ? 1 : v < lo ? v / lo : ramp(v, hi, hi * 3));
  add('holds are alive', Math.min(inBand(p, 0.03, 0.35), inBand(n, 0.02, 0.5)),
    `passive mean ${p} H/s, Nature's Call hold-window mean ${n} H/s`);
}
// 7. feet
{
  let worstFloat = 0; let worstSink = 0;
  for (const c of Object.values(data.clips)) {
    worstFloat = Math.max(worstFloat, c.plantedHighest);
    worstSink = Math.min(worstSink, c.toeLowest);
  }
  add('feet stay planted', Math.min(ramp(worstFloat, 0.10 * 1.9, 0.45 * 1.9), ramp(-worstSink, 0.01, 0.12)),
    `planted toe rises to ${worstFloat.toFixed(3)}, lowest toe ${worstSink.toFixed(3)}`);
}
// 8. readable + distinct payoffs
{
  const meanDist = (a, b) => {
    const keys = Object.keys(a);
    return keys.reduce((s, k) => s + Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1], a[k][2] - b[k][2]), 0) / keys.length;
  };
  // The three ACTIVES only. The passive is a resting stance by definition — measuring how far it
  // sits from the resting pose tests nothing about it, and an earlier version of this check spent
  // most of its budget failing the passive for being what it is meant to be. It still takes part
  // in the pairwise check below, where "is this a different move" does mean something.
  const ACTIVES = ['vine', 'natures-call', 'ultimate'];
  const fromRest = ACTIVES.filter((k) => data.payoff[k]).map((k) => [k, meanDist(data.payoff[k], data.restPose)]);
  const worstRest = fromRest.reduce((a, b) => (b[1] < a[1] ? b : a));
  let closest = ['', '', 99];
  const names = Object.keys(data.payoff);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const d = meanDist(data.payoff[names[i]], data.payoff[names[j]]);
      if (d < closest[2]) closest = [names[i], names[j], d];
    }
  }
  add('payoffs are readable and distinct',
    Math.min(ramp(0.25 - worstRest[1], 0, 0.25), ramp(0.12 - closest[2], 0, 0.12)),
    `least distinct from rest: ${worstRest[0]} at ${worstRest[1].toFixed(3)}; closest pair ${closest[0]}/${closest[1]} at ${closest[2].toFixed(3)}`);
}
// 8b. does the gesture survive the projection?
{
  // Measured in PIXELS on the demo's own canvas. A pose can be far from rest in three dimensions
  // and invisible on screen: raising both arms along the axis the camera looks down foreshortens
  // them into a smear over the chest, which scored full marks on 3D displacement and was
  // unreadable in the render. This check is what caught that.
  const spread = (screen) => {
    const hands = [screen.L_Hand, screen.R_Hand];
    const torso = screen.Spine02;
    // How far the hands sit from the torso on screen, and from each other.
    const reach = hands.reduce((s, h) => s + Math.hypot(h[0] - torso[0], h[1] - torso[1]), 0) / 2;
    const apart = Math.hypot(hands[0][0] - hands[1][0], hands[0][1] - hands[1][1]);
    return { reach, apart };
  };
  const rest = spread(data.restScreen);
  let worst = ['', 1e9];
  for (const [k, s] of Object.entries(data.payoffScreen)) {
    if (k === 'passive') continue;
    const v = spread(s);
    // Either the hands reach further from the body than at rest, or they open wider from each
    // other. A gesture that does neither is not visible as a gesture.
    const score = Math.max(v.reach / Math.max(1, rest.reach), v.apart / Math.max(1, rest.apart));
    if (score < worst[1]) worst = [k, score];
  }
  add('gestures survive the projection', ramp(1.15 - worst[1], 0, 0.35),
    `weakest on screen: ${worst[0]} at ${worst[1].toFixed(2)}x the resting spread`);
}

// 9. residue
{
  const r = data.residue;
  add('nothing left behind',
    Math.min(ramp(r.worstAngleDeg, 2, 25), ramp(r.worstScale, 0.001, 0.06), ramp(r.worstHome, 0.001, 0.15)),
    `worst bone ${r.worstAngleDeg}deg (${r.worstBone}), scale residue ${r.worstScale}, position residue ${r.worstHome}`);
}
// 10. clean run
add('clean run', consoleErrors.length ? 0 : 1,
  consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'no console errors');
// 1. harness itself + determinism placeholder (scored by the caller re-running)
add('harness reports every clip', Object.keys(data.clips).length === KIT.length ? 1 : 0,
  `${Object.keys(data.clips).length}/${KIT.length} kit clips swept`);

// Scaled to ten however many checks there are, so adding a check does not inflate the score. The
// screen-space check was added after the rubric was written and it would otherwise have taken the
// total from 10 to 11 without a single thing improving.
const raw = checks.reduce((s, c) => s + c.score, 0);
const total = (raw / checks.length) * 10;

if (JSON_OUT) {
  console.log(JSON.stringify({ total: +total.toFixed(2), raw: +raw.toFixed(2), checks: checks.length, breakdown: checks, clips: data.clips, timing, residue: data.residue }, null, 2));
} else {
  console.log('\nY’bneth animation score\n');
  for (const c of checks) {
    console.log(`  ${c.score.toFixed(2)}  ${c.name.padEnd(30)} ${c.detail}`);
  }
  console.log(`\n  TOTAL ${total.toFixed(2)} / 10   (${raw.toFixed(2)} of ${checks.length} checks)\n`);
}
process.exit(total > 9.0 ? 0 : 1);
