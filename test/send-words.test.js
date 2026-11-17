import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The extension file is a classic script (it is loaded as a Gmail content script),
// so it publishes onto globalThis instead of exporting.
await import('../extension/send-words.js');
const { sendWordsFor, sendSelector, table } = globalThis.MailTrackerSend;

describe('Send button wording by interface language', () => {
  test('French interface matches the French word and still the English one', () => {
    const words = sendWordsFor('fr');
    assert.ok(words.includes('Envoyer'));
    assert.ok(words.includes('Send'));
  });

  test('a regional or upper-case tag resolves to its language', () => {
    assert.deepEqual(sendWordsFor('fr-CA'), sendWordsFor('fr'));
    assert.deepEqual(sendWordsFor('FR'), sendWordsFor('fr'));
    assert.deepEqual(sendWordsFor('pt-BR'), sendWordsFor('pt'));
  });

  test('an unknown or missing language falls back to English only', () => {
    assert.deepEqual(sendWordsFor('xx'), ['Send']);
    assert.deepEqual(sendWordsFor(''), ['Send']);
    assert.deepEqual(sendWordsFor(undefined), ['Send']);
  });

  test('English is always accepted, whatever the language', () => {
    for (const lang of Object.keys(table)) assert.ok(sendWordsFor(lang).includes('Send'), lang);
  });

  test('every word is safe to put inside a CSS attribute selector', () => {
    for (const [lang, words] of Object.entries(table)) {
      for (const w of words) assert.match(w, /^[^"'\\\[\]]+$/, `${lang}: ${w}`);
    }
  });

  test('the selector checks both aria-label and data-tooltip for each word', () => {
    const sel = sendSelector('fr');
    assert.match(sel, /\[aria-label\*="Envoyer"\]/);
    assert.match(sel, /\[data-tooltip\*="Envoyer"\]/);
    assert.match(sel, /\[aria-label\*="Send"\]/);
  });
});
