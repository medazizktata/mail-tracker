import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Classic content script, published on globalThis.
await import('../extension/logic.js');
const { recipientsOf, isSentRow, findMatchingTracker } = globalThis.MailTrackerLogic;

describe('recipientsOf', () => {
  test('splits a multi-recipient label and trims', () => {
    assert.deepEqual(recipientsOf('a@x.com, b@y.org'), ['a@x.com', 'b@y.org']);
    assert.deepEqual(recipientsOf('a@x.com,b@y.org'), ['a@x.com', 'b@y.org']);
  });
  test('empty, null and undefined give no recipients', () => {
    for (const v of ['', null, undefined, ' , ']) assert.deepEqual(recipientsOf(v), []);
  });
});

describe('isSentRow: a Sent row has a localised prefix before the first recipient', () => {
  test('French "À :", English "To:", and a non-breaking space', () => {
    assert.equal(isSentRow('À : bob', 'bob'), true);
    assert.equal(isSentRow('To: bob', 'bob'), true);
    assert.equal(isSentRow('À : bob', 'bob'), true);
  });
  test('an inbox row starts straight with the sender, with or without more participants', () => {
    assert.equal(isSentRow('Alice Smith', 'Alice Smith'), false);
    assert.equal(isSentRow('Alice, Bob 2', 'Alice'), false);
  });
  test('a missing recipient span, or text that does not contain it, is not a sent row', () => {
    for (const first of ['', null, undefined]) assert.equal(isSentRow('À : bob', first), false);
    assert.equal(isSentRow('À : bob', 'carol'), false);
    assert.equal(isSentRow('', 'bob'), false);
    assert.equal(isSentRow(null, 'bob'), false);
  });
});

describe('findMatchingTracker', () => {
  const t = (id, recipient, subject, createdAt) => ({ id, recipient, subject, createdAt });
  const trackers = [
    t('old', 'bob@x.com', 'Invoice', '2026-11-01T10:00:00Z'),
    t('new', 'bob@x.com', 'Invoice', '2026-11-05T10:00:00Z'),
    t('other', 'bob@x.com', 'Lunch?', '2026-11-03T10:00:00Z'),
    t('group', 'a@x.com, bob@x.com', 'Plan', '2026-11-04T10:00:00Z'),
  ];

  test('matches on recipient and subject, and picks the newest of several', () => {
    assert.equal(findMatchingTracker(trackers, 'bob@x.com', { subject: 'Invoice' }).id, 'new');
  });

  test('the subject on the row may carry extra text, such as Re:', () => {
    assert.equal(findMatchingTracker(trackers, 'bob@x.com', { subject: 'Re: Lunch?' }).id, 'other');
  });

  test('an older untracked mail to a tracked recipient gets no tick', () => {
    // Used to fall back to "any tracker for this recipient", so every earlier mail to Bob
    // showed the newest tracker's read status.
    assert.equal(findMatchingTracker(trackers, 'bob@x.com', { subject: 'Holiday photos' }), null);
  });

  test('a recipient inside a multi-recipient label matches, case-insensitively', () => {
    assert.equal(findMatchingTracker(trackers, 'BOB@x.com', { subject: 'Plan' }).id, 'group');
  });

  test('a label stored with capitals still matches a lower-case address', () => {
    const list = [t('caps', 'Bob@X.com', 'Hi', '2026-11-02T10:00:00Z')];
    assert.equal(findMatchingTracker(list, 'bob@x.com', { subject: 'Hi' }).id, 'caps');
  });

  test('an unknown recipient gets nothing', () => {
    assert.equal(findMatchingTracker(trackers, 'zed@x.com', { subject: 'Invoice' }), null);
  });

  test('a tracker with no subject matches on recipient alone', () => {
    const list = [t('nosubj', 'bob@x.com', '', '2026-11-02T10:00:00Z')];
    assert.equal(findMatchingTracker(list, 'bob@x.com', { subject: '(no subject)' }).id, 'nosubj');
  });

  test('missing identifiers or an empty list do not throw', () => {
    assert.equal(findMatchingTracker([], 'bob@x.com', { subject: 'x' }), null);
    assert.equal(findMatchingTracker(trackers, 'bob@x.com', undefined), null);
  });

  test('the input list is not reordered', () => {
    const before = trackers.map(x => x.id).join();
    findMatchingTracker(trackers, 'bob@x.com', { subject: 'Invoice' });
    assert.equal(trackers.map(x => x.id).join(), before);
  });
});

describe('indicatorRetryDelay: draw the Sent ticks again until the Sent rows are on screen', () => {
  const { indicatorRetryDelay } = globalThis.MailTrackerLogic;

  test('keeps trying while no Sent row has been seen', () => {
    for (let attempt = 0; attempt < 8; attempt++) assert.equal(indicatorRetryDelay(attempt, 0), 1500);
  });
  test('stops once Sent rows were drawn', () => {
    assert.equal(indicatorRetryDelay(0, 1), null);
    assert.equal(indicatorRetryDelay(3, 25), null);
  });
  test('gives up after a bounded number of attempts', () => {
    assert.equal(indicatorRetryDelay(8, 0), null);
    assert.equal(indicatorRetryDelay(99, 0), null);
  });
  test('does not retry when the pass could not run (not configured)', () => {
    assert.equal(indicatorRetryDelay(0, null), null);
    assert.equal(indicatorRetryDelay(0, undefined), null);
  });
});

