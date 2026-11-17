import { esc, FAVICON } from '../shared.js';

// The page that hands the extension its connection code. It is only served to someone who already
// knows the password, and the code contains that password, so the page says to treat it as one.
export function renderConnect(code, nonce) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect the extension</title>
<link rel="icon" href="${FAVICON}">
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #09090b; color: #e4e4e7; }
  main { max-width: 560px; margin: 8vh auto; padding: 0 20px; }
  h1 { font-size: 1.4rem; margin: 0 0 12px; }
  textarea { width: 100%; box-sizing: border-box; background: #18181b; color: #e4e4e7; border: 1px solid #3f3f46;
             border-radius: 8px; padding: 10px; font: 13px ui-monospace, monospace; resize: none; }
  button { margin-top: 10px; background: #6366f1; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font: inherit; cursor: pointer; }
  .note { color: #a1a1aa; font-size: 0.85rem; }
  .warn { color: #fb923c; font-size: 0.85rem; }
  a { color: #a5b4fc; }
</style></head>
<body><main>
  <h1>Connect the extension</h1>
  <p>Copy this code, open the Mail Tracker popup in your browser, paste it into the first field and click <b>Save &amp; Connect</b>. Nothing else to fill in.</p>
  <textarea id="code" readonly rows="4">${esc(code)}</textarea>
  <button id="copy">Copy code</button> <span id="done" class="note" hidden>Copied</span>
  <p class="warn">This code contains your dashboard password. Treat it like the password: do not share it or paste it anywhere else.</p>
  <p class="note"><a href="/">Back to the dashboard</a></p>
  <script nonce="${nonce}">
    document.getElementById('copy').addEventListener('click', async function () {
      var box = document.getElementById('code');
      try { await navigator.clipboard.writeText(box.value); } catch (e) { box.select(); document.execCommand('copy'); }
      document.getElementById('done').hidden = false;
    });
  </script>
</main></body></html>`;
}
