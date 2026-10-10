import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../src/rules.js';
import * as plugin from '../src/index.js';
import rules from '../rules.json' with { type: 'json' };

// re2-wasm keeps every compiled pattern in a fixed 16 MiB WASM heap and offers
// no way to free an instance. Compiling the same patterns over and over (every
// settings read and transport rebuild did exactly that) exhausts the heap and
// aborts every later RE2 operation with "Cannot enlarge memory arrays", which
// took down all web tools. These budgets are far above what once killed the
// process (~5500 live instances) and must stay allocation-free.
test('repeated engine construction never exhausts the re2-wasm heap', () => {
  for (let i = 0; i < 3000; i++) {
    const engine = new RuleEngine(rules);
    assert.equal(engine.explain('https://github.com/morluto/rea').route, 'proxy');
  }
});

test('repeated plugin create() calls keep routing decisions working', () => {
  for (let i = 0; i < 1000; i++) {
    const instance = plugin.create({});
    assert.equal(instance.engine.explain('https://raw.githubusercontent.com/x/y').route, 'proxy');
    assert.equal(instance.engine.explain('https://example.com/').route, 'direct');
  }
});

test('rules snapshot is a stable frozen instance', () => {
  const engine = new RuleEngine(rules);
  assert.equal(engine.rules, engine.rules);
  assert.ok(Object.isFrozen(engine.rules));
  assert.ok(engine.rules.every(rule => Object.isFrozen(rule)));
  assert.deepEqual(engine.rules, rules);
});
