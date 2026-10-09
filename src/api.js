// Host-backed configuration endpoint for the client settings page.
//
// The browser half cannot rely on ctx.configForms: that service ships with
// @deepseek-ai/dsh-client-ui-settings, which a profile need not install, and
// dsh 0.2 removed the older ctx.settingsScope. This route therefore owns the
// read/write path, mirroring the installed reference plugin's approach.
//
// Security: loopback-only by construction, and every request must be same
// origin (fetch metadata) so a stray page cannot drive configuration writes.
// Secrets are never returned: proxyToken is only ever written.

const API_PREFIX = '/dsh-rule-proxy/api';
const MAX_BODY_BYTES = 512 * 1024;

// Loopback-only by construction; still refuse a request that any other
// origin or a cross-site page initiated, so a stray tab cannot drive writes.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return true;
  const host = req.headers.host;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return false; }
  if (originHost === host) return true;
  // A loopback request may legitimately arrive under a different loopback
  // spelling (127.0.0.1 vs localhost, or an explicit port); anything else is
  // a foreign origin.
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  return loopback.test(origin) && loopback.test(`http://${host}`);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function configView(value) {
  // proxyToken is intentionally omitted: it is a write-only secret field.
  const { proxyToken, ...rest } = value;
  void proxyToken;
  return rest;
}

export function registerConfigApi(ctx, read, write) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return () => {};
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      if (!sameOrigin(req)) { send(res, 403, { ok: false, error: 'cross-origin request refused' }); return; }
      const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(API_PREFIX.length);
      try {
        if (route === '/config' && req.method === 'GET') {
          send(res, 200, { ok: true, config: configView(read()), writable: true });
          return;
        }
        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req);
          write(body);
          send(res, 200, { ok: true, config: configView(read()), writable: true });
          return;
        }
        send(res, 404, { ok: false, error: 'unknown route' });
      } catch (error) {
        send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
