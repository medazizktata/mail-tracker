import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// Guards on how the extension is put together. None of this needs a browser, and each item
// is something that has gone wrong, or nearly did, in this project.
const EXT = new URL('../extension/', import.meta.url);
const read = p => readFileSync(new URL(p, EXT), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const jsFiles = readdirSync(EXT).filter(f => f.endsWith('.js'));
const contentScripts = manifest.content_scripts[0].js;

// Code with full-line comments removed, so a URL in a comment is not mistaken for one in code.
const code = f => read(f).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('extension packaging', () => {
  test('every content script the manifest names exists, and gmail.js loads last', () => {
    for (const f of contentScripts) assert.ok(existsSync(new URL(f, EXT)), f);
    assert.equal(contentScripts.at(-1), 'gmail.js');
  });

  test('gmail.js only uses helper namespaces whose files the manifest loads', () => {
    const provider = { I18n: 'i18n.js', Send: 'send-signatures.js', Logic: 'logic.js' };
    const used = new Set([...code('gmail.js').matchAll(/MailTracker([A-Za-z0-9]+)\b/g)].map(m => m[1]));
    for (const ns of used) {
      assert.ok(provider[ns], `unknown namespace MailTracker${ns}`);
      assert.ok(contentScripts.includes(provider[ns]), `${provider[ns]} is not loaded before gmail.js`);
    }
  });

  test('popup.html loads i18n.js before popup.js, and the service worker imports it', () => {
    const html = read('popup.html');
    assert.ok(html.indexOf('src="i18n.js"') > -1 && html.indexOf('src="i18n.js"') < html.indexOf('src="popup.js"'));
    assert.match(read('background.js'), /importScripts\(\s*['"]i18n\.js['"]\s*\)/);
  });

  test('no script file is orphaned (a renamed or replaced module left behind)', () => {
    const referenced = new Set([...contentScripts, manifest.background.service_worker]);
    for (const m of read('popup.html').matchAll(/src="([^"]+\.js)"/g)) referenced.add(m[1]);
    for (const m of read('background.js').matchAll(/importScripts\(\s*['"]([^'"]+)['"]/g)) referenced.add(m[1]);
    assert.deepEqual(jsFiles.filter(f => !referenced.has(f)), []);
  });
});

describe('extension privilege and data flow', () => {
  test('permissions are only storage, notifications and alarms, with no host permissions', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
  });

  test('the content script only runs on Gmail', () => {
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://mail.google.com/*']);
  });

  test('every fetch goes to the configured server, and no other URL appears in code', () => {
    for (const f of jsFiles) {
      for (const m of code(f).matchAll(/\bfetch\(\s*([^,)]*)/g)) {
        assert.match(m[1].trim(), /^`\$\{(serverUrl|input)\}/, `${f}: fetch(${m[1].trim()})`);
      }
      const urls = [...code(f).matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => m[0]);
      assert.deepEqual(urls.filter(u => u !== 'http://www.w3.org/2000/svg'), [], `${f} contains a URL literal`);
    }
  });

  test('no HTML injection sinks or dynamic code in the extension', () => {
    for (const f of jsFiles) {
      assert.doesNotMatch(code(f), /\.(inner|outer)HTML\s*=|insertAdjacentHTML|\beval\s*\(|new Function\(|document\.write/, f);
    }
  });

  test('the dashboard password is never kept in storage.sync', () => {
    for (const f of jsFiles) assert.doesNotMatch(code(f), /storage\.sync\.[a-z]+\([^)]*dashboardPassword/, f);
  });
});

describe('the popup list scrolls', () => {
  const popup = read('popup.html');
  const rule = sel => (popup.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}')) || [])[1] || '';

  test('the list itself is the scroll area, with a bounded height', () => {
    const r = rule('#pixel-container');
    assert.match(r, /overflow-y:\s*auto/);
    assert.match(r, /max-height:\s*\d+px/);
  });
  test('the body does not also scroll: one scroller, so the header stays put and the wheel has one target', () => {
    assert.doesNotMatch(rule('body'), /overflow/);
  });
});

describe('the popup links to the web dashboard', () => {
  test('a link is there, hidden until a server is set, and has a translated label', () => {
    const popup = read('popup.html');
    assert.match(popup, /id="dashboard-link"/);
    assert.match(popup, /id="dashboard-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|id="dashboard-link"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/);
    for (const lang of ['en', 'fr']) assert.ok(JSON.parse(read(`_locales/${lang}/messages.json`)).openDashboard?.message, lang);
  });
  test('its address is the worker origin and never carries the password', () => {
    const js = code('popup.js');
    assert.match(js, /dashboard-link['"]\)\.href\s*=\s*saved\b/);
    assert.doesNotMatch(js, /dashboard-link[^\n]*dashboardPassword/);
  });
});

describe('the setup view checkbox', () => {
  // `.setup input { width: 100% }` and `.setup { text-align: center }` stretched the checkbox across
  // the row and pushed its label to the right edge; the row must opt out of both.
  test('opts out of the full-width input rule and the centred text', () => {
    const popup = read('popup.html');
    assert.match(popup, /<input type="checkbox" id="track-links"[^>]*style="[^"]*width:auto/);
    assert.match(popup, /<label style="[^"]*text-align:left[^"]*">\s*<input type="checkbox" id="track-links"/);
  });
});
