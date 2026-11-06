// Fullscreen toggle for the whole page. Where the Fullscreen API is missing (for example iPhone
// Safari) the controls stay hidden and the viewer still fills the window.
const root = document.documentElement;
const request = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
const exit = (document.exitFullscreen ?? document.webkitExitFullscreen)?.bind(document);
const enabled = (document.fullscreenEnabled ?? document.webkitFullscreenEnabled) !== false;
const supported = !!request && !!exit && enabled;
const buttons = [...document.querySelectorAll('[data-fullscreen]')];

const active = () => !!(document.fullscreenElement ?? document.webkitFullscreenElement);

function sync() {
  const on = active();
  for (const button of buttons) {
    button.hidden = !supported;
    button.dataset.on = String(on);
    if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(on));
    button.querySelector('[data-fullscreen-label]').textContent = button.classList.contains('stage-button')
      ? (on ? 'Exit' : 'Fullscreen')
      : (on ? 'Exit fullscreen' : 'Open in fullscreen');
    button.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  }
}

async function toggle() {
  if (!supported) return;
  try {
    if (active()) await exit();
    else await request({ navigationUI: 'hide' });
  } catch {
    // Denied by the browser or an embedding policy: the viewer remains usable full-window.
  }
}

for (const button of buttons) button.addEventListener('click', toggle);
document.addEventListener('fullscreenchange', sync);
document.addEventListener('webkitfullscreenchange', sync);
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  event.preventDefault();
  void toggle();
});

sync();
