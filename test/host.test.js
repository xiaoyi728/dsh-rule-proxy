import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import * as standardTools from '@deepseek-ai/dsh-tool-web';
import { fetch as modelFetch, getGlobalDispatcher } from 'undici';
import * as plugin from '../src/index.js';

// In-memory Cordis composition with actual DSH services and standard tools;
// no profile, GUI, real model SDK, or user filesystem is modified.
test('native web tools execute through real Cordis/ToolRuntime/WebRuntime and unload cleanly', async t => {
  const before = { env: { ...process.env }, fetch: globalThis.fetch, dispatcher: getGlobalDispatcher() };
  const hits = { model: 0, target: [], connect: [] };
  const model = http.createServer((_req, res) => { hits.model++; res.end('model-original-path'); });
  const target = http.createServer((req, res) => {
    hits.target.push(req.url);
    if (req.url.startsWith('/search?')) {
      assert.equal(new URL(req.url, 'http://fixture').searchParams.get('q'), 'test query');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ url: 'https://example.com', title: 'Fixture', content: 'source snippet' }] }));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('native-tool-through-proxy');
    }
  });
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connect', (req, socket, head) => {
    hits.connect.push(req.url);
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  const ctx = new Context();
  const fibers = [];
  t.after(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
    for (const socket of sockets) socket.destroy();
    await Promise.all([model, target, proxy].map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
  });
  for (const server of [model, target, proxy]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const mount = async (definition, config = {}) => {
    const fiber = ctx.plugin(definition, config); fibers.push(fiber); await fiber.await(); return fiber;
  };
  await mount(SystemPrompt);
  await mount(ToolRuntime);
  await mount(WebRuntime, { fetchProvider: 'rule-proxy', searchProvider: 'rule-proxy-searxng' });
  const ruleProxy = await mount(plugin, {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    searxEndpoint: 'http://search.example/search',
    rules: [{ include: 'include', type: 'regex', title: 'fixture', pattern: '.*', active: true }],
  });
  // Test-only resolver maps fixture origins to a public authority, while the
  // fake CONNECT proxy chooses a local target. Production SSRF rules unchanged.
  ctx.web.fetchProviders.get('rule-proxy').transport.resolve = async () => [{ address: '93.184.216.34', family: 4 }];
  await mount(standardTools);
  let sequence = 0;
  const execute = (name, args) => ctx.tools.execute({
    callId: `fixture-${++sequence}`, name, arguments: args, signal: new AbortController().signal,
  });
  const modelUrl = `http://127.0.0.1:${model.address().port}/same-origin`;
  const [fetched, modelResult] = await Promise.all([
    execute('web_fetch', { url: modelUrl }),
    modelFetch(modelUrl).then(response => response.text()),
  ]);
  assert.equal(fetched.isError, false, JSON.stringify(fetched.error));
  assert.equal(fetched.value.body.content, 'native-tool-through-proxy');
  assert.ok(fetched.content.some(block => block.type === 'text' && block.text.includes('native-tool-through-proxy')));
  assert.equal(modelResult, 'model-original-path');
  const searched = await execute('web_search', { queries: ['test query'] });
  assert.equal(searched.isError, false, JSON.stringify(searched.error));
  assert.equal(searched.value.sources[0].title, 'Fixture');
  const diagnostic = await execute('rule_proxy_diagnose', { url: 'https://api.openai.com', source: 'model' });
  assert.equal(diagnostic.isError, false, JSON.stringify(diagnostic.error));
  assert.equal(diagnostic.value.route, 'unmanaged');
  assert.deepEqual(hits.connect, [`93.184.216.34:${model.address().port}`, '93.184.216.34:80']);
  assert.equal(hits.model, 1);
  await ruleProxy.dispose();
  assert.equal(ctx.web.fetchProviders.has('rule-proxy'), false);
  const absent = await execute('web_fetch', { url: modelUrl });
  assert.equal(absent.isError, true);
  const gone = await execute('rule_proxy_diagnose', { url: modelUrl });
  assert.equal(gone.isError, true);
  assert.equal(await modelFetch(modelUrl).then(response => response.text()), 'model-original-path');
  assert.deepEqual({ ...process.env }, before.env);
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(getGlobalDispatcher(), before.dispatcher);
});
