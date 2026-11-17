import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { encodeConnectionCode } from '../src/shared.js';

// The extension side is a classic script (popup page), published on globalThis.
await import('../extension/connection-code.js');
const { decode, looksLikeCode } = globalThis.MailTrackerConnect;

const ORIGIN = 'https://mt.example.workers.dev';

describe('connection code: the worker encodes it, the extension decodes it', () => {
  test('round trip, including a password with symbols and non-ASCII characters', () => {
    for (const pw of ['correct horse', 'pa:ss word/+=?&#%', 'mot de passe: é à ü € 日本', 'x']) {
      assert.deepEqual(decode(encodeConnectionCode(ORIGIN, pw)), { url: ORIGIN, password: pw });
    }
  });

  test('the code is one URL-safe token with a version prefix', () => {
    const code = encodeConnectionCode(ORIGIN, 'a password/with+symbols=');
    assert.match(code, /^mt1\.[A-Za-z0-9_-]+$/);
  });

  test('surrounding whitespace from a copy and paste is ignored', () => {
    const code = encodeConnectionCode(ORIGIN, 'secret-123');
    assert.deepEqual(decode(`  ${code}\n`), { url: ORIGIN, password: 'secret-123' });
  });

  test('looksLikeCode tells a code from a plain URL', () => {
    assert.equal(looksLikeCode(encodeConnectionCode(ORIGIN, 'pw')), true);
    assert.equal(looksLikeCode('https://mt.example.workers.dev'), false);
    assert.equal(looksLikeCode(''), false);
    assert.equal(looksLikeCode(undefined), false);
  });
});

describe('connection code: anything else is refused, because it decides where mail details are sent', () => {
  const forge = obj => 'mt1.' + Buffer.from(JSON.stringify(obj)).toString('base64url');

  test('plain http is refused, except on this machine', () => {
    assert.equal(decode(encodeConnectionCode('http://example.com', 'pw')), null);
    assert.equal(decode(encodeConnectionCode('http://localhost:8787', 'pw')).url, 'http://localhost:8787');
    assert.equal(decode(encodeConnectionCode('http://127.0.0.1:8787', 'pw')).url, 'http://127.0.0.1:8787');
  });

  test('a URL with credentials, a path, a query or a fragment is refused', () => {
    for (const u of ['https://user:pw@mt.example.workers.dev', 'https://mt.example.workers.dev/x',
                     'https://mt.example.workers.dev/?a=1', 'https://mt.example.workers.dev/#frag']) {
      assert.equal(decode(forge({ u, p: 'pw' })), null, u);
    }
  });

  test('other schemes are refused', () => {
    for (const u of ['javascript:alert(1)', 'ftp://mt.example.workers.dev', 'chrome-extension://abc/', 'data:text/plain,x']) {
      assert.equal(decode(forge({ u, p: 'pw' })), null, u);
    }
  });

  test('missing, empty, non-string or control-character fields are refused', () => {
    for (const bad of [{}, { u: ORIGIN }, { p: 'pw' }, { u: 1, p: 'pw' }, { u: ORIGIN, p: 5 }, { u: ORIGIN, p: '' },
                       { u: ORIGIN, p: 'a\nb' }, { u: ORIGIN, p: 'x'.repeat(257) }, null, [], 'text']) {
      assert.equal(decode(forge(bad)), null, JSON.stringify(bad));
    }
  });

  test('wrong prefix, bad base64, bad JSON and oversized input are refused', () => {
    const good = encodeConnectionCode(ORIGIN, 'pw');
    assert.equal(decode(good.replace('mt1.', 'mt2.')), null);
    assert.equal(decode('mt1.!!!not base64!!!'), null);
    assert.equal(decode('mt1.' + Buffer.from('{not json').toString('base64url')), null);
    assert.equal(decode(good + 'A'.repeat(3000)), null);
    assert.equal(decode(''), null);
    assert.equal(decode(null), null);
  });

  test('invalid UTF-8 is refused rather than silently repaired', () => {
    assert.equal(decode('mt1.' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')), null);
  });
});
