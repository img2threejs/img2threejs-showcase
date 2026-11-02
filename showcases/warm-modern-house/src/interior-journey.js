// Guided journey controller. A journey is a manifest path (runtime Y-up metres):
//   { id, speed, rooms: [roomId, ...], keys: [{ position: [x, y, z], target: [x, y, z], stopMs }] }
// The camera never interpolates through space: every position comes from the pure
// walker (createWalkNavigation), which owns walls, holes, portals, steps, slopes and
// headroom. Keys only describe the intended route; the walker is driven toward the
// straight-line point of the current segment and the result is checked against it.
// A blocked move, an XZ divergence or an eye-height mismatch beyond tolerance is a
// journey error, never a silent re-route or teleport.
//
// Nothing here owns a timer, thread or renderer: the host calls update(dt).
import { createWalkNavigation, validateWalkNavigation } from './interior-walk.js';
// Largest 3D distance advanced per walker move; keeps eye-height checks dense on stairs.
export const JOURNEY_STEP = 0.1;
// First key must sit within this of the walk surface + eyeHeight.
export const JOURNEY_START_HEIGHT_TOLERANCE = 0.2;
// Allowed eye-height deviation from the straight key-to-key line while walking.
export const JOURNEY_HEIGHT_TOLERANCE = 0.2;
// Allowed XZ deviation of the walker from the straight key-to-key line.
export const JOURNEY_XZ_TOLERANCE = 0.02;

const finite = v => typeof v === 'number' && Number.isFinite(v);
const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(finite);
const fmt = v => (Math.round(v*1000)/1000).toString();

function compilePath(path) {
  const label = `journey ${path?.id ?? '?'}`;
  if (!path || typeof path !== 'object') throw new Error('journey path must be an object');
  if (!finite(path.speed) || path.speed <= 0) throw new Error(`${label}: speed must be a positive finite number`);
  if (!Array.isArray(path.rooms) || !path.rooms.length || !path.rooms.every(r => typeof r === 'string' && r)) {
    throw new Error(`${label}: rooms must be a non-empty list of room ids`);
  }
  if (!Array.isArray(path.keys) || path.keys.length < 2) throw new Error(`${label}: keys must hold at least two keys`);
  const keys = path.keys.map((key, i) => {
    if (!key || !vec3(key.position)) throw new Error(`${label}: key[${i}].position must be three finite numbers`);
    if (!vec3(key.target)) throw new Error(`${label}: key[${i}].target must be three finite numbers`);
    const stopMs = key.stopMs ?? 0;
    if (!finite(stopMs) || stopMs < 0) throw new Error(`${label}: key[${i}].stopMs must be a finite number >= 0`);
    return { position: key.position.slice(), target: key.target.slice(), stopSeconds: stopMs/1000 };
  });
  const lengths = [];
  for (let i = 0; i+1 < keys.length; i++) {
    const a = keys[i].position, b = keys[i+1].position;
    const length = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    if (!finite(length)) throw new Error(`${label}: segment ${i} length is not finite`);
    lengths.push(length);
  }
  return { id: path.id, label, speed: path.speed, rooms: [...new Set(path.rooms)], firstRoom: path.rooms[0], keys, lengths };
}

