#!/usr/bin/env node
// Build docs/index.json — this plugin as a DSH plugin market index (format 1).
//
// The official Discover tab reads any user-added http(s) index URL. This script
// produces one for this package, taking the version and publish time from the
// npm registry so the entry never drifts from what is actually installable.
//
//   node scripts/build-index.mjs           write docs/index.json
//   node scripts/build-index.mjs --check   validate the current file, write nothing
//
// Without a published package the script fails loudly instead of inventing a
// publishTimestamp: `parseMarketIndex` rejects a missing or malformed one, and a
// guessed time would advertise a version that cannot be installed yet.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(ROOT, 'docs', 'index.json')
const REGISTRY = 'https://registry.npmjs.org'
const INDEX_URL = 'https://raw.githubusercontent.com/xiaoyi728/dsh-rule-proxy/main/docs/index.json'

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')
const selfTest = process.argv.includes('--self-test')

/** Load the official validator; it is the only authority on what a host accepts. */
async function loadValidator() {
  return import('@deepseek-ai/dsh-plugin-market-index')
}

/** Publish time of one exact version, in Unix seconds. */
async function publishTime(version) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(pkg.name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`npm registry answered ${String(response.status)} for ${pkg.name}`)
  const packument = await response.json()
  const stamp = packument.time?.[version]
  if (typeof stamp !== 'string') {
    throw new Error(`${pkg.name}@${version} is not on npm yet; publish before building the index`)
  }
  return Math.floor(new Date(stamp).getTime() / 1000)
}

/** The index document, with every field the format defines and no invented ones. */
function buildIndex(timestamp) {
  const repository = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  return {
    format: 1,
    title: { en: 'dsh-rule-proxy', zh: 'dsh-rule-proxy' },
    description: {
      en: 'Hostname-rule transport for DSH web tools.',
      zh: 'DSH web 工具的主机名规则传输层。',
    },
    metadata: {
      categories: { tools: { title: { en: 'Tools', zh: '工具与能力' } } },
      labels: {},
      sortKeys: {},
    },
    plugins: [
      {
        name: pkg.name,
        title: { en: 'rule-proxy', zh: '规则代理' },
        description: {
          en: 'Routes web_fetch, GitHub and optional SearXNG requests through an HTTP(S) proxy by hostname rule, falling back to a direct connection when the upstream is unreachable.',
          zh: '按主机名规则让 web_fetch、GitHub 与可选的 SearXNG 请求走指定 HTTP(S) 代理，上游不可达时自动回退直连。',
        },
        homepage: repository,
        repository: { url: repository },
        metadata: {
          category: 'tools',
          keywords: ['proxy', 'network', 'web-fetch', 'hostname-rules'],
          labels: [],
          sortKeys: {},
        },
        versions: [
          {
            version: pkg.version,
            publishTimestamp: timestamp,
            source: { type: 'npm' },
            engines: pkg.engines.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
          },
        ],
      },
    ],
  }
}

const { parseMarketIndex, marketInstallTarget } = await loadValidator()

if (selfTest) {
  // Validate the document shape without contacting the registry, so the format
  // can be proven before the package is published. A stand-in timestamp is used
  // only here and never written to disk.
  const index = buildIndex(1_700_000_000)
  const parsed = parseMarketIndex(index, INDEX_URL)
  const [entry] = parsed.plugins
  const target = marketInstallTarget(entry.name, entry.versions[0])
  console.log(`self-test: valid format-1 index for ${entry.name}, install spec ${target.spec}`)
} else if (checkOnly) {
  if (!fs.existsSync(OUT_FILE)) throw new Error(`${OUT_FILE} does not exist; run without --check first`)
  const parsed = parseMarketIndex(JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')), INDEX_URL)
  const [entry] = parsed.plugins
  if (entry.name !== pkg.name) throw new Error(`index names ${entry.name}, package is ${pkg.name}`)
  console.log(`check: valid format-1 index, ${String(parsed.plugins.length)} plugin, ${String(entry.versions.length)} version`)
} else {
  const index = buildIndex(await publishTime(pkg.version))
  // Minified: the reading host enforces a 15 s fetch timeout, and indentation is
  // pure overhead on the wire.
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(index)}\n`)
  parseMarketIndex(index, INDEX_URL)
  console.log(`wrote docs/index.json for ${pkg.name}@${pkg.version}`)
}
