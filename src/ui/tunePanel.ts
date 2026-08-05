/**
 * Shared live-tuning panel.
 *
 * Any demo whose runtime exposes a flat record of numeric parameters plus a get/set pair can raise
 * a tuning panel from here. Nothing in this module is demo-specific: the title, the note, the
 * accent colour and every slider's range arrive as options, so the second demo that needs a panel
 * contributes a config object rather than a second copy of this file.
 *
 * Two things this owns that a per-demo panel kept getting wrong:
 *
 *   - ONE stylesheet for every panel, injected once and keyed by `STYLE_ID`. The per-demo version
 *     appended a fresh `<style>` on every mount and only removed the panel element, so a host that
 *     rebuilds its demo on a timer (the home turntable rebuilds every 5.2s) piled up orphan
 *     `<style>` nodes for the lifetime of the page.
 *   - A registry of live panels, so remounting an id tears the previous panel down through its own
 *     disposer — listeners included — instead of orphaning it with `element.remove()`.
 */

/** A single numeric slider + number-input pair. */
export interface TuneControl<K extends string> {
  key: K;
  label: string;
  /** Short unit or range reminder, shown dimmed to the right of the label. */
  hint?: string;
  min: number;
  max: number;
  step: number;
}

/** How the panel reads, writes and resets the values it edits. */
export interface TuneAdapter<T> {
  get: () => T;
  set: (next: Partial<T>) => void;
  /** Restored by the panel's Reset action. */
  defaults: T;
}

export type TuneCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/**
 * The string keys of `T` whose values are numbers. Filtering the keys rather than constraining `T`
 * to `Record<string, number>` is what lets a plain documented interface — no index signature, so
 * misspelling a parameter is still a compile error — be tuned by this panel.
 */
export type NumericKeys<T> = Extract<
  { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T],
  string
>;

export interface TunePanelOptions<T extends object> {
  /**
   * Unique per panel and used as the DOM id. Mounting the same id again disposes the panel that
   * currently holds it, so a rebuild cannot leave two panels driving one runtime.
   */
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  /** Themes the headline, the slider track and the primary button. */
  accent?: string;
  corner?: TuneCorner;
  controls: ReadonlyArray<TuneControl<NumericKeys<T>>>;
  adapter: TuneAdapter<T>;
}

const STYLE_ID = 'tune-panel-shared-style';
const DEFAULT_ACCENT = '#ffd51a';

/** id -> disposer for every panel currently in the document. */
const openPanels = new Map<string, () => void>();

const CSS = `
[data-tune-panel] {
  position: fixed; z-index: 50; width: 292px; padding: 14px; border-radius: 14px;
  color: #f4f1f2; background: rgba(28, 22, 26, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: 0 16px 42px rgba(10, 6, 10, 0.38);
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
}
[data-tune-panel] * { box-sizing: border-box; }
[data-tune-panel][data-corner="top-right"] { top: 16px; right: 16px; }
[data-tune-panel][data-corner="top-left"] { top: 16px; left: 16px; }
[data-tune-panel][data-corner="bottom-right"] { bottom: 16px; right: 16px; }
[data-tune-panel][data-corner="bottom-left"] { bottom: 16px; left: 16px; }
[data-tune-panel] .tp-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
[data-tune-panel] .tp-title { display: block; color: var(--tp-accent); font: 700 12px/1.3 ui-sans-serif, system-ui, sans-serif; }
[data-tune-panel] .tp-subtitle { display: block; margin-top: 3px; color: #b8aeb2; font-size: 10px; }
[data-tune-panel] .tp-close { border: 0; background: transparent; color: #f4f1f2; font-size: 20px; line-height: 16px; cursor: pointer; padding: 0 2px; }
[data-tune-panel] .tp-note { margin: 11px 0 10px; padding: 8px; border-radius: 8px; color: #cfc6ca; background: rgba(0, 0, 0, .20); font-size: 10px; }
[data-tune-panel] .tp-row { margin: 10px 0; }
[data-tune-panel] .tp-label { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; color: #efe8ea; font-size: 10px; }
[data-tune-panel] .tp-label em { color: #a09699; font-style: normal; }
[data-tune-panel] .tp-line { display: grid; grid-template-columns: 1fr 68px; gap: 8px; align-items: center; }
[data-tune-panel] input[type=range] { width: 100%; accent-color: var(--tp-accent); }
[data-tune-panel] input[type=number] { width: 100%; padding: 5px 6px; border: 1px solid rgba(255, 255, 255, .18); border-radius: 6px; background: #141014; color: #fff; font: 11px ui-monospace, monospace; }
[data-tune-panel] .tp-actions { display: flex; gap: 7px; margin-top: 13px; }
[data-tune-panel] .tp-actions button { flex: 1; padding: 7px 8px; border: 1px solid rgba(255, 255, 255, .22); border-radius: 7px; color: #fff; background: #372c33; cursor: pointer; font: 10px ui-sans-serif, system-ui, sans-serif; }
[data-tune-panel] .tp-copy { color: #1d151b; background: var(--tp-accent); border-color: var(--tp-accent); font-weight: 700; }
[data-tune-panel] .tp-output { display: none; width: 100%; min-height: 82px; margin-top: 9px; padding: 7px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 7px; resize: vertical; color: #d6cdd0; background: #141014; font: 9px/1.35 ui-monospace, monospace; }
`;

/** Injected once per document, never removed — one stylesheet serves every panel. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Decimals follow the step, so a 0.005 step does not render as 0.06000000000000001. */
function formatValue(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  return value.toFixed(step < 0.01 ? 3 : 2);
}

