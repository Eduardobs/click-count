(() => {
  const key = 'one-more-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Storage may be unavailable. */ }
  if (preference !== 'light' && preference !== 'dark') preference = null;

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#17211c' : '#f7f8f5';
    document.querySelector('#themeToggle')?.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  apply(preference || (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', event => {
    if (!preference) apply(event.matches ? 'dark' : 'light');
  });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('#themeToggle');
    apply(document.documentElement.dataset.theme);
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(preference);
      try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
    });
  });
})();
