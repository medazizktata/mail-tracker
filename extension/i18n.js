// Thin wrapper over chrome.i18n. Strings live in _locales/<lang>/messages.json;
// Chrome picks the catalog from the browser's UI language and falls back to the
// default_locale (en). A missing key returns the key itself, so a gap is visible
// on screen instead of rendering blank.
//
// Loaded as a classic script (popup page, content script, service worker via
// importScripts), so it publishes onto globalThis.
(function (root) {
  function t(key, subs) {
    const m = chrome.i18n.getMessage(key, subs);
    return m || key;
  }

  // Fill static markup: data-i18n sets text, data-i18n-<attr> sets that attribute.
  function applyI18n(scope = document) {
    scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      scope.querySelectorAll(`[data-i18n-${attr}]`).forEach(el => {
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
      });
    }
  }

  // BCP-47 tag for date and number formatting, so they follow the UI language too.
  const uiLocale = () => chrome.i18n.getUILanguage();

  root.MailTrackerI18n = { t, applyI18n, uiLocale };
})(globalThis);
