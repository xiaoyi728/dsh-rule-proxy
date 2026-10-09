#!/usr/bin/env node
import fs from 'node:fs';
import { create } from './index.js';

function usage() {
  console.error('Usage: npm run diagnose -- <url> [source] [rules.json]');
  console.error('source: web-fetch | pure-search | github-api | github-git | model');
  process.exitCode = 2;
}

const [url, source = 'web-fetch', rulesPath = 'rules.json'] = process.argv.slice(2);
if (!url) usage();
else {
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const { engine, transport } = create({ rules, proxyUrl: '' });
    console.log(JSON.stringify({ ...engine.explain(url, { source }), coverage: {
      toolRequests: ['web-fetch', 'pure-search', 'github-api', 'github-git'],
      modelRequests: 'unmanaged: existing model client path is never changed',
    } }, null, 2));
    await transport.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
