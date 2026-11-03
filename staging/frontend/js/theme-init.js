/* Apply the saved / system theme before first paint (loaded in <head>; the sign-in page allows no inline scripts). */
(function () {
  var t = null;
  try { t = localStorage.getItem('mcb-theme'); } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', t);
})();
