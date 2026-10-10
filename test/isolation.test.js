import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { getGlobalDispatcher, fetch as modelFetch } from 'undici';
import { RuleEngine } from '../src/rules.js';
import { ToolTransport } from '../src/transport.js';
import { RuleFetchProvider } from '../src/provider.js';
import { resolvePublicAddresses } from '../src/public-network.js';

const rule = { include: 'include', type: 'regex', title: 'fixture', pattern: '.*127.*', active: true };

async function fixture(t) {
  const hits = { model: 0, tool: 0, connect: [] };
  const target = http.createServer((req, res) => {
    hits.model++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('model-original-path');
  });
  const fake = http.createServer((req, res) => {
    hits.tool++;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/same-origin' }); res.end(); return; }
    if (req.url === '/cross') { res.writeHead(302, { location: 'https://example.com/' }); res.end(); return; }
    if (req.url === '/slow') return;
    if (req.url === '/large') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '128' }); res.end('x'.repeat(128)); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tool-through-proxy');
  });
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connect', (req, socket, head) => {
    hits.connect.push(req.url);
    const upstream = net.connect(fake.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  for (const server of [target, fake, proxy]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, fake, proxy].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  return { hits, target, fake, proxy, url: `http://127.0.0.1:${target.address().port}/same-origin` };
}

