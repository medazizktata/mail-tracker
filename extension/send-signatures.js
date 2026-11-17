// Gmail localises the Send button's label, so no list of translations written
// from memory can be trusted. Send is recognised by the shape of the shortcut Gmail
// appends to its label (see looksLikeSend), which needs no table and no user action.
// For a label without such a shortcut, English "Send" is built in and the user can
// teach the extension once: they click the button while a compose window is open
// (the click is swallowed, nothing is sent) and its real label is stored.
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

  // Gmail appends the keyboard shortcut to the Send button's label: "Envoyer (⌘Enter)",
  // "Send (Ctrl-Enter)". The words are translated but the shape is not: every other compose
  // button's shortcut ends in a single character (⌘Z, Ctrl+Shift+C), while Send's ends in a
  // named key after at least one modifier. So Send can be recognised in any language without a
  // table of translations. Gmail wraps the shortcut in invisible bidi marks, which are removed.
  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const MODIFIER = /^(?:[⌘⌃⌥⇧]|ctrl|control|cmd|command|strg|alt|option|opt|shift|maj)[\s+\-]*/i;

  function shortcutKey(text) {
    const m = String(text || '').replace(BIDI, '').trim().match(/\(([^()]*)\)\s*$/);
    if (!m) return null;
    let rest = m[1].trim();
    let modifiers = 0;
    for (let mm = rest.match(MODIFIER); mm; mm = rest.match(MODIFIER)) {
      rest = rest.slice(mm[0].length);
      modifiers++;
    }
    return modifiers ? rest : null; // a shortcut needs a modifier; a bare "Enter" is a chat box
  }

  function looksLikeSend(attrs) {
    return [attrs.label, attrs.tooltip].some(text => /^\p{L}{4,}$/u.test(shortcutKey(text) || ''));
  }

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

  root.MailTrackerSend = { MAX_SIGNATURES, signatureFrom, addSignature, removeSignature, sendSelector, looksLikeSend };
})(globalThis);
