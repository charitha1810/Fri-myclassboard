/* Sign-in page: Google Sign-In button; the server verifies the Google token and checks the MCB staff list. */
(function () {
  var holder = document.getElementById('googleBtn');
  var busyBox = document.getElementById('loginBusy');
  var errorBox = document.getElementById('loginError');
  document.getElementById('year').textContent = new Date().getFullYear();

  function setBusy(on) { busyBox.hidden = !on; holder.hidden = on; }

  /** Show a message; with `reload`, offer a button that reloads the page (for problems a retry can't fix in place). */
  function showError(msg, reload) {
    errorBox.textContent = msg;
    if (reload) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-sm btn-quiet d-flex'; b.textContent = 'Reload page';
      b.addEventListener('click', function () { location.reload(); });
      errorBox.appendChild(b);
    }
    errorBox.hidden = false;
  }

  async function onCredential(response) {
    errorBox.hidden = true;
    setBusy(true);
    var res;
    try {
      res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
        credentials: 'same-origin'
      });
    } catch (err) {
      setBusy(false);
      return showError('Cannot reach the server. Check your connection and try again.');
    }
    if (res.ok) return window.location.replace('/');
    var data = {};
    try { data = await res.json(); } catch (e) {}
    setBusy(false);
    if (res.status === 403) return showError('This Google account is not authorised for Revenue Intelligence. Sign in with your MyClassBoard staff account, or contact your administrator.');
    showError(typeof data.detail === 'string' ? data.detail : 'Sign-in failed. Please try again.');
  }

  function whenGoogleReady(cb, tries) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    if (tries <= 0) return showError('Google Sign-In did not load. Check your connection, or whether a browser extension is blocking it.', true);
    setTimeout(function () { whenGoogleReady(cb, tries - 1); }, 300);
  }

  fetch('/api/auth/config', { credentials: 'same-origin' })
    .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function (cfg) {
      whenGoogleReady(function () {
        var dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: onCredential, ux_mode: 'popup' });
        google.accounts.id.renderButton(holder, {
          theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'rectangular', text: 'signin_with',
          logo_alignment: 'left', width: Math.max(200, Math.min(320, holder.clientWidth))
        });
      }, 40);
    })
    .catch(function () { showError('Cannot reach the server.', true); });
})();
