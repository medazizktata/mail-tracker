import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generatePassword, renderWranglerConfig, parseAccounts, parseKvId, parseWorkerUrl,
  isNotLoggedIn, validWorkerName, validSubdomain, suggestSubdomain, parseKvList, parseToken,
} from '../scripts/lib.mjs';

// Outputs copied from real wrangler 4.135.0 runs during this project.
const WHOAMI = `
 ⛅️ wrangler 4.135.0
👋 You are logged in with an OAuth Token, associated with the email someone@example.com.
┌──────────────────────────────────┬──────────────────────────────────┐
│ Account Name                     │ Account ID                       │
├──────────────────────────────────┼──────────────────────────────────┤
│ Someone's Account                │ a1b2c3d4e5f60718293a4b5c6d7e8f90 │
│ Second Org                       │ f0e1d2c3b4a5968778695a4b3c2d1e0f │
└──────────────────────────────────┴──────────────────────────────────┘`;
const KV_CREATE = `🌀 Creating namespace with title "example-tracker"
✨ Success!
{
  "kv_namespaces": [
    {
      "binding": "example_tracker",
      "id": "0123456789abcdef0123456789abcdef"
    }
  ]
}`;
// Seen on a real run: with a wrangler.toml in the folder, wrangler prints the snippet as TOML.
const KV_CREATE_TOML = `🌀 Creating namespace with title "mt-setup-test-tracker"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "mt_setup_test_tracker"
id = "fedcba9876543210fedcba9876543210"

Done in 2s using pnpm v12.9.1`;
const KV_LIST = ` ⛅️ wrangler 4.135.0 (update available 4.164.0)
[
  {
    "id": "fedcba9876543210fedcba9876543210",
    "title": "mt-setup-test-tracker",
    "supports_url_encoding": true
  },
  {
    "id": "0123456789abcdef0123456789abcdef",
    "title": "example-tracker"
  }
]
Done in 1.4s using pnpm v12.9.1`;
const DEPLOY = `Uploaded example-tracker (3.88 sec)
Deployed example-tracker triggers (3.92 sec)
  https://example-tracker.someone.workers.dev
  schedule: * * * * *`;

describe('reading wrangler output', () => {
  test('accounts come out of the whoami table with their ids', () => {
    assert.deepEqual(parseAccounts(WHOAMI), [
      { name: "Someone's Account", id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
      { name: 'Second Org', id: 'f0e1d2c3b4a5968778695a4b3c2d1e0f' },
    ]);
  });
  test('no table, no accounts', () => assert.deepEqual(parseAccounts('You are not authenticated.'), []));

  test('the namespace id comes out of kv create', () => {
    assert.equal(parseKvId(KV_CREATE), '0123456789abcdef0123456789abcdef');
    assert.equal(parseKvId('nothing here'), null);
  });

  test('the namespace id also comes out of the TOML form wrangler prints beside a wrangler.toml', () => {
    assert.equal(parseKvId(KV_CREATE_TOML), 'fedcba9876543210fedcba9876543210');
  });

  test('a list of namespaces is read through the banner and the trailing line', () => {
    assert.deepEqual(parseKvList(KV_LIST).map(n => n.title), ['mt-setup-test-tracker', 'example-tracker']);
    assert.deepEqual(parseKvList('[]\nDone in 1s'), []);
    assert.deepEqual(parseKvList('no json here'), []);
  });

  test('the worker URL comes out of a deploy', () => {
    assert.equal(parseWorkerUrl(DEPLOY), 'https://example-tracker.someone.workers.dev');
    assert.equal(parseWorkerUrl('no url'), null);
  });

  test('a missing login is recognised', () => {
    assert.equal(isNotLoggedIn('You are not authenticated. Please run `wrangler login`.'), true);
    assert.equal(isNotLoggedIn(WHOAMI), false);
  });
});

describe('reading the token from `wrangler auth token`', () => {
  const TOKEN = 'abcdEFGH1234_-.ijklMNOP5678qrstUVWX9012yz';
  test('picks the token line, not a banner or a trailing status line', () => {
    assert.equal(parseToken(` ⛅️ wrangler 4.135.0\n${TOKEN}\n\nDone in 2.1s using pnpm v12.9.1\n`), TOKEN);
  });
  test('works when the token is the only output', () => assert.equal(parseToken(`${TOKEN}\n`), TOKEN));
  test('nothing token-shaped gives null', () => {
    assert.equal(parseToken('Done in 2.1s using pnpm v12.9.1'), null);
    assert.equal(parseToken(''), null);
  });
});

describe('the generated password', () => {
  test('is long, URL-safe and different each time', () => {
    const a = generatePassword(), b = generatePassword();
    assert.match(a, /^[A-Za-z0-9_-]{24,}$/);
    assert.notEqual(a, b);
  });
});

describe('the generated wrangler config', () => {
  const args = { name: 'mail-tracker', accountId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', kvId: '0123456789abcdef0123456789abcdef' };

  test('names the account, the namespace and the cron trigger', () => {
    const t = renderWranglerConfig(args);
    assert.match(t, /^name = "mail-tracker"$/m);
    assert.match(t, /^account_id = "a1b2c3d4e5f60718293a4b5c6d7e8f90"$/m);
    assert.match(t, /binding = "TRACKER"\nid = "0123456789abcdef0123456789abcdef"/);
    assert.match(t, /\[triggers\]\ncrons = \["\* \* \* \* \*"\]/);
  });

  test('refuses values that could inject extra lines into the file', () => {
    assert.throws(() => renderWranglerConfig({ ...args, name: 'x"\n[evil]' }));
    assert.throws(() => renderWranglerConfig({ ...args, accountId: 'nothex' }));
    assert.throws(() => renderWranglerConfig({ ...args, kvId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90"\nmain = "x' }));
  });
});

describe('names', () => {
  test('worker names: lowercase letters, digits and hyphens, not starting with a hyphen', () => {
    for (const ok of ['mail-tracker', 'a', 'mt-2']) assert.equal(validWorkerName(ok), true, ok);
    for (const bad of ['', 'Mail', '-x', 'a b', 'a_b', 'a'.repeat(64), 'x"y']) assert.equal(validWorkerName(bad), false, bad);
  });
  test('subdomains: same rule, and no leading or trailing hyphen', () => {
    for (const ok of ['someone', 'mt-abc123', 'a']) assert.equal(validSubdomain(ok), true, ok);
    for (const bad of ['', '-a', 'a-', 'A', 'a.b', 'x'.repeat(64)]) assert.equal(validSubdomain(bad), false, bad);
  });
  test('a suggested subdomain is valid and carries no identity', () => {
    const s = suggestSubdomain();
    assert.equal(validSubdomain(s), true);
    assert.match(s, /^mt-[a-z0-9]{6}$/);
    assert.notEqual(suggestSubdomain(), suggestSubdomain());
  });
});
