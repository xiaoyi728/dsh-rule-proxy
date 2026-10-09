import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function run(command, args, cwd, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited ${code}\n${output}`)));
    child.stdin.end(input);
  });
}

const tarball = resolve(process.argv[2] ?? 'dsh-rule-proxy-0.1.0.tgz');
const prefix = join(tmpdir(), 'dsh-rule-proxy-package-');
const dir = await mkdtemp(prefix);
try {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'isolated-package-smoke', private: true, type: 'module' }));
  await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], dir);
  const output = await run(process.execPath, ['--input-type=module'], dir, `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { getGlobalDispatcher } from 'undici';
import * as plugin from 'dsh-rule-proxy';
const env = { ...process.env }, fetch = globalThis.fetch, dispatcher = getGlobalDispatcher();
const root = new URL('./node_modules/dsh-rule-proxy/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(manifest.dsh.client.platform, 'web');
assert.ok((await readFile(new URL('src/client.js', root), 'utf8')).includes('__ModuleLoader__'));
assert.equal(plugin.Config({}).rules.get().length, 12);
const instance = plugin.create();
assert.equal(instance.engine.explain('https://github.com').route, 'proxy');
assert.equal(instance.engine.explain('https://api.openai.com', { source: 'model' }).route, 'unmanaged');
await instance.transport.close();
const ctx = new Context();
const web = ctx.plugin(WebRuntime, { fetchProvider: 'rule-proxy' });
await web.await();
const fiber = ctx.plugin(plugin, {});
await fiber.await();
assert.ok(ctx.web.fetchProviders.get('rule-proxy').available());
await fiber.dispose();
assert.equal(ctx.web.fetchProviders.has('rule-proxy'), false);
await web.dispose();
assert.deepEqual({ ...process.env }, env);
assert.equal(globalThis.fetch, fetch);
assert.equal(getGlobalDispatcher(), dispatcher);
console.log('Installed tarball: backend import, default rules, client asset, Cordis registration and disposal passed');
`);
  process.stdout.write(output);
} finally {
  const target = await realpath(dir);
  assert.equal(target, resolve(dir));
  assert.ok(target.startsWith(prefix));
  await rm(target, { recursive: true, force: true });
}
