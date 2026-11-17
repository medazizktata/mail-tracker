import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Classic content script: it publishes onto globalThis instead of exporting.
await import('../extension/send-signatures.js');
const { signatureFrom, addSignature, removeSignature, sendSelector, looksLikeSend, MAX_SIGNATURES } = globalThis.MailTrackerSend;

describe('learned Send button signatures', () => {
  test('English "Send" is the only built-in, so nothing is guessed for other languages', () => {
    const sel = sendSelector([]);
    assert.match(sel, /\[aria-label\*="Send"\]/);
    assert.match(sel, /\[data-tooltip\*="Send"\]/);
    assert.doesNotMatch(sel, /Envoyer|Enviar|Senden/);
  });

  test('a learned signature matches the label and tooltip exactly', () => {
    const sel = sendSelector([{ label: 'Envoyer', tooltip: 'Envoyer (Ctrl+Entrée)' }]);
    assert.match(sel, /\[aria-label="Envoyer"\]/);
    assert.match(sel, /\[data-tooltip="Envoyer \(Ctrl\+Entrée\)"\]/);
  });

  test('a learned signature with only a tooltip still produces a selector', () => {
    const sel = sendSelector([{ label: '', tooltip: 'Senden' }]);
    assert.match(sel, /\[data-tooltip="Senden"\]/);
    assert.doesNotMatch(sel, /aria-label="/);
  });

  test('quotes, backslashes and newlines in a label cannot break out of the selector', () => {
    const sel = sendSelector([{ label: 'a"b\\c\nd', tooltip: '' }]);
    assert.ok(sel.includes('[aria-label="a\\"b\\\\c\\a d"]'), sel);
  });

  test('signatureFrom trims, and rejects a button with neither label nor tooltip', () => {
    assert.deepEqual(signatureFrom({ label: ' Envoyer ', tooltip: '' }), { label: 'Envoyer', tooltip: '' });
    assert.equal(signatureFrom({ label: '  ', tooltip: undefined }), null);
    assert.equal(signatureFrom({}), null);
  });

  test('adding the same signature twice keeps one', () => {
    const s = { label: 'Envoyer', tooltip: '' };
    assert.equal(addSignature(addSignature([], s), { ...s }).length, 1);
  });

  test('the list is capped and drops the oldest first', () => {
    let list = [];
    for (let i = 0; i < MAX_SIGNATURES + 3; i++) list = addSignature(list, { label: `L${i}`, tooltip: '' });
    assert.equal(list.length, MAX_SIGNATURES);
    assert.equal(list[0].label, 'L3');
    assert.equal(list.at(-1).label, `L${MAX_SIGNATURES + 2}`);
  });

  test('removeSignature undoes a learn and leaves the others', () => {
    const a = { label: 'A', tooltip: '' }, b = { label: 'B', tooltip: '' };
    assert.deepEqual(removeSignature([a, b], a), [b]);
  });

  test('inputs are not mutated', () => {
    const list = Object.freeze([Object.freeze({ label: 'A', tooltip: '' })]);
    addSignature(list, { label: 'B', tooltip: '' });
    removeSignature(list, { label: 'A', tooltip: '' });
  });
});

describe('recognising Send by the shape of its shortcut, in any language', () => {
  const label = s => ({ label: s, tooltip: '' });

  test('the real label seen in French Gmail on a Mac, bidi marks included', () => {
    assert.equal(looksLikeSend(label('Envoyer \u202a(⌘Enter)\u202c')), true);
  });

  test('other Send labels: English, other languages, other modifiers', () => {
    for (const s of ['Send (Ctrl-Enter)', 'Send (Ctrl+Enter)', 'Envoyer (Ctrl+Entrée)', 'Senden (Strg+Eingabetaste)',
                     'Enviar (⌘Intro)', 'Send + Archive (Ctrl+Shift+Enter)']) {
      assert.equal(looksLikeSend(label(s)), true, s);
    }
  });

  test('the tooltip counts as well as the label', () => {
    assert.equal(looksLikeSend({ label: '', tooltip: 'Envoyer (⌘Enter)' }), true);
  });

  test('every other compose button is rejected: single-key shortcuts and no shortcut', () => {
    for (const s of ['Annuler (⌘Z)', 'Rétablir (⌘Y)', 'Gras (⌘B)', 'Insérer un lien (⌘K)', 'Liste à puces (⌘⇧8)',
                     'Add Cc recipients (Ctrl+Shift+C)', 'Ajouter Cc (Ctrl+Maj+C)', 'Joindre des fichiers',
                     "Plus d'options d'envoi", 'Aa', '', 'Envoyer']) {
      assert.equal(looksLikeSend(label(s)), false, s);
    }
  });

  test('a bare key with no modifier is not Send (chat boxes use plain Enter)', () => {
    assert.equal(looksLikeSend(label('Send (Enter)')), false);
  });

  test('missing attributes are handled', () => {
    assert.equal(looksLikeSend({}), false);
    assert.equal(looksLikeSend({ label: null, tooltip: undefined }), false);
  });
});
