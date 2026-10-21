// Overlay panel disclosure: the canvas never resizes; the panel floats above it.
const toggle = document.getElementById('panel-toggle');
const panel = document.getElementById('panel');
const label = document.getElementById('panel-toggle-label');

function setOpen(open, { focus } = {}) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close room panel' : 'Open room panel');
  label.textContent = open ? 'Close' : 'Panel';
  if (focus === 'panel') panel.focus({ preventScroll: true });
  if (focus === 'toggle') toggle.focus({ preventScroll: true });
}

const isOpen = () => !panel.hidden;

toggle.addEventListener('click', () => setOpen(!isOpen(), { focus: isOpen() ? 'toggle' : 'panel' }));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
  event.preventDefault();
  setOpen(false, { focus: 'toggle' });
});

setOpen(false);