/**
 * Mounts a tuning panel and returns its disposer. Calling the disposer, pressing the panel's close
 * button, or remounting the same `id` all tear this instance down exactly once.
 */
export function mountTunePanel<T extends object>(
  options: TunePanelOptions<T>,
): () => void {
  const { id, title, subtitle, note, controls, adapter } = options;
  const accent = options.accent ?? DEFAULT_ACCENT;

  // An id already on screen belongs to a live panel: dispose it through its own closure so its
  // listeners go with it, rather than detaching the element and leaving them attached.
  openPanels.get(id)?.();

  ensureStyle();

  const panel = document.createElement('aside');
  panel.id = id;
  panel.dataset.tunePanel = '';
  panel.dataset.corner = options.corner ?? 'top-right';
  panel.style.setProperty('--tp-accent', accent);

  const header = document.createElement('header');
  header.className = 'tp-header';
  const heading = document.createElement('div');
  const titleEl = document.createElement('strong');
  titleEl.className = 'tp-title';
  titleEl.textContent = title;
  heading.appendChild(titleEl);
  if (subtitle) {
    const subtitleEl = document.createElement('small');
    subtitleEl.className = 'tp-subtitle';
    subtitleEl.textContent = subtitle;
    heading.appendChild(subtitleEl);
  }
  const closeButton = document.createElement('button');
  closeButton.className = 'tp-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', `Hide ${title} panel`);
  closeButton.textContent = '×';
  header.append(heading, closeButton);
  panel.appendChild(header);

  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'tp-note';
    noteEl.textContent = note;
    panel.appendChild(noteEl);
  }

  type Key = NumericKeys<T>;
  const rangeInputs = new Map<Key, HTMLInputElement>();
  const numberInputs = new Map<Key, HTMLInputElement>();

  // `NumericKeys<T>` guarantees these properties are numbers, but that is a fact about the key
  // filter that the compiler cannot carry through a generic index. One narrowing here beats a cast
  // at every read site.
  const values = (): Record<Key, number> => adapter.get() as unknown as Record<Key, number>;

  const syncControl = (key: Key, value: number, step: number): void => {
    const range = rangeInputs.get(key);
    const number = numberInputs.get(key);
    if (range) range.value = String(value);
    if (number) number.value = formatValue(value, step);
  };

  for (const control of controls) {
    const row = document.createElement('div');
    row.className = 'tp-row';

    const label = document.createElement('div');
    label.className = 'tp-label';
    const labelText = document.createElement('span');
    labelText.textContent = control.label;
    label.appendChild(labelText);
    if (control.hint) {
      const hint = document.createElement('em');
      hint.textContent = control.hint;
      label.appendChild(hint);
    }
    row.appendChild(label);

    const line = document.createElement('div');
    line.className = 'tp-line';
    const range = document.createElement('input');
    const number = document.createElement('input');
    for (const input of [range, number]) {
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
    }
    range.type = 'range';
    range.id = `${id}-${control.key}-range`;
    range.name = `${control.key}-range`;
    range.setAttribute('aria-label', `${control.label} slider`);
    number.type = 'number';
    number.id = `${id}-${control.key}-number`;
    number.name = `${control.key}-number`;
    number.setAttribute('aria-label', `${control.label} value`);
    line.append(range, number);
    row.appendChild(line);

    panel.appendChild(row);
    rangeInputs.set(control.key, range);
    numberInputs.set(control.key, number);
    syncControl(control.key, values()[control.key], control.step);

    const apply = (raw: string): void => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      const clamped = Math.min(control.max, Math.max(control.min, parsed));
      adapter.set({ [control.key]: clamped } as Partial<T>);
      syncControl(control.key, clamped, control.step);
    };
    range.addEventListener('input', () => apply(range.value));
    number.addEventListener('change', () => apply(number.value));
  }

  const actions = document.createElement('div');
  actions.className = 'tp-actions';
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'tp-copy';
  copyButton.textContent = 'Copy parameters';
  actions.append(resetButton, copyButton);
  panel.appendChild(actions);

  const output = document.createElement('textarea');
  output.className = 'tp-output';
  output.id = `${id}-output`;
  output.name = `${id}-output`;
  output.readOnly = true;
  output.spellcheck = false;
  output.setAttribute('aria-label', `Copied ${title} parameters`);
  panel.appendChild(output);

  const syncAll = (): void => {
    const current = values();
    for (const control of controls) syncControl(control.key, current[control.key], control.step);
  };

  resetButton.addEventListener('click', () => {
    adapter.set({ ...adapter.defaults });
    syncAll();
  });

  copyButton.addEventListener('click', () => {
    const json = JSON.stringify(adapter.get(), null, 2);
    output.value = json;
    output.style.display = 'block';
    // The textarea is the fallback path as well as the receipt: a denied or unavailable clipboard
    // still leaves the values selectable rather than silently dropping the copy.
    void navigator.clipboard?.writeText(json).catch(() => output.select());
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    panel.remove();
    if (openPanels.get(id) === dispose) openPanels.delete(id);
  };
  closeButton.addEventListener('click', dispose);

  document.body.appendChild(panel);
  openPanels.set(id, dispose);
  return dispose;
}

/** Disposes every live panel — for a host that tears its whole scene down. */
export function unmountAllTunePanels(): void {
  for (const dispose of [...openPanels.values()]) dispose();
}

/** Whether a panel with this id is currently mounted. */
export function isTunePanelOpen(id: string): boolean {
  return openPanels.has(id);
}
