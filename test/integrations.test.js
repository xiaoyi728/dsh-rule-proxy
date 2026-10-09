import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { SearxSearchProvider } from '../src/search.js';
import { RuleEngine } from '../src/rules.js';
import { ToolTransport } from '../src/transport.js';
import { GitHubTools } from '../src/github.js';
import { registerTools } from '../src/tools.js';
import { create, Config } from '../src/index.js';

async function fixture(t, handler) {
  const target = http.createServer(handler);
  const proxy = http.createServer();
  const sockets = new Set();
  const authorities = [];
  proxy.on('connect', (req, socket) => {
    authorities.push(req.url);
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  for (const server of [target, proxy]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const transport = new ToolTransport({ engine: new RuleEngine([{ include: 'include', type: 'regex', title: 'fixture', pattern: '.*', active: true }]), proxyUrl: `http://127.0.0.1:${proxy.address().port}`, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  t.after(async () => {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  });
  return { transport, authorities };
}

test('pure search uses real CONNECT transport and caps sources', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(new URL(req.url, 'http://fixture').searchParams.get('q'), 'github query');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ url: 'https://github.com/a', title: 'A', content: 'snippet' }, { url: 'https://example.com', title: 'B' }] }));
  });
  const search = new SearxSearchProvider(f.transport, 'http://search.example/search');
  const result = await search.search({ query: 'github query', maxResults: 1 });
  assert.equal(result.sources.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.sources[0].snippet, 'snippet');
  assert.deepEqual(f.authorities, ['93.184.216.34:80']);
});

test('Git protocol parser reads actual smart HTTP response via isolated adapter', async t => {
  const packet = text => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
  const oid = 'a'.repeat(40);
  const f = await fixture(t, (req, res) => {
    assert.match(req.url, /info\/refs\?service=git-upload-pack/);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end(packet('# service=git-upload-pack\n') + '0000' + packet(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`) + packet(`${oid} refs/heads/main\n`) + '0000');
  });
  // Keep production GitHub validation; switch only the test wire protocol to HTTP.
  const adapter = { request: (url, headers, signal, options) => {
    const wire = new URL(url); wire.protocol = 'http:';
    return f.transport.request(wire, headers, signal, options);
  } };
  const refs = await new GitHubTools(adapter).refs('owner/repo');
  assert.ok(refs.some(ref => ref.ref === 'refs/heads/main' && ref.oid === oid));
  assert.equal(f.authorities.length, 1);
});

test('all explicit tools compile schemas and execute diagnostics', async () => {
  const instance = create();
  const tools = [];
  try {
    registerTools({ tools: { register(tool) { tools.push(tool); } } }, instance, Config({}));
    assert.deepEqual(tools.map(tool => tool.name), ['rule_proxy_diagnose', 'github_api_get', 'github_git_refs']);
    const result = await tools[0].execute({ url: 'https://api.openai.com', source: 'model' }, {});
    assert.equal(result.route, 'unmanaged');
    await assert.rejects(tools[1].execute({ path: 'https://example.com' }, {}));
  } finally { await instance.transport.close(); }
});
