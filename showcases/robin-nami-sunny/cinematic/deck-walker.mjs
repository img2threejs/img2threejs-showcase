// A character walking the shared deck route.
//
// The route itself is a pure function of absolute seconds (deck-patrol.mjs). A walker owns
// one character's progress along it and refuses any step that would bring it closer than
// `separation` metres to another character it is approaching, so two characters (or a
// character and a paused/staged one) can never overlap even when they are on the same loop.

// Stance-foot speed of the shared Walking clip, measured on the corrected rig
// (evidence/nami-native-construction.json, gait.Walking). Robin and Nami use the same skeleton
// and the same clip, so one constant drives both walking cycles from travelled distance.
export const WALKING_SPEED = 1.2018773261019358;
// Stance-foot speed of the Running clip (evidence/nami-native-construction.json, gait.Running,
// ankle slope 1.895 m/s): played at its natural rate, so the deck run is travelled at that speed.
export const RUNNING_SPEED = 1.895;
// The patrol route is timed at this speed; a gait travels faster or slower by scaling route time.
export const ROUTE_SPEED = 0.7;
// `travel` is how fast the character moves along the deck; `stance` is the speed her clip's planted
// foot moves, so playing the clip at travel/stance keeps the feet from skating.
export const GAITS = Object.freeze({
  Walking: Object.freeze({ clip: 'Walking', travel: ROUTE_SPEED, stance: WALKING_SPEED }),
  Running: Object.freeze({ clip: 'Running', travel: RUNNING_SPEED, stance: RUNNING_SPEED }),
});
export const gaitRate = gait => GAITS[gait].travel / ROUTE_SPEED;
export const gaitPhase = (gait, distance) => distance / GAITS[gait].stance;

export function createDeckWalker({ patrol, startSeconds = 0, others = () => [], separation = 1.8 }) {
  const position = { x: 0, y: 0, z: 0, yaw: 0, distance: 0 }, next = { x: 0, y: 0, z: 0, yaw: 0, distance: 0 };
  let seconds = startSeconds, blocked = false;
  patrol.sample(seconds, position);
  return {
    position,
    get seconds() { return seconds; },
    get blocked() { return blocked; },
    /** Absolute placement (seek/reset). Never consults other characters. */
    set(value) { seconds = value; blocked = false; patrol.sample(seconds, position); return position; },
    reset() { return this.set(startSeconds); },
    /** Advances `dt` seconds (scaled by `rate`) along the route unless that would crowd another character. */
    advance(dt, rate = 1) {
      const step = dt * rate;
      patrol.sample(seconds + step, next);
      for (const other of others()) {
        const after = Math.hypot(next.x - other.x, next.z - other.z);
        if (after < separation && after < Math.hypot(position.x - other.x, position.z - other.z)) { blocked = true; return false; }
      }
      seconds += step; blocked = false;
      Object.assign(position, next);
      return true;
    },
  };
}
