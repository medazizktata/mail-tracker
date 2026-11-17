// Decision logic for the Gmail content script, kept apart from the DOM so it can be tested
// without a browser. Loaded before gmail.js as a classic content script, so it publishes
// onto globalThis.
(function (root) {
  // A tracker's recipient label is one address, or several joined with ", ".
  const recipientsOf = label => String(label || '').split(',').map(s => s.trim()).filter(Boolean);

  // In the Sent list Gmail puts a localised prefix ("To:", "À :", ...) in front of the
  // recipients, while an inbox row starts straight with the sender's name. Gmail's rows can be
  // the inbox's for a moment after the hash changes to #sent, so require "some prefix" rather
  // than a specific word.
  function isSentRow(fieldText, firstRecipientText) {
    const first = String(firstRecipientText || '');
    return first.length > 0 && String(fieldText || '').indexOf(first) >= 1;
  }

  // The tracker for a row in the Sent list: the newest one for that recipient whose subject
  // appears in the row's subject. A tracker without a subject matches on recipient alone.
  // There is deliberately no "any tracker for this recipient" fallback: it put the newest
  // tracker's read status on every earlier mail to the same person.
  function findMatchingTracker(trackers, email, identifiers) {
    const subject = (identifiers && identifiers.subject) || '';
    const who = String(email || '').toLowerCase();
    const matches = trackers.filter(t =>
      recipientsOf(t.recipient).some(r => r.toLowerCase() === who) &&
      (!t.subject || subject.includes(t.subject)));
    if (!matches.length) return null;
    return matches.reduce((best, t) => (new Date(t.createdAt) > new Date(best.createdAt) ? t : best));
  }

  // Gmail swaps the list a moment after the hash changes to #sent, so the first pass can still see the
  // inbox rows (seen live: 110 inbox rows, then nothing drawn). Run the pass again until Sent rows are
  // on screen, a bounded number of times. `drawn` is how many Sent rows the last pass saw, or
  // null/undefined if it could not run at all (not configured), in which case there is nothing to retry.
  const MAX_INDICATOR_ATTEMPTS = 8;
  const INDICATOR_RETRY_MS = 1500;
  function indicatorRetryDelay(attempt, drawn) {
    if (drawn === null || drawn === undefined || drawn > 0) return null;
    return attempt < MAX_INDICATOR_ATTEMPTS ? INDICATOR_RETRY_MS : null;
  }

  // Why a message cannot carry a pixel, or null. Gmail's plain-text mode has no HTML body to put one in;
  // without this the content script finds no body and the mail goes out untracked, saying nothing.
  function pixelBlocker({ bodyCount, bodyTag }) {
    if (!bodyCount) return 'no-body';
    if (String(bodyTag).toUpperCase() === 'TEXTAREA') return 'plain-text';
    return null;
  }

  // Links worth tracking in a message body: http and https only, normalised, deduplicated, never our own
  // worker (the pixel, or a link that is already tracked), capped. The worker validates again.
  const MAX_TRACKED_LINKS = 20;
  const MAX_TRACKED_LINK_LENGTH = 2000;
  function collectLinks(hrefs, workerHost) {
    const out = [];
    for (const raw of hrefs) {
      let u;
      try { u = new URL(raw); } catch { continue; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      if (u.host === workerHost || u.username || u.password) continue;
      if (u.href.length > MAX_TRACKED_LINK_LENGTH) continue;
      if (!out.includes(u.href)) out.push(u.href);
      if (out.length === MAX_TRACKED_LINKS) break;
    }
    return out;
  }

  // Does a message body already carry our pixel? Matched on the image's address, because Gmail strips the
  // data-* attribute we add (seen in the raw source of a sent mail). In a reopened draft the address may be
  // behind Gmail's image proxy, with the real URL after a "#".
  function hasPixel(srcs, serverUrl) {
    let host;
    try { host = new URL(serverUrl).host; } catch { return false; }
    const re = new RegExp('https?://' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/t/[0-9a-f]{8,32}(?:$|[?#&/])');
    return srcs.some(s => re.test(String(s || '')));
  }

  // The address Gmail shows in the tab title ("Inbox (3) - me@example.com - Gmail"), so the popup can reopen a
  // mail in the right account when several are signed in. A pop-out compose window has no such title.
  function gmailAccount(title) {
    const m = /[-\u2013]\s*([^\s@]+@[^\s@]+\.[^\s@]+)\s*[-\u2013]\s*Gmail\s*$/.exec(String(title || ''));
    return m ? m[1] : null;
  }

  // A tracker keeps no Gmail message id, only recipient and subject, so "open the mail" is a Gmail search
  // in Sent. The worker stores the subject cut at 80 characters, so drop a word that may be cut in half.
  const STORED_SUBJECT_LIMIT = 80;
  function gmailSearchUrl({ account, recipient, subject }) {
    let words = String(subject || '').replace(/["\\]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (String(subject || '').length >= STORED_SUBJECT_LIMIT && words.length > 1) words.pop();
    const query = ['in:sent'];
    const to = recipientsOf(recipient)[0];
    if (to) query.push('to:' + to.replace(/\s/g, ''));
    if (words.length) query.push('subject:"' + words.join(' ') + '"');
    return 'https://mail.google.com/mail/' + (account ? '?authuser=' + encodeURIComponent(account) : '') +
      '#search/' + encodeURIComponent(query.join(' '));
  }

  root.MailTrackerLogic = { recipientsOf, isSentRow, findMatchingTracker, indicatorRetryDelay, pixelBlocker, collectLinks, hasPixel, gmailAccount, gmailSearchUrl };
})(globalThis);
