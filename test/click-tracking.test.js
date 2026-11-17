import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { fakeKV } from '../support/fake-kv.js';
import { MAX_HITS_PER_TRACKER, MAX_LINKS, MAX_LINK_LENGTH, validLinks } from '../src/shared.js';

const PASSWORD = 'pw';
const SENDER_IP = '203.0.113.9';
const OTHER_IP = '198.51.100.4';
const AUTH = 'Basic ' + Buffer.from(`:${PASSWORD}`).toString('base64');
const LINKS = ['https://example.com/a', 'https://example.org/b?x=1'];

let env;
beforeEach(() => { env = { TRACKER: fakeKV(), DASHBOARD_PASSWORD: PASSWORD }; });

const call = (path, { method = 'GET', body, auth = true, ip = SENDER_IP, ua = 'Mozilla/5.0' } = {}) => {
  const h = new Headers({ 'cf-connecting-ip': ip, 'user-agent': ua });
  if (auth) h.set('Authorization', AUTH);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return worker.fetch(new Request(`https://tracker.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};

async function make(links = LINKS, extra = {}) {
  const res = await call('/new', { method: 'POST', body: { to: 'bob@example.com', subject: 'S', links, ...extra } });
  assert.equal(res.status, 200);
  return res.json();
}
const read = id => env.TRACKER.get(id, 'json');
// Scanners click within seconds of delivery, so a tracker that is "too new" files clicks away. Age it for the real-click tests.
async function age(id, ms = 60_000) {
  const d = await read(id);
  d.createdAt = new Date(Date.now() - ms).toISOString();
  await env.TRACKER.put(id, JSON.stringify(d));
}
const click = (id, n, opts = {}) => call(`/c/${id}/${n}`, { auth: false, ip: OTHER_IP, ...opts });

describe('validLinks', () => {
  test('keeps http and https, normalised, in order, without duplicates', () => {
    assert.deepEqual(validLinks(['https://ok.example', 'http://ok2.example/x', 'https://ok.example/']), ['https://ok.example/', 'http://ok2.example/x']);
  });
  test('drops other schemes, credentials, non-strings and garbage', () => {
    const bad = ['javascript:alert(1)', 'ftp://x.example/y', 'data:text/html,x', 'mailto:a@b.co', 'https://user:pw@example.com/', 'not a url', '', 5, null, {}];
    assert.deepEqual(validLinks(bad), []);
  });
  test('caps the count and the length', () => {
    const many = Array.from({ length: MAX_LINKS + 5 }, (_, i) => `https://example.com/${i}`);
    assert.equal(validLinks(many).length, MAX_LINKS);
    assert.deepEqual(validLinks([`https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}`]), []);
  });
  test('a CRLF smuggled into a link cannot reach a header', () => {
    const [u] = validLinks(['https://example.com/a\r\nSet-Cookie: x=1']);
    assert.ok(!/[\r\n]/.test(u), u);
  });
});

describe('/new with links', () => {
  test('returns a tracked URL for each link, in order', async () => {
    const r = await make();
    assert.deepEqual(r.links, LINKS.map((url, index) => ({ index, url, tracked: `https://tracker.test/c/${r.id}/${index}` })));
  });
  test('stores only the valid links', async () => {
    const r = await make(['https://ok.example/', 'javascript:alert(1)', 'https://ok.example/']);
    assert.equal(r.links.length, 1);
    assert.deepEqual((await read(r.id)).links, ['https://ok.example/']);
  });
  test('links must be an array', async () => {
    const res = await call('/new', { method: 'POST', body: { to: 'bob@example.com', links: 'https://example.com' } });
    assert.equal(res.status, 400);
  });
  test('a link-only tracker needs no recipient (for plain-text clients)', async () => {
    const res = await call('/new', { method: 'POST', body: { links: ['https://example.com/'] } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).links.length, 1);
  });
  test('no links, no links in the response, and no click route', async () => {
    const r = await make([]);
    assert.deepEqual(r.links, []);
    assert.equal((await click(r.id, 0)).status, 404);
  });
});