test('same-origin real tool/model requests stay isolated; global state unchanged', async t => {
  const f = await fixture(t);
  const before = { ...process.env };
  const dispatcher = getGlobalDispatcher();
  const globalFetch = globalThis.fetch;
  const transport = new ToolTransport({
    engine: new RuleEngine([rule]), proxyUrl: `http://127.0.0.1:${f.proxy.address().port}`,
    // Test-only resolver maps the fake destination to a validated public address.
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  t.after(() => transport.close());
  const provider = new RuleFetchProvider(transport);
  const [tool, model] = await Promise.all([provider.fetch({ url: f.url }), modelFetch(f.url).then(r => r.text())]);
  assert.equal(tool.body.content, 'tool-through-proxy');
  assert.equal(model, 'model-original-path');
  assert.deepEqual(f.hits.connect, [`93.184.216.34:${f.target.address().port}`]);
  assert.equal(f.hits.model, 1); assert.equal(f.hits.tool, 1);
  assert.deepEqual({ ...process.env }, before);
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.equal(globalThis.fetch, globalFetch);
});

test('matched proxy failure does not fall back; model still works', async t => {
  const f = await fixture(t);
  const transport = new ToolTransport({ engine: new RuleEngine([rule]), proxyUrl: 'http://127.0.0.1:1', resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(() => transport.close());
  await assert.rejects(new RuleFetchProvider(transport, { timeoutMs: 1000 }).fetch({ url: f.url }));
  assert.equal(f.hits.model, 0);
  assert.equal(await modelFetch(f.url).then(r => r.text()), 'model-original-path');
});

test('production resolver blocks private targets before any proxy connection', async () => {
  const transport = new ToolTransport({ engine: new RuleEngine([rule]), proxyUrl: 'http://127.0.0.1:1' });
  try {
    await assert.rejects(new RuleFetchProvider(transport).fetch({ url: 'http://127.0.0.1/' }), error => error.code === 'WEB_BLOCKED_URL');
  } finally { await transport.close(); }
});

test('a matched rule with no upstream proxy reports the setup mistake, not a generic failure', async t => {
  const f = await fixture(t);
  const transport = new ToolTransport({ engine: new RuleEngine([rule]), proxyUrl: '', resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(() => transport.close());
  await assert.rejects(
    new RuleFetchProvider(transport).fetch({ url: f.url }),
    error => error.code === 'WEB_PROXY_NOT_CONFIGURED' && error.message.includes('no upstream proxy is configured'),
  );
  assert.equal(f.hits.connect.length, 0, 'no connection is attempted when there is nothing to connect to');
});

test('an unreachable upstream proxy names the cause so the fix is obvious', async t => {
  // Take a real port and release it, so the refusal is a connection refusal
  // rather than undici rejecting a well-known "bad port" outright.
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const deadPort = closed.address().port;
  await new Promise(resolve => { closed.close(resolve); closed.closeAllConnections(); });
  const transport = new ToolTransport({ engine: new RuleEngine([rule]), proxyUrl: `http://127.0.0.1:${deadPort}`, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(() => transport.close());
  try {
    await assert.rejects(
      new RuleFetchProvider(transport, { timeoutMs: 5000 }).fetch({ url: 'http://127.0.0.1/' }),
      error => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('ECONNREFUSED'),
    );
  } finally { await transport.close(); }
});

test('same-origin redirects, cross-origin refusal, limits, cancellation and cleanup', async t => {
  const f = await fixture(t);
  const transport = new ToolTransport({ engine: new RuleEngine([rule]), proxyUrl: `http://127.0.0.1:${f.proxy.address().port}`, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(() => transport.close());
  const url = path => new URL(path, f.url).toString();
  assert.equal((await new RuleFetchProvider(transport).fetch({ url: url('/redirect') })).body.content, 'tool-through-proxy');
  await assert.rejects(new RuleFetchProvider(transport).fetch({ url: url('/cross') }), error => error.code === 'WEB_REDIRECT_BLOCKED');
  await assert.rejects(new RuleFetchProvider(transport, { maxRedirects: 0 }).fetch({ url: url('/redirect') }), error => error.code === 'WEB_REDIRECT_BLOCKED');
  await assert.rejects(new RuleFetchProvider(transport, { maxResponseBytes: 16 }).fetch({ url: url('/large') }), error => error.code === 'WEB_FETCH_TOO_LARGE');
  assert.equal((await new RuleFetchProvider(transport, { maxBodyChars: 4 }).fetch({ url: f.url })).truncated, true);
  await assert.rejects(new RuleFetchProvider(transport, { timeoutMs: 50 }).fetch({ url: url('/slow') }));
  const controller = new AbortController();
  const pending = new RuleFetchProvider(transport).fetch({ url: url('/slow') }, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  await transport.close();
  await assert.rejects(new RuleFetchProvider(transport).fetch({ url: f.url }));
});

test('unmatched and disabled tool requests use independent direct transport', async t => {
  const f = await fixture(t);
  for (const enabled of [true, false]) {
    // Test-only loopback resolver permits observing direct socket routing.
    const transport = new ToolTransport({ engine: new RuleEngine(enabled ? [] : [rule]), enabled, proxyUrl: 'http://127.0.0.1:1', resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    try { assert.equal((await new RuleFetchProvider(transport).fetch({ url: f.url })).body.content, 'model-original-path'); }
    finally { await transport.close(); }
  }
  assert.equal(f.hits.model, 2);
  assert.equal(f.hits.connect.length, 0);
});

test('proxy CONNECT brackets a validated IPv6 address without a second hostname lookup', async t => {
  const f = await fixture(t);
  const url = new URL(f.url);
  url.hostname = 'fixture.example';
  const ipv6 = '2606:4700:4700::1111';
  const lookups = [];
  const transport = new ToolTransport({
    engine: new RuleEngine([{ ...rule, pattern: 'fixture' }]),
    proxyUrl: `http://127.0.0.1:${f.proxy.address().port}`,
    resolve: (hostname, signal) => resolvePublicAddresses(hostname, signal, async name => {
      lookups.push(name);
      return name === 'ipv4only.arpa' ? [] : [{ address: ipv6, family: 6 }];
    }),
  });
  t.after(() => transport.close());
  assert.equal((await new RuleFetchProvider(transport).fetch({ url: url.toString() })).body.content, 'tool-through-proxy');
  assert.deepEqual(f.hits.connect, [`[${ipv6}]:${url.port}`]);
  assert.deepEqual(lookups, ['fixture.example', 'ipv4only.arpa']);
  assert.equal(f.hits.model, 0);
});

test('same-origin redirect revalidates DNS and blocks a rebound private address before CONNECT', async t => {
  const f = await fixture(t);
  const url = new URL('/redirect', f.url);
  url.hostname = 'fixture.example';
  let lookups = 0;
  const transport = new ToolTransport({
    engine: new RuleEngine([{ ...rule, pattern: 'fixture' }]),
    proxyUrl: `http://127.0.0.1:${f.proxy.address().port}`,
    resolve: (hostname, signal) => resolvePublicAddresses(hostname, signal, async () => {
      lookups++;
      return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    }),
  });
  t.after(() => transport.close());
  await assert.rejects(new RuleFetchProvider(transport).fetch({ url: url.toString() }), error => error.code === 'WEB_BLOCKED_URL');
  assert.equal(lookups, 2);
  assert.deepEqual(f.hits.connect, [`93.184.216.34:${url.port}`]);
  assert.equal(f.hits.tool, 1);
  assert.equal(f.hits.model, 0);
});

