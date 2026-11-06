// Pure mapping from keyboard, on-screen buttons, touch joystick and pointer drags to walk
// motion. Sign convention matches createWalkNavigation: positive strafe is to the right,
// positive turn (yaw) turns to the left, positive forward moves along the view direction.
export const WALK_SPEED = 1.4;          // metres per second
export const WALK_RUN_FACTOR = 2;
export const WALK_TURN_RATE = 1.6;      // radians per second
export const MAX_FRAME_SECONDS = 0.1;   // a long frame never becomes one huge step
export const LOOK_SENSITIVITY = 0.004;  // radians per dragged pixel
export const PITCH_LIMIT = 1.2;
export const BUTTON_STEP = Object.freeze({ distance: 0.4, turn: Math.PI / 12 });
export const JOYSTICK_DEADZONE = 0.15;

const KEY_ACTIONS = new Map([
  ['w', 'forward'], ['ArrowUp', 'forward'], ['s', 'back'], ['ArrowDown', 'back'],
  ['a', 'strafeLeft'], ['d', 'strafeRight'],
  ['ArrowLeft', 'turnLeft'], ['ArrowRight', 'turnRight'], ['q', 'turnLeft'], ['e', 'turnRight'],
]);

export const WALK_BUTTONS = Object.freeze([
  { action: 'forward', label: 'Forward' }, { action: 'back', label: 'Back' },
  { action: 'strafeLeft', label: 'Step left' }, { action: 'strafeRight', label: 'Step right' },
  { action: 'turnLeft', label: 'Turn left' }, { action: 'turnRight', label: 'Turn right' },
]);

const AXES = {
  forward: { forward: 1 }, back: { forward: -1 }, strafeLeft: { strafe: -1 }, strafeRight: { strafe: 1 },
  turnLeft: { turn: 1 }, turnRight: { turn: -1 },
};

export function keyAction(key) {
  if (typeof key !== 'string') return null;
  return KEY_ACTIONS.get(key.length === 1 ? key.toLowerCase() : key) ?? null;
}

/** Held actions -> normalised intent { forward, strafe, turn }, each in [-1, 1]. */
export function intentFromActions(actions) {
  const intent = { forward: 0, strafe: 0, turn: 0 };
  for (const action of actions) {
    const axes = AXES[action];
    if (!axes) throw new Error(`Unknown walk action: ${String(action)}`);
    for (const [axis, value] of Object.entries(axes)) intent[axis] = Math.max(-1, Math.min(1, intent[axis] + value));
  }
  return intent;
}

export function hasIntent(intent) { return intent.forward !== 0 || intent.strafe !== 0 || intent.turn !== 0; }

/**
 * Intent over `deltaSeconds` -> metres to advance, metres to strafe and radians to turn.
 * Diagonal movement is normalised so it is not faster than straight movement.
 */
export function stepFromIntent(intent, deltaSeconds, { run = false } = {}) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be nonnegative.');
  const dt = Math.min(deltaSeconds, MAX_FRAME_SECONDS);
  const length = Math.hypot(intent.forward, intent.strafe);
  const scale = length > 1 ? 1 / length : 1;
  const speed = WALK_SPEED * (run ? WALK_RUN_FACTOR : 1) * dt;
  return { forward: intent.forward * scale * speed, strafe: intent.strafe * scale * speed,
    turn: intent.turn * WALK_TURN_RATE * dt };
}

/** One discrete step for a keyboard-activated on-screen button. */
export function buttonStep(action) {
  const axes = AXES[action];
  if (!axes) throw new Error(`Unknown walk action: ${String(action)}`);
  return { forward: (axes.forward ?? 0) * BUTTON_STEP.distance, strafe: (axes.strafe ?? 0) * BUTTON_STEP.distance,
    turn: (axes.turn ?? 0) * BUTTON_STEP.turn };
}

/** Joystick knob offset (pixels from centre) -> intent. Up is forward. Inside the dead zone is zero. */
export function joystickIntent(dx, dy, radius) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(radius > 0)) throw new RangeError('Joystick needs finite offsets and a positive radius.');
  const length = Math.hypot(dx, dy);
  const magnitude = Math.min(1, length / radius);
  if (magnitude < JOYSTICK_DEADZONE) return { forward: 0, strafe: 0, turn: 0 };
  const scale = (magnitude - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE) / length;
  return { forward: -dy * scale, strafe: dx * scale, turn: 0 };
}

/** Pointer drag (pixels) -> look change. Dragging right looks right (yaw decreases). */
export function lookFromDrag(dx, dy, pitch, yaw) {
  const nextPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - dy * LOOK_SENSITIVITY));
  return { yaw: yaw - dx * LOOK_SENSITIVITY, pitch: nextPitch };
}
