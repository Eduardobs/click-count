import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../theme.js', import.meta.url), 'utf8');
function setup({ saved = null, dark = false, blocked = false } = {}) {
  const listeners = {};
  const button = { setAttribute: (_, value) => { button.pressed = value; }, addEventListener: (_, fn) => { button.click = fn; } };
  const meta = {};
  const root = { dataset: {} };
  let stored = saved;
  vm.runInNewContext(source, {
    window: { matchMedia: () => ({ matches: dark, addEventListener: (_, fn) => { listeners.system = fn; } }) },
    document: { documentElement: root, querySelector: selector => selector.startsWith('meta') ? meta : button, addEventListener: (_, fn) => { listeners.ready = fn; } },
    localStorage: { getItem: () => { if (blocked) throw Error(); return saved; }, setItem: (_, value) => { if (blocked) throw Error(); stored = value; } },
  });
  listeners.ready();
  return { root, button, meta, listeners, stored: () => stored };
}

test('saved choice overrides the system and toggles persist across reloads', () => {
  const page = setup({ saved: 'light', dark: true });
  assert.equal(page.root.dataset.theme, 'light');
  page.button.click();
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.button.pressed, 'true');
  assert.equal(page.meta.content, '#17211c');
  page.listeners.system({ matches: false });
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(setup({ saved: page.stored() }).root.dataset.theme, 'dark');
  page.button.click();
  assert.equal(page.button.pressed, 'false');
  assert.equal(page.meta.content, '#f7f8f5');
});

test('system preference is followed until a manual choice, including blocked storage', () => {
  const page = setup({ dark: true, blocked: true });
  assert.equal(page.root.dataset.theme, 'dark');
  page.listeners.system({ matches: false });
  assert.equal(page.root.dataset.theme, 'light');
  page.button.click();
  page.listeners.system({ matches: false });
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(setup({ saved: 'invalid' }).root.dataset.theme, 'light');
});