// Walker plus a cursor over the path. The cursor holds all progress; the walker holds
// the actual position. Used for both preflight and live playback so they cannot diverge.
function createRun({ navigation, journey, room }) {
  const eye = navigation.eyeHeight;
  const first = journey.keys[0].position;
  let walker;
  try {
    walker = createWalkNavigation({ navigation, room, position: [first[0], first[2]], y: first[1]-eye });
  } catch (error) {
    throw new Error(`${journey.label}: start key is not walkable in room ${room}: ${error.message}`);
  }
  const keys = journey.keys, lengths = journey.lengths, last = keys.length-1;
  const cursor = { key: 0, along: 0, dwell: 0, done: false };

  function fail(message) { throw new Error(`${journey.label}: ${message}`); }

  function begin(skipDwell) {
    const a = keys[0].position;
    try {
      walker.teleport(room, a[0], a[2], { y: a[1]-eye });
    } catch (error) {
      fail(`start key is not walkable in room ${room}: ${error.message}`);
    }
    const gap = walker.snapshot().position[1]-a[1];
    if (Math.abs(gap) > JOURNEY_START_HEIGHT_TOLERANCE) {
      fail(`start key height ${fmt(a[1])} is ${fmt(Math.abs(gap))} m from the walk surface plus eye height (${fmt(a[1]+gap)})`);
    }
    cursor.key = 0; cursor.along = 0; cursor.done = false;
    cursor.dwell = skipDwell ? 0 : keys[0].stopSeconds;
  }

  // Moves the walker toward the point `along` metres into segment `key`.
  function walkTo(key, along) {
    const a = keys[key].position, b = keys[key+1].position;
    const f = lengths[key] > 0 ? along/lengths[key] : 1;
    const wx = a[0]+(b[0]-a[0])*f, wy = a[1]+(b[1]-a[1])*f, wz = a[2]+(b[2]-a[2])*f;
    const result = walker.move(wx-walker.x, wz-walker.z);
    const where = `between key ${key} and key ${key+1} at [${fmt(wx)}, ${fmt(wy)}, ${fmt(wz)}]`;
    if (result.blocked) fail(`walk is blocked ${where} (room ${result.room}, wall, hole or obstruction)`);
    if (Math.hypot(result.x-wx, result.z-wz) > JOURNEY_XZ_TOLERANCE) {
      fail(`walker diverged from the path ${where}: reached [${fmt(result.x)}, ${fmt(result.z)}]`);
    }
    const y = result.y+eye;
    if (Math.abs(y-wy) > JOURNEY_HEIGHT_TOLERANCE) {
      fail(`path height ${fmt(wy)} does not match walk surface eye height ${fmt(y)} ${where} (room ${result.room})`);
    }
  }

  // Advances up to `seconds` of journey time (Infinity allowed). Dwells are consumed in
  // order, so a long frame can never skip a stop. Returns whether the walker moved.
  function advance(seconds, skipDwell, onRoom) {
    let remaining = seconds, moved = false;
    while (remaining > 0 && !cursor.done) {
      if (cursor.dwell > 0) {
        const use = Math.min(cursor.dwell, remaining);
        cursor.dwell -= use; remaining -= use;
        if (cursor.dwell > 0) break;
        continue;
      }
      if (cursor.key === last) { cursor.done = true; break; }
      const length = lengths[cursor.key];
      const left = length-cursor.along;
      if (left > 0) {
        const budget = remaining*journey.speed;
        const step = Math.min(left, JOURNEY_STEP, budget);
        if (!(step > 0)) break;
        const arrive = step === left;
        cursor.along = arrive ? length : cursor.along+step;
        remaining = step === budget ? 0 : remaining-step/journey.speed;
        const before = walker.room;
        walkTo(cursor.key, cursor.along);
        moved = true;
        if (walker.room !== before) onRoom?.(walker.room);
        if (!arrive) continue;
      } else if (length === 0) {
        walkTo(cursor.key, 0);
      }
      cursor.key++; cursor.along = 0;
      cursor.dwell = skipDwell ? 0 : keys[cursor.key].stopSeconds;
    }
    if (cursor.key === last && cursor.dwell <= 0) cursor.done = true;
    return moved;
  }

  function target(out) {
    const key = cursor.key;
    const a = keys[key].target;
    if (key === last || cursor.along <= 0 || lengths[key] <= 0) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
      return out;
    }
    const b = keys[key+1].target, f = cursor.along/lengths[key];
    out[0] = a[0]+(b[0]-a[0])*f; out[1] = a[1]+(b[1]-a[1])*f; out[2] = a[2]+(b[2]-a[2])*f;
    return out;
  }

  return { walker, cursor, begin, advance, target };
}

