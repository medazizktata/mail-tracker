// Gmail localises the Send button's aria-label and data-tooltip, so the content
// script has to know the word for the interface language. Gmail publishes that
// language on <html lang>. Loaded before gmail.js as a classic content script, so
// it publishes onto globalThis.
//
// The words below are from memory of Gmail's interface, not read from the live
// page. A wrong or missing entry is not silent: gmail.js shows a banner when a
// compose window has no Send button it recognises. English is always accepted.
(function (root) {
  const table = {
    en: ['Send'], fr: ['Envoyer'], es: ['Enviar'], pt: ['Enviar'], de: ['Senden'],
    it: ['Invia'], nl: ['Verzenden'], sv: ['Skicka'], da: ['Send'], no: ['Send'], nb: ['Send'],
    fi: ['Lähetä'], pl: ['Wyślij'], cs: ['Odeslat'], ru: ['Отправить'], uk: ['Надіслати'],
    tr: ['Gönder'], ar: ['إرسال'], he: ['שליחה'], ja: ['送信'], ko: ['보내기'],
    zh: ['发送', '發送'], hi: ['भेजें'], id: ['Kirim'], vi: ['Gửi'],
  };

  function sendWordsFor(lang) {
    const primary = String(lang || '').toLowerCase().split(/[-_]/)[0];
    return [...new Set([...(table[primary] || []), 'Send'])];
  }

  function sendSelector(lang) {
    return sendWordsFor(lang)
      .flatMap(w => [`div[role="button"][aria-label*="${w}"]`, `div[role="button"][data-tooltip*="${w}"]`])
      .join(', ');
  }

  // Structural fallback for languages missing from the table: the compose Send
  // button carries the .aoO class (from memory of Gmail's markup, not verified).
  const fallbackSelector = 'div[role="button"].aoO';

  root.MailTrackerSend = { table, sendWordsFor, sendSelector, fallbackSelector };
})(globalThis);
