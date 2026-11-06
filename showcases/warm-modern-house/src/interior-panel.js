// Overlay panel disclosure and its tab strip: the canvas never resizes; the panel floats above it.
const toggle = document.getElementById('panel-toggle');
const panel = document.getElementById('panel');
const label = document.getElementById('panel-toggle-label');
const tabs = [...panel.querySelectorAll('[role="tab"]')];

const tabPanel = tab => document.getElementById(tab.getAttribute('aria-controls'));

function selectTab(selected, { focus = false } = {}) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tabPanel(tab).hidden = !active;
  }
  if (focus) selected.focus({ preventScroll: true });
}

function setOpen(open, { focus } = {}) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close views and controls panel' : 'Open views and controls panel');
  label.textContent = open ? 'Close' : 'Panel';
  if (focus === 'panel') panel.focus({ preventScroll: true });
  if (focus === 'toggle') toggle.focus({ preventScroll: true });
}

const isOpen = () => !panel.hidden;

toggle.addEventListener('click', () => setOpen(!isOpen(), { focus: isOpen() ? 'toggle' : 'panel' }));

// WAI-ARIA tabs: arrows move between tabs, Home/End jump to the ends.
panel.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length,
    Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(tabs[next], { focus: true });
});
for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
  event.preventDefault();
  setOpen(false, { focus: 'toggle' });
});

/** Opens the panel on the tab that holds `element`, so it can receive focus. */
export function revealInPanel(element) {
  const owner = element.closest('[role="tabpanel"]');
  const tab = tabs.find(candidate => tabPanel(candidate) === owner);
  if (!isOpen()) setOpen(true);
  if (tab) selectTab(tab);
}

selectTab(tabs[0]);
setOpen(false);
