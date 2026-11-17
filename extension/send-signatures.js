// Gmail localises the Send button's label, so no list of translations written
// from memory can be trusted. Instead the extension learns the button from the
// user's own Gmail: they click it once while a compose window is open (the click
// is swallowed, nothing is sent) and its real aria-label and tooltip are stored.
// Only Gmail's default language, English, is built in.
//
// Loaded before gmail.js as a classic content script, so it publishes onto
// globalThis. Everything here is pure so it can be tested without a browser.
(function (root) {
  const MAX_SIGNATURES = 5;
  const BUILTIN = ['Send'];

  // A CSS string: escape the quote and backslash, and a newline as \a.
  const quote = v => `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;

  // What the page itself calls the button, in the user's language.
  function signatureFrom(attrs) {
    const label = String(attrs.label || '').trim();
    const tooltip = String(attrs.tooltip || '').trim();
    return label || tooltip ? { label, tooltip } : null;
  }

  const same = (a, b) => a.label === b.label && a.tooltip === b.tooltip;

  function addSignature(list, sig) {
    if (list.some(s => same(s, sig))) return [...list];
    return [...list, { ...sig }].slice(-MAX_SIGNATURES);
  }

  function removeSignature(list, sig) {
    return list.filter(s => !same(s, sig));
  }

  function sendSelector(learned = []) {
    const parts = [];
    for (const w of BUILTIN) {
      parts.push(`div[role="button"][aria-label*=${quote(w)}]`, `div[role="button"][data-tooltip*=${quote(w)}]`);
    }
    for (const s of learned) {
      if (s.label) parts.push(`div[role="button"][aria-label=${quote(s.label)}]`);
      if (s.tooltip) parts.push(`div[role="button"][data-tooltip=${quote(s.tooltip)}]`);
    }
    return parts.join(', ');
  }

  root.MailTrackerSend = { MAX_SIGNATURES, signatureFrom, addSignature, removeSignature, sendSelector };
})(globalThis);
