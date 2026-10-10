import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The client half reads and writes configuration through the host endpoint at
// /dsh-rule-proxy/api. The browser fixture (test/browser.mjs) covers the real
// React interaction; these cases pin the module contract: registration id,
// single injection requirement, and the endpoint it talks to.
function load() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {}, useRef: () => ({ current: null }),
    useSyncExternalStore: () => ({ status: 'loading', value: undefined, writable: false, error: '' }),
    useCallback: fn => fn,
  };
  const registrations = [];
  const requests = [];
  let module;
  const context = {
    window: { __ModuleLoader__: { load: definition => {
      module = definition.factory(name => { assert.equal(name, 'react'); return React; });
    } } },
    URL, Blob, Worker: class {}, setTimeout, clearTimeout, console,
    fetch: async (path, options) => { requests.push({ path, options }); return { json: async () => ({ ok: false, error: 'not ready' }) }; },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context);
  return {
    module,
    requests,
    register: ctx => module.apply(ctx),
    registrations,
  };
}

test('client registers the header capsule and the settings section and requires only slots', () => {
  const fixture = load();
  assert.deepEqual([...fixture.module.inject], ['slots']);
  fixture.register({
    slots: { inject: (name, fn) => {
      assert.ok(['conversation.session.header.utilities', 'settings.section'].includes(name));
      return fn();
    }, register: options => { fixture.registrations.push(options); return () => {}; } },
  });
  assert.equal(fixture.registrations.length, 2);
  assert.deepEqual(fixture.registrations.map(entry => entry.name), ['conversation.session.header.utilities', 'settings.section']);
  assert.ok(fixture.registrations.every(entry => entry.id === 'dsh-rule-proxy'));
  assert.equal(typeof fixture.registrations[1].label, 'string');
});

test('client reads configuration from the host endpoint and never handles the secret', () => {
  const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(source, /const API_BASE = '\/dsh-rule-proxy\/api'/);
  assert.match(source, /fetchJson\('\/config'\)/);
  // proxyToken is a write-only secret the host never returns.
  assert.doesNotMatch(source, /config\.proxyToken/);
});