describe('pixelBlocker: why a message cannot carry a pixel', () => {
  const { pixelBlocker } = globalThis.MailTrackerLogic;

  test('no HTML body found: Gmail\'s plain-text mode has none', () => {
    assert.equal(pixelBlocker({ bodyCount: 0, bodyTag: undefined }), 'no-body');
  });
  test('a plain textarea cannot hold an image either', () => {
    assert.equal(pixelBlocker({ bodyCount: 1, bodyTag: 'TEXTAREA' }), 'plain-text');
    assert.equal(pixelBlocker({ bodyCount: 1, bodyTag: 'textarea' }), 'plain-text');
  });
  test('a normal editable body is fine', () => {
    assert.equal(pixelBlocker({ bodyCount: 1, bodyTag: 'DIV' }), null);
    assert.equal(pixelBlocker({ bodyCount: 2, bodyTag: 'DIV' }), null);
  });
});

describe('collectLinks: which links in a message to track', () => {
  const { collectLinks } = globalThis.MailTrackerLogic;
  const HOST = 'mt.example.workers.dev';

  test('http and https, deduplicated and normalised, in order', () => {
    assert.deepEqual(collectLinks(['https://a.example', 'http://b.example/x', 'https://a.example/'], HOST), ['https://a.example/', 'http://b.example/x']);
  });
  test('never mailto, tel, javascript, anchors or relative links', () => {
    assert.deepEqual(collectLinks(['mailto:a@b.co', 'tel:123', 'javascript:alert(1)', '#top', '/relative', 'ftp://x.example/'], HOST), []);
  });
  test('never our own worker: not the pixel, not a link already tracked', () => {
    assert.deepEqual(collectLinks([`https://${HOST}/t/abcdef0123456789`, `https://${HOST}/c/abcdef0123456789/0`, 'https://ok.example/'], HOST), ['https://ok.example/']);
  });
  test('a lookalike host is not our worker', () => {
    assert.deepEqual(collectLinks([`https://x${HOST}/page`], HOST), [`https://x${HOST}/page`]);
  });
  test('credentials and over-long links are skipped', () => {
    assert.deepEqual(collectLinks(['https://u:p@a.example/', `https://a.example/${'x'.repeat(2100)}`], HOST), []);
  });
  test('capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://a.example/${i}`);
    assert.equal(collectLinks(many, HOST).length, 20);
  });
  test('empty and garbage input', () => {
    assert.deepEqual(collectLinks([], HOST), []);
    assert.deepEqual(collectLinks([null, undefined, '', 5], HOST), []);
  });
});

describe('hasPixel: does a message body already carry our pixel', () => {
  const { hasPixel } = globalThis.MailTrackerLogic;
  const SERVER = 'https://mt.example.workers.dev';
  const ID = 'd964b11de5f14520';

  test('a direct pixel URL', () => {
    assert.equal(hasPixel([`${SERVER}/t/${ID}`], SERVER), true);
  });
  test('the same pixel behind Gmail\'s image proxy, with the real URL after the #', () => {
    assert.equal(hasPixel([`https://ci3.googleusercontent.com/meips/AAA#${SERVER}/t/${ID}`], SERVER), true);
  });
  test('other images, other paths and other hosts are not our pixel', () => {
    for (const src of ['https://example.com/logo.png', `${SERVER}/s/${ID}`, `${SERVER}/t/`, `${SERVER}/t/not-hex-id!`,
                       `https://other.example/t/${ID}`, `https://xmt.example.workers.dev/t/${ID}`, '', null, undefined]) {
      assert.equal(hasPixel([src], SERVER), false, String(src));
    }
  });
  test('the dots in a host are literal, and other regex characters are escaped', () => {
    assert.equal(hasPixel([`https://mtXexampleXworkers.dev/t/${ID}`], 'https://mt.example.workers.dev'), false);
    assert.equal(hasPixel([`https://a+b.example/t/${ID}`], 'https://a+b.example'), true);
    assert.equal(hasPixel([`https://aab.example/t/${ID}`], 'https://a+b.example'), false);
  });
  test('the id must end where the pixel URL ends: a non-hex tail is another URL', () => {
    assert.equal(hasPixel([`${SERVER}/t/${ID}zz`], SERVER), false);
    assert.equal(hasPixel([`${SERVER}/t/${ID}?cb=1`], SERVER), true);
  });
  test('found among several images', () => {
    assert.equal(hasPixel(['https://example.com/a.png', `${SERVER}/t/${ID}`], SERVER), true);
  });
  test('no images, or an unusable server address', () => {
    assert.equal(hasPixel([], SERVER), false);
    assert.equal(hasPixel([`${SERVER}/t/${ID}`], 'not a url'), false);
    assert.equal(hasPixel([`${SERVER}/t/${ID}`], ''), false);
  });
});