function resolveJourney({ navigation, path, room }) {
  if (!navigation || typeof navigation !== 'object') throw new Error('journey requires a navigation document');
  validateWalkNavigation(navigation);
  const journey = compilePath(path);
  const start = room ?? journey.firstRoom;
  if (typeof start !== 'string' || !start) throw new Error(`${journey.label}: start room must be a room id`);
  if (!journey.rooms.includes(start)) throw new Error(`${journey.label}: start room ${start} is not listed in path.rooms`);
  return { journey, start };
}

// Walks the whole path with the real walker (stops skipped). Throws with a specific
// reason when any segment is blocked, off the walk surface, has bad height/headroom,
// when a room is entered that the path does not declare, or when a declared room is
// never visited. Returns { room, rooms (declared, visit order), length (3D metres),
// duration (seconds, stops included) }.
export function validateJourneyPath({ navigation, path, room } = {}) {
  const { journey, start } = resolveJourney({ navigation, path, room });
  const run = createRun({ navigation, journey, room: start });
  return preflight(run, journey, start);
}

function preflight(run, journey, start) {
  const visited = [start];
  const declared = new Set(journey.rooms);
  run.begin(true);
  const enter = id => {
    if (!visited.includes(id)) visited.push(id);
    if (!declared.has(id)) throw new Error(`${journey.label}: path enters room ${id}, which path.rooms does not declare`);
  };
  run.advance(Infinity, true, enter);
  if (!run.cursor.done) throw new Error(`${journey.label}: path preflight did not reach the final key`);
  const never = journey.rooms.filter(id => !visited.includes(id));
  if (never.length) throw new Error(`${journey.label}: declared rooms never visited by the walk: ${never.join(', ')}`);
  const length = journey.lengths.reduce((a, b) => a+b, 0);
  const stops = journey.keys.reduce((a, k) => a+k.stopSeconds, 0);
  return { room: start, rooms: visited, length, duration: length/journey.speed+stops };
}

export function createGuidedJourney({ navigation, path, room, onPose, onRoom, onState } = {}) {
  for (const [name, fn] of [['onPose', onPose], ['onRoom', onRoom], ['onState', onState]]) {
    if (fn !== undefined && typeof fn !== 'function') throw new Error(`${name} must be a function`);
  }
  const { journey, start } = resolveJourney({ navigation, path, room });
  const run = createRun({ navigation, journey, room: start });
  const summary = preflight(run, journey, start);

  let state = 'idle', error = null, currentRoom = null;
  const target = [0, 0, 0];

  function snapshot() {
    const moving = state !== 'idle';
    return {
      state,
      room: moving ? currentRoom : null,
      keyIndex: moving ? run.cursor.key : 0,
      position: moving ? run.walker.snapshot().position : null,
      target: moving ? run.target([0, 0, 0]) : null,
      error,
    };
  }
  function setState(next, message = null) {
    state = next; error = message;
    onState?.(snapshot());
  }
  function emitPose() {
    onPose?.({ position: run.walker.snapshot().position, target: run.target(target).slice() });
  }
  function setRoom(id) {
    if (id === currentRoom) return;
    currentRoom = id;
    onRoom?.(id);
  }
  function guard(fn) {
    try { return fn(); } catch (e) {
      setState('error', e.message);
      return false;
    }
  }

  function start_() {
    return guard(() => {
      run.begin(false);
      currentRoom = null;
      setRoom(run.walker.room);
      state = 'playing'; error = null;
      emitPose();
      onState?.(snapshot());
      return true;
    });
  }

  return {
    summary,
    start: start_,
    pause() { if (state === 'playing') setState('paused'); },
    resume() { if (state === 'paused') setState('playing'); },
    stop() {
      if (state === 'idle') return;
      currentRoom = null;
      setState('idle');
    },
    update(deltaSeconds) {
      if (!finite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be a finite number >= 0');
      if (state !== 'playing') return false;
      let moved = false;
      const ok = guard(() => {
        moved = run.advance(deltaSeconds, false, setRoom);
        return true;
      });
      if (!ok) return false;
      if (moved) emitPose();
      if (run.cursor.done) {
        setState('completed');
        return moved;
      }
      return true;
    },
    snapshot,
  };
}
