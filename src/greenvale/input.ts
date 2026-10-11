import { ATTACKS, type Attack, type Movement, type Scene, type Skill } from './types.js';

export interface GreenvaleInput {
  /** Latest combined movement request (touch + keyboard). Host reads per frame. */
  movement: Movement;
  /** Reset all transient input state without removing listeners. */
  reset(): void;
  /** Remove every listener and free internal references. Idempotent. */
  dispose(): void;
}

const PREVENTED_KEYS: Record<string, true> = {
  KeyW: true, KeyA: true, KeyS: true, KeyD: true,
  ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true,
  ShiftLeft: true, ShiftRight: true,
  KeyE: true, Digit1: true, Digit2: true, Digit3: true,
  KeyJ: true, KeyK: true, KeyL: true, KeyU: true, KeyI: true, KeyO: true,
};
const SHIFT_CODES: Record<string, true> = { ShiftLeft: true, ShiftRight: true };
const ATTACK_KEYS = Object.fromEntries(
  (Object.entries(ATTACKS) as [Attack, typeof ATTACKS[Attack]][]).map(([id, action]) => [action.code, id]),
) as Partial<Record<string, Attack>>;

type TouchId = 'run' | 'interact' | Skill | Attack;
const TOUCH_IDS: TouchId[] = [
  'run', 'interact', 'heal', 'ice', 'fire',
  ...(Object.keys(ATTACKS) as Attack[]),
];

interface TouchButton { id: TouchId; el: HTMLElement; pressed: boolean; pointer: number | null }
interface TouchDisposer { remove(): void }

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function skillFromDigit(digit: string): Skill | null {
  if (digit === 'Digit1') return 'heal';
  if (digit === 'Digit2') return 'ice';
  if (digit === 'Digit3') return 'fire';
  return null;
}

