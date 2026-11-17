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

  root.MailTrackerLogic = { recipientsOf, isSentRow, findMatchingTracker, indicatorRetryDelay };
})(globalThis);
