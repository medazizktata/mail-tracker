import { esc, FAVICON, LOGO_SVG } from '../shared.js';

// The sign-in page. A plain form that works without script (the one script only adds a show/hide button),
// shaped so a password manager offers to fill and save it: a username field it can attach to, a labelled
// current-password field and a submit button.
export function renderLogin({ error = '', next = '/', nonce }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>Sign in · Mail Tracker</title>
<link rel="icon" href="${FAVICON}">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #09090b; --surface: #18181b; --border: #27272a; --border-hover: #3f3f46;
    --text: #fafafa; --text-2: #a1a1aa; --accent: #4f46e5; --accent-hover: #6366f1; --red: #f87171;
  }
  html { color-scheme: dark; }
  body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 380px; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; font-weight: 700; font-size: 1.05rem; letter-spacing: -0.02em; margin-bottom: 24px; }
  .brand svg { width: 28px; height: 28px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 28px 24px 24px; }
  h1 { font-size: 1.25rem; font-weight: 650; letter-spacing: -0.02em; }
  .lede { color: var(--text-2); font-size: 0.875rem; line-height: 1.5; margin: 6px 0 20px; }
  label { display: block; font-size: 0.8125rem; font-weight: 600; margin-bottom: 6px; }
  .field { position: relative; }
  input[type="password"] { width: 100%; height: 44px; padding: 0 64px 0 12px; border-radius: 10px;
    border: 1px solid var(--border-hover); background: var(--bg); color: var(--text); font: inherit; font-size: 1rem; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px; }
  .toggle { position: absolute; right: 4px; top: 4px; height: 36px; padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; color: var(--text-2); font: inherit; font-size: 0.8125rem; cursor: pointer; }
  .toggle:hover { color: var(--text); }
  .error { margin-bottom: 14px; padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(248,113,113,0.4);
    background: rgba(248,113,113,0.08); color: var(--red); font-size: 0.875rem; }
  .submit { width: 100%; height: 44px; margin-top: 16px; border: 0; border-radius: 10px; background: var(--accent); color: #fff;
    font: inherit; font-size: 0.9375rem; font-weight: 600; cursor: pointer; }
  .submit:hover { background: var(--accent-hover); }
  .help { color: var(--text-2); font-size: 0.8125rem; line-height: 1.5; margin-top: 18px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (prefers-reduced-motion: no-preference) { .submit, .toggle { transition: background 0.15s, color 0.15s; } }
</style>
</head><body>
<main>
  <div class="brand">${LOGO_SVG} Mail Tracker</div>
  <form class="card" method="post" action="/login">
    <h1>Sign in</h1>
    <p class="lede">Enter the dashboard password to see your tracked emails.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <input type="text" name="username" value="Mail Tracker" autocomplete="username" readonly tabindex="-1" aria-hidden="true" class="sr-only">
    <label for="password">Password</label>
    <div class="field">
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus${error ? ' aria-invalid="true"' : ''}>
      <button type="button" class="toggle" id="toggle" aria-controls="password" aria-pressed="false" hidden>Show</button>
    </div>
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="submit" type="submit">Sign in</button>
    <p class="help">It is the password you set when you deployed the worker. The extension's connection code contains it too.</p>
  </form>
</main>
<script nonce="${nonce}">
  var input = document.getElementById('password');
  var toggle = document.getElementById('toggle');
  toggle.hidden = false;
  toggle.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    input.focus();
  });
</script>
</body></html>`;
}
