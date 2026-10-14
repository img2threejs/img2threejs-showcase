void import('./host.js').catch((error: unknown) => {
  console.error('Greenvale module failed to load', error);
  const status = document.getElementById('greenvale-entry-status');
  if (status) {
    status.setAttribute('role', 'alert');
    status.textContent = 'Greenvale could not load. Check your connection and reload this page.';
  }
});
