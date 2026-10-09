import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { getGlobalDispatcher } from 'undici';

// Native Loader/Include, ConfigEditor, SettingsForms and persistent profile
// patch. No app server, home profile, global proxy or real credential is used.
test('native settings host serves volatile config, persists edits and preserves redacted secrets', async t => {
  const env = { ...process.env };
  const globalFetch = globalThis.fetch;
  const dispatcher = getGlobalDispatcher();
  const prefix = join(tmpdir(), 'dsh-rule-proxy-settings-');
  const dir = await mkdtemp(prefix);
  let ctx = new Context();
  let loaderFiber;
  const stop = async () => {
    if (ctx.loader) for (const entry of [...ctx.loader.entries()].reverse()) {
      if (entry.fiber) await entry.fiber.dispose();
    }
    if (loaderFiber) await loaderFiber.dispose();
  };
  t.after(async () => {
    await stop();  // Delete only our newly created, verified temporary fixture directory.
    const target = await realpath(dir);
    assert.equal(target, resolve(dir));
    assert.ok(target.startsWith(prefix));
    await rm(target, { recursive: true, force: true });
  });
  const manifest = join(dir, 'package.json');
  const patchPath = join(dir, 'cordis.patch.yml');
  const basePath = join(dir, 'cordis.yml');
  const token = 'fixture-credential-not-a-real-secret';
  const modulePath = specifier => fileURLToPath(import.meta.resolve(specifier));
  const rows = [
    { id: 'web', name: modulePath('@deepseek-ai/dsh-web'), config: { fetchProvider: 'rule-proxy' } },
    { id: 'config-editor', name: modulePath('@deepseek-ai/dsh-config-editor') },
    { id: 'settings', name: modulePath('@deepseek-ai/dsh-settings') },
    { id: 'rule-proxy', name: fileURLToPath(new URL('../src/index.js', import.meta.url)), config: { proxyToken: token } },
  ];
  await writeFile(manifest, JSON.stringify({ name: 'isolated-test-profile', private: true, dsh: { profile: { bundles: [] } } }));
  await writeFile(basePath, '[]\n');
  await writeFile(patchPath, JSON.stringify([{ insert: rows }, { id: 'rule-proxy', config: { proxyToken: token } }]));
  const profile = {
    name: 'isolated-test-profile', dir, home: join(dir, 'empty-home'), cwd: dir, patchPath,
    installAnchor: manifest, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  };
  const boot = async () => {
    ctx.provide('profileContext', profile);
    loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(basePath).href });
    await loaderFiber.await();
    await mountRootInclude(ctx, basePath, readProfilePatches('test', profile));
    await ctx.loader.await();
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await();
  };
  await boot();
  const describe = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'rule-proxy');
  const descriptor = describe();
  assert.ok(descriptor, 'settings must expose the real root volatile namespace');
  assert.equal(descriptor.value.enabled, true);
  assert.equal(descriptor.value.rules.length, 12);
  assert.ok(!JSON.stringify(descriptor).includes(token));
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'rule-proxy');
  const originalFiber = entry.fiber;
  const originalProvider = ctx.web.fetchProviders.get('rule-proxy');
  const oldTransport = originalProvider.transport;
  await ctx.settings.mutate('rule-proxy', [{ op: 'set', path: ['enabled'], value: false }], descriptor.revision);
  assert.equal(entry.fiber, originalFiber);
  const updatedProvider = ctx.web.fetchProviders.get('rule-proxy');
  assert.equal(updatedProvider.transport.enabled, false);
  assert.notEqual(updatedProvider.transport, oldTransport);
  assert.equal(entry.fiber.config.proxyToken.get(), token);
  assert.equal(describe().value.enabled, false);
  assert.ok((await readFile(patchPath, 'utf8')).includes('enabled: false'));
  const revision = describe().revision;
  await assert.rejects(ctx.settings.mutate('rule-proxy', [{ op: 'set', path: ['enabled'], value: true }], descriptor.revision), error => error.code === 'SETTINGS_CONFLICT');
  await assert.rejects(ctx.settings.mutate('rule-proxy', [{ op: 'set', path: ['rules'], value: [{ include: 'include', type: 'regex', title: 'invalid', pattern: '(', active: true }] }], revision));
  assert.equal(describe().revision, revision);
  assert.equal(ctx.web.fetchProviders.get('rule-proxy').transport.enabled, false);
  assert.equal(entry.fiber.config.rules.get().length, 12);
  assert.equal(entry.fiber.config.proxyToken.get(), token);
  await ctx.settings.mutate('rule-proxy', [{ op: 'set', path: ['searxEndpoint'], value: 'https://search.example/search' }], revision);
  assert.equal(ctx.web.searchProviders.get('rule-proxy-searxng').available(), true);
  assert.equal(entry.fiber, originalFiber);
  const rules = describe().value.rules.map((rule, index) => index === 0 ? { ...rule, active: false } : rule);
  await ctx.settings.mutate('rule-proxy', [{ op: 'set', path: ['rules'], value: rules }], describe().revision);
  const retired = ctx.web.fetchProviders.get('rule-proxy');
  await stop();
  assert.equal(retired.available(), false);
  ctx = new Context();
  await boot();
  assert.equal(describe().value.enabled, false);
  assert.equal(describe().value.searxEndpoint, 'https://search.example/search');
  assert.ok(!JSON.stringify(describe()).includes(token));
  const restored = ctx.configEditor.entries().find(row => row.options.id === 'rule-proxy');
  assert.equal(restored.fiber.config.proxyToken.get(), token);
  assert.deepEqual(describe().value.rules, rules);
  assert.deepEqual({ ...process.env }, env);
  assert.equal(globalThis.fetch, globalFetch);
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.equal(ctx.web.fetchProviders.get('rule-proxy').transport.enabled, false);
  assert.equal(ctx.web.searchProviders.get('rule-proxy-searxng').available(), true);
});
