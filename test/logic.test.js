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
