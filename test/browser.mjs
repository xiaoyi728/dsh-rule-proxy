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
    await page.setContent('<html lang="zh"><body style="margin:16px;font:14px sans-serif"><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(rules => {
      const listeners = new Set();
      let snapshot = { status: 'ready', writable: true, revision: 3, value: { enabled: true, proxyUrl: '', searxEndpoint: '', rules } };
      window.fixtureWrites = [];
      window.fixtureForm = {
        getSnapshot: () => snapshot,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        mutate: async (ops, revision) => {
          window.fixtureWrites.push({ ops, revision });
          const value = { ...snapshot.value };
          for (const op of ops) value[op.path[0]] = op.value;
          snapshot = { ...snapshot, revision: snapshot.revision + 1, value };
          listeners.forEach(fn => fn()); return true;
        },
      };
      window.__ModuleLoader__ = { load: definition => {
        const module = definition.factory(() => window.fixtureReact);
        module.apply({
          effect: fn => fn(),
          configForms: { get: () => window.fixtureForm, whileServed: (_ids, fn) => fn() },
          slots: { inject: (_name, fn) => fn(), register: (options, Page) => {
            window.fixtureRoot(document.getElementById('root')).render(window.fixtureReact.createElement(Page, { view: 'detail', ...options.inject() }));
            return () => {};
          } },
        });
      } };
    }, rules);
    await page.addScriptTag({ content: client });
    await page.getByLabel('上游 HTTP(S) 代理').fill('http://127.0.0.1:7890');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.fixtureWrites.length === 1);
    assert.equal(await page.evaluate(() => window.fixtureWrites[0].ops.some(op => op.path[0] === 'proxyToken')), false);
    await page.getByRole('button', { name: '诊断草稿' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('代理'));
    await page.getByLabel('请求来源').selectOption('model');
    await page.getByRole('button', { name: '诊断草稿' }).click();
    await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('不受插件管理'));
    await page.getByLabel('导入规则文件').setInputFiles({ name: 'rules.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rules.slice(0, 1))) });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.fixtureWrites.length === 2);
    assert.equal(await page.evaluate(() => window.fixtureWrites[1].ops.find(op => op.path[0] === 'rules').value.length), 1);
    const domainRule = { include: 'include', type: 'domain', title: 'GitHub domain', pattern: 'github.com', active: true };
    await page.getByLabel('导入规则文件').setInputFiles({ name: 'domain.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([domainRule])) });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.fixtureWrites.length === 3);
    assert.equal(await page.evaluate(() => window.fixtureWrites[2].ops.find(op => op.path[0] === 'rules').value[0].type), 'domain');
    await page.getByLabel('请求来源').selectOption('web-fetch');
    const checkRoute = async (url, expected) => {
      await page.getByLabel('诊断 URL').fill(url);
      await page.getByRole('button', { name: '诊断草稿' }).click();
      await page.waitForFunction(expected => document.querySelector('output')?.textContent.includes(expected), expected);
    };
    await checkRoute('https://github.com/', '代理（精确域名）');
    await checkRoute('https://API.GITHUB.COM./repos', '代理（精确域名）');
    for (const url of ['https://notgithub.com/', 'https://github.com.evil.com/', 'https://example.com/github.com', 'https://githubXcom/']) await checkRoute(url, '直连');
    await page.getByLabel('规则 JSON').fill(JSON.stringify([{ ...domainRule, active: false }]));
    await checkRoute('https://api.github.com/', '直连');
    for (const pattern of ['UPPER.COM', '*.github.com', 'github.com/path']) {
      await page.getByLabel('规则 JSON').fill(JSON.stringify([{ ...domainRule, pattern }]));
      await page.getByRole('button', { name: '诊断草稿' }).click();
      await page.getByRole('alert').filter({ hasText: 'domain 须为小写域名' }).waitFor();
    }
    await page.getByLabel('规则 JSON').fill(JSON.stringify([domainRule]));
    await checkRoute('https://api.github.com/', '代理（精确域名）');
    await page.getByLabel('规则 JSON').fill(JSON.stringify([{ ...domainRule, type: 'regex', pattern: '(a)\\1' }]));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '不支持反向引用或先行断言' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureWrites.length), 3);
    await page.getByLabel('规则 JSON').fill(JSON.stringify([domainRule]));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `test/settings-${width}.png`, fullPage: true });
    await page.close();
    console.log(`Settings browser fixture passed: ${width}px`);
  }
} finally { await browser.close(); }
