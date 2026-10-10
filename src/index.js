import z from '@deepseek-ai/schemastery';
import defaultRules from '../rules.json' with { type: 'json' };
import { RuleEngine } from './rules.js';
import { ToolTransport, proxyOptions } from './transport.js';
import { RuleFetchProvider } from './provider.js';
import { registerTools } from './tools.js';
import { SearxSearchProvider } from './search.js';
import { registerConfigApi } from './api.js';

export const name = 'rule-proxy';
export const inject = ['web'];
const InputConfig = z.object({
  enabled: z.boolean().default(true),
  searxEndpoint: z.transform(z.string(), value => {
    if (value) new SearxSearchProvider(null, value);
    return value;
  }).default(''),
  proxyUrl: z.transform(z.string(), value => {
    if (value) proxyOptions(value);
    return value;
  }).default(''),
  proxyToken: z.string().role('secret').pattern(/^[^\r\n]*$/).default(''),
  rules: z.transform(z.array(z.object({
    include: z.string().required(), type: z.string().required(), title: z.string().required(),
    pattern: z.string().required(), active: z.boolean().required(),
  })), value => new RuleEngine(value).rules).default(defaultRules),
  maxResponseBytes: z.number().step(1).min(1).max(2147483647).default(5000000),
  maxBodyChars: z.number().step(1).min(1).max(2147483647).default(100000),
  timeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
  maxRedirects: z.number().step(1).min(0).max(20).default(5),
});

// DSH settings exposes only volatile nodes. Capture the committed fields once
// per operation so one request uses one transport configuration.
export const Config = z.object(Object.fromEntries(
  Object.entries(InputConfig.dict).map(([key, schema]) => [key, schema.volatile()]),
));

// Settings reads re-parse values, so rules come back as a fresh array each
// time even when unchanged. Compare snapshots by value: reference comparison
// would rebuild the engine and transport on every request.
function sameSnapshot(a, b) {
  return Boolean(a) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => (Array.isArray(a[key]) && Array.isArray(b[key]))
      ? JSON.stringify(a[key]) === JSON.stringify(b[key])
      : a[key] === b[key]);
}

export function create(input = {}) {
  const config = InputConfig(structuredClone(input));
  const engine = new RuleEngine(config.rules);
  const transport = new ToolTransport({
    engine, enabled: config.enabled, proxyUrl: config.proxyUrl, proxyToken: config.proxyToken,
  });
  const provider = new RuleFetchProvider(transport, config);
  return { engine, transport, provider, search: config.searxEndpoint ? new SearxSearchProvider(transport, config.searxEndpoint, config) : undefined };
}

export function apply(ctx, config) {
  let latest;
  const settings = { get() {
    const next = Object.fromEntries(Object.entries(config).map(([key, ref]) => [key, ref.get()]));
    if (!sameSnapshot(latest, next)) latest = next;
    return latest;
  } };
  const records = new Set();
  let current, disposed = false;
  const close = record => record.closing ??= record.instance.transport.close().finally(() => records.delete(record));
  const get = () => {
    if (disposed) throw new Error('rule-proxy is disposed');
    const snapshot = settings.get();
    if (current?.snapshot !== snapshot) {
      const previous = current;
      current = { snapshot, instance: create(snapshot), active: 0 };
      records.add(current);
      if (previous) {
        previous.retired = true;
        if (!previous.active) close(previous).catch(error => ctx.logger.error(error));
      }
    }
    return current;
  };
  const run = async callback => {
    const record = get();
    record.active++;
    try { return await callback(record.instance, record.snapshot); }
    finally {
      record.active--;
      if (record.retired && !record.active) await close(record);
    }
  };
  // Establish initial state now so malformed config cannot defer errors.
  get();
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.all([...records].map(close));
  }, 'rule-proxy live transport');
  ctx.web.registerFetchProvider({
    id: 'rule-proxy',
    available: () => !disposed,
    get transport() { return get().instance.transport; },
    fetch: (request, signal) => run(instance => instance.provider.fetch(request, signal)),
  });
  ctx.web.registerSearchProvider({
    id: 'rule-proxy-searxng',
    available: () => !disposed && Boolean(settings.get().searxEndpoint),
    search: (request, signal) => run(instance => {
      if (!instance.search) throw new Error('SearXNG endpoint is not configured');
      return instance.search.search(request, signal);
    }),
  });
  ctx.inject(['tools'], child => registerTools(child, null, settings.get(), run));
  ctx.inject(['webServer', 'settings'], child => {
    const unregister = registerConfigApi(child, () => settings.get(), body => {
      // Reuse the plugin schema so a browser write can never store a value the
      // plugin would refuse at activation, and keep every field it omits.
      const next = { ...settings.get(), ...body };
      const validated = Config(next);
      const patch = {};
      for (const [key, ref] of Object.entries(validated)) patch[key] = ref.get();
      return child.settings.mutate('rule-proxy', Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value })));
    });
    child.effect(() => unregister, 'rule-proxy config api');
  });
}

export { RuleEngine } from './rules.js';
export { RuleFetchProvider } from './provider.js';
export { ToolTransport } from './transport.js';
