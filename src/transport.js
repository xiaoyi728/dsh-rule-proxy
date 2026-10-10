import { Agent, Client, ProxyAgent, fetch } from 'undici';
import { WebError } from '@deepseek-ai/dsh-web';
import { resolvePublicAddresses, createPinnedLookup } from './public-network.js';

export function proxyOptions(input, token) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Configure an HTTP(S) upstream proxy URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Proxy must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  if (token && /[\r\n]/.test(token)) throw new Error('Invalid proxy authorization');
  return { uri: url.origin, ...(token ? { token } : {}), proxyTunnel: true };
}

function authority(address, port) {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/**
 * Name the underlying failure. Undici wraps connection faults as
 * `TypeError: fetch failed` with the real code on `cause`, sometimes one or two
 * levels down, so a bare `cause.code` lookup loses it and the operator is left
 * with "fetch failed".
 */
export function failureCause(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const code = current.code;
    if (typeof code === 'string' && code !== 'ERR_UNHANDLED_ERROR') return code;
    const message = current.message;
    if (depth > 0 && typeof message === 'string' && message !== 'fetch failed') return message;
  }
  const codes = error?.cause?.errors?.map(entry => entry?.code).filter(Boolean);
  if (codes?.length) return codes.join(', ');
  return error?.message ?? 'unknown error';
}

export class ToolTransport {
  #active = new Set();
  #closed = false;
  constructor({ engine, enabled = true, proxyUrl = '', proxyToken, resolve = resolvePublicAddresses }) {
    this.engine = engine;
    this.enabled = enabled;
    this.proxyUrl = proxyUrl;
    this.proxyToken = proxyToken;
    this.resolve = resolve;
    if (proxyUrl) proxyOptions(proxyUrl, proxyToken);
  }
  explain(url, source = 'web-fetch') {
    return this.engine.explain(url.toString(), { enabled: this.enabled, source });
  }
  async request(url, headers, signal = new AbortController().signal, { source = 'web-fetch', method = 'GET', body } = {}) {
    if (this.#closed) throw new WebError('Tool transport disposed', 'WEB_PROVIDER_ERROR');
    const route = this.explain(url, source);
    if (route.route === 'unmanaged') throw new Error('Unmanaged request must use its original client');
    // A matched rule with no upstream proxy configured is a setup mistake, not a
    // network fault: say so plainly instead of letting it surface as a generic
    // provider failure after a pointless direct attempt.
    if (route.route === 'proxy' && !this.proxyUrl) {
      throw new WebError(`Rule "${route.title}" matched ${url.hostname}, but no upstream proxy is configured`, 'WEB_PROXY_NOT_CONFIGURED');
    }
    const addresses = await this.resolve(url.hostname, signal);
    signal.throwIfAborted();
    if (this.#closed) throw new WebError('Tool transport disposed', 'WEB_PROVIDER_ERROR');
    let dispatcher;
    if (route.route === 'proxy') {
      const options = proxyOptions(this.proxyUrl, this.proxyToken);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      // Rewrite only CONNECT authority, not HTTP Host or TLS SNI/certificate identity.
      dispatcher = new ProxyAgent({
        ...options,
        connectTimeout: 10000,
        clientFactory(origin, options) {
          const client = new Client(origin, options);
          const connect = client.connect.bind(client);
          client.connect = params => connect({ ...params, path: authority(addresses[0].address, port) });
          return client;
        },
      });
    } else {
      dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses), timeout: 10000 } });
    }
    this.#active.add(dispatcher);
    const close = async () => {
      this.#active.delete(dispatcher);
      await dispatcher.destroy();
    };
    try {
      const response = await fetch(url, { method, headers, body, signal, redirect: 'manual', dispatcher });
      return { response, close };
    } catch (error) {
      await close();
      signal.throwIfAborted();
      // Keep the underlying cause: "proxy refused" and "origin reset" need
      // different fixes, and a bare provider error hides that difference.
      throw new WebError(`Tool ${route.route} request to ${url.hostname} failed (${failureCause(error)}); no direct fallback`, 'WEB_PROVIDER_ERROR');
    }
  }
  async close() {
    this.#closed = true;
    await Promise.all([...this.#active].map(agent => agent.destroy()));
    this.#active.clear();
  }
}
