import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; window.fixtureReact=React; window.fixtureRoot=createRoot;`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser' });
const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const rules = JSON.parse(await readFile(new URL('../rules.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Serve the panel from a real origin so the same-origin fetch the client
    // performs is exercised exactly as it is in the browser. Register the page
    // route first: Playwright matches handlers in reverse registration order, so
    // the exact API route below takes precedence over this catch-all.
    await page.route('http://127.0.0.1:3199/**', route => route.fulfill({ contentType: 'text/html', body: '<html lang="zh"><body style="margin:16px;font:14px sans-serif"><div id="root"></div></body></html>' }));
    // The client now talks to the host over /dsh-rule-proxy/api, so the fixture
    // serves that route instead of injecting a settings service. The state lives
    // here rather than in the page: a route handler must not evaluate into the
    // very page that issued the request.
    const host = { config: { enabled: true, proxyUrl: '', searxEndpoint: '', rules }, writes: [] };
    await page.route('**/dsh-rule-proxy/api/config', async route => {
      const request = route.request();
      if (request.method() !== 'GET') Object.assign(host.config, request.postDataJSON() ?? {}), host.writes.push(request.postDataJSON() ?? {});
      return route.fulfill({ json: { ok: true, config: host.config, writable: true } });
    });
    await page.goto('http://127.0.0.1:3199/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.__ModuleLoader__ = { load: definition => {
        const module = definition.factory(() => window.fixtureReact);
        module.apply({
          slots: { inject: (_name, fn) => fn(), register: (_options, Section) => {
            window.fixtureRoot(document.getElementById('root')).render(window.fixtureReact.createElement(Section));
            return () => {};
          } },
        });
      } };
    });
    await page.addScriptTag({ content: client });
    await page.locator('#rule-proxy-enabled').waitFor({ state: 'attached' });
    await page.locator('#rule-proxy-url').fill('http://127.0.0.1:7890');
        await page.getByRole('button', { name: '诊断' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('代理'));
    await page.locator('#rule-proxy-diag-source').selectOption('model');
    await page.getByRole('button', { name: '诊断' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('不受插件管理'));

    const domainRule = { include: 'include', type: 'domain', title: 'GitHub domain', pattern: 'github.com', active: true };
    await page.locator('input[type=file]').setInputFiles({ name: 'domain.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([domainRule])) });
    await page.getByRole('button', { name: '保存规则' }).click();
    await page.waitForTimeout(300);
    await page.locator('#rule-proxy-diag-source').selectOption('web-fetch');
    const checkRoute = async (url, expected) => {
      await page.locator('#rule-proxy-diag-url').fill(url);
      await page.getByRole('button', { name: '诊断' }).click();
      await page.waitForFunction(expected => document.querySelector('output')?.textContent.includes(expected), expected);
    };
    await checkRoute('https://github.com/', '代理（精确域名）');
    await checkRoute('https://API.GITHUB.COM./repos', '代理（精确域名）');
    for (const url of ['https://notgithub.com/', 'https://github.com.evil.com/', 'https://example.com/github.com']) await checkRoute(url, '直连');
    // Host-written invalid rules are refused before any request is staged.
    const writesBefore = host.writes.length;
    await page.locator('#rule-proxy-rules').fill(JSON.stringify([{ ...domainRule, type: 'regex', pattern: '(a)\\1' }]));
    await page.getByRole('button', { name: '保存规则' }).click();
    await page.getByRole('alert').filter({ hasText: '不支持反向引用或先行断言' }).waitFor();
    assert.equal(host.writes.length, writesBefore);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `test/settings-${width}.png`, fullPage: true });
    await page.close();
    console.log(`Settings browser fixture passed: ${width}px`);
  }
} finally { await browser.close(); }
