import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { RuleEngine } from '../src/rules.js';
import { ToolTransport } from '../src/transport.js';
import { RuleFetchProvider } from '../src/provider.js';

const engine = () => new RuleEngine([{ include: 'include', type: 'regex', title: 'fixture', pattern: '.*', active: true }]);
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];

test('proxy authentication rejection remains a tool failure without leaking secret', async t => {
  const secret = 'Basic fixture-only';
  let auth;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    auth = req.headers['proxy-authorization'];
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const transport = new ToolTransport({ engine: engine(), proxyUrl: `http://127.0.0.1:${proxy.address().port}`, proxyToken: secret, resolve });
  t.after(async () => { await transport.close(); await new Promise(done => proxy.close(done)); });
  await assert.rejects(new RuleFetchProvider(transport).fetch({ url: 'http://fixture.example/' }), error => !error.message.includes(secret));
  assert.equal(auth, secret);
});

test('proxy authentication success carries the token and returns the proxied response', async t => {
  const secret = 'Basic fixture-success';
  let auth;
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('authenticated-tool-response');
  });
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connect', (req, socket, head) => {
    auth = req.headers['proxy-authorization'];
    if (auth !== secret) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const transport = new ToolTransport({ engine: engine(), proxyUrl: `http://127.0.0.1:${proxy.address().port}`, proxyToken: secret, resolve });
  t.after(async () => {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
  });
  const result = await new RuleFetchProvider(transport).fetch({ url: `http://fixture.example:${target.address().port}/` });
  assert.equal(result.body.content, 'authenticated-tool-response');
  assert.equal(auth, secret);
});


test('HTTPS tunnel preserves original SNI and refuses untrusted target certificate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-proxy-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=fixture.example'], { stdio: 'ignore' });
  let sni;
  const target = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), SNICallback(servername, cb) { sni = servername; cb(null, null); } }, (_req, res) => res.end('must-not-be-read'));
  target.on('tlsClientError', () => {});
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connect', (req, socket) => {
    assert.equal(req.url, '93.184.216.34:443');
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  for (const server of [target, proxy]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const transport = new ToolTransport({ engine: engine(), proxyUrl: `http://127.0.0.1:${proxy.address().port}`, resolve });
  t.after(async () => {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
    // Fixed generated files only; do not recursively delete a computed directory.
    assert.equal(path.dirname(key), dir); assert.equal(path.dirname(cert), dir);
    fs.unlinkSync(key); fs.unlinkSync(cert); fs.rmdirSync(dir);
  });
  await assert.rejects(new RuleFetchProvider(transport).fetch({ url: 'https://fixture.example/' }));
  assert.equal(sni, 'fixture.example');
});

test('trusted target TLS succeeds through HTTP and HTTPS proxies without changing parent trust', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-proxy-trusted-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  t.after(() => {
    assert.equal(path.dirname(key), dir); assert.equal(path.dirname(cert), dir);
    fs.unlinkSync(key); fs.unlinkSync(cert); fs.rmdirSync(dir);
  });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=fixture.example', '-addext', 'subjectAltName=DNS:fixture.example,DNS:api.github.com,DNS:github.com,IP:127.0.0.1'], { stdio: 'ignore' });
  const credentials = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const hosts = [];
  const packet = text => `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`;
  const oid = 'a'.repeat(40);
  const target = https.createServer(credentials, (req, res) => {
    hosts.push({ host: req.headers.host, sni: req.socket.servername, proxyAuth: req.headers['proxy-authorization'] });
    if (req.headers.host === 'api.github.com') {
      assert.equal(req.url, '/repos/owner/repo');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ full_name: 'owner/repo' }));
    } else if (req.headers.host === 'github.com') {
      assert.equal(req.url, '/owner/repo.git/info/refs?service=git-upload-pack');
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      res.end(packet('# service=git-upload-pack\n') + '0000' + packet(`${oid} HEAD\0symref=HEAD:refs/heads/main\n`) + packet(`${oid} refs/heads/main\n`) + '0000');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('trusted-tool-response');
    }
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  t.after(() => new Promise(done => { target.close(done); target.closeAllConnections(); }));
  const before = { ...process.env };
  for (const protocol of ['http', 'https']) {
    const proxy = protocol === 'https' ? https.createServer(credentials) : http.createServer();
    const sockets = new Set();
    const connects = [];
    proxy.on('connect', (req, socket, head) => {
      connects.push({ authority: req.url, auth: req.headers['proxy-authorization'] });
      const upstream = net.connect(target.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(socket); sockets.add(upstream);
      socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    try {
      const script = `
        import { ToolTransport } from ${JSON.stringify(new URL('../src/transport.js', import.meta.url).href)};
        import { RuleEngine } from ${JSON.stringify(new URL('../src/rules.js', import.meta.url).href)};
        import { RuleFetchProvider } from ${JSON.stringify(new URL('../src/provider.js', import.meta.url).href)};
        import { GitHubTools } from ${JSON.stringify(new URL('../src/github.js', import.meta.url).href)};
        import assert from 'node:assert/strict';
        const transport = new ToolTransport({
          engine: new RuleEngine([{ include: 'include', type: 'regex', title: 'fixture', pattern: '.*', active: true }]),
          proxyUrl: ${JSON.stringify(`${protocol}://127.0.0.1:${proxy.address().port}`)},
          proxyToken: 'Basic trusted-fixture', resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        });
        try {
          console.log((await new RuleFetchProvider(transport).fetch({ url: 'https://fixture.example/' })).body.content);
          const github = new GitHubTools(transport);
          const api = await github.api('/repos/owner/repo');
          assert.equal(JSON.parse(api.body.content).full_name, 'owner/repo');
          const refs = await github.refs('owner/repo');
          assert.ok(refs.some(ref => ref.ref === 'refs/heads/main' && ref.oid === ${JSON.stringify(oid)}));
        } finally { await transport.close(); }
      `;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 10000,
      });
      assert.equal(result.stdout.trim(), 'trusted-tool-response');
      assert.deepEqual(connects, Array.from({ length: 3 }, () => ({ authority: '93.184.216.34:443', auth: 'Basic trusted-fixture' })));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(done => { proxy.close(done); proxy.closeAllConnections(); });
    }
  }
  assert.deepEqual(hosts, Array.from({ length: 2 }, () => ['fixture.example', 'api.github.com', 'github.com']
    .map(host => ({ host, sni: host, proxyAuth: undefined }))).flat());
  assert.deepEqual({ ...process.env }, before);
});
