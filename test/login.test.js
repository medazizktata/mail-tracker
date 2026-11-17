import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { fakeKV } from '../support/fake-kv.js';
import { signSession, readSession, safeNext, SESSION_SECONDS } from '../src/session.js';
import { renderLogin } from '../src/views/login.js';

const PASSWORD = 'pa:ss word';
const BASIC = 'Basic ' + Buffer.from(`:${PASSWORD}`).toString('base64');
const ORIGIN = 'https://tracker.test';

let env;
beforeEach(() => { env = { TRACKER: fakeKV(), DASHBOARD_PASSWORD: PASSWORD, LOGIN_FAIL_DELAY_MS: '0' }; });

const call = (path, { method = 'GET', headers = {}, form, body } = {}) => {
  const h = new Headers(headers);
  let payload = body;
  if (form) { h.set('Content-Type', 'application/x-www-form-urlencoded'); payload = new URLSearchParams(form).toString(); }
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: h, body: payload }), env);
};
const navigate = (path, headers = {}) => call(path, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html', ...headers } });
const signIn = (password = PASSWORD, extra = {}) => call('/login', { method: 'POST', form: { password, ...extra }, headers: { Origin: ORIGIN } });
const cookieOf = res => (res.headers.get('Set-Cookie') || '').split(';')[0];

describe('a browser that is not signed in gets a sign-in page, not the browser\'s password prompt', () => {
  test('page routes redirect a navigation to /login, remembering where it was going', async () => {
    for (const [path, next] of [['/', '%2F'], ['/connect', '%2Fconnect'], ['/s/0123456789abcdef', '%2Fs%2F0123456789abcdef']]) {
      const res = await navigate(path);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('Location'), `/login?next=${next}`, path);
      assert.equal(res.headers.get('WWW-Authenticate'), null, `${path} must not trigger the native prompt`);
      assert.match(res.headers.get('Cache-Control'), /no-store/);
    }
  });

  test('a request that is not a page load still gets the 401 challenge (curl, the extension)', async () => {
    const res = await call('/');
    assert.equal(res.status, 401);
    assert.match(res.headers.get('WWW-Authenticate'), /^Basic/);
    assert.equal((await call('/list')).status, 401);
    assert.equal((await navigate('/list')).status, 401); // API routes never redirect
  });

  test('the login page is a real form that a password manager recognises', async () => {
    const res = await call('/login');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/login"/);
    assert.match(html, /<input[^>]*type="password"[^>]*autocomplete="current-password"/);
    assert.match(html, /<input[^>]*autocomplete="username"/);
    assert.match(html, /<label[^>]*for="password"/);
    assert.match(res.headers.get('Content-Security-Policy'), /form-action 'self'/);
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
  });

  test('the other pages still forbid form posts', async () => {
    const res = await call('/', { headers: { Authorization: BASIC } });
    assert.match(res.headers.get('Content-Security-Policy'), /form-action 'none'/);
  });
});

