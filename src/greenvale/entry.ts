void import('./host.js').catch((error: unknown) => {
  console.error('Greenvale module failed to load', error);
  const loading = document.getElementById('greenvale-loading');
  if (loading) {
    loading.dataset.state = 'error';
    loading.setAttribute('aria-busy', 'false');
  }
  const status = document.getElementById('greenvale-entry-status');
  if (status) {
    status.setAttribute('role', 'alert');
    status.textContent = 'Greenvale could not load. Check your connection and reload this page.';
  }
});
