import { RE2 } from 're2-wasm';

export const MAX_RULES = 256;
export const MAX_PATTERN_LENGTH = 512;

// re2-wasm stores every compiled pattern in a fixed 16 MiB WASM heap and
// exposes no way to free an instance (no delete()/dispose()), so recompiling
// the same patterns — which happens on every settings read and every transport
// rebuild — exhausts the heap and aborts every later RE2 operation with
// "Cannot enlarge memory arrays to size 16781312 bytes (OOM)". Share one
// instance per pattern for the process lifetime so repeated compiles allocate
// nothing; the cache stays tiny because patterns are bounded and few.
const compiledCache = new Map();

function compilePattern(pattern, index) {
  let compiled = compiledCache.get(pattern);
  if (!compiled) {
    try { compiled = new RE2(pattern, 'u'); }
    catch (error) { throw new Error(`Rule ${index}: invalid or unsupported RE2 expression (${error?.message ?? error})`); }
    compiledCache.set(pattern, compiled);
  }
  return compiled;
}

export function normalizeHostname(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

export class RuleEngine {
  #rules;
  #compiled;
  #public;
  constructor(input) { this.replace(input); }
  replace(input) {
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > 256 * 1024) throw new Error('Rules JSON exceeds 256 KiB');
      input = JSON.parse(input);
    }
    if (!Array.isArray(input) || input.length > MAX_RULES) throw new Error('Rules must be an array of at most 256 entries');
    const rules = input.map((rule, index) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`Rule ${index}: expected object`);
      const keys = Object.keys(rule);
      if (keys.length !== 5 || !['include', 'type', 'title', 'pattern', 'active'].every(key => keys.includes(key))) throw new Error(`Rule ${index}: unexpected fields`);
      if (rule.include !== 'include' || !['regex', 'domain'].includes(rule.type)) throw new Error(`Rule ${index}: only include/regex or include/domain is supported`);
      if (typeof rule.active !== 'boolean' || typeof rule.title !== 'string' || rule.title.length > 256 || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > MAX_PATTERN_LENGTH) throw new Error(`Rule ${index}: invalid field value or length`);
      if (rule.type === 'domain' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(rule.pattern)) throw new Error(`Rule ${index}: domain pattern must be a valid lowercase domain name`);
      return Object.freeze({ ...rule });
    });
    const compiled = rules.map((rule, index) => {
      if (rule.type === 'domain') return rule.pattern.toLowerCase();
      return compilePattern(rule.pattern, index);
    });
    this.#rules = Object.freeze(rules);
    this.#compiled = compiled;
    // One stable frozen snapshot per engine: callers treat the result as
    // read-only, and identity stability lets config snapshots compare cheaply.
    this.#public = Object.freeze(rules.map(rule => Object.freeze({ ...rule })));
  }
  get rules() { return this.#public; }
  explain(input, { enabled = true, source = 'web-fetch' } = {}) {
    if (!['web-fetch', 'pure-search', 'github-api', 'github-git'].includes(source)) {
      return { source, route: 'unmanaged', reason: 'Model and unrelated requests retain their existing network path' };
    }
    const hostname = normalizeHostname(input);
    if (!enabled) return { source, hostname, route: 'direct', reason: 'Tool proxy disabled' };
    const index = this.#rules.findIndex((rule, i) => rule.active && (rule.type === 'domain' ? (hostname === this.#compiled[i] || hostname.endsWith('.' + this.#compiled[i])) : this.#compiled[i].test(hostname)));
    return index < 0
      ? { source, hostname, route: 'direct', reason: 'No active hostname rule matched' }
      : { source, hostname, route: 'proxy', ruleIndex: index, ruleType: this.#rules[index].type, title: this.#rules[index].title, pattern: this.#rules[index].pattern };
  }
}
