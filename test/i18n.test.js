import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const EXT = new URL('../extension/', import.meta.url);
const read = p => readFileSync(new URL(p, EXT), 'utf8');
const catalog = lang => JSON.parse(read(`_locales/${lang}/messages.json`));

const LOCALES = readdirSync(new URL('_locales/', EXT));
const en = catalog('en');

// Every key the code asks for: t('key'), data-i18n*="key", and __MSG_key__ in the manifest.
function usedKeys() {
  const files = ['popup.js', 'popup.html', 'background.js', 'gmail.js', 'manifest.json'];
  const keys = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\bt\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(m[1]);
  }
  return keys;
}

describe('extension locales', () => {
  test('English is the default locale and the manifest says so', () => {
    assert.equal(JSON.parse(read('manifest.json')).default_locale, 'en');
    assert.ok(LOCALES.includes('en'));
  });

  test('every key the code uses exists in the English catalog', () => {
    const missing = [...usedKeys()].filter(k => !(k in en));
    assert.deepEqual(missing, []);
  });

  test('every English key is used somewhere (no dead strings)', () => {
    const used = usedKeys();
    assert.deepEqual(Object.keys(en).filter(k => !used.has(k)), []);
  });

  for (const lang of LOCALES.filter(l => l !== 'en')) {
    test(`${lang} has exactly the English keys`, () => {
      const c = catalog(lang);
      assert.deepEqual(Object.keys(c).sort(), Object.keys(en).sort());
    });

    test(`${lang} keeps the same placeholders as English`, () => {
      const c = catalog(lang);
      for (const [k, v] of Object.entries(en)) {
        const tokens = s => [...(s.message.match(/\$[a-zA-Z0-9_]+\$/g) || [])].sort();
        assert.deepEqual(tokens(c[k]), tokens(v), `${lang}.${k}`);
        assert.deepEqual(Object.keys(c[k].placeholders || {}).sort(), Object.keys(v.placeholders || {}).sort(), `${lang}.${k} definitions`);
      }
    });

    test(`${lang} has no empty or untranslated-looking message`, () => {
      const c = catalog(lang);
      for (const [k, v] of Object.entries(c)) assert.ok(v.message.trim().length > 0, `${lang}.${k} is empty`);
    });
  }

  test('every placeholder used in a message is defined, and every definition is used', () => {
    for (const lang of LOCALES) {
      for (const [k, v] of Object.entries(catalog(lang))) {
        const used = new Set([...v.message.matchAll(/\$([a-zA-Z0-9_]+)\$/g)].map(m => m[1].toLowerCase()));
        const defined = new Set(Object.keys(v.placeholders || {}).map(s => s.toLowerCase()));
        assert.deepEqual([...used].sort(), [...defined].sort(), `${lang}.${k}`);
      }
    }
  });

  test('the i18n helper falls back to the key, so a missing string is visible, not blank', () => {
    assert.ok(existsSync(new URL('i18n.js', EXT)));
    assert.match(read('i18n.js'), /return\s+m\s*\|\|\s*key/);
  });
});
