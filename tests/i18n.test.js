import test from 'node:test';
import assert from 'node:assert/strict';
import { translations, applyLanguage, getLanguage, t, formatCount, setText, setLiteralText } from '../i18n.js';

const root = {
  documentElement: {},
  querySelectorAll: () => [],
  querySelector: () => ({}),
};

test('all languages cover the same translation keys', () => {
  const keys = Object.keys(translations.en).sort();
  for (const catalog of Object.values(translations)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys);
    assert.ok(Object.values(catalog).every(value => value.trim()));
  }
});

test('language changes update existing messages and preserve literal user names', () => {
  assert.equal(getLanguage(), 'en');
  const message = {};
  setText(message, 'queuedMany', { count: '2' });
  assert.equal(message.textContent, '2 clicks queued');
  applyLanguage('pt-BR', root);
  assert.equal(message.textContent, '2 cliques na fila');
  assert.equal(root.documentElement.lang, 'pt-BR');
  applyLanguage('es', root);
  assert.equal(message.textContent, '2 clics en la cola');
  setText(message, '');
  applyLanguage('en', root);
  assert.equal(message.textContent, '');
  setText(message, 'Minha conta');
  setLiteralText(message, 'Alice');
  applyLanguage('pt-BR', root);
  assert.equal(message.textContent, 'Alice');
  assert.equal(formatCount('12345678901234567890'), '12.345.678.901.234.567.890');
  applyLanguage('unsupported', root);
  assert.equal(getLanguage(), 'en');
  assert.equal(formatCount('1234'), '1,234');
  assert.equal(t('Entrar'), 'Sign in');
});
