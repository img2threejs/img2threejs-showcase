import { REGIONS, INTERACTION_MODES } from './labels.mjs';

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || ['id', 'class', 'type', 'for', 'role', 'min', 'max', 'step', 'value'].includes(key)) node.setAttribute(key, value === true ? '' : value);
    else node[key] = value;
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
};

export const CAMERA_VIEWS = Object.freeze([
  { id: 'follow', label: 'Follow' },
  { id: 'front', label: 'Front' },
  { id: 'quarter', label: '3/4' },
  { id: 'profile', label: 'Side' },
  { id: 'rear', label: 'Back' },
  { id: 'torso', label: 'Upper body' },
  { id: 'hips', label: 'Hips' },
  { id: 'face', label: 'Face' },
  { id: 'skill', label: 'Skill', only: ['robin'] },
  { id: 'wide', label: 'Giant', only: ['robin'] },
]);

/**
 * Builds one character's four sections (Outfit, Animation, Camera, Touch) into `root`.
 * Every control id is prefixed with the character id: `${id}-animation`, `${id}-motion` ...
 */
export function buildCharacterPanel(root, { id, name, outfits, outfitNote, timeline = false, replay = false }) {
  const group = (title, ...children) => h('div', { class: 'group', 'data-section': title.toLowerCase() }, h('h3', { text: title }), ...children);
  root.replaceChildren(
    group('Outfit',
      h('div', { class: 'segmented outfit-grid', role: 'group', 'aria-label': `${name} outfit` },
        outfits.map(outfit => h('button', { 'data-character': id, 'data-outfit': outfit.id, 'aria-pressed': 'false', disabled: true, title: outfit.label },
          outfit.swatch ? h('i', { class: 'swatch', style: `background:${outfit.swatch}`, 'aria-hidden': 'true' }) : null, outfit.label))),
      h('p', { class: 'outfit-note', id: `${id}-outfit-note`, text: outfitNote })),
    group('Animation',
      h('select', { id: `${id}-animation`, 'aria-label': `${name} animation`, disabled: true }, h('option', { text: 'Loading animations…' })),
      h('p', { class: 'outfit-note', id: `${id}-clip-note` }),
      timeline ? h('div', { class: 'timeline', id: `${id}-timeline-box` },
        h('div', { class: 'label-row' }, h('label', { for: `${id}-timeline`, text: 'Time' }), h('output', { id: `${id}-time`, for: `${id}-timeline`, text: '0.00 / 0.00 s' })),
        h('input', { id: `${id}-timeline`, type: 'range', min: '0', max: '6', value: '0', step: '0.001', disabled: true, 'aria-label': `${name} animation time` })) : null,
      h('div', { class: 'playback' },
        h('button', { id: `${id}-motion`, class: 'primary-button', 'aria-pressed': 'true', disabled: true, text: 'Pause' }),
        replay ? h('button', { id: `${id}-replay`, class: 'outline-button', disabled: true, text: 'Replay from the start' }) : null,
        h('button', { id: `${id}-reset`, class: 'outline-button', disabled: true, text: 'Back to deck walk' }))),
    group('Camera',
      h('div', { class: 'chips', role: 'group', 'aria-label': `${name} camera angles` },
        CAMERA_VIEWS.filter(view => !view.only || view.only.includes(id)).map(view =>
          h('button', { 'data-character': id, 'data-view': view.id, 'aria-pressed': 'false', disabled: true, text: view.label })))),
    group('Touch',
      h('div', { class: 'segmented', role: 'group', 'aria-label': `${name} touch mode` },
        INTERACTION_MODES.map(mode => h('button', { id: `${id}-mode-${mode.id}`, 'data-character': id, 'data-mode': mode.id, 'aria-pressed': mode.id === 'squeeze' ? 'true' : 'false', disabled: true, text: mode.label }))),
      h('p', { class: 'outfit-note', text: 'Press and hold a spot on her, drag a little, then let go to see the elastic recovery. Pull fabric drags the top by its strap or panel.' }),
      h('p', { id: `${id}-interaction-status`, class: 'interaction-status', role: 'status', 'aria-live': 'polite', text: `Preparing ${REGIONS.length} touch regions…` }),
      h('div', { class: 'region-box' },
        h('div', { class: 'label-row' }, h('label', { for: `${id}-region`, text: 'Region' }), h('span', { id: `${id}-tissue`, text: '—' })),
        h('select', { id: `${id}-region`, disabled: true }, REGIONS.map(region => h('option', { value: region.id, text: region.label }))),
        h('div', { class: 'readouts' },
          h('div', {}, h('span', { text: 'NATURAL FREQUENCY' }), h('strong', { id: `${id}-frequency`, text: '—' })),
          h('div', {}, h('span', { text: 'DAMPING' }), h('strong', { id: `${id}-damping`, text: '—' }))),
        h('button', { id: `${id}-impulse`, class: 'outline-button', disabled: true, text: 'Test bounce' }))),
  );
}