describe('signing in', () => {
  test('the right password sets a hardened session cookie and goes where you were headed', async () => {
    const res = await signIn(PASSWORD, { next: '/connect' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/connect');
    const set = res.headers.get('Set-Cookie');
    assert.match(set, /^__Host-mt_session=/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_SECONDS}`]) assert.ok(set.includes(attr), attr);
    assert.ok(!/Domain=/i.test(set), 'a __Host- cookie has no Domain');
    assert.ok(!set.includes(encodeURIComponent(PASSWORD)) && !set.includes(PASSWORD), 'the password is never in the cookie');
  });

  test('the cookie then opens every page and API route, including ones that change data', async () => {
    const cookie = cookieOf(await signIn());
    const withCookie = { Cookie: cookie, Origin: ORIGIN };
    assert.equal((await call('/', { headers: withCookie })).status, 200);
    assert.equal((await call('/connect', { headers: withCookie })).status, 200);
    assert.equal((await call('/list', { headers: withCookie })).status, 200);
    const made = await call('/new', { method: 'POST', headers: { ...withCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'a@b.co', subject: 'S' }) });
    assert.equal(made.status, 200);
    const { id } = await made.json();
    assert.equal((await call(`/d/${id}`, { method: 'DELETE', headers: withCookie })).status, 200);
  });

  test('the wrong password shows the form again with an error and sets nothing', async () => {
    const res = await signIn('nope');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Set-Cookie'), null);
    assert.equal(res.headers.get('WWW-Authenticate'), null);
    assert.match(await res.text(), /role="alert"[^>]*>[^<]*incorrect/i);
  });

  test('a password with a colon or a space signs in (the form takes it whole)', async () => {
    assert.equal((await signIn(PASSWORD)).status, 303);
    assert.equal((await signIn('pa')).status, 401);
    assert.equal((await signIn('')).status, 401);
    assert.equal((await call('/login', { method: 'POST', headers: { Origin: ORIGIN } })).status, 401); // no body at all
  });

  test('an empty password never signs in, even if none were configured', async () => {
    env.DASHBOARD_PASSWORD = '';
    for (const res of [await signIn(''), await call('/login'), await navigate('/')]) assert.equal(res.status, 503);
    assert.equal((await signIn('')).headers.get('Set-Cookie'), null);
  });

  test('signed in already: /login just goes on', async () => {
    const cookie = cookieOf(await signIn());
    const res = await call('/login?next=%2Fconnect', { headers: { Cookie: cookie } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/connect');
  });
});

describe('where "next" may lead', () => {
  test('only the dashboard, a tracker page or /connect on this site', () => {
    for (const ok of ['/', '/connect', '/s/0123456789abcdef']) assert.equal(safeNext(ok), ok, ok);
    const bad = ['https://evil.example/', '//evil.example', '/\\evil.example', '/\\/evil.example', 'javascript:alert(1)', '/s/../x', '/list',
      '/s/xyz', '/connect/../..', '/%2F%2Fevil.example', '/?x=1', '/\r\nSet-Cookie: a=b', '', null, undefined, 5, '/'.repeat(300)];
    for (const b of bad) assert.equal(safeNext(b), '/', String(b).slice(0, 30));
  });

  test('an attacker-supplied next never leaves the site through the form', async () => {
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      assert.equal((await signIn(PASSWORD, { next })).headers.get('Location'), '/', next);
    }
  });
});

describe('the session cookie', () => {
  const now = 1_800_000_000;

  test('verifies, and fails once expired, tampered with, truncated or issued for another password', async () => {
    const token = await signSession(PASSWORD, now + 100);
    assert.equal(await readSession(token, PASSWORD, now), true);
    assert.equal(await readSession(token, PASSWORD, now + 101), false, 'expired');
    assert.equal(await readSession(token, 'another password', now), false, 'other password');
    const [v, exp, mac] = token.split('.');
    assert.equal(await readSession([v, String(Number(exp) + 99999), mac].join('.'), PASSWORD, now), false, 'longer expiry, same mac');
    assert.equal(await readSession([v, exp, mac.slice(0, -2) + (mac.endsWith('00') ? '11' : '00')].join('.'), PASSWORD, now), false, 'altered mac');
    for (const junk of ['', 'x', 'v1..', 'v1.abc.def', `v1.${now + 100}.`, 'v2.' + exp + '.' + mac, null, undefined]) assert.equal(await readSession(junk, PASSWORD, now), false, String(junk));
    assert.equal(await readSession(token, '', now), false, 'no password configured');
  });

  test('changing the password signs every browser out', async () => {
    const cookie = cookieOf(await signIn());
    assert.equal((await call('/list', { headers: { Cookie: cookie } })).status, 200);
    env.DASHBOARD_PASSWORD = 'a new password';
    assert.equal((await call('/list', { headers: { Cookie: cookie } })).status, 401);
  });

  test('a cookie with a bad value is just not signed in', async () => {
    for (const c of ['__Host-mt_session=', '__Host-mt_session=garbage', 'other=1', '__Host-mt_session=a=b=c;;;']) {
      assert.equal((await call('/list', { headers: { Cookie: c } })).status, 401, c);
    }
  });

  test('a cookie cannot be used to change data from another site', async () => {
    const cookie = cookieOf(await signIn());
    const post = origin => call('/new', { method: 'POST', headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'a@b.co' }) });
    assert.equal((await post('https://evil.example')).status, 403);
    assert.equal((await post(ORIGIN)).status, 200);
    assert.equal((await post(null)).status, 403, 'no Origin at all on a cookie-only write');
    const del = await call('/d/0123456789abcdef', { method: 'DELETE', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(del.status, 403);
  });

  test('the extension (Basic auth, an extension Origin) is not affected by that rule', async () => {
    const res = await call('/new', { method: 'POST', headers: { Authorization: BASIC, Origin: 'chrome-extension://abcdefghijklmnop', 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'a@b.co' }) });
    assert.equal(res.status, 200);
  });

  test('on plain http (local dev) it falls back to a name and flags that work there', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost:8787' }, body: new URLSearchParams({ password: PASSWORD }).toString(),
    }), env);
    const set = res.headers.get('Set-Cookie');
    assert.match(set, /^mt_session=/);
    assert.ok(!set.includes('Secure') && set.includes('HttpOnly') && set.includes('SameSite=Strict'));
  });
});

describe('signing in is only done from this site, and signing out works', () => {
  test('a login posted from another site is refused', async () => {
    const res = await call('/login', { method: 'POST', form: { password: PASSWORD }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  test('POST /logout clears the cookie and returns to the form; GET /logout does nothing', async () => {
    const res = await call('/logout', { method: 'POST', headers: { Origin: ORIGIN } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/login');
    assert.match(res.headers.get('Set-Cookie'), /^__Host-mt_session=;.*Max-Age=0/);
    assert.equal((await call('/logout')).status, 405);
  });

  test('a logout posted from another site is refused', async () => {
    const res = await call('/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  test('a failed password waits before answering, so guessing is slow', async () => {
    delete env.LOGIN_FAIL_DELAY_MS;
    const t0 = Date.now();
    const res = await signIn('nope');
    assert.equal(res.status, 401);
    assert.ok(Date.now() - t0 >= 400, 'answered too fast');
    const t1 = Date.now();
    await signIn(PASSWORD);
    assert.ok(Date.now() - t1 < 400, 'a right password should not wait');
  });
});

describe('the sign-in page itself', () => {
  test('shows the error as text, never as markup, and keeps the destination', () => {
    const page = renderLogin({ error: '<img src=x onerror=alert(1)>', next: '/s/0123456789abcdef"><script>', nonce: 'n0nce' });
    assert.ok(!page.includes('<img src=x'), 'error was not escaped');
    assert.ok(!page.includes('"><script>'), 'next was not escaped');
    assert.match(page, /name="next"[^>]*value="\/s\/0123456789abcdef&quot;&gt;&lt;script&gt;"/);
  });

  test('has one inline script, nonced, and no inline event handlers', () => {
    const page = renderLogin({ error: '', next: '/', nonce: 'n0nce' });
    assert.equal((page.match(/<script/g) || []).length, 1);
    assert.match(page, /<script nonce="n0nce">/);
    assert.doesNotMatch(page, /\son[a-z]+\s*=/i);
  });

  test('works without script: the form submits as plain HTML', () => {
    const page = renderLogin({ error: '', next: '/', nonce: 'n' });
    assert.match(page, /<button[^>]*type="submit"/);
    assert.match(page, /name="password"[^>]*required/);
  });
});

describe('the dashboard knows about signing in and out', () => {
  test('has a sign-out button that posts to /logout, and sends an expired session to /login', async () => {
    const cookie = cookieOf(await signIn());
    const page = await (await call('/', { headers: { Cookie: cookie } })).text();
    assert.match(page, /id="signOut"/);
    assert.match(page, /fetch\('\/logout', \{ method: 'POST' \}\)/);
    assert.match(page, /r\.status === 401\) \{ location\.href = '\/login'/);
  });
});
