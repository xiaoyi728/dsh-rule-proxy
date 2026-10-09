import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { updateVolatile } from '@deepseek-ai/cosmokit';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { RuleFetchProvider } from '../src/provider.js';
import * as plugin from '../src/index.js';

// Hold the provider boundary rather than the wire: socket isolation is covered
// separately. This test targets snapshot ownership and retiring transports.
test('volatile snapshots retain in-flight transport and close it after completion', async t => {
  const ctx = new Context();
  const web = ctx.plugin(WebRuntime, { fetchProvider: 'rule-proxy' });
  await web.await();
  const original = RuleFetchProvider.prototype.fetch;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  RuleFetchProvider.prototype.fetch = async function () {
    entered(this.transport);
    await gate;
    return { snapshotEnabled: this.transport.enabled };
  };
  let fiber;
  t.after(async () => {
    release();
    RuleFetchProvider.prototype.fetch = original;
    if (fiber) await fiber.dispose();
    await web.dispose();
  });
  fiber = ctx.plugin(plugin, {});
  await fiber.await();
  const provider = ctx.web.fetchProviders.get('rule-proxy');
  const old = provider.transport;
  let closeCount = 0;
  const close = old.close.bind(old);
  old.close = async () => { closeCount++; await close(); };
  const pending = provider.fetch({ url: 'https://example.com/' });
  assert.equal(await started, old);
  updateVolatile(fiber.config.enabled, plugin.Config({ enabled: false }).enabled);
  const next = provider.transport;
  assert.notEqual(next, old);
  assert.equal(next.enabled, false);
  assert.equal(closeCount, 0);
  release();
  assert.deepEqual(await pending, { snapshotEnabled: true });
  assert.equal(closeCount, 1);
  await assert.rejects(old.request(new URL('https://example.com/'), {}), error => error.code === 'WEB_PROVIDER_ERROR');
  await fiber.dispose();
  assert.equal(provider.available(), false);
  await assert.rejects(next.request(new URL('https://example.com/'), {}), error => error.code === 'WEB_PROVIDER_ERROR');
});
