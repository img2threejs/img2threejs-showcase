// Room colour panel. Builds the whole UI from the palette engine API (see createPalette in
// interior-palette.js) and nothing else: it never touches the scene, materials or storage.

const CATEGORY_ORDER = ['surfaces', 'wood', 'bed', 'textiles', 'window', 'metal', 'lighting'];
const CATEGORY_LABEL = {
  surfaces: 'Surfaces', wood: 'Wood', bed: 'Bed', textiles: 'Textiles', window: 'Window', metal: 'Metal', lighting: 'Lighting',
};
const MOBILE_QUERY = '(max-width: 600px)';
const HEX_FULL = /^#[0-9a-f]{6}$/;
const MAX_IMPORT_BYTES = 256 * 1024;

let sequence = 0;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter(child => child !== undefined && child !== null));
  return node;
}

function normalizeHex(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

const lower = hex => String(hex ?? '').toLowerCase();

// Blackbody approximation (Tanner Helland) used only to draw the kelvin track and the lighting chip.
function kelvinToHex(kelvin) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const red = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const channel = value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function kelvinGradient(min, max) {
  const stops = 7;
  const parts = [];
  for (let index = 0; index < stops; index += 1) {
    const k = min + ((max - min) * index) / (stops - 1);
    parts.push(`${kelvinToHex(k)} ${Math.round((index / (stops - 1)) * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

function kelvinWord(kelvin) {
  if (kelvin < 2500) return 'Candle-warm';
  if (kelvin < 3000) return 'Warm white';
  if (kelvin < 3600) return 'Soft white';
  if (kelvin < 4100) return 'Neutral white';
  return 'Cool white';
}

function finishFraction(group, roughness) {
  const { min, max } = group.finish;
  return Math.min(1, Math.max(0, (max - roughness) / (max - min || 1)));
}

function finishWord(fraction) {
  return fraction < 0.12 ? 'Matte' : fraction > 0.88 ? 'Satin' : 'Semi-satin';
}

function presetDots(preset, groups) {
  const ordered = [];
  for (const group of groups) {
    const hex = preset.colors?.[group.id];
    if (hex && !ordered.some(item => lower(item) === lower(hex))) ordered.push(hex);
  }
  if (ordered.length <= 5) return ordered;
  return Array.from({ length: 5 }, (_, index) => ordered[Math.round((index * (ordered.length - 1)) / 4)]);
}

export function mountPaletteUI({ root, palette }) {
  if (!root) throw new Error('mountPaletteUI needs a root element.');
  if (!palette) throw new Error('mountPaletteUI needs a palette.');
  const id = `pal${++sequence}`;
  const groups = palette.groups;
  const presets = palette.presets;
  const mobile = window.matchMedia(MOBILE_QUERY);
  const cleanup = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  };

  let current = palette.state();
  let externalDisabled = false;
  let comparing = false;
  let holding = false;
  let override = null;
  let announceTimer = 0;
  let flip = false;

  // ---- live status -------------------------------------------------------------------------
  const status = el('p', { class: 'palette-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  function announceNow(text) {
    clearTimeout(announceTimer);
    flip = !flip;
    status.textContent = text + (flip ? '\u00a0' : '');
  }
  function announceSoon(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => announceNow(text), 350);
  }
  function act(label, run) {
    override = label;
    try { run(); } finally {
      if (override) { const text = override; override = null; announceNow(text); }
    }
  }

  // ---- header ------------------------------------------------------------------------------
  const bodyId = `${id}-body`;
  const title = el('h3', { id: 'palette-title', text: 'Room colours' });
  const summaryText = el('span', { class: 'palette-summary' });
  const toggle = el('button', { type: 'button', class: 'palette-toggle', 'aria-expanded': 'false', 'aria-controls': bodyId },
    el('span', { text: 'Customise colours' }), el('span', { class: 'palette-caret', 'aria-hidden': 'true' }));
  const head = el('div', { class: 'palette-head' }, el('div', { class: 'palette-title-block' }, title, summaryText), toggle);
  root.dataset.collapsed = 'true';
  listen(toggle, 'click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    root.dataset.collapsed = String(!open);
  });

  // ---- presets -----------------------------------------------------------------------------
  const presetButtons = new Map();
  const presetRow = el('div', { class: 'palette-presets', role: 'group', 'aria-label': 'Colour presets' });
  for (const preset of presets) {
    const descId = `${id}-preset-${preset.id}`;
    const button = el('button', { type: 'button', class: 'palette-preset', 'aria-pressed': 'false', 'aria-labelledby': `${descId}-name`, 'aria-describedby': descId, title: preset.description || undefined },
      el('span', { class: 'palette-preset-dots', 'aria-hidden': 'true' },
        presetDots(preset, groups).map(hex => el('span', { class: 'palette-dot', style: `--swatch-color:${hex}` }))),
      el('span', { class: 'palette-preset-name', id: `${descId}-name`, text: preset.label }),
      el('span', { class: 'palette-preset-desc', id: descId, text: preset.description ?? '' }));
    listen(button, 'click', () => act(`Preset ${preset.label} applied`, () => palette.applyPreset(preset.id)));
    presetButtons.set(preset.id, button);
    presetRow.append(button);
  }

  // ---- toolbar -----------------------------------------------------------------------------
  const tool = (label, handler, extra = {}) => {
    const button = el('button', { type: 'button', class: 'palette-tool', text: label, ...extra });
    if (handler) listen(button, 'click', event => {
      if (button.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      handler(event);
    });
    return button;
  };
  const undoButton = tool('Undo', () => act('Undone', () => palette.undo()), { 'aria-keyshortcuts': 'Control+Z Meta+Z' });
  const redoButton = tool('Redo', () => act('Redone', () => palette.redo()), { 'aria-keyshortcuts': 'Control+Shift+Z Meta+Shift+Z' });
  const randomButton = tool('Randomise', () => act('Random palette applied', () => palette.randomize()));
  const compareButton = tool('Compare original', null, { 'aria-pressed': 'false', 'aria-describedby': `${id}-compare-hint` });
  const shareButton = tool('Copy share link', () => copyLink());
  const exportButton = tool('Export JSON', () => exportFile());
  const importButton = tool('Import JSON', () => fileInput.click());
  const resetAllButton = tool('Reset all colours', () => act('All colours reset to the original palette', () => palette.reset()));
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'palette-sr', tabindex: '-1', 'aria-label': 'Palette JSON file' });
  const compareHint = el('p', { id: `${id}-compare-hint`, class: 'palette-hint',
    text: 'Compare: hold the button, or press Space or Enter to switch it on and off. Share, export and import keep every colour, finish and light setting.' });
  const compareBadge = el('p', { class: 'palette-compare-badge', hidden: true, text: 'Showing the original colours. Release or press Compare again to return to yours.' });
  const message = el('p', { class: 'palette-message', hidden: true, id: `${id}-message` });
  const shareField = el('input', { type: 'text', readonly: true, class: 'palette-share-input', id: `${id}-share`, 'aria-label': 'Share link' });
  const shareBox = el('div', { class: 'palette-share', hidden: true },
    el('label', { for: `${id}-share`, text: 'Copy this link manually:' }), shareField);
  const toolbar = el('div', { class: 'palette-toolbar', role: 'toolbar', 'aria-label': 'Palette actions' },
    undoButton, redoButton, randomButton, compareButton, shareButton, exportButton, importButton, resetAllButton);

  function showMessage(text, kind = 'info') {
    message.hidden = !text;
    message.textContent = text ?? '';
    message.dataset.kind = kind;
    message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  // compare: press-and-hold (pointer) + toggle (keyboard / assistive tech click without a pointer)
  function renderCompare() {
    compareButton.setAttribute('aria-pressed', String(comparing));
    compareBadge.hidden = !comparing;
  }
  function setCompare(on) {
    if (comparing === on) return;
    comparing = on;
    palette.compare(on);
    renderCompare();
    announceNow(on ? 'Showing the original colours' : 'Showing your colours');
  }
  function releaseHold() {
    if (!holding) return;
    holding = false;
    setCompare(false);
  }
  listen(compareButton, 'pointerdown', event => {
    if (event.button !== 0) return;
    holding = true;
    try { compareButton.setPointerCapture(event.pointerId); } catch { /* synthetic pointers */ }
    setCompare(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(compareButton, type, releaseHold);
  listen(compareButton, 'contextmenu', event => event.preventDefault());
  listen(compareButton, 'click', event => { if (event.detail === 0) setCompare(!comparing); });
  listen(window, 'blur', () => { holding = false; setCompare(false); });
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && comparing) { holding = false; setCompare(false); return; }
    const typing = event.target instanceof HTMLInputElement && event.target.type === 'text';
    if (!(event.ctrlKey || event.metaKey) || event.altKey || typing) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey && palette.canUndo()) { event.preventDefault(); undoButton.click(); }
    else if ((key === 'z' && event.shiftKey || key === 'y') && palette.canRedo()) { event.preventDefault(); redoButton.click(); }
  });

  async function copyLink() {
    const url = palette.shareURL();
    shareBox.hidden = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      showMessage('Share link copied to the clipboard.');
      announceNow('Share link copied');
    } catch {
      shareField.value = url;
      shareBox.hidden = false;
      showMessage('The browser blocked clipboard access. The link is selected below: copy it manually.');
      announceNow('Clipboard blocked. The share link is selected in the text field below.');
      shareField.focus();
      shareField.select();
    }
  }
  function exportFile() {
    const blob = new Blob([palette.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: 'bedroom-palette.json' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showMessage('Palette exported as bedroom-palette.json.');
    announceNow('Palette exported');
  }
  listen(fileInput, 'change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('The file is larger than 256 KB, so it is not a palette export.');
      const text = await file.text();
      override = 'Palette imported';
      palette.importJSON(text);
      showMessage(`Imported ${file.name}.`);
    } catch (error) {
      override = null;
      const reason = error instanceof Error ? error.message : String(error);
      showMessage(`Could not import ${file.name}: ${reason}`, 'error');
      announceNow(`Import failed. ${reason}`);
      return;
    }
    if (override) { announceNow(override); override = null; }
  });

  // ---- groups ------------------------------------------------------------------------------
  const controls = new Map();
  const groupsRoot = el('div', { class: 'palette-groups' });
  const categories = [...new Set(groups.map(group => group.category))]
    .sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));

  function buildGroup(group) {
    const gid = `${id}-${group.id}`;
    const isLight = group.kind === 'light';
    const chip = el('span', { class: 'palette-chip', 'aria-hidden': 'true' });
    const hexLabel = el('span', { class: 'palette-summary-hex', 'aria-hidden': 'true' });
    const modifiedSr = el('span', { class: 'palette-sr' });
    const summary = el('summary', {}, chip, el('span', { class: 'palette-group-name', text: group.label }),
      el('span', { class: 'palette-mod', 'aria-hidden': 'true', title: 'Changed from the original' }), hexLabel, modifiedSr,
      el('span', { class: 'palette-caret', 'aria-hidden': 'true' }));
    const record = { group, chip, hexLabel, modifiedSr, swatches: [] };
    const body = el('div', { class: 'palette-group-body' });

    const resetButton = el('button', { type: 'button', class: 'palette-group-reset', text: 'Reset', 'aria-label': `Reset ${group.label}` });
    listen(resetButton, 'click', event => {
      if (resetButton.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      act(`${group.label} reset to original`, () => palette.reset(group.id));
    });
    record.resetButton = resetButton;

    if (!isLight) {
      const colorInput = el('input', { type: 'color', class: 'palette-color', id: `${gid}-color`, 'aria-label': `${group.label} colour picker` });
      const hexInput = el('input', { type: 'text', class: 'palette-hex', id: `${gid}-hex`, maxlength: '7', inputmode: 'text',
        autocomplete: 'off', spellcheck: 'false', placeholder: '#c8b7a1', 'aria-describedby': `${gid}-hex-error` });
      const hexError = el('span', { class: 'palette-hex-error', id: `${gid}-hex-error`, hidden: true, text: 'Use a hex colour such as #c8b7a1.' });
      record.colorInput = colorInput;
      record.hexInput = hexInput;
      record.hexError = hexError;
      record.dirty = false;
      listen(colorInput, 'input', () => {
        const hex = normalizeHex(colorInput.value);
        if (hex) palette.setColor(group.id, hex);
      });
      const setInvalid = invalid => {
        hexInput.setAttribute('aria-invalid', String(invalid));
        hexError.hidden = !invalid;
      };
      listen(hexInput, 'input', () => {
        record.dirty = true;
        const hex = normalizeHex(hexInput.value);
        if (hex && hexInput.value.trim().replace(/^#/, '').length === 6) {
          setInvalid(false);
          palette.setColor(group.id, hex);
        } else if (hexInput.getAttribute('aria-invalid') === 'true') setInvalid(!hex);
      });
      const commit = () => {
        const hex = normalizeHex(hexInput.value);
        if (!hex) { setInvalid(true); announceNow(`${group.label}: ${hexInput.value || 'empty value'} is not a valid hex colour. Use a value such as #c8b7a1.`); return false; }
        setInvalid(false);
        record.dirty = false;
        if (lower(current.colors[group.id]) !== hex) palette.setColor(group.id, hex);
        hexInput.value = hex;
        return true;
      };
      listen(hexInput, 'change', commit);
      listen(hexInput, 'keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (event.key === 'Escape' && record.dirty) {
          event.preventDefault(); event.stopPropagation();
          record.dirty = false; setInvalid(false); hexInput.value = lower(current.colors[group.id]);
        }
      });
      body.append(
        el('div', { class: 'palette-picker-row' },
          el('label', { class: 'palette-color-wrap', for: `${gid}-color` }, el('span', { class: 'palette-field-label', text: 'Colour' }), colorInput),
          el('div', { class: 'palette-hex-wrap' }, el('label', { class: 'palette-field-label', for: `${gid}-hex`, text: 'Hex' }), hexInput),
          resetButton),
        hexError);
      const swatchRow = el('div', { class: 'palette-swatches', role: 'group', 'aria-label': `${group.label} swatches` });
      for (const swatch of group.swatches ?? []) {
        const hex = lower(swatch.hex);
        const button = el('button', { type: 'button', class: 'palette-swatch', 'aria-pressed': 'false',
          'aria-label': `${swatch.label}, ${hex}`, title: `${swatch.label} ${hex}` },
          el('span', { class: 'palette-swatch-dot', style: `--swatch-color:${hex}` }));
        listen(button, 'click', () => act(`${group.label} set to ${swatch.label}`, () => palette.setColor(group.id, hex)));
        record.swatches.push({ button, hex });
        swatchRow.append(button);
      }
      body.append(swatchRow);
    } else {
      body.append(el('div', { class: 'palette-picker-row palette-picker-row-light' },
        el('span', { class: 'palette-field-note', text: 'Sets the colour temperature of the pendant lights and their bulbs.' }), resetButton));
      const lightRow = el('div', { class: 'palette-swatches', role: 'group', 'aria-label': `${group.label} presets` });
      for (const swatch of (group.swatches ?? []).filter(item => Number.isFinite(item.kelvin))) {
        const button = el('button', { type: 'button', class: 'palette-swatch', 'aria-pressed': 'false',
          'aria-label': `${swatch.label}, ${swatch.kelvin} K`, title: `${swatch.label} ${swatch.kelvin} K` },
          el('span', { class: 'palette-swatch-dot', style: `--swatch-color:${lower(swatch.hex)}` }));
        listen(button, 'click', () => act(`${group.label} set to ${swatch.label}, ${swatch.kelvin} K`, () => palette.setKelvin(swatch.kelvin)));
        record.swatches.push({ button, kelvin: swatch.kelvin });
        lightRow.append(button);
      }
      if (lightRow.childElementCount) body.append(lightRow);
    }

    if (group.finish) {
      const { min, max } = group.finish;
      const output = el('output', { class: 'palette-output', for: `${gid}-finish` });
      const input = el('input', { type: 'range', class: 'palette-slider', id: `${gid}-finish`, min, max, step: '0.01',
        'aria-describedby': `${gid}-finish-hint` });
      listen(input, 'input', () => palette.setFinish(group.id, min + max - Number(input.value)));
      record.finishInput = input;
      record.finishOutput = output;
      body.append(el('div', { class: 'palette-slider-row' },
        el('div', { class: 'palette-slider-label' }, el('label', { for: `${gid}-finish`, text: 'Finish' }), output),
        input,
        el('div', { class: 'palette-slider-ends', id: `${gid}-finish-hint`, 'aria-hidden': 'true' }, el('span', { text: 'Matte' }), el('span', { text: 'Satin' }))));
    }
    if (isLight && group.kelvin) {
      const { min, max } = group.kelvin;
      const output = el('output', { class: 'palette-output', for: `${gid}-kelvin` });
      const input = el('input', { type: 'range', class: 'palette-slider palette-kelvin', id: `${gid}-kelvin`, min, max, step: '50' });
      input.style.setProperty('--kelvin-gradient', kelvinGradient(min, max));
      listen(input, 'input', () => palette.setKelvin(Number(input.value)));
      record.kelvinInput = input;
      record.kelvinOutput = output;
      body.append(el('div', { class: 'palette-slider-row' },
        el('div', { class: 'palette-slider-label' }, el('label', { for: `${gid}-kelvin`, text: 'Light colour temperature' }), output),
        input,
        el('div', { class: 'palette-slider-ends', 'aria-hidden': 'true' }, el('span', { text: `${min} K warm` }), el('span', { text: `${max} K cool` }))));
    }

    const details = el('details', { class: 'palette-group', 'data-kind': group.kind }, summary, body);
    listen(details, 'toggle', () => {
      if (!details.open || !mobile.matches) return;
      for (const other of groupsRoot.querySelectorAll('details[open]')) if (other !== details) other.open = false;
    });
    record.details = details;
    controls.set(group.id, record);
    return details;
  }

  for (const category of categories) {
    const members = groups.filter(group => group.category === category);
    const headingId = `${id}-cat-${category}`;
    groupsRoot.append(el('section', { class: 'palette-category', 'aria-labelledby': headingId },
      el('h4', { id: headingId, text: CATEGORY_LABEL[category] ?? category[0].toUpperCase() + category.slice(1) }),
      el('div', { class: 'palette-group-list' }, members.map(buildGroup))));
  }

  const bodyFieldset = el('fieldset', { class: 'palette-body', id: bodyId },
    el('legend', { class: 'palette-sr', text: 'Room colour controls' }),
    el('div', { class: 'palette-section' }, el('h4', { class: 'palette-subtitle', id: `${id}-presets-title`, text: 'Presets' }), presetRow),
    el('div', { class: 'palette-section' }, toolbar, compareHint, compareBadge, message, shareBox, fileInput),
    el('div', { class: 'palette-section' }, groupsRoot));

  root.replaceChildren(head, bodyFieldset, status);

  // ---- sync --------------------------------------------------------------------------------
  function groupModified(group, state) {
    if (group.kind === 'light') return Math.round(state.kelvin) !== Math.round(group.kelvin?.default ?? state.kelvin);
    if (lower(state.colors[group.id]) !== lower(group.default)) return true;
    return group.finish && state.finishes[group.id] !== undefined
      && Math.abs(state.finishes[group.id] - group.finish.default) > 0.004;
  }

  function syncGroup(record, state) {
    const { group } = record;
    const modified = groupModified(group, state);
    record.resetButton.setAttribute('aria-disabled', String(!modified));
    record.modifiedSr.textContent = modified ? ' (changed)' : '';
    record.details.dataset.modified = String(modified);
    if (group.kind === 'light') {
      const kelvin = Math.round(state.kelvin);
      record.chip.style.setProperty('--swatch-color', kelvinToHex(kelvin));
      record.hexLabel.textContent = `${kelvin} K`;
      for (const { button, kelvin: swatchKelvin } of record.swatches) button.setAttribute('aria-pressed', String(Math.abs(swatchKelvin - kelvin) < 25));
      if (record.kelvinInput) {
        record.kelvinInput.value = String(kelvin);
        record.kelvinOutput.textContent = `${kelvin} K · ${kelvinWord(kelvin)}`;
        record.kelvinInput.setAttribute('aria-valuetext', `${kelvin} kelvin, ${kelvinWord(kelvin)}`);
      }
    } else {
      const hex = lower(state.colors[group.id] ?? group.default);
      record.chip.style.setProperty('--swatch-color', hex);
      record.hexLabel.textContent = hex;
      if (record.colorInput.value !== hex && HEX_FULL.test(hex)) record.colorInput.value = hex;
      if (!record.dirty && record.hexInput.value !== hex) {
        record.hexInput.value = hex;
        record.hexInput.setAttribute('aria-invalid', 'false');
        record.hexError.hidden = true;
      }
      for (const { button, hex: swatchHex } of record.swatches) button.setAttribute('aria-pressed', String(swatchHex === hex));
    }
    if (record.finishInput) {
      const roughness = state.finishes[group.id] ?? group.finish.default;
      const value = group.finish.min + group.finish.max - roughness;
      if (Math.abs(Number(record.finishInput.value) - value) > 0.004) record.finishInput.value = String(value);
      const fraction = finishFraction(group, roughness);
      const word = finishWord(fraction);
      record.finishOutput.textContent = `${word} · ${Math.round(fraction * 100)}% satin`;
      record.finishInput.setAttribute('aria-valuetext', `${word}, ${Math.round(fraction * 100)} percent satin`);
    }
  }

  function describeHex(group, hex) {
    const match = group.swatches?.find(swatch => lower(swatch.hex) === lower(hex));
    return match ? `${match.label} ${lower(hex)}` : lower(hex);
  }

  function diffMessage(prev, next) {
    if (next.preset && next.preset !== prev.preset) {
      const preset = presets.find(item => item.id === next.preset);
      if (preset) return `Preset ${preset.label} applied`;
    }
    if (prev.modified && !next.modified) return 'All colours back to the original palette';
    const changes = [];
    for (const group of groups) {
      if (group.kind === 'light') {
        if (Math.round(prev.kelvin) !== Math.round(next.kelvin)) changes.push(`${group.label} ${Math.round(next.kelvin)} K, ${kelvinWord(next.kelvin)}`);
        continue;
      }
      if (lower(prev.colors[group.id]) !== lower(next.colors[group.id])) changes.push(`${group.label} colour ${describeHex(group, next.colors[group.id])}`);
      if (group.finish && prev.finishes[group.id] !== next.finishes[group.id]) {
        const fraction = finishFraction(group, next.finishes[group.id] ?? group.finish.default);
        changes.push(`${group.label} finish ${finishWord(fraction).toLowerCase()}, ${Math.round(fraction * 100)} percent satin`);
      }
    }
    if (!changes.length) return null;
    return changes.length === 1 ? changes[0] : `${changes.length} colour settings updated`;
  }

  function applyDisabledFlags() {
    bodyFieldset.disabled = externalDisabled;
    toggle.disabled = false;
    root.dataset.disabled = String(externalDisabled);
  }

  function sync(first = false) {
    const prev = current;
    current = palette.state();
    for (const [presetId, button] of presetButtons) button.setAttribute('aria-pressed', String(current.preset === presetId));
    for (const record of controls.values()) syncGroup(record, current);
    undoButton.setAttribute('aria-disabled', String(!palette.canUndo()));
    redoButton.setAttribute('aria-disabled', String(!palette.canRedo()));
    resetAllButton.setAttribute('aria-disabled', String(!current.modified));
    // The engine leaves compare as soon as any edit lands; follow it so the button never lies.
    if (typeof current.comparing === 'boolean' && current.comparing !== comparing) {
      comparing = current.comparing;
      if (!comparing) holding = false;
      renderCompare();
    }
    const preset = current.preset && presets.find(item => item.id === current.preset);
    summaryText.textContent = !current.modified ? 'Original colours' : preset ? `Preset: ${preset.label}` : 'Custom colours';
    if (first) return;
    const text = override ?? diffMessage(prev, current);
    if (override) { override = null; announceNow(text); }
    else if (text) announceSoon(text);
  }
  const unsubscribe = palette.subscribe(() => sync());
  sync(true);
  applyDisabledFlags();

  function setDisabled(disabled) {
    externalDisabled = !!disabled;
    if (externalDisabled && comparing) { holding = false; setCompare(false); }
    applyDisabledFlags();
  }

  root.hidden = false;
  listen(mobile, 'change', () => {
    if (!mobile.matches) return;
    const open = [...groupsRoot.querySelectorAll('details[open]')];
    for (const extra of open.slice(1)) extra.open = false;
  });

  return {
    setDisabled,
    dispose() {
      clearTimeout(announceTimer);
      if (comparing) setCompare(false);
      unsubscribe?.();
      for (const stop of cleanup.splice(0)) stop();
      root.replaceChildren();
      root.hidden = true;
      delete root.dataset.collapsed;
      delete root.dataset.disabled;
    },
  };
}
