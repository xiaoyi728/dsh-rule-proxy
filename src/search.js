import { RuleFetchProvider } from './provider.js';

// Explicit SearXNG-only provider; never wraps a model-backed search client.
export class SearxSearchProvider {
  id = 'rule-proxy-searxng';
  constructor(transport, endpoint, limits = {}) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error('Expected an anonymous HTTP(S) SearXNG search endpoint');
    this.fetchProvider = new RuleFetchProvider(transport, limits, 'pure-search');
  }
  available() { return true; }
  async search(request, signal) {
    if (typeof request.query !== 'string' || !request.query.trim()) throw new Error('Expected a nonempty search query');
    const cap = request.maxResults ?? 8;
    if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error('Search maxResults must be an integer from 1 to 100');
    const url = new URL(this.endpoint);
    url.searchParams.set('q', request.query);
    url.searchParams.set('format', 'json');
    const fetched = await this.fetchProvider.fetch({ url: url.toString() }, signal);
    if (fetched.statusCode !== 200 || fetched.truncated) throw new Error('SearXNG returned an incomplete or failed response');
    let data;
    try { data = JSON.parse(fetched.body.content); }
    catch { throw new Error('Invalid SearXNG JSON response'); }
    if (!data || !Array.isArray(data.results)) throw new Error('Invalid SearXNG response');
    const results = data.results.filter(item => {
      if (!item || typeof item.url !== 'string' || typeof item.title !== 'string') return false;
      try {
        const source = new URL(item.url);
        return ['http:', 'https:'].includes(source.protocol) && !source.username && !source.password;
      } catch { return false; }
    });
    return { query: request.query, sources: results.slice(0, cap).map(item => ({ url: item.url, title: item.title, ...(typeof item.content === 'string' ? { snippet: item.content } : {}) })), truncated: results.length > cap };
  }
}
