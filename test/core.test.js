import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import * as plugin from '../src/index.js';
import { RuleEngine } from '../src/rules.js';
import { resolvePublicAddresses, isPublicIpAddress } from '../src/public-network.js';
import { GitHubTools } from '../src/github.js';

const rule = { include: 'include', type: 'regex', title: 'GitHub', pattern: '.*github.*', active: true };

test('rules normalize hostname, ignore paths, retain original fields and update atomically', () => {
  const engine = new RuleEngine([rule]);
  assert.equal(engine.explain('https://GITHUB.COM./x').route, 'proxy');
  assert.equal(engine.explain('https://example.com/github').route, 'direct');
  assert.equal(engine.explain('https://notgithub.example.com').route, 'proxy');
  assert.equal(engine.explain('https://github.com', { source: 'model' }).route, 'unmanaged');
  assert.equal(engine.explain('https://github.com', { enabled: false }).route, 'direct');
  assert.throws(() => engine.replace([{ ...rule, pattern: '(a)\\1' }]));
  assert.deepEqual(engine.rules, [rule]);
  engine.replace([{ ...rule, active: false }]);
  assert.equal(engine.explain('https://github.com').route, 'direct');
  assert.throws(() => engine.replace([{ ...rule, extra: true }]));
  assert.throws(() => engine.replace([{ ...rule, include: 'exclude' }]));
  assert.throws(() => engine.explain('https://user:pass@github.com'));
  assert.throws(() => engine.explain('file:///etc/passwd'));
  // RE2 handles nested quantifiers without backtracking.
  assert.equal(new RuleEngine([{ ...rule, pattern: '(a+)+$' }]).explain(`https://${'a'.repeat(200)}b.com`).route, 'direct');
});

test('configuration defaults and invalid updates validate before activation', () => {
  assert.equal(plugin.Config({}).rules.get().length, 12);
  for (const input of [{ timeoutMs: -1 }, { maxRedirects: 21 }, { proxyUrl: 'socks5://localhost:1' }, { proxyToken: 'x\r\ny' }, { rules: [{ ...rule, pattern: '(' }] }]) assert.throws(() => plugin.Config(input));
});

test('Cordis provider registers, reloads and disposes without global changes', async () => {
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  const ctx = new Context();
  const web = ctx.plugin(WebRuntime, { fetchProvider: 'rule-proxy' });
  await web.await();
  const fiber = ctx.plugin(plugin, {});
  await fiber.await();
  const first = ctx.web.fetchProviders.get('rule-proxy');
  const firstTransport = first.transport;
  assert.ok(first);
  assert.throws(() => fiber.update({ rules: [{ ...rule, pattern: '(' }] }));
  assert.equal(ctx.web.fetchProviders.get('rule-proxy'), first);
  fiber.update({ enabled: false });
  await fiber.await();
  // Bare Cordis update restarts; the native config editor handles volatile
  // writes separately. A restarted provider must still release old resources.
  const next = ctx.web.fetchProviders.get('rule-proxy');
  assert.notEqual(next, first);
  assert.notEqual(next.transport, firstTransport);
  assert.equal(next.transport.enabled, false);
  await fiber.dispose();
  assert.equal(ctx.web.fetchProviders.has('rule-proxy'), false);
  assert.deepEqual({ ...process.env }, env);
  assert.equal(globalThis.fetch, fetch);
  await web.dispose();
});

test('public DNS rejects mixed answers, private literals and invalid results', async () => {
  const signal = new AbortController().signal;
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicIpAddress(ip), false);
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  await assert.rejects(resolvePublicAddresses('example.com', signal, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  await assert.rejects(resolvePublicAddresses('example.com', signal, async () => []));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(resolvePublicAddresses('example.com', abort.signal, () => new Promise(() => {})));
});

test('GitHub URL scope rejects credentials, other origins and repository traversal', async () => {
  const instance = plugin.create();
  try {
    const github = new GitHubTools(instance.transport);
    await assert.rejects(github.api('https://example.com'));
    await assert.rejects(github.api('https://user:pass@api.github.com'));
    await assert.rejects(github.refs('../repo'));
    await assert.rejects(github.refs('owner/repo/extra'));
  } finally { await instance.transport.close(); }
});

test('domain type matches exact and subdomain but not lookalike domains', () => {
  const engine = new RuleEngine([
    { include: 'include', type: 'domain', title: 'GitHub exact', pattern: 'github.com', active: true },
  ]);
  assert.equal(engine.explain('https://github.com/api').route, 'proxy');
  assert.equal(engine.explain('https://api.github.com/api').route, 'proxy');
  assert.equal(engine.explain('https://raw.githubusercontent.com').route, 'direct');
  assert.equal(engine.explain('https://notgithub.com').route, 'direct');
  assert.equal(engine.explain('https://github.com.evil.com').route, 'direct');
});

test('domain type rejects invalid domain patterns', () => {
  for (const pattern of ['*.github.com', 'github.com/path', 'github.com?q', 'UPPER.COM', 'localhost', 'a', '.com', 'github..com']) {
    assert.throws(() => new RuleEngine([
      { include: 'include', type: 'domain', title: 'test', pattern, active: true },
    ]), /domain pattern must be a valid lowercase domain name/);
  }
});

test('mixed domain and regex types coexist correctly', () => {
  const engine = new RuleEngine([
    { include: 'include', type: 'domain', title: 'GH', pattern: 'github.com', active: true },
    { include: 'include', type: 'regex', title: 'Google', pattern: '.*google.*', active: true },
    { include: 'include', type: 'domain', title: 'Inactive', pattern: 'huggingface.co', active: false },
  ]);
  assert.equal(engine.explain('https://github.com').route, 'proxy');
  assert.equal(engine.explain('https://google.com').route, 'proxy');
  assert.equal(engine.explain('https://huggingface.co').route, 'direct');
  assert.equal(engine.explain('https://unknown.com').route, 'direct');
});

test('unsupported type values are rejected', () => {
  assert.throws(() => new RuleEngine([
    { include: 'include', type: 'wildcard', title: 'test', pattern: 'github.*', active: true },
  ]), /only include\/regex or include\/domain is supported/);
  assert.throws(() => new RuleEngine([
    { include: 'exclude', type: 'regex', title: 'test', pattern: 'x', active: true },
  ]), /only include\/regex or include\/domain is supported/);
});

test('explain includes ruleType field for domain and regex rules', () => {
  const engine = new RuleEngine([
    { include: 'include', type: 'domain', title: 'github domain', pattern: 'github.com', active: true },
    { include: 'include', type: 'regex', title: 'google regex', pattern: '.*google\\..*', active: true },
  ]);
  const domainResult = engine.explain('https://api.github.com/repos/owner/repo');
  assert.equal(domainResult.route, 'proxy');
  assert.equal(domainResult.ruleType, 'domain');
  assert.equal(domainResult.title, 'github domain');
  const regexResult = engine.explain('https://www.google.com/search');
  assert.equal(regexResult.route, 'proxy');
  assert.equal(regexResult.ruleType, 'regex');
  assert.equal(regexResult.title, 'google regex');
  const noMatch = engine.explain('https://example.com/');
  assert.equal(noMatch.route, 'direct');
  assert.equal(noMatch.ruleType, undefined);
});
