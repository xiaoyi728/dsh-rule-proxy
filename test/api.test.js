import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { registerConfigApi, configView } from '../src/api.js';

function fixture(snapshot, onWrite) {
  const routes = [];
  const webServer = { register: route => { routes.push(route); return () => {}; } };
  const ctx = { get: name => (name === 'webServer' ? webServer : undefined) };
  registerConfigApi(ctx, snapshot, onWrite);
  return routes;
}

function request(routes, { url = '/dsh-rule-proxy/api/config', method = 'GET', headers = {}, body } = {}) {
  const req = new PassThrough();
  process.nextTick(() => { req.end(body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))); });
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', ...headers } });
  let status; let payload = '';
  const res = {
    writeHead(code, headers) { status = code; res.headers = headers ?? {}; },
    end(text) { payload += text ?? ''; },
  };
  return routes[0].handler(req, res).then(() => ({ status, payload: JSON.parse(payload) }));
}

test('config view never returns the proxy token', () => {
  assert.deepEqual(configView({ enabled: true, proxyToken: 'secret', rules: [] }), { enabled: true, rules: [] });
});

test('api serves configuration, rejects cross-origin writes and forwards edits', async t => {
  const writes = [];
  const state = { enabled: true, proxyUrl: 'http://10.0.0.1:8080', proxyToken: 'secret', rules: [] };
  const routes = fixture(() => state, body => writes.push({ body }));
  t.after(() => assert.equal(routes.length, 1));
  const read = await request(routes);
  assert.equal(read.status, 200);
  assert.equal(read.payload.ok, true);
  assert.equal(read.payload.config.proxyUrl, 'http://10.0.0.1:8080');
  assert.equal('proxyToken' in read.payload.config, false);
  const refused = await request(routes, { method: 'POST', headers: { origin: 'https://evil.example' }, body: { enabled: false } });
  assert.equal(refused.status, 403);
  assert.equal(writes.length, 0);
  const wrongSite = await request(routes, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { enabled: false } });
  assert.equal(wrongSite.status, 403);
  assert.equal(writes.length, 0);
  const accepted = await request(routes, { method: 'POST', headers: { origin: 'http://127.0.0.1:3080' }, body: { enabled: false } });
  assert.equal(accepted.status, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { enabled: false });
  const missing = await request(routes, { url: '/dsh-rule-proxy/api/other' });
  assert.equal(missing.status, 404);
  const bad = await request(routes, { method: 'POST', body: 'not-json' });
  assert.equal(bad.status, 400);
});

test('api reports unavailable when no web server is present', () => {
  const ctx = { get: () => undefined };
  assert.equal(typeof registerConfigApi(ctx, () => ({}), () => {}), 'function');
});