describe('the click redirect', () => {
  test('goes to the stored link and counts the click', async () => {
    const { id } = await make(); await age(id);
    const res = await click(id, 0);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), LINKS[0]);
    const d = await read(id);
    assert.equal(d.clicks, 1);
    assert.equal(d.clickEvents[0].link, 0);
    assert.equal((await click(id, 1)).headers.get('Location'), LINKS[1]);
  });

  test('is not cached and leaks no referrer', async () => {
    const { id } = await make(); await age(id);
    const res = await click(id, 0);
    assert.match(res.headers.get('Cache-Control'), /no-store/);
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  });

  test('can only reach stored links: unknown id, bad index, odd index forms are all 404 and never redirect', async () => {
    const { id } = await make(); await age(id);
    for (const path of [`/c/nope0000/0`, `/c/${id}/2`, `/c/${id}/-1`, `/c/${id}/abc`, `/c/${id}/00`, `/c/${id}/1.5`, `/c/${id}/`, `/c/${id}`, `/c/${id}/0/extra`]) {
      const res = await call(path, { auth: false, ip: OTHER_IP });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('Location'), null, path);
    }
  });

  test('a query parameter cannot choose the destination: no open redirect', async () => {
    const { id } = await make(); await age(id);
    for (const q of ['?u=https://evil.example', '?url=https://evil.example', '?to=https://evil.example', '?redirect=//evil.example']) {
      const res = await call(`/c/${id}/0${q}`, { auth: false, ip: OTHER_IP });
      assert.equal(res.headers.get('Location'), LINKS[0], q);
    }
  });

  test('a HEAD request redirects but records nothing', async () => {
    const { id } = await make(); await age(id);
    const res = await call(`/c/${id}/0`, { method: 'HEAD', auth: false, ip: OTHER_IP });
    assert.equal(res.status, 302);
    assert.equal((await read(id)).clicks || 0, 0);
  });

  test('only GET and HEAD', async () => {
    const { id } = await make(); await age(id);
    assert.equal((await call(`/c/${id}/0`, { method: 'POST', auth: false, body: {} })).status, 404);
  });
});

describe('which clicks count', () => {
  test('the sender\'s own click is filed, not counted, and still redirects', async () => {
    const { id } = await make(); await age(id);
    const res = await click(id, 0, { ip: SENDER_IP });
    assert.equal(res.status, 302);
    const d = await read(id);
    assert.equal(d.clicks || 0, 0);
    assert.equal(d.filteredEvents.at(-1).reason, 'sender_ip');
  });

  test('a link scanner is filed, not counted, and still redirects', async () => {
    const { id } = await make(); await age(id);
    const res = await click(id, 0, { ua: 'Mozilla/5.0 Safelinks' });
    assert.equal(res.status, 302);
    const d = await read(id);
    assert.equal(d.clicks || 0, 0);
    assert.equal(d.filteredEvents.at(-1).reason, 'bot_proxy');
  });

  test('a click within seconds of sending is a scanner, not a reader', async () => {
    const { id } = await make(); // brand new
    const res = await click(id, 0);
    assert.equal(res.status, 302);
    const d = await read(id);
    assert.equal(d.clicks || 0, 0);
    assert.equal(d.filteredEvents.at(-1).reason, 'too_fast');
  });

  test('repeat clicks from one address inside the window count once', async () => {
    const { id } = await make(); await age(id);
    for (let i = 0; i < 4; i++) await click(id, 0);
    assert.equal((await read(id)).clicks, 1);
  });

  test('clicks from different addresses each count', async () => {
    const { id } = await make(); await age(id);
    await click(id, 0, { ip: '198.51.100.1' });
    await click(id, 0, { ip: '198.51.100.2' });
    assert.equal((await read(id)).clicks, 2);
  });
});

describe('limits', () => {
  test('past the per-tracker hit cap a click still redirects but nothing is written', async () => {
    const { id } = await make(); await age(id);
    const d = await read(id);
    d.opens = MAX_HITS_PER_TRACKER;
    await env.TRACKER.put(id, JSON.stringify(d));
    const before = env.TRACKER.ops.put;
    const res = await click(id, 0);
    assert.equal(res.status, 302);
    assert.equal(env.TRACKER.ops.put, before);
  });

  test('click events are capped', async () => {
    const { id } = await make(); await age(id);
    for (let i = 0; i < 130; i++) await click(id, 0, { ip: `10.2.${Math.floor(i / 250)}.${i % 250}` });
    assert.ok((await read(id)).clickEvents.length <= 100);
  });

  test('a failing write never blocks the redirect', async () => {
    const { id } = await make(); await age(id);
    env.TRACKER.put = async () => { throw new Error('KV down'); };
    const res = await click(id, 0);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), LINKS[0]);
  });
});

describe('who can read the clicks', () => {
  test('the owner sees clicks and links in the stats; nobody else', async () => {
    const { id } = await make(); await age(id); await click(id, 0);
    assert.equal((await call(`/s/${id}?format=json`, { auth: false })).status, 401);
    const stats = await (await call(`/s/${id}?format=json`)).json();
    assert.equal(stats.clicks, 1);
    assert.deepEqual(stats.links, LINKS);
    assert.equal(stats.senderIp, undefined);
  });

  test('the list carries the click count', async () => {
    const { id } = await make(); await age(id); await click(id, 0);
    const list = await (await call('/list')).json();
    assert.equal(list.find(t => t.id === id).clicks, 1);
  });
});

describe('the stats page, end to end', () => {
  test('shows the tracked address with this worker\'s own origin, and the clicks', async () => {
    const { id } = await make(); await age(id); await click(id, 1);
    const html = await (await call(`/s/${id}`)).text();
    assert.ok(html.includes(`https://tracker.test/c/${id}/1`));
    assert.match(html, /id="statClicks">1</);
  });
});
