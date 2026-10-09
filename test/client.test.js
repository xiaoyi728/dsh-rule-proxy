import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const states = [];
  let cursor = 0, contribution, component, module;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useEffect() {}, useRef: () => ({ current: null }),
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => { module = definition.factory(name => { assert.equal(name, 'react'); return React; }); } } },
    URL, Blob, setTimeout, clearTimeout,
  });
  const mutations = [];
  const snapshot = { status: 'ready', writable: true, revision: 7, value: { enabled: true, proxyUrl: '', searxEndpoint: '', rules: [] } };
  const form = { subscribe() {}, getSnapshot: () => snapshot, mutate: async (ops, revision) => { mutations.push({ ops, revision }); return true; } };
  module.apply({
    effect: fn => fn(),
    configForms: { get: id => { assert.equal(id, 'rule-proxy'); return form; }, whileServed: (_ids, fn) => fn() },
    slots: { inject: (_name, fn) => fn(), register: (options, page) => { contribution = options; component = page; return () => {}; } },
  });
  return { snapshot, mutations, render(view = 'detail') { cursor = 0; return component({ view, ...contribution.inject() }); } };
}
function nodes(tree) { return [tree, ...(tree?.children ?? []).flatMap(child => typeof child === 'object' && child ? nodes(child) : [])]; }

test('client stages JSON import and saves only nonsecret fields with original revision', async () => {
  const f = fixture();
  assert.equal(f.render('summary'), '工具规则代理');
  const file = nodes(f.render()).find(n => n.props.type === 'file');
  const rules = [{ include: 'include', type: 'regex', title: 'GitHub', pattern: 'github', active: true }];
  await file.props.onChange({ target: { value: 'fixture.json', files: [{ size: 100, text: async () => JSON.stringify(rules) }] } });
  assert.equal(f.mutations.length, 0);
  f.snapshot.revision = 8;
  const save = nodes(f.render()).find(n => n.type === 'button' && n.children[0] === '保存');
  await save.props.onClick();
  assert.equal(f.mutations[0].revision, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(f.mutations[0].ops.find(op => op.path[0] === 'rules').value)), rules);
  assert.equal(f.mutations[0].ops.some(op => op.path[0] === 'proxyToken'), false);
});

test('client rejects oversized import and disables writes in readonly deployments', async () => {
  const f = fixture();
  await nodes(f.render()).find(n => n.props.type === 'file').props.onChange({ target: { value: '', files: [{ size: 300000 }] } });
  assert.ok(nodes(f.render()).some(n => n.props.role === 'alert'));
  assert.equal(f.mutations.length, 0);
  f.snapshot.writable = false;
  assert.equal(nodes(f.render()).find(n => n.props.type === 'file').props.disabled, true);
});