/** Bind keyboard + pointer-driven touch controls to the Greenvale scene. */
export function bindInput(canvas: HTMLCanvasElement, getScene: () => Scene): GreenvaleInput {
  const movement: Movement = { x: 0, y: 0, run: false };
  // Dynamic key membership changes per frame as keys go down/up.
  const keys = new Set<string>();
  const touchButtons = new Map<TouchId, TouchButton>();
  const listeners: TouchDisposer[] = [];
  let canvasFocused = document.activeElement === canvas;
  let run = false;
  let disposed = false;
  const stick = document.getElementById('gv-joystick');
  const thumb = stick?.querySelector<HTMLElement>('.greenvale-joystick__thumb');
  let stickPointer: number | null = null;
  let stickX = 0;
  let stickY = 0;
  let centreX = 0;
  let centreY = 0;
  let radius = 1;

  function recomputeMovement(): void {
    let dx = stickX;
    let dy = stickY;
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const right = keys.has('KeyD') || keys.has('ArrowRight');
    const up = keys.has('KeyW') || keys.has('ArrowUp');
    const down = keys.has('KeyS') || keys.has('ArrowDown');
    if (left) dx -= 1;
    if (right) dx += 1;
    if (up) dy -= 1;
    if (down) dy += 1;
    movement.x = dx;
    movement.y = dy;
    movement.run = run || !!touchButtons.get('run')?.pressed;
  }

  function releaseCapture(el: HTMLElement, pointer: number | null): void {
    if (pointer !== null && el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
  }

  function clearStick(): void {
    const pointer = stickPointer;
    stickPointer = null;
    stickX = stickY = 0;
    if (thumb) thumb.style.transform = '';
    if (stick) {
      stick.dataset.pressed = 'false';
      releaseCapture(stick, pointer);
    }
    recomputeMovement();
  }

  function releaseAll(): void {
    keys.clear();
    run = false;
    clearStick();
    for (const entry of touchButtons.values()) {
      const pointer = entry.pointer;
      entry.pointer = null;
      entry.pressed = false;
      entry.el.dataset.pressed = 'false';
      releaseCapture(entry.el, pointer);
    }
    recomputeMovement();
  }

  function onCanvasFocus(): void { canvasFocused = true; }
  function onCanvasBlur(): void { canvasFocused = false; releaseAll(); }
  function onWindowBlur(): void { releaseAll(); }
  function onVisibilityChange(): void { if (document.hidden) releaseAll(); }

  function handleKeyDown(event: KeyboardEvent): void {
    if (isEditable(event.target)) return;
    if (!canvasFocused) return;
    const code = event.code;
    if (PREVENTED_KEYS[code] !== true) return;
    event.preventDefault();
    if (getScene().world.state.paused) return;
    if (SHIFT_CODES[code] === true) {
      if (!run) { run = true; recomputeMovement(); }
      return;
    }
    const attack = ATTACK_KEYS[code];
    if (attack) {
      if (!event.repeat) getScene().attack(attack);
      return;
    }
    const skill = skillFromDigit(code);
    if (skill) { getScene().cast(skill); return; }
    if (code === 'KeyE') { getScene().world.interact(); return; }
    if (!keys.has(code)) {
      keys.add(code);
      recomputeMovement();
    }
  }

  function handleKeyUp(event: KeyboardEvent): void {
    const code = event.code;
    if (SHIFT_CODES[code] === true) {
      if (run) { run = false; recomputeMovement(); }
      return;
    }
    if (keys.delete(code)) recomputeMovement();
  }

  function track<K extends keyof HTMLElementEventMap>(target: EventTarget, type: K,
                                                    listener: (event: HTMLElementEventMap[K]) => void,
                                                    options?: AddEventListenerOptions): void;
  function track(target: EventTarget, type: string, listener: EventListener,
                 options?: AddEventListenerOptions): void;
  function track(target: EventTarget, type: string, listener: EventListener,
                 options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, options);
    listeners.push({ remove: () => target.removeEventListener(type, listener, options) });
  }

  function wireJoystick(): void {
    if (!stick) return;
    const move = (event: PointerEvent): void => {
      if (event.pointerId !== stickPointer) return;
      event.preventDefault();
      const x = event.clientX - centreX;
      const y = event.clientY - centreY;
      const distance = Math.hypot(x, y);
      const clamped = Math.min(distance, radius);
      const ratio = distance > 0 ? clamped / distance : 0;
      if (thumb) thumb.style.transform = `translate(${x * ratio}px, ${y * ratio}px)`;
      // A small dead zone prevents drift; the remaining travel controls walking speed.
      const magnitude = Math.max(0, (clamped / radius - 0.16) / 0.84);
      stickX = distance > 0 ? x / distance * magnitude : 0;
      stickY = distance > 0 ? y / distance * magnitude : 0;
      recomputeMovement();
    };
    const down = (event: PointerEvent): void => {
      if (stickPointer !== null || getScene().world.state.paused) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      const box = stick.getBoundingClientRect();
      centreX = box.x + box.width / 2;
      centreY = box.y + box.height / 2;
      radius = Math.max(1, (box.width - (thumb?.offsetWidth ?? 44)) / 2);
      stickPointer = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      stick.dataset.pressed = 'true';
      move(event);
    };
    const up = (event: PointerEvent): void => {
      if (event.pointerId === stickPointer) clearStick();
    };
    track(stick, 'pointerdown', down);
    track(stick, 'pointermove', move);
    track(stick, 'pointerup', up);
    track(stick, 'pointercancel', up);
    track(stick, 'lostpointercapture', up);
    track(stick, 'focus', onCanvasFocus);
    track(stick, 'blur', onCanvasBlur);
  }

  function wireTouchButton(id: TouchId): void {
    const el = document.querySelector<HTMLElement>(`[data-greenvale-touch="${id}"]`);
    if (!el) return;
    // Skip duplicate wiring if the same element already maps to this id —
    // bindUi being re-invoked against the same node should be a no-op.
    for (const [, existing] of touchButtons) {
      if (existing.el === el) return;
    }
    const entry: TouchButton = { id, el, pressed: false, pointer: null };
    touchButtons.set(id, entry);
    const press = (event: PointerEvent): void => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      entry.pointer = event.pointerId;
      if (!entry.pressed) { entry.pressed = true; recomputeMovement(); }
      entry.el.dataset.pressed = 'true';
    };
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== entry.pointer) return;
      const pointer = entry.pointer;
      entry.pointer = null;
      releaseCapture(el, pointer);
      if (entry.pressed) { entry.pressed = false; recomputeMovement(); }
      entry.el.dataset.pressed = 'false';
    };
    const onDown = (event: PointerEvent): void => {
      if (entry.pointer !== null || getScene().world.state.paused) return;
      // Reject non-primary mouse buttons — pointerdown event.button !== 0 on
      // right-click is normal; touch always reports 0.
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      const alreadyPressed = entry.pressed;
      press(event);
      if (alreadyPressed) return;
      if (id === 'heal' || id === 'ice' || id === 'fire') getScene().cast(id);
      else if (id in ATTACKS) getScene().attack(id as Attack);
      else if (id === 'interact') getScene().world.interact();
    };
    const onUp = (event: PointerEvent): void => release(event);
    const onCancel = (event: PointerEvent): void => release(event);
    // Suppress the synthetic click after a pointer-driven press; the action
    // already started in pointerdown, so a click would double-fire.
    const onClick = (event: MouseEvent): void => event.preventDefault();
    track(el, 'pointerdown', onDown);
    track(el, 'pointerup', onUp);
    track(el, 'pointercancel', onCancel);
    track(el, 'lostpointercapture', onCancel);
    track(el, 'click', onClick);
    // Skills (heal/ice/fire) fire once per press via a mouse-keyboard click
    // path: the synthetic click only triggers when event.detail === 0
    // (keyboard/Enter activation), so pointer-driven taps don't double-cast.
    // Pointer-driven taps already cast in pointerdown, so we deliberately
    // skip the synthetic click for taps.
    if (id === 'heal' || id === 'ice' || id === 'fire') {
      const onKeyActivate = (event: MouseEvent): void => {
        if (event.detail === 0) getScene().cast(id);
      };
      track(el, 'click', onKeyActivate);
    } else if (id in ATTACKS) {
      const onKeyActivate = (event: MouseEvent): void => {
        if (event.detail === 0) getScene().attack(id as Attack);
      };
      track(el, 'click', onKeyActivate);
    } else if (id === 'interact') {
      const onKeyActivate = (event: MouseEvent): void => {
        if (event.detail === 0) getScene().world.interact();
      };
      track(el, 'click', onKeyActivate);
    }
  }

  function reset(): void { releaseAll(); }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    releaseAll();
    for (let i = listeners.length - 1; i >= 0; i--) listeners[i]!.remove();
    listeners.length = 0;
    touchButtons.clear();
  }

  canvas.tabIndex = 0;
  track(canvas, 'focus', onCanvasFocus);
  track(canvas, 'blur', onCanvasBlur);
  track(window, 'blur', onWindowBlur);
  track(document, 'visibilitychange', onVisibilityChange);
  track(window, 'resize', releaseAll);
  track(window, 'keydown', handleKeyDown);
  track(window, 'keyup', handleKeyUp);
  wireJoystick();
  for (const id of TOUCH_IDS) wireTouchButton(id);
  return { movement, reset, dispose };
}
